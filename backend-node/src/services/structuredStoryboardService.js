/**
 * 结构化分镜生成：LLM 输出 SegmentIR 数组 → 逐段校验（含引用 id 是否属于本剧）→ 整集段规划 → 替换本集分镜。
 * 任何一段校验失败都整体报错，不静默退回旧链路，也不写库。
 * 受保护的镜头（有采用片、留档候选或审片记录）与经典链路一样原样保留。
 * 「转为结构化分镜」：把本集旧分镜逐条原地改写成 IR，受保护的镜头不动。
 */
const aiClient = require('./aiClient');
const taskService = require('./taskService');
const videoClient = require('./videoClient');
const { storyboardPlanningCaps } = require('./modelCapabilities');
const storyboardService = require('./storyboardService');
const episodeContinuityService = require('./episodeContinuityService');
const { parseSegmentIr, readStoredIr } = require('./segmentIr/schema');
const { planSegments } = require('./segmentIr/planner');
const { episodeStoryboardRows } = require('./episodeStoryboardRows');
const { lintEpisode } = require('./segmentCompile/episodeLint');
const { lintDialogueFidelity } = require('./segmentCompile/lint');
const rules = require('./segmentCompile/rules/storyboardRules');
const { safeParseAIJSON, extractFirstArray } = require('../utils/safeJson');
const { parseDramaMetadata } = require('../utils/dramaStyleMerge');
const { coversEpisode } = require('./characterHeadBody');

function statusError(status, message) {
  return Object.assign(new Error(message), { status });
}

function loadEpisode(db, episodeId) {
  const ep = db.prepare('SELECT id, drama_id, episode_number, script_content, description FROM episodes WHERE id = ? AND deleted_at IS NULL').get(Number(episodeId));
  if (!ep) throw statusError(404, '剧集不存在或无权限访问');
  const script = String(ep.script_content || ep.description || '').trim();
  if (!script) throw statusError(400, '剧本内容为空，请先生成剧集内容');
  return { ep, script };
}

function parseRange(raw) {
  try { return raw ? JSON.parse(raw) : null; } catch (_) { return null; }
}

/**
 * 本剧可被 IR 引用的资产：给模型看的列表，以及校验归属用的索引。
 * 场景状态只列时段/光线版本（竖屏主机位、反打是机位变体，不是「此刻的样子」）；
 * 造型只列适用于本集的：起止集包含本集的（即本集默认），以及没设集数范围的。
 */
function loadAssets(db, dramaId, episodeNumber) {
  const characters = db.prepare('SELECT id, name, role FROM characters WHERE drama_id = ? AND deleted_at IS NULL ORDER BY id').all(dramaId);
  const scenes = db.prepare('SELECT id, location, time FROM scenes WHERE drama_id = ? AND deleted_at IS NULL ORDER BY id').all(dramaId);
  const props = db.prepare('SELECT id, name FROM props WHERE drama_id = ? AND deleted_at IS NULL ORDER BY id').all(dramaId);
  const sceneStates = db.prepare(
    `SELECT st.id, st.scene_id, st.name, st.state_phrase FROM scene_states st JOIN scenes s ON s.id = st.scene_id
     WHERE s.drama_id = ? AND st.deleted_at IS NULL AND s.deleted_at IS NULL AND COALESCE(st.kind, 'state') = 'state'
     ORDER BY st.scene_id, st.sort_order, st.id`
  ).all(dramaId);
  const wardrobes = db.prepare(
    `SELECT w.id, w.character_id, w.name, w.change_phrase, w.episode_range FROM character_wardrobes w JOIN characters c ON c.id = w.character_id
     WHERE c.drama_id = ? AND w.deleted_at IS NULL AND c.deleted_at IS NULL ORDER BY w.character_id, w.sort_order, w.id`
  ).all(dramaId)
    .map((w) => ({ ...w, episode_range: parseRange(w.episode_range) }))
    .filter((w) => !Array.isArray(w.episode_range) || !w.episode_range.length || coversEpisode(w.episode_range, Number(episodeNumber)));
  const propStates = db.prepare(
    `SELECT st.id, st.prop_id FROM prop_states st JOIN props p ON p.id = st.prop_id
     WHERE p.drama_id = ? AND st.deleted_at IS NULL AND p.deleted_at IS NULL`
  ).all(dramaId);
  return {
    lists: { characters, scenes, props, sceneStates, wardrobes },
    known: {
      characters: new Set(characters.map((c) => c.id)),
      scenes: new Set(scenes.map((s) => s.id)),
      props: new Set(props.map((p) => p.id)),
      sceneStates: new Map(sceneStates.map((s) => [s.id, s.scene_id])),
      wardrobes: new Map(wardrobes.map((w) => [w.id, w.character_id])),
      propStates: new Map(propStates.map((s) => [s.id, s.prop_id])),
    },
  };
}

