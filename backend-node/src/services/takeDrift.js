/**
 * 已生成的片「当时用的资产图」与「该分镜现在绑定的资产图」是否一致。只读，不落库，不触发任何生成。
 *
 * - current：当时用的角色、造型、场景（含状态）、道具图，现在仍是本分镜绑定的图；
 * - stale：其中有图被换（重新生成）、被换绑，或资产已删除；changed 列出这些资产；
 * - unknown：无法比较，不当作过期——旧片没有 compiled_json、首尾帧或即梦片没有 refs、分镜已不是结构化分镜、
 *   片未完成、推导出错。
 *
 * 只比资产参考图：上一段尾帧每次生成都不同，不参与；首帧图与分镜文字的变化不在这里判断。
 */
const { getVideoCaps } = require('./modelCapabilities');

const COMPARED_KINDS = new Set(['character', 'crowd', 'scene', 'prop']);
const unknown = () => ({ status: 'unknown', changed: [] });

// 去掉 origin（端口、域名随配置变化），只比路径
function pathOf(url) {
  const text = String(url || '');
  try { return new URL(text).pathname; } catch (_) { return text; }
}

function storedRefs(row) {
  if (row.status !== 'completed' || !row.compiled_json) return null;
  try {
    const refs = JSON.parse(row.compiled_json).refs;
    if (!Array.isArray(refs)) return null;
    const compared = refs.filter((r) => r && COMPARED_KINDS.has(r.kind) && r.url);
    return compared.length ? compared : null;
  } catch (_) {
    return null;
  }
}

// 本分镜现在绑定的资产图；资产与模型能力无关，所以取任一片的目标即可。出错或不是结构化分镜返回 null。
function currentAssetPaths(db, storyboardId, row) {
  try {
    // 惰性引入：segmentCompileService → videoClient 一路会回到本模块的调用方，顶层引入会成环
    const { compileStoryboard } = require('./segmentCompileService');
    const target = { protocol: row.video_protocol, model: row.model, caps: getVideoCaps({ protocol: row.video_protocol, model: row.model, provider: row.provider }) };
    const r = compileStoryboard(db, storyboardId, { target });
    return r.ok ? new Set(r.compiled.assets.map((a) => pathOf(a.url))) : null;
  } catch (_) {
    return null;
  }
}

/**
 * @param {object[]} rows video_generations 行（需含 id、storyboard_id、status、compiled_json、video_protocol、model、provider）
 * @returns {Map<number, { status: 'current'|'stale'|'unknown', changed: { alias: string, kind: string }[] }>} 以行 id 为键
 */
function deriveDrift(db, rows) {
  const out = new Map();
  const current = new Map(); // storyboard_id → 当前资产路径集合（每个分镜只读一次）
  for (const row of rows) {
    const refs = row.storyboard_id != null ? storedRefs(row) : null;
    if (!refs) { out.set(row.id, unknown()); continue; }
    if (!current.has(row.storyboard_id)) current.set(row.storyboard_id, currentAssetPaths(db, row.storyboard_id, row));
    const assets = current.get(row.storyboard_id);
    if (!assets) { out.set(row.id, unknown()); continue; }
    const changed = refs.filter((r) => !assets.has(pathOf(r.url))).map((r) => ({ alias: r.alias, kind: r.kind }));
    out.set(row.id, changed.length ? { status: 'stale', changed } : { status: 'current', changed: [] });
  }
  return out;
}

module.exports = { deriveDrift };
