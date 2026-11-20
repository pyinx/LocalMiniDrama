const { test } = require('node:test');
const assert = require('node:assert/strict');
const { takeWorkspace } = require('./helpers/workbenchTakes');
const videoService = require('../src/services/videoService');

test('legacy universal video submission preserves the saved action on retries without editing authored text', async t => {
  const ws = await takeWorkspace(t);
  const [shot, classic] = ws.shots;
  t.mock.method(videoService, 'processVideoGeneration', () => {});
  const prompt = '分镜1： 6秒: 桌上有一本书。';
  const action = '店员把书递给客人。';
  const update = ws.db.prepare('UPDATE storyboards SET creation_mode=?,action=?,universal_segment_text=? WHERE id=?');
  update.run('universal', action, prompt, shot.id);
  update.run('classic', action, null, classic.id);
  const body = { drama_id: ws.id, storyboard_id: shot.id, prompt, operation_key: 'same-take' };
  const { id } = await ws.request('POST', '/videos', body);
  const take = await ws.request('GET', '/videos/' + id);
  assert.ok(take.prompt.includes(action));
  assert.equal(ws.db.prepare('SELECT universal_segment_text FROM storyboards WHERE id=?').get(shot.id).universal_segment_text, prompt);
  assert.equal((await ws.request('POST', '/videos', body)).id, id);
  const other = await ws.request('POST', '/videos', { drama_id: ws.id, storyboard_id: classic.id, prompt });
  assert.ok(!(await ws.request('GET', '/videos/' + other.id)).prompt.includes(action));
});
