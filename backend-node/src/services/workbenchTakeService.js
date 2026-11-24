const fs = require('node:fs');
const path = require('node:path');

const actions = ['revise', 'replace', 'reshoot'];
const statuses = ['open', 'resolved'];

function fail(message, status = 400) {
  throw Object.assign(new Error(message), { status });
}

function publicMedia(row) {
  if (!row) return null;
  const url = typeof row.video_url === 'string' ? row.video_url.trim() : '';
  const remote = /^https?:\/\//i.test(url) ? url : null;
  const relativeVideo = /\.(?:mp4|webm|mov|mkv|m4v|avi)$/i.test(url)
    && !/^(?:[a-z][\w+.-]*:|\/)/i.test(url) && !url.split(/[\\/]/).includes('..');
  const relative = relativeVideo ? url : '';
  const stored = typeof row.local_path === 'string' && row.local_path.trim();
  const local = (stored || (url.startsWith('/static/') ? url : relative)).replace(/^\/static\//, '');
  if (!local && !remote) return null;
  return { id: row.id ?? null, storyboard_id: row.storyboard_id, status: 'completed', local_path: local || null, video_url: remote };
}

function sameMedia(a, b) {
  if (!a || !b) return false;
  if (a.local_path && b.local_path) return a.local_path === b.local_path;
  return Boolean(a.video_url && a.video_url === b.video_url);
}

function candidates(db, sbId) {
  return db.prepare(`SELECT v.* FROM video_generations v JOIN storyboards s ON s.id=v.storyboard_id
    JOIN episodes e ON e.id=s.episode_id AND e.drama_id=v.drama_id
    WHERE s.id=? AND s.deleted_at IS NULL AND e.deleted_at IS NULL
    AND v.status='completed' AND v.deleted_at IS NULL ORDER BY v.created_at DESC, v.id DESC`).all(sbId);
}

// A missing check is a legacy record; unavailable checks are inconclusive.
// Only an explicit failed measurement with reported issues blocks automation.
function parseMediaCheck(row) {
  const check = row?.media_check;
  if (typeof check !== 'string') return check || null;
  try { return JSON.parse(check); } catch { return null; }
}

function takeEligibility(row) {
  const check = parseMediaCheck(row);
  return !(check?.status === 'failed' && Array.isArray(check.issues) && check.issues.length > 0);
}

// A few legacy projects used the main image slot to store a video. Before that slot
// is rebound to a still, preserve the effective video in its dedicated legacy field.
function videoUrlBeforeFrameChange(db, sb) {
  if (!sb || !isVideoPath(sb.local_path)) return sb?.video_url ?? null;
  const selected = resolveTake(db, sb);
  return selected?.local_path ? '/static/' + selected.local_path : selected?.video_url || sb.video_url || null;
}

function isVideoPath(value) {
  return /\.(mp4|webm|mov|mkv|m4v|avi)$/i.test(value || '');
}

function resolveTake(db, sb, rows) {
  if (!sb) return null;
  rows ??= candidates(db, sb.id);
  if (sb.adopted_video_generation_id != null) {
    return publicMedia(rows.find(v => v.id === sb.adopted_video_generation_id));
  }
  const latest = rows.find(v => publicMedia(v) && takeEligibility(v));
  // Legacy entries used local_path for both the video and the storyboard's still image.
  const videoPath = isVideoPath(sb.local_path) ? sb.local_path : null;
  const legacy = publicMedia({ video_url: sb.video_url, local_path: videoPath, storyboard_id: sb.id });
  if (!legacy || (latest && (latest.completed_at || latest.updated_at || latest.created_at) > sb.updated_at)) {
    return publicMedia(latest);
  }
  const matches = rows.filter(v => sameMedia(legacy, publicMedia(v)));
  if (matches.length && matches.every(v => !takeEligibility(v))) return publicMedia(latest);
  // A path shared by multiple candidates remains playable without assigning ownership.
  return matches.length === 1 ? publicMedia(matches[0]) : legacy;
}

function selectionFields(db, sb, rows) {
  if (sb.take_revision == null) return {}; // A pre-migration reader may only expose the legacy fields.
  const resolved = resolveTake(db, sb, rows);
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
  const rows = candidates(db, sbId);
  const selection = selectionFields(db, sb, rows);
  const current = selection.resolved_video;
  const drift = require('./takeDrift').deriveDrift(db, rows);
  return {
    ...selection,
    can_register_legacy: Boolean(current && current.id == null && !rows.some(v => sameMedia(current, publicMedia(v)))),
    candidates: rows.filter(publicMedia).map(v => ({
      ...publicMedia(v), model: v.model, created_at: v.created_at, keep_in_archive: !!v.keep_in_archive,
      media_check: parseMediaCheck(v),
      eligible_for_automatic_use: takeEligibility(v),
      asset_drift: drift.get(v.id),
      reviews: reviews(db, v.id),
    })),
  };
}

// Register only the media the author opened. A concurrent request reuses its ID.
function registerLegacy(db, sbId, expected) {
  return db.transaction(() => {
    const sb = storyboard(db, sbId);
    const rows = candidates(db, sb.id);
    const current = resolveTake(db, sb, rows);
    if (!current || current.local_path !== expected?.local_path || current.video_url !== expected?.video_url) {
      fail('当前视频已变化，请刷新后重新审片', 409);
    }
    const matches = rows.filter(v => sameMedia(current, publicMedia(v)));
    if (matches.length > 1) fail('旧片对应多个候选，请手动选择版本', 409);
    if (!matches.length) {
      const stamp = sb.updated_at || sb.created_at || '1970-01-01';
      const result = db.prepare(`INSERT INTO video_generations
        (drama_id, storyboard_id, provider, prompt, status, local_path, video_url, created_at, updated_at, completed_at)
        SELECT drama_id, ?, 'imported', '', 'completed', ?, ?, ?, ?, ? FROM episodes WHERE id=? AND deleted_at IS NULL`)
        .run(sb.id, current.local_path, current.video_url, stamp, stamp, stamp, sb.episode_id);
      if (!result.changes) fail('分集不存在', 404);
    }
    return details(db, sb.id);
  }).immediate();
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
  fail, publicMedia, localFile, candidates, parseMediaCheck, takeEligibility, resolveTake, selectionFields, videoUrlBeforeFrameChange, adopt, take,
  details, registerLegacy, keep, reviews, addReview, reviewStatus, validateReview,
};
