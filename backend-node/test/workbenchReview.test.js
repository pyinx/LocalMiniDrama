const { test } = require('node:test');
const assert = require('node:assert/strict');
const { setTimeout: delay } = require('node:timers/promises');
const config = require('../src/config');
const videoClient = require('../src/services/videoClient');
const { takeWorkspace } = require('./helpers/workbenchTakes');

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
