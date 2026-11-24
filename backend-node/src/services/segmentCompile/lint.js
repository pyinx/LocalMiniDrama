/**
 * 单段检查：
 * - 写法问题（警告）：只查 IR 里由人或 LLM 写的自由文本，编译器自己的固定措辞不查；
 * - 硬上限（阻断）：编译结果的长度、参考数、未绑定记号；
 * - 台词保真（警告）：IR 台词与本集剧本比对。
 */

const { promptChars } = require('../modelCapabilities');

const TEXT_RULES = [
  { code: 'pronoun_reference', re: /(?<![其吉])(他们|她们|他|她)|那人|对方/g, msg: '用代词指人，模型可能当成新人物；请写人物名' },
  { code: 'refers_previous', re: /接上一段|接上段|同上|延续刚才|如前所述/g, msg: '模型看不到上一段，请把起始状态写出来' },
  { code: 'fade_to_black', re: /淡出|淡入|入黑|渐暗|黑场|暗角/g, msg: '淡出/黑场常被画成黑色光晕，转场在成片时加' },
  { code: 'text_or_bgm', re: /字幕|BGM|背景音乐|配乐/gi, msg: '字幕与配乐在成片阶段加，不要写进画面描述' },
  { code: 'image_quality_words', re: /8K|4K|UE5|masterpiece|RAW原片|超清|高清画质/gi, msg: '图像质量词对视频无效，删掉' },
  { code: 'fraction_ratio', re: /\d+\s*\/\s*\d+|[一二三四五]分之[一二三四]/g, msg: '分数式占比不会被兑现，改用景别和身体截取' },
  { code: 'negation', re: /不要|没有|禁止|别让|不能出现|不出现/g, msg: '否定句会把被否定的东西召回画面，改写成实际看到的样子' },
  {
    code: 'emotion_label',
    re: /悲伤|伤心|难过|痛苦|绝望|愤怒|恼怒|焦虑|不安|恐惧|害怕|惊恐|震惊|疲惫|倦意|孤独|孤寂|落寞|失落|颓废|压抑|释然|欣慰|喜悦|兴奋|无奈|委屈|眼神空洞|若有所思|神情|神态|表情/g,
    msg: '情绪词会被画成脸上一成不变的表情，改写成拍得到的动作：手在做什么、看向哪里、停顿多久',
  },
];

function freeTextFields(ir) {
  const out = [
    ['scene.setting', ir.scene.setting],
    ['tone', ir.tone],
  ];
  ir.shots.forEach((s, i) => {
    out.push([`shots.${i}.action`, s.action]);
    s.subjects.forEach((x, j) => {
      out.push([`shots.${i}.subjects.${j}.pose`, x.pose]);
      if (x.holding) out.push([`shots.${i}.subjects.${j}.holding`, x.holding]);
    });
    s.sfx.forEach((x, j) => out.push([`shots.${i}.sfx.${j}`, x]));
    s.lines.forEach((l, j) => out.push([`shots.${i}.lines.${j}.delivery`, l.delivery]));
  });
  return out.filter(([, v]) => v);
}

const TEXT_RULE_CODES = new Set(TEXT_RULES.map((r) => r.code));

/** 写法类提醒且落在可改的自由文本字段上：改写这个字段就能消除，其余提醒（台词、参考图、规划、画风）要在别处处理 */
function isFixableFinding(f) {
  return !!f && TEXT_RULE_CODES.has(f.code) && typeof f.where?.path === 'string';
}

/** 对一段自由文本跑写法规则 */
function lintText(text, path = '') {
  const findings = [];
  for (const rule of TEXT_RULES) {
    for (const m of String(text).matchAll(rule.re)) {
      findings.push({ level: 'warn', code: rule.code, where: { path, index: m.index, match: m[0] }, msg: rule.msg });
    }
  }
  return findings;
}

/**
 * @param {object} ir 已校验的 IR
 * @param {{ prompt: string, refs: object[], family: string } | null} compiled compileSegment 的结果
 * @param {object} caps
 */
function lintSegment(ir, compiled, caps) {
  const findings = freeTextFields(ir).flatMap(([path, text]) => lintText(text, path));
  if (compiled) {
    if (promptChars(compiled.prompt) > caps.maxPromptChars && !compiled.findings?.some(f => f.code === 'prompt_too_long')) {
      findings.push({ level: 'block', code: 'prompt_too_long', where: {}, msg: `prompt ${promptChars(compiled.prompt)} 字超过上限 ${caps.maxPromptChars}` });
    }
    if (compiled.refs.length > caps.refImages) {
      findings.push({ level: 'block', code: 'too_many_references', where: {}, msg: `参考图 ${compiled.refs.length} 张超过上限 ${caps.refImages}` });
    }
    const bound = new Set(compiled.refs.map((r) => r.token));
    const tokenRe = compiled.family === 'jimeng' ? /\{\{[^}]+\}\}/g : new RegExp((caps.refToken || '@图片') + '\\d+', 'g');
    for (const m of compiled.prompt.matchAll(tokenRe)) {
      if (!bound.has(m[0])) findings.push({ level: 'block', code: 'alias_unbound', where: { index: m.index, match: m[0] }, msg: `${m[0]} 没有对应的参考图` });
    }
  }
  return findings;
}

