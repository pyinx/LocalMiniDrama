const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const aiClient = require('../src/services/aiClient');
const videoService = require('../src/services/videoService');
const videoClient = require('../src/services/videoClient');
const aiConfigService = require('../src/services/aiConfigService');
const videoRoutes = require('../src/routes/videos');
const storyboardRoutes = require('../src/routes/storyboards');
const { runStructuredStoryboardGeneration } = require('../src/services/structuredStoryboardService');
const P = require('../src/services/segmentCompile/rules/phrases');
const { createIrTestDb, sampleIr, mockRes, noopLog } = require('./helpers/segmentIrFixtures');

let db, ids, saved;
beforeEach(() => {
  ({ db, ids } = createIrTestDb());
  saved = { gen: aiClient.generateText, proc: videoService.processVideoGeneration, call: videoClient.callVideoApi, list: aiConfigService.listConfigs };
  videoService.processVideoGeneration = () => {};
});
afterEach(() => {
  aiClient.generateText = saved.gen;
  videoService.processVideoGeneration = saved.proc;
  videoClient.callVideoApi = saved.call;
  aiConfigService.listConfigs = saved.list;
});

function createVideo(body) {
  const res = mockRes();
  videoRoutes(db, noopLog).create({ body: { drama_id: ids.dramaId, ...body } }, res);
  return res;
}
function genRow(res) {
  return db.prepare('SELECT * FROM video_generations WHERE id = ?').get(res.body.data.id);
}

async function regenerateStructured() {
  db.prepare("UPDATE episodes SET script_content = ? WHERE id = ?").run('人事（公式化）：签个字吧。\n林远：是因为绩效吗？\n林远（os）：果然轮到我了。', ids.episodeId);
  const segA = sampleIr(ids);
  const segB = sampleIr(ids, { main_move: '跟拍' });
  segB.shots = [segB.shots[1]];
  segB.duration_s = segB.shots[0].seconds;
  segA.shots = [segA.shots[0]];
  segA.shots[0].seconds = 5;
  segA.duration_s = 5;
  aiClient.generateText = async () => '```json\n' + JSON.stringify([segA, segB]) + '\n```';
  return runStructuredStoryboardGeneration(db, noopLog, ids.episodeId, {});
}

