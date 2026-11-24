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

function resolutionTier(resolution) {
  const match = String(resolution || '').trim().toLowerCase().match(/^(\d{3,4})p?$/);
  return match ? Number(match[1]) : null;
}

// Starting values, not calibrated: a fade or a held close-up trips them, so the scan only
// records intervals for the reviewer and never feeds eligibility (see `anomalies` below).
const BLACK_MIN_S = 0.5;
const FREEZE_MIN_S = 1.0;
const ANOMALY_MAX_ITEMS = 20;
const SCAN_TIMEOUT_MS = 30000;

const round3 = n => Math.round(n * 1000) / 1000;

// freezedetect prints only freeze_start when the picture is still frozen at the end of the
// stream, so an open interval is closed at the clip's end.
// Only lines the filters themselves print count: the log also echoes the clip's own metadata,
// which is untrusted and could spell out a detection.
function parseAnomalies(log, duration) {
  const items = [];
  for (const m of log.matchAll(/^\[Parsed_blackdetect_\d+ @ [^\]]*\]\s*black_start:([\d.]+)\s+black_end:([\d.]+)\s+black_duration:([\d.]+)/gm)) {
    items.push({ kind: 'black', start_s: round3(Number(m[1])), end_s: round3(Number(m[2])), duration_s: round3(Number(m[3])) });
  }
  let open = null;
  for (const m of log.matchAll(/^\[Parsed_freezedetect_\d+ @ [^\]]*\]\s*lavfi\.freezedetect\.freeze_(start|end):\s*([\d.]+)/gm)) {
    const at = Number(m[2]);
    if (m[1] === 'start') open = at;
    else if (open != null) {
      items.push({ kind: 'frozen', start_s: round3(open), end_s: round3(at), duration_s: round3(at - open) });
      open = null;
    }
  }
  if (open != null && duration > open) {
    items.push({ kind: 'frozen', start_s: round3(open), end_s: round3(duration), duration_s: round3(duration - open) });
  }
  const long = items.filter(i => i.duration_s >= (i.kind === 'black' ? BLACK_MIN_S : FREEZE_MIN_S));
  // A black screen is also a frozen one; report it once, as black.
  const blacks = long.filter(i => i.kind === 'black');
  const slack = 0.1;
  return long.filter(i => i.kind === 'black' || !blacks.some(b => i.start_s >= b.start_s - slack && i.end_s <= b.end_s + slack))
    .sort((a, b) => a.start_s - b.start_s).slice(0, ANOMALY_MAX_ITEMS);
}

// Never throws: a failed scan must not fail the take or touch its spec check.
async function scanAnomalies(file, stream, duration) {
  const checkedAt = new Date().toISOString();
  try {
    const filter = `blackdetect=d=${BLACK_MIN_S}:pix_th=0.10,freezedetect=n=-60dB:d=${FREEZE_MIN_S}`;
    const { stderr } = await execFile(getFfmpegPath(), ['-nostdin', '-hide_banner', '-nostats', '-v', 'info', ...localInput,
      '-i', file, '-map', '0:' + stream.index, '-an', '-vf', filter, '-f', 'null', '-'],
      { timeout: SCAN_TIMEOUT_MS, maxBuffer: 1024 * 1024, windowsHide: true });
    const items = parseAnomalies(stderr, duration);
    return { status: items.length ? 'flagged' : 'passed', checked_at: checkedAt, items };
  } catch (err) {
    const message = err.code === 'ENOENT' ? '缺少 FFmpeg' :
      /No such filter|Option not found|Filter not found/i.test(err.stderr || '') ? '当前 FFmpeg 缺少黑屏或冻结检测滤镜' :
      err.killed ? '画面扫描超时' : '无法解码视频以扫描画面';
    return { status: 'unavailable', checked_at: checkedAt, items: [], message };
  }
}

