const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { parseSegmentIr } = require('../src/services/segmentIr/schema');
const { sampleIr } = require('./helpers/segmentIrFixtures');

const IDS = { sceneId: 3, linId: 1, hrId: 2 };

function errorPaths(r) {
  assert.equal(r.ok, false);
  assert.ok(Array.isArray(r.errors) && r.errors.length > 0);
  return r.errors.map((e) => e.path);
}

describe('segment IR schema (AC5)', () => {
  it('valid ir', () => {
    const r = parseSegmentIr(sampleIr(IDS));
    assert.equal(r.ok, true, JSON.stringify(r.errors));
    assert.equal(r.ir.version, 1);
    assert.equal(r.ir.shots.length, 2);
    const fromString = parseSegmentIr(JSON.stringify(sampleIr(IDS)));
    assert.equal(fromString.ok, true);
  });

  it('missing required fields are reported with paths', () => {
    const ir = sampleIr(IDS);
    delete ir.scene;
    delete ir.shots[0].subjects[0].facing;
    const paths = errorPaths(parseSegmentIr(ir));
    assert.ok(paths.includes('scene'), paths.join(','));
    assert.ok(paths.includes('shots.0.subjects.0.facing'), paths.join(','));
  });

  it('shot seconds must sum to segment duration', () => {
    const paths = errorPaths(parseSegmentIr(sampleIr(IDS, { duration_s: 9 })));
    assert.ok(paths.includes('duration_s'));
  });

  it('non-integer or non-positive durations rejected', () => {
    const ir = sampleIr(IDS);
    ir.shots[0].seconds = 2.5;
    ir.duration_s = 7.5;
    assert.equal(parseSegmentIr(ir).ok, false);
    assert.equal(parseSegmentIr(sampleIr(IDS, { duration_s: 0 })).ok, false);
  });

  it('aliases must resolve to cast and be unique', () => {
    const ir = sampleIr(IDS);
    ir.shots[1].lines[0].speaker = '路人';
    ir.shots[1].subjects[0].alias = '路人';
    const paths = errorPaths(parseSegmentIr(ir));
    assert.ok(paths.includes('shots.1.lines.0.speaker'));
    assert.ok(paths.includes('shots.1.subjects.0.alias'));
    const dup = sampleIr(IDS);
    dup.cast[1].alias = '林远';
    assert.ok(errorPaths(parseSegmentIr(dup)).includes('cast.1.alias'));
  });

  it('dialogue needs a speaker, narration does not', () => {
    const ir = sampleIr(IDS);
    ir.shots[0].lines.push({ kind: 'vo', speaker: null, text: '那天下着雨。', delivery: '平缓', voice: null });
    assert.equal(parseSegmentIr(ir).ok, true);
    ir.shots[0].lines[0].speaker = null;
    assert.ok(errorPaths(parseSegmentIr(ir)).includes('shots.0.lines.0.speaker'));
  });

  it('cards stay inside the segment and first/last mode needs a first frame', () => {
    assert.ok(errorPaths(parseSegmentIr(sampleIr(IDS, { cards: [{ text: '人事部', at_s: 6, hold_s: 3 }] }))).includes('cards.0'));
    assert.ok(errorPaths(parseSegmentIr(sampleIr(IDS, { continuity: { mode: 'first_last' } }))).includes('continuity.first_frame_image_id'));
  });

  it('unparseable input', () => {
    assert.equal(parseSegmentIr('{not json').ok, false);
    assert.equal(parseSegmentIr(null).ok, false);
  });
});

