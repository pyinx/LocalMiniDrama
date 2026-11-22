'use strict';

const { createHash } = require('node:crypto');
const fs = require('node:fs');
const { assetImageReference } = require('./assetImageReference');
const { parseDramaMetadata } = require('../utils/dramaStyleMerge');
const { catalog, creativeGuidance, directionOf, projectCast, effectiveCast, scenarioFor, readLock } = require('./workbenchCreativeMethods');
const { resolveTake, publicMedia, localFile } = require('./workbenchTakeService');
const { episodeStoryboardRows } = require('./episodeStoryboardRows');
const { referenceRow } = require('./characterHeadBody');

function failure(status, message) { return Object.assign(new Error(message), { status }); }

function project(db, id) {
  const row = db.prepare('SELECT id, title, style, metadata FROM dramas WHERE id = ? AND deleted_at IS NULL').get(Number(id));
  if (!row) throw failure(404, '项目不存在');
  return row;
}

function checkEpisodeReplacement(db, episodeId) {
  const rows = db.prepare(`SELECT storyboard_number, creative_review_lock FROM storyboards
    WHERE episode_id = ? AND deleted_at IS NULL AND creative_review_lock IS NOT NULL ORDER BY storyboard_number`).all(Number(episodeId));
  const locked = rows.filter(row => {
    const lock = readLock(row.creative_review_lock);
    return Object.hasOwn(lock, 'dialogue') || Object.hasOwn(lock, 'visual');
  });
  if (locked.length) throw failure(409, '整集重建会替换锁定镜头 ' + locked.map(s => s.storyboard_number).join('、') + '。请在跨集复核中解除这些锁定，或只修改目标镜头。');
}

function updateDirection(db, id, body) {
  if (typeof body.enabled !== 'boolean' || typeof body.facts !== 'string' || body.facts.length > 4000) {
    throw failure(400, '请提供创作方法开关与 4000 字以内的项目事实');
  }
  return db.transaction(() => {
    const drama = project(db, id);
    const existing = directionOf(drama);
    if (body.revision !== existing.revision) throw failure(409, '项目事实或方法已经变化，请刷新后核对');
    const metadata = { ...parseDramaMetadata(drama) };
    metadata.creative_direction = { enabled: body.enabled, facts: body.facts.trim(), revision: existing.revision + 1 };
    db.prepare('UPDATE dramas SET metadata = ?, updated_at = ? WHERE id = ?')
      .run(JSON.stringify(metadata), new Date().toISOString(), drama.id);
    return metadata.creative_direction;
  })();
}

function activeAppearance(character, episodeNumber) {
  let stages;
  try { stages = JSON.parse(character.stages || '[]'); } catch { stages = []; }
  const active = Array.isArray(stages) ? stages.filter(stage => {
    const range = stage?.episode_range;
    return Array.isArray(range) && range.length === 2 && range[0] <= episodeNumber && episodeNumber <= range[1] && stage.appearance;
  }) : [];
  return active.length ? active.map(s => s.appearance).join(' / ') : character.appearance || '';
}

// Archives assign new database IDs and local filenames. Compare local image content
// and remote reference identities, keeping the displayed descriptions readable.
function visualSnapshot(shot, assets, cast) {
  const visual = [];
  const images = [];
  function addImage(label, reference) {
    if (!reference) return;
    if (!assets.imageDigests.has(reference)) {
      const { local, url } = assetImageReference(reference, assets.staticBase);
      const file = local && localFile(assets.storageRoot, local);
      const hash = createHash('sha256');
      if (file) hash.update(fs.readFileSync(file));
      else hash.update(url ? 'reference:' + url : 'missing:' + local);
      assets.imageDigests.set(reference, hash.digest('hex'));
    }
    images.push([label, assets.imageDigests.get(reference)]);
  }
  function add(row, parts, imageRow = row) {
    const label = parts.filter(Boolean).join(' · ');
    visual.push(label);
    addImage(label + ' · 主图', imageRow.local_path || imageRow.image_url);
    addImage(label + ' · 四视图', row.four_view_image_url);
  }
  for (const row of cast) {
    const project = row.storyboard_id == null;
    const appearance = project ? activeAppearance(row, shot.episode_number) : row.appearance || row.description;
    // 与生视频一致：本集落在某套造型范围内时，参考图是该造型图
    const imageRow = project ? referenceRow(row, assets.wardrobes.get(row.id) || [], shot.episode_number) : row;
    add(row, ['角色', row.name, appearance], imageRow);
  }
  const scene = assets.scenes.get(shot.scene_id);
  if (scene) add(scene, ['地点', scene.location, scene.time, scene.prompt]);
  for (const prop of assets.props.get(shot.id) || []) add(prop, ['道具', prop.name, prop.prompt || prop.description]);
  return { visual: visual.sort(), ...(images.length && { visual_images: images.sort() }) };
}