/** 引用的资产必须属于本剧；状态和造型必须属于它所挂的场景、角色、道具 */
function referenceErrors(ir, label, known) {
  const errs = [];
  if (!known.scenes.has(ir.scene.scene_id)) errs.push(`${label}：场景 id ${ir.scene.scene_id} 不属于本剧`);
  if (ir.scene.state_id != null && known.sceneStates.get(ir.scene.state_id) !== ir.scene.scene_id) {
    errs.push(`${label}：场景状态 id ${ir.scene.state_id} 不属于场景 ${ir.scene.scene_id}，或不是时段光线版本`);
  }
  ir.cast.forEach((c) => {
    if (!known.characters.has(c.character_id)) errs.push(`${label}：角色 id ${c.character_id} 不属于本剧`);
    if (c.wardrobe_id != null && known.wardrobes.get(c.wardrobe_id) !== c.character_id) {
      errs.push(`${label}：造型 id ${c.wardrobe_id} 不属于角色 ${c.character_id}，或不适用于本集`);
    }
  });
  ir.prop_refs.forEach((p) => {
    if (!known.props.has(p.prop_id)) errs.push(`${label}：道具 id ${p.prop_id} 不属于本剧`);
    if (p.state_id != null && known.propStates.get(p.state_id) !== p.prop_id) {
      errs.push(`${label}：道具状态 id ${p.state_id} 不属于道具 ${p.prop_id}`);
    }
  });
  return errs;
}

// 模型只规划出一段时可能直接返回这一段的对象；extractFirstArray 会误取它里面的 cast 等数组当作分镜段
const SEGMENT_KEYS = ['version', 'duration_s', 'scene', 'shots'];
function isBareSegment(v) {
  return !!v && typeof v === 'object' && !Array.isArray(v) && SEGMENT_KEYS.some((k) => k in v);
}

function parseIrArray(text, log, what) {
  let arr = null;
  try {
    const parsed = safeParseAIJSON(String(text || ''), [], log);
    arr = isBareSegment(parsed) ? [parsed] : extractFirstArray(parsed);
  } catch (e) {
    throw new Error(`${what}失败：模型输出不是可解析的 JSON（${e.message}）`);
  }
  if (!Array.isArray(arr) || !arr.length) throw new Error(`${what}失败：模型没有返回任何分镜段`);
  return arr;
}

function editSnapshot(db, episodeId) {
  return JSON.stringify(db.prepare('SELECT id, updated_at FROM storyboards WHERE episode_id=? AND deleted_at IS NULL ORDER BY id').all(Number(episodeId)));
}

/** 生成或转换之后，项目随之使用结构化分镜 */
function enableStructured(db, dramaId) {
  const drama = db.prepare('SELECT metadata FROM dramas WHERE id = ?').get(dramaId);
  const metadata = parseDramaMetadata(drama);
  if (metadata.storyboard_structured === true) return;
  db.prepare('UPDATE dramas SET metadata = ?, updated_at = ? WHERE id = ?')
    .run(JSON.stringify({ ...metadata, storyboard_structured: true }), new Date().toISOString(), dramaId);
}

/** 本集还没有 IR 的分镜（保留下来的旧镜头）里的台词与旁白：台词检查把它们算作已覆盖 */
function legacyLineText(db, episodeId) {
  return db.prepare('SELECT dialogue, narration FROM storyboards WHERE episode_id = ? AND deleted_at IS NULL AND segment_ir IS NULL')
    .all(Number(episodeId))
    .flatMap((r) => [r.dialogue, r.narration])
    .filter(Boolean);
}

function episodeFindings(db, episodeId, script) {
  const segments = episodeSegments(db, episodeId);
  const continuity = episodeContinuityService.getContinuity(db, episodeId) || {};
  return [...lintEpisode(segments, { continuity }), ...lintDialogueFidelity(segments, script, { coveredText: legacyLineText(db, episodeId) })];
}

