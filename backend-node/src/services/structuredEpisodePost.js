/**
 * 结构化剧集的成片后期：保留片段原音轨（含模型原生人声），按需混入逐句台词轨与 BGM（压在台词下面）；
 * 由 IR 生成台词字幕与字卡（能烧就烧，ffmpeg 没有 subtitles 滤镜时改为软字幕并说明原因）；
 * 输出接缝拼图与每秒抽帧拼图供审片。
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { parseSegmentIr } = require('./segmentIr/schema');
const { buildTimeline, planDialogueLines, estimatedLineSeconds, buildDialogueSrt, buildCardsSrt } = require('./episodeSubtitles');
const { buildDialogueTrack } = require('./dialogueTtsService');
const { ffprobeDurationSec, ffprobeHasAudio, runFfmpeg, escapeFfmpegPath, runMergedEpisodePostProcess } = require('./mergedEpisodePostProcess');
const { probeFfmpegFilters } = require('../utils/ffmpegPath');
const { toLocalPath } = require('../utils/storagePaths');

const DEFAULT_BGM_DB = -18;

/** 本集是否走结构化后期：参与合成的分镜里有任意一条结构化分镜 */
function isStructuredEpisode(db, scenes) {
  return scenes.some((sc) => {
    const r = db.prepare('SELECT segment_ir FROM storyboards WHERE id = ? AND deleted_at IS NULL').get(Number(sc.scene_id));
    return !!(r && r.segment_ir);
  });
}

/** 片段是否由原生人声模型生成：优先读取实际采用版本，兼容没有版本身份的旧任务 */
function segmentIsNative(db, storyboardId, takeId) {
  const g = db
    .prepare("SELECT compiled_json FROM video_generations WHERE storyboard_id = ? AND status = 'completed' AND deleted_at IS NULL AND (? IS NULL OR id = ?) ORDER BY id DESC LIMIT 1")
    .get(storyboardId, takeId ?? null, takeId ?? null);
  try {
    return !!(g && g.compiled_json && JSON.parse(g.compiled_json).request.generate_audio);
  } catch (_) {
    return false;
  }
}

function loadSegments(db, scenes, complete) {
  return scenes.map((sc) => {
    const sbId = Number(sc.scene_id);
    const row = db.prepare('SELECT segment_ir FROM storyboards WHERE id = ?').get(sbId);
    const parsed = row && row.segment_ir ? parseSegmentIr(row.segment_ir) : null;
    if (complete && parsed && !parsed.ok) {
      throw new Error(`第 ${sc.storyboard_number ?? sbId} 镜的结构化分镜无效：${parsed.errors.map(e => e.path || e.message).join('、')}`);
    }
    return {
      storyboard_id: sbId,
      number: sc.storyboard_number,
      ir: parsed && parsed.ok ? parsed.ir : null,
      clip_s: Number(sc.duration) || 5,
      edit_range: sc.edit_range,
      native: sc.mainSoundResolved || segmentIsNative(db, sbId, sc.effective_take_id),
    };
  });
}

function makeVoiceOf(db, timeline) {
  const cache = new Map();
  return (line, seg) => {
    if (!line.speaker) return null;
    const c = seg.ir.cast.find((x) => x.alias === line.speaker);
    if (!c) return null;
    if (!cache.has(c.character_id)) {
      const r = db.prepare('SELECT tts_voice FROM characters WHERE id = ?').get(c.character_id);
      cache.set(c.character_id, (r && r.tts_voice) || null);
    }
    return cache.get(c.character_id);
  };
}

