/**
 * 剧集级连续性表：每集每场景一份（持续道具、站位锁、轴线锁、环境声），编译器逐字取用。
 */
const { z } = require('zod');

const entry = z.object({
  props: z.array(z.object({ name: z.string().trim().min(1), look: z.string().trim().min(1) })).default([]),
  position_lock: z.string().trim().optional(),
  axis_lock: z.string().trim().optional(),
  ambience: z.string().trim().optional(),
});
const tableSchema = z.record(z.string().regex(/^\d+$/), entry);

function getContinuity(db, episodeId) {
  const row = db.prepare('SELECT continuity_json FROM episodes WHERE id = ? AND deleted_at IS NULL').get(Number(episodeId));
  if (!row) return null;
  if (!row.continuity_json) return {};
  try {
    const r = tableSchema.safeParse(JSON.parse(row.continuity_json));
    return r.success ? r.data : {};
  } catch (_) {
    return {};
  }
}

/** @returns 保存后的表；剧集不存在返回 null；不合法抛 code=continuity_invalid */
function setContinuity(db, episodeId, table) {
  const exists = db.prepare('SELECT id FROM episodes WHERE id = ? AND deleted_at IS NULL').get(Number(episodeId));
  if (!exists) return null;
  const r = tableSchema.safeParse(table || {});
  if (!r.success) {
    const err = new Error('连续性表不合法：' + r.error.issues.slice(0, 3).map((i) => `${i.path.join('.')} ${i.message}`).join('；'));
    err.code = 'continuity_invalid';
    throw err;
  }
  db.prepare('UPDATE episodes SET continuity_json = ?, updated_at = ? WHERE id = ?').run(JSON.stringify(r.data), new Date().toISOString(), Number(episodeId));
  return r.data;
}

module.exports = { getContinuity, setContinuity };