describe('POST /videos rejects bad IR before any request (AC5)', () => {
  const { createIrTestDb, mockRes, noopLog } = require('./helpers/segmentIrFixtures');
  const videoService = require('../src/services/videoService');
  const videoRoutes = require('../src/routes/videos');
  const storyboardService = require('../src/services/storyboardService');

  it('invalid ir rejected before request', () => {
    const { db, ids } = createIrTestDb();
    const original = videoService.processVideoGeneration;
    let dispatched = 0;
    videoService.processVideoGeneration = () => { dispatched++; };
    try {
      const counts = () => [
        db.prepare('SELECT COUNT(*) AS n FROM video_generations').get().n,
        db.prepare('SELECT COUNT(*) AS n FROM async_tasks').get().n,
      ];
      const before = counts();
      const routes = videoRoutes(db, noopLog);

      db.prepare('UPDATE storyboards SET segment_ir = ? WHERE id = ?').run('{"version":1,"shots":[]}', ids.sbIr);
      const bad = mockRes();
      routes.create({ body: { drama_id: ids.dramaId, storyboard_id: ids.sbIr, prompt: 'x' } }, bad);
      assert.equal(bad.statusCode, 422);
      assert.equal(bad.body.error.code, 'segment_ir_invalid');

      // 合法 IR，但引用的角色已删除 → 编译阻断
      storyboardService.saveSegmentIr(db, noopLog, ids.sbIr, sampleIr({ sceneId: ids.sceneId, linId: ids.linId, hrId: ids.hrId }));
      db.prepare('UPDATE characters SET deleted_at = ? WHERE id = ?').run(new Date().toISOString(), ids.hrId);
      const blocked = mockRes();
      routes.create({ body: { drama_id: ids.dramaId, storyboard_id: ids.sbIr, prompt: 'x' } }, blocked);
      assert.equal(blocked.statusCode, 422);
      assert.equal(blocked.body.error.code, 'segment_compile_blocked');
      assert.ok(blocked.body.error.details.findings.some((f) => f.code === 'asset_missing'));

      assert.deepEqual(counts(), before, 'no task and no generation row');
      assert.equal(dispatched, 0, 'no video request dispatched');
    } finally {
      videoService.processVideoGeneration = original;
    }
  });
});

describe('IR binds variant images (AC12)', () => {
  const { createIrTestDb, noopLog } = require('./helpers/segmentIrFixtures');
  const storyboardService = require('../src/services/storyboardService');
  const segmentCompileService = require('../src/services/segmentCompileService');
  const aiConfigService = require('../src/services/aiConfigService');

  it('binds wardrobe and scene state images', () => {
    const { db, ids } = createIrTestDb();
    const now = new Date().toISOString();
    db.prepare("UPDATE characters SET image_url = 'http://cdn/lin-base.png' WHERE id = ?").run(ids.linId);
    db.prepare("UPDATE scenes SET image_url = 'http://cdn/room-master.png' WHERE id = ?").run(ids.sceneId);
    const wid = Number(db.prepare("INSERT INTO character_wardrobes (character_id, name, change_phrase, image_url, created_at, updated_at) VALUES (?, '西装', '深灰西装', 'http://cdn/lin-suit.png', ?, ?)").run(ids.linId, now, now).lastInsertRowid);
    const sid = Number(db.prepare("INSERT INTO scene_states (scene_id, name, kind, state_phrase, image_url, created_at, updated_at) VALUES (?, '夜', 'portrait', '夜晚', 'http://cdn/room-night.png', ?, ?)").run(ids.sceneId, now, now).lastInsertRowid);
    const ir = sampleIr({ sceneId: ids.sceneId, linId: ids.linId, hrId: ids.hrId });
    ir.cast[0].wardrobe_id = wid;
    ir.scene.state_id = sid;
    storyboardService.saveSegmentIr(db, noopLog, ids.sbIr, ir);
    const saved = aiConfigService.listConfigs;
    aiConfigService.listConfigs = () => [{ id: 1, service_type: 'video', is_active: true, is_default: true, provider: 'minimax', api_protocol: 'minimax_h3', base_url: 'https://api', api_key: 'k', model: ['MiniMax-H3'], default_model: 'MiniMax-H3' }];
    try {
      const r = segmentCompileService.compileStoryboard(db, ids.sbIr);
      const urls = Object.fromEntries(r.compiled.refs.map((x) => [x.alias, x.url]));
      assert.equal(urls['林远'], 'http://cdn/lin-suit.png', 'wardrobe image, not the base');
      assert.equal(urls['会议室'], 'http://cdn/room-night.png', 'scene state image, not the master');
    } finally { aiConfigService.listConfigs = saved; }
  });
});