function defaultSynthesize(db, log, tmpDir) {
  const ttsService = require('./ttsService');
  return async ({ text, voice }) => {
    const r = await ttsService.synthesize(db, log, { text, storyboard_id: null, storage_base: tmpDir, voice_id: voice || undefined });
    return path.join(tmpDir, r.local_path.replace(/\//g, path.sep));
  };
}

/** 接缝拼图：每个片段交界处前后各一帧并排，所有交界上下排列 */
function buildSeamsSheet(videoPath, boundaries, outPath, tmpDir, log) {
  if (!boundaries.length) return null;
  const pairs = [];
  boundaries.forEach(({ time, cutFrame, before }, i) => {
    const a = path.join(tmpDir, `seam_${i}_a.png`);
    const c = path.join(tmpDir, `seam_${i}_b.png`);
    const grab = (left, output) => {
      const seek = cutFrame == null ? ['-ss', String(left ? time - before : time)] : [];
      const select = cutFrame == null ? '' : `select=eq(n\\,${left ? cutFrame - 1 : cutFrame}),`;
      return runFfmpeg(['-y', ...seek, '-i', videoPath, '-frames:v', '1', '-vf', select + 'scale=240:-2', output], log, 'seam_frame');
    };
    if (grab(true, a) && grab(false, c)) pairs.push([a, c]);
  });
  if (!pairs.length) return null;
  const args = ['-y'];
  pairs.flat().forEach((p) => args.push('-i', p));
  const rows = pairs.map((_, i) => `[${2 * i}:v][${2 * i + 1}:v]hstack=inputs=2[r${i}]`);
  const tail = pairs.length > 1 ? `${pairs.map((_, i) => `[r${i}]`).join('')}vstack=inputs=${pairs.length}[out]` : null;
  const graph = tail ? [...rows, tail].join(';') : rows[0].replace('[r0]', '[out]');
  args.push('-filter_complex', graph, '-map', '[out]', '-frames:v', '1', outPath);
  return runFfmpeg(args, log, 'seams_sheet') && fs.existsSync(outPath) ? outPath : null;
}

/** 每秒一帧拼图（6 列） */
function buildFramesSheet(videoPath, duration, outPath, log) {
  const rows = Math.max(1, Math.ceil(Math.ceil(duration) / 6));
  const ok = runFfmpeg(['-y', '-i', videoPath, '-vf', `fps=1,scale=180:-2,tile=6x${rows}`, '-frames:v', '1', outPath], log, 'frames_sheet');
  return ok && fs.existsSync(outPath) ? outPath : null;
}

/**
 * @param {{ mergedAbsPath, storageRoot, scenes, episodeId, mergeOpts, cfg?, synthesize?, filters?: Set<string> }} opts
 * @returns {Promise<{ ok: boolean, relativePath?: string, info?: object, error?: string }>}
 */
async function runStructuredEpisodePost(db, log, opts) {
  const { mergedAbsPath, storageRoot, scenes, episodeId, mergeOpts = {} } = opts;
  const videoDur = ffprobeDurationSec(mergedAbsPath);
  if (!videoDur) return { ok: false, error: '无法读取合成视频时长' };
  const filters = opts.filters || probeFfmpegFilters();
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), `drama-struct-post-${episodeId || 0}-`));
  const info = { subtitles: { method: 'none', burned: false }, sheets: {}, warnings: [], dialogue_track: false };
  try {
    const timeline = buildTimeline(loadSegments(db, scenes, mergeOpts.delivery_mode === 'complete'));
    const wantSubs = !!(mergeOpts.dialogue_subtitles || mergeOpts.burn_narration_subtitles);
    const wantCards = !!mergeOpts.cards;
    const wantDub = !!mergeOpts.burn_dialogue_audio;
    const bgm = mergeOpts.bgm && mergeOpts.bgm.url ? mergeOpts.bgm : null;

    // ---- 台词：配音段逐句合成，原生人声段只估算时长供字幕
    let placements;
    let dialoguePath = null;
    if (wantDub) {
      const track = await buildDialogueTrack({
        timeline,
        synthesize: opts.synthesize || defaultSynthesize(db, log, tmpDir),
        voiceOf: makeVoiceOf(db, timeline),
        totalDuration: videoDur,
        protectDialogue: Boolean(mergeOpts.delivery_mode),
        tmpDir,
        log,
      });
      placements = track.placements;
      for (const p of placements) {
        const prev = timeline[p.segment - 1];
        const incoming = prev?.edit_range?.tail_us || 0;
        if (incoming && Math.round((p.start_s - timeline[p.segment].start_s) * 1e6) < incoming) {
          throw new Error('尾音与下一镜实际对白重叠，请缩短尾音后重新试听');
        }
      }
      dialoguePath = track.audioPath;
      info.warnings.push(...track.warnings);
      info.dialogue_track = !!dialoguePath;
    } else {
      const plan = planDialogueLines(timeline, (line) => estimatedLineSeconds(line));
      placements = plan.placements;
    }

    if (wantSubs && placements.some(p => p.native || !wantDub)) {
      info.warnings.push({ level: 'info', code: 'estimated_dialogue_timing', msg: '未逐句测得音长的台词字幕按计划时码估算。' });
    }

    // ---- 字幕文件（放在成片旁边，软字幕时也便于单独使用）
    const base = path.join(path.dirname(mergedAbsPath), path.basename(mergedAbsPath, path.extname(mergedAbsPath)));
    const srtPath = wantSubs ? `${base}.srt` : null;
    const cardsPath = wantCards ? `${base}.cards.srt` : null;
    if (srtPath) fs.writeFileSync(srtPath, '﻿' + buildDialogueSrt(placements), 'utf8');
    if (cardsPath) fs.writeFileSync(cardsPath, '﻿' + buildCardsSrt(timeline), 'utf8');
    const subFiles = [srtPath, cardsPath].filter((p) => p && fs.statSync(p).size > 8);

    // ---- 音频：原音轨 + 台词轨 + BGM（BGM 压低）
    const hasOrig = ffprobeHasAudio(mergedAbsPath);
    const args = ['-y', '-i', mergedAbsPath];
    const audioLabels = [];
    const graph = [];
    let idx = 1;
    if (hasOrig && dialoguePath && mergeOpts.delivery_mode) {
      const windows = placements.filter(p => !p.native).map(p =>
        `between(t,${p.start_s.toFixed(6)},${(p.start_s + p.duration_s).toFixed(6)})`);
      // Apply the switch on 1 ms audio blocks, independent of the input codec's packet length.
      graph.push(`[0:a]aresample=48000,asetnsamples=n=48:p=0,volume=0:enable='${windows.join('+')}'[source]`);
      audioLabels.push('[source]');
    } else if (hasOrig) audioLabels.push('[0:a]');
    if (dialoguePath) { args.push('-i', dialoguePath); audioLabels.push(`[${idx++}:a]`); }
    let bgmIdx = null;
    if (bgm) {
      const bgmPath = toLocalPath(opts.cfg || require('../config').loadConfig(), bgm.url) || bgm.url;
      if (path.isAbsolute(bgmPath) && !fs.statSync(bgmPath, { throwIfNoEntry: false })?.isFile()) {
        throw new Error(`整集 BGM 缺少音频文件：${path.basename(bgmPath)}`);
      }
      args.push('-stream_loop', '-1', '-i', bgmPath);
      bgmIdx = idx++;
      const db_ = Number.isFinite(Number(bgm.volume_db)) ? Math.min(-6, Number(bgm.volume_db)) : DEFAULT_BGM_DB;
      graph.push(`[${bgmIdx}:a]volume=${db_}dB,atrim=0:${videoDur.toFixed(3)}[bgm]`);
      audioLabels.push('[bgm]');
    }
    const audioChanged = !!(dialoguePath || bgm);
    if (audioChanged) {
      graph.push(`${audioLabels.join('')}amix=inputs=${audioLabels.length}:normalize=0:dropout_transition=0,atrim=0:${videoDur.toFixed(3)}[aout]`);
    }

    // ---- 视频：能烧就烧字幕，否则软字幕
    const canBurn = filters.has('subtitles');
    let vLabel = '0:v';
    if (subFiles.length && canBurn) {
      const chain = [];
      if (srtPath && subFiles.includes(srtPath)) chain.push(`subtitles='${escapeFfmpegPath(srtPath)}':charenc=UTF-8:force_style='Alignment=2,MarginV=60'`);
      if (cardsPath && subFiles.includes(cardsPath)) chain.push(`subtitles='${escapeFfmpegPath(cardsPath)}':charenc=UTF-8:force_style='Alignment=8,Bold=1,PrimaryColour=&H0080FFFF,MarginV=40'`);
      graph.push(`[0:v]${chain.join(',')}[vout]`);
      vLabel = '[vout]';
      info.subtitles = { method: 'libass', burned: true };
    } else if (subFiles.length) {
      info.subtitles = { method: 'mov_text', burned: false, reason: '本机 ffmpeg 没有 subtitles 滤镜（libass），字幕改为可开关的软字幕' };
    }
    const softSubInputs = [];
    if (subFiles.length && !canBurn) subFiles.forEach((f) => { args.push('-i', f); softSubInputs.push(idx++); });

    if (!audioChanged && !subFiles.length) {
      info.output = 'unchanged';
    } else {
      if (graph.length) args.push('-filter_complex', graph.join(';'));
      args.push('-map', vLabel);
      if (audioChanged) args.push('-map', '[aout]');
      else if (hasOrig) args.push('-map', '0:a');
      softSubInputs.forEach((i) => args.push('-map', `${i}:s`));
      args.push(...(vLabel === '0:v' ? ['-c:v', 'copy'] : ['-c:v', 'libx264', '-preset', 'fast', '-crf', '23']));
      if (audioChanged) args.push('-c:a', 'aac', '-b:a', '192k');
      else if (hasOrig) args.push('-c:a', 'copy');
      if (softSubInputs.length) {
        args.push('-c:s', 'mov_text');
        softSubInputs.forEach((_, k) => args.push(`-metadata:s:s:${k}`, `title=${k === 0 && srtPath ? '台词' : '字卡'}`));
      }
      const outAbs = `${base}_post.mp4`;
      args.push('-movflags', '+faststart', '-t', videoDur.toFixed(3), outAbs);
      if (!runFfmpeg(args, log, 'structured_post') || !fs.existsSync(outAbs)) return { ok: false, error: '成片后期合成失败', info };
      info.output = path.relative(storageRoot, outAbs).replace(/\\/g, '/');
    }
    let finalAbs = info.output === 'unchanged' ? mergedAbsPath : path.join(storageRoot, info.output);
    const narration = mergeOpts.burn_narration_subtitles && scenes.some(sc => sc.sound?.narration?.trim());
    if (mergeOpts.delivery_mode && (narration || mergeOpts.watermark_text)) {
      const layered = await runMergedEpisodePostProcess(db, log, {
        ...opts, mergedAbsPath: finalAbs, mergeOpts: { ...mergeOpts, burn_narration_subtitles: narration },
      });
      if (!layered.ok) return { ...layered, info };
      info.output = layered.relativePath;
      finalAbs = path.join(storageRoot, info.output);
    }

    // ---- 审片拼图
    if (mergeOpts.review_sheets) {
      const bounds = [];
      let t = 0;
      timeline.slice(0, -1).forEach((s) => {
        t += s.clip_s;
        const cutFrame = s.edit_range ? Math.round(t * require('./episodeCutPlan').frameRate(s.edit_range.fps)) : null;
        bounds.push({ time: t, cutFrame, before: Math.min(0.15, s.clip_s) });
      });
      const seams = buildSeamsSheet(finalAbs, bounds, `${base}_seams.png`, tmpDir, log);
      const frames = buildFramesSheet(finalAbs, videoDur, `${base}_frames.png`, log);
      if (mergeOpts.delivery_mode === 'complete' && ((bounds.length && !seams) || !frames)) {
        throw new Error(!frames ? '缺少逐秒审片拼图' : '缺少接缝审片拼图');
      }
      if (seams) info.sheets.seams = path.relative(storageRoot, seams).replace(/\\/g, '/');
      if (frames) info.sheets.frames = path.relative(storageRoot, frames).replace(/\\/g, '/');
    }
    if (finalAbs !== mergedAbsPath) {
      try { fs.unlinkSync(mergedAbsPath); } catch (_) {}
    }
    log.info('structured post: done', { episode_id: episodeId, subtitles: info.subtitles.method, dialogue_track: info.dialogue_track });
    return { ok: true, relativePath: path.relative(storageRoot, finalAbs).replace(/\\/g, '/'), info };
  } catch (e) {
    log.warn('structured post: failed', { error: e.message });
    return { ok: false, error: e.message, info };
  } finally {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) {}
  }
}

module.exports = { runStructuredEpisodePost, isStructuredEpisode };
