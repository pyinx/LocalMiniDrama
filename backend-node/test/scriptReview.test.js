const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const aiClient = require('../src/services/aiClient');
const promptI18n = require('../src/services/promptI18n');
const { parseScript, reviewEpisode } = require('../src/services/scriptReviewService');
const storyboardRoutes = require('../src/routes/storyboards');
const { createIrTestDb, mockRes, noopLog } = require('./helpers/segmentIrFixtures');

const SCRIPT = [
  '## 场1 日 内 会议室',
  '出场：林远、人事',
  '△ 人事把离职协议推过桌面。',
  '人事（公式化）：签个字吧。',
  '林远：是因为上个月我负责的那个项目最后没有按时上线的绩效吗？',
  '林远（os）：果然轮到我了。',
  '旁白：那天下着雨。',
].join('\n');

const VALID = {
  gates: { non_script: false, compliance_blocked: false, homogeneous: false, notes: '' },
  dimensions: ['opening', 'hook', 'conflict', 'pacing', 'dialogue', 'character', 'payoff', 'shootability'].map((key) => ({ key, score: 8, evidence: '有证据' })),
  problems: [{ location: '场1 第2句', what: '台词太长', advice: '拆成两句' }],
  weighted_total: 10,
};

let db, ids, saved;
beforeEach(() => {
  ({ db, ids } = createIrTestDb());
  db.prepare('UPDATE episodes SET script_content = ? WHERE id = ?').run(SCRIPT, ids.episodeId);
  saved = aiClient.generateText;
});
afterEach(() => { aiClient.generateText = saved; });

describe('script layer (AC17)', () => {
  it('parses script format', () => {
    const p = parseScript(SCRIPT);
    assert.equal(p.format, 'structured');
    assert.deepEqual(p.scenes, ['## 场1 日 内 会议室']);
    assert.deepEqual(p.lines.map((l) => [l.speaker, l.kind]), [['人事', 'dialogue'], ['林远', 'dialogue'], ['林远', 'os'], [null, 'vo']]);
    assert.equal(p.stats.line_count, 4);
    assert.equal(p.lines[0].chars, 4, 'punctuation not counted');
    assert.equal(p.stats.long_lines.length, 1);
    assert.ok(p.stats.max_line_chars > 15);
    const prose = parseScript('林远走进会议室，人事说“签个字吧”。');
    assert.equal(prose.format, 'fuzzy');
    assert.equal(prose.lines[0].text, '签个字吧');
    // 分集剧本生成提示带写作纪律（默认提示词）
    const zh = promptI18n.getStoryExpansionSystemPrompt({ app: { language: 'zh' } }, 1);
    for (const kw of ['前两三句', '不超过 15 个字', '「人名：台词」']) assert.ok(zh.includes(kw), kw);
    assert.ok(promptI18n.getStoryExpansionSystemPrompt({ app: { language: 'en' } }, 1).includes('Name: line'));
  });

  it('report schema', async () => {
    let sentSystem = '';
    aiClient.generateText = async (_db, _log, _t, _u, sys) => { sentSystem = sys; return '```json\n' + JSON.stringify(VALID) + '\n```'; };
    const r = await reviewEpisode(db, noopLog, ids.episodeId);
    assert.match(sentSystem, /只诊断，不改写剧本/);
    assert.equal(r.report.weighted_total, 8, 'server computes the total, ignores the model value');
    assert.equal(r.report.grade, '强');
    assert.equal(r.report.dimensions.length, 8);
    assert.equal(r.report.problems[0].what, '台词太长');
    assert.equal(r.script.stats.line_count, 4);

    aiClient.generateText = async () => JSON.stringify({ ...VALID, gates: { ...VALID.gates, non_script: true } });
    assert.equal((await reviewEpisode(db, noopLog, ids.episodeId)).report.weighted_total, 4, 'non-script capped at 4');
    aiClient.generateText = async () => JSON.stringify({ ...VALID, gates: { ...VALID.gates, compliance_blocked: true } });
    const blocked = (await reviewEpisode(db, noopLog, ids.episodeId)).report;
    assert.deepEqual([blocked.weighted_total, blocked.grade], [null, '不能拍']);
    aiClient.generateText = async () => JSON.stringify({ ...VALID, gates: { ...VALID.gates, homogeneous: true } });
    const homo = (await reviewEpisode(db, noopLog, ids.episodeId)).report;
    assert.equal(homo.dimensions.find((d) => d.key === 'conflict').score, 5);
    aiClient.generateText = async () => JSON.stringify({ ...VALID, dimensions: VALID.dimensions.slice(1) });
    assert.deepEqual((await reviewEpisode(db, noopLog, ids.episodeId)).report.missing_dimensions, ['opening']);

    for (const bad of ['不是 JSON', JSON.stringify({ gates: {}, dimensions: [] }), JSON.stringify({ ...VALID, dimensions: [{ key: 'opening', score: 11 }] })]) {
      aiClient.generateText = async () => bad;
      await assert.rejects(reviewEpisode(db, noopLog, ids.episodeId), (e) => e.code === 'script_review_invalid', bad.slice(0, 30));
    }
    const routes = storyboardRoutes(db, noopLog);
    db.prepare("UPDATE episodes SET script_content = '', description = '' WHERE id = ?").run(ids.episodeId);
    const empty = mockRes();
    await routes.scriptReview({ params: { episode_id: String(ids.episodeId) }, body: {} }, empty);
    assert.equal(empty.statusCode, 422);
    const missing = mockRes();
    await routes.scriptReview({ params: { episode_id: '9999' }, body: {} }, missing);
    assert.equal(missing.statusCode, 404);
  });

  it('no auto rewrite', async () => {
    aiClient.generateText = async () => JSON.stringify({ ...VALID, rewritten_script: '全新的剧本正文', content: '另一版' });
    const before = db.prepare('SELECT * FROM episodes WHERE id = ?').get(ids.episodeId);
    const res = mockRes();
    await storyboardRoutes(db, noopLog).scriptReview({ params: { episode_id: String(ids.episodeId) }, body: {} }, res);
    assert.equal(res.statusCode, 200);
    assert.ok(!JSON.stringify(res.body.data).includes('全新的剧本正文'), 'rewritten text never surfaces');
    assert.deepEqual(db.prepare('SELECT * FROM episodes WHERE id = ?').get(ids.episodeId), before, 'episode untouched');
  });
});
