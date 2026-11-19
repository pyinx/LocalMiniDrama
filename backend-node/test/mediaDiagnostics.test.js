const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { getFfmpegPath } = require('../src/utils/ffmpegPath');
const { takeWorkspace } = require('./helpers/workbenchTakes');

function ffmpeg(args) {
  execFileSync(getFfmpegPath(), ['-v', 'error', '-nostdin', '-y', ...args], { timeout: 30000 });
}
function makeClip(ws, file, { color = 'white', filter, audio, seconds = 2 } = {}) {
  const args = ['-f', 'lavfi', '-i', 'color=c=' + color + ':s=96x64:r=25'];
  if (audio) args.push('-f', 'lavfi', '-i', audio, '-c:a', file.endsWith('.mov') ? 'pcm_s16le' : 'aac');
  if (filter) args.push('-vf', filter);
  ffmpeg([...args, '-t', String(seconds), '-c:v', 'libx264', '-pix_fmt', 'yuv420p', path.join(ws.storage, file)]);
}

test('frame checks belong to the selected take and remeasure after replacement', async t => {
  const ws = await takeWorkspace(t);
  const [a, b] = ws.shots;
  const take = ws.add(a, 'candidate.mp4');
  const file = path.join(ws.storage, 'candidate.mp4');
  const route = '/storyboards/' + a.id + '/takes/' + take + '/framing';
  const get = () => ws.request('GET', route);
  makeClip(ws, 'candidate.mp4', { filter: 'pad=96:160:0:48' });
  const [one, two] = await Promise.all([get(), get()]);
  assert.equal(one.status, 'possible_bars');
  assert.deepEqual(one.rect, { w: 96, h: 64, x: 0, y: 48 });
  assert.ok(one.samples.length === 5 && one.samples.every(s => s.seconds > 0 && s.seconds < 2));
  assert.deepEqual(two, one);
  assert.deepEqual(await get(), one);
  assert.equal((await ws.error('GET', '/storyboards/' + b.id + '/takes/' + take + '/framing')).status, 400);
  const rotatedFile = path.join(ws.storage, 'rotation.mp4');
  const modern = execFileSync(getFfmpegPath(), ['-version'], { encoding: 'utf8' }).match(/ffmpeg version (\d+)/);
  if (modern && Number(modern[1]) < 6) ffmpeg(['-i', file, '-c', 'copy', '-metadata:s:v:0', 'rotate=90', rotatedFile]);
  else ffmpeg(['-display_rotation:v:0', '90', '-i', file, '-c', 'copy', rotatedFile]);
  fs.renameSync(path.join(ws.storage, 'rotation.mp4'), file);
  const rotated = await get();
  assert.equal(rotated.status, 'possible_bars');
  assert.equal(rotated.width, 160);
  assert.equal(rotated.height, 96);
  assert.deepEqual(rotated.rect, { w: 64, h: 96, x: 48, y: 0 });
  makeClip(ws, 'candidate.mp4');
  assert.equal((await get()).status, 'full_frame');
  makeClip(ws, 'candidate.mp4', { color: 'black' });
  assert.equal((await get()).status, 'inconclusive');
  makeClip(ws, 'candidate.mp4', { filter: 'fade=t=in:st=0:d=0.4' });
  assert.equal((await get()).status, 'full_frame');
  makeClip(ws, 'candidate.mp4', { filter: 'pad=96:160:0:48,drawbox=x=0:y=0:w=iw:h=ih:color=white:t=fill:enable=gte(t\\,1)' });
  assert.equal((await get()).status, 'inconclusive');
  fs.writeFileSync(file, '无效视频');
  assert.equal((await get()).status, 'unavailable');
  fs.unlinkSync(file);
  assert.equal((await get()).status, 'unavailable');
  assert.equal(ws.db.prepare('SELECT adopted_video_generation_id FROM storyboards WHERE id=?').get(a.id).adopted_video_generation_id, null);
});

