/**
 * P0 工具：模型通过假适配器注入，文件通过内存 fs 注入；不跑真模型、不写真实文件。
 */
'use strict';

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { createAgentTestDb, seedTwoDramas } = require('./helpers/agentTestDb');
const { createAgentNotesService } = require('../src/services/agentNotesService');
const { configureP0Tools } = require('../src/mastra/tools.mjs');
const aiClient = require('../src/services/aiClient');

const log = { info() {}, warn() {}, error() {} };

function memoryFs() {
  const files = new Map();
  return {
    files,
    readFileSync(p) {
      if (!files.has(p)) {
        const err = new Error('missing');
        err.code = 'ENOENT';
        throw err;
      }
      return files.get(p);
    },
    mkdirSync() {},
    writeFileSync(p, data) { files.set(p, data); },
  };
}

const VALID_FINDINGS = {
  findings: [
    { id: 'f1', severity: 'warn', location: '开场第一句', what: '说明腔', why: '没有可见冲突', direction: '改成动作' },
  ],
};
const VALID_EDITS = {
  edits: [{ finding_id: 'f1', path: '甲集剧本', before: '甲集剧本', after: '甲把杯子推到桌角' }],
};

let notes;
let model;
let savedGenerateText;
beforeEach(() => {
  const io = memoryFs();
  notes = createAgentNotesService({ dataDir: '/tmp/p0-test', fs: io });
  model = async () => JSON.stringify(VALID_FINDINGS);
  savedGenerateText = aiClient.generateText;
  configureP0Tools({ notes, generateText: (prompt, system) => model(prompt, system) });
});
afterEach(() => {
  configureP0Tools(null);
  aiClient.generateText = savedGenerateText;
});

