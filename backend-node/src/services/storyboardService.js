// 分镜：create, update, delete；帧提示词 get/save
const { parseSegmentIr, readStoredIr, SEGMENT_IR_VERSION } = require('./segmentIr/schema');
const { planSegments } = require('./segmentIr/planner');
const {
  IR_OWNED_FIELDS,
  projectLegacyFields,
  ownedFieldChanges,
  SegmentIrOwnedError,
  SegmentIrInvalidError,
} = require('./segmentIr/project');

/**
 * 将分镜勾选的角色（dramas.characters 表 id）同步到 storyboard_characters（角色库 id），
 * 便于帧提示词与图生参考图与 UI 一致；按角色名匹配本剧或全局角色库。
 */
function parseDramaCharacterIds(charactersValue) {
  if (charactersValue === undefined || charactersValue === null) return null;
  if (Array.isArray(charactersValue)) {
    return charactersValue
      .map((x) => Number(typeof x === 'object' && x != null ? x.id : x))
      .filter((n) => Number.isFinite(n));
  }
  if (typeof charactersValue === 'string') {
    try {
      const arr = JSON.parse(charactersValue);
      if (!Array.isArray(arr)) return [];
      return arr
        .map((x) => Number(typeof x === 'object' && x != null ? x.id : x))
        .filter((n) => Number.isFinite(n));
    } catch (_) {
      return [];
    }
  }
  return [];
}

function syncStoryboardCharacterLinks(db, storyboardId, dramaCharacterIds) {
  const sid = Number(storyboardId);
  db.prepare('DELETE FROM storyboard_characters WHERE storyboard_id = ?').run(sid);
  const ids = Array.isArray(dramaCharacterIds) ? dramaCharacterIds.map((n) => Number(n)).filter((n) => Number.isFinite(n)) : [];
  if (ids.length === 0) return;
  const sb = db.prepare(
    `SELECT e.drama_id FROM storyboards s JOIN episodes e ON e.id = s.episode_id WHERE s.id = ? AND s.deleted_at IS NULL`
  ).get(sid);
  const dramaId = sb?.drama_id != null ? Number(sb.drama_id) : null;
  const now = new Date().toISOString();
  const ins = db.prepare('INSERT OR IGNORE INTO storyboard_characters (storyboard_id, character_id, created_at) VALUES (?, ?, ?)');
  for (const cid of ids.slice(0, 20)) {
    const crow = db.prepare('SELECT name FROM characters WHERE id = ? AND deleted_at IS NULL').get(cid);
    const name = (crow?.name || '').trim();
    if (!name) continue;
    let lib = null;
    if (dramaId) {
      lib = db.prepare(
        'SELECT id FROM character_libraries WHERE deleted_at IS NULL AND drama_id = ? AND TRIM(name) = ? LIMIT 1'
      ).get(dramaId, name);
    }
    if (!lib) {
      lib = db.prepare(
        'SELECT id FROM character_libraries WHERE deleted_at IS NULL AND drama_id IS NULL AND TRIM(name) = ? LIMIT 1'
      ).get(name);
    }
    if (lib) ins.run(sid, lib.id, now);
  }
}

function createStoryboard(db, log, req) {
  const now = new Date().toISOString();
  const episodeId = Number(req.episode_id);
  const num = Number(req.storyboard_number ?? 0) || 0;
  const info = db.prepare(
    `INSERT INTO storyboards (episode_id, scene_id, storyboard_number, title, description, location, time, duration, dialogue, action, result, atmosphere, image_prompt, video_prompt, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)`
  ).run(
    episodeId,
    req.scene_id ?? null,
    num,
    req.title ?? null,
    req.description ?? null,
    req.location ?? null,
    req.time ?? null,
    req.duration ?? 0,
    req.dialogue ?? null,
    req.action ?? null,
    req.result ?? null,
    req.atmosphere ?? null,
    req.image_prompt ?? null,
    req.video_prompt ?? null,
    now,
    now
  );
  log.info('Storyboard created', { id: info.lastInsertRowid, episode_id: episodeId });
  return getStoryboardById(db, info.lastInsertRowid);
}

