/**
 * 角色头身分离：头是身份，只生成一次；身体是造型，可以有多套。
 * 交给视频与分镜的参考图是「头 + 当前身体」的拼合，由程序拼出，脸在所有造型里像素一致。
 * 拼合图路径只由头和身体的路径决定，所以「是否处于头身模式」可以从主图路径推导，不另存开关。
 */
const path = require('path');
const fs = require('fs');
const { createHash } = require('crypto');
const imageClient = require('./imageClient');
const A = require('./segmentCompile/rules/assetPhrases');
const { deriveStyleSentences } = require('./segmentCompile/style');
const { mergeCfgStyleWithDrama } = require('../utils/dramaStyleMerge');
const { storageRoot, toPublicUrl, assertInsideStorage } = require('../utils/storagePaths');
const seedance2AssetGuards = require('../utils/seedance2AssetGuards');

const SHEET_HEIGHT = 1024;
const GAP = 32;
// 视频接口对参考图宽高比有上限（Seedance 2.0 为 0.4–2.5），超出时上下补底色
const MAX_RATIO = 2.4;
const BACKGROUND = { r: 242, g: 242, b: 242, alpha: 1 };

function codedError(code, message) {
  return Object.assign(new Error(message), { code });
}

// 同一角色同时只跑一条头身生成链：重复提交会多付一轮生图费用，还可能拼出不配对的头和身体。
// 生图任务本身在本进程内执行，所以占用记录也只放在内存里；卡住的任务 15 分钟后放行。
const BUSY_TTL_MS = 15 * 60 * 1000;
const inFlight = new Map();

function claim(characterId) {
  const at = inFlight.get(characterId);
  if (at && Date.now() - at < BUSY_TTL_MS) throw codedError('busy', '这个角色的头身图正在生成，请等它完成');
  inFlight.set(characterId, Date.now());
  return () => inFlight.delete(characterId);
}

function staticUrl(rel) {
  return rel ? '/static/' + String(rel).replace(/^\/+/, '') : null;
}

/** 拼合图的存储相对路径：与头像同目录，文件名由头和身体的路径散列得出 */
function composedPath(headRel, bodyRel) {
  if (!headRel || !bodyRel) return null;
  const digest = createHash('sha256').update(`${headRel}\n${bodyRel}`).digest('hex').slice(0, 16);
  return path.posix.join(path.posix.dirname(String(headRel).replace(/\\/g, '/')), `hb_${digest}.png`);
}

/** 角色（或角色库条目）当前主图就是它头和身体的拼合图 */
function isHeadBody(row) {
  const p = row && composedPath(row.head_local_path, row.body_local_path);
  return !!p && row.local_path === p;
}

/** 左格头像、右格身体三视图，统一高度，浅灰底，无文字，宽高比不超过 MAX_RATIO；同一对输入总是落到同一路径 */
async function composeSheet(cfg, headRel, bodyRel) {
  const sharp = require('sharp');
  const rel = composedPath(headRel, bodyRel);
  if (!rel) throw codedError('head_body_missing', '缺少头像或身体图');
  const root = storageRoot(cfg);
  const file = (r) => assertInsideStorage(cfg, path.join(root, r));
  const out = file(rel);
  // 头和身体文件生成后不再改写，同一对输入的拼合图内容不变；已存在就直接用，不重写正在被读取的文件
  if (fs.existsSync(out)) return rel;
  const head = await sharp(file(headRel)).resize({ height: SHEET_HEIGHT }).png().toBuffer({ resolveWithObject: true });
  const body = await sharp(file(bodyRel)).resize({ height: SHEET_HEIGHT }).png().toBuffer({ resolveWithObject: true });
  fs.mkdirSync(path.dirname(out), { recursive: true });
  const tmp = `${out}.${process.pid}.${Date.now()}.tmp`;
  const width = head.info.width + GAP + body.info.width;
  const height = Math.max(SHEET_HEIGHT, Math.ceil(width / MAX_RATIO));
  const top = Math.floor((height - SHEET_HEIGHT) / 2);
  await sharp({ create: { width, height, channels: 4, background: BACKGROUND } })
    .composite([{ input: head.data, left: 0, top }, { input: body.data, left: head.info.width + GAP, top }])
    .png()
    .toFile(tmp);
  fs.renameSync(tmp, out);
  return rel;
}

// ---- 按集选用造型

function parseRange(raw) {
  if (Array.isArray(raw)) return raw;
  try { return raw ? JSON.parse(raw) : null; } catch (_) { return null; }
}

/** 集数范围 [a, b] 含两端，[a] 只含第 a 集；未设范围的造型不自动选用 */
function coversEpisode(rawRange, episodeNumber) {
  const r = parseRange(rawRange);
  if (!Array.isArray(r) || !r.length || !Number.isFinite(episodeNumber)) return false;
  const from = Number(r[0]);
  const to = Number(r[1] ?? r[0]);
  return from <= episodeNumber && episodeNumber <= to;
}

