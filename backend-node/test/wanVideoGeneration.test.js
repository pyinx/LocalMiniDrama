const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { once } = require('node:events');
const { execFileSync } = require('node:child_process');
const { setTimeout: delay } = require('node:timers/promises');
const sharp = require('sharp');
const { getFfmpegPath } = require('../src/utils/ffmpegPath');
const { takeWorkspace } = require('./helpers/workbenchTakes');
const videoService = require('../src/services/videoService');

const model = 'wan2.2-kf2v-flash';

test('Wan 3.0 six-second portrait storyboard submits its ordered references, polls, and verifies the original media', async t => {
  const ws = await takeWorkspace(t);
  const shot = ws.shots[0];
  ws.db.prepare("UPDATE storyboards SET duration=6, creation_mode='universal' WHERE id=?").run(shot.id);
  const bytes = path.join(ws.storage, 'wan3-6s.mp4');
  execFileSync(getFfmpegPath(), ['-loglevel', 'error', '-f', 'lavfi', '-i', 'color=black:s=720x1280:r=8:d=6',
    '-f', 'lavfi', '-i', 'anullsrc=r=16000:cl=mono', '-shortest', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', bytes]);
  const requests = [];
  const vendor = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    requests.push({ method: req.method, path: req.url, headers: req.headers,
      body: chunks.length ? JSON.parse(Buffer.concat(chunks)) : null });
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify(req.method === 'POST' ? { output: { task_id: 'wan-task', task_status: 'PENDING' } }
      : { output: { task_status: 'SUCCEEDED', video_url: ws.cfg.storage.base_url + '/wan3-6s.mp4' }, usage: { SR: 720 } }));
  }).listen(0, '127.0.0.1');
  await once(vendor, 'listening');
  t.after(() => new Promise(resolve => vendor.close(resolve)));
  ws.db.prepare(`INSERT INTO ai_service_configs(service_type,provider,base_url,api_key,model,is_default,is_active)
    VALUES('video','dashscope',?,'local-test','["wan3.0-video"]',1,1)`).run('http://127.0.0.1:' + vendor.address().port + '/api/v1/');
  t.mock.method(require('../src/config'), 'loadConfig', () => ws.cfg);
  const process = videoService.processVideoGeneration;
  const tasks = [];
  t.mock.method(videoService, 'processVideoGeneration', (...args) => { tasks.push(process(...args)); });
  const refs = ['scene.png', 'actor.png'];
  for (const [index, name] of refs.entries()) await sharp({ create: { width: 480, height: 720, channels: 3, background: index ? 'blue' : 'red' } }).png().toFile(path.join(ws.storage, name));
  const body = { drama_id: ws.id, storyboard_id: shot.id, operation_key: 'wan3-shot', duration: 5, aspect_ratio: '9:16',
    reference_mode: 'omni', resolution: '720p', prompt: '@图片2 走入@图片1', generate_audio: true, reference_image_urls: refs.map(name => '/static/' + name) };
  assert.equal((await ws.error('POST', '/videos', { ...body, reference_image_urls: Array(11).fill('/static/actor.png') })).status, 422);
  assert.equal(ws.db.prepare('SELECT COUNT(*) n FROM async_tasks').get().n, 0);
  const item = await ws.request('POST', '/videos', body);
  const replay = await ws.request('POST', '/videos', body);
  assert.equal(replay.id, item.id);
  await delay(0);
  assert.equal(tasks.length, 1);
  await tasks[0];
  assert.deepEqual(requests.map(r => [r.method, r.path]), [
    ['POST', '/api/v1/services/aigc/video-generation/video-synthesis'], ['GET', '/api/v1/tasks/wan-task'],
  ]);
  const [request] = requests;
  assert.equal(request.headers['x-dashscope-async'], 'enable');
  assert.equal(request.body.model, 'wan3.0-video');
  assert.equal(request.body.input.prompt, '图2 走入图1');
  assert.deepEqual(request.body.input.media, refs.map(name => ({ type: 'reference_image',
    url: 'data:image/png;base64,' + fs.readFileSync(path.join(ws.storage, name)).toString('base64') })));
  assert.deepEqual(request.body.parameters, { duration: 6, resolution: '720P', ratio: '9:16', audio: true, watermark: false });
  const take = await ws.request('GET', '/videos/' + item.id);
  assert.equal(take.status, 'completed', take.error_msg);
  assert.equal(take.eligible_for_automatic_use, true);
  assert.equal(take.media_check.width, 720);
  assert.equal(take.media_check.height, 1280);
  assert.deepEqual(fs.readFileSync(path.join(ws.storage, take.local_path)), fs.readFileSync(bytes));
});

