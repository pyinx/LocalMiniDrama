const { test } = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const { setTimeout: delay } = require('node:timers/promises');
const fs = require('node:fs');
const path = require('node:path');
const { getFfmpegPath } = require('../src/utils/ffmpegPath');
const config = require('../src/config');
const { takeWorkspace } = require('./helpers/workbenchTakes');
const { sampleIr } = require('./helpers/segmentIrFixtures');

function ffmpeg(...args) {
  return execFileSync(getFfmpegPath(), ['-v', 'error', '-y', ...args], { maxBuffer: 16 * 1024 * 1024 });
}

async function deliver(ws, options = {}) {
  const episode = ws.episodes[0].id;
  const job = await ws.request('POST', `/episodes/${episode}/finalize`, { delivery_mode: 'complete', ...options });
  const deadline = Date.now() + 60000;
  while (Date.now() < deadline) {
    const response = await fetch(ws.url(`/video-merges/${job.merge_id}`), { headers: { Connection: 'close' } });
    assert.ok(response.ok);
    const { data: row } = await response.json();
    if (['completed', 'failed'].includes(row.status)) return row;
    await delay(50);
  }
  assert.fail('正式交付超时');
}

function decode(file) {
  return ffmpeg('-i', file, '-map', '0:a:0', '-ac', '1', '-ar', '8000', '-f', 's16le', '-');
}

// Measure each 40 ms output frame separately. The test tones have an integer number of cycles per frame.
function amplitude(pcm, frame, frequency) {
  let x = 0, y = 0;
  for (let i = 0; i < 320; i++) {
    const value = pcm.readInt16LE((frame * 320 + i) * 2);
    const phase = 2 * Math.PI * frequency * i / 8000;
    x += value * Math.cos(phase);
    y += value * Math.sin(phase);
  }
  return Math.hypot(x, y) / 160;
}

async function fixture(t) {
  const ws = await takeWorkspace(t);
  t.mock.method(config, 'loadConfig', () => ws.cfg);
  const boards = ws.shots.slice(0, 2);
  const sources = [
    ['red', 29, 'sin(2*PI*450*t)'],
    ['blue', 10, 'sin(2*PI*650*t)*between(t,0.80,1.20)+sin(2*PI*1000*t)*between(t,0.75,1.0357)'],
  ];
  for (const [i, [color, frame, audio]] of sources.entries()) {
    const name = `source-${i}.mp4`;
    const take = ws.add(boards[i], name);
    ffmpeg('-f', 'lavfi', '-i', `color=${color}:s=144x256:r=25:d=2`, '-f', 'lavfi', '-i',
      `aevalsrc='0.08*(${audio})':s=48000:d=2`, '-vf',
      `drawbox=c=${i ? 'yellow' : 'lime'}:t=fill:enable='eq(n,${frame})'`,
      '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', path.join(ws.storage, name));
    await ws.adopt(boards[i], take);
  }
  ffmpeg('-f', 'lavfi', '-i', 'sine=f=875:d=0.64', path.join(ws.storage, 'voice.wav'));
  await ws.request('PUT', `/storyboards/${boards[0].id}`, { audio_local_path: 'voice.wav', sound_source: 'dub' });
  await ws.request('PUT', `/storyboards/${boards[1].id}`, { sound_source: 'original' });
  const url = `/episodes/${ws.episodes[0].id}/edit`;
  const { revision, shots } = await ws.request('GET', url);
  await ws.request('PUT', url, { revision, action: 'trim', left: shots[0], right: shots[1], out_us: 1200000, in_us: 400000 });
  return ws;
}

function setIr(ws, i, ir) {
  ws.db.prepare('UPDATE storyboards SET segment_ir=? WHERE id=?').run(JSON.stringify(ir), ws.shots[i].id);
}

function mediaFile(ws, row) {
  assert.equal(row.status, 'completed', row.error_msg);
  return path.join(ws.storage, row.merged_url);
}

