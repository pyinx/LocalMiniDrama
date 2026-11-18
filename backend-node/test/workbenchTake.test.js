const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { setTimeout: delay } = require('node:timers/promises');
const AdmZip = require('adm-zip');
const config = require('../src/config');
const videoClient = require('../src/services/videoClient');
const videoService = require('../src/services/videoService');
const { getFfmpegPath } = require('../src/utils/ffmpegPath');
const { takeWorkspace } = require('./helpers/workbenchTakes');

async function archive(ws, extras = []) {
  const res = await fetch(ws.url('/dramas/' + ws.id + '/export?take_ids=' + extras.join(',')));
  assert.equal(res.status, 200);
  const buffer = Buffer.from(await res.arrayBuffer());
  const zip = new AdmZip(buffer);
  const project = JSON.parse(zip.readAsText('project.json'));
  return { buffer, zip, board: project.episodes[0].storyboards[0] };
}

async function restore(ws, buffer) {
  const form = new FormData();
  form.append('file', new Blob([buffer]), 'project.zip');
  const restored = await ws.request('POST', '/dramas/import', form);
  return ws.request('GET', '/dramas/' + restored.drama_id);
}

function firstPixel(file) {
  return execFileSync(getFfmpegPath(), ['-loglevel', 'error', '-i', file, '-frames:v', '1', '-vf', 'crop=2:2:(iw-2)/2:(ih-2)/2,scale=1:1', '-pix_fmt', 'rgb24', '-f', 'rawvideo', 'pipe:1']);
}

async function cut(ws, epId) {
  const job = await ws.request('POST', '/episodes/' + epId + '/finalize', {});
  const deadline = Date.now() + 20000;
  do {
    const merge = await ws.request('GET', '/video-merges/' + job.merge_id);
    if (merge.status === 'completed') return firstPixel(path.join(ws.storage, merge.merged_url));
    assert.notEqual(merge.status, 'failed', merge.error_msg);
    await delay(25);
  } while (Date.now() < deadline);
  assert.fail('Timed out waiting for the episode cut');
}

test('keeps the adopted take across consumers and restore', async t => {
  const ws = await takeWorkspace(t), dest = await takeWorkspace(t);
  const [sb, adjacent] = ws.shots;
  const red = ws.add(sb, 'red.mp4', 'red'), blue = ws.add(sb, 'blue.mp4', 'blue');
  ws.add(adjacent, 'end.mp4', 'green');
  dest.add(dest.shots[0], 'offset.mp4');
  const cfg = t.mock.method(config, 'loadConfig', () => ws.cfg);
  await ws.adopt(sb, red);
  ws.db.prepare("UPDATE video_generations SET status='processing',provider_task_id='local-render' WHERE id=?").run(blue);
  t.mock.method(videoClient, 'getDefaultVideoConfig', () => ({ provider: 'test' }));
  t.mock.method(videoClient, 'pollVideoTask', async () => ({ video_url: ws.cfg.storage.base_url + '/blue.mp4' }));
  await videoService.resumePollForVideoGeneration(ws.db, console, blue);
  assert.equal(videoService.getById(ws.db, blue).status, 'completed');
  const after = await ws.request('GET', '/storyboards/' + sb.id);
  assert.equal(after.resolved_video.id, red);
  assert.equal(after.local_path, null);
  const details = await ws.request('GET', '/dramas/' + ws.id);
  assert.equal(details.episodes[0].storyboards[0].resolved_video.id, red);
  const link = await fetch(ws.url('/storyboards/' + sb.id + '/link-tail-frame'), { method: 'POST',
    headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ drama_id: ws.id }) });
  const frame = await link.json();
  assert.equal(frame.success, true, JSON.stringify(frame));
  assert.ok(firstPixel(path.join(ws.storage, frame.local_path))[0] > 200);
  assert.ok((await cut(ws, sb.episode_id))[0] > 200);
  const { buffer, zip, board } = await archive(ws, [blue]);
  assert.deepEqual(zip.readFile(board.video_file), fs.readFileSync(path.join(ws.storage, 'red.mp4')));
  const reopened = await restore(dest, buffer);
  const restored = reopened.episodes[0].storyboards[0];
  assert.notEqual(restored.resolved_video.id, red);
  assert.deepEqual(fs.readFileSync(path.join(dest.storage, restored.resolved_video.local_path)), zip.readFile(board.video_file));
  const versions = await dest.request('GET', '/storyboards/' + restored.id + '/takes');
  await dest.adopt(restored, versions.candidates.find(v => v.id !== restored.resolved_video.id).id, restored.take_revision);
  cfg.mock.mockImplementation(() => dest.cfg);
  assert.ok((await cut(dest, restored.episode_id))[2] > 200);
});

