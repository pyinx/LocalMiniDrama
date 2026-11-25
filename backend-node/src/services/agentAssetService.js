/**
 * asset-bible：全剧资产矩阵（只读 DB + notes）、道具状态提议（写 notes，不落库）、资产就绪检查。
 * 不调用 assetVariantService.create / generateImage / setContinuity / 任何付费接口。
 */
'use strict';

const { z } = require('zod');
const { safeParseAIJSON } = require('../utils/safeJson');

const propProposalsSchema = z.object({
  proposals: z.array(z.object({
    prop_id: z.number().int().positive(),
    name: z.string().min(1),
    state_phrase: z.string().min(1),
    reason: z.string().default(''),
  })).min(1).max(20),
});

function fail(error) {
  return { ok: false, error };
}

function matrixFromDb(db, dramaId) {
  const characters = db.prepare(
    'SELECT id, name, appearance, image_url, local_path FROM characters WHERE drama_id = ? AND deleted_at IS NULL ORDER BY id'
  ).all(dramaId).map((r) => ({ id: r.id, name: r.name, has_reference: Boolean(r.image_url || r.local_path) }));
  const scenes = db.prepare(
    'SELECT id, location, time, image_url, local_path FROM scenes WHERE drama_id = ? AND deleted_at IS NULL ORDER BY id'
  ).all(dramaId).map((r) => ({ id: r.id, location: r.location, time: r.time, has_reference: Boolean(r.image_url || r.local_path) }));
  const props = db.prepare(
    'SELECT id AS prop_id, name, description FROM props WHERE drama_id = ? AND deleted_at IS NULL ORDER BY id'
  ).all(dramaId).map((r) => ({ id: r.prop_id, name: r.name }));
  let locks = {};
  try {
    const { getContinuity } = require('./episodeContinuityService');
    const episodes = db.prepare('SELECT id FROM episodes WHERE drama_id = ? AND deleted_at IS NULL ORDER BY episode_number').all(dramaId);
    for (const ep of episodes) {
      const value = getContinuity(db, ep.id);
      if (value && Object.keys(value).length) locks[ep.id] = value;
    }
  } catch (_) { /* 表不存在时视为无锁 */ }
  return { characters, scenes, props, locks };
}

function getAssetMatrix(db, notes, dramaId) {
  if (!Number.isSafeInteger(Number(dramaId)) || Number(dramaId) <= 0) return fail('not_found');
  if (!db.prepare('SELECT id FROM dramas WHERE id = ? AND deleted_at IS NULL').get(Number(dramaId))) return fail('not_found');
  const matrix = matrixFromDb(db, Number(dramaId));
  const note = notes.readOrEmpty(Number(dramaId), 'asset-matrix');
  if (!note.ok) return fail(note.error);
  return {
    ok: true,
    matrix,
    prop_proposals: note.document.prop_proposals || [],
    revision: note.revision,
  };
}

