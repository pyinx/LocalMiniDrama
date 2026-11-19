/**
 * 结构化分镜段 → 某个视频模型的请求（prompt、参考图、首尾帧、请求开关）。
 * 各写法族共用同一骨架：风格句 → 参考说明 → 地点与连续性 → 镜头逐条 → 尾注；
 * 族之间只差参考记号（即梦用 {{别名}}，其余用 @图片N）、是否原生出人声、以及请求开关。
 * 纯函数：所有数据库内容由调用方放进 ctx.bindings。
 */
const P = require('./rules/phrases');

const PRIORITY = { scene: 0, lead: 1, character: 2, crowd: 3, prop: 4, tail_frame: 5 };
const EMIT = { character: 0, crowd: 0, scene: 1, prop: 2, tail_frame: 3 };

function firstClause(text) {
  return String(text).split(/[，；,;]/)[0];
}

function envelopeOk(d, { min, max, step }) {
  return d >= min && d <= max && (d - min) % step === 0;
}

/**
 * @param {object} ir 已校验的 SegmentIR
 * @param {{
 *   caps: object,
 *   family?: string,
 *   style: { video: string },
 *   bindings: { characters: object, wardrobes?: object, scenes: object, sceneStates?: object, props?: object, propStates?: object, images?: object },
 *   continuity?: { props?: {name:string,look:string}[], position_lock?: string, axis_lock?: string, ambience?: string },
 *   tailFrame?: { url: string } | null,
 * }} ctx
 */
