const { test } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const http = require('node:http');
const { once } = require('node:events');
const { execFileSync } = require('node:child_process');
const path = require('node:path');
const { setTimeout: delay } = require('node:timers/promises');
const Database = require('better-sqlite3');
const { runMigrationsAndEnsure } = require('../src/db/migrate');
const { setupRouter } = require('../src/routes');
const api = require('../src/services/videoClient');
const video = require('../src/services/videoService');
const tasks = require('../src/services/taskService');
const drama = require('../src/services/dramaService');
const { getFfmpegPath } = require('../src/utils/ffmpegPath');
const { takeWorkspace } = require('./helpers/workbenchTakes');
const log = { info() {}, warn() {}, error() {} };

test('filling missing shots reuses storyboard-only media even with a stale waiting slot', async t => {
  const ws = await takeWorkspace(t);
  const [shot] = ws.shots;
  const batch = () => ws.request('POST', '/videos/episode/' + shot.episode_id + '/batch', { storyboard_ids: [shot.id] });
  const [waiting] = await batch();
  ws.db.prepare("UPDATE storyboards SET video_url='/static/old.mp4' WHERE id=?").run(shot.id);
  assert.equal((await batch())[0].status, 'waiting');
  require('node:fs').writeFileSync(path.join(ws.storage, 'old.mp4'), 'legacy clip');
  const [ready] = await batch();
  assert.equal(ready.status, 'completed');
  assert.equal(ready.video_id, null);
  const result = await ws.request('POST', '/videos', { drama_id: ws.id, storyboard_id: shot.id,
    operation_key: waiting.operation_key, prompt: '补镜' });
  assert.equal(result.status, 'completed');
  assert.equal(result.local_path, 'old.mp4');
  assert.equal(ws.db.prepare('SELECT COUNT(*) AS n FROM video_generations').get().n, 0);
  assert.equal(ws.db.prepare('SELECT COUNT(*) AS n FROM async_tasks').get().n, 0);
});

test('a successful provider reply without a handle cannot be dispatched twice', async t => {
  const ws = await takeWorkspace(t);
  const [accepted, rejected] = ws.shots;
  let posts = 0;
  const provider = http.createServer((req, res) => {
    assert.equal(req.method, 'POST');
    posts++;
    res.writeHead(posts === 1 ? 200 : 400, { 'Content-Type': 'application/json' });
    res.end(posts === 1 ? '{"accepted":true}' : '{"message":"invalid model"}');
  }).listen(0, '127.0.0.1');
  await once(provider, 'listening');
  t.after(() => new Promise(resolve => provider.close(resolve)));
  ws.db.prepare(`INSERT INTO ai_service_configs(service_type,provider,model,base_url,api_key,is_default,is_active)
    VALUES('video','volcengine','["fixture"]',?,'test',1,1)`).run('http://127.0.0.1:' + provider.address().port);
  t.mock.method(require('../src/config'), 'loadConfig', () => ws.cfg);
  const post = (shot, key) => ws.request('POST', '/videos', {
    drama_id: ws.id, storyboard_id: shot.id, operation_key: key, prompt: '镜头', model: 'fixture',
  });
  async function failed(id) {
    for (let i = 0; i < 200; i++) {
      const result = video.getById(ws.db, id);
      if (result.status === 'failed') return result;
      await delay(10);
    }
    assert.fail('submission did not settle');
  }
  const first = await post(accepted, 'single-accepted');
  assert.equal((await failed(first.id)).dispatch_state, 'unknown');
  const second = await post(rejected, 'single-rejected');
  assert.equal((await failed(second.id)).dispatch_state, 'rejected');
  // Restore an older failed/sent record as it would appear after upgrading.
  ws.db.prepare("UPDATE video_generations SET dispatch_state='sent' WHERE id=?").run(first.id);
  video.resumeProcessingVideoGenerations(ws.db, log);
  const slots = await ws.request('POST', '/videos/episode/' + ws.episodes[0].id + '/batch',
    { storyboard_ids: [accepted.id, rejected.id] });
  assert.equal(slots[0].dispatch_state, 'unknown');
  assert.equal((await post(accepted, slots[0].operation_key)).id, first.id);
  assert.equal(slots[1].status, 'waiting');
  assert.equal(posts, 2);
});

