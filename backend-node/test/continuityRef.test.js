const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { tailFrameEligibility } = require('../src/services/segmentCompile/continuity');
const tailFrameLinkService = require('../src/services/tailFrameLinkService');
const storyboardService = require('../src/services/storyboardService');
const segmentCompileService = require('../src/services/segmentCompileService');
const { parseSegmentIr } = require('../src/services/segmentIr/schema');
const { createIrTestDb, sampleIr, mockRes, noopLog } = require('./helpers/segmentIrFixtures');
const { ffmpegSkip, makeClip, tmpStorage } = require('./helpers/mediaFixtures');

const IDS = { sceneId: 3, linId: 1, hrId: 2 };
const ir = (o) => parseSegmentIr(sampleIr(IDS, o)).ir;

/** 两条相邻的结构化分镜，第一条有一条已完成的视频 */
function setup(storage, nextOverrides = {}) {
  const { db, ids } = createIrTestDb();
  storyboardService.saveSegmentIr(db, noopLog, ids.sbIr, sampleIr(ids));
  storyboardService.saveSegmentIr(db, noopLog, ids.sbLegacy, sampleIr(ids, nextOverrides));
  const rel = 'projects/x/videos/v1.mp4';
  if (storage) {
    fs.mkdirSync(path.join(storage, 'projects/x/videos'), { recursive: true });
    makeClip(path.join(storage, rel), 2, null, 440, 'red');
  }
  db.prepare("INSERT INTO video_generations (drama_id, storyboard_id, provider, prompt, status, local_path, created_at, updated_at) VALUES (?, ?, 'test', 'p', 'completed', ?, ?, ?)")
    .run(ids.dramaId, ids.sbIr, rel, '2026-11-18T10:00:00.000Z', '2026-11-18T10:00:00.000Z');
  return { db, ids };
}

function link(db, ids, storage) {
  const res = mockRes();
  const cfg = { storage: { local_path: storage || '/nonexistent' } };
  return tailFrameLinkService(db, cfg, noopLog).linkTailFrame({ params: { id: String(ids.sbIr) }, body: { drama_id: ids.dramaId } }, res).then(() => res);
}

describe('continuity tail frame (AC14)', () => {
  it('tail frame only for same scene state', async () => {
    assert.equal(tailFrameEligibility(ir(), ir()).ok, true);
    assert.equal(tailFrameEligibility(ir(), ir({ scene: { scene_id: 3, state_id: 9, setting: '夜' } })).ok, false, 'different scene state');
    assert.equal(tailFrameEligibility(ir(), ir({ scene: { scene_id: 4, state_id: null, setting: 'x' } })).ok, false, 'different scene');
    const lonely = ir();
    lonely.cast = [{ character_id: 99, wardrobe_id: null, alias: '路人', group: false }];
    lonely.shots.forEach((s) => { s.subjects = []; s.lines = []; });
    assert.equal(tailFrameEligibility(ir(), lonely).ok, false, 'no shared character');
    assert.equal(tailFrameEligibility(null, ir()).ok, false, 'legacy predecessor');

    const { db, ids } = setup(null, { scene: { scene_id: 999, state_id: null, setting: 'x' } });
    const before = db.prepare('SELECT COUNT(*) AS n FROM image_generations').get().n;
    const res = await link(db, ids, null);
    assert.equal(res.statusCode, 409);
    assert.equal(res.body.code, 'tail_frame_not_applicable');
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM image_generations').get().n, before, 'nothing written');
  });

  it('extracts last frame', { skip: ffmpegSkip }, () => {
    const dir = tmpStorage();
    const clip = makeClip(path.join(dir, 'c.mp4'), 2, null, 440, 'green');
    const out = path.join(dir, 'last.jpg');
    assert.deepEqual(tailFrameLinkService.extractLastFrame(clip, out), { ok: true });
    assert.ok(fs.statSync(out).size > 100);
    assert.equal(tailFrameLinkService.extractLastFrame(path.join(dir, 'missing.mp4'), path.join(dir, 'x.jpg')).ok, false);
  });

  it('tail frame written through ir', { skip: ffmpegSkip }, async () => {
    const storage = tmpStorage();
    const { db, ids } = setup(storage);
    const colsBefore = db.prepare('SELECT first_frame_image_id, image_url, local_path FROM storyboards WHERE id = ?').get(ids.sbLegacy);
    const res = await link(db, ids, storage);
    assert.equal(res.statusCode, 200, JSON.stringify(res.body));
    const row = db.prepare('SELECT first_frame_image_id, image_url, local_path, segment_ir FROM storyboards WHERE id = ?').get(ids.sbLegacy);
    const cont = JSON.parse(row.segment_ir).continuity;
    assert.equal(cont.tail_ref_from, ids.sbIr);
    assert.equal(cont.first_frame_image_id, res.body.new_first_frame_image_id);
    assert.deepEqual({ first_frame_image_id: row.first_frame_image_id, image_url: row.image_url, local_path: row.local_path }, colsBefore, 'storyboard columns untouched');
  });

  it('stale tail frame blocks', () => {
    const { db, ids } = setup(null);
    const img = Number(db.prepare("INSERT INTO image_generations (drama_id, storyboard_id, provider, prompt, status, image_url, created_at, updated_at) VALUES (?, ?, 'tail-frame', 'p', 'completed', 'http://cdn/tail.jpg', ?, ?)")
      .run(ids.dramaId, ids.sbLegacy, '2026-11-18T10:05:00.000Z', '2026-11-18T10:05:00.000Z').lastInsertRowid);
    const next = sampleIr(ids);
    next.continuity = { mode: 'refs', tail_ref_from: ids.sbIr, first_frame_image_id: img };
    storyboardService.saveSegmentIr(db, noopLog, ids.sbLegacy, next);

    const aiConfigService = require('../src/services/aiConfigService');
    const savedList = aiConfigService.listConfigs;
    aiConfigService.listConfigs = () => [{ id: 1, service_type: 'video', is_active: true, is_default: true, provider: 'volcengine', api_protocol: 'volcengine_omni', base_url: 'https://ark', api_key: 'k', model: ['doubao-seedance-2-0-260128'], default_model: 'doubao-seedance-2-0-260128' }];
    let fresh;
    try { fresh = segmentCompileService.compileStoryboard(db, ids.sbLegacy); } finally { aiConfigService.listConfigs = savedList; }
    assert.ok(!fresh.findings.some((f) => f.code.startsWith('tail_frame')), JSON.stringify(fresh.findings));
    const tailRef = fresh.compiled.refs.find((r) => r.kind === 'tail_frame');
    assert.equal(tailRef && tailRef.url, 'http://cdn/tail.jpg', 'fresh tail frame bound as a reference');

    db.prepare("INSERT INTO video_generations (drama_id, storyboard_id, provider, prompt, status, created_at, updated_at) VALUES (?, ?, 'test', 'p', 'completed', ?, ?)")
      .run(ids.dramaId, ids.sbIr, '2026-11-18T11:00:00.000Z', '2026-11-18T11:00:00.000Z');
    const stale = segmentCompileService.compileStoryboard(db, ids.sbLegacy);
    assert.equal(stale.blocked, true);
    assert.ok(stale.findings.some((f) => f.code === 'tail_frame_stale'));

    db.prepare('UPDATE video_generations SET deleted_at = ? WHERE storyboard_id = ?').run('x', ids.sbIr);
    const missing = segmentCompileService.compileStoryboard(db, ids.sbLegacy);
    assert.ok(missing.findings.some((f) => f.code === 'tail_frame_source_missing' && f.level === 'block'));
  });
});