function projectAssets(db, id, storageRoot, staticBase) {
  const scenes = new Map(db.prepare(`SELECT id, location, time, prompt, local_path, image_url FROM scenes
    WHERE drama_id=? AND deleted_at IS NULL`).all(id).map(row => [row.id, row]));
  const props = new Map();
  for (const row of db.prepare(`SELECT sp.storyboard_id, p.name, p.description, p.prompt, p.local_path, p.image_url FROM props p
    JOIN storyboard_props sp ON sp.prop_id = p.id WHERE p.drama_id = ? AND p.deleted_at IS NULL ORDER BY p.id`).all(id)) {
    if (!props.has(row.storyboard_id)) props.set(row.storyboard_id, []);
    props.get(row.storyboard_id).push(row);
  }
  const wardrobes = new Map();
  for (const row of db.prepare(`SELECT w.* FROM character_wardrobes w JOIN characters c ON c.id = w.character_id
    WHERE c.drama_id = ? AND w.deleted_at IS NULL AND c.deleted_at IS NULL ORDER BY w.sort_order, w.id`).all(id)) {
    if (!wardrobes.has(row.character_id)) wardrobes.set(row.character_id, []);
    wardrobes.get(row.character_id).push(row);
  }
  return { ...projectCast(db, id), scenes, props, wardrobes, storageRoot, staticBase, imageDigests: new Map() };
}

function describeShot(shot, drama, assets) {
  const lock = readLock(shot.creative_review_lock);
  const cast = effectiveCast(shot, assets);
  const current = { dialogue: shot.dialogue || '', ...visualSnapshot(shot, assets, cast) };
  const changes = ['dialogue', 'visual'].filter(key => Object.hasOwn(lock, key) && JSON.stringify(lock[key]) !== JSON.stringify(current[key]));
  const imagesChanged = Object.hasOwn(lock, 'visual') && JSON.stringify(lock.visual_images || []) !== JSON.stringify(current.visual_images || []);
  if (imagesChanged && !changes.includes('visual')) changes.push('visual');
  const method = scenarioFor(shot, lock.method, cast.length);
  const guidance = creativeGuidance(drama, 'video', shot, cast.length);
  const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
  const creativeRevision = digest([current, method, shot.action, shot.description, guidance]);
  const reviewToken = digest([lock, creativeRevision]);
  return {
    id: shot.id, number: shot.storyboard_number, title: shot.title || '', current, changes, images_changed: imagesChanged,
    lock, method, method_label: catalog.scenarios[method].label, checks: guidance.checks, review_token: reviewToken,
    creative_revision: creativeRevision, approved: lock.approval === creativeRevision,
  };
}

function openMediaReviews(db, dramaId) {
  const byShot = new Map();
  const rows = db.prepare(`SELECT v.id AS take_id, v.storyboard_id, v.local_path, v.video_url,
      r.id, r.time_ms, r.note, r.action
    FROM video_take_reviews r JOIN video_generations v ON v.id = r.video_generation_id
    JOIN storyboards s ON s.id = v.storyboard_id JOIN episodes e ON e.id = s.episode_id
    WHERE e.drama_id = ? AND v.drama_id = e.drama_id AND e.deleted_at IS NULL AND s.deleted_at IS NULL
      AND v.deleted_at IS NULL AND v.status = 'completed' AND r.status = 'open'
    ORDER BY v.id DESC, r.time_ms, r.id`).all(dramaId);
  for (const row of rows) {
    if (!byShot.has(row.storyboard_id)) byShot.set(row.storyboard_id, new Map());
    const takes = byShot.get(row.storyboard_id);
    if (!takes.has(row.take_id)) {
      const media = publicMedia({ ...row, id: row.take_id });
      takes.set(row.take_id, { id: row.take_id, media, notes: [] });
    }
    takes.get(row.take_id).notes.push({ id: row.id, time_ms: row.time_ms, note: row.note, action: row.action });
  }
  return byShot;
}

