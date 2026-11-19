const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const imageClient = require('../src/services/imageClient');
const assetVariantService = require('../src/services/assetVariantService');
const variantRoutes = require('../src/routes/assetVariants');
const { runMigrationsAndEnsure } = require('../src/db/migrate');
const A = require('../src/services/segmentCompile/rules/assetPhrases');
const { createIrTestDb, mockRes, noopLog } = require('./helpers/segmentIrFixtures');

let db, ids, captured, original;
beforeEach(() => {
  ({ db, ids } = createIrTestDb());
  original = imageClient.createAndGenerateImage;
  captured = [];
  imageClient.createAndGenerateImage = (_db, _log, opts) => {
    captured.push(opts);
    opts.on_completed({ image_url: 'http://cdn/wardrobe.png', local_path: 'projects/x/characters/w.png', image_gen_id: 99 });
    return { id: 99, status: 'pending' };
  };
});
afterEach(() => { imageClient.createAndGenerateImage = original; });

describe('character wardrobes (AC11)', () => {
  it('variant references base sheet', () => {
    db.prepare("UPDATE characters SET image_url = 'http://cdn/lin.png', local_path = 'projects/x/characters/lin.png', appearance = '三十岁男性，短发' WHERE id = ?").run(ids.linId);
    const w = assetVariantService.create(db, 'wardrobe', ids.linId, { name: '西装', change_phrase: '深灰西装，白衬衫' });
    assetVariantService.generateImage(db, noopLog, 'wardrobe', w.id);
    const opts = captured[0];
    assert.deepEqual(opts.reference_image_urls, ['http://localhost:5679/static/projects/x/characters/lin.png']);
    assert.equal(opts.character_id, undefined, 'does not target the character main image');
    assert.match(opts.prompt, /深灰西装，白衬衫/);
    const row = db.prepare('SELECT * FROM character_wardrobes WHERE id = ?').get(w.id);
    assert.equal(row.local_path, 'projects/x/characters/w.png');
    assert.equal(db.prepare('SELECT local_path FROM characters WHERE id = ?').get(ids.linId).local_path, 'projects/x/characters/lin.png', 'main image untouched');

    const noBase = assetVariantService.create(db, 'wardrobe', ids.hrId, { name: '便装', change_phrase: '灰色卫衣' });
    assert.throws(() => assetVariantService.generateImage(db, noopLog, 'wardrobe', noBase.id), (e) => e.code === 'base_image_missing');
  });

  it('wardrobe sheet has exactly one clear face clause', () => {
    db.prepare("UPDATE characters SET image_url = 'http://cdn/lin.png' WHERE id = ?").run(ids.linId);
    const w = assetVariantService.create(db, 'wardrobe', ids.linId, { name: '工装', change_phrase: '蓝色工装短裤' });
    const { prompt } = assetVariantService.generateImage(db, noopLog, 'wardrobe', w.id);
    assert.equal(prompt.split(A.CLEAR_FACE).length - 1, 1);
    assert.ok(prompt.includes(A.oneClearFaceLayout));
    assert.ok(prompt.includes(A.wardrobeLead('林远')));
  });

  it('stages migrate to wardrobes', () => {
    db.prepare('UPDATE characters SET stages = ? WHERE id = ?').run(JSON.stringify([
      { episode_range: [1, 3], appearance: '旧T恤卡其裤' },
      { episode_range: [4, 4], appearance: '工装短裤' },
      { appearance: '' },
    ]), ids.linId);
    const quiet = console.log; console.log = () => {};
    try {
      runMigrationsAndEnsure(db);
      runMigrationsAndEnsure(db);
    } finally { console.log = quiet; }
    const rows = db.prepare('SELECT name, change_phrase, episode_range FROM character_wardrobes WHERE character_id = ? ORDER BY sort_order').all(ids.linId);
    assert.deepEqual(rows.map((r) => r.name), ['第1–3集造型', '第4集造型']);
    assert.equal(rows[0].change_phrase, '旧T恤卡其裤');
    assert.equal(rows[0].episode_range, '[1,3]');
    assert.ok(db.prepare('SELECT stages FROM characters WHERE id = ?').get(ids.linId).stages, 'stages column kept');
  });

  it('wardrobe routes validate and 404', () => {
    const r = variantRoutes(db, noopLog)('wardrobe');
    const missing = mockRes();
    r.list({ params: { id: '99999' } }, missing);
    assert.equal(missing.statusCode, 404);
    const bad = mockRes();
    r.create({ params: { id: String(ids.linId) }, body: { name: '' } }, bad);
    assert.equal(bad.statusCode, 422);
    const ok = mockRes();
    r.create({ params: { id: String(ids.linId) }, body: { name: '西装', change_phrase: '深灰西装' } }, ok);
    assert.equal(ok.statusCode, 201);
    const list = mockRes();
    r.list({ params: { id: String(ids.linId) } }, list);
    assert.equal(list.body.data.length, 1);
  });
});
