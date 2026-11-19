const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const characterLibraryService = require('../src/services/characterLibraryService');
const sceneService = require('../src/services/sceneService');
const propService = require('../src/services/propService');
const storyboardService = require('../src/services/storyboardService');
const segmentCompileService = require('../src/services/segmentCompileService');
const { createIrTestDb, sampleIr, noopLog } = require('./helpers/segmentIrFixtures');

function seedVariants(db, ids) {
  const now = new Date().toISOString();
  const propId = Number(db.prepare("INSERT INTO props (drama_id, name, image_url, created_at, updated_at) VALUES (?, '协议', 'http://cdn/p.png', ?, ?)").run(ids.dramaId, now, now).lastInsertRowid);
  const w = Number(db.prepare("INSERT INTO character_wardrobes (character_id, name, change_phrase, created_at, updated_at) VALUES (?, '西装', 'x', ?, ?)").run(ids.linId, now, now).lastInsertRowid);
  const w2 = Number(db.prepare("INSERT INTO character_wardrobes (character_id, name, change_phrase, created_at, updated_at) VALUES (?, '便装', 'y', ?, ?)").run(ids.hrId, now, now).lastInsertRowid);
  const st = Number(db.prepare("INSERT INTO scene_states (scene_id, name, kind, state_phrase, created_at, updated_at) VALUES (?, '夜', 'state', 'z', ?, ?)").run(ids.sceneId, now, now).lastInsertRowid);
  const ps = Number(db.prepare("INSERT INTO prop_states (prop_id, name, state_phrase, created_at, updated_at) VALUES (?, '撕碎', 'w', ?, ?)").run(propId, now, now).lastInsertRowid);
  return { propId, w, w2, st, ps };
}
const deleted = (db, table, id) => db.prepare(`SELECT deleted_at FROM ${table} WHERE id = ?`).get(id).deleted_at != null;

describe('variant cascade (AC25)', () => {
  it('character delete cascades wardrobes', () => {
    const { db, ids } = createIrTestDb();
    const v = seedVariants(db, ids);
    assert.equal(characterLibraryService.deleteCharacter(db, noopLog, ids.linId).ok, true);
    assert.equal(deleted(db, 'character_wardrobes', v.w), true);
    assert.equal(deleted(db, 'character_wardrobes', v.w2), false, 'other characters untouched');
  });

  it('scene and prop delete cascade', () => {
    const { db, ids } = createIrTestDb();
    const v = seedVariants(db, ids);
    assert.equal(sceneService.deleteScene(db, noopLog, ids.sceneId).ok, true);
    assert.equal(deleted(db, 'scene_states', v.st), true);
    assert.equal(propService.deleteById(db, noopLog, v.propId), true);
    assert.equal(deleted(db, 'prop_states', v.ps), true);
    assert.equal(deleted(db, 'character_wardrobes', v.w), false);
  });

  it('ir referencing deleted asset blocks compile', () => {
    const { db, ids } = createIrTestDb();
    const v = seedVariants(db, ids);
    const ir = sampleIr(ids, { prop_refs: [{ prop_id: v.propId, state_id: v.ps, alias: '协议' }] });
    ir.cast[0].wardrobe_id = v.w;
    ir.scene.state_id = v.st;
    storyboardService.saveSegmentIr(db, noopLog, ids.sbIr, ir);
    assert.equal(segmentCompileService.compileStoryboard(db, ids.sbIr).blocked, false);

    sceneService.deleteScene(db, noopLog, ids.sceneId);
    characterLibraryService.deleteCharacter(db, noopLog, ids.linId);
    propService.deleteById(db, noopLog, v.propId);
    const r = segmentCompileService.compileStoryboard(db, ids.sbIr);
    assert.equal(r.blocked, true);
    const missing = r.findings.filter((f) => f.code === 'asset_missing');
    assert.ok(missing.length >= 3, JSON.stringify(missing));
    assert.ok(!r.compiled.refs.some((x) => x.alias === '林远'), 'no silently dropped/stale reference to the deleted character');
  });
});
