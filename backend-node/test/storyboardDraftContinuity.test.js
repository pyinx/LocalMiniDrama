const { it } = require('node:test');
const assert = require('node:assert/strict');
const routesFor = require('../src/routes/storyboards');
const ai = require('../src/services/aiClient');
const { getVideoCaps } = require('../src/services/modelCapabilities');
const { callVideoApi } = require('../src/services/videoClient');
const { createIrTestDb, noopLog, mockRes } = require('./helpers/segmentIrFixtures');

it('protects the draft on conflict and concurrent edits', async t => {
  const draft = '分镜1：5秒：水面越过刻线，随即回落，最后停在线下。';
  const conflict = { beat: '分镜1', source: '随即回落', candidate: '停在线上', reason: '结束水位不同' };
  for (const [field, route] of [['video_prompt', 'polishClassicVideoPromptStream'], ['universal_segment_text', 'polishUniversalSegmentStream']]) {
    for (const outcome of ['conflict', 'changed', 'ok']) {
      await t.test(field + ' ' + outcome, async t => {
        const { db, ids } = createIrTestDb();
        t.after(() => db.close());
        const id = ids.sbIr;
        const read = () => db.prepare('SELECT ' + field + ' AS draft FROM storyboards WHERE id=?').get(id).draft;
        const before = read();
        const res = mockRes();
        const events = [];
        res.write = line => events.push(JSON.parse(line));
        const provider = t.mock.method(ai, 'streamGenerateText', async (_db, _log, _kind, user, system) => {
          assert.ok(user.includes(draft));
          assert.ok(system.includes('storyboard_conflict'));
          if (outcome === 'changed') db.prepare('UPDATE storyboards SET ' + field + '=? WHERE id=?').run('作者新稿', id);
          return outcome === 'conflict' ? JSON.stringify({ storyboard_conflict: conflict }) : draft;
        });
        await routesFor(db, noopLog)[route]({ params: { id }, body: { ['draft_' + field]: draft, force_without_reference_images: true } }, res);
        assert.equal(provider.mock.callCount(), 1);
        const last = events.at(-1);
        if (outcome === 'conflict') {
          assert.equal(last.code, 'storyboard_conflict');
          for (const s of Object.values(conflict)) assert.ok(last.message.includes(s));
          assert.equal(read(), before);
        } else if (outcome === 'changed') {
          assert.equal(last.code, 'storyboard_draft_changed');
          assert.equal(read(), '作者新稿');
        } else {
          assert.equal(last.type, 'done');
          assert.ok(read().includes('随即回落'));
          assert.equal(read(), last[field]);
        }
      });
    }
  }
});

it('retains a short valid classic draft on repeated polish', async t => {
  const { db, ids } = createIrTestDb();
  t.after(() => db.close());
  const draft = '水位越线，又回落。';
  t.mock.method(ai, 'streamGenerateText', async () => draft);
  const route = routesFor(db, noopLog).polishClassicVideoPromptStream;
  for (let pass = 0; pass < 2; pass++) {
    const res = mockRes();
    const events = [];
    res.write = line => events.push(JSON.parse(line));
    await route({ params: { id: ids.sbIr }, body: { draft_video_prompt: draft } }, res);
    assert.deepEqual(events.at(-1), { type: 'done', video_prompt: draft });
  }
});

it('keeps the saved universal draft when a beat is duplicated', async t => {
  const { db, ids } = createIrTestDb();
  t.after(() => db.close());
  const read = () => db.prepare('SELECT universal_segment_text FROM storyboards WHERE id=?').get(ids.sbIr).universal_segment_text;
  const before = read();
  t.mock.method(ai, 'generateText', async () => '分镜1：2秒：保持固定。\n分镜1：3秒：风声渐弱。');
  const res = mockRes();
  await routesFor(db, noopLog).generateUniversalSegmentPrompt({ params: { id: ids.sbIr }, body: { force_without_reference_images: true } }, res);
  assert.equal(res.statusCode, 422);
  assert.equal(res.body.error.code, 'invalid_storyboard_response');
  assert.equal(read(), before);
});

it('retains the original when a narrative line appears in the reference header', async t => {
  const { db, ids } = createIrTestDb();
  t.after(() => db.close());
  const raw = ['画面风格和类型: 水彩', '生成一个由以下1个分镜组成的视频。', '水越线后回落。', '分镜1：5秒：镜头对准刻线。'].join('\n');
  t.mock.method(ai, 'generateText', async () => raw);
  const res = mockRes();
  await routesFor(db, noopLog).generateUniversalSegmentPrompt({ params: { id: ids.sbIr }, body: { force_without_reference_images: true } }, res);
  assert.equal(res.statusCode, 422);
  const row = db.prepare('SELECT universal_segment_text,universal_beat_signature FROM storyboards WHERE id=?').get(ids.sbIr);
  assert.equal(row.universal_segment_text, '旧全能文本');
  assert.equal(row.universal_beat_signature, null);
});

it('delivers the last Unicode character at the provider boundary or rejects before submitting', async t => {
  const posted = [];
  t.mock.method(global, 'fetch', async (_url, opts) => {
    posted.push(JSON.parse(opts.body).prompt);
    return new Response(JSON.stringify({ code: 0, data: { task_id: 'fixture' }, task_id: 'fixture' }));
  });
  for (const protocol of ['kling_omni', 'vidu']) {
    const target = { protocol, model: 'test', config: { api_key: 'local-fixture', base_url: 'http://localhost' } };
    const limit = getVideoCaps(target).maxPromptChars;
    const prompt = '风'.repeat(limit - 1) + '🔔';
    const before = posted.length;
    await callVideoApi(null, noopLog, { prompt }, target);
    assert.equal(posted.at(-1), prompt);
    const tooLong = await callVideoApi(null, noopLog, { prompt: prompt + '。' }, target);
    assert.equal(tooLong.submission, 'rejected');
    assert.equal(posted.length, before + 1);
  }
});
