'use strict';

// local_path takes priority in the workbench, including when image_url contains an older image.
function assetImageReference(value, staticBase = '') {
  if (typeof value !== 'string' || !value.trim()) return {};
  const ref = value.trim();
  const base = staticBase.replace(/\/$/, '');
  if (base && ref.startsWith(base + '/')) return { local: ref.slice(base.length + 1) };
  if (/^(https?:\/\/|data:image\/)/i.test(ref)) return { url: ref };
  return { local: ref.replace(/^\/static\//, '') };
}

module.exports = { assetImageReference };