function compileSegment(ir, ctx) {
  const caps = ctx.caps;
  const family = ctx.family || caps.family || 'generic';
  const native = !!caps.nativeAudio;
  const b = { wardrobes: {}, sceneStates: {}, props: {}, propStates: {}, images: {}, ...ctx.bindings };
  const findings = [];
  const add = (level, code, msg, where = {}) => findings.push({ level, code, where, msg });

  if (!envelopeOk(ir.duration_s, caps.duration)) {
    const { min, max, step } = caps.duration;
    add('block', 'duration_outside_envelope', `段时长 ${ir.duration_s} 秒不在当前模型范围 ${min}–${max} 秒（步长 ${step}）内，请对本集重新规划`);
  }
  const firstLast = ir.continuity.mode === 'first_last';
  if (firstLast && !caps.firstLastFrame) add('block', 'first_last_unsupported', '当前模型不支持首尾帧模式');

  // ---- 资产解析：缺失（已删除）阻断；有对象但没出图只告警并改用文字名
  const names = {};
  const roles = {};
  const candidates = [];
  ir.cast.forEach((c, order) => {
    const ch = b.characters[c.character_id];
    names[c.alias] = (ch && ch.name) || c.alias;
    if (!ch) return add('block', 'asset_missing', `角色「${c.alias}」已不存在`, { alias: c.alias });
    roles[c.alias] = ch;
    let url = ch.image_url || null;
    if (c.wardrobe_id != null) {
      const w = b.wardrobes[c.wardrobe_id];
      if (!w) return add('block', 'asset_missing', `「${c.alias}」的造型已不存在`, { alias: c.alias });
      url = w.image_url || null;
    }
    const crowd = !!(ch.is_group || c.group);
    const kind = crowd ? 'crowd' : 'character';
    if (url) candidates.push({ alias: c.alias, name: names[c.alias], kind, url, priority: crowd ? PRIORITY.crowd : ch.role === 'main' ? PRIORITY.lead : PRIORITY.character, order });
    else if (!firstLast) add('warn', 'no_reference_image', `「${c.alias}」还没有参考图，只能用文字指代`, { alias: c.alias });
  });

  const scene = b.scenes[ir.scene.scene_id];
  const sceneName = (scene && scene.name) || '场景';
  const sceneAlias = names[sceneName] ? `${sceneName}·场景` : sceneName;
  names[sceneAlias] = sceneName;
  let sceneUrl = scene ? scene.image_url || null : null;
  if (!scene) add('block', 'asset_missing', '场景已不存在');
  if (ir.scene.state_id != null) {
    const st = b.sceneStates[ir.scene.state_id];
    if (!st) add('block', 'asset_missing', '场景状态已不存在');
    else sceneUrl = st.image_url || null;
  }
  if (sceneUrl) candidates.push({ alias: sceneAlias, name: sceneName, kind: 'scene', url: sceneUrl, priority: PRIORITY.scene, order: 0 });

  ir.prop_refs.forEach((p, order) => {
    const pr = b.props[p.prop_id];
    names[p.alias] = (pr && pr.name) || p.alias;
    if (!pr) return add('block', 'asset_missing', `道具「${p.alias}」已不存在`, { alias: p.alias });
    let url = pr.image_url || null;
    if (p.state_id != null) {
      const st = b.propStates[p.state_id];
      if (!st) return add('block', 'asset_missing', `道具「${p.alias}」的状态已不存在`, { alias: p.alias });
      url = st.image_url || null;
    }
    if (url) candidates.push({ alias: p.alias, name: names[p.alias], kind: 'prop', url, priority: PRIORITY.prop, order });
  });

  if (ir.continuity.tail_ref_from != null && ctx.tailFrame && ctx.tailFrame.url) {
    candidates.push({ alias: '上一段尾帧', name: '上一段尾帧', kind: 'tail_frame', url: ctx.tailFrame.url, priority: PRIORITY.tail_frame, order: 0 });
  }

  // ---- 参考图：按截断优先级挑选，按输出顺序（角色 > 场景 > 道具 > 其他）排列并编号
  let refs = [];
  const frames = {};
  const lastFrameId = ir.continuity.last_frame_image_id;
  if (lastFrameId != null && !b.images[lastFrameId]) add('block', 'asset_missing', '指定的尾帧图片不可用，请重新选择');
  if (firstLast) {
    frames.first_frame_url = b.images[ir.continuity.first_frame_image_id] || null;
    if (!frames.first_frame_url) add('block', 'asset_missing', '首帧图片已不存在');
    if (lastFrameId != null) frames.last_frame_url = b.images[lastFrameId] || null;
  } else {
    const byPriority = [...candidates].sort((x, y) => x.priority - y.priority || x.order - y.order);
    const kept = byPriority.slice(0, caps.refImages);
    byPriority.slice(caps.refImages).forEach((r) => add('warn', 'reference_dropped', `参考图超过模型上限 ${caps.refImages} 张，「${r.name}」改用文字指代`, { alias: r.alias }));
    refs = kept
      .sort((x, y) => EMIT[x.kind] - EMIT[y.kind] || x.order - y.order)
      .map((r, i) => ({ ...r, token: family === 'jimeng' ? `{{${r.alias}}}` : `@图片${i + 1}` }));
  }
  const tokens = Object.fromEntries(refs.map((r) => [r.alias, r.token]));
  const who = (alias) => tokens[alias] || names[alias] || alias;

  const refLines = refs.map((r) => {
    if (r.kind === 'character') return P.refCharacter(r.token, r.name);
    if (r.kind === 'crowd') return P.refCrowd(r.token, r.name);
    if (r.kind === 'scene') return P.refScene(r.token, r.name);
    if (r.kind === 'prop') return P.refProp(r.token, r.name);
    return P.refTailFrame(r.token);
  });

  const cont = ctx.continuity || {};
  const voiced = new Set();
  const hasLines = ir.shots.some((s) => s.lines.length);

  function shotText(shot, k, trim) {
    const parts = [P.shotHead(k + 1, shot.seconds) + (k > 0 ? (shot.cut === 'hard' ? P.cutHard : P.cutContinuous) : '') + P.framing(shot.size, shot.camera)];
    for (const s of shot.subjects) parts.push(P.subject(who(s.alias), s.frame_pos, s.facing, s.gaze, s.pose, s.holding));
    if (shot.movement) parts.push(P.movement(shot.movement));
    parts.push(P.action(trim.action ? firstClause(shot.action) : shot.action));
    const speaking = new Set(shot.lines.filter((l) => l.kind !== 'vo' && l.speaker).map((l) => l.speaker));
    for (const line of shot.lines) {
      const w = line.speaker ? who(line.speaker) : null;
      if (!native) continue;
      const desc = line.speaker && roles[line.speaker] && roles[line.speaker].voice_style;
      if (desc && line.kind !== 'os' && !voiced.has(line.speaker)) {
        voiced.add(line.speaker);
        parts.push(P.voice(w, desc));
      }
      if (line.kind === 'dialogue') parts.push(P.sayNative(w, line.text, line.delivery));
      else if (line.kind === 'os') parts.push(P.innerNative(w, line.text));
      else if (line.kind === 'offscreen') parts.push(P.offscreenNative(w, line.text));
      else parts.push(P.narrationNative(line.text));
    }
    for (const s of shot.subjects) {
      if (native && !speaking.has(s.alias)) parts.push(P.silentNative(who(s.alias)));
      if (!native && speaking.has(s.alias)) parts.push(P.dubbed(who(s.alias)));
    }
    if (shot.sfx.length && !trim.sfx) parts.push(P.sfx(shot.sfx.join('、')));
    return parts.join('');
  }

  function assemble(trim) {
    voiced.clear();
    const lines = [P.stylePrefix + ctx.style.video];
    if (refLines.length) lines.push(...refLines);
    const place = tokens[sceneAlias] ? `${tokens[sceneAlias]}（${sceneName}）` : sceneName;
    lines.push(P.sceneLine(place, ir.scene.setting));
    if (cont.props && cont.props.length) lines.push(P.continuityProps(cont.props.map((p) => `${p.name}（${p.look}）`).join('；')));
    if (cont.position_lock) lines.push(P.positionLock(cont.position_lock));
    if (cont.axis_lock) lines.push(P.axisLock(cont.axis_lock));
    if (cont.ambience) lines.push(P.ambience(cont.ambience));
    if (ir.tone && !trim.tone) lines.push(P.tone(ir.tone));
    lines.push(P.shotCount(ir.shots.length, ir.duration_s));
    ir.shots.forEach((shot, k) => lines.push(shotText(shot, k, trim)));
    if (native && !hasLines) lines.push(P.allSilent);
    lines.push(native ? P.tailNative : P.tailDubbed);
    return lines.join('\n');
  }

  // ---- 超长裁剪：先砍动作细节，再砍音效与基调；镜头语言、台词、连续性和尾注不动
  const steps = [{}, { action: true }, { action: true, sfx: true }, { action: true, sfx: true, tone: true }];
  let prompt = assemble(steps[0]);
  for (let i = 1; i < steps.length && prompt.length > caps.maxPromptChars; i++) {
    prompt = assemble(steps[i]);
    add('info', 'prompt_trimmed', `prompt 超过模型上限 ${caps.maxPromptChars} 字，已裁剪（第 ${i} 级）`);
  }
  if (prompt.length > caps.maxPromptChars) {
    add('block', 'prompt_too_long', `裁剪后 prompt 仍有 ${prompt.length} 字，超过模型上限 ${caps.maxPromptChars} 字，请拆段或精简镜头`);
  }

  const request = { generate_audio: native, mode: firstLast ? 'first_last' : 'refs', ...frames };
  if (family === 'wan') request.prompt_extend = false;
  return {
    family,
    prompt,
    refs: refs.map(({ alias, url, kind, token }) => ({ alias, url, kind, token })),
    duration_s: ir.duration_s,
    request,
    findings,
  };
}

module.exports = { compileSegment };
