const path = require('path');
const fs = require('fs');
const execFile = require('util').promisify(require('child_process').execFile);
const { getFfmpegPath, getFfprobePath, hasLocalFfmpeg } = require('../utils/ffmpegPath');
const storageLayout = require('./storageLayout');

function list(db, query) {
  let sql = 'FROM video_merges WHERE deleted_at IS NULL';
  const params = [];
  if (query.episode_id) {
    sql += ' AND episode_id = ?';
    params.push(query.episode_id);
  }
  if (query.drama_id) {
    sql += ' AND drama_id = ?';
    params.push(query.drama_id);
  }
  const rows = db.prepare('SELECT * ' + sql + ' ORDER BY created_at DESC').all(...params);
  return rows.map(rowToItem);
}

function rowToItem(r) {
  return {
    id: r.id,
    episode_id: r.episode_id,
    drama_id: r.drama_id,
    title: r.title,
    provider: r.provider,
    status: r.status,
    merged_url: r.merged_url,
    duration: r.duration ?? undefined,
    task_id: r.task_id,
    error_msg: r.error_msg ?? undefined,
    post_info: (() => { try { return r.post_info ? JSON.parse(r.post_info) : undefined; } catch (_) { return undefined; } })(),
    created_at: r.created_at,
    completed_at: r.completed_at,
  };
}

function getById(db, id) {
  const r = db.prepare('SELECT * FROM video_merges WHERE id = ? AND deleted_at IS NULL').get(Number(id));
  return r ? rowToItem(r) : null;
}

function hasPublishedDelivery(db, episodeId) {
  return !!db.prepare(`SELECT 1 FROM episodes e JOIN video_merges m ON m.episode_id=e.id AND m.merged_url=e.video_url
    WHERE e.id=? AND m.status='completed' AND json_extract(m.merge_options,'$.delivery_mode')='complete' LIMIT 1`).get(episodeId);
}

function create(db, log, req) {
  const now = new Date().toISOString();
  const taskService = require('./taskService');
  const task = taskService.createTask(db, log, 'video_merge', String(req.episode_id || ''));
  const mergeOptionsJson = (() => {
    const o = req.merge_options;
    if (o && typeof o === 'object') return JSON.stringify(o);
    return '{}';
  })();
  const info = db.prepare(
    `INSERT INTO video_merges (episode_id, drama_id, title, provider, model, status, scenes, merge_options, task_id, created_at)
     VALUES (?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?)`
  ).run(
    Number(req.episode_id) || 0,
    Number(req.drama_id) || 0,
    req.title ?? null,
    req.provider || 'ffmpeg',
    req.model ?? null,
    req.scenes ? JSON.stringify(req.scenes) : '[]',
    mergeOptionsJson,
    task.id,
    now
  );
  return { merge_id: info.lastInsertRowid, task_id: task.id, ...getById(db, info.lastInsertRowid) };
}

function deleteById(db, log, id) {
  const now = new Date().toISOString();
  const result = db.prepare('UPDATE video_merges SET deleted_at = ? WHERE id = ? AND deleted_at IS NULL').run(now, Number(id));
  return result.changes > 0;
}

/** 获取 storage 根目录（绝对路径） */
function getStorageRoot() {
  const loadConfig = require('../config').loadConfig;
  const cfg = loadConfig();
  const p = cfg.storage?.local_path || './data/storage';
  return path.isAbsolute(p) ? p : path.join(process.cwd(), p);
}

