const fs = require('node:fs');
const path = require('node:path');

const actions = ['revise', 'replace', 'reshoot'];
const statuses = ['open', 'resolved'];

function fail(message, status = 400) {
  throw Object.assign(new Error(message), { status });
}

function publicMedia(row) {
  if (!row) return null;
  const local = (typeof row.local_path === 'string' && row.local_path.trim())
    || (typeof row.video_url === 'string' && row.video_url.startsWith('/static/') ? row.video_url.slice(8) : '');
  const remote = /^https?:\/\//i.test(row.video_url || '') ? row.video_url : null;
  if (!local && !remote) return null;
  return { id: row.id ?? null, storyboard_id: row.storyboard_id, status: 'completed', local_path: local || null, video_url: remote };
}

function candidates(db, sbId) {
  return db.prepare(`SELECT v.* FROM video_generations v JOIN storyboards s ON s.id=v.storyboard_id
    JOIN episodes e ON e.id=s.episode_id AND e.drama_id=v.drama_id
    WHERE s.id=? AND s.deleted_at IS NULL AND e.deleted_at IS NULL
    AND v.status='completed' AND v.deleted_at IS NULL ORDER BY v.created_at DESC, v.id DESC`).all(sbId);
}

function resolveTake(db, sb, rows) {
  if (!sb) return null;
  rows ??= candidates(db, sb.id);
  if (sb.adopted_video_generation_id != null) {
    return publicMedia(rows.find(v => v.id === sb.adopted_video_generation_id));
  }
  const latest = rows.find(publicMedia);
  // Legacy entries used local_path for both the video and the storyboard's still image.
  const videoPath = /\.(mp4|webm|mov|mkv|m4v|avi)$/i.test(sb.local_path || '')
    ? sb.local_path : null;
  const legacy = publicMedia({ video_url: sb.video_url, local_path: videoPath, storyboard_id: sb.id });
  if (!legacy || (latest && (latest.completed_at || latest.updated_at || latest.created_at) > sb.updated_at)) {
    return publicMedia(latest);
  }
  const matches = rows.filter(v => (legacy.local_path && legacy.local_path === v.local_path)
    || (legacy.video_url && legacy.video_url === v.video_url));
  // A path shared by multiple candidates remains playable without assigning ownership.
  return matches.length === 1 ? publicMedia(matches[0]) : legacy;
}

function selectionFields(db, sb) {
  if (sb.take_revision == null) return {}; // A pre-migration reader may only expose the legacy fields.
  const resolved = resolveTake(db, sb);
  return {
    adopted_video_generation_id: sb.adopted_video_generation_id,
    take_revision: sb.take_revision,
    resolved_video: resolved,
    video_url: resolved?.local_path ? '/static/' + resolved.local_path : resolved?.video_url || null,
  };
}

function storyboard(db, id) {
  const sb = db.prepare('SELECT * FROM storyboards WHERE id=? AND deleted_at IS NULL').get(id);
  if (!sb) fail('分镜不存在', 404);
  return sb;
}

function take(db, sbId, id) {
  const row = candidates(db, sbId).find(v => v.id === Number(id));
  if (!row || !publicMedia(row)) fail('请选择本镜已完成且有视频的候选');
  return row;
}

function localFile(root, relative) {
  if (!relative || path.isAbsolute(relative)) return null;
  try {
    const base = fs.realpathSync(root);
    const file = fs.realpathSync(path.resolve(base, relative));
    const within = path.relative(base, file);
    if (!within || within.startsWith('..' + path.sep) || within === '..' || path.isAbsolute(within)) return null;
    const stat = fs.statSync(file);
    return stat.isFile() && stat.size > 0 ? file : null;
  } catch { return null; }
}

function adopt(db, cfg, sbId, body) {
  return db.transaction(() => {
    const sb = storyboard(db, sbId);
    const row = take(db, sbId, body.video_generation_id);
    const local = publicMedia(row).local_path;
    if (local && !localFile(cfg?.storage?.local_path || './data/storage', local)) {
      fail('候选本地文件缺失或不在媒体目录内，请重新导入');
    }
    if (sb.adopted_video_generation_id !== row.id) {
      if (body.expected_revision !== sb.take_revision) fail('采用版本已变更，请刷新后重新选择', 409);
      db.prepare('UPDATE storyboards SET adopted_video_generation_id=?, take_revision=take_revision+1 WHERE id=?')
        .run(row.id, sb.id);
    }
    return selectionFields(db, storyboard(db, sbId));
  }).immediate();
}

function reviews(db, id) {
  return db.prepare('SELECT * FROM video_take_reviews WHERE video_generation_id=? ORDER BY time_ms,id').all(id);
}

function details(db, sbId) {
  const sb = storyboard(db, sbId);
  return {
    ...selectionFields(db, sb),
    candidates: candidates(db, sbId).filter(publicMedia).map(v => ({
      ...publicMedia(v), model: v.model, created_at: v.created_at, keep_in_archive: !!v.keep_in_archive,
      reviews: reviews(db, v.id),
    })),
  };
}

function keep(db, sbId, id, value) {
  take(db, sbId, id);
  if (typeof value !== 'boolean') fail('请选择是否保留候选');
  db.prepare('UPDATE video_generations SET keep_in_archive=? WHERE id=?').run(Number(value), id);
}

function validateReview(r) {
  if (!r || !Number.isSafeInteger(r.time_ms) || r.time_ms < 0 || typeof r.note !== 'string'
    || !r.note.trim() || r.note.length > 4000 || !actions.includes(r.action) || !statuses.includes(r.status || 'open')) {
    fail('审片需填写有效时间码、问题描述和处理方式');
  }
}

function addReview(db, id, body, createdAt = new Date().toISOString()) {
  validateReview(body);
  db.prepare(`INSERT INTO video_take_reviews(video_generation_id,time_ms,note,action,status,created_at)
    VALUES(?,?,?,?,?,?)`).run(id, body.time_ms, body.note.trim(), body.action, body.status || 'open', createdAt);
}

function reviewStatus(db, sbId, id, reviewId, status) {
  take(db, sbId, id);
  if (!statuses.includes(status)) fail('审片处理状态无效');
  const result = db.prepare('UPDATE video_take_reviews SET status=? WHERE id=? AND video_generation_id=?').run(status, reviewId, id);
  if (!result.changes) fail('审片记录不存在', 404);
}

module.exports = {
  fail, publicMedia, localFile, candidates, resolveTake, selectionFields, adopt, take,
  details, keep, reviews, addReview, reviewStatus, validateReview,
};
