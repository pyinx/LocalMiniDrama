const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { setTimeout: delay } = require('node:timers/promises');
const Database = require('better-sqlite3');
const { runMigrationsAndEnsure } = require('../src/db/migrate');
const { getFfmpegPath } = require('../src/utils/ffmpegPath');
const drama = require('../src/services/dramaService');
const merges = require('../src/services/videoMergeService');
const config = require('../src/config');
const log = { info() {}, warn() {}, error() {} };

test('preserves the last release on incomplete media', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'delivery-test-'));
  const db = new Database(':memory:');
  t.after(() => { db.close(); fs.rmSync(root, { recursive: true, force: true }); });
  runMigrationsAndEnsure(db);
  t.mock.method(config, 'loadConfig', () => ({ storage: { local_path: root } }));
  const project = drama.createDrama(db, log, { title: '春水' });
  drama.saveEpisodes(db, log, project.id, { episodes: [{ episode_number: 1, title: '渡口' }] });
  const ep = db.prepare('SELECT id FROM episodes').get().id;
  const shot = n => db.prepare("INSERT INTO storyboards (episode_id,storyboard_number,title,duration,created_at,updated_at) VALUES (?,?,?,5,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)").run(ep, n, '镜' + n).lastInsertRowid;
  const a = shot(1);
  const addClip = (id, file) => db.prepare("INSERT INTO video_generations (drama_id, storyboard_id, provider, prompt, status, local_path, created_at, updated_at) VALUES (?,?,'fixture','clip','completed',?,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)").run(project.id, id, file);
  execFileSync(getFfmpegPath(), ['-loglevel', 'error', '-f', 'lavfi', '-i', 'color=red:s=48x80:r=10:d=1', '-c:v', 'libx264', path.join(root, 'good.mp4')]);
  addClip(a, 'good.mp4');
  const finalize = (mode, body = {}) => drama.finalizeEpisode(db, log, ep, 'http://localhost:1/static', { delivery_mode: mode, ...body });
  const finish = async job => {
    for (let i = 0; i < 1000; i++) {
      const row = merges.getById(db, job.merge_id);
      if (['completed', 'failed'].includes(row.status)) return row;
      await delay(20);
    }
    assert.fail('合成超时');
  };
  const release = await finish(finalize('complete'));
  assert.equal(release.status, 'completed', release.error_msg);
  assert.equal(release.duration, 1);
  const published = () => db.prepare('SELECT video_url FROM episodes WHERE id=?').get(ep).video_url;
  assert.equal(published(), release.merged_url);
  const b = shot(2);
  assert.deepEqual(finalize('complete').missing_shots, [2]);
  const draft = finalize('draft');
  assert.deepEqual(draft.missing_shots, [2]);
  assert.equal((await finish(draft)).status, 'completed');
  assert.equal(published(), release.merged_url);
  assert.equal((await finish(finalize(undefined))).status, 'completed');
  assert.equal(published(), release.merged_url, '旧客户端的部分片段预览保留正式成片');
  fs.writeFileSync(path.join(root, 'bad.mp4'), 'broken');
  addClip(b, 'bad.mp4');
  const bad = await finish(finalize('complete'));
  assert.match(bad.error_msg, /春水.*第 2 镜/);
  assert.equal(published(), release.merged_url);
  db.prepare("UPDATE video_generations SET local_path='good.mp4' WHERE storyboard_id=?").run(b);
  db.prepare("UPDATE storyboards SET dialogue='船来了', audio_local_path='missing-dub.mp3' WHERE id=?").run(b);
  const draftResult = async options => {
    const job = finalize('draft', options);
    const row = await finish(job);
    assert.equal(row.status, 'completed', row.error_msg);
    assert.equal(published(), release.merged_url);
    return JSON.parse(db.prepare('SELECT result FROM async_tasks WHERE id=?').get(job.task_id).result);
  };
  const silent = await draftResult({ burn_dialogue_audio: true });
  assert.equal(silent.scenes_count, 2);
  assert.match(silent.warnings.join(' '), /第 2 镜缺少对白配音/);
  assert.match((await finish(finalize('complete', { burn_dialogue_audio: true }))).error_msg, /第 2 镜缺少对白/);
  db.prepare("UPDATE storyboards SET narration='水面泛起波纹' WHERE id=?").run(b);
  t.mock.method(require('../src/services/ttsService'), 'synthesize', async () => { throw new Error('旁白合成中断'); });
  const subtitle = await finish(finalize('complete', { burn_narration_subtitles: true }));
  assert.match(subtitle.error_msg, /第 2 镜.*旁白合成中断/);
  const preview = await draftResult({ burn_narration_subtitles: true, watermark_text: '试剪' });
  assert.match(preview.warnings.join(' '), /草稿使用后期处理前的合成片.*第 2 镜.*旁白合成中断/);
  assert.ok(fs.statSync(path.join(root, preview.video_url)).size > 0);
  assert.equal(published(), release.merged_url);
  const pending = finalize('complete');
  db.prepare("UPDATE video_generations SET local_path='other-take.mp4' WHERE storyboard_id=?").run(a);
  assert.match((await finish(pending)).error_msg, /变化/);
  assert.equal(published(), release.merged_url);
  assert.ok(fs.statSync(path.join(root, release.merged_url)).size > 0);
});

