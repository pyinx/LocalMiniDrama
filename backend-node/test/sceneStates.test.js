const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const imageClient = require('../src/services/imageClient');
const assetVariantService = require('../src/services/assetVariantService');
const A = require('../src/services/segmentCompile/rules/assetPhrases');
const { createIrTestDb, noopLog } = require('./helpers/segmentIrFixtures');

let db, ids, sent, original;
beforeEach(() => {
  ({ db, ids } = createIrTestDb());
  db.prepare("UPDATE scenes SET image_url = 'http://cdn/room.png' WHERE id = ?").run(ids.sceneId);
  original = imageClient.createAndGenerateImage;
  sent = [];
  imageClient.createAndGenerateImage = (_db, _log, opts) => {
    sent.push(opts);
    opts.on_completed({ image_url: 'http://cdn/state.png', local_path: null, image_gen_id: 1 });
    return { id: 1 };
  };
});
afterEach(() => { imageClient.createAndGenerateImage = original; });

describe('scene states (AC12 / AC30)', () => {
  it('portrait version references master', () => {
    const st = assetVariantService.create(db, 'scene_state', ids.sceneId, { name: '日·主机位', kind: 'portrait', state_phrase: '白天，百叶窗半开' });
    assetVariantService.generateImage(db, noopLog, 'scene_state', st.id);
    assert.deepEqual(sent[0].reference_image_urls, ['http://cdn/room.png']);
    assert.equal(sent[0].size, '1024x1792');
    assert.equal(sent[0].scene_id, undefined, 'master image untouched');
    assert.ok(sent[0].prompt.includes(A.scenePortrait));
    assert.ok(sent[0].prompt.includes(A.sceneStateLead('会议室')));
    assert.equal(db.prepare('SELECT image_url FROM scene_states WHERE id = ?').get(st.id).image_url, 'http://cdn/state.png');
    assert.equal(db.prepare('SELECT image_url FROM scenes WHERE id = ?').get(ids.sceneId).image_url, 'http://cdn/room.png');
  });

  it('reverse version references master', () => {
    const st = assetVariantService.create(db, 'scene_state', ids.sceneId, { name: '反打', kind: 'reverse', state_phrase: '白天' });
    assetVariantService.generateImage(db, noopLog, 'scene_state', st.id);
    assert.deepEqual(sent[0].reference_image_urls, ['http://cdn/room.png']);
    assert.ok(sent[0].prompt.includes(A.sceneReverse));
    assert.ok(!sent[0].prompt.includes(A.scenePortrait));
    assert.equal(sent[0].size, '1792x1024');
    assert.throws(() => assetVariantService.create(db, 'scene_state', ids.sceneId, { name: 'x', kind: 'top', state_phrase: 'y' }), (e) => e.code === 'variant_invalid');
  });
});
