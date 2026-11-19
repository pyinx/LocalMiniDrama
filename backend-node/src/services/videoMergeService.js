const path = require('path');
const fs = require('fs');
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

  const storageRoot = getStorageRoot();
  const tempDir = fs.mkdtempSync(path.join(require('os').tmpdir(), 'drama-video-merge-'));
  const ffmpegAvailable = hasLocalFfmpeg();
  const { ffprobeDurationSec } = require('./mergedEpisodePostProcess');
  const resolvedScenes = [];
  let mergedRelativePath = null;
  try {
    for (const [i, scene] of scenes.entries()) {
      const localPath = await resolveVideoToLocalPath(scene?.video_url, baseUrl, storageRoot, tempDir, i, log);
      if (!localPath) return fail(`第 ${i + 1} 段视频无法解析`);
      const duration = ffmpegAvailable ? ffprobeDurationSec(localPath) : Number(scene.duration) || 0;
      if (ffmpegAvailable && !duration) return fail(`第 ${i + 1} 段视频时长无法读取`);
      resolvedScenes.push({ ...scene, localPath, duration });
    }
    if (ffmpegAvailable && resolvedScenes.length <= 100) {
      const sub = storageLayout.getProjectStorageSubdir(db, r.drama_id) || '';
      const outputFileName = `merged_${mergeId}_${Date.now()}.mp4`;
      const relativePath = path.posix.join(sub, 'videos', 'merged', outputFileName);
      const outputPath = path.join(storageRoot, relativePath);
      fs.mkdirSync(path.dirname(outputPath), { recursive: true });
      if (runFfmpegConcat(resolvedScenes.map(scene => scene.localPath), outputPath, log) && fs.existsSync(outputPath)) {
        mergedRelativePath = relativePath;
        log.info('Video merge completed (ffmpeg)', { merge_id: mergeId, episode_id: episodeId, output: mergedRelativePath });
      }
    }
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
  const totalDuration = resolvedScenes.reduce((sum, scene) => sum + scene.duration, 0);

  let mergeOpts = {};
  try {
    mergeOpts = JSON.parse(r.merge_options || '{}');
  } catch (_) {
    mergeOpts = {};
  }
  const postKind = choosePostProcessor(db, resolvedScenes, mergeOpts);
  const structuredPost = require('./structuredEpisodePost');
  if (mergedRelativePath && ffmpegAvailable && postKind === 'structured') {
    // 结构化剧集：保留原音轨，逐句台词轨替代旧的 burn_dialogue_audio，两者不同时混入
    const mergedAbsPath = path.join(storageRoot, mergedRelativePath.replace(/\//g, path.sep));
    const post = await structuredPost.runStructuredEpisodePost(db, log, { mergedAbsPath, storageRoot, scenes: resolvedScenes, episodeId, mergeOpts });
    if (post.info) db.prepare('UPDATE video_merges SET post_info = ? WHERE id = ?').run(JSON.stringify({ ...post.info, error: post.ok ? undefined : post.error }), mergeId);
    if (post.ok && post.relativePath) mergedRelativePath = post.relativePath;
    else log.warn('Video merge: structured post-process failed', { merge_id: mergeId, err: post.error });
  } else if (mergedRelativePath && ffmpegAvailable && postKind === 'legacy') {
    const mergedAbsPath = path.join(storageRoot, mergedRelativePath.replace(/\//g, path.sep));
    if (fs.existsSync(mergedAbsPath)) {
      const mergedPP = require('./mergedEpisodePostProcess');
      const post = await mergedPP.runMergedEpisodePostProcess(db, log, {
        mergedAbsPath,
        storageRoot,
        scenes: resolvedScenes,
        episodeId,
        mergeOpts,
      });
      if (post.ok && post.relativePath) {
        mergedRelativePath = post.relativePath;
        log.info('Video merge: merged episode post-process', { merge_id: mergeId, out: mergedRelativePath });
      } else if (post.error && post.error !== 'NO_POST_OPTS') {
        log.warn('Video merge: post-process skipped', { merge_id: mergeId, err: post.error });
      }
    }
  }

  const finalMergedUrl = mergedRelativePath || resolvedScenes[0].video_url;
  db.prepare(
    'UPDATE video_merges SET status = ?, merged_url = ?, duration = ?, completed_at = ?, error_msg = ? WHERE id = ?'
  ).run('completed', finalMergedUrl, Math.round(totalDuration) || null, now, null, mergeId);
  db.prepare('UPDATE episodes SET video_url = ?, status = ?, updated_at = ? WHERE id = ?').run(finalMergedUrl, 'completed', now, episodeId);
  if (taskId) {
    taskService.updateTaskResult(db, taskId, { merge_id: mergeId, video_url: finalMergedUrl, duration: Math.round(totalDuration) });
  }
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
  create,
  deleteById,
  processVideoMerge,
  buildConcatArgs,
  runFfmpegConcat,
};
