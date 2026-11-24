/**
 * 结构化分镜「一键优化」：把写法类提醒（代词、情绪词、否定句等）交给模型改写，只返回提议，不落库。
 * 模型只能给「路径 → 新文本」：路径必须是被提醒命中的自由文本字段，改完整份 IR 还要再过一遍校验，
 * 所以台词原文、别名、资产绑定、秒数和镜头顺序不可能被改动。应用提议走现有的 updateSegmentIr。
 */
const aiClient = require('./aiClient');
const segmentCompileService = require('./segmentCompileService');
const { parseSegmentIr } = require('./segmentIr/schema');
const { lintText, freeTextFields, isFixableFinding } = require('./segmentCompile/lint');
const { safeParseAIJSON } = require('../utils/safeJson');

function codedError(code, message) {
  const err = new Error(message);
  err.code = code;
  return err;
}

const SYSTEM_PROMPT = `你是短剧分镜的文字编辑。给你一段结构化分镜里被检查出问题的几处文字，逐处改写。
规则：
1. 只改 items 里列出的字段，保持原意、事实和篇幅，不增加新情节、新人物、新道具。
2. 代词（他、她、那人、对方）改成 cast 里的人物名。
3. 情绪词和神态词改写成摄像机拍得到的动作：手在做什么、看向哪里、停顿多久。
4. 否定句改写成实际看到的样子；承接上一段的说法改写成起始状态；淡出、黑场、字幕、配乐、画质词、分数占比直接去掉或换成画面里的具体描述。
5. 改写后不得再含有 issues 指出的那类问题。
只输出 JSON：{"edits":[{"path":"<items 里的 path，原样照抄>","text":"<改写后的完整文字>"}]}，不要解释。`;

function setByPath(root, path, value) {
  const keys = path.split('.');
  let node = root;
  for (const k of keys.slice(0, -1)) node = node[/^\d+$/.test(k) ? Number(k) : k];
  node[/^\d+$/.test(keys[keys.length - 1]) ? Number(keys[keys.length - 1]) : keys[keys.length - 1]] = value;
}

/** 路径 → 给人看的字段名 */
function pathLabel(path) {
  const parts = path.split('.');
  if (path === 'scene.setting') return '场景';
  if (path === 'tone') return '基调';
  const shot = `镜头 ${Number(parts[1]) + 1}`;
  if (parts[2] === 'action') return `${shot} · 动作`;
  if (parts[2] === 'subjects') return `${shot} · 出镜人物 ${Number(parts[3]) + 1} · ${parts[4] === 'holding' ? '手里拿着' : '姿态'}`;
  if (parts[2] === 'sfx') return `${shot} · 声音 ${Number(parts[3]) + 1}`;
  if (parts[2] === 'lines') return `${shot} · 台词 ${Number(parts[3]) + 1} · 语气`;
  return path;
}

function userPrompt(ir, items) {
  return JSON.stringify(
    {
      cast: ir.cast.map((c) => c.alias),
      scene: ir.scene.setting,
      shots: ir.shots.map((s, i) => ({ shot: i + 1, event: s.event, subjects: s.subjects.map((x) => x.alias), action: s.action })),
      items,
    },
    null,
    1
  );
}

/**
 * @returns {Promise<{ ir: object, changes: { path: string, label: string, before: string, after: string, remaining: string[] }[] } | { ok: false, code: string, message: string, errors?: object[] }>}
 *   编译阶段的失败（分镜不存在、非结构化、IR 不合法）按 compileStoryboard 的形状原样返回；其余失败抛带 code 的错误。
 */
async function optimizeStoryboard(db, log, storyboardId, opts = {}) {
  const compiled = segmentCompileService.compileStoryboard(db, storyboardId, { model: opts.model || undefined });
  if (!compiled.ok) return compiled;
  const { ir } = compiled;

  const originals = new Map(freeTextFields(ir));
  const byPath = new Map();
  for (const f of compiled.findings.filter(isFixableFinding)) {
    const path = f.where.path;
    if (!originals.has(path)) continue;
    if (!byPath.has(path)) byPath.set(path, { path, text: originals.get(path), issues: [] });
    byPath.get(path).issues.push({ code: f.code, match: f.where.match, hint: f.msg });
  }
  if (!byPath.size) throw codedError('nothing_to_optimize', '没有可自动优化的提醒');

  let edits;
  try {
    const text = await aiClient.generateText(db, log, 'text', userPrompt(ir, [...byPath.values()]), SYSTEM_PROMPT, {
      scene_key: 'segment_optimize',
      temperature: 0.3,
      max_tokens: 2048,
    });
    edits = safeParseAIJSON(String(text || ''), {}, log).edits;
  } catch (e) {
    log.error('segment optimize model failed', { storyboard_id: storyboardId, error: e.message });
    throw codedError('optimize_failed', `模型改写失败：${e.message}`);
  }
  if (!Array.isArray(edits)) throw codedError('optimize_failed', '模型没有返回可用的改写结果');

  const seen = new Set();
  const changes = [];
  for (const e of edits) {
    const path = e && e.path;
    if (!byPath.has(path)) throw codedError('optimize_failed', `模型改了未被提醒的字段：${path}，已整体放弃`);
    if (seen.has(path)) throw codedError('optimize_failed', `模型对 ${path} 给了多次改写，已整体放弃`);
    seen.add(path);
    const after = typeof e.text === 'string' ? e.text.trim() : '';
    if (!after) throw codedError('optimize_failed', `模型把 ${path} 改成了空文字，已整体放弃`);
    const before = originals.get(path);
    if (after === before) continue;
    changes.push({ path, label: pathLabel(path), before, after, remaining: [...new Set(lintText(after, path).map((f) => f.code))] });
  }
  if (!changes.length) throw codedError('nothing_to_optimize', '模型没有给出任何改动');

  const draft = JSON.parse(JSON.stringify(ir));
  for (const c of changes) setByPath(draft, c.path, c.after);
  const parsed = parseSegmentIr(draft);
  if (!parsed.ok) throw codedError('optimize_failed', '改写后的分镜未通过校验，已整体放弃：' + JSON.stringify(parsed.errors.slice(0, 3)));
  return { ir: parsed.ir, changes };
}

module.exports = { optimizeStoryboard };