describe('legacy and structured pipelines coexist (AC10)', () => {
  it('old storyboard keeps legacy prompt', () => {
    const res = createVideo({ storyboard_id: ids.sbLegacy, prompt: '旧提示词', style: '水彩' });
    assert.equal(res.statusCode, 201);
    const row = genRow(res);
    assert.equal(row.prompt, '旧提示词. Style: 水彩');
    assert.equal(row.compiled_json, null);
  });

  it('regenerated episode uses compiler', async () => {
    // 同一部剧另一集的旧分镜
    const now = new Date().toISOString();
    const ep2 = db.prepare('INSERT INTO episodes (drama_id, episode_number, title, created_at, updated_at) VALUES (?, 2, ?, ?, ?)').run(ids.dramaId, '第2集', now, now).lastInsertRowid;
    const oldSb = db.prepare("INSERT INTO storyboards (episode_id, storyboard_number, dialogue, duration, created_at, updated_at) VALUES (?, 1, '原台词', 5, ?, ?)").run(ep2, now, now).lastInsertRowid;

    const result = await regenerateStructured();
    assert.ok(result.storyboard_ids.length >= 2);
    const live = db.prepare('SELECT id, segment_ir FROM storyboards WHERE episode_id = ? AND deleted_at IS NULL').all(ids.episodeId);
    assert.deepEqual(live.map((r) => r.id).sort(), [...result.storyboard_ids].sort(), 'old storyboards of the episode replaced');
    assert.ok(live.every((r) => r.segment_ir));

    const res = createVideo({ storyboard_id: result.storyboard_ids[0], prompt: '前端拼的旧提示词', style: '水彩', reference_image_urls: ['http://x/y.png'] });
    assert.equal(res.statusCode, 201, JSON.stringify(res.body));
    const row = genRow(res);
    assert.ok(row.prompt.startsWith(P.stylePrefix), row.prompt.slice(0, 40));
    assert.ok(!row.prompt.includes('前端拼的旧提示词') && !row.prompt.includes('Style: 水彩'));
    assert.ok(row.compiled_json);
    assert.notEqual(row.reference_image_urls, JSON.stringify(['http://x/y.png']), 'frontend refs ignored');

    const legacy = createVideo({ storyboard_id: oldSb, prompt: '第二集旧提示词' });
    assert.equal(genRow(legacy).prompt, '第二集旧提示词');
  });

  it('structured generation fails loudly on invalid model output', async () => {
    db.prepare("UPDATE episodes SET script_content = '剧本' WHERE id = ?").run(ids.episodeId);
    const before = db.prepare('SELECT COUNT(*) AS n FROM storyboards WHERE episode_id = ? AND deleted_at IS NULL').get(ids.episodeId).n;
    aiClient.generateText = async () => JSON.stringify([{ version: 1, duration_s: 5 }]);
    await assert.rejects(runStructuredStoryboardGeneration(db, noopLog, ids.episodeId, {}), /未通过校验/);
    const foreign = sampleIr({ ...ids, sceneId: 999 });
    aiClient.generateText = async () => JSON.stringify([foreign]);
    await assert.rejects(runStructuredStoryboardGeneration(db, noopLog, ids.episodeId, {}), /不属于本剧/);
    aiClient.generateText = async () => '对不起，我无法完成';
    await assert.rejects(runStructuredStoryboardGeneration(db, noopLog, ids.episodeId, {}));
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM storyboards WHERE episode_id = ? AND deleted_at IS NULL').get(ids.episodeId).n, before, 'nothing replaced');
  });

  it('async generation uses the stored compile result', async () => {
    const result = await regenerateStructured();
    const res = createVideo({ storyboard_id: result.storyboard_ids[0] });
    const row = genRow(res);
    aiConfigService.listConfigs = () => [{ id: 1, service_type: 'video', is_active: true, is_default: true, provider: 'volcengine', api_protocol: 'volcengine_omni', base_url: 'https://ark', api_key: 'k', model: ['doubao-seedance-2-0-260128'], default_model: 'doubao-seedance-2-0-260128' }];
    let sent = null;
    videoClient.callVideoApi = async (_db, _log, opts) => { sent = opts; return { error: 'stop here' }; };
    await saved.proc(db, noopLog, row.id);
    assert.equal(sent.prompt, row.prompt);
    assert.equal(sent.duration, row.duration);
    assert.equal(typeof sent.generate_audio, 'boolean');
  });

  it('compile preview and continuity endpoints', () => {
    const routes = storyboardRoutes(db, noopLog);
    const legacy = mockRes();
    routes.compilePreview({ params: { id: String(ids.sbLegacy) }, body: {} }, legacy);
    assert.equal(legacy.statusCode, 409);
    assert.equal(legacy.body.error.code, 'legacy_storyboard');

    const put = mockRes();
    routes.putEpisodeContinuity({ params: { episode_id: String(ids.episodeId) }, body: { continuity: { [ids.sceneId]: { ambience: '空调低鸣', props: [] } } } }, put);
    assert.equal(put.statusCode, 200, JSON.stringify(put.body));
    const bad = mockRes();
    routes.putEpisodeContinuity({ params: { episode_id: String(ids.episodeId) }, body: { continuity: { abc: {} } } }, bad);
    assert.equal(bad.statusCode, 422);

    require('../src/services/storyboardService').saveSegmentIr(db, noopLog, ids.sbIr, sampleIr(ids));
    const prev = mockRes();
    routes.compilePreview({ params: { id: String(ids.sbIr) }, body: {} }, prev);
    assert.equal(prev.statusCode, 200, JSON.stringify(prev.body));
    assert.ok(prev.body.data.prompt.includes(P.ambience('空调低鸣')));
    assert.ok(Array.isArray(prev.body.data.findings));

    const check = mockRes();
    routes.episodeSegmentCheck({ params: { episode_id: String(ids.episodeId) } }, check);
    assert.equal(check.statusCode, 200);
    assert.equal(check.body.data.segments, 1);
    assert.ok(check.body.data.findings.some((f) => f.code === 'line_not_in_script'), 'script is empty in fixture, so lines are flagged');
  });

  it('surfaces handoff findings through segment-check and generation', async () => {
    const routes = storyboardRoutes(db, noopLog);
    const storyboardService = require('../src/services/storyboardService');
    const now = new Date().toISOString();
    const check = () => {
      const res = mockRes();
      routes.episodeSegmentCheck({ params: { episode_id: String(ids.episodeId) } }, res);
      assert.equal(res.statusCode, 200, JSON.stringify(res.body));
      return res.body.data.findings.filter((f) => f.code === 'holding_changed');
    };
    const irHolding = (holding) => {
      const ir = sampleIr(ids);
      for (const sh of ir.shots) for (const sub of sh.subjects) if (sub.alias === '林远') sub.holding = holding;
      return ir;
    };
    // 序号 1（结构化）、2（旧分镜）、3（结构化）：被旧分镜隔开，不检查
    storyboardService.saveSegmentIr(db, noopLog, ids.sbIr, irHolding('纸箱'));
    const sb3 = db.prepare("INSERT INTO storyboards (episode_id, storyboard_number, title, duration, created_at, updated_at) VALUES (?, 3, '第三段', 8, ?, ?)").run(ids.episodeId, now, now).lastInsertRowid;
    storyboardService.saveSegmentIr(db, noopLog, sb3, irHolding(null));
    assert.deepEqual(check(), []);
    // 旧分镜挪到末尾后两段相邻：持物突变被报出来
    db.prepare('UPDATE storyboards SET storyboard_number = 9 WHERE id = ?').run(ids.sbLegacy);
    db.prepare('UPDATE storyboards SET storyboard_number = 2 WHERE id = ?').run(sb3);
    const found = check();
    assert.equal(found.length, 1);
    assert.equal(found[0].where.storyboard_id, sb3);
    assert.equal(found[0].level, 'warn');

    // 结构化生成返回的 findings 里同样出现
    db.prepare("UPDATE episodes SET script_content = ? WHERE id = ?").run('林远：是因为绩效吗？', ids.episodeId);
    const segA = irHolding('纸箱');
    const segB = irHolding(null);
    segA.shots = [segA.shots[1]];
    segA.duration_s = segA.shots[0].seconds;
    segB.shots = [segB.shots[1]];
    segB.duration_s = segB.shots[0].seconds;
    aiClient.generateText = async () => '```json\n' + JSON.stringify([segA, segB]) + '\n```';
    const result = await runStructuredStoryboardGeneration(db, noopLog, ids.episodeId, {});
    assert.ok(result.findings.some((f) => f.code === 'holding_changed' && f.where.storyboard_id === result.storyboard_ids[1]), JSON.stringify(result.findings));
  });

  it('generation does not compare segments split by a protected legacy storyboard', async () => {
    const kept = createVideo({ storyboard_id: ids.sbLegacy, prompt: '保留的旧片' });
    db.prepare('UPDATE video_generations SET keep_in_archive = 1 WHERE id = ?').run(kept.body.data.id);
    db.prepare("UPDATE episodes SET script_content = ? WHERE id = ?").run('林远：是因为绩效吗？', ids.episodeId);
    const seg = (holding) => {
      const ir = sampleIr(ids);
      for (const sh of ir.shots) for (const sub of sh.subjects) if (sub.alias === '林远') sub.holding = holding;
      ir.shots = [ir.shots[1]];
      ir.duration_s = ir.shots[0].seconds;
      return ir;
    };
    // 序号 1、2（受保护的旧分镜）、3：1 和 3 之间隔着旧分镜，不算相邻
    aiClient.generateText = async () => '```json\n' + JSON.stringify([seg('纸箱'), seg('纸箱'), seg(null)]) + '\n```';
    const result = await runStructuredStoryboardGeneration(db, noopLog, ids.episodeId, {});
    assert.equal(result.storyboard_ids.length, 2, 'number 2 kept for the protected storyboard');
    assert.deepEqual(result.findings.filter((f) => f.code === 'holding_changed'), []);
  });
});