test('measures final encoded audio and distinguishes silence, absent audio and short takes', async t => {
  const ws = await takeWorkspace(t);
  const stored = ws.db.prepare("INSERT INTO video_merges (episode_id,drama_id,status,merged_url,scenes) VALUES(?,?,'completed',?,?)");
  const sources = JSON.stringify([{ video_url: 'original.mp4' }]);
  const id = stored.run(ws.episodes[0].id, ws.id, 'mix.mov', sources).lastInsertRowid;
  const read = () => ws.request('GET', '/video-merges/' + id + '/loudness');
  makeClip(ws, 'mix.mov', { audio: 'sine=frequency=440:sample_rate=48000' });
  const first = await read();
  assert.equal(first.status, 'measured');
  assert.ok(first.integrated_lufs < -15 && first.integrated_lufs > -30 && first.peak_dbtp < 0, JSON.stringify(first));
  makeClip(ws, 'mix.mov', { audio: 'sine=frequency=440:sample_rate=48000,volume=0.25' });
  const quiet = await read();
  assert.ok(Math.abs(first.integrated_lufs - quiet.integrated_lufs - 12) < 0.4);
  assert.ok(Math.abs(first.peak_dbtp - quiet.peak_dbtp - 12) < 0.5);
  makeClip(ws, 'mix.mov', { audio: 'anullsrc=r=48000:cl=mono' });
  assert.equal((await read()).status, 'silent');
  makeClip(ws, 'mix.mov', { audio: 'sine=frequency=440:sample_rate=48000,volume=0.0009' });
  const gated = await read();
  assert.equal(gated.status, 'below_gate');
  assert.ok(Number.isFinite(gated.peak_dbtp));
  makeClip(ws, 'mix.mov');
  assert.equal((await read()).status, 'no_audio');
  makeClip(ws, 'mix.mov', { audio: 'sine=frequency=440', seconds: 0.2 });
  assert.equal((await read()).status, 'too_short');
  for (const reference of ['original.mp4', 'https://example.invalid/source.mp4', '../outside.mp4']) {
    ws.db.prepare('UPDATE video_merges SET merged_url=? WHERE id=?').run(reference, id);
    assert.equal((await read()).status, 'unavailable');
  }
  ws.db.prepare("UPDATE video_merges SET status='processing' WHERE id=?").run(id);
  assert.equal((await ws.error('GET', '/video-merges/'+id+'/loudness')).status, 409);
});

test('complete delivery exposes the encoded two-shot mix for measurement', async t => {
  const ws = await takeWorkspace(t);
  t.mock.method(require('../src/config'), 'loadConfig', () => ws.cfg);
  for (const shot of ws.shots.slice(0, 2)) {
    const name = 'shot-' + shot.id + '.mp4';
    ws.add(shot, name);
    makeClip(ws, name, { seconds: 1, audio: 'sine=frequency=600:sample_rate=48000' });
  }
  const job = await ws.request('POST', '/episodes/' + ws.episodes[0].id + '/finalize', { delivery_mode: 'complete' });
  const route = '/video-merges/' + job.merge_id;
  const deadline = Date.now() + 30000;
  let merge;
  do {
    merge = await ws.request('GET', route);
    if (merge.status === 'completed' || merge.status === 'failed') break;
    await new Promise(resolve => setTimeout(resolve, 50));
  } while (Date.now() < deadline);
  assert.equal(merge.status, 'completed', JSON.stringify(merge));
  assert.equal(merge.encoded_output, true);
  assert.equal(merge.delivery_mode, 'complete');
  const report = await ws.request('GET', route + '/loudness');
  assert.equal(report.status, 'measured', JSON.stringify(report));
});

test('a missing filter leaves review available and a retry can succeed', { skip: process.platform === 'win32' }, async t => {
  const ws = await takeWorkspace(t);
  const shot = ws.shots[0];
  const id = ws.add(shot, 'review.mp4');
  makeClip(ws, 'review.mp4');
  const route = '/storyboards/' + shot.id + '/takes/' + id + '/framing';
  const limited = path.join(ws.storage, 'ffmpeg-without-cropdetect');
  fs.writeFileSync(limited, "#!/bin/sh\necho 'No such filter: cropdetect' >&2\nexit 1\n", { mode: 0o700 });
  const original = process.env.FFMPEG_PATH;
  try {
    process.env.FFMPEG_PATH = limited;
    const result = await ws.request('GET', route);
    assert.equal(result.status, 'unavailable');
    assert.match(result.message, /滤镜/);
    const takes = await ws.request('GET', '/storyboards/' + shot.id + '/takes');
    assert.ok(takes.candidates.some(v => v.id === id));
  } finally {
    if (original === undefined) delete process.env.FFMPEG_PATH;
    else process.env.FFMPEG_PATH = original;
  }
  assert.equal((await ws.request('GET', route)).status, 'full_frame');
});
