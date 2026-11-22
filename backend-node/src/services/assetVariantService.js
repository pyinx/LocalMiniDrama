/**
 * 资产变体：角色造型 / 场景状态 / 道具状态。三者同构——挂在一个父资产下，各有一张图，
 * 生图时以父资产的图为参考（身份、空间、外观的唯一来源），结果只写回变体行，不动父资产主图。
 */
const { z } = require('zod');
const imageClient = require('./imageClient');
const A = require('./segmentCompile/rules/assetPhrases');
const { deriveStyleSentences } = require('./segmentCompile/style');
const { mergeCfgStyleWithDrama } = require('../utils/dramaStyleMerge');
const { toPublicUrl } = require('../utils/storagePaths');

const KINDS = {
  wardrobe: {
    table: 'character_wardrobes',
    parentTable: 'characters',
    parentCol: 'character_id',
    parentLabel: '角色',
    storageCategory: 'characters',
    size: '1792x1024',
    schema: z.object({
      name: z.string().trim().min(1),
      change_phrase: z.string().trim().min(1),
      episode_range: z.array(z.number().int().positive()).max(2).nullable().optional(),
      sort_order: z.number().int().optional(),
    }),
    columns: ['name', 'change_phrase', 'episode_range', 'sort_order'],
    buildPrompt: (parent, row, style) =>
      [style.asset, A.wardrobeLead(parent.name), String(parent.appearance || '').trim(), A.wardrobeChange(row.change_phrase), A.oneClearFaceLayout]
        .filter(Boolean)
        .join('\n'),
  },
  scene_state: {
    table: 'scene_states',
    parentTable: 'scenes',
    parentCol: 'scene_id',
    parentLabel: '场景',
    storageCategory: 'scenes',
    size: (row) => (row.kind === 'portrait' ? '1024x1792' : '1792x1024'),
    schema: z.object({
      name: z.string().trim().min(1),
      kind: z.enum(['state', 'portrait', 'reverse']).default('state'),
      state_phrase: z.string().trim().min(1),
      sort_order: z.number().int().optional(),
    }),
    columns: ['name', 'kind', 'state_phrase', 'sort_order'],
    // 场景图用完整风格句（含光的倾向）
    buildPrompt: (parent, row, style) =>
      [
        style.video,
        A.sceneStateLead(parent.location || '场景'),
        A.sceneStateChange(row.state_phrase),
        row.kind === 'portrait' ? A.scenePortrait : null,
        row.kind === 'reverse' ? A.sceneReverse : null,
        A.sceneEmpty,
      ]
        .filter(Boolean)
        .join('\n'),
  },
  prop_state: {
    table: 'prop_states',
    parentTable: 'props',
    parentCol: 'prop_id',
    parentLabel: '道具',
    storageCategory: 'props',
    size: '1024x1024',
    schema: z.object({
      name: z.string().trim().min(1),
      state_phrase: z.string().trim().min(1),
      sort_order: z.number().int().optional(),
    }),
    columns: ['name', 'state_phrase', 'sort_order'],
    buildPrompt: (parent, row, style) =>
      [style.asset, A.propStateLead(parent.name || '道具'), String(parent.description || '').trim(), A.propStateChange(row.state_phrase)]
        .filter(Boolean)
        .join('\n'),
  },
};

function kindOf(kind) {
  const k = KINDS[kind];
  if (!k) throw Object.assign(new Error('未知的变体类型'), { code: 'bad_kind' });
  return k;
}

function codedError(code, message, extra) {
  return Object.assign(new Error(message), { code }, extra || {});
}

function toDto(cfg, row) {
  if (!row) return null;
  let range = null;
  try { range = row.episode_range ? JSON.parse(row.episode_range) : null; } catch (_) {}
  return { ...row, episode_range: range, image_url: toPublicUrl(cfg, row.image_url, row.local_path) || null };
}

function loadParent(db, k, parentId) {
  return db.prepare(`SELECT * FROM ${k.parentTable} WHERE id = ? AND deleted_at IS NULL`).get(Number(parentId));
}

function cfgNow() {
  return require('../config').loadConfig();
}

function list(db, kind, parentId) {
  const k = kindOf(kind);
  if (!loadParent(db, k, parentId)) return null;
  const cfg = cfgNow();
  return db
    .prepare(`SELECT * FROM ${k.table} WHERE ${k.parentCol} = ? AND deleted_at IS NULL ORDER BY sort_order, id`)
    .all(Number(parentId))
    .map((r) => toDto(cfg, r));
}

function getById(db, kind, id) {
  const k = kindOf(kind);
  return db.prepare(`SELECT * FROM ${k.table} WHERE id = ? AND deleted_at IS NULL`).get(Number(id));
}