function updateEpisodeDuration(db, episodeId, now) {
  const total = db.prepare('SELECT COALESCE(SUM(duration), 0) AS d FROM storyboards WHERE episode_id = ? AND deleted_at IS NULL').get(Number(episodeId)).d;
  db.prepare('UPDATE episodes SET duration=?, updated_at=? WHERE id=?').run(Math.ceil(total / 60), now, Number(episodeId));
  return total;
}

/** 待转换的分镜：没有 IR、也不受保护的旧分镜 */
function conversionCandidates(db, episodeId) {
  const rows = db.prepare(
    `SELECT id, storyboard_number, duration, scene_id, characters, action, dialogue, narration, universal_segment_text, segment_ir
     FROM storyboards WHERE episode_id = ? AND deleted_at IS NULL ORDER BY storyboard_number, id`
  ).all(Number(episodeId));
  const protectedIds = new Set(storyboardService.protectedStoryboards(db, episodeId).map((s) => s.id));
  return { rows, protectedIds, candidates: rows.filter((r) => !protectedIds.has(r.id) && !r.segment_ir) };
}

function episodeSegments(db, episodeId) {
  return db.prepare('SELECT id, storyboard_number, segment_ir FROM storyboards WHERE episode_id = ? AND deleted_at IS NULL AND segment_ir IS NOT NULL ORDER BY storyboard_number, id')
    .all(Number(episodeId))
    .map((r) => ({ storyboard_id: r.id, storyboard_number: r.storyboard_number, ir: readStoredIr(r.segment_ir) }))
    .filter((s) => s.ir);
}

/** 生成并保存；返回 { storyboard_ids, preserved_shot_ids, findings }。供后台任务与测试直接调用 */
async function runStructuredStoryboardGeneration(db, log, episodeId, opts = {}) {
  const { ep, script } = loadEpisode(db, episodeId);
  const { lists, known } = loadAssets(db, ep.drama_id, ep.episode_number);
  const target = videoClient.resolveVideoTarget(db, opts.videoModel);
  const caps = storyboardPlanningCaps(target.caps, opts.clipRange);
  const original = editSnapshot(db, ep.id);
  require('./workbenchContinuity').checkEpisodeReplacement(db, ep.id);

  const text = await aiClient.generateText(db, log, 'text', rules.userPrompt({
    script, episodeNumber: ep.episode_number, ...lists, caps, storyboardCount: opts.storyboardCount, videoDuration: opts.videoDuration,
  }), rules.systemPrompt(caps), {
    scene_key: 'storyboard_extraction',
    model: opts.model || undefined,
    temperature: 0.4,
    max_tokens: 16384,
  });
  const arr = parseIrArray(text, log, '结构化分镜生成');

  const errors = [];
  const irs = arr.map((raw, i) => {
    const r = parseSegmentIr(raw);
    if (!r.ok) {
      errors.push(...r.errors.slice(0, 3).map((e) => `第 ${i + 1} 段 ${e.path || '(root)'}：${e.message}`));
      return null;
    }
    errors.push(...referenceErrors(r.ir, `第 ${i + 1} 段`, known));
    return r.ir;
  });
  if (errors.length) throw new Error('结构化分镜生成失败，模型输出未通过校验：' + errors.slice(0, 6).join('；'));

  const plan = planSegments(irs, caps, { episode: !opts.storyboardCount });
  const blocked = plan.findings.find(f => f.level === 'block');
  if (blocked) throw new Error(blocked.msg);
  if (opts.storyboardCount && plan.segments.length !== Number(opts.storyboardCount)) {
    throw new Error(`要求生成 ${opts.storyboardCount} 镜，本次规划得到 ${plan.segments.length} 镜，请重试或调整镜数。`);
  }
  const now = new Date().toISOString();
  const ids = [];
  let preserved = [];
  let totalDuration = 0;
  db.transaction(() => {
    if (editSnapshot(db, ep.id) !== original) throw new Error('生成期间原分镜已被编辑，请刷新后重试。');
    require('./workbenchContinuity').checkEpisodeReplacement(db, ep.id);
    // 受保护的镜头连同采用片、审片记录一起保留；与它同镜号的新段丢弃，不把旧素材挂到无关的新内容上
    preserved = storyboardService.protectedStoryboards(db, ep.id);
    const keepIds = new Set(preserved.map((s) => s.id));
    const keepNumbers = new Set(episodeStoryboardRows(db, ep.id).filter((s) => keepIds.has(s.id)).map((s) => s.storyboard_number));
    const remove = db.prepare('UPDATE storyboards SET deleted_at = ? WHERE id = ?');
    for (const row of db.prepare('SELECT id FROM storyboards WHERE episode_id = ? AND deleted_at IS NULL').all(ep.id)) {
      if (!keepIds.has(row.id)) remove.run(now, row.id);
    }
    const ins = db.prepare(
      `INSERT INTO storyboards (episode_id, storyboard_number, title, creation_mode, status, created_at, updated_at)
       VALUES (?, ?, ?, 'classic', 'pending', ?, ?)`
    );
    plan.segments.forEach((seg, i) => {
      if (keepNumbers.has(i + 1)) return;
      const title = (seg.ir.shots.find((s) => s.event) || {}).event || `分镜${i + 1}`;
      const id = Number(ins.run(ep.id, i + 1, String(title).slice(0, 40), now, now).lastInsertRowid);
      storyboardService.saveSegmentIr(db, log, id, seg.ir);
      ids.push(id);
    });
    totalDuration = updateEpisodeDuration(db, ep.id, now);
  })();
  const findings = [...plan.findings, ...episodeFindings(db, ep.id, script)];
  log.info('Structured storyboards generated', { episode_id: ep.id, segments: ids.length, preserved: preserved.length, findings: findings.length });
  return { storyboard_ids: ids, preserved_shot_ids: preserved.map((s) => s.id), findings, total_duration: totalDuration };
}

