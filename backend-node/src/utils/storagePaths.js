/**
 * 存储根内文件的 URL / 本地路径换算（结构化分镜编译、即梦 file: 参考、逐句 TTS 共用）。
 */
const path = require('path');

function storageRoot(cfg) {
  const p = (cfg && cfg.storage && cfg.storage.local_path) || './data/storage';
  return path.isAbsolute(p) ? p : path.join(process.cwd(), p);
}

function filesBaseUrl(cfg) {
  return String((cfg && cfg.storage && cfg.storage.base_url) || '').replace(/\/$/, '');
}

/** 资产行（image_url + local_path）→ 可交给视频接口的 URL；本地文件优先 */
function toPublicUrl(cfg, imageUrl, localPath) {
  const base = filesBaseUrl(cfg);
  if (localPath && base) return `${base}/${String(localPath).replace(/^\/+/, '')}`;
  const u = imageUrl ? String(imageUrl) : '';
  if (!u || u.startsWith('data:')) return u || null;
  if (/^https?:\/\//i.test(u)) return u;
  if (u.startsWith('/static/') && base) return base.replace(/\/static$/, '') + u;
  return u;
}

/** 绝对路径必须落在存储根之内，否则抛错（防止把任意文件交给外部工具） */
function assertInsideStorage(cfg, absPath) {
  const root = path.resolve(storageRoot(cfg));
  const target = path.resolve(absPath);
  if (target !== root && !target.startsWith(root + path.sep)) {
    const err = new Error('文件不在存储目录内');
    err.code = 'path_outside_storage';
    throw err;
  }
  return target;
}

/** /static/... URL、指向本服务的 http URL 或存储内相对路径 → 存储根内的绝对路径；外部 URL 返回 null */
function toLocalPath(cfg, urlOrPath) {
  if (!urlOrPath) return null;
  const s = String(urlOrPath);
  const base = filesBaseUrl(cfg);
  let rel = null;
  if (base && s.startsWith(base + '/')) rel = s.slice(base.length + 1);
  else if (s.includes('/static/')) rel = s.split('/static/')[1];
  else if (/^https?:\/\//i.test(s)) return null;
  else if (path.isAbsolute(s)) return assertInsideStorage(cfg, s);
  else rel = s;
  return assertInsideStorage(cfg, path.join(storageRoot(cfg), decodeURIComponent(rel.split('?')[0])));
}

module.exports = { storageRoot, filesBaseUrl, toPublicUrl, toLocalPath, assertInsideStorage };