// ---- 台词保真

function normalizeLine(text) {
  return String(text).replace(/[\s\p{P}\p{S}]/gu, '');
}

function bigrams(s) {
  const out = new Map();
  for (let i = 0; i + 1 < s.length; i++) out.set(s.slice(i, i + 2), (out.get(s.slice(i, i + 2)) || 0) + 1);
  return out;
}

function similarity(a, b) {
  if (a === b) return 1;
  const x = bigrams(a);
  const y = bigrams(b);
  let common = 0;
  for (const [k, n] of x) common += Math.min(n, y.get(k) || 0);
  const total = Math.max(1, a.length - 1 + b.length - 1);
  return (2 * common) / total;
}

const SCRIPT_LINE = /^\s*([^\s：:（()△#【]{1,12})\s*(?:[（(]([^）)]*)[）)])?\s*[：:]\s*(.+?)\s*$/;

/** 从剧本取台词：标准格式「人名（语气）：台词」；不是标准格式时只取引号内文字做模糊比对 */
function parseScriptLines(script) {
  const lines = [];
  for (const raw of String(script || '').split(/\r?\n/)) {
    if (/^\s*(##|#|△|出场)/.test(raw)) continue;
    const m = raw.match(SCRIPT_LINE);
    if (!m) continue;
    const label = (m[2] || '').toLowerCase();
    const isVo = m[1] === '旁白' || label.includes('vo');
    lines.push({ speaker: isVo ? null : m[1], kind: isVo ? 'vo' : label.includes('os') ? 'os' : label.includes('画外') ? 'offscreen' : 'dialogue', text: m[3] });
  }
  if (lines.length >= 2) return { mode: 'structured', lines };
  const quoted = [...String(script || '').matchAll(/["“「]([^"”」]{2,})["”」]/g)].map((m) => ({ speaker: null, kind: null, text: m[1] }));
  return { mode: 'fuzzy', lines: quoted };
}

/**
 * @param {{ storyboard_id?: number, ir: object }[]} segments 本集按顺序的 IR 段
 * @param {string} script 本集剧本
 */
function lintDialogueFidelity(segments, script, opts = {}) {
  const parsed = parseScriptLines(script);
  const findings = [];
  const fuzzy = parsed.mode === 'fuzzy';
  const pool = parsed.lines.map((l) => ({ ...l, norm: normalizeLine(l.text), used: false }));
  segments.forEach(({ storyboard_id, ir }, si) => {
    ir.shots.forEach((shot, i) => shot.lines.forEach((line, j) => {
      const where = { segment: si, storyboard_id, path: `shots.${i}.lines.${j}`, fuzzy };
      const norm = normalizeLine(line.text);
      const exact = pool.find((p) => !p.used && p.norm === norm) || pool.find((p) => p.norm === norm);
      if (exact) {
        exact.used = true;
        if (!fuzzy && exact.speaker !== (line.kind === 'vo' ? null : line.speaker)) {
          findings.push({ level: 'warn', code: 'speaker_changed', where, msg: `「${line.text}」剧本里是${exact.speaker || '旁白'}说的，这里是${line.speaker || '旁白'}` });
        }
        return;
      }
      const best = pool.map((p) => ({ p, s: similarity(p.norm, norm) })).sort((a, b) => b.s - a.s)[0];
      if (best && best.s >= 0.5) {
        best.p.used = true;
        findings.push({ level: 'warn', code: 'line_altered', where, msg: `台词与剧本不一致：剧本「${best.p.text}」，这里「${line.text}」` });
      } else {
        findings.push({ level: 'warn', code: 'line_not_in_script', where, msg: `「${line.text}」剧本里没有${fuzzy ? '（剧本非标准格式，按模糊匹配判断）' : ''}` });
      }
    }));
  });
  if (!fuzzy) {
    // 保留下来的旧分镜（没有 IR）里出现过的台词不算缺失：逐行去掉「人名：」后整句相同即覆盖；
    // 4 个字以上的台词也接受包含，短台词不能因为碰巧含同一个字就算覆盖
    const covered = (opts.coveredText || [])
      .flatMap((t) => String(t).split(/\r?\n/))
      .map((line) => normalizeLine(line.replace(/^\s*[^：:\n]{1,12}[：:]/, '')))
      .filter(Boolean);
    const isCovered = (norm) => !!norm && covered.some((c) => c === norm || (norm.length >= 4 && c.includes(norm)));
    pool.filter((p) => !p.used && !isCovered(p.norm)).forEach((p) => findings.push({ level: 'warn', code: 'line_missing', where: { fuzzy }, msg: `剧本台词「${p.text}」（${p.speaker || '旁白'}）没有出现在分镜里` }));
  }
  return findings;
}

module.exports = { lintText, lintSegment, lintDialogueFidelity, parseScriptLines, freeTextFields, isFixableFinding };