function readWorkbench(db, id, storageRoot = './data/storage', staticBase = '') {
  const drama = project(db, id);
  const assets = projectAssets(db, drama.id, storageRoot, staticBase);
  const reviews = openMediaReviews(db, drama.id);
  const episodes = db.prepare(`SELECT id, episode_number AS number, title, TRIM(COALESCE(script_content, '')) != '' AS has_script
    FROM episodes WHERE drama_id = ? AND deleted_at IS NULL ORDER BY episode_number, id`).all(drama.id);
  for (const ep of episodes) {
    ep.shots = episodeStoryboardRows(db, ep.id).map(shot => {
      shot.episode_number = ep.number;
      const item = describeShot(shot, drama, assets);
      const current = resolveTake(db, shot);
      item.video_state = current?.local_path
        ? (localFile(storageRoot, current.local_path) ? 'local' : 'missing')
        : (current?.video_url ? 'remote' : 'missing');
      item.has_video = item.video_state !== 'missing';
      item.current_take_id = current?.id ?? null;
      item.adopted_id = shot.adopted_video_generation_id ?? null;
      const notes = reviews.get(shot.id);
      item.current_review = notes?.get(item.current_take_id) ?? null;
      item.history_reviews = notes ? [...notes.values()].filter(take => take.id !== item.current_take_id) : [];
      item.needs_review = item.changes.length > 0 || Boolean(item.current_review);
      return item;
    });
  }
  return {
    id: drama.id, title: drama.title, direction: directionOf(drama), version: catalog.version,
    methods: Object.entries(catalog.scenarios).map(([id, item]) => ({ id, label: item.label })), episodes,
  };
}

function reviewShot(db, dramaId, id, body, storageRoot = './data/storage', staticBase = '') {
  return db.transaction(() => {
    const drama = project(db, dramaId);
    const shot = db.prepare(`SELECT s.*, e.episode_number FROM storyboards s JOIN episodes e ON s.episode_id = e.id
      WHERE s.id = ? AND e.drama_id = ? AND e.deleted_at IS NULL AND s.deleted_at IS NULL`).get(Number(id), drama.id);
    if (!shot) throw failure(404, '分镜不属于当前作品');
    const item = describeShot(shot, drama, projectAssets(db, drama.id, storageRoot, staticBase));
    if (item.review_token !== body.review_token) throw failure(409, '镜头内容或已确认的事实发生变化，请刷新再确认');
    const lock = { ...item.lock };
    if (body.action === 'approve') {
      if (!item.checks.length) throw failure(400, '请先启用创作方法');
      lock.approval = item.creative_revision;
    } else if (body.action === 'method') {
      if (body.method !== 'auto' && !Object.hasOwn(catalog.scenarios, body.method)) throw failure(400, '未知创作方法');
      if (body.method === 'auto') delete lock.method;
      else lock.method = body.method;
    } else {
      if (!['dialogue', 'visual'].includes(body.field)) throw failure(400, '请选择对白或外观');
      if (body.action === 'accept') lock[body.field] = item.current[body.field];
      else if (body.action === 'unlock') delete lock[body.field];
      else throw failure(400, '未知复核操作');
      if (body.field === 'visual') {
        if (body.action === 'accept' && item.current.visual_images) lock.visual_images = item.current.visual_images;
        else delete lock.visual_images;
      }
    }
    // updated_at also participates in legacy media selection; reviewing text must not change it.
    db.prepare('UPDATE storyboards SET creative_review_lock = ? WHERE id = ?').run(JSON.stringify(lock), shot.id);
  })();
}

module.exports = { readWorkbench, reviewShot, updateDirection, checkEpisodeReplacement };
