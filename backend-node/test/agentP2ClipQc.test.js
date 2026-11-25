'use strict';
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createAgentTestDb, seedTwoDramas } = require('./helpers/agentTestDb');
const { createAgentNotesService } = require('../src/services/agentNotesService');
const { getTakeEvidence, recordClipFindings } = require('../src/services/agentClipQcService');

function memoryFs() {
  const files = new Map();
  return {
    files,
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
  const notes = createAgentNotesService({ dataDir: '/tmp/p2-clip-qc', fs: memoryFs() });
  const storage = fs.mkdtempSync(path.join(os.tmpdir(), 'p2-qc-'));
  fs.writeFileSync(path.join(storage, 'ref-a.png'), 'image');
  const mediaCheck = JSON.stringify({
    status: 'failed',
    issues: [{ code: 'duration_short', expected: 3, actual: 2 }],
    anomalies: { status: 'flagged', items: [{ kind: 'black', start_s: 0.5, end_s: 1.2, duration_s: 0.7 }] },
  });
  const validIr = JSON.stringify({
    version: 1,
    duration_s: 3,
    scene: { scene_id: 1, state_id: null, setting: '甲地' },
    shots: [{ seconds: 3, size: '中景', camera: '固定', action: '甲把信推到桌角' }],
  });
  // 分镜 id 与剧 id 故意不同：防止 scope SQL 把 drama_id / storyboard_id 的绑定顺序写反。
  db.prepare('INSERT INTO storyboards (id, episode_id, storyboard_number, segment_ir, created_at, updated_at) VALUES (5, 11, 2, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)').run(validIr);
  db.prepare('UPDATE storyboards SET segment_ir = ? WHERE id = ?').run(validIr, ids.storyboardA);
  db.prepare(`INSERT INTO video_generations
    (id, drama_id, storyboard_id, provider, prompt, model, status, media_check, compiled_json,
     first_frame_url, reference_image_urls, local_path, created_at)
    VALUES (?, ?, ?, 'test', ?, 'model-a', 'completed', ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)`)
    .run(1, ids.dramaA, ids.storyboardA, '中景，甲把信推到桌角，镜头缓推，时长3秒', mediaCheck,
      JSON.stringify({ refs: [], findings: [{ level: 'warn', code: 'action_vague', where: '镜头1', msg: '动作不够可拍' }] }), '/static/ref-a.png', JSON.stringify(['/static/ref-a.png', 'https://example.com/remote.png']),
      'videos/take-1.mp4');
  db.prepare("INSERT INTO video_take_reviews (id, video_generation_id, time_ms, note, action, status, created_at) VALUES (1, 1, 1200, '信没有出现', 'revise', 'open', CURRENT_TIMESTAMP)").run();
  const deps = {
    storageRoot: storage,
    // submitted findings come from take.compiled_json; no compiler injection needed
  };
  return { db, ids, notes, deps, storage };
}

function evidenceFor(fx, overrides = {}) {
  return getTakeEvidence({
    db: fx.db, notes: fx.notes, deps: fx.deps,
    dramaId: fx.ids.dramaA,
    episodeId: fx.ids.episodeA1,
    storyboardId: fx.ids.storyboardA,
    takeId: 1,
    ...overrides,
  });
}

describe('clip-qc', () => {
  it('clip-qc evidence aggregation reads submitted prompt, media checks and reviews', () => {
    const fx = fixtures();
    assert.deepEqual(evidenceFor(fx, { takeId: 999 }), { ok: false, error: 'not_found' });
    assert.deepEqual(evidenceFor(fx, { dramaId: fx.ids.dramaB }), { ok: false, error: 'not_found' });

    const e = evidenceFor(fx);
    assert.equal(e.ok, true);
    assert.equal(e.take_id, 1);
    assert.equal(e.prompt.text, '中景，甲把信推到桌角，镜头缓推，时长3秒');
    assert.ok(e.evidence_id);
    assert.ok(e.prompt.id);
    assert.equal(e.media_check.status, 'failed');
    assert.equal(e.media_check.issues[0].code, 'duration_short');
    assert.equal(e.media_check.anomalies[0].kind, 'black');
    assert.equal(e.reviews.length, 1);
    assert.equal(e.reviews[0].time_ms, 1200);
    assert.equal(e.reference_images.length, 2);
    assert.equal(e.reference_images[0].exists, true);
    assert.equal(e.reference_images[1].exists, null);
    assert.ok(e.evidence_gaps.some((g) => g.includes('远程参考图')));
    assert.ok(e.evidence_ids.includes(e.prompt.id));
    assert.ok(e.evidence_ids.includes(e.media_check.id));

    // 媒体检测段落不属于任何证据时，缺口写清楚，不伪造结论
    fx.db.prepare('UPDATE video_generations SET media_check = NULL WHERE id = 1').run();
    const noMedia = evidenceFor(fx);
    assert.equal(noMedia.ok, true);
    assert.equal(noMedia.media_check.status, 'unavailable');
    assert.ok(noMedia.evidence_gaps.some((g) => g.includes('没有媒体检测结果')));
  });

  it('scope binds drama, episode and storyboard independently', () => {
    const fx = fixtures();
    const db = fx.db;
    db.prepare(`INSERT INTO video_generations
      (id, drama_id, storyboard_id, provider, prompt, model, status, created_at)
      VALUES (25, 1, 5, 'test', '中景，甲把信推到桌角，时长3秒', 'model-a', 'completed', CURRENT_TIMESTAMP)`).run();
    const ok = getTakeEvidence({
      db, notes: fx.notes, deps: fx.deps,
      dramaId: 1, episodeId: 11, storyboardId: 5, takeId: 25,
    });
    assert.equal(ok.ok, true);
    assert.equal(ok.storyboard_id, 5);
    assert.equal(getTakeEvidence({ db, notes: fx.notes, deps: fx.deps, dramaId: 2, episodeId: 11, storyboardId: 5, takeId: 25 }).error, 'not_found');
    assert.equal(getTakeEvidence({ db, notes: fx.notes, deps: fx.deps, dramaId: 1, episodeId: 12, storyboardId: 5, takeId: 25 }).error, 'not_found');
  });

  it('attribution hints are evidence-bound and model-free', () => {
    const fx = fixtures();
    const e = evidenceFor(fx);
    assert.ok(e.attribution_hints.length >= 1);
    for (const h of e.attribution_hints) assert.notEqual(h.class, 'single_take_variance', '不能凭一条 take 推出模型倾向');
    // 提示词只写了时长，画幅偏差不能指认为「作者画幅要求未执行」
    const aspectOnly = e.attribution_hints.filter((h) => h.class === 'requirement_not_executed' && h.basis.includes(e.media_check.id));
    assert.equal(aspectOnly.length, 1); // 时长3秒 ↔ duration_short
    fx.db.prepare("UPDATE video_generations SET media_check = ? WHERE id = 1").run(JSON.stringify({
      status: 'failed', issues: [{ code: 'aspect_ratio_mismatch' }], anomalies: { items: [] },
    }));
    const aspectMismatch = evidenceFor(fx);
    assert.ok(!aspectMismatch.attribution_hints.some((h) => h.basis.includes(aspectMismatch.media_check.id)),
      '提示词未要求画幅时不能拿画幅偏差指认作者要求未执行');
    // 提示词质量问题不能归为执行失败
    assert.ok(!e.attribution_hints.some((h) => h.class === 'requirement_not_executed' && h.basis.some((id) => id.startsWith('submitted-'))),
      'action_vague 这类提示词质量问题不能算要求未执行');
    for (const h of e.attribution_hints) {
      assert.ok(['requirement_not_executed', 'single_take_variance', 'prompt_under_specified'].includes(h.class));
      assert.ok(h.basis.length > 0);
      for (const id of h.basis) assert.ok(e.evidence_ids.includes(id), `basis ${id} 不在证据集合内`);
    }

    // 提示词无具体写法时，给出 prompt_under_specified，且引用提示词证据
    fx.db.prepare("UPDATE video_generations SET prompt = '按参考来' WHERE id = 1").run();
    const vague = evidenceFor(fx);
    const under = vague.attribution_hints.find((h) => h.class === 'prompt_under_specified');
    assert.ok(under);
    assert.deepEqual(under.basis, [vague.prompt.id]);
  });

  it('clip-qc findings require evidence and respect revision', () => {
    const fx = fixtures();
    const e = evidenceFor(fx);
    const finding = {
      class: 'requirement_not_executed',
      evidence_ids: [e.prompt.id, e.reviews[0].id],
      visible_evidence: '成片 1.2 秒处没有出现信',
      action: 'revise',
    };
    const input = (overrides = {}) => ({
      db: fx.db, notes: fx.notes, dramaId: fx.ids.dramaA, episodeId: fx.ids.episodeA1, evidence: e, expected_revision: 0, findings: [finding], deps: fx.deps, ...overrides,
    });

    assert.deepEqual(recordClipFindings(input({ findings: [] })), { ok: false, error: 'invalid_finding' });
    assert.deepEqual(recordClipFindings(input({ findings: [{ ...finding, class: 'unknown' }] })),
      { ok: false, error: 'invalid_finding' });
    assert.deepEqual(recordClipFindings(input({ findings: [{ ...finding, visible_evidence: '' }] })),
      { ok: false, error: 'invalid_finding' });
    assert.deepEqual(recordClipFindings(input({ findings: [{ ...finding, evidence_ids: ['nope'] }] })),
      { ok: false, error: 'invalid_finding' });
    assert.deepEqual(recordClipFindings(input({ expected_revision: 2 })), { ok: false, error: 'conflict' });
    assert.deepEqual(recordClipFindings(input({ dramaId: fx.ids.dramaB })), { ok: false, error: 'not_found' });
    assert.deepEqual(recordClipFindings(input({ episodeId: fx.ids.episodeA2 })), { ok: false, error: 'not_found' });
    assert.equal(fx.notes.read(fx.ids.dramaA, `episode-${fx.ids.episodeA1}-qc`).error, 'not_found');

    const saved = recordClipFindings(input());
    assert.equal(saved.ok, true);
    assert.equal(saved.revision, 1);
    assert.equal(saved.findings[0].visible_evidence, finding.visible_evidence);
    assert.deepEqual(recordClipFindings(input()), { ok: false, error: 'conflict' });
    assert.deepEqual(recordClipFindings(input({ expected_revision: 1, evidence: { ...e, take_id: 999 } })),
      { ok: false, error: 'stale_evidence' });

    // 媒体变化后证据 id 改变，旧证据包被拒绝
    fx.db.prepare("UPDATE video_generations SET prompt = '中景，甲把信推到桌角，镜头急推' WHERE id = 1").run();
    assert.deepEqual(recordClipFindings(input({ expected_revision: 1 })), { ok: false, error: 'stale_evidence' });
    assert.equal(fx.notes.read(fx.ids.dramaA, `episode-${fx.ids.episodeA1}-qc`).revision, 1);
  });
});
