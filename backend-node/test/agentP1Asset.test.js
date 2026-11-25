'use strict';
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { createAgentTestDb, seedTwoDramas } = require('./helpers/agentTestDb');
const { createAgentNotesService } = require('../src/services/agentNotesService');
const { getAssetMatrix, proposePropStates, checkAssetLock } = require('../src/services/agentAssetService');
const assetVariantService = require('../src/services/assetVariantService');

function memoryFs() {
  const files = new Map();
  return {
    readFileSync(p) {
      if (!files.has(p)) { const e = new Error('missing'); e.code = 'ENOENT'; throw e; }
      return files.get(p);
    },
    mkdirSync() {},
    writeFileSync(p, d) { files.set(p, d); },
  };
}

function fixtures() {
  const db = createAgentTestDb();
  const ids = seedTwoDramas(db);
  db.exec(`
    CREATE TABLE props (id INTEGER PRIMARY KEY AUTOINCREMENT, drama_id INTEGER, name TEXT, description TEXT, deleted_at TEXT);
    CREATE TABLE prop_states (id INTEGER PRIMARY KEY, prop_id INTEGER, name TEXT, state_phrase TEXT, deleted_at TEXT);
    CREATE TABLE scene_states (id INTEGER PRIMARY KEY, scene_id INTEGER, name TEXT, state_phrase TEXT, deleted_at TEXT);
    CREATE TABLE character_wardrobes (id INTEGER PRIMARY KEY, character_id INTEGER, name TEXT, change_phrase TEXT, episode_range TEXT, deleted_at TEXT);
  `);
  db.prepare('INSERT INTO props (id, drama_id, name, description) VALUES (1, 1, ?, ?)').run('信', '关键道具');
  // 对齐生产 DDL（migrations/01_init.sql）：props 主键是 id，不是 prop_id
  const prodDdl = require('fs').readFileSync(require('path').join(__dirname, '../migrations/01_init.sql'), 'utf8');
  assert.match(prodDdl, /CREATE TABLE IF NOT EXISTS props \(\s*id INTEGER PRIMARY KEY/);
  const notes = createAgentNotesService({ dataDir: '/tmp/p1-asset', fs: memoryFs() });
  return { db, ids, notes };
}

const GOOD = { proposals: [{ prop_id: 1, name: '信', state_phrase: '被撕成两半', reason: '剧本里撕信' }] };

describe('asset bible', () => {
  it('asset matrix, prop proposals and lock checks stay read-only', async () => {
    const { db, ids, notes } = fixtures();

    assert.deepEqual(getAssetMatrix(db, notes, 999), { ok: false, error: 'not_found' });
    const matrix = getAssetMatrix(db, notes, ids.dramaA);
    assert.equal(matrix.ok, true);
    assert.equal(matrix.matrix.props[0].name, '信');
    assert.equal(matrix.matrix.characters[0].has_reference, true);
    assert.deepEqual(matrix.prop_proposals, []);

    const savedCreate = assetVariantService.create;
    let createCalled = false;
    assetVariantService.create = () => { createCalled = true; };

    const deps = { generateText: async () => JSON.stringify(GOOD), log: { warn() {} } };
    const proposed = await proposePropStates({
      db, log: deps.log, notes, deps, dramaId: ids.dramaA, episodeId: ids.episodeA1,
    });
    assert.equal(proposed.ok, true);
    assert.equal(proposed.proposals[0].state_phrase, '被撕成两半');
    assert.equal(createCalled, false, 'propose must never call assetVariantService.create');
    assert.equal(notes.read(ids.dramaA, 'asset-matrix').document.prop_proposals.length, 1);
    assert.equal(db.prepare('SELECT COUNT(*) c FROM prop_states').get().c, 0, 'proposal must not write prop_states');

    const bad = { generateText: async () => 'not json', log: deps.log };
    assert.equal((await proposePropStates({ db, log: deps.log, notes, deps: bad, dramaId: ids.dramaA, episodeId: ids.episodeA1 })).error,
      'proposal_invalid');
    const wrongProp = { generateText: async () => JSON.stringify({ proposals: [{ prop_id: 999, name: 'x', state_phrase: 'y' }] }), log: deps.log };
    assert.equal((await proposePropStates({ db, log: deps.log, notes, deps: wrongProp, dramaId: ids.dramaA, episodeId: ids.episodeA1 })).error,
      'proposal_invalid');
    assert.equal(notes.read(ids.dramaA, 'asset-matrix').revision, proposed.revision);

    const after = getAssetMatrix(db, notes, ids.dramaA);
    assert.equal(after.prop_proposals.length, 1);
    assetVariantService.create = savedCreate;

    db.prepare('UPDATE storyboards SET characters = ? WHERE id = ?').run('[1]', ids.storyboardA);
    const lock = checkAssetLock(db, notes, ids.dramaA, ids.episodeA1, ids.storyboardA);
    assert.equal(lock.ok, true);
    assert.equal(lock.assets[0].kind, 'character');
    assert.equal(checkAssetLock(db, notes, ids.dramaB, ids.episodeA1, ids.storyboardA).error, 'not_found');

    // 引用了缺参考图的资产 → asset_unready，且只报被引用资产
    db.prepare("UPDATE storyboards SET characters = '[1,999]' WHERE id = ?").run(ids.storyboardA);
    db.prepare('UPDATE characters SET image_url = NULL, local_path = NULL WHERE id = ?').run(ids.characterA);
    const unready = checkAssetLock(db, notes, ids.dramaA, ids.episodeA1, ids.storyboardA);
    assert.equal(unready.error, 'asset_unready');
    assert.deepEqual(unready.unready.map((u) => u.id), [1]);
    assert.equal(unready.assets.length, 1);
  });
});
