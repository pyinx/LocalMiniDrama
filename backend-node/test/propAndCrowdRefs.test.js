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
