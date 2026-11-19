'use strict';

const fs = require('node:fs');
const { promisify } = require('node:util');
const execFile = promisify(require('node:child_process').execFile);
const { getFfmpegPath, getFfprobePath } = require('../utils/ffmpegPath');
const takes = require('./workbenchTakeService');
const merges = require('./videoMergeService');

const localInput = ['-protocol_whitelist', 'file,pipe', '-format_whitelist', 'mov,matroska,webm,avi,mpegts,mpeg,flv,ogg,asf,mxf'];
const unavailable = message => ({ status: 'unavailable', message });

async function probe(file) {
  // Older bundled ffprobe versions expose rotation in the full stream report.
  const { stdout } = await execFile(getFfprobePath(), ['-v', 'error', ...localInput,
    '-show_streams', '-show_format', '-of', 'json', file], { timeout: 20000, windowsHide: true });
  return JSON.parse(stdout);
}

function near(a, b, width, height) {
  return a && b && Math.abs(a.x - b.x) <= Math.max(2, width * 0.01) &&
    Math.abs(a.y - b.y) <= Math.max(2, height * 0.01) &&
    Math.abs(a.w - b.w) <= Math.max(2, width * 0.01) && Math.abs(a.h - b.h) <= Math.max(2, height * 0.01);
}

async function cropWindow(file, stream, width, height, start, length) {
  const filter = 'format=yuv420p,signalstats,cropdetect=limit=24:round=2:skip=0:reset_count=1,metadata=mode=print:file=-';
  const { stdout } = await execFile(getFfmpegPath(), ['-nostdin', '-v', 'error', ...localInput, '-ss', String(start),
    '-i', file, '-t', String(length), '-map', '0:' + stream.index, '-an', '-vf', filter, '-frames:v', '48', '-f', 'null', '-'],
    { timeout: 25000, maxBuffer: 512 * 1024, windowsHide: true });
  const frames = [];
  for (const block of stdout.split(/^frame:/m).slice(1)) {
    const seconds = Number(/pts_time:([\d.e+-]+)/.exec(block)?.[1]);
    if (!Number.isFinite(seconds) || seconds < 0 || seconds >= length) continue;
    const high = Number(/lavfi\.signalstats\.YHIGH=(\d+)/.exec(block)?.[1]);
    if (!(high >= 40)) continue;
    const rect = {};
    for (const match of block.matchAll(/lavfi\.cropdetect\.([xywh])=(-?\d+)/g)) rect[match[1]] = Number(match[2]);
    if (rect.x >= 0 && rect.y >= 0 && rect.w > 0 && rect.h > 0 && rect.x + rect.w <= width && rect.y + rect.h <= height) {
      frames.push({ rect, seconds: start + seconds });
    }
  }
  const middle = frames[Math.floor(frames.length / 2)];
  if (!middle) return { seconds: start, state: 'low_evidence' };
  if (!frames.every(frame => near(frame.rect, middle.rect, width, height))) return { seconds: middle.seconds, state: 'variable' };
  return { seconds: middle.seconds, state: 'readable', rect: middle.rect };
}

async function framing(file, media) {
  const video = media.streams.find(s => s.codec_type === 'video' && !s.disposition?.attached_pic);
  const duration = Number(video?.duration) || Number(media.format.duration);
  if (!video || !video.width || !video.height || !Number.isFinite(duration) || duration <= 0) return unavailable('缺少可读取的视频尺寸或时长');
  const angle = Number(video.side_data_list?.find(s => s.rotation != null)?.rotation ?? video.tags?.rotate ?? 0);
  const rotation = ((angle % 360) + 360) % 360;
  if (rotation % 90 !== 0) return unavailable('视频使用非直角旋转，请在播放器中复核');
  const sideways = rotation === 90 || rotation === 270;
  const width = sideways ? video.height : video.width;
  const height = sideways ? video.width : video.height;
  const samples = [];
  const length = Math.min(0.8, duration * 0.15);
  for (const fraction of [0.04, 0.24, 0.44, 0.64, 0.84]) {
    samples.push(await cropWindow(file, video, width, height, duration * fraction, length));
  }
  const good = samples.filter(s => s.rect);
  const info = { width, height, encoded_width: video.width, encoded_height: video.height, rotation, samples };
  if (good.length < 3 || samples.some(s => s.state === 'variable') || !good.every(s => near(s.rect, good[0].rect, width, height))) {
    return { ...info, status: 'inconclusive', message: '暗场、短片或画幅变化使采样不足以判断，请按时间点回看' };
  }
  const rect = good[Math.floor(good.length / 2)].rect;
  const full = near(rect, { x: 0, y: 0, w: width, h: height }, width, height);
  return { ...info, rect, status: full ? 'full_frame' : 'possible_bars',
    message: full ? '可判读的采样均铺满画面' : '多处采样出现相同暗边，请回看是否为有意遮幅' };
}

