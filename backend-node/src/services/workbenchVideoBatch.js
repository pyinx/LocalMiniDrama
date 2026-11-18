const { randomUUID } = require('node:crypto');

// A batch fills missing clips. A deliberate reshoot creates its own operation.
function openBatch(db, episodeId, storyboardIds) {
  const ep = db.prepare('SELECT id FROM episodes WHERE id=? AND deleted_at IS NULL').get(episodeId);
  if (!ep) throw new Error('剧集不存在');
  return db.transaction(() => {
    const board = db.prepare('SELECT id FROM storyboards WHERE id=? AND episode_id=? AND deleted_at IS NULL');
    const insert = db.prepare('INSERT OR IGNORE INTO video_batch_items(episode_id,storyboard_id,operation_key) VALUES(?,?,?)');
    for (const id of new Set(storyboardIds)) {
      if (!board.get(id, episodeId)) throw new Error('批次分镜不属于本集');
      const existing = db.prepare("SELECT * FROM video_generations WHERE storyboard_id=? AND deleted_at IS NULL AND (status IN ('processing','completed') OR dispatch_state='unknown' OR provider_task_id IS NOT NULL) ORDER BY id DESC LIMIT 1").get(id);
      const key = existing?.operation_key || randomUUID();
      if (existing && !existing.operation_key) db.prepare('UPDATE video_generations SET operation_key=? WHERE id=?').run(key, existing.id);
      insert.run(episodeId, id, key);
      // 已经发出的操作保留原标识。领取前取消的项在作者继续此批次时重新排队。
      db.prepare(`UPDATE video_batch_items SET operation_key=? WHERE episode_id=? AND storyboard_id=? AND
        EXISTS (SELECT 1 FROM video_generations v WHERE v.operation_key=video_batch_items.operation_key AND v.dispatch_state='cancelled_before_dispatch')`)
        .run(key, episodeId, id);
    }
    return db.prepare(`SELECT b.storyboard_id, b.operation_key, v.id AS video_id, v.task_id,
        COALESCE(v.status,'waiting') AS status, v.dispatch_state, v.error_msg, s.storyboard_number
      FROM video_batch_items b JOIN storyboards s ON s.id=b.storyboard_id AND s.deleted_at IS NULL
      LEFT JOIN video_generations v ON v.operation_key=b.operation_key
      WHERE b.episode_id=? ORDER BY s.storyboard_number, s.id`).all(episodeId);
  }).immediate();
}

module.exports = { openBatch };