function updateStoryboard(db, log, id, req) {
  const row = db.prepare('SELECT * FROM storyboards WHERE id = ? AND deleted_at IS NULL').get(Number(id));
  if (!row) return null;
  if (row.segment_ir) {
    const changed = ownedFieldChanges(row, req);
    if (changed.length) throw new SegmentIrOwnedError(changed);
  }
  const allowed = ['title', 'description', 'location', 'time', 'duration', 'dialogue', 'narration', 'action', 'result', 'atmosphere', 'image_prompt', 'polished_prompt', 'video_prompt', 'scene_id', 'characters', 'composed_image', 'image_url', 'local_path', 'main_panel_idx', 'video_url', 'audio_local_path', 'narration_audio_local_path', 'status', 'shot_type', 'angle', 'angle_h', 'angle_v', 'angle_s', 'movement', 'segment_index', 'segment_title', 'creation_mode', 'universal_segment_text', 'layout_description', 'first_frame_image_id', 'last_frame_image_id', 'last_frame_image_url', 'last_frame_local_path'];
  const updates = [];
  const params = [];
  if (req.sound_source !== undefined) {
    const root = require('../config').loadConfig().storage?.local_path || './data/storage';
    updates.push('adopted_sound = ?');
    params.push(require('./episodeSound').selectSound(req.sound_source, req.audio_local_path ?? row.audio_local_path, root));
  }
  if (req.local_path !== undefined && req.local_path !== row.local_path && req.video_url === undefined) {
    const videoUrl = require('./workbenchTakeService').videoUrlBeforeFrameChange(db, row);
    if (videoUrl !== (row.video_url ?? null)) {
      updates.push('video_url = ?');
      params.push(videoUrl);
    }
  }
  // 前端可能传 character_ids，与 characters 统一：存为 JSON 字符串
  const charactersValue = req.character_ids !== undefined ? req.character_ids : req.characters;
  let parsedDramaCharIdsForSync = null;
  if (!row.segment_ir && charactersValue !== undefined) {
    updates.push('characters = ?');
    const jsonStr = Array.isArray(charactersValue) ? JSON.stringify(charactersValue) : (typeof charactersValue === 'string' ? charactersValue : '[]');
    params.push(jsonStr);
    parsedDramaCharIdsForSync = parseDramaCharacterIds(charactersValue) ?? [];
  }
  for (const key of allowed) {
    if (key === 'characters' || (row.segment_ir && IR_OWNED_FIELDS.includes(key))) continue;
    if (req[key] !== undefined) {
      updates.push(key + ' = ?');
      const val = req[key];
      params.push(val);
    }
  }
  if (updates.length === 0 && req.prop_ids === undefined) return getStoryboardById(db, id);
  if (updates.length > 0) {
    // Updating only the audio choice must preserve the effective legacy video selection.
    const soundOnly = updates.length === 1 && updates[0] === 'adopted_sound = ?';
    params.push(soundOnly ? row.updated_at : new Date().toISOString(), id);
    db.prepare('UPDATE storyboards SET ' + updates.join(', ') + ', updated_at = ? WHERE id = ?').run(...params);
  }
  // 角色勾选变更：只同步 storyboard_characters，不删除 frame_prompts。
  // 用户手动保存的首/尾帧提示词应保留；图生时 framePromptSanitize 会按当前勾选剔除未出场角色名。
  if (parsedDramaCharIdsForSync !== null) {
    try {
      syncStoryboardCharacterLinks(db, id, parsedDramaCharIdsForSync);
    } catch (e) {
      log.warn('syncStoryboardCharacterLinks failed', { id, message: e.message });
    }
  }
  // 道具关联：写入 storyboard_props 表
  if (req.prop_ids !== undefined) {
    const propIds = Array.isArray(req.prop_ids) ? req.prop_ids : [];
    db.prepare('DELETE FROM storyboard_props WHERE storyboard_id = ?').run(Number(id));
    const ins = db.prepare('INSERT OR IGNORE INTO storyboard_props (storyboard_id, prop_id) VALUES (?, ?)');
    for (const pid of propIds) ins.run(Number(id), Number(pid));
  }
  log.info('Storyboard updated', { id });
  return getStoryboardById(db, id);
}

/** 分镜是否由结构化 IR 管理 */
function hasSegmentIr(db, id) {
  const r = db.prepare('SELECT segment_ir FROM storyboards WHERE id = ? AND deleted_at IS NULL').get(Number(id));
  return !!(r && r.segment_ir);
}

/** 旧的通用生成/润色、按音频拆分等会改写 IR 所有字段的入口统一用它拦截 */
function assertNotSegmentIr(db, id) {
  if (hasSegmentIr(db, id)) throw new SegmentIrOwnedError([]);
}