async function loudness(file, media) {
  const audio = media.streams.filter(s => s.codec_type === 'audio');
  const track = audio.find(s => s.disposition?.default) || audio[0];
  if (!track) return { status: 'no_audio', message: '成片没有音轨' };
  const duration = Number(track.duration) || Number(media.format.duration);
  if (duration > 0 && duration < 0.4) return { status: 'too_short', message: '音轨不足 0.4 秒，无法测量综合响度' };
  const { stderr } = await execFile(getFfmpegPath(), ['-nostdin', '-hide_banner', '-nostats', '-v', 'info', ...localInput,
    '-i', file, '-map', '0:' + track.index, '-vn', '-af', 'loudnorm=print_format=json', '-f', 'null', '-'],
    { timeout: 480000, maxBuffer: 1024 * 1024, windowsHide: true });
  const block = /\{\s*"input_i"[\s\S]*?\}/.exec(stderr);
  if (!block) return unavailable('工具没有返回响度读数');
  const { input_i, input_tp } = JSON.parse(block[0]);
  if (typeof input_i !== 'string' || !input_i.trim() || typeof input_tp !== 'string' || !input_tp.trim()) return unavailable('工具返回了不完整的响度读数');
  if (String(input_tp).toLowerCase() === '-inf') return { status: 'silent', message: '音轨为静音' };
  const peak = Number(input_tp);
  if (!Number.isFinite(peak)) return unavailable('无法测量真峰值');
  const integrated = Number(input_i);
  if (input_i.toLowerCase() === '-inf') return { status: 'below_gate', peak_dbtp: peak, message: '音频低于综合响度测量门限' };
  if (!Number.isFinite(integrated)) return unavailable('无法测量综合响度');
  return { status: 'measured', integrated_lufs: integrated, peak_dbtp: peak, audio_stream: track.index };
}

function fingerprint(file) {
  if (!file) return null;
  try {
    const s = fs.statSync(file, { bigint: true });
    return JSON.stringify([file, ...[s.dev, s.ino, s.size, s.mtimeNs, s.ctimeNs].map(String)]);
  } catch { return null; }
}

function createDiagnostics(db, cfg) {
  const root = cfg?.storage?.local_path || './data/storage';
  const cache = new Map();
  const active = new Map();

  async function measure(kind, id, locate, analyze) {
    const file = locate();
    const stamp = fingerprint(file);
    const result = data => ({ ...data, id: Number(id), checked_at: new Date().toISOString() });
    if (!stamp) return result(unavailable('没有可检测的本地媒体文件，请查看或重新导入原片'));
    const key = JSON.stringify([kind, id, stamp]);
    if (cache.has(key)) return cache.get(key);
    if (active.has(key)) return active.get(key);
    if (active.size >= 2) return result(unavailable('其他媒体正在检测，请稍后重试'));
    const job = (async () => {
      try {
        const data = await analyze(file, await probe(file));
        if (fingerprint(locate()) !== stamp) return result(unavailable('检测期间媒体发生变化，请重新检测'));
        const record = result(data);
        if (data.status !== 'unavailable') {
          if (cache.size >= 64) cache.delete(cache.keys().next().value);
          cache.set(key, record);
        }
        return record;
      } catch (err) {
        if (err.status) throw err;
        const message = err.code === 'ENOENT' ? '缺少 FFmpeg 或 ffprobe' :
          /No such filter|Option not found|Filter not found/i.test(err.stderr || '') ? '当前 FFmpeg 缺少所需滤镜或选项' :
          err.killed ? '检测超时，请人工复核' : '无法解码文件或读取检测结果，请人工复核';
        return result(unavailable(message));
      } finally { active.delete(key); }
    })();
    active.set(key, job);
    return job;
  }

  return {
    take(boardId, takeId) {
      return measure('framing', Number(takeId), () => {
        const row = takes.take(db, boardId, takeId);
        return takes.localFile(root, takes.publicMedia(row).local_path);
      }, framing);
    },
    merge(mergeId) {
      return measure('loudness', Number(mergeId), () => {
        const row = merges.getById(db, mergeId);
        if (!row) takes.fail('导出记录不存在', 404);
        if (row.status !== 'completed') takes.fail('导出尚未完成', 409);
        if (!row.encoded_output) return null;
        return takes.localFile(root, row.merged_url.replace(/^\/static\//, ''));
      }, loudness);
    },
  };
}

module.exports = { createDiagnostics };
