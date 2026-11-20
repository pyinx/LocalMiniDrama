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
const { takeEligibility, resolveTake } = require('../src/services/workbenchTakeService');

test('only explicit failed original-media checks block automatic use', () => {
  assert.equal(takeEligibility({}), true); // pre-check legacy take
  assert.equal(takeEligibility({ media_check: '{bad json' }), true);
  assert.equal(takeEligibility({ media_check: JSON.stringify({ status: 'unavailable', issues: [] }) }), true);
  assert.equal(takeEligibility({ media_check: JSON.stringify({ status: 'failed', issues: [{ code: 'duration_short' }] }) }), false);
  assert.equal(takeEligibility({ media_check: JSON.stringify({ status: 'failed', issues: [] }) }), true);
});

test('automatic take resolution skips a failed newest take but preserves explicit adoption', () => {
  const rows = [
    { id: 2, video_url: '/static/new.mp4', created_at: '2026-01-02', media_check: JSON.stringify({ status: 'failed', issues: [{ code: 'duration_short' }] }) },
    { id: 1, video_url: '/static/old.mp4', created_at: '2026-01-01' },
  ];
  assert.equal(resolveTake(null, { id: 5, updated_at: '2025-01-01' }, rows).id, 1);
  assert.equal(resolveTake(null, { id: 5, adopted_video_generation_id: 2 }, rows).id, 2);
});

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

