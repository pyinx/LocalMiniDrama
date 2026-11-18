const fs = require('node:fs');
const path = require('node:path');
const takes = require('./workbenchTakeService');

function choices(db, dramaId, root) {
  const rows = db.prepare(`SELECT s.*, e.episode_number FROM storyboards s JOIN episodes e ON e.id=s.episode_id
    WHERE e.drama_id=? AND s.deleted_at IS NULL AND e.deleted_at IS NULL ORDER BY e.episode_number,s.storyboard_number`).all(dramaId);
  return rows.flatMap(sb => {
    const list = takes.candidates(db, sb.id);
    const selected = takes.resolveTake(db, sb, list);
    const options = list.filter(takes.publicMedia).map(v => ({
      id: v.id, episode_number: sb.episode_number, storyboard_number: sb.storyboard_number,
      model: v.model, local_available: !!takes.localFile(root, takes.publicMedia(v).local_path),
      default_included: v.id === selected?.id || !!v.keep_in_archive || takes.reviews(db, v.id).length > 0,
    }));
    if (selected && selected.id == null || !selected && sb.adopted_video_generation_id != null) {
      options.push({
        id: sb.adopted_video_generation_id || 'legacy-' + sb.id,
        episode_number: sb.episode_number, storyboard_number: sb.storyboard_number,
        default_included: true, local_available: !!takes.localFile(root, selected?.local_path),
      });
    }
    return options;
  });
}

function packBoard(db, root, sb, extras, zip, episodeNumber) {
  const rows = takes.candidates(db, sb.id);
  const selected = takes.resolveTake(db, sb, rows);
  const label = `第 ${episodeNumber} 集第 ${sb.storyboard_number} 镜`;
  if (sb.adopted_video_generation_id && !selected) takes.fail(label + '的采用记录不可用', 422);
  const pack = [];
  if (selected && selected.id == null) rows.push(selected);
  let selectedKey = null, selectedFile = null;
  for (const row of rows) {
    const isSelected = selected && row.id === selected.id;
    const notes = row.id ? takes.reviews(db, row.id) : [];
    const extra = extras.delete(row.id);
    if (!isSelected && !extra && !row.keep_in_archive && !notes.length) continue;
    const local = takes.localFile(root, takes.publicMedia(row)?.local_path);
    if (!local) takes.fail(`${label}候选 #${row.id || '旧片'} 缺少可打包的本地视频，请先保存本地副本`, 422);
    const key = row.id == null ? 'legacy' : 'v' + row.id;
    const file = `media/videos/sb_${sb.id}_${key}${path.extname(local) || '.mp4'}`;
    zip.addFile(file, fs.readFileSync(local));
    pack.push({
      key, file, model: row.model || null, prompt: row.prompt || '', keep_in_archive: !!row.keep_in_archive,
      created_at: row.created_at || null,
      reviews: notes.map(({ time_ms, note, action, status, created_at }) => ({ time_ms, note, action, status, created_at })),
    });
    if (isSelected) { selectedKey = key; selectedFile = file; }
  }
  return {
    video_file: selectedFile, default_take_key: selectedKey,
    adopted_take_key: sb.adopted_video_generation_id != null ? selectedKey : null, video_takes: pack,
  };
}

// Validate references before saving any database rows or media on import.
function validateBoard(sb, files) {
  if (sb.video_takes === undefined) return;
  if (!Array.isArray(sb.video_takes)) takes.fail('工程包候选列表无效');
  const keys = new Set();
  for (const row of sb.video_takes) {
    if (!row || typeof row.key !== 'string' || !row.key || keys.has(row.key)) takes.fail('工程包候选标识重复或缺失');
    if (typeof row.file !== 'string' || !row.file.startsWith('media/videos/') || !files.get(row.file)?.length)
      takes.fail(`分镜 ${sb.storyboard_number} 候选 ${row.key} 缺少本地视频`);
    keys.add(row.key);
    if (!Array.isArray(row.reviews || [])) takes.fail('工程包审片记录格式无效');
    for (const review of row.reviews || []) takes.validateReview(review);
  }
  for (const key of [sb.default_take_key, sb.adopted_take_key]) {
    if (key != null && !keys.has(key)) takes.fail('工程包采用记录与分镜候选不匹配');
  }
}

function restore(db, sb, dramaId, sbId, now, save) {
  for (const row of sb.video_takes) {
    const local = save(row.file);
    const result = db.prepare(`INSERT INTO video_generations
      (drama_id,storyboard_id,provider,prompt,model,status,local_path,keep_in_archive,created_at,updated_at,completed_at)
      VALUES(?,?,'imported',?,?,'completed',?,?,?,?,?)`)
      .run(dramaId, sbId, row.prompt || '', row.model || null, local, Number(row.keep_in_archive === true), row.created_at || now, now, now);
    const id = result.lastInsertRowid;
    for (const note of row.reviews || []) takes.addReview(db, id, note, note.created_at || now);
    if (row.key === sb.adopted_take_key) {
      db.prepare('UPDATE storyboards SET adopted_video_generation_id=?,take_revision=1 WHERE id=?').run(id, sbId);
    } else if (sb.adopted_take_key == null && row.key === sb.default_take_key) {
      db.prepare('UPDATE storyboards SET video_url=? WHERE id=?').run('/static/' + local, sbId);
    }
  }
}

module.exports = { choices, packBoard, validateBoard, restore };
