const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const storyboardService = require('../src/services/storyboardService');
const episodeStoryboardService = require('../src/services/episodeStoryboardService');
const { projectLegacyFields } = require('../src/services/segmentIr/project');
const storyboardRoutes = require('../src/routes/storyboards');
const { createIrTestDb, sampleIr, mockRes, noopLog } = require('./helpers/segmentIrFixtures');

let db;
let ids;
let routes;
beforeEach(() => {
  ({ db, ids } = createIrTestDb());
  routes = storyboardRoutes(db, noopLog);
});

function row(id) {
  return db.prepare('SELECT * FROM storyboards WHERE id = ?').get(id);
}

function saveIr(ir = sampleIr(ids)) {
  return storyboardService.saveSegmentIr(db, noopLog, ids.sbIr, ir);
}

function callUpdate(id, body) {
  const res = mockRes();
  routes.update({ params: { id: String(id) }, body }, res);
  return res;
}

describe('segment IR ownership (AC23 / AC33 / AC40)', () => {
  it('legacy fields are projected', () => {
    const sb = saveIr();
    const r = row(ids.sbIr);
    assert.equal(r.segment_ir_version, 1);
    assert.deepEqual(JSON.parse(r.segment_ir).shots.length, 2);
    assert.equal(r.duration, 8);
    assert.equal(r.scene_id, ids.sceneId);
    assert.deepEqual(JSON.parse(r.characters), [ids.linId, ids.hrId]);
    assert.equal(r.movement, '缓推');
    assert.equal(r.shot_type, '中景、近景');
    assert.equal(r.action, '人事把协议推过桌面；林远手指收紧');
    assert.equal(r.dialogue, '人事：签个字吧。\n林远：是因为绩效吗？\n林远（os）：果然轮到我了。');
    assert.equal(sb.segment_ir.duration_s, 8, 'DTO exposes parsed IR');
  });

  it('projection excludes compiled text', () => {
    const p = projectLegacyFields(sampleIr(ids));
    assert.ok(!('universal_segment_text' in p));
    assert.deepEqual(Object.keys(p).sort(), ['action', 'characters', 'dialogue', 'duration', 'movement', 'scene_id', 'shot_type']);
    saveIr();
    assert.equal(row(ids.sbIr).universal_segment_text, '旧全能文本', 'saving IR does not write compiled text');
  });

  it('generic update rejected for ir storyboard', () => {
    saveIr();
    const before = row(ids.sbIr);
    for (const body of [{ dialogue: '改了' }, { duration: 12 }, { character_ids: [ids.linId] }, { universal_segment_text: '新文本' }, { title: '新标题', movement: '急推' }]) {
      const res = callUpdate(ids.sbIr, body);
      assert.equal(res.statusCode, 409, JSON.stringify(body));
      assert.equal(res.body.error.code, 'segment_ir_owned');
      assert.ok(res.body.error.details.fields.length > 0);
    }
    assert.deepEqual(row(ids.sbIr), before, 'rejected updates change nothing');
  });

  it('unchanged projected fields accepted', () => {
    saveIr();
    const dto = storyboardService.getStoryboardById(db, ids.sbIr);
    const res = callUpdate(ids.sbIr, { ...dto, duration: String(dto.duration), title: '新标题' });
    assert.equal(res.statusCode, 200, JSON.stringify(res.body));
    assert.equal(row(ids.sbIr).title, '新标题');
  });

  it('ir edit reprojects', () => {
    saveIr();
    const ir = sampleIr(ids);
    ir.shots[1].lines = [{ kind: 'dialogue', speaker: '林远', text: '好，我签。', delivery: '平静', voice: null }];
    ir.shots[1].seconds = 6;
    ir.duration_s = 9;
    ir.cast = [ir.cast[1], ir.cast[0]];
    const res = mockRes();
    routes.updateSegmentIr({ params: { id: String(ids.sbIr) }, body: { ir } }, res);
    assert.equal(res.statusCode, 200, JSON.stringify(res.body));
    const r = row(ids.sbIr);
    assert.equal(r.duration, 9);
    assert.match(r.dialogue, /林远：好，我签。/);
    assert.deepEqual(JSON.parse(r.characters), [ids.hrId, ids.linId]);

    const bad = mockRes();
    routes.updateSegmentIr({ params: { id: String(ids.sbIr) }, body: { ir: { ...ir, duration_s: 99 } } }, bad);
    assert.equal(bad.statusCode, 422);
    assert.equal(bad.body.error.code, 'segment_ir_invalid');
    assert.equal(row(ids.sbIr).duration, 9, 'invalid IR does not overwrite');

    const missing = mockRes();
    routes.updateSegmentIr({ params: { id: '99999' }, body: { ir } }, missing);
    assert.equal(missing.statusCode, 404);
  });

  it('legacy storyboard update unchanged', () => {
    const res = callUpdate(ids.sbLegacy, { dialogue: '新台词', duration: 7, movement: '急推' });
    assert.equal(res.statusCode, 200);
    const r = row(ids.sbLegacy);
    assert.equal(r.dialogue, '新台词');
    assert.equal(r.duration, 7);
    assert.equal(r.segment_ir, null);
  });

  it('agent tool edits ir', async () => {
    const { executeUpdateStoryboard } = await import('../src/mastra/tools.mjs');
    saveIr();
    const refused = executeUpdateStoryboard(db, noopLog, ids.dramaId, { id: ids.sbIr, dialogue: '改台词' });
    assert.equal(refused.ok, false);
    assert.match(refused.error, /segmentIr/);
    assert.equal(row(ids.sbIr).dialogue.startsWith('人事：'), true);

    const ir = sampleIr(ids);
    ir.shots[0].lines[0].text = '请签字。';
    const ok = executeUpdateStoryboard(db, noopLog, ids.dramaId, { id: ids.sbIr, segmentIr: JSON.stringify(ir) });
    assert.equal(ok.ok, true, ok.error);
    assert.match(row(ids.sbIr).dialogue, /人事：请签字。/);

    const badIr = executeUpdateStoryboard(db, noopLog, ids.dramaId, { id: ids.sbIr, segmentIr: '{"version":1}' });
    assert.equal(badIr.ok, false);

    const imageOnly = executeUpdateStoryboard(db, noopLog, ids.dramaId, { id: ids.sbIr, imagePrompt: '雨夜' });
    assert.equal(imageOnly.ok, true, 'non-projected fields still editable');
  });

  it('universal polish rejected for ir storyboard', async () => {
    saveIr();
    for (const [name, body] of [
      ['generateUniversalSegmentPrompt', {}],
      ['generateUniversalSegmentStream', {}],
      ['polishUniversalSegmentStream', { draft_universal_segment_text: '画面风格和类型: x\n分镜1： 5秒: y' }],
    ]) {
      const res = mockRes();
      await routes[name]({ params: { id: String(ids.sbIr) }, body }, res);
      assert.equal(res.statusCode, 409, name);
      assert.equal(res.body.error.code, 'segment_ir_owned', name);
    }
    assert.equal(row(ids.sbIr).universal_segment_text, '旧全能文本');
  });

  it('split by audio rejected for ir storyboard', () => {
    saveIr();
    const before = db.prepare('SELECT COUNT(*) AS n FROM storyboards WHERE deleted_at IS NULL').get().n;
    assert.throws(() => episodeStoryboardService.splitStoryboardByAudio(db, noopLog, ids.sbIr), (e) => e.code === 'segment_ir_owned');
    const res = mockRes();
    routes.splitByAudio({ params: { id: String(ids.sbIr) }, body: {} }, res);
    assert.equal(res.statusCode, 409);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM storyboards WHERE deleted_at IS NULL').get().n, before);
  });

  it('auto character sync skips ir storyboard', () => {
    const { syncStoryboardCharacters } = require('../src/services/imageService');
    const ir = sampleIr(ids);
    ir.cast = [ir.cast[1]];
    ir.shots = [{ ...ir.shots[0], seconds: 8, subjects: [ir.shots[0].subjects[0]], action: '人事看向林远的空座位', lines: [] }];
    storyboardService.saveSegmentIr(db, noopLog, ids.sbIr, ir);
    const before = row(ids.sbIr).characters;
    assert.deepEqual(syncStoryboardCharacters(db, noopLog, ids.sbIr).added, []);
    assert.equal(row(ids.sbIr).characters, before, 'name in action text does not add a character to an IR storyboard');
    db.prepare('UPDATE storyboards SET action = ?, characters = ? WHERE id = ?').run('人事看向林远', '[]', ids.sbLegacy);
    assert.ok(syncStoryboardCharacters(db, noopLog, ids.sbLegacy).added.length > 0, 'legacy storyboards still auto-fill');
  });

  it('batch infer rejected for ir storyboard', () => {
    saveIr();
    const before = row(ids.sbIr);
    const legacyBefore = row(ids.sbLegacy);
    const res = mockRes();
    routes.batchInferParams({ body: { episode_id: ids.episodeId, overwrite: true } }, res);
    assert.equal(res.statusCode, 409);
    assert.deepEqual(res.body.error.details.storyboard_ids, [ids.sbIr]);
    assert.deepEqual(row(ids.sbIr), before);
    assert.deepEqual(row(ids.sbLegacy), legacyBefore, 'whole batch is rejected, nothing written');

    const keep = mockRes();
    routes.batchInferParams({ body: { episode_id: ids.episodeId, overwrite: false } }, keep);
    assert.equal(keep.statusCode, 200, 'fill-missing mode leaves projected movement alone');
    assert.equal(row(ids.sbIr).movement, '缓推');
  });
});
