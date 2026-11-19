/**
 * 存储根内文件的 URL / 本地路径换算（结构化分镜编译、即梦 file: 参考、逐句 TTS 共用）。
 */
const path = require('path');
const fs = require('fs');

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
  const rel = path.relative(root, target);
  const outside = () => Object.assign(new Error('文件不在指定存储目录内'), { code: 'path_outside_storage' });
  if (rel === '..' || rel.startsWith('..' + path.sep) || path.isAbsolute(rel)) throw outside();
  // 根本身由配置指定；其下每一级（包括尚未创建文件的父目录）均不能经符号链接重定向。
  let current = root;
  for (const part of rel.split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    if (fs.lstatSync(current, { throwIfNoEntry: false })?.isSymbolicLink()) throw outside();
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
  else if (s.startsWith('/static/')) rel = s.slice('/static/'.length);
  else if (/^https?:\/\//i.test(s)) return null;
  else if (path.isAbsolute(s)) return assertInsideStorage(cfg, s);
  else rel = s;
  return assertInsideStorage(cfg, path.join(storageRoot(cfg), decodeURIComponent(rel.split('?')[0])));
}

module.exports = { storageRoot, filesBaseUrl, toPublicUrl, toLocalPath, assertInsideStorage };
