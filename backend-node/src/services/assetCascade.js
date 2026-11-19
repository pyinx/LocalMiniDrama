/**
 * 父资产软删后，把挂在它下面的变体一并软删（造型/场景状态/道具状态）。
 * 按「父已软删、变体未删」匹配，所以单个删除和按集批量删除都只需在删除后调一次。
 * 无外部依赖，可被任何删除路径引用而不产生循环依赖。
 */
const VARIANT_TABLES = [
  ['character_wardrobes', 'character_id', 'characters'],
  ['scene_states', 'scene_id', 'scenes'],
  ['prop_states', 'prop_id', 'props'],
];

function tableExists(db, name) {
  return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name);
}

/** @param {'characters'|'scenes'|'props'} parentTable */
function cascadeDeletedParents(db, parentTable, now) {
  let n = 0;
  for (const [table, col, parent] of VARIANT_TABLES) {
    if (parent !== parentTable || !tableExists(db, table)) continue;
    n += db
      .prepare(
        `UPDATE ${table} SET deleted_at = ? WHERE deleted_at IS NULL
           AND ${col} IN (SELECT id FROM ${parent} WHERE deleted_at IS NOT NULL)`
      )
      .run(now).changes;
  }
  return n;
}

module.exports = { cascadeDeletedParents };
