const { describe, it, beforeEach, afterEach, mock } = require('node:test');
const assert = require('node:assert/strict');
const aiClient = require('../src/services/aiClient');
const aiConfigService = require('../src/services/aiConfigService');
const storyboardService = require('../src/services/storyboardService');
const segmentOptimizeService = require('../src/services/segmentOptimizeService');
const storyboardRoutes = require('../src/routes/storyboards');
const { createIrTestDb, sampleIr, mockRes, noopLog } = require('./helpers/segmentIrFixtures');

const MIXED_STYLE = '超写实摄影风格，日本动漫画风';

let db;
let ids;
let calls;

/** 镜头 1 含情绪词「眼神空洞」，镜头 2 含代词「他」，剧集画风真混用——对应用户在编译预览里看到的三条提醒 */
function flaggedIr() {
  const ir = sampleIr(ids);
  ir.shots[0].action = '林远眼神空洞地盯着协议';
  ir.shots[1].action = '林远说完，他低下头';
  return ir;
}

function storedIr() {
  return JSON.parse(db.prepare('SELECT segment_ir FROM storyboards WHERE id = ?').get(ids.sbIr).segment_ir);
}

function stubVideoConfig() {
  mock.method(aiConfigService, 'listConfigs', () => [
    { id: 1, service_type: 'video', is_active: true, is_default: true, provider: 'minimax', api_protocol: 'minimax_h3', base_url: 'https://api', api_key: 'k', model: ['MiniMax-H3'], default_model: 'MiniMax-H3' },
  ]);
}

function modelReplies(reply) {
  mock.method(aiClient, 'generateText', async (...args) => {
    calls.push(args);
    if (reply instanceof Error) throw reply;
    return typeof reply === 'string' ? reply : JSON.stringify(reply);
  });
}

beforeEach(() => {
  ({ db, ids } = createIrTestDb());
  calls = [];
  db.prepare('UPDATE dramas SET metadata = ? WHERE id = ?').run(JSON.stringify({ style_prompt_zh: MIXED_STYLE }), ids.dramaId);
  storyboardService.saveSegmentIr(db, noopLog, ids.sbIr, flaggedIr());
  stubVideoConfig();
});
afterEach(() => mock.restoreAll());

function previewFindings() {
  const res = mockRes();
  storyboardRoutes(db, noopLog).compilePreview({ params: { id: String(ids.sbIr) }, body: {} }, res);
  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  return res.body.data.findings;
}

