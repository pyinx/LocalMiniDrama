const test = require('node:test');
const assert = require('node:assert/strict');
const { takeWorkspace } = require('./helpers/workbenchTakes');
const merge = require('../src/services/videoMergeService');

test('seam auditions queue the same structured post settings as formal delivery', async t => {
  const ws = await takeWorkspace(t);
  t.mock.method(require('../src/config'), 'loadConfig', () => ws.cfg);
  // Inspect the real queued jobs before encoding starts.
  t.mock.method(merge, 'processVideoMerge', async () => {});
  for (const shot of ws.shots.slice(0, 2)) {
    await ws.adopt(shot, ws.add(shot, `shot-${shot.id}.mp4`, 'blue'));
  }
  const episode = '/episodes/' + ws.episodes[0].id;
  const { shots: [left, right], revision } = await ws.request('GET', episode + '/edit');
  const settings = {
    dialogue_subtitles: true, cards: true, review_sheets: true,
    bgm: { url: '/static/score.wav', volume_db: -22 },
  };
  const delivery = await ws.request('POST', episode + '/finalize', { ...settings, delivery_mode: 'complete' });
  const audition = await ws.request('POST', episode + '/edit/audition', {
    ...settings, delivery_mode: 'complete', action: 'original', left, right, revision,
  });
  await new Promise(resolve => setImmediate(resolve));
  const query = ws.db.prepare('SELECT merge_options FROM video_merges WHERE id = ?');
  const finalOptions = JSON.parse(query.get(delivery.merge_id).merge_options);
  const auditionOptions = JSON.parse(query.get(audition.merge_id).merge_options);
  assert.equal(finalOptions.delivery_mode, 'complete');
  assert.equal(auditionOptions.delivery_mode, 'draft');
  for (const [key, expected] of Object.entries(settings)) {
    assert.deepEqual(finalOptions[key], expected, key);
    assert.deepEqual(auditionOptions[key], finalOptions[key], key);
  }
});