describe('P0 agent tools', () => {
  it('series tools read, save and check continuity deterministically', async () => {
    const { executeGetSeriesNotes, executeSaveSeriesNotes, executeCheckSeriesContinuity } = await import('../src/mastra/tools.mjs');
    const db = createAgentTestDb();
    const ids = seedTwoDramas(db);

    assert.equal(executeGetSeriesNotes(db, 999, {}).error, 'not_found');
    const empty = executeGetSeriesNotes(db, ids.dramaA, {});
    assert.equal(empty.ok, true);
    assert.equal(empty.revision, 0);
    assert.deepEqual(empty.document, {});

    const saved = executeSaveSeriesNotes(db, ids.dramaA, {
      expected_revision: 0,
      document: { invariants: [{ id: 'i1', tokens: ['不可变事实'] }] },
    });
    assert.equal(saved.ok, true);
    assert.equal(saved.revision, 1);
    assert.equal(executeSaveSeriesNotes(db, ids.dramaA, { expected_revision: 0, document: {} }).error, 'conflict');

    const read = executeGetSeriesNotes(db, ids.dramaA, {});
    assert.equal(read.document.invariants[0].tokens[0], '不可变事实');

    const pass = executeCheckSeriesContinuity(db, ids.dramaA, ids.episodeA1, '不可变事实一直在');
    assert.equal(pass.ok, true);
    assert.deepEqual(pass.violations, []);
    assert.equal(pass.checked, 1);
    const violation = executeCheckSeriesContinuity(db, ids.dramaA, ids.episodeA1, '完全没有提到');
    assert.equal(violation.violations[0].expected, '不可变事实');
    assert.equal(executeCheckSeriesContinuity(db, ids.dramaA, ids.episodeA1, '  ').error, 'empty_script');
    assert.equal(executeCheckSeriesContinuity(db, ids.dramaA, 999, 'x').error, '这一集不属于当前项目');
  });

  it('review_episode_deep validates scope, model output and notes write', async () => {
    const { executeReviewEpisodeDeep } = await import('../src/mastra/tools.mjs');
    const db = createAgentTestDb();
    const ids = seedTwoDramas(db);

    assert.equal((await executeReviewEpisodeDeep(db, log, 999, ids.episodeA1, {})).error, 'not_found');
    assert.equal((await executeReviewEpisodeDeep(db, log, ids.dramaA, 999, {})).error, '这一集不属于当前项目');
    assert.equal((await executeReviewEpisodeDeep(db, log, ids.dramaA, ids.episodeA1, { mode: 'nope' })).error, 'invalid_mode');

    db.prepare('UPDATE episodes SET script_content = ? WHERE id = ?').run('   ', ids.episodeA1);
    assert.equal((await executeReviewEpisodeDeep(db, log, ids.dramaA, ids.episodeA1, {})).error, 'empty_script');
    db.prepare('UPDATE episodes SET script_content = ? WHERE id = ?').run('甲集剧本', ids.episodeA1);

    const good = await executeReviewEpisodeDeep(db, log, ids.dramaA, ids.episodeA1, { mode: 'dialogue' });
    assert.equal(good.ok, true);
    assert.equal(good.findings[0].id, 'f1');
    assert.equal(good.revision, 1);
    assert.equal(notes.read(ids.dramaA, `episode-${ids.episodeA1}-script-review`).document.findings[0].what, '说明腔');

    model = async () => 'not json at all';
    assert.equal((await executeReviewEpisodeDeep(db, log, ids.dramaA, ids.episodeA1, {})).error, 'review_invalid');
    model = async () => JSON.stringify({ findings: [{ id: 'f1', severity: 'bad', location: 'x', what: 'y' }] });
    assert.equal((await executeReviewEpisodeDeep(db, log, ids.dramaA, ids.episodeA1, {})).error, 'review_invalid');
    model = async () => { throw new Error('boom'); };
    assert.equal((await executeReviewEpisodeDeep(db, log, ids.dramaA, ids.episodeA1, {})).error, 'review_failed');
    assert.equal(notes.read(ids.dramaA, `episode-${ids.episodeA1}-script-review`).revision, 1);
  });

  it('propose_script_edits only proposes, validates selection and keeps original script', async () => {
    const { executeReviewEpisodeDeep, executeProposeScriptEdits } = await import('../src/mastra/tools.mjs');
    const db = createAgentTestDb();
    const ids = seedTwoDramas(db);
    await executeReviewEpisodeDeep(db, log, ids.dramaA, ids.episodeA1, {});

    assert.equal((await executeProposeScriptEdits(db, log, ids.dramaA, ids.episodeA1, { finding_ids: [] })).error, 'invalid_selection');
    assert.equal((await executeProposeScriptEdits(db, log, ids.dramaA, ids.episodeA1, { finding_ids: ['missing'] })).error, 'invalid_selection');

    model = async () => JSON.stringify(VALID_EDITS);
    const proposed = await executeProposeScriptEdits(db, log, ids.dramaA, ids.episodeA1, { finding_ids: ['f1'] });
    assert.equal(proposed.ok, true);
    assert.equal(proposed.proposal[0].after, '甲把杯子推到桌角');
    assert.equal(db.prepare('SELECT script_content FROM episodes WHERE id = ?').get(ids.episodeA1).script_content, '甲集剧本');
    const savedProposal = notes.read(ids.dramaA, `episode-${ids.episodeA1}-script-proposal`);
    assert.equal(savedProposal.document.edits.length, 1);

    // 路径/原文不匹配时整份拒绝
    model = async () => JSON.stringify({ edits: [{ finding_id: 'f1', path: '不存在的句子', before: '不存在', after: 'x' }] });
    assert.equal((await executeProposeScriptEdits(db, log, ids.dramaA, ids.episodeA1, { finding_ids: ['f1'] })).error, 'invalid_path');
    model = async () => 'broken';
    assert.equal((await executeProposeScriptEdits(db, log, ids.dramaA, ids.episodeA1, { finding_ids: ['f1'] })).error, 'review_invalid');
  });

  it('production model wiring passes the app db to aiClient.generateText', async () => {
    const { executeReviewEpisodeDeep } = await import('../src/mastra/tools.mjs');
    const db = createAgentTestDb();
    const ids = seedTwoDramas(db);
    let receivedDb;
    aiClient.generateText = async (modelDb, _log, service, prompt, system, options) => {
      receivedDb = modelDb;
      assert.equal(service, 'text');
      assert.equal(options.scene_key, 'script_deep_review');
      return JSON.stringify(VALID_FINDINGS);
    };
    configureP0Tools({ notes, db });

    const result = await executeReviewEpisodeDeep(db, log, ids.dramaA, ids.episodeA1, {});
    assert.equal(result.ok, true);
    assert.equal(receivedDb, db, 'production path must pass the real db, not null');
  });
});