async function proposePropStates({ db, log, notes, deps, dramaId, episodeId }) {
  const ep = db.prepare(
    'SELECT id, drama_id, script_content, description FROM episodes WHERE id = ? AND drama_id = ? AND deleted_at IS NULL'
  ).get(Number(episodeId), Number(dramaId));
  if (!ep) return fail('not_found');
  const script = String(ep.script_content || ep.description || '').trim();
  if (!script) return fail('empty_script');
  const props = db.prepare('SELECT id AS prop_id, name, description FROM props WHERE drama_id = ? AND deleted_at IS NULL ORDER BY id')
    .all(Number(dramaId));
  if (!props.length) return fail('no_props');
  if (!deps || typeof deps.generateText !== 'function') return fail('model_unavailable');

  let raw;
  try {
    raw = await deps.generateText([
      '本集剧本：', script, '',
      '当前剧的道具：' + JSON.stringify(props.map((p) => ({ id: p.prop_id, name: p.name, description: p.description }))),
      '只提议本集中确实发生状态变化的道具（碎裂、点亮、沾血、被拿走等）。每项给出道具 id、名称、状态描述和理由。',
      '只输出 JSON：{"proposals":[{"prop_id":1,"name":"信","state_phrase":"被撕成两半","reason":"剧本里撕信"}]}',
    ].join('\n'), '你是短剧道具状态编辑。只输出 JSON，不改剧本，不创建资产。');
  } catch (_) {
    return fail('proposal_failed');
  }
  let parsed;
  try {
    parsed = safeParseAIJSON(String(raw || ''), {}, log || { warn() {} });
  } catch (_) {
    return fail('proposal_invalid');
  }
  const validated = propProposalsSchema.safeParse(parsed);
  const knownIds = new Set(props.map((p) => Number(p.prop_id)));
  if (!validated.success || validated.data.proposals.some((p) => !knownIds.has(p.prop_id))) return fail('proposal_invalid');

  const note = notes.readOrEmpty(Number(dramaId), 'asset-matrix');
  if (!note.ok) return fail(note.error);
  const previous = Array.isArray(note.document.prop_proposals) ? note.document.prop_proposals : [];
  const saved = notes.write(Number(dramaId), 'asset-matrix', note.revision, {
    ...note.document,
    prop_proposals: [...previous, ...validated.data.proposals.map((p) => ({ ...p, episode_id: ep.id }))],
  });
  if (!saved.ok) return fail(saved.error);
  return { ok: true, proposals: validated.data.proposals, revision: saved.revision };
}

function checkAssetLock(db, notes, dramaId, episodeId, storyboardId) {
  const shot = db.prepare(
    `SELECT s.id, s.storyboard_number, s.characters, s.segment_ir, s.image_url, s.local_path, e.drama_id, e.id AS episode_id
     FROM storyboards s JOIN episodes e ON e.id = s.episode_id
     WHERE s.id = ? AND s.deleted_at IS NULL AND e.deleted_at IS NULL`
  ).get(Number(storyboardId));
  if (!shot || Number(shot.drama_id) !== Number(dramaId)) return fail('not_found');
  const note = notes.readOrEmpty(Number(dramaId), 'asset-matrix');
  if (!note.ok) return fail(note.error);
  const matrix = matrixFromDb(db, Number(dramaId));

  // 只检查这条分镜真正引用的资产，不把整部剧没用到的资产算进来。
  let referencedCharacterIds = [];
  try {
    const raw = JSON.parse(String(shot.characters || '[]'));
    if (Array.isArray(raw)) referencedCharacterIds = raw.map(Number).filter((n) => Number.isSafeInteger(n));
  } catch (_) { /* 旧分镜可能没有 characters 字段 */ }
  let sceneId = null;
  try {
    const ir = shot.segment_ir ? JSON.parse(shot.segment_ir) : null;
    if (ir && ir.scene && Number.isSafeInteger(Number(ir.scene.scene_id))) sceneId = Number(ir.scene.scene_id);
  } catch (_) { /* 非结构化分镜没有场景 id */ }

  const assets = [];
  const unready = [];
  for (const c of matrix.characters.filter((c) => referencedCharacterIds.includes(c.id))) {
    assets.push({ kind: 'character', id: c.id, name: c.name, ready: c.has_reference });
    if (!c.has_reference) unready.push({ kind: 'character', id: c.id, name: c.name });
  }
  for (const s of matrix.scenes.filter((s) => s.id === sceneId)) {
    assets.push({ kind: 'scene', id: s.id, name: s.location, ready: s.has_reference });
    if (!s.has_reference) unready.push({ kind: 'scene', id: s.id, name: s.location });
  }
  if (unready.length) return { ok: false, error: 'asset_unready', assets, unready };
  return { ok: true, storyboard_id: shot.id, assets, locked: Boolean(matrix.locks[String(shot.episode_id)]) };
}

module.exports = { getAssetMatrix, proposePropStates, checkAssetLock };
