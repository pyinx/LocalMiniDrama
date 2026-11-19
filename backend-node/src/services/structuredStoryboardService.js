/**
 * 结构化分镜生成：LLM 输出 SegmentIR 数组 → 逐段校验（含引用 id 是否属于本剧）→ 整集段规划 → 替换本集分镜。
 * 任何一段校验失败都整体报错，不静默退回旧链路，也不写库。
 */
const aiClient = require('./aiClient');
const taskService = require('./taskService');
const videoClient = require('./videoClient');
const storyboardService = require('./storyboardService');
const episodeContinuityService = require('./episodeContinuityService');
const { parseSegmentIr } = require('./segmentIr/schema');
const { planSegments } = require('./segmentIr/planner');
const { lintEpisode } = require('./segmentCompile/episodeLint');
const { lintDialogueFidelity } = require('./segmentCompile/lint');
const rules = require('./segmentCompile/rules/storyboardRules');
const { safeParseAIJSON, extractFirstArray } = require('../utils/safeJson');

function loadEpisode(db, episodeId) {
  const ep = db.prepare('SELECT id, drama_id, script_content, description FROM episodes WHERE id = ? AND deleted_at IS NULL').get(Number(episodeId));
  if (!ep) throw new Error('剧集不存在或无权限访问');
  const script = String(ep.script_content || ep.description || '').trim();
  if (!script) throw new Error('剧本内容为空，请先生成剧集内容');
  return { ep, script };
}

function referenceErrors(ir, idx, known) {
  const errs = [];
  if (!known.scenes.has(ir.scene.scene_id)) errs.push(`第 ${idx + 1} 段：场景 id ${ir.scene.scene_id} 不属于本剧`);
  ir.cast.forEach((c) => { if (!known.characters.has(c.character_id)) errs.push(`第 ${idx + 1} 段：角色 id ${c.character_id} 不属于本剧`); });
  ir.prop_refs.forEach((p) => { if (!known.props.has(p.prop_id)) errs.push(`第 ${idx + 1} 段：道具 id ${p.prop_id} 不属于本剧`); });
  return errs;
}

/** 生成并保存；返回 { storyboard_ids, findings }。供后台任务与测试直接调用 */
async function runStructuredStoryboardGeneration(db, log, episodeId, opts = {}) {
  const { ep, script } = loadEpisode(db, episodeId);
  const characters = db.prepare('SELECT id, name, role FROM characters WHERE drama_id = ? AND deleted_at IS NULL ORDER BY id').all(ep.drama_id);
  const scenes = db.prepare('SELECT id, location, time FROM scenes WHERE drama_id = ? AND deleted_at IS NULL ORDER BY id').all(ep.drama_id);
  const props = db.prepare('SELECT id, name FROM props WHERE drama_id = ? AND deleted_at IS NULL ORDER BY id').all(ep.drama_id);
  const { caps } = videoClient.resolveVideoTarget(db, opts.videoModel);

  const text = await aiClient.generateText(db, log, 'text', rules.userPrompt({ script, characters, scenes, props, caps }), rules.systemPrompt(caps), {
    scene_key: 'storyboard_extraction',
    model: opts.model || undefined,
    temperature: 0.4,
    max_tokens: 16384,
  });
  let arr = null;
  try {
    arr = extractFirstArray(safeParseAIJSON(String(text || ''), [], log));
  } catch (e) {
    throw new Error('结构化分镜生成失败：模型输出不是可解析的 JSON（' + e.message + '）');
  }
  if (!Array.isArray(arr) || !arr.length) throw new Error('结构化分镜生成失败：模型没有返回任何分镜段');

  const known = {
    characters: new Set(characters.map((c) => c.id)),
    scenes: new Set(scenes.map((s) => s.id)),
    props: new Set(props.map((p) => p.id)),
  };
  const errors = [];
  const irs = arr.map((raw, i) => {
    const r = parseSegmentIr(raw);
    if (!r.ok) {
      errors.push(...r.errors.slice(0, 3).map((e) => `第 ${i + 1} 段 ${e.path || '(root)'}：${e.message}`));
      return null;
    }
    errors.push(...referenceErrors(r.ir, i, known));
    return r.ir;
  });
  if (errors.length) throw new Error('结构化分镜生成失败，模型输出未通过校验：' + errors.slice(0, 6).join('；'));

  const plan = planSegments(irs, caps, { episode: true });
  const now = new Date().toISOString();
  const ids = [];
  db.transaction(() => {
    db.prepare('UPDATE storyboards SET deleted_at = ? WHERE episode_id = ? AND deleted_at IS NULL').run(now, ep.id);
    const ins = db.prepare(
      `INSERT INTO storyboards (episode_id, storyboard_number, title, creation_mode, status, created_at, updated_at)
       VALUES (?, ?, ?, 'classic', 'pending', ?, ?)`
    );
    plan.segments.forEach((seg, i) => {
      const title = (seg.ir.shots.find((s) => s.event) || {}).event || `分镜${i + 1}`;
      const id = Number(ins.run(ep.id, i + 1, String(title).slice(0, 40), now, now).lastInsertRowid);
      storyboardService.saveSegmentIr(db, log, id, seg.ir);
      ids.push(id);
    });
  })();
  const segments = plan.segments.map((s, i) => ({ storyboard_id: ids[i], ir: s.ir }));
  const continuity = episodeContinuityService.getContinuity(db, ep.id) || {};
  const findings = [...plan.findings, ...lintEpisode(segments, { continuity }), ...lintDialogueFidelity(segments, script)];
  log.info('Structured storyboards generated', { episode_id: ep.id, segments: ids.length, findings: findings.length });
  return { storyboard_ids: ids, findings };
}

/** 路由入口：建任务后台执行 */
function startStructuredStoryboardGeneration(db, log, episodeId, opts = {}) {
  loadEpisode(db, episodeId);
  const task = taskService.createTask(db, log, 'storyboard_generation', String(episodeId));
  setImmediate(async () => {
    try {
      taskService.updateTaskStatus(db, task.id, 'processing', 10, '正在生成结构化分镜…');
      const result = await runStructuredStoryboardGeneration(db, log, episodeId, opts);
      taskService.updateTaskResult(db, task.id, { ...result, total: result.storyboard_ids.length });
    } catch (err) {
      log.error('Structured storyboard generation failed', { episode_id: episodeId, error: err.message });
      taskService.updateTaskError(db, task.id, err.message);
    }
  });
  return { task_id: task.id, status: 'pending', message: '结构化分镜生成任务已创建，正在后台处理...' };
}

module.exports = { startStructuredStoryboardGeneration, runStructuredStoryboardGeneration };