test('archives the selected candidate set once', async t => {
  const ws = await takeWorkspace(t), dest = await takeWorkspace(t);
  const sb = ws.shots[0], base = '/storyboards/' + sb.id + '/takes/';
  const [a,b,c,d] = ['a','b','c','d'].map(key => ws.add(sb, key + '.mp4'));
  await ws.adopt(sb, a);
  const review = { time_ms: 450, note: '票在此帧换手', action: 'replace' };
  for (const id of [a,b]) await ws.request('POST', base + id + '/reviews', review);
  for (const id of [a,c]) await ws.request('PUT', base + id + '/retention', { keep_in_archive: true });
  const fixed = await archive(ws);
  assert.deepEqual(fixed.board.video_takes.map(v => v.key).sort(), [a,b,c].map(id => 'v'+id));
  const full = await archive(ws, [d,d,a]);
  assert.equal(full.board.video_takes.length, 4);
  assert.equal(full.zip.getEntries().filter(e => /^media\/videos\//.test(e.entryName)).length, 4);
  dest.add(dest.shots[0], 'offset.mp4');
  const imported = await restore(dest, full.buffer);
  const restored = imported.episodes[0].storyboards[0];
  const details = await dest.request('GET', '/storyboards/' + restored.id + '/takes');
  for (const row of details.candidates) {
    const bytes = fs.readFileSync(path.join(dest.storage, row.local_path), 'utf8');
    assert.equal(row.keep_in_archive, ['a.mp4','c.mp4'].includes(bytes));
    assert.equal(row.reviews.length, ['a.mp4','b.mp4'].includes(bytes) ? 1 : 0);
    if (row.reviews.length) assert.equal(row.reviews[0].video_generation_id, row.id);
  }
  // 1.4 has only video_file. Both new and legacy readers can still open the chosen video.
  const oldZip = new AdmZip(fixed.buffer);
  const manifest = JSON.parse(oldZip.readAsText('project.json'));
  const old = manifest.episodes[0].storyboards[0];
  delete old.video_takes; delete old.adopted_take_key; manifest.version = '1.4';
  oldZip.updateFile('project.json', Buffer.from(JSON.stringify(manifest)));
  const oldImport = await restore(dest, oldZip.toBuffer());
  assert.equal(oldImport.episodes[0].storyboards[0].adopted_video_generation_id, null);
  assert.equal(fs.readFileSync(path.join(dest.storage, oldImport.episodes[0].storyboards[0].resolved_video.local_path), 'utf8'), 'a.mp4');
});

test('rejects stale selections and foreign takes', async t => {
  const ws = await takeWorkspace(t), [sb,other] = ws.shots;
  const a = ws.add(sb, 'a.mp4'), b = ws.add(sb, 'b.mp4'), elsewhere = ws.add(other, 'c.mp4');
  ws.db.prepare("UPDATE video_generations SET video_url='/static/a.mp4',local_path=NULL WHERE id=?").run(a);
  const endpoint = '/storyboards/' + sb.id + '/takes/adoption';
  const results = await Promise.all([a,b].map(id => ws.error('PUT', endpoint, { video_generation_id: id, expected_revision: 0 })));
  assert.deepEqual(results.map(r => r.status).sort(), [200,409]);
  const board = await ws.request('GET', '/storyboards/' + sb.id);
  assert.equal((await ws.adopt(sb, board.adopted_video_generation_id)).take_revision, 1);
  assert.equal((await ws.error('PUT', endpoint, {video_generation_id: elsewhere, expected_revision: 1})).status, 400);
  const choices = await ws.request('GET', '/dramas/' + ws.id + '/export-takes');
  assert.ok(choices.find(v => v.id === a).local_available);
  assert.ok((await archive(ws, [a])).board.video_takes.some(v => v.key === 'v' + a));
  const remote = ws.add(sb, null);
  ws.db.prepare("UPDATE video_generations SET video_url='https://example.invalid/remote.mp4' WHERE id=?").run(remote);
  await ws.adopt(sb, remote, 1);
  const missing = await fetch(ws.url('/dramas/' + ws.id + '/export'));
  assert.equal(missing.status, 422);
  assert.match((await missing.json()).error.message, /第 1 集第 1 镜/);
});