test('a waiting batch reuses later manual takes at submission and on reopen', async t => {
  const ws = await takeWorkspace(t);
  const episode = ws.episodes[0].id;
  const [running, uncertain] = ws.shots;
  const finished = await ws.request('POST', '/storyboards', { episode_id: episode, storyboard_number: 3, duration: 1 });
  const post = (board, key) => ws.request('POST', '/videos', {
    drama_id: ws.id, storyboard_id: board.id, operation_key: key, prompt: '同一镜头',
  });
  const batch = ids => ws.request('POST', '/videos/episode/' + episode + '/batch', { storyboard_ids: ids });
  const slots = await batch([running.id, uncertain.id, finished.id]);
  assert.ok(slots.every(item => item.status === 'waiting'));

  const attempts = new Map();
  const supplier = http.createServer((req, res) => {
    const id = Number(req.url.slice(1));
    attempts.set(id, (attempts.get(id) || 0) + 1);
    res.end('accepted');
  });
  supplier.listen(0, '127.0.0.1');
  await once(supplier, 'listening');
  t.after(() => new Promise(resolve => supplier.close(resolve)));
  let release;
  const hold = new Promise(resolve => { release = resolve; });
  t.after(() => release());
  execFileSync(getFfmpegPath(), ['-loglevel', 'error', '-f', 'lavfi', '-i', 'color=green:s=64x64:r=2:d=1',
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', path.join(ws.storage, 'done.mp4')]);
  t.mock.method(require('../src/config'), 'loadConfig', () => ws.cfg);
  t.mock.method(api, 'getDefaultVideoConfig', () => ({ provider: 'test' }));
  t.mock.method(api, 'callVideoApi', async (_db, _log, body) => {
    await (await fetch('http://127.0.0.1:' + supplier.address().port + '/' + body.storyboard_id, { method: 'POST' })).text();
    if (body.storyboard_id === running.id) await hold;
    return body.storyboard_id === uncertain.id ? { error: '接单后请求超时' } : { video_url: ws.cfg.storage.base_url + '/done.mp4' };
  });
  async function waitStatus(id, status) {
    for (let n = 0; n < 500 && video.getById(ws.db, id).status !== status; n++) await delay(10);
    assert.equal(video.getById(ws.db, id).status, status);
  }
  const [one, two, three] = await Promise.all([
    post(running, 'manual-one'), post(uncertain, 'manual-two'), post(finished, 'manual-three'),
  ]);
  await Promise.all([waitStatus(two.id, 'failed'), waitStatus(three.id, 'completed')]);
  // Both windows still hold waiting snapshots. No call to openBatch refreshes them before POST.
  const repeats = await Promise.all([
    post(running, slots[0].operation_key), post(running, slots[0].operation_key), post(uncertain, slots[1].operation_key),
  ]);
  assert.deepEqual(repeats.map(v => [v.id, v.task_id]), [[one.id, one.task_id], [one.id, one.task_id], [two.id, two.task_id]]);
  assert.equal(repeats[2].dispatch_state, 'unknown');
  const reopened = await batch([]);
  assert.deepEqual(reopened.map(v => v.video_id), [one.id,two.id,three.id]);
  assert.deepEqual(reopened.map(v => v.operation_key), slots.map(v => v.operation_key));
  assert.deepEqual(reopened.map(v => v.status), ['processing','failed','completed']);
  assert.equal((await post(finished,slots[2].operation_key)).id, three.id);
  assert.equal((await post(finished,'manual-three')).id, three.id);
  assert.equal(ws.db.prepare('SELECT COUNT(*) n FROM video_generations').get().n, 3);
  assert.deepEqual([running,uncertain,finished].map(b => attempts.get(b.id)), [1,1,1]);
  const reshoot = await post(uncertain, 'manual-explicit-reshoot');
  await waitStatus(reshoot.id,'failed');
  assert.notEqual(reshoot.id, two.id);
  assert.equal(attempts.get(uncertain.id), 2);
  release();
  await waitStatus(one.id, 'completed');
});

test('recovers without repeating uncertain dispatches', async t => {
  const db = new Database(':memory:');
  t.after(() => db.close());
  runMigrationsAndEnsure(db);
  const project = drama.createDrama(db, log, { title: '复工' });
  drama.saveEpisodes(db, log, project.id, { episodes: [{ episode_number: 1, title: '开工' }] });
  const episode = db.prepare('SELECT id FROM episodes').get().id;
  const makeShot = n => db.prepare("INSERT INTO storyboards(episode_id,storyboard_number,title,created_at,updated_at) VALUES(?,?,?,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)").run(episode, n, '镜' + n).lastInsertRowid;
  const [a, b] = [makeShot(1), makeShot(2)];
  let attempts = 0;
  const supplier = http.createServer((req, res) => { attempts++; req.socket.destroy(); });
  supplier.listen(0, '127.0.0.1');
  await once(supplier, 'listening');
  t.after(() => new Promise(resolve => supplier.close(resolve)));
  t.mock.method(api, 'getDefaultVideoConfig', () => ({ provider: 'test' }));
  t.mock.method(api, 'callVideoApi', async () => { await fetch('http://127.0.0.1:' + supplier.address().port, { method: 'POST' }); });
  const cfg = { storage: {}, server: {} };
  const app = express();
  app.use(express.json());
  app.use('/api/v1', setupRouter(cfg, db, log));
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise(resolve => server.close(resolve)));
  const post = async (url, body) => {
    const r = await fetch('http://127.0.0.1:' + server.address().port + '/api/v1' + url, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
    const result = await r.json();
    assert.ok(r.ok, JSON.stringify(result));
    return result.data;
  };
  const batch = ids => post('/videos/episode/' + episode + '/batch', { storyboard_ids: ids });
  const [first, waiting] = await batch([a, b]);
  const payload = { drama_id: project.id, storyboard_id: a, operation_key: first.operation_key, prompt: '车门打开' };
  const [one, two] = await Promise.all([post('/videos', payload), post('/videos', payload)]);
  assert.equal(one.id, two.id);
  assert.equal(one.task_id, two.task_id);
  for (let i = 0; i < 100 && video.getById(db, one.id).status !== 'failed'; i++) await delay(20);
  assert.equal(attempts, 1);
  assert.equal(video.getById(db, one.id).dispatch_state, 'unknown');
  assert.equal((await batch([]))[1].operation_key, waiting.operation_key);
  // Interrupt between dispatch and saving the upstream ID.
  db.prepare("UPDATE video_generations SET status='processing', dispatch_state='sent' WHERE id=?").run(one.id);
  video.resumeProcessingVideoGenerations(db, log);
  assert.equal((await post('/videos', payload)).dispatch_state, 'unknown');
  assert.equal((await batch([a, b]))[0].operation_key, first.operation_key);
  assert.equal(attempts, 1);
  // The stopped batch still has an unclaimed item. Cancel before it is sent,
  // then explicitly resume. The new operation may contact the provider once.
  const createTask = tasks.createTask(db, log, 'video_generation', String(project.id));
  db.prepare(`INSERT INTO video_generations(drama_id,storyboard_id,provider,prompt,status,operation_key,dispatch_state,task_id,created_at,updated_at)
    VALUES(?,?,'test','排队','processing',?,'queued',?,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)`).run(project.id,b,waiting.operation_key,createTask.id);
  tasks.cancelTask(db, log, createTask.id);
  const resumed = (await batch([b]))[1];
  assert.notEqual(resumed.operation_key, waiting.operation_key);
  assert.equal(resumed.status, 'waiting');
  const next = await post('/videos', { ...payload, storyboard_id: b, operation_key: resumed.operation_key });
  for (let i = 0; i < 100 && video.getById(db, next.id).status !== 'failed'; i++) await delay(20);
  assert.equal(attempts, 2);
  // A known upstream ID is only polled after startup.
  db.prepare("UPDATE video_generations SET status='processing', dispatch_state='sent', provider_task_id='known-123' WHERE id=?").run(one.id);
  const poll = t.mock.method(api, 'pollVideoTask', async () => ({ error: '供应商已终止任务' }));
  video.resumeProcessingVideoGenerations(db, log);
  for (let i = 0; i < 100 && !poll.mock.callCount(); i++) await delay(20);
  assert.equal(poll.mock.callCount(), 1);
  assert.equal(poll.mock.calls[0].arguments[3], 'known-123');
  assert.equal(attempts, 2);
});