async function cut(ws, epId, settings = {}) {
  const job = await ws.request('POST', '/episodes/' + epId + '/finalize', settings);
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
  const refreshed = await ws.request('GET', '/episodes/' + sb.episode_id + '/storyboards');
  assert.deepEqual(refreshed.storyboards[0].resolved_video, after.resolved_video);
  assert.equal(refreshed.storyboards[0].adopted_video_generation_id, red);
  assert.equal(refreshed.storyboards[0].video_url, '/static/red.mp4');
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

test('canonical legacy media identifies its unique review and is archived once', async t => {
  const ws = await takeWorkspace(t), sb = ws.shots[0];
  const id = ws.add(sb, 'old.mp4');
  ws.db.prepare("UPDATE video_generations SET local_path=NULL, video_url='/static/old.mp4' WHERE id=?").run(id);
  ws.db.prepare("UPDATE storyboards SET video_url='/static/old.mp4', updated_at='2099' WHERE id=?").run(sb.id);
  await ws.request('POST', '/storyboards/' + sb.id + '/takes/' + id + '/reviews', { time_ms: 50, note: '旧片对焦', action: 'revise' });
  const state = await ws.request('GET', '/dramas/' + ws.id + '/creative-review');
  assert.equal(state.episodes[0].shots[0].current_review.id, id);
  assert.equal(state.episodes[0].shots[0].needs_review, true);
  const { board, zip } = await archive(ws);
  assert.equal(board.video_takes.length, 1);
  assert.equal(zip.getEntries().filter(e => e.entryName.startsWith('media/videos/')).length, 1);
});

test('tail linking binds the next visible shot atomically and preserves its storyboard-only video', async t => {
  const ws = await takeWorkspace(t), [from, shadow] = ws.shots;
  ws.add(from, 'red.mp4', 'red');
  fs.copyFileSync(path.join(ws.storage, 'red.mp4'), path.join(ws.storage, 'old.mp4'));
  const next = await ws.request('POST', '/storyboards', { episode_id: from.episode_id, storyboard_number: 2, duration: 1 });
  ws.db.prepare("UPDATE storyboards SET storyboard_number=2, local_path='old.mp4' WHERE id=?").run(next.id);
  const link = () => ws.error('POST', '/storyboards/' + from.id + '/link-tail-frame', { drama_id: ws.id });
  const details = () => ws.request('GET', '/storyboards/' + next.id);
  const rows = () => ws.db.prepare('SELECT storyboard_id FROM image_generations WHERE provider=?').all('tail-frame');
  const imagesDir = path.join(ws.storage, 'media', 'images');
  ws.db.exec('CREATE TRIGGER skip_frame BEFORE UPDATE OF first_frame_image_id ON storyboards BEGIN SELECT RAISE(IGNORE); END');
  assert.equal((await link()).status, 500);
  assert.deepEqual(rows(), []);
  assert.deepEqual(fs.readdirSync(imagesDir), []);
  const before = ws.db.prepare('SELECT video_url, local_path FROM storyboards WHERE id=?').get(next.id);
  assert.deepEqual(before, { video_url: null, local_path: 'old.mp4' });
  ws.db.exec('DROP TRIGGER skip_frame');
  const frame = await (await link()).json();
  assert.equal(frame.next_storyboard_id, next.id);
  assert.ok(firstPixel(path.join(ws.storage, frame.local_path))[0] > 200);
  const after = await details();
  assert.equal(after.first_frame_image_id, frame.new_first_frame_image_id);
  assert.equal(after.local_path, frame.local_path);
  assert.equal(after.resolved_video.local_path, 'old.mp4');
  assert.equal(after.resolved_video.id, null);
  assert.equal((await ws.request('GET', '/storyboards/' + shadow.id)).first_frame_image_id, null);
  assert.deepEqual(rows(), [{storyboard_id: next.id}]);
  assert.equal((await ws.request('GET', '/storyboards/' + next.id + '/takes')).candidates.length, 0);
});

test('a storyboard-only video gets a stable reviewable identity on request', async t => {
  const ws = await takeWorkspace(t), sb = ws.shots[0];
  fs.writeFileSync(path.join(ws.storage, 'old.mp4'), 'legacy');
  ws.db.prepare("UPDATE storyboards SET video_url='old.mp4' WHERE id=?").run(sb.id);
  const base = '/storyboards/' + sb.id + '/takes';
  let detail = await ws.request('GET', base);
  assert.equal(detail.candidates.length, 0);
  assert.equal(detail.can_register_legacy, true);
  assert.equal(detail.resolved_video.local_path, 'old.mp4');
  assert.equal((await ws.error('POST', base + '/legacy', { local_path: 'changed.mp4', video_url: null })).status, 409);
  const registered = await Promise.all([1,2].map(() => ws.request('POST', base + '/legacy', detail.resolved_video)));
  const takeId = registered[0].resolved_video.id;
  assert.ok(takeId);
  assert.equal(registered[1].resolved_video.id, takeId);
  assert.equal(registered[1].candidates.length, 1);
  await ws.request('POST', base + '/' + takeId + '/reviews', { time_ms: 180, note: '旧镜跳帧', action: 'reshoot' });
  await ws.adopt(sb, takeId);
  assert.equal((await archive(ws)).board.video_takes[0].reviews[0].time_ms, 180);
  ws.add(sb, null);
  ws.db.prepare("UPDATE video_generations SET video_url='/static/old.mp4' WHERE storyboard_id=?").run(sb.id);
  ws.db.prepare("UPDATE storyboards SET adopted_video_generation_id=NULL, updated_at='2099' WHERE id=?").run(sb.id);
  detail = await ws.request('GET', base);
  assert.equal(detail.resolved_video.id, null);
  assert.equal(detail.can_register_legacy, false);
  assert.equal((await ws.error('POST', base + '/legacy', detail.resolved_video)).status, 409);
});

test('editor, review and strict delivery use the same visible row for a repeated shot number', async t => {
  const ws = await takeWorkspace(t);
  const [old, adjacent] = ws.shots;
  const history = ws.add(old, 'history.mp4');
  await ws.adopt(old, history);
  const visible = await ws.request('POST', '/storyboards', { episode_id: old.episode_id, storyboard_number: 1, duration: 1 });
  // Imported/streamed legacy rows can share a positive number even when a CRUD creation normalizes it.
  ws.db.prepare('UPDATE storyboards SET storyboard_number=1 WHERE id=?').run(visible.id);
  const current = ws.add(visible, 'visible.mp4', 'red');
  await ws.adopt(visible, current);
  ws.add(adjacent, 'other.mp4', 'blue');
  const projected = await ws.request('GET', '/dramas/' + ws.id + '/creative-review');
  assert.deepEqual(projected.episodes[0].shots.map(s => s.id), [visible.id, adjacent.id]);
  const { executeGetCurrentProject } = await import('../src/mastra/tools.mjs');
  const agent = executeGetCurrentProject(ws.db, ws.id, old.episode_id);
  assert.deepEqual(agent.project.storyboards.map(s => s.id), [visible.id, adjacent.id]);
  const inputs = require('../src/services/dramaService').episodeDeliveryInputs(ws.db, old.episode_id, ws.cfg.storage.base_url);
  assert.deepEqual(inputs.map(s => s.scene_id), [visible.id, adjacent.id]);
  t.mock.method(config, 'loadConfig', () => ws.cfg);
  assert.ok((await cut(ws, old.episode_id, { delivery_mode: 'complete' }))[0] > 200);
  // Recoverable hidden takes remain available in project archives.
  assert.equal((await archive(ws)).board.adopted_take_key, 'v' + history);
});

test('rebuilding an episode preserves the old cut on model and database failures and retains authored shots on success', async t => {
  const ws = await takeWorkspace(t), [first, second] = ws.shots;
  const base = '/episodes/' + first.episode_id + '/storyboards';
  ws.db.prepare("UPDATE episodes SET script_content='黎明前，两人在门口相遇。' WHERE id=?").run(first.episode_id);
  const red = ws.add(first, 'used.mp4');
  await ws.adopt(first, red);
  await ws.request('POST', '/storyboards/' + first.id + '/takes/' + red + '/reviews', { time_ms: 200, note: '保留版本', action: 'revise' });
  const proposals = [1,2,3].map(i => ({ shot_number: i, title: '重写镜' + i, action: '转身', duration: 2 }));
  const json = JSON.stringify(proposals);
  let release;
  const waiting = new Promise(resolve => { release = resolve; });
  const generate = t.mock.method(require('../src/services/aiClient'), 'generateText', async (...args) => {
    args.at(-1).streamCallback(json + ' '.repeat(500));
    await waiting;
    throw new Error('模拟生成失败');
  });
  const submit = () => ws.request('POST', base, { storyboard_count: 3 });
  const state = id => ws.db.prepare('SELECT status,error,result FROM async_tasks WHERE id=?').get(id);
  async function settle(id) {
    for (let i=0; i<150 && ['pending','processing'].includes(state(id).status); i++) await delay(20);
    return state(id);
  }
  const job = await submit();
  assert.equal((await submit()).task_id, job.task_id);
  const listing = async () => (await ws.request('GET', base)).storyboards;
  const oldIds = [first.id, second.id];
  assert.deepEqual((await listing()).map(s => s.id), oldIds);
  release();
  assert.equal((await settle(job.task_id)).status, 'failed');
  assert.deepEqual((await listing()).map(s => s.id), oldIds);
  assert.equal((await archive(ws)).board.adopted_take_key, 'v' + red);

  generate.mock.mockImplementation(async () => json);
  ws.db.exec(`CREATE TRIGGER fail_new_shot BEFORE INSERT ON storyboards WHEN NEW.title='重写镜3'
    BEGIN SELECT RAISE(ABORT, '模拟第二次写入失败'); END`);
  assert.match((await settle((await submit()).task_id)).error, /模拟第二次写入失败/);
  assert.deepEqual((await listing()).map(s => s.id), oldIds);
  ws.db.exec('DROP TRIGGER fail_new_shot');
  const done = await settle((await submit()).task_id);
  assert.equal(done.status, 'completed', done.error);
  assert.deepEqual(JSON.parse(done.result).preserved_shot_ids, [first.id]);
  const boards = await listing();
  assert.deepEqual(boards.map(s => s.storyboard_number), [1,2,3]);
  assert.equal(boards[0].id, first.id);
  assert.notEqual(boards[1].id, second.id);
  assert.equal(boards[0].resolved_video.id, red);
  assert.equal((await archive(ws)).board.video_takes[0].reviews[0].note, '保留版本');
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