test('正式交付使用裁后对白、字卡和接缝帧，保留源片音乐并连续混入整集 BGM', async t => {
  const ws = await fixture(t);
  const ordinary = decode(mediaFile(ws, await deliver(ws)));
  const ids = { sceneId: 1, linId: 1, hrId: 2 };
  const first = sampleIr(ids);
  setIr(ws, 0, first);
  const second = sampleIr(ids, { cards: [{ text: 'CUT', at_s: 4, hold_s: 2 }] });
  second.shots[0].lines = [];
  second.shots[1].lines = [{ ...second.shots[1].lines[0], text: '走' }];
  setIr(ws, 1, second);
  ffmpeg('-f', 'lavfi', '-i', "aevalsrc='0.12*sin(2*PI*if(lt(t,1.4),300,350)*t)':s=48000:d=3", path.join(ws.storage, 'bgm.wav'));
  const row = await deliver(ws, { dialogue_subtitles: true, cards: true, review_sheets: true,
    burn_dialogue_audio: true, bgm: { url: '/static/bgm.wav', volume_db: -12 } });
  const file = mediaFile(ws, row);
  const dir = path.dirname(file);
  const pcm = decode(file);
  assert.equal(row.post_info.dialogue_track, false, '采用配音和原声后应沿用已选主声');
  // An additional copy at the same level would double the Fourier amplitude.
  const voice = amplitude(ordinary, 8, 875);
  assert.ok(voice > 1000);
  assert.ok(Math.abs(amplitude(pcm, 8, 875) / voice - 1) < 0.15);
  assert.ok(amplitude(pcm, 8, 450) < 65, '配音镜不应混回原声');
  for (let frame = 1; frame < 69; frame++) {
    const bgm = frame < 35 ? 300 : 350;
    assert.ok(amplitude(pcm, frame, bgm) > 300, `BGM 第 ${frame} 帧`);
    const music = amplitude(pcm, frame, 650);
    assert.ok(frame >= 40 && frame < 50 ? music > 600 : music < 150, `镜内音乐第 ${frame} 帧 ${music}`);
    const speech = amplitude(pcm, frame, 1000);
    if (frame >= 39 && frame < 45) assert.ok(speech > 600, `对白第 ${frame} 帧`);
    if (frame < 38 || frame > 46) assert.ok(speech < 150, `对白越界到第 ${frame} 帧`);
  }
  const srt = fs.readdirSync(dir).filter(name => name.endsWith('.srt'));
  const read = name => fs.readFileSync(path.join(dir, name), 'utf8');
  assert.match(read(srt.find(name => !name.endsWith('.cards.srt'))), /00:00:01,550 --> 00:00:01,836\s+走/);
  assert.match(read(srt.find(name => name.endsWith('.cards.srt'))), /00:00:01,800 --> 00:00:02,800\s+CUT/);
  assert.ok(row.post_info.warnings.some(w => w.code === 'estimated_dialogue_timing'));
  if (row.post_info.subtitles.burned) {
    const rgb = ffmpeg('-i', file, '-pix_fmt', 'rgb24', '-f', 'rawvideo', '-');
    const frameBytes = 144 * 256 * 3;
    assert.equal(rgb.length, 70 * frameBytes);
    function hasInk(frame, upper) {
      const start = frame * frameBytes + (upper ? 0 : frameBytes / 2);
      for (let i = start; i < start + frameBytes / 2; i += 3) {
        if (Math.min(rgb[i], rgb[i + 1], rgb[i + 2]) > 130) return true;
      }
      return false;
    }
    assert.deepEqual([38, 39, 44].map(frame => hasInk(frame, false)), [false, true, true]);
    assert.deepEqual([44, 45, 69].map(frame => hasInk(frame, true)), [false, true, true]);
  } else {
    assert.match(ffmpeg('-i', file, '-map', '0:s:0', '-f', 'srt', '-').toString(), /00:00:01,550 --> 00:00:01,836\s+走/);
    assert.match(ffmpeg('-i', file, '-map', '0:s:1', '-f', 'srt', '-').toString(), /00:00:01,800 --> 00:00:02,800\s+CUT/);
  }
  const seams = path.join(ws.storage, row.post_info.sheets.seams);
  const pixel = ffmpeg('-i', seams, '-vf', 'crop=480:8:0:0,scale=2:1:flags=area', '-pix_fmt', 'rgb24', '-frames:v', '1', '-f', 'rawvideo', '-');
  assert.ok(pixel[0] < 30 && pixel[1] > 210 && pixel[2] < 30, `接缝左侧应为第 29 帧的绿标 ${pixel}`);
  assert.ok(pixel[3] > 210 && pixel[4] > 210 && pixel[5] < 30, `接缝右侧应为第 10 帧的黄标 ${pixel}`);
  if (process.env.AC9_EVIDENCE_DIR) fs.cpSync(dir, process.env.AC9_EVIDENCE_DIR, { recursive: true });
});

test('逐句配音接替发声区间的主声，前后保留所选片段的原声', async t => {
  const ws = await fixture(t);
  const board = ws.shots[1];
  await ws.request('PUT', `/storyboards/${board.id}`, { sound_source: 'auto' });
  const ir = sampleIr({ sceneId: 1, linId: 1, hrId: 2 });
  ir.shots[0].lines = [];
  ir.shots[1].lines = [ir.shots[1].lines[0]];
  setIr(ws, 1, ir);
  // Only external speech synthesis is replaced. Mixing, encoding and HTTP delivery run normally.
  t.mock.method(require('../src/services/ttsService'), 'synthesize', async (_db, _log, request) => {
    ffmpeg('-f', 'lavfi', '-i', 'sine=f=1250:d=0.24', path.join(request.storage_base, 'speech.wav'));
    return { local_path: 'speech.wav' };
  });
  // The second shot keeps its entire head so a separate narration can cross the dialogue.
  const url = `/episodes/${ws.episodes[0].id}/edit`;
  const { revision, shots } = await ws.request('GET', url);
  await ws.request('PUT', url, { revision, action: 'trim', left: shots[0], right: shots[1], out_us: 1200000, in_us: 0 });
  ffmpeg('-f', 'lavfi', '-i', 'sine=f=1600:d=1.1', path.join(ws.storage, 'narration.wav'));
  await ws.request('PUT', `/storyboards/${board.id}`, { narration: '旁白', narration_audio_local_path: 'narration.wav' });
  const row = await deliver(ws, { burn_dialogue_audio: true, dialogue_subtitles: true, burn_narration_subtitles: true });
  const pcm = decode(mediaFile(ws, row));
  assert.equal(row.post_info.dialogue_track, true);
  for (let frame = 50; frame <= 53; frame++) {
    assert.ok(amplitude(pcm, frame, 1250) > 600, '缺少采用的逐句配音');
    assert.ok(amplitude(pcm, frame, 1000) < 120, '原对白和逐句配音同时可听');
    assert.ok(amplitude(pcm, frame, 1600) > 600, '独立旁白不应随原对白静音');
  }
  assert.ok(amplitude(pcm, 58, 650) > 600, '逐句配音结束后仍应保留片段原声');
});