describe('segment optimize (preview popup)', () => {
  it('marks only text-rule findings on editable fields as fixable', () => {
    const byCode = Object.fromEntries(previewFindings().map((f) => [f.code, f]));
    assert.equal(byCode.emotion_label.fixable, true);
    assert.equal(byCode.pronoun_reference.fixable, true);
    assert.equal(byCode.mixed_style_vocabulary.fixable, false, 'style comes from the drama, not from this segment');
    assert.equal(byCode.emotion_label.where.match, '眼神空洞', 'existing fields stay');
  });

  it('proposes text edits only on flagged fields and does not persist', async () => {
    const before = db.prepare('SELECT segment_ir, updated_at FROM storyboards WHERE id = ?').get(ids.sbIr);
    modelReplies({
      edits: [
        { path: 'shots.0.action', text: '林远低头看着协议，手指停在签字栏上，一动不动' },
        { path: 'shots.1.action', text: '林远说完，低下头，手指摩挲着笔帽' },
      ],
    });
    const r = await segmentOptimizeService.optimizeStoryboard(db, noopLog, ids.sbIr);

    assert.deepEqual(r.changes.map((c) => [c.path, c.before]), [
      ['shots.0.action', '林远眼神空洞地盯着协议'],
      ['shots.1.action', '林远说完，他低下头'],
    ]);
    assert.deepEqual(r.changes.map((c) => c.remaining), [[], []]);
    const expected = JSON.parse(JSON.stringify(storedIr()));
    expected.shots[0].action = '林远低头看着协议，手指停在签字栏上，一动不动';
    expected.shots[1].action = '林远说完，低下头，手指摩挲着笔帽';
    assert.deepEqual(r.ir, expected, 'everything except the flagged fields is untouched');

    assert.equal(calls.length, 1);
    const prompt = calls[0][3];
    assert.match(prompt, /林远/, 'cast names are given so pronouns can become names');
    assert.doesNotMatch(prompt, /mixed_style_vocabulary/, 'the style finding is not sent to the model');
    assert.deepEqual(db.prepare('SELECT segment_ir, updated_at FROM storyboards WHERE id = ?').get(ids.sbIr), before, 'nothing persisted');
  });

  it('rejects edits outside flagged text fields or failing validation', async () => {
    const before = db.prepare('SELECT segment_ir FROM storyboards WHERE id = ?').get(ids.sbIr).segment_ir;
    const bad = [
      [{ path: 'shots.0.lines.0.text', text: '改了台词' }],
      [{ path: 'scene.setting', text: '别的地方' }],
      [{ path: 'shots.9.action', text: '不存在的镜头' }],
      [{ path: 'shots.0.action', text: '   ' }],
      [{ path: 'shots.0.action', text: 'A' }, { path: 'shots.0.action', text: 'B' }],
      [{ path: 'shots.0.action', text: '合法的改写' }, { path: 'shots.0.camera', text: '越界的字段' }],
    ];
    for (const edits of bad) {
      mock.restoreAll();
      stubVideoConfig();
      modelReplies({ edits });
      await assert.rejects(() => segmentOptimizeService.optimizeStoryboard(db, noopLog, ids.sbIr), { code: 'optimize_failed' }, JSON.stringify(edits));
    }
    assert.equal(db.prepare('SELECT segment_ir FROM storyboards WHERE id = ?').get(ids.sbIr).segment_ir, before);
  });

  it('skips the model when nothing is fixable and drops no-op edits', async () => {
    modelReplies({ edits: [{ path: 'shots.0.action', text: '林远眼神空洞地盯着协议' }, { path: 'shots.1.action', text: '林远说完，低下头' }] });
    const r = await segmentOptimizeService.optimizeStoryboard(db, noopLog, ids.sbIr);
    assert.deepEqual(r.changes.map((c) => c.path), ['shots.1.action'], 'the unchanged text is not a change');

    modelReplies({ edits: [{ path: 'shots.0.action', text: '林远眼神空洞地盯着协议' }] });
    await assert.rejects(() => segmentOptimizeService.optimizeStoryboard(db, noopLog, ids.sbIr), { code: 'nothing_to_optimize' });

    const clean = sampleIr(ids);
    storyboardService.saveSegmentIr(db, noopLog, ids.sbIr, clean);
    calls.length = 0;
    await assert.rejects(() => segmentOptimizeService.optimizeStoryboard(db, noopLog, ids.sbIr), { code: 'nothing_to_optimize' });
    assert.equal(calls.length, 0, 'no model call without fixable findings');
  });

  it('returns an error and persists nothing when the model fails', async () => {
    const before = db.prepare('SELECT segment_ir FROM storyboards WHERE id = ?').get(ids.sbIr).segment_ir;
    const routes = storyboardRoutes(db, noopLog);
    for (const reply of [new Error('upstream 500'), '抱歉，我无法处理', { edits: 'oops' }]) {
      mock.restoreAll();
      stubVideoConfig();
      modelReplies(reply);
      const res = mockRes();
      await routes.optimizePreview({ params: { id: String(ids.sbIr) }, body: {} }, res);
      assert.equal(res.statusCode, 502, String(reply));
      assert.equal(res.body.error.code, 'optimize_failed');
    }
    assert.equal(db.prepare('SELECT segment_ir FROM storyboards WHERE id = ?').get(ids.sbIr).segment_ir, before);
  });
});
