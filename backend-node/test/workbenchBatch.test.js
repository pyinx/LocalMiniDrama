const { test } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const http = require('node:http');
const { once } = require('node:events');
const { setTimeout: delay } = require('node:timers/promises');
const Database = require('better-sqlite3');
const { runMigrationsAndEnsure } = require('../src/db/migrate');
const { setupRouter } = require('../src/routes');
const api = require('../src/services/videoClient');
const video = require('../src/services/videoService');
const tasks = require('../src/services/taskService');
const drama = require('../src/services/dramaService');
const log = { info() {}, warn() {}, error() {} };

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