test('结构化资料损坏或 BGM 缺失时，正式交付点明缺项并保留上次成片', async t => {
  const ws = await fixture(t);
  const previous = await deliver(ws);
  mediaFile(ws, previous);
  const ir = sampleIr({ sceneId: 1, linId: 1, hrId: 2 });
  for (const [input, options, error] of [
    [{ ...ir, version: 9 }, { cards: true }, /第 2 镜.*结构化分镜/],
    [ir, { bgm: { url: '/static/missing.wav' } }, /BGM.*missing\.wav/],
  ]) {
    setIr(ws, 1, input);
    const job = await deliver(ws, options);
    assert.equal(job.status, 'failed');
    assert.match(job.error_msg, error);
    assert.equal(ws.db.prepare('SELECT video_url FROM episodes WHERE id=?').get(ws.episodes[0].id).video_url, previous.merged_url);
  }
});

test('正式交付要求实配逐句对白完整且原速', async t => {
  const ws = await fixture(t);
  const board = ws.shots[0];
  await ws.request('PUT', `/storyboards/${board.id}`, { sound_source: 'auto', audio_local_path: '' });
  const ir = sampleIr({ sceneId: 1, linId: 1, hrId: 2 });
  ir.shots[0].lines = [ir.shots[0].lines[0]];
  ir.shots[1].lines = [];
  let duration;
  t.mock.method(require('../src/services/ttsService'), 'synthesize', async (_db, _log, request) => {
    ffmpeg('-f', 'lavfi', '-i', `sine=f=1250:d=${duration}`, path.join(request.storage_base, 'speech.wav'));
    return { local_path: 'speech.wav' };
  });
  const url = `/episodes/${ws.episodes[0].id}/edit`;
  for (const [cut, seconds, shotSeconds] of [[1, 1.6, 8], [2, 1.2, 4]]) {
    duration = seconds;
    ir.shots[0].seconds = shotSeconds;
    ir.shots = shotSeconds === 8 ? [ir.shots[0]] : [ir.shots[0], { ...ir.shots[0], seconds: 8 - shotSeconds, lines: [] }];
    setIr(ws, 0, ir);
    const { revision, shots } = await ws.request('GET', url);
    await ws.request('PUT', url, { revision, action: cut === 2 ? 'restore' : 'trim', left: shots[0], right: shots[1], out_us: cut * 1000000, in_us: 0 });
    const row = await deliver(ws, { burn_dialogue_audio: true });
    assert.equal(row.status, 'failed', `原声长 ${seconds}s，镜头窗口 ${cut === 2 ? 1 : cut}s`);
    assert.match(row.error_msg, /逐句配音.*(剪点|可用时长)/);
    if (cut === 1) {
      const state = await ws.request('GET', url + '?burn_dialogue_audio=true');
      const job = await ws.request('POST', url + '/audition', { revision: state.revision, action: 'trim',
        left: state.shots[0], right: state.shots[1], out_us: 1000000, in_us: 0, burn_dialogue_audio: true });
      const deadline = Date.now() + 60000;
      let task;
      do {
        task = await ws.request('GET', `/tasks/${job.task_id}`);
        if (['completed', 'failed'].includes(task.status)) break;
        await delay(50);
      } while (Date.now() < deadline);
      assert.equal(task.status, 'failed', '试听也必须保护逐句对白');
      assert.match(task.error, /逐句配音.*剪点/);
      const draft = await deliver(ws, { delivery_mode: 'draft', burn_dialogue_audio: true });
      const pcm = decode(mediaFile(ws, draft));
      assert.ok(amplitude(pcm, 8, 450) > 600, '普通草稿应回退至第一镜原声');
      assert.ok(amplitude(pcm, 8, 1250) < 120);
      const result = await ws.request('GET', `/tasks/${draft.task_id}`);
      const warnings = (typeof result.result === 'string' ? JSON.parse(result.result) : result.result).warnings;
      assert.match(warnings.join('；'), /逐句配音.*剪点/);
    }
  }
});
