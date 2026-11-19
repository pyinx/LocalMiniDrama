const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { hasLocalFfmpeg, getFfmpegPath, getFfprobePath } = require('../../src/utils/ffmpegPath');

const ffmpegSkip = hasLocalFfmpeg() ? false : '本机没有 ffmpeg，跳过需要真实编码的成片测试';

function ff(args) {
  const r = spawnSync(getFfmpegPath(), ['-y', '-hide_banner', '-loglevel', 'error', ...args], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error('ffmpeg failed: ' + r.stderr);
}

/** 生成测试片段：toneDb 为 null 时音轨静音 */
function makeClip(file, seconds, toneDb, freq = 440, color = 'blue') {
  const audio = toneDb == null ? ['-f', 'lavfi', '-i', `anullsrc=r=44100:cl=stereo:d=${seconds}`] : ['-f', 'lavfi', '-i', `sine=f=${freq}:d=${seconds}:sample_rate=44100`];
  ff(['-f', 'lavfi', '-i', `color=c=${color}:s=320x568:d=${seconds}:r=24`, ...audio,
    ...(toneDb == null ? [] : ['-af', `volume=${toneDb}dB,aformat=channel_layouts=stereo`]),
    '-shortest', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', file]);
  return file;
}

function makeTone(file, seconds, freq = 220, db = 0) {
  ff(['-f', 'lavfi', '-i', `sine=f=${freq}:d=${seconds}:sample_rate=44100`, '-af', `volume=${db}dB,aformat=channel_layouts=stereo`, file]);
  return file;
}

function concat(files, out) {
  const list = out + '.txt';
  fs.writeFileSync(list, files.map((f) => `file '${f}'`).join('\n'));
  ff(['-f', 'concat', '-safe', '0', '-i', list, '-c', 'copy', out]);
  return out;
}

/** 某时间段的平均音量（dB） */
function meanVolume(file, from, dur) {
  const r = spawnSync(getFfmpegPath(), ['-hide_banner', '-ss', String(from), '-t', String(dur), '-i', file, '-af', 'volumedetect', '-f', 'null', '-'], { encoding: 'utf8' });
  const m = String(r.stderr).match(/mean_volume:\s*(-?[\d.]+|-inf) dB/);
  return m ? (m[1] === '-inf' ? -120 : Number(m[1])) : null;
}

function streams(file) {
  const r = spawnSync(getFfprobePath(), ['-v', 'error', '-show_entries', 'stream=codec_type,codec_name', '-of', 'json', file], { encoding: 'utf8' });
  return JSON.parse(r.stdout).streams;
}

function tmpStorage() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'lmd-post-test-'));
}

module.exports = { ffmpegSkip, makeClip, makeTone, concat, meanVolume, streams, tmpStorage };