/** AI 可能在等待期间失去写权限，所有权条件必须与最终写入在同一条 SQL 中。 */
function saveLegacyUniversalPrompt(db, id, text) {
  const result = db.prepare(`UPDATE storyboards SET universal_segment_text = ?, updated_at = ?
    WHERE id = ? AND deleted_at IS NULL AND (segment_ir IS NULL OR segment_ir = '')`)
    .run(text, new Date().toISOString(), id);
  if (result.changes) return true;
  assertNotSegmentIr(db, id);
  return false;
}

/**
 * 保存结构化分镜：校验 →（给了能力表时）单段规划 → 同一事务写入 IR 与投影字段 → 同步角色关联。
 * 单段规划只做台词耗时下限与时长对齐；需要拆段时原样保存并在 plan_findings 里提示重新规划。
 * @param {{ caps?: object }} [opts]
 * @returns 分镜 DTO（规划过则带 plan_findings）；分镜不存在返回 null；IR 不合法抛 SegmentIrInvalidError
 */
function saveSegmentIr(db, log, id, irInput, opts = {}) {
  const sid = Number(id);
  const exists = db.prepare('SELECT id FROM storyboards WHERE id = ? AND deleted_at IS NULL').get(sid);
  if (!exists) return null;
  const parsed = parseSegmentIr(irInput);
  if (!parsed.ok) throw new SegmentIrInvalidError(parsed.errors);
  let ir = parsed.ir;
  let planFindings = null;
  if (opts.caps) {
    const plan = planSegments([ir], opts.caps);
    planFindings = plan.findings;
    if (plan.segments.length === 1) ir = parseSegmentIr(plan.segments[0].ir).ir;
    else planFindings.push({ level: 'warn', code: 'needs_replan', where: {}, msg: `这一段按当前模型需要拆成 ${plan.segments.length} 段，请对本集执行重新规划` });
  }
  const p = projectLegacyFields(ir);
  const now = new Date().toISOString();
  db.transaction(() => {
    db.prepare(
      `UPDATE storyboards SET segment_ir = ?, segment_ir_version = ?, dialogue = ?, action = ?, duration = ?,
         shot_type = ?, movement = ?, characters = ?, scene_id = ?, updated_at = ? WHERE id = ?`
    ).run(JSON.stringify(ir), SEGMENT_IR_VERSION, p.dialogue, p.action, p.duration, p.shot_type, p.movement, p.characters, p.scene_id, now, sid);
    syncStoryboardCharacterLinks(db, sid, JSON.parse(p.characters));
  })();
  log.info('Storyboard segment IR saved', { id: sid, shots: ir.shots.length });
  const dto = getStoryboardById(db, sid);
  return planFindings ? { ...dto, plan_findings: planFindings } : dto;
}

function deleteStoryboard(db, log, id) {
  const now = new Date().toISOString();
  const result = db.prepare('UPDATE storyboards SET deleted_at = ? WHERE id = ? AND deleted_at IS NULL').run(now, Number(id));
  if (result.changes === 0) return false;
  log.info('Storyboard deleted', { id });
  return true;
}