// Inspect the provider's downloaded source before any canvas normalization. The spec check
// deliberately measures metadata only: a padded derivative must not hide the dimensions or
// duration the provider actually returned. `anomalies` is a separate, advisory record.
async function inspectGeneratedTake(file, expected = {}) {
  try {
    const media = await probe(file);
    const stream = media.streams.find(s => s.codec_type === 'video' && !s.disposition?.attached_pic);
    const width = Number(stream?.width) || null;
    const height = Number(stream?.height) || null;
    const duration = Number(stream?.duration) || Number(media.format?.duration) || null;
    if (!stream || !width || !height || !Number.isFinite(duration) || duration <= 0) {
      const message = '原始视频尺寸或时长不可读取';
      return { status: 'unavailable', checked_at: new Date().toISOString(), issues: [], anomalies: { status: 'unavailable', items: [], message }, message };
    }
    const rotation = Number(stream.side_data_list?.find(s => s.rotation != null)?.rotation ?? stream.tags?.rotate ?? 0);
    const sideways = Math.abs(rotation % 180) === 90;
    const actualWidth = sideways ? height : width;
    const actualHeight = sideways ? width : height;
    const actual = { width: actualWidth, height: actualHeight, duration, aspect_ratio: actualWidth / actualHeight,
      has_audio: media.streams.some(s => s.codec_type === 'audio') };
    const issues = [];
    const expectedDuration = Number(expected.duration);
    // Tolerate container/frame rounding, not a provider snapping the request to a shorter preset.
    if (Number.isFinite(expectedDuration) && expectedDuration > 0 && duration + 0.25 < expectedDuration) {
      issues.push({ code: 'duration_short', expected: expectedDuration, actual: duration, message: `时长不足：期望 ${expectedDuration}s，实际 ${duration.toFixed(2)}s` });
    }
    const ratio = String(expected.aspect_ratio || '').match(/^(\d+(?:\.\d+)?)\s*:\s*(\d+(?:\.\d+)?)$/);
    if (ratio) {
      const wanted = Number(ratio[1]) / Number(ratio[2]);
      if (Math.abs(actual.aspect_ratio / wanted - 1) > 0.03) {
        issues.push({ code: 'aspect_ratio_mismatch', expected: expected.aspect_ratio, actual: `${actualWidth}:${actualHeight}`, message: `画幅不符：期望 ${expected.aspect_ratio}，原片为 ${actualWidth}×${actualHeight}` });
      }
    }
    const pixels = resolutionTier(expected.resolution);
    const sourceTier = resolutionTier(expected.source_resolution);
    const belowDimensions = expected.resolution_by_area
      ? actualWidth * actualHeight < pixels * pixels * (16 / 9) * 0.9
      : Math.min(actualWidth, actualHeight) < pixels * 0.95;
    if (sourceTier) actual.source_resolution = `${sourceTier}P`;
    if (pixels && (belowDimensions || (sourceTier && sourceTier < pixels))) {
      const sourceLabel = `${actualWidth}×${actualHeight}${sourceTier ? `（厂商报告 ${sourceTier}P）` : ''}`;
      issues.push({ code: 'resolution_low', expected: expected.resolution, actual: `${actualWidth}x${actualHeight}`, message: `分辨率不足：期望 ${expected.resolution}，原片为 ${sourceLabel}` });
    }
    if (expected.require_audio === true && !actual.has_audio) {
      issues.push({ code: 'audio_missing', message: '原片缺少要求的音轨' });
    }
    if (ratio && expected.resolution_by_area && !issues.some(issue => issue.code === 'aspect_ratio_mismatch')) {
      // A stable, large inset can be a horizontal video packaged in a vertical canvas.
      // An unreadable or changing dark scene is insufficient evidence to reject the take.
      const sample = await framing(file, media).catch(() => null);
      const rect = sample?.rect;
      if (sample?.status === 'possible_bars' && rect.w * rect.h < 0.75 * sample.width * sample.height &&
          Math.abs((rect.w / rect.h) / (Number(ratio[1]) / Number(ratio[2])) - 1) > 0.15) {
        issues.push({ code: 'content_aspect_ratio_mismatch', expected: expected.aspect_ratio, actual: `${rect.w}x${rect.h}`,
          message: `有效画面画幅不符：期望 ${expected.aspect_ratio}，多处采样的有效画面约为 ${rect.w}×${rect.h}` });
      }
    }
    const anomalies = await scanAnomalies(file, stream, duration);
    return { status: issues.length ? 'failed' : 'passed', checked_at: new Date().toISOString(), ...actual, issues, anomalies };
  } catch (err) {
    const message = err.code === 'ENOENT' ? '缺少 FFmpeg 或 ffprobe' : '无法读取原始视频信息';
    return { status: 'unavailable', checked_at: new Date().toISOString(), issues: [], anomalies: { status: 'unavailable', items: [], message }, message };
  }
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

module.exports = { createDiagnostics, inspectGeneratedTake };
