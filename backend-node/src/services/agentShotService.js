/**
 * shot-director：机位/动作编排提议（写 notes），以及基于现有确定性编译的连续性复核（只读）。
 * 不写 SegmentIR、不改分镜表，复核依赖可注入以便测试。
 */
'use strict';

const { z } = require('zod');
const { safeParseAIJSON } = require('../utils/safeJson');
const { parseSegmentIr } = require('./segmentIr/schema');
const { tailFrameEligibility } = require('./segmentCompile/continuity');

const blockingSchema = z.object({
  proposal: z.object({
    master_shot: z.string().min(1),
    axis: z.string().min(1),
    beats: z.array(z.object({
      order: z.number().int().positive(),
      shot: z.string().min(1),
      action: z.string().min(1),
      camera: z.string().min(1),
    })).min(1).max(20),
    notes: z.string().default(''),
  }),
});

function fail(error) {
  return { ok: false, error };
}

function episodeOf(db, dramaId, episodeId) {
  return db.prepare(
    'SELECT id, drama_id, script_content, description FROM episodes WHERE id = ? AND drama_id = ? AND deleted_at IS NULL'
  ).get(Number(episodeId), Number(dramaId));
}

async function proposeBlocking({ db, log, notes, deps, dramaId, episodeId, sceneId }) {
  const ep = episodeOf(db, dramaId, episodeId);
  if (!ep) return fail('not_found');
  const script = String(ep.script_content || ep.description || '').trim();
  if (!script) return fail('empty_script');
  if (sceneId != null && !db.prepare('SELECT id FROM scenes WHERE id = ? AND drama_id = ? AND deleted_at IS NULL')
    .get(Number(sceneId), Number(dramaId))) return fail('not_found');
  if (!deps || typeof deps.generateText !== 'function') return fail('model_unavailable');

  let raw;
  try {
    raw = await deps.generateText([
      '本集剧本：', script,
      sceneId != null ? '目标场景 id：' + Number(sceneId) : '',
      '先定主机位与轴线，再给逐拍动作与机位；只写摄像机拍得到的动作，不写情绪标签。',
      '只输出 JSON：{"proposal":{"master_shot":"...","axis":"...","beats":[{"order":1,"shot":"...","action":"...","camera":"..."}],"notes":""}}',
    ].filter(Boolean).join('\n'), '你是短剧调度编辑。只输出 JSON，不改分镜表。');
  } catch (_) {
    return fail('proposal_failed');
  }
  let parsed;
  try {
    parsed = safeParseAIJSON(String(raw || ''), {}, log || { warn() {} });
  } catch (_) {
    return fail('proposal_invalid');
  }
  const validated = blockingSchema.safeParse(parsed);
  if (!validated.success) return fail('proposal_invalid');

  const kind = `episode-${ep.id}-direction`;
  const note = notes.readOrEmpty(Number(dramaId), kind);
  if (!note.ok) return fail(note.error);
  const saved = notes.write(Number(dramaId), kind, note.revision, {
    ...note.document,
    scene_id: sceneId == null ? null : Number(sceneId),
    proposal: validated.data.proposal,
  });
  if (!saved.ok) return fail(saved.error);
  return { ok: true, proposal: validated.data.proposal, revision: saved.revision };
}

function reviewShotContinuity({ db, notes, dramaId, episodeId, storyboardId, deps = {} }) {
  const shot = db.prepare(
    `SELECT s.id, s.segment_ir, s.episode_id, s.storyboard_number, e.drama_id FROM storyboards s JOIN episodes e ON e.id = s.episode_id
     WHERE s.id = ? AND s.deleted_at IS NULL AND e.deleted_at IS NULL`
  ).get(Number(storyboardId));
  if (!shot || Number(shot.drama_id) !== Number(dramaId)) return fail('not_found');
  if (!shot.segment_ir) return fail('legacy_storyboard');
  const parsed = parseSegmentIr(shot.segment_ir);
  if (!parsed.ok) return fail('segment_ir_invalid');

  const compile = deps.compileStoryboard || ((id) => require('./segmentCompileService').compileStoryboard(db, id));
  const result = compile(shot.id);
  if (!result || result.ok === false) return fail(result && result.code ? result.code : 'compile_failed');
  const checkTail = deps.tailFrameEligibility || tailFrameEligibility;
  let tailFrame = null;
  const from = parsed.ir.continuity && parsed.ir.continuity.tail_ref_from;
  if (from != null) {
    const prev = db.prepare(
      `SELECT id, segment_ir FROM storyboards
       WHERE episode_id = ? AND storyboard_number < ? AND deleted_at IS NULL
       ORDER BY storyboard_number DESC, id DESC LIMIT 1`
    ).get(shot.episode_id, shot.storyboard_number || 0);
    const prevParsed = prev && prev.segment_ir ? parseSegmentIr(prev.segment_ir) : null;
    tailFrame = checkTail(prevParsed && prevParsed.ok ? prevParsed.ir : null, parsed.ir);
  }
  const note = notes.readOrEmpty(Number(dramaId), `episode-${Number(episodeId)}-direction`);
  return {
    ok: true,
    findings: result.findings || [],
    blocked: Boolean(result.blocked),
    tail_frame: tailFrame,
    has_direction_notes: note.ok && Boolean(note.document.proposal),
  };
}

module.exports = { proposeBlocking, reviewShotContinuity };
