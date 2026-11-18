const { test } = require('node:test');
const assert = require('node:assert/strict');
const { setTimeout: delay } = require('node:timers/promises');
const config = require('../src/config');
const videoClient = require('../src/services/videoClient');
const { takeWorkspace } = require('./helpers/workbenchTakes');

test('project review follows the effective take and keeps historical notes reachable by time and version', async t => {
  const ws = await takeWorkspace(t);
  const [first,, target, adjacent] = ws.shots;
  const a = ws.add(target, 'red.mp4', 'red');
  const b = ws.add(target, 'blue.mp4', 'blue');
  const elsewhere = ws.add(first, 'first.mp4', 'white');
  const base = '/storyboards/' + target.id + '/takes';
  const add = (id, time_ms, note) => ws.request('POST', base + '/' + id + '/reviews', { time_ms, note, action: 'revise' });
  await add(a, 500, '红片嘴型抢拍');
  await add(b, 250, '蓝片视线偏移');
  await ws.request('POST', '/storyboards/' + first.id + '/takes/' + elsewhere + '/reviews', { time_ms: 100, note: '第一集连戏', action: 'reshoot' });
  const overview = () => ws.request('GET', '/dramas/' + ws.id + '/creative-review');
  const find = (review, id) => review.episodes.flatMap(ep => ep.shots).find(s => s.id === id);
  let state = await overview();
  // With no explicit selection the existing take resolver identifies the latest playable clip.
  let s = find(state, target.id);
  assert.equal(s.current_take_id, b);
  assert.equal(s.current_review.id, b);
  assert.deepEqual(s.history_reviews.map(old => old.id), [a]);
  assert.equal(find(state, adjacent.id).needs_review, false);
  assert.equal(find(state, first.id).current_review.id, elsewhere);

  await ws.adopt(target, a);
  s = find(await overview(), target.id);
  assert.equal(s.current_review.id, a);
  assert.equal(s.current_review.media.local_path, 'red.mp4');
  assert.equal(s.current_review.notes[0].time_ms, 500);
  assert.equal(s.history_reviews[0].notes[0].note, '蓝片视线偏移');
  assert.equal(s.history_reviews[0].media.local_path, 'blue.mp4');
  assert.equal(s.needs_review, true);
  await ws.request('PUT', base + '/' + a + '/reviews/' + s.current_review.notes[0].id, { status: 'resolved' });
  s = find(await overview(), target.id);
  assert.equal(s.current_review, null);
  assert.equal(s.needs_review, false);
  assert.equal(s.history_reviews[0].notes[0].time_ms, 250);
  await ws.adopt(target, b, 1);
  s = find(await overview(), target.id);
  assert.equal(s.needs_review, true);
  assert.deepEqual(s.history_reviews, []);

  // Two old candidates may point at the same file. A playable legacy path cannot identify note ownership.
  ws.db.prepare('UPDATE video_generations SET local_path=? WHERE id=?').run('red.mp4', b);
  ws.db.prepare("UPDATE storyboards SET adopted_video_generation_id=NULL, local_path='red.mp4', updated_at='2099' WHERE id=?").run(target.id);
  s = find(await overview(), target.id);
  assert.equal(s.has_video, true);
  assert.equal(s.current_take_id, null);
  assert.equal(s.needs_review, false);
  assert.deepEqual(s.history_reviews.map(old => old.id), [b]);
});

test('keeps notes on the reviewed take after a reshoot', async t => {
  const ws = await takeWorkspace(t);
  const [previous,,target,adjacent] = ws.shots;
  const originals = [previous, target, adjacent].map((s,i) => ws.add(s, 'original-' + i + '.mp4', 'red'));
  for (const [i, shot] of [previous,target,adjacent].entries()) await ws.adopt(shot, originals[i]);
  const review = { time_ms: 500, note: '口型提早半秒', action: 'reshoot' };
  const base = '/storyboards/' + target.id + '/takes';
  await ws.request('POST', base + '/' + originals[1] + '/reviews', review);
  assert.equal((await ws.error('DELETE', '/videos/' + originals[1])).status, 409);
  t.mock.method(config, 'loadConfig', () => ws.cfg);
  t.mock.method(videoClient, 'getDefaultVideoConfig', () => ({ provider: 'fixture' }));
  const calls = t.mock.method(videoClient, 'callVideoApi', async () => ({ video_url: ws.cfg.storage.base_url + '/original-0.mp4' }));
  const job = await ws.request('POST', '/videos', { drama_id: ws.id, storyboard_id: target.id, prompt: '延后半秒开口' });
  let result;
  for (let i=0; i<250; i++) {
    result = await ws.request('GET', '/videos/' + job.id);
    if (result.status !== 'processing') break;
    await delay(20);
  }
  assert.equal(result.status, 'completed', result.error_msg);
  assert.equal(calls.mock.callCount(), 1);
  assert.equal((await ws.request('GET', base)).adopted_video_generation_id, originals[1]);
  await ws.adopt(target, job.id, 1);
  const details = await ws.request('GET', base);
  const old = details.candidates.find(v => v.id === originals[1]), note = old.reviews[0];
  assert.equal(note.time_ms, 500); assert.equal(note.note, review.note);
  assert.equal(details.candidates.find(v => v.id === job.id).reviews.length, 0);
  assert.equal((await ws.error('DELETE', '/videos/' + old.id)).status, 409);
  await ws.request('PUT', base + '/' + old.id + '/reviews/' + note.id, { status: 'resolved' });
  assert.equal((await ws.request('GET', base)).candidates.find(v => v.id === old.id).reviews[0].status, 'resolved');
  for (const [shot,id] of [[previous,originals[0]],[adjacent,originals[2]]]) {
    const untouched = await ws.request('GET', '/storyboards/' + shot.id + '/takes');
    assert.deepEqual(untouched.candidates.map(v => v.id), [id]);
    assert.equal(untouched.take_revision, 1);
  }
  assert.equal(ws.db.prepare("SELECT COUNT(*) AS n FROM async_tasks WHERE type='video_generation'").get().n, 1);
});