function validate(k, data, partial) {
  const r = (partial ? k.schema.partial() : k.schema).safeParse(data || {});
  if (!r.success) {
    throw codedError('variant_invalid', '变体数据不合法：' + r.error.issues.slice(0, 3).map((i) => `${i.path.join('.')} ${i.message}`).join('；'));
  }
  return r.data;
}

function columnValue(col, v) {
  if (col === 'episode_range') return v == null ? null : JSON.stringify(v);
  return v ?? null;
}

function create(db, kind, parentId, data) {
  const k = kindOf(kind);
  if (!loadParent(db, k, parentId)) return null;
  const v = validate(k, data, false);
  const now = new Date().toISOString();
  const cols = k.columns.filter((c) => v[c] !== undefined);
  const info = db
    .prepare(`INSERT INTO ${k.table} (${k.parentCol}, ${cols.join(', ')}, created_at, updated_at) VALUES (?, ${cols.map(() => '?').join(', ')}, ?, ?)`)
    .run(Number(parentId), ...cols.map((c) => columnValue(c, v[c])), now, now);
  return toDto(cfgNow(), getById(db, kind, info.lastInsertRowid));
}

function update(db, kind, id, data) {
  const k = kindOf(kind);
  if (!getById(db, kind, id)) return null;
  const v = validate(k, data, true);
  const cols = k.columns.filter((c) => v[c] !== undefined);
  if (cols.length) {
    db.prepare(`UPDATE ${k.table} SET ${cols.map((c) => `${c} = ?`).join(', ')}, updated_at = ? WHERE id = ?`)
      .run(...cols.map((c) => columnValue(c, v[c])), new Date().toISOString(), Number(id));
  }
  return toDto(cfgNow(), getById(db, kind, id));
}

function remove(db, kind, id) {
  const k = kindOf(kind);
  const r = db.prepare(`UPDATE ${k.table} SET deleted_at = ? WHERE id = ? AND deleted_at IS NULL`).run(new Date().toISOString(), Number(id));
  return r.changes > 0;
}

/** 父资产软删时同一事务调用：其变体一并软删 */
function removeForParent(db, kind, parentId, now) {
  const k = kindOf(kind);
  return db.prepare(`UPDATE ${k.table} SET deleted_at = ? WHERE ${k.parentCol} = ? AND deleted_at IS NULL`).run(now, Number(parentId)).changes;
}

/**
 * 以父资产的图为参考生成变体图；结果写回变体行。
 * @returns {{ image_generation: object, prompt: string }}
 */
function generateImage(db, log, kind, id, opts = {}) {
  const k = kindOf(kind);
  const row = getById(db, kind, id);
  if (!row) throw codedError('not_found', '变体不存在');
  const parent = loadParent(db, k, row[k.parentCol]);
  if (!parent) throw codedError('not_found', `${k.parentLabel}已不存在`);
  const cfg = cfgNow();
  if (kind === 'wardrobe') {
    // 头身分离的角色只生成这套身体，造型图由头和身体拼合
    const headBody = require('./characterHeadBody').generateWardrobeBody(db, log, cfg, row, opts);
    if (headBody) return headBody;
  }
  const baseUrl = k.baseImage ? k.baseImage(db, cfg, parent, row) : toPublicUrl(cfg, parent.image_url, parent.local_path);
  if (!baseUrl) throw codedError('base_image_missing', `请先为${k.parentLabel}「${parent.name || parent.location}」生成主图，变体要以它为参考`);
  const drama = db.prepare('SELECT style, metadata FROM dramas WHERE id = ?').get(parent.drama_id);
  const style = deriveStyleSentences((mergeCfgStyleWithDrama(cfg, drama || {}).style || {}).default_style_zh || '');
  const prompt = k.buildPrompt(parent, row, style);
  db.prepare(`UPDATE ${k.table} SET prompt = ?, updated_at = ? WHERE id = ?`).run(prompt, new Date().toISOString(), row.id);
  const imageGen = imageClient.createAndGenerateImage(db, log, {
    drama_id: parent.drama_id,
    prompt,
    model: opts.model || undefined,
    size: typeof k.size === 'function' ? k.size(row) : k.size,
    quality: 'standard',
    provider: 'openai',
    reference_image_urls: [baseUrl],
    storage_category: k.storageCategory,
    on_completed: ({ image_url, local_path }) => {
      db.prepare(`UPDATE ${k.table} SET image_url = ?, local_path = ?, updated_at = ? WHERE id = ?`)
        .run(image_url, local_path, new Date().toISOString(), row.id);
      // 整张造型图取代了此前的头身拼合，旧身体不再参与重拼
      if (kind === 'wardrobe') db.prepare('UPDATE character_wardrobes SET body_local_path = NULL WHERE id = ?').run(row.id);
    },
  });
  return { image_generation: imageGen, prompt };
}

module.exports = { KINDS, list, getById, create, update, remove, removeForParent, generateImage };
