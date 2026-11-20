const { randomUUID } = require('node:crypto');
const { publicMedia, parseMediaCheck, takeEligibility, resolveTake, localFile } = require('./workbenchTakeService');

// Call inside the transaction that reads or dispatches the batch slot. The batch key
// and a manual request's key are independently retriable even when they share a take.
function resolveBatchVideo(db, slot, storageRoot) {
  const bound = slot.reused_video_id != null
    ? db.prepare('SELECT * FROM video_generations WHERE id=?').get(slot.reused_video_id)
    : db.prepare('SELECT * FROM video_generations WHERE operation_key=?').get(slot.operation_key);
  if (bound) return bound;
  const candidates = db.prepare(`SELECT * FROM video_generations WHERE storyboard_id=? AND drama_id=? AND deleted_at IS NULL
    AND (status IN ('pending','processing','completed') OR dispatch_state='unknown' OR TRIM(provider_task_id)!='')
    ORDER BY id DESC`).all(slot.storyboard_id, slot.drama_id);
  const existing = candidates.find(v => v.status !== 'completed' || (publicMedia(v) && takeEligibility(v)));
  if (existing) {
    db.prepare('UPDATE video_batch_items SET reused_video_id=? WHERE operation_key=?').run(existing.id, slot.operation_key);
    return existing;
  }
  // A legacy clip can be the current cut without owning a generation ID.
  const board = db.prepare('SELECT * FROM storyboards WHERE id=? AND deleted_at IS NULL').get(slot.storyboard_id);
  const media = resolveTake(db, board, candidates.filter(v => v.status === 'completed'));
  if (media && (media.local_path ? localFile(storageRoot, media.local_path) : media.video_url)) {
    if (media.id != null) {
      const adopted = candidates.find(v => v.id === media.id);
      if (adopted) {
        db.prepare('UPDATE video_batch_items SET reused_video_id=? WHERE operation_key=?').run(adopted.id, slot.operation_key);
        return adopted;
      }
    }
    return { ...media, drama_id: slot.drama_id };
  }
}

// A batch fills missing clips. A deliberate reshoot creates its own operation.
function openBatch(db, episodeId, storyboardIds, storageRoot) {
  const ep = db.prepare('SELECT id, drama_id FROM episodes WHERE id=? AND deleted_at IS NULL').get(episodeId);
  if (!ep) throw new Error('剧集不存在');
  return db.transaction(() => {
    const board = db.prepare('SELECT id FROM storyboards WHERE id=? AND episode_id=? AND deleted_at IS NULL');
    const insert = db.prepare('INSERT OR IGNORE INTO video_batch_items(episode_id,storyboard_id,operation_key) VALUES(?,?,?)');
    const requested = new Set(storyboardIds);
    for (const id of requested) {
      if (!board.get(id, episodeId)) throw new Error('批次分镜不属于本集');
      insert.run(episodeId, id, randomUUID());
    }
    const slots = db.prepare(`SELECT b.*, s.storyboard_number
      FROM video_batch_items b JOIN storyboards s ON s.id=b.storyboard_id AND s.deleted_at IS NULL
      WHERE b.episode_id=? ORDER BY s.storyboard_number, s.id`).all(episodeId);
    return slots.map(slot => {
      slot.drama_id = ep.drama_id;
      let video = resolveBatchVideo(db, slot, storageRoot);
      if (requested.has(slot.storyboard_id) && video?.dispatch_state === 'cancelled_before_dispatch') {
        const key = slot.operation_key === video.operation_key ? randomUUID() : slot.operation_key;
        db.prepare('UPDATE video_batch_items SET operation_key=?,reused_video_id=NULL WHERE operation_key=?').run(key, slot.operation_key);
        slot.operation_key = key;
        slot.reused_video_id = null;
        video = resolveBatchVideo(db, slot, storageRoot);
      }
      return { storyboard_id: slot.storyboard_id, storyboard_number: slot.storyboard_number,
        operation_key: slot.operation_key, video_id: video?.id ?? null, task_id: video?.task_id ?? null,
        status: video?.deleted_at ? 'failed' : video?.status || 'waiting', dispatch_state: video?.dispatch_state ?? null,
        media_check: parseMediaCheck(video), eligible_for_automatic_use: takeEligibility(video),
        error_msg: video?.deleted_at ? '关联视频已删除，请核查后手动重拍' : video?.error_msg ?? null };
    });
  }).immediate();
}

module.exports = { openBatch, resolveBatchVideo };