/** 将 video_url 解析为本地文件路径，或下载到 temp 返回路径 */
async function resolveVideoToLocalPath(videoUrl, baseUrl, storageRoot, tempDir, index, log) {
  if (!videoUrl || typeof videoUrl !== 'string') return null;
  const u = videoUrl.trim();
  // 1) URL 以 baseUrl 开头（如 http://localhost:5679/static）-> 对应 storageRoot 下相对路径
  if (baseUrl && (u.startsWith(baseUrl) || u.startsWith(baseUrl.replace(/\/$/, '')))) {
    const base = baseUrl.replace(/\/$/, '');
    const rel = u.startsWith(base + '/') ? u.slice(base.length + 1) : u.slice(base.length).replace(/^\//, '');
    if (rel && !rel.startsWith('http')) {
      const localPath = path.join(storageRoot, rel.replace(/\//g, path.sep));
      if (fs.existsSync(localPath)) {
        log.info('Video merge: using local static file', { index, path: localPath });
        return localPath;
      }
    }
  }
  // 2) 已是本地绝对路径且存在
  if (path.isAbsolute(u) && fs.existsSync(u)) {
    log.info('Video merge: using absolute path', { index, path: u });
    return u;
  }
  // 3) 相对路径（相对 storageRoot）
  if (!u.startsWith('http://') && !u.startsWith('https://')) {
    const localPath = path.join(storageRoot, u.replace(/^\//, '').replace(/\//g, path.sep));
    if (fs.existsSync(localPath)) {
      log.info('Video merge: using relative path', { index, path: localPath });
      return localPath;
    }
  }
  if (!/^https?:\/\//i.test(u)) return null;
  // 4) 远程 URL：下载到 temp
  const ext = u.includes('.mp4') ? '.mp4' : u.includes('.webm') ? '.webm' : '.mp4';
  const destPath = path.join(tempDir, `dl_${Date.now()}_${index}${ext}`);
  try {
    const res = await fetch(u, { method: 'GET' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    fs.writeFileSync(destPath, buf);
    log.info('Video merge: downloaded to temp', { index, dest: destPath });
    return destPath;
  } catch {
    log.warn('Video merge: download failed', { index });
    return null;
  }
}

/**
 * ffmpeg concat 参数构造：
 * - 默认 `-c copy` 流拷贝：快且无损，但要求各片段编码参数一致；
 * - transcode：重编码兜底。AI 分镜片段常出现编码/分辨率/采样率不一致，
 *   流拷贝 concat 会直接失败，整集退化成只有首段（issue #21 / #14）。
 */
function buildConcatArgs(listFile, outputPath, transcode = false) {
  if (!transcode) {
    return ['-f', 'concat', '-safe', '0', '-i', listFile, '-c', 'copy', '-y', outputPath];
  }
  return [
    '-f', 'concat', '-safe', '0', '-i', listFile,
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-ar', '44100', '-ac', '2',
    '-movflags', '+faststart',
    '-y', outputPath,
  ];
}

function runFfmpegConcatOnce(listFile, outputPath, transcode, log) {
  const ffmpegBin = getFfmpegPath();
  const { spawnSync } = require('child_process');
  const result = spawnSync(ffmpegBin, buildConcatArgs(listFile, outputPath, transcode), {
    encoding: 'utf8',
    maxBuffer: 4 * 1024 * 1024,
  });
  if (result.error) {
    log.warn('Video merge: ffmpeg spawn error', { error: result.error.message, transcode: !!transcode });
    return false;
  }
  if (result.status !== 0) {
    log.warn('Video merge: ffmpeg failed', {
      transcode: !!transcode,
      stderr: result.stderr?.slice(-500),
    });
    return false;
  }
  return true;
}

/** 使用 ffmpeg concat 合并多个视频文件：先流拷贝，失败再重编码兜底 */
function runFfmpegConcat(localPaths, outputPath, log) {
  const listFile = path.join(path.dirname(outputPath), `concat_list_${path.basename(outputPath)}.txt`);
  try {
    const lines = localPaths.map((p) => {
      const normalized = p.replace(/\\/g, '/');
      return `file '${normalized.replace(/'/g, "'\\''")}'`;
    });
    fs.writeFileSync(listFile, lines.join('\n'), 'utf8');
    if (runFfmpegConcatOnce(listFile, outputPath, false, log)) return true;
    log.warn('Video merge: stream copy concat failed, retrying with re-encode', {
      clip_count: localPaths.length,
    });
    return runFfmpegConcatOnce(listFile, outputPath, true, log);
  } finally {
    try { if (fs.existsSync(listFile)) fs.unlinkSync(listFile); } catch (_) {}
  }
}

/**
 * 异步处理视频合成：优先使用 ffmpeg 真正合并多段视频；失败或无 ffmpeg 时用首段作为 merged_url。
 */
async function processVideoMerge(db, log, mergeId, baseUrl) {
  const r = db.prepare('SELECT * FROM video_merges WHERE id = ? AND deleted_at IS NULL').get(mergeId);
  if (!r) return;
  const tempDir = fs.mkdtempSync(path.join(require('os').tmpdir(), 'drama-video-merge-'));
  const work = { tempDir, outputDir: null };
  try {
    await renderMerge(db, log, r, baseUrl, work);
  } catch (err) {
    if (work.outputDir) fs.rmSync(work.outputDir, { recursive: true, force: true });
    const message = `${r.title || '合成任务'}：${err.message}`;
    db.prepare("UPDATE video_merges SET status = 'failed', error_msg = ? WHERE id = ?").run(message, mergeId);
    if (r.task_id) require('./taskService').updateTaskError(db, r.task_id, message);
    log.warn('Video merge failed', { merge_id: mergeId, error: message });
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

async function inspectDeliveryClip(file, label, requireAudio = false) {
  try {
    const { stdout } = await execFile(getFfprobePath(), ['-v', 'error', '-show_entries',
      'stream=codec_type,width,height,sample_aspect_ratio,avg_frame_rate,duration:stream_side_data=rotation:stream_tags=rotate:format=duration', '-of', 'json', file]);
    const info = JSON.parse(stdout);
    const video = info.streams.find(s => s.codec_type === 'video');
    const seconds = Number(video?.duration) || Number(info.format?.duration);
    if (!video?.width || !video.height || !(seconds > 0)) throw new Error('缺少有效视频流');
    const hasAudio = info.streams.some(s => s.codec_type === 'audio');
    if (requireAudio && !hasAudio) throw new Error('缺少必需音轨');
    await execFile(getFfmpegPath(), ['-v', 'error', '-xerror', '-i', file, '-map', '0:v:0', '-map', '0:a?', '-f', 'null', '-']);
    const [n, d] = (video.avg_frame_rate || '').split('/').map(Number);
    const [pixelW, pixelH] = (video.sample_aspect_ratio || '').split(':').map(Number);
    const sar = pixelW > 0 && pixelH > 0 ? pixelW / pixelH : 1;
    const angle = Number(video.side_data_list?.find(entry => entry.rotation != null)?.rotation ?? video.tags?.rotate) || 0;
    const rotation = ((angle % 360) + 360) % 360;
    const sin = Math.abs(Math.sin(rotation * Math.PI / 180));
    const cos = Math.abs(Math.cos(rotation * Math.PI / 180));
    const displayWidth = video.width * sar;
    const ratio = (displayWidth * cos + video.height * sin) / (displayWidth * sin + video.height * cos);
    return {
      seconds, ratio, frame: n && d ? d / n : 0.04, hasAudio,
      width: sin > cos ? video.height : video.width, height: sin > cos ? video.width : video.height,
      layout: [video.width, video.height, sar, rotation].join('/'),
    };
  } catch (err) {
    throw new Error(`${label}无法读取或解码：${err.stderr?.trim().slice(-220) || err.message.split('\n')[0]}`);
  }
}

async function renderMerge(db, log, r, baseUrl, work) {
  const { tempDir } = work;
  const mergeId = r.id;
  const mergeOpts = JSON.parse(r.merge_options || '{}');
  const mode = mergeOpts.delivery_mode;
  const complete = mode === 'complete';
  const taskId = r.task_id;
  const episodeId = r.episode_id;
  let scenes = [];
  try {
    scenes = JSON.parse(r.scenes || '[]');
  } catch (_) {
    log.warn('video merge parse scenes failed', { merge_id: mergeId });
  }
  const now = new Date().toISOString();
  db.prepare('UPDATE video_merges SET status = ? WHERE id = ?').run('processing', mergeId);
  const taskService = require('./taskService');
  function fail(message) {
    db.prepare('UPDATE video_merges SET status = ?, error_msg = ? WHERE id = ?').run('failed', message, mergeId);
    if (taskId) taskService.updateTaskError(db, taskId, message);
  }
  if (!Array.isArray(scenes) || scenes.length === 0) return fail('无有效视频片段');

  const snapshot = JSON.stringify(scenes);
  const ffmpegAvailable = hasLocalFfmpeg();
  const { ffprobeDurationSec } = require('./mergedEpisodePostProcess');
  const storageRoot = getStorageRoot();

  const localPaths = [];
  const draftWarnings = [];
  const usableScenes = [];
  const [ratioW, ratioH] = String(mergeOpts.aspect_ratio || '').replace('：', ':').split(':').map(Number);
  const expectedRatio = ratioW > 0 && ratioH > 0 ? ratioW / ratioH : null;
  let firstInfo;
  let mixedLayout = false;
  for (let i = 0; i < scenes.length; i++) {
    const p = await resolveVideoToLocalPath(
      scenes[i]?.video_url,
      baseUrl,
      storageRoot,
      tempDir,
      i,
      log
    );
    if (mode) {
      const sc = scenes[i];
      const label = `第 ${sc.storyboard_number ?? sc.scene_id} 镜`;
      let info;
      try {
        if (!p) throw new Error(label + '找不到视频文件');
        info = await inspectDeliveryClip(p, label);
      } catch (err) {
        if (complete) throw err;
        draftWarnings.push(err.message);
        continue;
      }
      if (firstInfo && Math.abs(info.ratio - firstInfo.ratio) > 0.01) throw new Error(label + '画幅与首镜不一致');
      if (complete && expectedRatio && Math.abs(info.ratio - expectedRatio) > 0.01) throw new Error(label + '画幅与项目设置不一致');
      if (firstInfo && firstInfo.layout !== info.layout) mixedLayout = true;
      firstInfo ||= info;
      sc.duration = info.seconds;
    } else {
      if (!p) return fail(`第 ${i + 1} 段视频无法解析`);
      scenes[i].duration = ffmpegAvailable ? ffprobeDurationSec(p) : Number(scenes[i].duration) || 0;
      if (ffmpegAvailable && !scenes[i].duration) return fail(`第 ${i + 1} 段视频时长无法读取`);
    }
    if (p) {
      localPaths.push(p);
      usableScenes.push({ ...scenes[i], localPath: p });
    }
  }
  if (mode === 'draft') {
    if (!usableScenes.length) throw new Error(draftWarnings.join('；') || '没有可预览的镜头');
  }
  scenes = usableScenes;
  const totalDuration = scenes.reduce((sum, sc) => sum + sc.duration, 0);
  const postKind = choosePostProcessor(db, scenes, mergeOpts);
  if (mode && postKind === 'legacy' && mergeOpts.burn_dialogue_audio) {
    for (const sc of scenes) {
      if (!sc.sound?.dialogue?.trim() && !sc.sound?.audio_local_path) continue;
      const audio = sc.sound.audio_local_path;
      if (!audio || !fs.existsSync(path.resolve(storageRoot, audio))) {
        const label = `第 ${sc.storyboard_number ?? sc.scene_id} 镜`;
        if (complete) throw new Error(label + '缺少对白配音');
        draftWarnings.push(label + '缺少对白配音，草稿中该镜对白为静音');
      }
    }
  }
  log.info('Video merge: ffmpeg check', {
    merge_id: mergeId,
    has_ffmpeg: ffmpegAvailable,
    ffmpeg_path: getFfmpegPath(),
    local_video_count: localPaths.length,
    cwd: process.cwd(),
  });

  let mergedRelativePath = null;
  if (localPaths.length > 0 && ffmpegAvailable && localPaths.length <= 100) {
    const projectSubdir = storageLayout.getProjectStorageSubdir(db, r.drama_id);
    const sub = projectSubdir && String(projectSubdir).trim();
    const mergedDir = sub
      ? path.join(storageRoot, sub, 'videos', 'merged')
      : path.join(storageRoot, 'videos', 'merged');
    if (!fs.existsSync(mergedDir)) fs.mkdirSync(mergedDir, { recursive: true });
    const outputFileName = `merged_${mergeId}_${Date.now()}.mp4`;
    if (mode) work.outputDir = fs.mkdtempSync(path.join(mergedDir, 'cut-'));
    const outputPath = path.join(work.outputDir || mergedDir, outputFileName);
    // A concatenated stream can carry only one rotation matrix and sample aspect ratio.
    // FFmpeg autorotates each input while encoding these mixed clips to one layout.
    if (mixedLayout) {
      const width = Math.ceil(firstInfo.width / 2) * 2;
      const height = Math.ceil(firstInfo.height / 2) * 2;
      const filter = `scale=${width}:${height},setsar=${firstInfo.ratio * height / width}:max=10000`;
      for (let i = 0; i < localPaths.length; i++) {
        const normalized = path.join(tempDir, `upright-${i}.mp4`);
        await execFile(getFfmpegPath(), ['-v', 'error', '-i', localPaths[i], '-map', '0:v:0', '-map', '0:a?',
          '-vf', filter, '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '18', '-pix_fmt', 'yuv420p',
          '-c:a', 'aac', '-ar', '44100', '-ac', '2', normalized]).catch(err => {
          throw new Error(`第 ${usableScenes[i].storyboard_number ?? usableScenes[i].scene_id} 镜画幅转换失败：${err.stderr || err.message}`);
        });
        localPaths[i] = normalized;
      }
    }
    const ok = runFfmpegConcat(localPaths, outputPath, log);
    if (ok && fs.existsSync(outputPath)) {
      mergedRelativePath = path.relative(storageRoot, outputPath).replace(/\\/g, '/');
      log.info('Video merge completed (ffmpeg)', { merge_id: mergeId, episode_id: episodeId, output: mergedRelativePath });
    }
  }

  const shotRange = scenes.map(s => s.storyboard_number ?? s.scene_id).join('、');
  if (mode && !mergedRelativePath) throw new Error(`第 ${shotRange} 镜无法合成，请检查 FFmpeg 和源文件`);
  if (mergedRelativePath && postKind) {
    const mergedAbsPath = path.join(storageRoot, mergedRelativePath.replace(/\//g, path.sep));
    if (fs.existsSync(mergedAbsPath)) {
      const runPost = postKind === 'structured'
        ? require('./structuredEpisodePost').runStructuredEpisodePost
        : require('./mergedEpisodePostProcess').runMergedEpisodePostProcess;
      let post;
      try {
        post = await runPost(db, log, { mergedAbsPath, storageRoot, scenes, episodeId, mergeOpts });
      } catch (err) {
        if (mode !== 'draft') throw err;
        post = { ok: false, error: err.message };
      }
      if (post.info) {
        db.prepare('UPDATE video_merges SET post_info = ? WHERE id = ?')
          .run(JSON.stringify({ ...post.info, error: post.ok ? undefined : post.error }), mergeId);
      }
      if (post.ok && post.relativePath) {
        mergedRelativePath = post.relativePath;
        log.info('Video merge: merged episode post-process', { merge_id: mergeId, out: mergedRelativePath });
      } else if (complete) {
        throw new Error(`第 ${shotRange} 镜后期失败：${post.error || '未生成成片'}`);
      } else if (mode === 'draft') {
        draftWarnings.push(`第 ${shotRange} 镜后期失败，草稿使用后期处理前的合成片：${post.error || '未生成后期文件'}`);
      } else if (post.error && post.error !== 'NO_POST_OPTS') {
        log.warn('Video merge: post-process skipped', { merge_id: mergeId, err: post.error });
      }
    }
  }

  if (mode) {
    const wantsAudio = mergeOpts.burn_dialogue_audio ||
      (postKind === 'structured' ? mergeOpts.bgm?.url : mergeOpts.burn_narration_subtitles);
    const info = await inspectDeliveryClip(path.join(storageRoot, mergedRelativePath), `第 ${shotRange} 镜合成结果`, complete && wantsAudio);
    if (!complete && wantsAudio && !info.hasAudio) draftWarnings.push(`第 ${shotRange} 镜草稿未包含所选音轨`);
    if (Math.abs(info.seconds - totalDuration) > Math.max(firstInfo.frame, info.frame) + 0.001 ||
        Math.abs(info.ratio - firstInfo.ratio) > 0.01) throw new Error(`第 ${shotRange} 镜合成后画幅或时长不符`);
  }

  const finalMergedUrl = mergedRelativePath || scenes[0].video_url;
  db.transaction(() => {
    if (complete) {
      const fresh = require('./dramaService').episodeDeliveryInputs(db, episodeId, baseUrl);
      if (snapshot !== JSON.stringify(fresh)) throw new Error(`第 ${shotRange} 镜的采用、顺序或声音资料已变化，请重新交付`);
      const later = db.prepare("SELECT id FROM video_merges WHERE episode_id = ? AND id > ? AND status = 'completed' AND COALESCE(json_extract(merge_options, '$.delivery_mode'),'') <> 'draft' LIMIT 1").get(episodeId, mergeId);
      if (later) throw new Error('已有较新的成片发布');
    }
    db.prepare(
      'UPDATE video_merges SET status = ?, merged_url = ?, duration = ?, completed_at = ?, error_msg = ? WHERE id = ?'
    ).run('completed', finalMergedUrl, Math.round(totalDuration) || null, now, null, mergeId);
    if (complete || (!mode && !hasPublishedDelivery(db, episodeId))) {
      db.prepare('UPDATE episodes SET video_url = ?, status = ?, updated_at = ? WHERE id = ?').run(finalMergedUrl, 'completed', now, episodeId);
    }
    if (taskId) taskService.updateTaskResult(db, taskId, {
      merge_id: mergeId, video_url: finalMergedUrl, duration: Math.round(totalDuration),
      ...(mode === 'draft' ? { warnings: draftWarnings, scenes_count: scenes.length } : {}),
    });
  })();
  if (!mergedRelativePath) {
    log.info('Video merge completed (first-clip fallback)', { merge_id: mergeId, episode_id: episodeId });
  }
}

/**
 * 合成后走哪条后期：结构化剧集（任一分镜有 IR）走结构化后期，其中逐句台词轨替代旧的 burn_dialogue_audio；
 * 其余沿用原后期；没有任何后期选项返回 null。
 */
function choosePostProcessor(db, scenes, mergeOpts) {
  const o = mergeOpts || {};
  const legacyNeed = !!o.burn_narration_subtitles || !!o.burn_dialogue_audio || !!(o.watermark_text && String(o.watermark_text).trim());
  const structuredNeed = legacyNeed || !!(o.dialogue_subtitles || o.cards || o.review_sheets || (o.bgm && o.bgm.url));
  if (structuredNeed && require('./structuredEpisodePost').isStructuredEpisode(db, scenes)) return 'structured';
  return legacyNeed ? 'legacy' : null;
}

module.exports = {
  choosePostProcessor,
  list,
  getById,
  hasPublishedDelivery,
  create,
  deleteById,
  processVideoMerge,
  buildConcatArgs,
  runFfmpegConcat,
};