/**
 * 把本集旧分镜逐条原地改写成 IR：镜头 id 与镜号不变；受保护的镜头和已经结构化的镜头不动。
 * 模型输出缺条、多条、重复或不合法时整体失败，不写库。
 * @returns {{ converted_ids: number[], skipped_protected_ids: number[], skipped_structured_ids: number[], findings: object[] }}
 */
async function runStructuredConversion(db, log, episodeId, opts = {}) {
  const { ep, script } = loadEpisode(db, episodeId);
  const { rows, protectedIds, candidates } = conversionCandidates(db, ep.id);
  const result = {
    converted_ids: [],
    skipped_protected_ids: rows.filter((r) => protectedIds.has(r.id)).map((r) => r.id),
    skipped_structured_ids: rows.filter((r) => !protectedIds.has(r.id) && r.segment_ir).map((r) => r.id),
    findings: [],
  };
  if (!candidates.length) {
    enableStructured(db, ep.drama_id);
    return result;
  }
  const candidateIds = new Set(candidates.map((r) => r.id));
  require('./workbenchContinuity').checkEpisodeReplacement(db, ep.id, { ids: candidateIds, verb: '转换会改写' });

  const { lists, known } = loadAssets(db, ep.drama_id, ep.episode_number);
  const target = videoClient.resolveVideoTarget(db, opts.videoModel);
  const caps = storyboardPlanningCaps(target.caps, opts.clipRange);
  const propLinks = db.prepare(`SELECT storyboard_id, prop_id FROM storyboard_props WHERE storyboard_id IN (${candidates.map(() => '?').join(',')})`)
    .all(...candidates.map((r) => r.id));
  const existing = candidates.map((r) => ({
    storyboard_id: r.id,
    storyboard_number: r.storyboard_number,
    duration: r.duration,
    scene_id: r.scene_id,
    character_ids: storyboardService.parseDramaCharacterIds(r.characters) || [],
    prop_ids: propLinks.filter((l) => l.storyboard_id === r.id).map((l) => l.prop_id),
    action: r.action || '',
    dialogue: r.dialogue || '',
    narration: r.narration || '',
    segment_text: String(r.universal_segment_text || '').slice(0, 1500),
  }));
  const original = editSnapshot(db, ep.id);

  const text = await aiClient.generateText(db, log, 'text', rules.conversionUserPrompt({
    script, episodeNumber: ep.episode_number, ...lists, caps, storyboards: existing,
  }), rules.systemPrompt(caps) + rules.conversionSuffix, {
    scene_key: 'storyboard_extraction',
    model: opts.model || undefined,
    temperature: 0.3,
    max_tokens: 16384,
  });
  const arr = parseIrArray(text, log, '转为结构化分镜');

  const errors = [];
  const irs = new Map();
  if (arr.length !== candidates.length) errors.push(`应改写 ${candidates.length} 条分镜，模型返回 ${arr.length} 段`);
  arr.forEach((raw, i) => {
    const id = Number(raw && raw.storyboard_id);
    const label = `分镜 ${Number.isFinite(id) ? id : '?'}`;
    if (!candidateIds.has(id)) return errors.push(`第 ${i + 1} 段的 storyboard_id 不是待转换的分镜`);
    if (irs.has(id)) return errors.push(`${label} 出现了不止一次`);
    const r = parseSegmentIr(raw);
    if (!r.ok) return errors.push(...r.errors.slice(0, 3).map((e) => `${label} ${e.path || '(root)'}：${e.message}`));
    errors.push(...referenceErrors(r.ir, label, known));
    irs.set(id, r.ir);
  });
  candidates.forEach((c) => { if (!irs.has(c.id) && arr.length === candidates.length) errors.push(`分镜 ${c.id} 没有改写结果`); });
  if (errors.length) throw new Error('转为结构化分镜失败，模型输出未通过校验：' + errors.slice(0, 6).join('；'));

  db.transaction(() => {
    if (editSnapshot(db, ep.id) !== original) throw new Error('转换期间分镜已被编辑，请刷新后重试。');
    // 采用片、留档、审片和锁定都不改 updated_at：写入前重新核对
    const nowProtected = storyboardService.protectedStoryboards(db, ep.id).filter((s) => candidateIds.has(s.id));
    if (nowProtected.length) throw new Error(`转换期间镜头 ${nowProtected.map((s) => s.storyboard_number).join('、')} 被采用或标记保留，请刷新后重试。`);
    require('./workbenchContinuity').checkEpisodeReplacement(db, ep.id, { ids: candidateIds, verb: '转换会改写' });
    const mode = db.prepare("UPDATE storyboards SET creation_mode = 'classic' WHERE id = ?");
    for (const c of candidates) {
      const saved = storyboardService.saveSegmentIr(db, log, c.id, irs.get(c.id), { caps });
      mode.run(c.id);
      result.converted_ids.push(c.id);
      for (const f of saved.plan_findings || []) result.findings.push({ ...f, where: { ...f.where, storyboard_id: c.id } });
    }
    enableStructured(db, ep.drama_id);
    updateEpisodeDuration(db, ep.id, new Date().toISOString());
  })();
  result.findings.push(...episodeFindings(db, ep.id, script));
  log.info('Storyboards converted to structured', { episode_id: ep.id, converted: result.converted_ids.length, protected: result.skipped_protected_ids.length });
  return result;
}

