/**
 * 视频配置（分辨率、字幕、对白烧录、水印、台词字幕、字卡、背景音乐、审片拼图）。
 * 本模块独占这 8 项的定义、默认值、校验与合并：
 *   有效设置 = DEFAULTS ← 项目（dramas.metadata.video_settings）← 分集覆盖（episodes.video_settings）
 * 项目与分集都只存「已设置的键」（稀疏）；读取时逐键校验，非法值视为未设置。
 */
const storageLayout = require('./storageLayout');

const RESOLUTIONS = ['480p', '720p', '1080p'];
const WATERMARK_MAX = 200;
const BGM_URL_MAX = 1000;
const BGM_DB_MIN = -40;
const BGM_DB_MAX = -6;

const DEFAULTS = Object.freeze({
  resolution: '480p',
  subtitle: false,
  dialogue_burn: false,
  watermark: Object.freeze({ enabled: false, text: '' }),
  dialogue_subtitles: true,
  cards: true,
  bgm: Object.freeze({ url: '', volume_db: -18 }),
  review_sheets: true,
});
const KEYS = Object.keys(DEFAULTS);

function inputError(message, status = 400) {
  const err = new Error(message);
  err.status = status;
  return err;
}

function isPlainObject(v) {
  return v != null && typeof v === 'object' && !Array.isArray(v);
}

/** 校验并规整一个键的值（固定键序，便于相等比较）；非法时抛 400 */
function normalizeValue(key, value) {
  switch (key) {
    case 'resolution':
      if (!RESOLUTIONS.includes(value)) throw inputError('分辨率只能是 ' + RESOLUTIONS.join('、'));
      return value;
    case 'subtitle':
    case 'dialogue_burn':
    case 'dialogue_subtitles':
    case 'cards':
    case 'review_sheets':
      if (typeof value !== 'boolean') throw inputError(key + ' 必须是布尔值');
      return value;
    case 'watermark': {
      if (!isPlainObject(value) || typeof value.enabled !== 'boolean') throw inputError('水印格式无效：需要 enabled（布尔）与 text（字符串）');
      const text = value.text == null ? '' : value.text;
      if (typeof text !== 'string') throw inputError('水印文字必须是字符串');
      const trimmed = text.trim();
      if (trimmed.length > WATERMARK_MAX) throw inputError('水印文字最多 ' + WATERMARK_MAX + ' 字');
      return { enabled: value.enabled, text: trimmed };
    }
    case 'bgm': {
      if (!isPlainObject(value)) throw inputError('背景音乐格式无效：需要 url 与 volume_db');
      const url = value.url == null ? '' : value.url;
      if (typeof url !== 'string') throw inputError('背景音乐地址必须是字符串');
      const trimmed = url.trim();
      if (trimmed.length > BGM_URL_MAX) throw inputError('背景音乐地址过长');
      const db = value.volume_db == null ? DEFAULTS.bgm.volume_db : value.volume_db;
      if (typeof db !== 'number' || !Number.isFinite(db) || db < BGM_DB_MIN || db > BGM_DB_MAX) {
        throw inputError('背景音乐音量需在 ' + BGM_DB_MIN + ' 到 ' + BGM_DB_MAX + ' dB 之间');
      }
      return { url: trimmed, volume_db: db };
    }
    default:
      throw inputError('不支持的设置项：' + key);
  }
}

/** 读取已存的稀疏对象：丢弃未知键与非法值，不抛错 */
function sanitize(raw) {
  if (typeof raw === 'string') {
    try { raw = JSON.parse(raw); } catch (_) { return {}; }
  }
  const out = {};
  if (!isPlainObject(raw)) return out;
  for (const key of KEYS) {
    if (!(key in raw)) continue;
    try { out[key] = normalizeValue(key, raw[key]); } catch (_) { /* 非法值视为未设置 */ }
  }
  return out;
}

function projectEffective(metadata) {
  return { ...DEFAULTS, ...sanitize(storageLayout.parseMetadata(metadata).video_settings) };
}

/** 分集的 `{ overrides, effective }`；project 是项目有效设置 */
function forEpisode(project, rawOverrides) {
  const overrides = sanitize(rawOverrides);
  return { overrides, effective: { ...project, ...overrides } };
}

/** 校验补丁：对象；键只能是这 8 项；值为 null（清除）或合法值。返回规整后的补丁，全有或全无 */
function validatePatch(patch) {
  if (!isPlainObject(patch)) throw inputError('请求体必须是对象');
  const out = {};
  for (const [key, value] of Object.entries(patch)) {
    if (!KEYS.includes(key)) throw inputError('不支持的设置项：' + key);
    out[key] = value === null ? null : normalizeValue(key, value);
  }
  return out;
}

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/** 项目默认：补丁里 null 清除该项；其余写入。读-改-写在同一事务内。返回项目有效设置，剧不存在返回 null */
function saveProject(db, log, dramaId, rawPatch) {
  const patch = validatePatch(rawPatch);
  return db.transaction(() => {
    const row = db.prepare('SELECT id, metadata FROM dramas WHERE id = ? AND deleted_at IS NULL').get(Number(dramaId));
    if (!row) return null;
    const meta = storageLayout.parseMetadata(row.metadata);
    const stored = sanitize(meta.video_settings);
    for (const [key, value] of Object.entries(patch)) {
      if (value === null) delete stored[key];
      else stored[key] = value;
    }
    if (Object.keys(stored).length) meta.video_settings = stored;
    else delete meta.video_settings;
    db.prepare('UPDATE dramas SET metadata = ?, updated_at = ? WHERE id = ?').run(JSON.stringify(meta), new Date().toISOString(), row.id);
    log.info('Project video settings saved', { drama_id: row.id, keys: Object.keys(patch) });
    return { ...DEFAULTS, ...stored };
  })();
}

/** 分集覆盖：null 清除；值与项目有效值相同也视为清除（不留重复覆盖）。返回 `{ overrides, effective }`，集不存在返回 null */
function saveEpisode(db, log, episodeId, rawPatch) {
  const patch = validatePatch(rawPatch);
  return db.transaction(() => {
    const ep = db.prepare('SELECT id, drama_id, video_settings FROM episodes WHERE id = ? AND deleted_at IS NULL').get(Number(episodeId));
    if (!ep) return null;
    const drama = db.prepare('SELECT metadata FROM dramas WHERE id = ? AND deleted_at IS NULL').get(ep.drama_id);
    if (!drama) return null;
    const project = projectEffective(drama.metadata);
    const overrides = sanitize(ep.video_settings);
    for (const [key, value] of Object.entries(patch)) {
      if (value === null || same(value, project[key])) delete overrides[key];
      else overrides[key] = value;
    }
    db.prepare('UPDATE episodes SET video_settings = ?, updated_at = ? WHERE id = ?')
      .run(Object.keys(overrides).length ? JSON.stringify(overrides) : null, new Date().toISOString(), ep.id);
    log.info('Episode video settings saved', { episode_id: ep.id, keys: Object.keys(patch) });
    return { overrides, effective: { ...project, ...overrides } };
  })();
}

module.exports = { KEYS, DEFAULTS, projectEffective, forEpisode, sanitize, saveProject, saveEpisode, validatePatch };