function getStoryboardById(db, id) {
  const r = db.prepare('SELECT * FROM storyboards WHERE id = ? AND deleted_at IS NULL').get(Number(id));
  if (!r) return null;
  let characters = [];
  if (r.characters) {
    if (typeof r.characters === 'string') {
      try { characters = JSON.parse(r.characters); } catch (_) {}
    } else if (Array.isArray(r.characters)) characters = r.characters;
  }
  let propIds = [];
  try {
    const propLinks = db.prepare('SELECT prop_id FROM storyboard_props WHERE storyboard_id = ?').all(Number(id));
    propIds = propLinks.map((p) => p.prop_id);
  } catch (_) {}
  return {
    id: r.id,
    episode_id: r.episode_id,
    scene_id: r.scene_id,
    storyboard_number: r.storyboard_number,
    title: r.title,
    description: r.description,
    location: r.location,
    time: r.time,
    duration: r.duration ?? 0,
    dialogue: r.dialogue,
    narration: r.narration ?? null,
    action: r.action,
    result: r.result ?? null,
    atmosphere: r.atmosphere,
    image_prompt: r.image_prompt,
    polished_prompt: r.polished_prompt ?? null,
    video_prompt: r.video_prompt,
    shot_type: r.shot_type,
    angle: r.angle,
    angle_h: r.angle_h ?? null,
    angle_v: r.angle_v ?? null,
    angle_s: r.angle_s ?? null,
    movement: r.movement,
    segment_index: r.segment_index ?? 0,
    segment_title: r.segment_title ?? null,
    creation_mode: r.creation_mode === 'universal' ? 'universal' : 'classic',
    universal_segment_text: r.universal_segment_text ?? null,
    layout_description: r.layout_description ?? null,
    first_frame_image_id: r.first_frame_image_id ?? null,
    last_frame_image_id: r.last_frame_image_id ?? null,
    last_frame_image_url: r.last_frame_image_url ?? null,
    last_frame_local_path: r.last_frame_local_path ?? null,
    characters,
    segment_ir: readStoredIr(r.segment_ir),
    prop_ids: propIds,
    composed_image: r.composed_image,
    image_url: r.image_url ?? null,
    local_path: r.local_path ?? null,
    main_panel_idx: r.main_panel_idx != null ? Number(r.main_panel_idx) : null,
    video_url: r.video_url,
    ...require('./workbenchTakeService').selectionFields(db, r),
    sound_source: require('./episodeSound').soundOf(r)?.source ?? 'auto',
    audio_local_path: r.audio_local_path ?? null,
    narration_audio_local_path: r.narration_audio_local_path ?? null,
    status: r.status || 'pending',
    created_at: r.created_at,
    updated_at: r.updated_at,
  };
}

function getFramePrompts(db, storyboardId) {
  const rows = db.prepare(
    'SELECT * FROM frame_prompts WHERE storyboard_id = ? ORDER BY created_at ASC'
  ).all(Number(storyboardId));
  return rows.map((r) => ({
    id: r.id,
    storyboard_id: r.storyboard_id,
    frame_type: r.frame_type,
    prompt: r.prompt,
    description: r.description,
    layout: r.layout,
    created_at: r.created_at,
    updated_at: r.updated_at,
  }));
}

function saveFramePrompt(db, log, storyboardId, frameType, prompt, description, layout) {
  const now = new Date().toISOString();
  const existing = db.prepare('SELECT id FROM frame_prompts WHERE storyboard_id = ? AND frame_type = ?').get(Number(storyboardId), frameType);
  if (existing) {
    db.prepare('UPDATE frame_prompts SET prompt = ?, description = ?, layout = ?, updated_at = ? WHERE id = ?').run(
      prompt,
      description ?? null,
      layout ?? null,
      now,
      existing.id
    );
    return getFramePrompts(db, storyboardId);
  }
  db.prepare(
    `INSERT INTO frame_prompts (storyboard_id, frame_type, prompt, description, layout, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(Number(storyboardId), frameType, prompt, description ?? null, layout ?? null, now, now);
  log.info('Frame prompt saved', { storyboard_id: storyboardId, frame_type: frameType });
  return getFramePrompts(db, storyboardId);
}

/** 在指定分镜前插入一个空白分镜：先把同 episode 中 number >= target 的全部 +1，再创建新分镜 */
function insertBeforeStoryboard(db, log, targetId) {
  const target = db.prepare(
    'SELECT id, episode_id, storyboard_number, segment_index, segment_title FROM storyboards WHERE id = ? AND deleted_at IS NULL'
  ).get(Number(targetId));
  if (!target) return null;

  db.prepare(
    'UPDATE storyboards SET storyboard_number = storyboard_number + 1, updated_at = ? WHERE episode_id = ? AND storyboard_number >= ? AND deleted_at IS NULL'
  ).run(new Date().toISOString(), target.episode_id, target.storyboard_number);

  const now = new Date().toISOString();
  const info = db.prepare(
    `INSERT INTO storyboards (episode_id, storyboard_number, segment_index, segment_title, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'pending', ?, ?)`
  ).run(target.episode_id, target.storyboard_number, target.segment_index ?? null, target.segment_title ?? null, now, now);

  log.info('Storyboard inserted before', { new_id: info.lastInsertRowid, before_id: targetId });
  return getStoryboardById(db, info.lastInsertRowid);
}

module.exports = {
  parseDramaCharacterIds,
  hasSegmentIr,
  assertNotSegmentIr,
  saveLegacyUniversalPrompt,
  saveSegmentIr,
  createStoryboard,
  insertBeforeStoryboard,
  updateStoryboard,
  deleteStoryboard,
  getStoryboardById,
  getFramePrompts,
  saveFramePrompt,
};