/** 本集适用的造型（按排序取第一个有图的），没有则为 null */
function wardrobeForEpisode(wardrobes, episodeNumber) {
  return (wardrobes || []).find((w) => (w.local_path || w.image_url) && coversEpisode(w.episode_range, Number(episodeNumber))) || null;
}

function listWardrobes(db, characterId) {
  return db
    .prepare('SELECT * FROM character_wardrobes WHERE character_id = ? AND deleted_at IS NULL ORDER BY sort_order, id')
    .all(Number(characterId));
}

/** 本集要用的参考图所在的行：本集造型，或角色主图 */
function referenceRow(character, wardrobes, episodeNumber) {
  return wardrobeForEpisode(wardrobes, episodeNumber) || character;
}

/** 给前端的本集造型摘要；用主图时为 null */
function episodeReference(db, character, episodeNumber) {
  const w = wardrobeForEpisode(listWardrobes(db, character.id), episodeNumber);
  return w ? { wardrobe_id: w.id, wardrobe_name: w.name, local_path: w.local_path || null, image_url: w.image_url || null } : null;
}

function episodeNumberOfStoryboard(db, storyboardId) {
  const row = db
    .prepare('SELECT e.episode_number FROM storyboards s JOIN episodes e ON e.id = s.episode_id WHERE s.id = ?')
    .get(Number(storyboardId));
  return row ? Number(row.episode_number) : null;
}

// ---- 写回

/** 拼合图写成角色主图：旧主图进历史图，Seedance 认证素材按主图变化处理 */
function writeMainImage(db, log, characterId, rel) {
  const prev = db
    .prepare('SELECT id, local_path, image_url, extra_images, seedance2_asset FROM characters WHERE id = ?')
    .get(Number(characterId));
  if (!prev || prev.local_path === rel) return;
  let extras = [];
  try { extras = prev.extra_images ? JSON.parse(prev.extra_images) : []; } catch (_) {}
  if (!Array.isArray(extras)) extras = [];
  const oldPath = prev.local_path || prev.image_url || '';
  if (oldPath && !extras.includes(oldPath)) extras.push(oldPath);
  const patch = { image_url: staticUrl(rel), local_path: rel };
  seedance2AssetGuards.markStaleOnCharacterMainImageDrift(db, log, prev, patch);
  db.prepare('UPDATE characters SET image_url = ?, local_path = ?, extra_images = ?, error_msg = NULL, updated_at = ? WHERE id = ?')
    .run(patch.image_url, rel, extras.length ? JSON.stringify(extras) : null, new Date().toISOString(), prev.id);
}

function writeWardrobeImage(db, wardrobeId, rel) {
  db.prepare('UPDATE character_wardrobes SET image_url = ?, local_path = ?, updated_at = ? WHERE id = ?')
    .run(staticUrl(rel), rel, new Date().toISOString(), Number(wardrobeId));
}

function loadCharacter(db, characterId) {
  return db.prepare('SELECT * FROM characters WHERE id = ? AND deleted_at IS NULL').get(Number(characterId));
}

/** 按当前的头重拼主图和所有带身体的造型 */
async function recompose(db, log, cfg, characterId) {
  const c = loadCharacter(db, characterId);
  if (!c || !c.head_local_path) return;
  if (c.body_local_path) writeMainImage(db, log, c.id, await composeSheet(cfg, c.head_local_path, c.body_local_path));
  for (const w of listWardrobes(db, c.id)) {
    if (w.body_local_path) writeWardrobeImage(db, w.id, await composeSheet(cfg, c.head_local_path, w.body_local_path));
  }
}

// ---- 生成

function styleOf(db, cfg, dramaId) {
  const drama = db.prepare('SELECT style, metadata FROM dramas WHERE id = ?').get(dramaId);
  return deriveStyleSentences((mergeCfgStyleWithDrama(cfg, drama || {}).style || {}).default_style_zh || '');
}

function describe(c) {
  return String(c.appearance || c.description || c.name || '').trim();
}

function headPrompt(c, style) {
  return [style.asset, A.headSheet(c.name), A.headSource + describe(c)].filter(Boolean).join('\n');
}

function bodyPrompt(c, style) {
  return [style.asset, A.bodyLead(c.name), A.bodySource + describe(c), A.headlessBodyLayout].filter(Boolean).join('\n');
}

function wardrobeBodyPrompt(c, wardrobe, style) {
  return [style.asset, A.bodyWardrobeLead(c.name), A.wardrobeChange(wardrobe.change_phrase), A.headlessBodyLayout].filter(Boolean).join('\n');
}

/**
 * 提交一张图；完成后把本地路径交给 then，失败记到角色的 error_msg。
 * 不传 character_id：头和身体都不是主图，不能让生图链路直接覆盖主图。
 */