function startTask(db, log, episodeId, run, messages) {
  loadEpisode(db, episodeId);
  const task = taskService.createTask(db, log, 'storyboard_generation', String(episodeId));
  setImmediate(async () => {
    try {
      taskService.updateTaskStatus(db, task.id, 'processing', 10, messages.running);
      const result = await run();
      taskService.updateTaskResult(db, task.id, { ...result, total: (result.storyboard_ids || result.converted_ids).length });
    } catch (err) {
      log.error(messages.failed, { episode_id: episodeId, error: err.message });
      taskService.updateTaskError(db, task.id, err.message);
    }
  });
  return { task_id: task.id, status: 'pending', message: messages.created };
}

/** 路由入口：建任务后台执行 */
function startStructuredStoryboardGeneration(db, log, episodeId, opts = {}) {
  loadEpisode(db, episodeId);
  require('./workbenchContinuity').checkEpisodeReplacement(db, episodeId);
  return startTask(db, log, episodeId, () => runStructuredStoryboardGeneration(db, log, episodeId, opts), {
    running: '正在生成结构化分镜…', failed: 'Structured storyboard generation failed', created: '结构化分镜生成任务已创建，正在后台处理...',
  });
}

function startStructuredConversion(db, log, episodeId, opts = {}) {
  loadEpisode(db, episodeId);
  const { candidates } = conversionCandidates(db, episodeId);
  if (candidates.length) {
    require('./workbenchContinuity').checkEpisodeReplacement(db, episodeId, { ids: new Set(candidates.map((r) => r.id)), verb: '转换会改写' });
  }
  return startTask(db, log, episodeId, () => runStructuredConversion(db, log, episodeId, opts), {
    running: '正在转为结构化分镜…', failed: 'Structured storyboard conversion failed', created: '转为结构化分镜任务已创建，正在后台处理...',
  });
}

module.exports = { startStructuredStoryboardGeneration, runStructuredStoryboardGeneration, startStructuredConversion, runStructuredConversion };
