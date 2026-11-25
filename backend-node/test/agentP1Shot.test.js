'use strict';
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { createAgentTestDb, seedTwoDramas } = require('./helpers/agentTestDb');
const { createAgentNotesService } = require('../src/services/agentNotesService');
const { proposeBlocking, reviewShotContinuity } = require('../src/services/agentShotService');

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
  const notes = createAgentNotesService({ dataDir: '/tmp/p1-shot', fs: memoryFs() });
  return { db, ids, notes };
}

const GOOD = {
  proposal: {
    master_shot: '中景侧机位，交代两人的位置关系',
    axis: '主语始终在画面左侧',
    beats: [{ order: 1, shot: '中景', action: '甲把信推到桌角', camera: '缓推' }],
    notes: '',
  },
};

describe('shot director', () => {
  it('blocking proposals and deterministic shot continuity review', async () => {
    const { db, ids, notes } = fixtures();
    const log = { warn() {} };
    const deps = { generateText: async () => JSON.stringify(GOOD) };

    assert.equal((await proposeBlocking({ db, log, notes, deps, dramaId: ids.dramaA, episodeId: 999 })).error, 'not_found');
    assert.equal((await proposeBlocking({ db, log, notes, deps, dramaId: ids.dramaA, episodeId: ids.episodeA1, sceneId: 999 })).error, 'not_found');

    const proposed = await proposeBlocking({ db, log, notes, deps, dramaId: ids.dramaA, episodeId: ids.episodeA1, sceneId: ids.sceneA });
    assert.equal(proposed.ok, true);
    assert.equal(proposed.proposal.master_shot, GOOD.proposal.master_shot);
    assert.equal(notes.read(ids.dramaA, `episode-${ids.episodeA1}-direction`).document.proposal.axis, GOOD.proposal.axis);

    const bad = { generateText: async () => 'not json' };
    assert.equal((await proposeBlocking({ db, log, notes, deps: bad, dramaId: ids.dramaA, episodeId: ids.episodeA1 })).error,
      'proposal_invalid');
    assert.equal(notes.read(ids.dramaA, `episode-${ids.episodeA1}-direction`).revision, proposed.revision);

    // 确定性复核：legacy / 合法 IR / 不写库
    assert.equal(reviewShotContinuity({ db, notes, dramaId: ids.dramaA, episodeId: ids.episodeA1, storyboardId: ids.storyboardA }).code
      || reviewShotContinuity({ db, notes, dramaId: ids.dramaA, episodeId: ids.episodeA1, storyboardId: ids.storyboardA }).error,
    'legacy_storyboard');

    const validIr = JSON.stringify({
      version: 1,
      duration_s: 3,
      scene: { scene_id: 1, state_id: null, setting: '甲地' },
      shots: [{ seconds: 3, size: '中景', camera: '固定', action: '甲把信推到桌角' }],
    });
    db.prepare('UPDATE storyboards SET segment_ir = ? WHERE id = ?').run(validIr, ids.storyboardA);
    let compileCalled = 0;
    const reviewDeps = {
      compileStoryboard(id) { compileCalled++; return { ok: true, findings: [{ level: 'warn', code: 'x' }], blocked: false }; },
      tailFrameEligibility() { return { ok: false, reason: 'test' }; },
    };
    const review = reviewShotContinuity({
      db, notes, dramaId: ids.dramaA, episodeId: ids.episodeA1, storyboardId: ids.storyboardA, deps: reviewDeps,
    });
    assert.equal(review.ok, true);
    assert.equal(compileCalled, 1);
    assert.equal(review.findings.length, 1);
    assert.equal(review.blocked, false);
    assert.equal(review.has_direction_notes, true);
    assert.equal(review.tail_frame, null, '未声明 tail_ref_from 时不应误报尾帧不合格');
    assert.equal(db.prepare('SELECT segment_ir FROM storyboards WHERE id = ?').get(ids.storyboardA).segment_ir, validIr);
    assert.equal(reviewShotContinuity({ db, notes, dramaId: ids.dramaB, episodeId: ids.episodeA1, storyboardId: ids.storyboardA }).error,
      'not_found');
  });
});
