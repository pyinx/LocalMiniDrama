const path = require('path');
const fs = require('fs');
const execFile = require('util').promisify(require('child_process').execFile);
const { getFfmpegPath, getFfprobePath } = require('../utils/ffmpegPath');
const { localFile } = require('./workbenchTakeService');
const { mediaDigest } = require('./episodeSound');

async function speechSeconds(file, limit) {
  const { stdout } = await execFile(getFfmpegPath(), ['-v','error','-xerror','-i',file,'-map','0:a:0','-t',String(limit + 0.05),
    '-ar','8000','-ac','1','-f','s16le','-'], { encoding:'buffer', maxBuffer: Math.ceil((limit + 2) * 16000) });
  if (!stdout.length) throw new Error('声音文件缺少有效样本');
  return stdout.length / 16000;
}

async function selectedDub(shot, options, root, seconds) {
  const selected = shot.sound?.selected;
  const relative = selected ? selected.path : shot.sound?.audio_local_path;
  if (selected ? selected.source !== 'dub' : !options.burn_dialogue_audio || !relative) return null;
  const file = localFile(root, relative);
  if (!file || (selected && mediaDigest(file) !== selected.sha256)) throw new Error('缺少对白配音或配音内容已变化');
  if (await speechSeconds(file,seconds) > seconds + 0.002) throw new Error('对白配音超过镜头可用时长，请调整配音或镜头');
  return file;
}

async function validateSpeechRange(shot, row, options, root) {
  if (row.in_us === 0 && row.out_us === row.duration_us) return;
  const sound = shot.sound;
  const selected = sound.selected;
  const relative = selected ? selected.source === 'dub' && selected.path : options.burn_dialogue_audio && sound.audio_local_path;
  const sources = [relative, options.burn_narration_subtitles && sound.narration && sound.narration_audio_local_path];
  for (const rel of sources.filter(Boolean)) {
    const file = localFile(root, rel);
    if (!file || row.in_us > 0 || await speechSeconds(file,row.out_us / 1e6) > row.out_us / 1e6 + 0.002) {
      throw new Error('第 ' + row.number + ' 镜的剪点会截断选用的声音，请调整剪点或配音');
    }
  }
}

async function frameStart(file, micros) {
  if (!micros) return 0;
  const { stdout } = await execFile(getFfprobePath(), ['-v','error','-select_streams','v:0','-show_entries',
    'frame=best_effort_timestamp_time','-of','json',file],{maxBuffer:32*1024*1024});
  const pts = JSON.parse(stdout).frames.map(f => Number(f.best_effort_timestamp_time)).filter(Number.isFinite);
  if (!pts.length) throw new Error('无法定位源画面');
  let start = 0;
  for (const value of pts) {
    const time = Math.round((value - pts[0]) * 1e6);
    if (time > micros) break;
    start = time;
  }
  return start / 1e6;
}

async function renderDeliveryShots(parts, first, options, root, temp, output, warnings) {
  const commonVideo = parts.every(p => p.info.layout === first.layout && p.info.encoding === first.encoding);
  const copyVideo = !parts.some(p => p.range) && commonVideo && ['h264','hevc'].includes(first.codec);
  const width = Math.ceil(first.width / 2) * 2;
  const height = Math.ceil(first.height / 2) * 2;
  const list = [];
  for (const [index, { file, shot, info, range }] of parts.entries()) {
    const label = '第 ' + (shot.storyboard_number ?? shot.scene_id) + ' 镜';
    let dub;
    try {
      if (range) await validateSpeechRange(shot,range, {...options,burn_narration_subtitles:false},root);
      dub = await selectedDub(shot, options, root, info.seconds);
    }
    catch (err) {
      const message = label + (err.message.includes('配音') ? err.message : '对白配音无法解码或超过镜头时长');
      if (options.delivery_mode !== 'draft') throw new Error(message);
      warnings.push(message + '，草稿使用本镜原声或静音');
    }
    const args = ['-v','error','-i',file];
    let audio = '0:a:0';
    if (dub) {
      args.push('-i', dub);
      audio = '1:a:0';
    } else if (!info.hasAudio || shot.sound?.selected?.source === 'mute') {
      args.push('-f','lavfi','-i','anullsrc=r=48000:cl=stereo');
      audio = '1:a:0';
    }
    args.push('-map','0:v:0','-map',audio);
    if (copyVideo) args.push('-c:v','copy');
    else {
      const filters = [];
      if (range) {
        const start = await frameStart(file,range.in_us);
        filters.push('setpts=PTS-STARTPTS','trim=start=' + start + ':end=' + range.out_us / 1e6,
          'setpts=PTS-' + range.in_us + '/1000000/TB',
          'tpad=stop_mode=clone:stop_duration=1','fps=' + range.fps + ':start_time=0:round=up',
          'trim=end_frame=' + range.frames);
      }
      const fittedW = Math.max(2,2*Math.round(width * Math.min(1,info.ratio/first.ratio)/2));
      const fittedH = Math.max(2,2*Math.round(height * Math.min(1,first.ratio/info.ratio)/2));
      filters.push('scale=' + fittedW + ':' + fittedH, 'setsar=' + first.ratio * height / width + ':max=10000');
      if (fittedW !== width || fittedH !== height) filters.push('pad=' + width + ':' + height + ':(ow-iw)/2:(oh-ih)/2');
      args.push('-vf',filters.join(','),'-c:v','libx264','-bf','0','-pix_fmt','yuv420p','-preset','veryfast','-crf','18');
    }
    const name = 'segment-' + index + '.mov';
    // PCM intermediates avoid adding AAC encoder delay at every cut.
    const af = ['aresample=48000:async=1:first_pts=0'];
    if (range) af.push('atrim=start=' + range.in_us / 1e6 + ':end=' + range.out_us / 1e6,'asetpts=PTS-STARTPTS');
    af.push('apad');
    args.push('-af',af.join(','),'-ar','48000','-ac','2','-c:a','pcm_s16le',
      '-t',String(shot.duration),'-video_track_timescale','90000',path.join(temp, name));
    await execFile(getFfmpegPath(), args).catch(err => { throw new Error(label + '合成失败：' + (err.stderr || err.message)); });
    list.push("file '" + name + "'", 'duration ' + shot.duration);
  }
  const manifest = path.join(temp,'segments.ffconcat');
  fs.writeFileSync(manifest, list.join('\n') + '\n');
  await execFile(getFfmpegPath(), ['-v','error','-f','concat','-safe','1','-i',manifest,'-map','0:v:0','-map','0:a:0',
    '-c:v','copy','-c:a','aac','-b:a','192k','-movflags','+faststart',output]);
}

module.exports = { renderDeliveryShots, validateSpeechRange, speechSeconds };