test('Wan video submission and original-media checks preserve the reviewed shot and its target', async t => {
  const ws = await takeWorkspace(t);
  const [shot, otherShot] = ws.shots;
  const origin = address => `http://127.0.0.1:${address.port}`;
  const submissions = [];
  const asset = (filename, source) => execFileSync(getFfmpegPath(), ['-loglevel', 'error', '-f', 'lavfi', '-i', source,
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', path.join(ws.storage, filename)]);
  asset('bad.mp4', 'color=white:s=854x480:r=12:d=4');
  asset('good.mp4', 'color=white:s=720x1280:r=12:d=5');
  let variant = 'bad';
  const vendor = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    submissions.push({ path: req.url, body: JSON.parse(Buffer.concat(chunks).toString()) });
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ output: { video_url: `${ws.cfg.storage.base_url}/${variant}.mp4` },
      usage: { SR: variant === 'bad' ? 480 : 720 } }));
  }).listen(0, '127.0.0.1');
  await once(vendor, 'listening');
  t.after(() => new Promise(resolve => vendor.close(resolve)));
  const addConfig = ws.db.prepare(`INSERT INTO ai_service_configs(service_type,provider,base_url,api_key,model,is_default,is_active)
    VALUES('video','dashscope',?,'test',?,?,1)`);
  const configId = addConfig.run(origin(vendor.address()), JSON.stringify([model]), 1).lastInsertRowid;
  const alternateId = addConfig.run('http://127.0.0.1:1', JSON.stringify([model]), 0).lastInsertRowid;
  t.mock.method(require('../src/config'), 'loadConfig', () => ws.cfg);
  const run = videoService.processVideoGeneration;
  const deferred = [];
  t.mock.method(videoService, 'processVideoGeneration', (db, log, id) => deferred.push(() => run(db, log, id)));

  const image = (name, width, height) => sharp({ create: { width, height, channels: 3, background: 'white' } })
    .png().toFile(path.join(ws.storage, name));
  await Promise.all([image('portrait.png', 720, 1280), image('landscape.png', 1280, 720)]);
  const body = { drama_id: ws.id, storyboard_id: shot.id, prompt: '人物推开门', duration: 6,
    first_frame_url: '/static/portrait.png', aspect_ratio: '9:16', resolution: '720p', operation_key: 'test-shot' };
  const update = ws.db.prepare('UPDATE storyboards SET duration=?,creation_mode=?,dialogue=? WHERE id=?');
  async function incompatible(input, message) {
    const res = await ws.error('POST', '/videos', input);
    assert.equal(res.status, 422);
    const { error } = await res.json();
    assert.equal(error.code, 'video_model_incompatible');
    assert.match(error.message, message);
  }
  update.run(6, 'universal', '说再见', shot.id);
  for (let i = 0; i < 3; i++) await incompatible(body, /固定生成 5 秒/);
  update.run(5, 'universal', null, shot.id);
  await incompatible(body, /不支持全能模式/);
  update.run(5, 'classic', '说再见', shot.id);
  await incompatible(body, /本镜包含台词/);
  update.run(5, 'classic', null, shot.id);
  await incompatible({ ...body, first_frame_url: '/static/landscape.png' }, /当前为 1280×720/);
  await incompatible({ ...body, first_frame_url: 'https://example.com/unchecked.png' }, /无法核实外链/);
  assert.equal(ws.db.prepare('SELECT COUNT(*) n FROM video_generations').get().n, 0);
  assert.equal(ws.db.prepare('SELECT COUNT(*) n FROM async_tasks').get().n, 0);
  assert.equal(submissions.length, 0);

  const created = await ws.request('POST', '/videos', body);
  assert.equal(created.duration, 5);
  assert.equal(created.model, model);
  assert.equal(created.resolution, '720P');
  ws.db.prepare('UPDATE ai_service_configs SET is_default=(id=?)').run(alternateId);
  update.run(6, 'universal', '换成另一句', shot.id);
  const replay = await ws.request('POST', '/videos', body);
  assert.equal(replay.id, created.id);
  assert.equal((await ws.error('POST', '/videos', { ...body, prompt: '不同的分镜' })).status, 409);
  await delay(0);
  assert.equal(deferred.length, 1);
  await deferred.shift()();
  assert.equal(submissions.length, 1);
  const [sent] = submissions;
  assert.equal(sent.path, '/api/v1/services/aigc/image2video/video-synthesis');
  assert.deepEqual(sent.body.parameters, { resolution: '720P', prompt_extend: false });
  assert.equal(sent.body.model, model);
  assert.match(sent.body.input.first_frame_url, /^data:image\/png;base64,/);
  assert.equal('last_frame_url' in sent.body.input, false);
  const take = await ws.request('GET', `/videos/${created.id}`);
  assert.equal(take.status, 'completed');
  assert.equal(take.eligible_for_automatic_use, false);
  assert.deepEqual(take.media_check.issues.map(issue => issue.code), ['duration_short', 'aspect_ratio_mismatch', 'resolution_low']);
  assert.equal(take.media_check.width, 854);
  const reviewed = await ws.request('GET', `/storyboards/${shot.id}/takes`);
  assert.equal(reviewed.resolved_video, null);
  assert.equal(reviewed.candidates[0].id, take.id);
  assert.equal(reviewed.candidates[0].eligible_for_automatic_use, false);
  assert.equal((await ws.request('POST', `/videos/episode/${shot.episode_id}/batch`, { storyboard_ids: [shot.id] }))[0].status, 'waiting');

  variant = 'good';
  update.run(5, 'classic', null, otherShot.id);
  ws.db.prepare('UPDATE ai_service_configs SET is_default=(id=?)').run(configId);
  const good = await ws.request('POST', '/videos', { ...body, storyboard_id: otherShot.id, operation_key: 'good-shot' });
  await delay(0);
  await deferred.shift()();
  const passed = await ws.request('GET', `/videos/${good.id}`);
  assert.equal(passed.media_check.status, 'passed');
  assert.equal(passed.eligible_for_automatic_use, true);
  assert.equal((await ws.request('GET', `/storyboards/${otherShot.id}/takes`)).resolved_video.id, good.id);
  assert.deepEqual(fs.readFileSync(path.join(ws.storage, passed.local_path)), fs.readFileSync(path.join(ws.storage, 'good.mp4')));
});