test('delivers rotation-matrix, square-pixel and anamorphic shots at their displayed aspect ratio', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'delivery-ratio-'));
  const db = new Database(':memory:');
  t.after(() => { db.close(); fs.rmSync(root, { recursive: true, force: true }); });
  runMigrationsAndEnsure(db);
  t.mock.method(config, 'loadConfig', () => ({ storage: { local_path: root } }));
  db.exec(`INSERT INTO dramas(id,title,metadata) VALUES(1,'试镜','{"aspect_ratio":"9:16"}');
    INSERT INTO episodes(id,drama_id,episode_number) VALUES(1,1,1);`);
  const ffmpeg = args => execFileSync(getFfmpegPath(), ['-v', 'error', ...args], { cwd: root });
  const make = (file, size, filter) => ffmpeg(['-f', 'lavfi', '-i', 'color=black:s=' + size + ':r=10:d=1',
    '-vf', filter, '-c:v', 'libx264', file]);
  make('sensor.mp4', '160x90', 'drawbox=0:0:80:90:red:t=fill');
  try {
    ffmpeg(['-display_rotation:v:0', '90', '-i', 'sensor.mp4', '-c', 'copy', 'rotated.mp4']);
  } catch {
    ffmpeg(['-y', '-i', 'sensor.mp4', '-c', 'copy', '-metadata:s:v:0', 'rotate=90', 'rotated.mp4']);
  }
  make('upright.mp4', '90x160', 'drawbox=0:0:90:80:blue:t=fill');
  make('anamorphic.mp4', '90x120', 'drawbox=0:0:45:120:green:t=fill,setsar=3/4');
  const clips = ['rotated.mp4', 'upright.mp4', 'anamorphic.mp4'];
  const add = (file, number) => db.prepare(`INSERT INTO storyboards(episode_id,storyboard_number,video_url)
    VALUES(1,?,?)`).run(number, '/static/' + file);
  async function release() {
    const job = drama.finalizeEpisode(db, log, 1, 'http://localhost:1/static', { delivery_mode: 'complete' });
    for (let i = 0; i < 1000; i++) {
      const row = merges.getById(db, job.merge_id);
      if (row.status === 'failed') assert.fail(row.error_msg);
      if (row.status === 'completed') return row.merged_url;
      await delay(20);
    }
    assert.fail('合成超时');
  }
  const frame = (file, seconds) => ffmpeg(['-ss', String(seconds), '-i', file, '-frames:v', '1', '-vf', 'scale=4:4',
    '-pix_fmt', 'rgb24', '-f', 'rawvideo', '-']);
  add(clips[0], 1);
  assert.deepEqual(frame(await release(), 0.2), frame(clips[0], 0.2));
  add(clips[1], 2);
  add(clips[2], 3);
  const movie = await release();
  for (const [i, clip] of clips.entries()) {
    const expected = frame(clip, 0.2);
    const output = frame(movie, i + 0.2);
    assert.equal(output.length, expected.length);
    assert.ok(output.every((byte, p) => Math.abs(byte - expected[p]) < 15), '第 ' + (i + 1) + ' 镜方向或构图改变');
  }
});