function submit(db, log, c, opts, then) {
  const fail = (error) => {
    log.error('[头身分离] 失败', { character_id: c.id, error });
    db.prepare('UPDATE characters SET error_msg = ?, updated_at = ? WHERE id = ?').run(String(error).slice(0, 500), new Date().toISOString(), c.id);
    if (opts.onFail) opts.onFail();
  };
  return imageClient.createAndGenerateImage(db, log, {
    drama_id: c.drama_id,
    prompt: opts.prompt,
    model: opts.model || undefined,
    size: opts.size,
    quality: 'standard',
    provider: 'openai',
    user_negative_prompt: imageClient.resolveAssetUserNegativeForApi(opts.model, c.negative_prompt) || undefined,
    reference_image_urls: opts.refs && opts.refs.length ? opts.refs : undefined,
    storage_category: 'characters',
    on_completed: ({ local_path }) => {
      if (!local_path) return fail('图片已生成但未能保存到本地');
      return Promise.resolve(then(local_path)).catch((e) => fail(e.message));
    },
    on_failed: ({ error }) => fail(error),
  });
}

/**
 * part = all：生成头 → 以头为参考生成基础身体 → 拼合为主图（「转为头身分离」）
 * part = head：重新生成头，完成后重拼主图与所有造型
 * part = body：重新生成基础身体，完成后重拼主图
 * @returns {{ image_generation: object, prompt: string }}
 */
function generate(db, log, cfg, characterId, part, opts = {}) {
  if (!['all', 'head', 'body'].includes(part)) throw codedError('bad_part', 'part 须为 all、head 或 body');
  const c = loadCharacter(db, characterId);
  if (!c) throw codedError('not_found', '角色不存在');
  if (part === 'body' && !c.head_local_path) throw codedError('head_missing', '请先生成头像，身体要以它为参考');
  const done = claim(c.id);
  try {
    db.prepare('UPDATE characters SET error_msg = NULL WHERE id = ?').run(c.id);
    const style = styleOf(db, cfg, c.drama_id);
    const model = opts.model;

    const startBody = (headRel) => {
      const prompt = bodyPrompt(c, style);
      const imageGen = submit(db, log, c, { prompt, model, size: '1024x1024', refs: [toPublicUrl(cfg, null, headRel)], onFail: done }, async (bodyRel) => {
        db.prepare('UPDATE characters SET body_local_path = ?, updated_at = ? WHERE id = ?').run(bodyRel, new Date().toISOString(), c.id);
        await recompose(db, log, cfg, c.id);
        done();
      });
      return { image_generation: imageGen, prompt };
    };

    if (part === 'body') return startBody(c.head_local_path);

    const prompt = headPrompt(c, style);
    const imageGen = submit(db, log, c, { prompt, model, size: '1024x1024', onFail: done }, async (headRel) => {
      db.prepare('UPDATE characters SET head_local_path = ?, updated_at = ? WHERE id = ?').run(headRel, new Date().toISOString(), c.id);
      if (part === 'all') return startBody(headRel);
      await recompose(db, log, cfg, c.id);
      done();
    });
    return { image_generation: imageGen, prompt };
  } catch (e) {
    done();
    throw e;
  }
}

/**
 * 头身模式下的造型出图：只生成这套身体，参考为头和基础身体，完成后拼合为造型图。
 * 非头身角色返回 null，由调用方走原有的整张造型设定图。
 */
function generateWardrobeBody(db, log, cfg, wardrobe, opts = {}) {
  const c = loadCharacter(db, wardrobe.character_id);
  if (!c || !isHeadBody(c)) return null;
  const style = styleOf(db, cfg, c.drama_id);
  const prompt = wardrobeBodyPrompt(c, wardrobe, style);
  db.prepare('UPDATE character_wardrobes SET prompt = ?, updated_at = ? WHERE id = ?').run(prompt, new Date().toISOString(), wardrobe.id);
  const refs = [toPublicUrl(cfg, null, c.head_local_path), toPublicUrl(cfg, null, c.body_local_path)];
  const imageGen = submit(db, log, c, { prompt, model: opts.model, size: '1024x1024', refs }, async (bodyRel) => {
    db.prepare('UPDATE character_wardrobes SET body_local_path = ?, updated_at = ? WHERE id = ?').run(bodyRel, new Date().toISOString(), wardrobe.id);
    const head = loadCharacter(db, c.id)?.head_local_path;
    if (head) writeWardrobeImage(db, wardrobe.id, await composeSheet(cfg, head, bodyRel));
  });
  return { image_generation: imageGen, prompt };
}

module.exports = {
  composedPath,
  isHeadBody,
  composeSheet,
  coversEpisode,
  wardrobeForEpisode,
  listWardrobes,
  referenceRow,
  episodeReference,
  episodeNumberOfStoryboard,
  recompose,
  generate,
  generateWardrobeBody,
};
