const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const segmentCompileService = require('../src/services/segmentCompileService');
const storyboardService = require('../src/services/storyboardService');
const characterLibraryService = require('../src/services/characterLibraryService');
const imageClient = require('../src/services/imageClient');
const A = require('../src/services/segmentCompile/rules/assetPhrases');
const aiConfigService = require('../src/services/aiConfigService');
const { createIrTestDb, sampleIr, noopLog } = require('./helpers/segmentIrFixtures');

/** 在 Seedance 2.x（9 张参考）配置下执行 */
function withSeedance(fn) {
  const saved = aiConfigService.listConfigs;
  aiConfigService.listConfigs = () => [{ id: 1, service_type: 'video', is_active: true, is_default: true, provider: 'volcengine', api_protocol: 'volcengine_omni', base_url: 'https://ark', api_key: 'k', model: ['doubao-seedance-2-0-260128'], default_model: 'doubao-seedance-2-0-260128' }];
  try { return fn(); } finally { aiConfigService.listConfigs = saved; }
}

describe('prop and crowd references (AC29)', () => {
  it('crowd asset binds', () => {
    const { db, ids } = createIrTestDb();
    const now = new Date().toISOString();
    const crowdId = Number(db.prepare("INSERT INTO characters (drama_id, name, appearance, is_group, image_url, created_at, updated_at) VALUES (?, '同事们', '白衬衫上班族', 1, 'http://cdn/crowd.png', ?, ?)").run(ids.dramaId, now, now).lastInsertRowid);

    const original = imageClient.createAndGenerateImage;
    let sent = null;
    imageClient.createAndGenerateImage = (_db, _log, opts) => { sent = opts; return { id: 1 }; };
    try {
      characterLibraryService.generateCharacterImage(db, noopLog, require('../src/config').loadConfig(), crowdId);
    } finally { imageClient.createAndGenerateImage = original; }
    assert.ok(sent.prompt.startsWith(A.crowdSheet('同事们', 3, '白衬衫上班族')), sent.prompt.slice(0, 60));

    const ir = sampleIr(ids);
    ir.cast.push({ character_id: crowdId, wardrobe_id: null, alias: '同事们' });
    storyboardService.saveSegmentIr(db, noopLog, ids.sbIr, ir);
    const r = withSeedance(() => segmentCompileService.compileStoryboard(db, ids.sbIr));
    assert.equal(r.ok, true);
    const crowdRef = r.compiled.refs.find((x) => x.alias === '同事们');
    assert.ok(crowdRef, 'crowd reference bound');
    assert.equal(crowdRef.kind, 'crowd', 'kind follows characters.is_group even though IR cast.group is false');
    assert.ok(r.compiled.prompt.includes(crowdRef.token + ' 是一群「同事们」'));
  });
});

describe('prop states and reference order (AC29)', () => {
  const assetVariantService = require('../src/services/assetVariantService');

  it('prop state references initial image', () => {
    const { db, ids } = createIrTestDb();
    const now = new Date().toISOString();
    const propId = Number(db.prepare("INSERT INTO props (drama_id, name, description, image_url, created_at, updated_at) VALUES (?, '手机', '黑色直板手机', 'http://cdn/phone.png', ?, ?)").run(ids.dramaId, now, now).lastInsertRowid);
    const original = imageClient.createAndGenerateImage;
    let sent = null;
    imageClient.createAndGenerateImage = (_db, _log, opts) => { sent = opts; opts.on_completed({ image_url: 'http://cdn/phone-broken.png', local_path: null }); return { id: 1 }; };
    try {
      const st = assetVariantService.create(db, 'prop_state', propId, { name: '碎屏', state_phrase: '屏幕从左上角裂开' });
      assetVariantService.generateImage(db, noopLog, 'prop_state', st.id);
      assert.deepEqual(sent.reference_image_urls, ['http://cdn/phone.png']);
      assert.ok(sent.prompt.includes(A.propStateLead('手机')));
      assert.ok(sent.prompt.includes('屏幕从左上角裂开'));

      const ir = sampleIr(ids, { prop_refs: [{ prop_id: propId, state_id: st.id, alias: '手机' }] });
      storyboardService.saveSegmentIr(db, noopLog, ids.sbIr, ir);
      const r = withSeedance(() => segmentCompileService.compileStoryboard(db, ids.sbIr));
      assert.equal(r.compiled.refs.find((x) => x.alias === '手机').url, 'http://cdn/phone-broken.png', 'IR binds the state image');
    } finally { imageClient.createAndGenerateImage = original; }
  });

  it('reference order', () => {
    const { db, ids } = createIrTestDb();
    const now = new Date().toISOString();
    db.prepare("UPDATE characters SET image_url = 'http://cdn/lin.png', role = 'main' WHERE id = ?").run(ids.linId);
    db.prepare("UPDATE characters SET image_url = 'http://cdn/hr.png', role = 'supporting' WHERE id = ?").run(ids.hrId);
    db.prepare("UPDATE scenes SET image_url = 'http://cdn/room.png' WHERE id = ?").run(ids.sceneId);
    const crowdId = Number(db.prepare("INSERT INTO characters (drama_id, name, is_group, image_url, created_at, updated_at) VALUES (?, '同事们', 1, 'http://cdn/crowd.png', ?, ?)").run(ids.dramaId, now, now).lastInsertRowid);
    const propId = Number(db.prepare("INSERT INTO props (drama_id, name, image_url, created_at, updated_at) VALUES (?, '协议', 'http://cdn/paper.png', ?, ?)").run(ids.dramaId, now, now).lastInsertRowid);
    const ir = sampleIr(ids, { prop_refs: [{ prop_id: propId, state_id: null, alias: '协议' }] });
    ir.cast = [ir.cast[1], ir.cast[0], { character_id: crowdId, wardrobe_id: null, alias: '同事们' }];
    storyboardService.saveSegmentIr(db, noopLog, ids.sbIr, ir);

    const all = withSeedance(() => segmentCompileService.compileStoryboard(db, ids.sbIr));
    assert.deepEqual(all.compiled.refs.map((r) => r.kind), ['character', 'character', 'crowd', 'scene', 'prop'], 'output order: characters > scene > props');

    // 只留 3 张：场景 > 主角 > 次要角色 > 群像 > 道具
    const caps3 = withSeedance(() => {
      const videoClient = require('../src/services/videoClient');
      const orig = videoClient.resolveVideoTarget;
      videoClient.resolveVideoTarget = (...a) => { const t = orig(...a); return { ...t, caps: { ...t.caps, refImages: 3 } }; };
      try { return segmentCompileService.compileStoryboard(db, ids.sbIr); } finally { videoClient.resolveVideoTarget = orig; }
    });
    assert.deepEqual(caps3.compiled.refs.map((r) => r.alias).sort(), ['人事', '会议室', '林远'].sort());
    assert.deepEqual(caps3.findings.filter((f) => f.code === 'reference_dropped').map((f) => f.where.alias).sort(), ['同事们', '协议'].sort());
  });
});
