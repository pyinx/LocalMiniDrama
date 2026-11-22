const takes = require('./workbenchTakeService');
const { episodeStoryboardRows } = require('./episodeStoryboardRows');
// 对应 Go application/services/drama_service.go
const { readStoredIr } = require('./segmentIr/schema');

const storageLayout = require('./storageLayout');
const { resolveStylePreset } = require('../constants/generationStylePresets');
const seedance2AssetGuards = require('../utils/seedance2AssetGuards');
const characterHeadBody = require('./characterHeadBody');

/**
 * 清理 image_url：如果数据库中存储的是 base64 data URL，则返回 null。
 * 图片应通过 local_path → /static/{local_path} 访问，base64 不应通过 API 透传（会严重膨胀响应体）。
 */
function sanitizeImageUrl(url) {
  if (!url) return null;
  if (String(url).startsWith('data:')) return null;
  return url;
}

function parseJsonColumn(value) {
  if (value == null || value === '') return null;
  if (typeof value === 'object') return value;
  try {
    return JSON.parse(value);
  } catch (_) {
    return null;
  }
}

function validateProjectStyle(db, style, metadata) {
  if (style !== 'custom') {
    delete metadata.custom_style;
  } else if (metadata.custom_style) {
    const library = require('./customStyleLibrary');
    library.validateSnapshot(metadata.custom_style);
    library.imageBytes(db, metadata.custom_style.image);
    if (!(metadata.style_prompt_zh || metadata.style_prompt_en || '').trim()) throw library.inputError('画风快照缺少正向提示词');
  }
}

function createDrama(db, log, req) {
  const now = new Date().toISOString();
  let meta = {};
  if (req.metadata) {
    try {
      meta =
        typeof req.metadata === 'string'
          ? JSON.parse(req.metadata)
          : { ...req.metadata };
    } catch (_) {
      meta = {};
    }
  }
  validateProjectStyle(db, req.style, meta);
  if (!meta.storage_folder_label) {
    meta.storage_folder_label = storageLayout.sanitizeFolderLabel(req.title || '');
  }
  const metadataStr = Object.keys(meta).length ? JSON.stringify(meta) : null;
  const stmt = db.prepare(`
    INSERT INTO dramas (title, description, genre, style, metadata, status, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, 'draft', ?, ?)
  `);
  const info = stmt.run(
    req.title || '',
    req.description || null,
    req.genre || null,
    req.style || 'realistic',
    metadataStr,
    now,
    now
  );
  const id = info.lastInsertRowid;
  log.info('Drama created', { drama_id: id });
  return getDramaById(db, id);
}

function getDramaById(db, id) {
  const row = db.prepare('SELECT * FROM dramas WHERE id = ? AND deleted_at IS NULL').get(id);
  return row ? rowToDrama(row) : null;
}

function getDrama(db, dramaId, baseUrl) {
  const drama = getDramaById(db, Number(dramaId));
  if (!drama) return null;
  // 加载 episodes、characters、scenes、props、storyboards（简化：只查当前 drama 的）
  const episodes = db.prepare(
    'SELECT * FROM episodes WHERE drama_id = ? AND deleted_at IS NULL ORDER BY episode_number ASC'
  ).all(drama.id);
  drama.episodes = episodes.map((e) => rowToEpisode(e));
  for (const ep of drama.episodes) {
    const storyboards = episodeStoryboardRows(db, ep.id);
    ep.storyboards = storyboards.map((s) => rowToStoryboard(s, db));
    // 批量加载 storyboard_props，附加到对应分镜
    try {
      const sbIds = ep.storyboards.map((s) => s.id);
      if (sbIds.length > 0) {
        const placeholders = sbIds.map(() => '?').join(',');
        const spRows = db.prepare(`SELECT storyboard_id, prop_id FROM storyboard_props WHERE storyboard_id IN (${placeholders})`).all(...sbIds);
        const spMap = {};
        for (const row of spRows) {
          if (!spMap[row.storyboard_id]) spMap[row.storyboard_id] = [];
          spMap[row.storyboard_id].push(row.prop_id);
        }
        for (const sb of ep.storyboards) {
          sb.prop_ids = spMap[sb.id] || [];
        }
      }
    } catch (_) {}
    ep.duration = ep.storyboards.reduce((sum, s) => sum + (s.duration || 0), 0);
    if (ep.duration > 0) ep.duration = Math.ceil(ep.duration / 60); // 转为分钟
    // 本集关联的角色（与 Go Preload("Episodes.Characters") 一致）
    try {
      const epChars = db.prepare(
        `SELECT c.* FROM characters c
         INNER JOIN episode_characters ec ON c.id = ec.character_id
         WHERE ec.episode_id = ? AND c.deleted_at IS NULL
         ORDER BY c.sort_order ASC, c.name ASC`
      ).all(ep.id);
      ep.characters = epChars.map((c) => ({ ...rowToCharacter(c), episode_reference: characterHeadBody.episodeReference(db, c, Number(ep.episode_number)) }));
    } catch (_) {
      ep.characters = [];
    }
    // 本集关联的场景（与 Go Preload("Episodes.Scenes") 一致，用于提取完成后展示）
    try {
      const epScenes = db.prepare(
        'SELECT * FROM scenes WHERE episode_id = ? AND deleted_at IS NULL ORDER BY id ASC'
      ).all(ep.id);
      ep.scenes = epScenes.map((s) => rowToScene(s));
    } catch (_) {
      ep.scenes = [];
    }
    // 本集关联的道具：本集提取的（episode_id=本集）+ 本集分镜中出现的（storyboard_props），合并去重
    try {
      const byEpisode = db.prepare(
        'SELECT * FROM props WHERE episode_id = ? AND deleted_at IS NULL ORDER BY id ASC'
      ).all(ep.id);
      const byStoryboard = db.prepare(
        `SELECT DISTINCT p.* FROM props p
         INNER JOIN storyboard_props sp ON p.id = sp.prop_id
         INNER JOIN storyboards sb ON sb.id = sp.storyboard_id AND sb.episode_id = ? AND sb.deleted_at IS NULL
         WHERE p.deleted_at IS NULL ORDER BY p.id ASC`
      ).all(ep.id);
      const seen = new Set();
      ep.props = [];
      for (const p of byEpisode) {
        if (!seen.has(p.id)) {
          seen.add(p.id);
          ep.props.push(rowToProp(p));
        }
      }
      for (const p of byStoryboard) {
        if (!seen.has(p.id)) {
          seen.add(p.id);
          ep.props.push(rowToProp(p));
        }
      }
      ep.props.sort((a, b) => a.id - b.id);
    } catch (_) {
      ep.props = [];
    }
  }
  const characters = db.prepare(
    'SELECT * FROM characters WHERE drama_id = ? AND deleted_at IS NULL ORDER BY sort_order ASC, name ASC'
  ).all(drama.id);
  drama.characters = characters.map((c) => rowToCharacter(c));
  const scenes = db.prepare(
    'SELECT * FROM scenes WHERE drama_id = ? AND deleted_at IS NULL ORDER BY id ASC'
  ).all(drama.id);
  drama.scenes = scenes.map((s) => rowToScene(s));
  const props = db.prepare(
    'SELECT * FROM props WHERE drama_id = ? AND deleted_at IS NULL ORDER BY id ASC'
  ).all(drama.id);
  drama.props = props.map((p) => rowToProp(p));
  return drama;
}

function listDramas(db, query) {
  let sql = 'FROM dramas WHERE deleted_at IS NULL';
  const params = [];
  if (query.status) {
    sql += ' AND status = ?';
    params.push(query.status);
  }
  if (query.genre) {
    sql += ' AND genre = ?';
    params.push(query.genre);
  }
  if (query.keyword) {
    sql += ' AND (title LIKE ? OR description LIKE ?)';
    const k = '%' + query.keyword + '%';
    params.push(k, k);
  }
  const countRow = db.prepare('SELECT COUNT(*) as total ' + sql).get(...params);
  const total = countRow.total || 0;
  const page = Math.max(1, parseInt(query.page, 10) || 1);
  const pageSize = Math.min(100, Math.max(1, parseInt(query.page_size, 10) || 20));
  const offset = (page - 1) * pageSize;
  const list = db.prepare(
    'SELECT * ' + sql + ' ORDER BY updated_at DESC LIMIT ? OFFSET ?'
  ).all(...params, pageSize, offset);
  const dramas = list.map((r) => rowToDrama(r));
  for (const d of dramas) {
    const episodes = db.prepare(
      'SELECT * FROM episodes WHERE drama_id = ? AND deleted_at IS NULL ORDER BY episode_number ASC'
    ).all(d.id);
    d.episodes = episodes.map((e) => {
      const ep = rowToEpisode(e);
      const storyboards = episodeStoryboardRows(db, ep.id);
      ep.storyboards = storyboards.map((s) => rowToStoryboard(s, db));
      try {
        const sbIds = ep.storyboards.map((s) => s.id);
        if (sbIds.length > 0) {
          const placeholders = sbIds.map(() => '?').join(',');
          const spRows = db.prepare(`SELECT storyboard_id, prop_id FROM storyboard_props WHERE storyboard_id IN (${placeholders})`).all(...sbIds);
          const spMap = {};
          for (const row of spRows) {
            if (!spMap[row.storyboard_id]) spMap[row.storyboard_id] = [];
            spMap[row.storyboard_id].push(row.prop_id);
          }
          for (const sb of ep.storyboards) sb.prop_ids = spMap[sb.id] || [];
        }
      } catch (_) {}
      ep.duration = ep.storyboards.reduce((sum, s) => sum + (s.duration || 0), 0);
      if (ep.duration > 0) ep.duration = Math.ceil(ep.duration / 60);
      return ep;
    });
  }
  return { dramas, total, page, pageSize };
}

function updateDrama(db, log, dramaId, req) {
  const drama = getDramaById(db, Number(dramaId));
  if (!drama) return null;
  const updates = [];
  const params = [];
  if (req.title != null) {
    updates.push('title = ?');
    params.push(req.title);
  }
  if (req.description != null) {
    updates.push('description = ?');
    params.push(req.description || null);
  }
  if (req.genre != null) {
    updates.push('genre = ?');
    params.push(req.genre || null);
  }
  if (req.status != null) {
    updates.push('status = ?');
    params.push(req.status);
  }
  if (updates.length === 0) return drama;
  params.push(new Date().toISOString(), dramaId);
  db.prepare(
    'UPDATE dramas SET ' + updates.join(', ') + ', updated_at = ? WHERE id = ?'
  ).run(...params);
  log.info('Drama updated', { drama_id: dramaId });
  return getDramaById(db, dramaId);
}

function generateStoryboard(db, log, episodeId, options) {
  const episodeStoryboardService = require('./episodeStoryboardService');
  const { model, style, storyboard_count, video_duration, aspect_ratio, include_narration, universal_omni_storyboard } = options || {};
  // 转换可能为字符串的数字
  const count = storyboard_count ? Number(storyboard_count) : undefined;
  const duration = video_duration ? Number(video_duration) : undefined;
  return episodeStoryboardService.generateStoryboard(
    db,
    log,
    episodeId,
    model || undefined,
    style,
    count,
    duration,
    aspect_ratio,
    include_narration,
    universal_omni_storyboard,
    options?.clip_duration_range
  );
}

function deleteDrama(db, log, dramaId) {
  const result = db.prepare('UPDATE dramas SET deleted_at = ? WHERE id = ? AND deleted_at IS NULL').run(
    new Date().toISOString(),
    Number(dramaId)
  );
  if (result.changes === 0) return false;
  log.info('Drama deleted', { drama_id: dramaId });
  return true;
}

function getDramaStats(db) {
  const total = db.prepare('SELECT COUNT(*) as c FROM dramas WHERE deleted_at IS NULL').get().c;
  const byStatus = db.prepare(
    'SELECT status, COUNT(*) as count FROM dramas WHERE deleted_at IS NULL GROUP BY status'
  ).all();
  return { total, by_status: byStatus };
}

function rowToDrama(r) {
  let metadata = r.metadata;
  if (typeof metadata === 'string') {
    try {
      metadata = JSON.parse(metadata);
    } catch (e) {
      metadata = {};
    }
  }
  return {
    id: r.id,
    title: r.title,
    description: r.description,
    genre: r.genre,
    style: r.style || 'realistic',
    total_episodes: r.total_episodes ?? 1,
    total_duration: r.total_duration ?? 0,
    status: r.status || 'draft',
    thumbnail: r.thumbnail,
    tags: r.tags,
    metadata: metadata || {},
    created_at: r.created_at,
    updated_at: r.updated_at,
  };
}

function rowToEpisode(r) {
  return {
    id: r.id,
    drama_id: r.drama_id,
    episode_number: r.episode_number,
    title: r.title,
    script_content: r.script_content,
    has_novel_source: !!r.novel_source,
    description: r.description,
    duration: r.duration ?? 0,
    status: r.status || 'draft',
    video_url: r.video_url,
    thumbnail: r.thumbnail,
    created_at: r.created_at,
    updated_at: r.updated_at,
  };
}

function parseStoryboardCharacters(charactersStr) {
  if (!charactersStr || typeof charactersStr !== 'string') return [];
  try {
    const parsed = JSON.parse(charactersStr);
    if (!Array.isArray(parsed)) return [];
    return parsed.map((c) => (typeof c === 'object' && c != null && c.id != null ? Number(c.id) : Number(c))).filter((n) => Number.isFinite(n));
  } catch (_) {
    return [];
  }
}

function rowToStoryboard(r, db) {
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
    continuity_snapshot: r.continuity_snapshot ?? null,
    video_prompt: r.video_prompt,
      shot_type: r.shot_type ?? null,
      angle: r.angle ?? null,
      angle_h: r.angle_h ?? null,
      angle_v: r.angle_v ?? null,
      angle_s: r.angle_s ?? null,
      movement: r.movement ?? null,
      lighting_style: r.lighting_style ?? null,
      depth_of_field: r.depth_of_field ?? null,
      segment_index: r.segment_index ?? 0,
      segment_title: r.segment_title ?? null,
      creation_mode: r.creation_mode === 'universal' ? 'universal' : 'classic',
      universal_segment_text: r.universal_segment_text ?? null,
      segment_ir: readStoredIr(r.segment_ir),
      first_frame_image_id: r.first_frame_image_id ?? null,
      last_frame_image_id: r.last_frame_image_id ?? null,
      last_frame_image_url: sanitizeImageUrl(r.last_frame_image_url),
      last_frame_local_path: r.last_frame_local_path ?? null,
      characters: parseStoryboardCharacters(r.characters),
      composed_image: r.composed_image,
      image_url: sanitizeImageUrl(r.image_url),
      local_path: r.local_path ?? null,
      main_panel_idx: r.main_panel_idx != null ? Number(r.main_panel_idx) : null,
      video_url: r.video_url,
      ...takes.selectionFields(db, r),
      sound_source: require('./episodeSound').soundOf(r)?.source ?? 'auto',
      audio_local_path: r.audio_local_path ?? null,
      narration_audio_local_path: r.narration_audio_local_path ?? null,
      status: r.status || 'pending',
      error_msg: r.error_msg,
      created_at: r.created_at,
      updated_at: r.updated_at,
    };
}

function rowToCharacter(r) {
  return {
    id: r.id,
    drama_id: r.drama_id,
    name: r.name,
    role: r.role,
    description: r.description,
    appearance: r.appearance,
    stages: r.stages ?? null,
    personality: r.personality,
    voice_style: r.voice_style,
    is_group: !!r.is_group,
    tts_voice: r.tts_voice ?? null,
    image_url: sanitizeImageUrl(r.image_url),
    local_path: r.local_path,
    extra_images: r.extra_images || null,
    ref_image: r.ref_image || null,
    reference_images: r.reference_images,
    seed_value: r.seed_value,
    sort_order: r.sort_order ?? 0,
    error_msg: r.error_msg,
    polished_prompt: r.polished_prompt || null,
    negative_prompt: r.negative_prompt || null,
    four_view_image_url: r.four_view_image_url || null,
    head_local_path: r.head_local_path || null,
    body_local_path: r.body_local_path || null,
    head_body: characterHeadBody.isHeadBody(r),
    seedance2_asset: parseJsonColumn(r.seedance2_asset),
    seedance2_voice_asset: parseJsonColumn(r.seedance2_voice_asset),
    created_at: r.created_at,
    updated_at: r.updated_at,
  };
}

function rowToScene(r) {
  return {
    id: r.id,
    drama_id: r.drama_id,
    location: r.location,
    time: r.time,
    prompt: r.prompt,
    polished_prompt: r.polished_prompt || null,
    negative_prompt: r.negative_prompt || null,
    storyboard_count: r.storyboard_count ?? 1,
    image_url: sanitizeImageUrl(r.image_url),
    local_path: r.local_path,
    extra_images: r.extra_images || null,
    ref_image: r.ref_image || null,
    status: r.status || 'pending',
    error_msg: r.error_msg,
    created_at: r.created_at,
    updated_at: r.updated_at,
  };
}

function rowToProp(r) {
  return {
    id: r.id,
    drama_id: r.drama_id,
    name: r.name,
    type: r.type,
    description: r.description,
    prompt: r.prompt,
    image_url: sanitizeImageUrl(r.image_url),
    local_path: r.local_path,
    extra_images: r.extra_images || null,
    ref_image: r.ref_image || null,
    negative_prompt: r.negative_prompt || null,
    error_msg: r.error_msg,
    created_at: r.created_at,
    updated_at: r.updated_at,
  };
}

function saveOutline(db, log, dramaId, req) {
  const drama = getDramaById(db, Number(dramaId));
  if (!drama) return false;
  const now = new Date().toISOString();
  const tagsStr = Array.isArray(req.tags) ? JSON.stringify(req.tags) : null;
  // Merge new metadata with existing metadata
  let existingMetadata = {};
  if (drama.metadata) {
    try {
      existingMetadata = typeof drama.metadata === 'string' ? JSON.parse(drama.metadata) : drama.metadata;
    } catch (e) {
      existingMetadata = {};
    }
  }
  let newMetadata = {};
  if (req.metadata) {
    try {
      newMetadata = { ...(typeof req.metadata === 'string' ? JSON.parse(req.metadata) : req.metadata) };
    } catch (e) {
      newMetadata = {};
    }
  }
  // Project direction has its own optimistic update contract. Old outline forms
  // can submit cached metadata, including an earlier review revision.
  delete newMetadata.creative_direction;
  const mergedMetadata = { ...existingMetadata, ...newMetadata };

  // 与 mergeCfgStyleWithDrama 一致：提示词优先读 metadata.style_prompt_*。仅改 dramas.style 而不带画风长文案时，
  // 若仍保留旧的 metadata 画风，会出现「列表/首页 badge 已是新 style，角色提示词却仍用旧画风」。
  if (req.style !== undefined) {
    const styleVal = String(req.style || '').trim();
    const hasExplicitStylePrompt =
      req.metadata &&
      typeof req.metadata === 'object' &&
      !Array.isArray(req.metadata) &&
      ('style_prompt_zh' in req.metadata || 'style_prompt_en' in req.metadata);
    if (!hasExplicitStylePrompt && styleVal) {
      const preset = resolveStylePreset(styleVal);
      if (preset) {
        mergedMetadata.style_prompt_zh = preset.zh;
        mergedMetadata.style_prompt_en = preset.en;
      }
    }
  }

  validateProjectStyle(db, req.style === undefined ? drama.style : req.style, mergedMetadata);
  const metadataStr = JSON.stringify(mergedMetadata);
  
  db.prepare(
    `UPDATE dramas SET title = ?, description = ?, genre = ?, tags = ?, style = ?, metadata = ?, updated_at = ? WHERE id = ?`
  ).run(
    req.title || drama.title, 
    req.summary ?? drama.description, 
    req.genre !== undefined ? req.genre : drama.genre, 
    tagsStr, 
    req.style !== undefined ? req.style : drama.style, 
    metadataStr, 
    now, 
    dramaId
  );
  log.info('Outline saved', { drama_id: dramaId, style: req.style, genre: req.genre, metadata: mergedMetadata });
  return true;
}

function getCharacters(db, dramaId, episodeId) {
  const did = Number(dramaId);
  const drama = getDramaById(db, did);
  if (!drama) return null;
  let rows;
  if (episodeId) {
    const exists = db.prepare('SELECT 1 FROM episodes WHERE id = ? AND drama_id = ?').get(episodeId, did);
    if (!exists) return null;
    rows = db.prepare(
      `SELECT c.* FROM characters c
       INNER JOIN episode_characters ec ON ec.character_id = c.id
       WHERE ec.episode_id = ? AND c.deleted_at IS NULL ORDER BY c.sort_order ASC, c.name ASC`
    ).all(episodeId);
  } else {
    rows = db.prepare(
      'SELECT * FROM characters WHERE drama_id = ? AND deleted_at IS NULL ORDER BY sort_order ASC, name ASC'
    ).all(did);
  }
  const episodeNumber = episodeId
    ? Number(db.prepare('SELECT episode_number FROM episodes WHERE id = ?').get(episodeId)?.episode_number)
    : null;
  const characters = rows.map((r) => ({
    ...rowToCharacter(r),
    ...(episodeId && { episode_reference: characterHeadBody.episodeReference(db, r, episodeNumber) }),
  }));
  for (const c of characters) {
    const img = db.prepare(
      'SELECT status, error_msg FROM image_generations WHERE character_id = ? ORDER BY created_at DESC LIMIT 1'
    ).get(c.id);
    if (img && ['pending', 'processing', 'failed'].includes(img.status)) {
      c.image_generation_status = img.status;
      if (img.error_msg) c.image_generation_error = img.error_msg;
    }
  }
  return characters;
}

function saveCharacters(db, log, dramaId, req) {
  const did = Number(dramaId);
  const drama = getDramaById(db, did);
  if (!drama) return false;
  if (req.episode_id) {
    const ep = db.prepare('SELECT 1 FROM episodes WHERE id = ? AND drama_id = ?').get(req.episode_id, did);
    if (!ep) return false;
  }
  const characterIds = [];
  const chars = req.characters || [];
  for (const char of chars) {
    if (char.id) {
      const ex = db.prepare('SELECT id FROM characters WHERE id = ? AND drama_id = ?').get(char.id, did);
      if (ex) {
        characterIds.push(ex.id);
        // 只更新文本字段；image_url / local_path 仅在调用方显式传入时才覆盖，防止漏传字段清空已有图片
        const imgFields = [];
        const imgParams = [];
        if ('image_url' in char) { imgFields.push('image_url = ?'); imgParams.push(char.image_url ?? null); }
        if ('local_path' in char) { imgFields.push('local_path = ?'); imgParams.push(char.local_path ?? null); }
        if (imgFields.length > 0) {
          const prevC = db
            .prepare('SELECT id, local_path, image_url, seedance2_asset FROM characters WHERE id = ? AND deleted_at IS NULL')
            .get(char.id);
          if (prevC) {
            seedance2AssetGuards.markStaleOnCharacterMainImageDrift(db, log, prevC, {
              image_url: 'image_url' in char ? char.image_url : prevC.image_url,
              local_path: 'local_path' in char ? char.local_path : prevC.local_path,
            });
          }
        }
        const imgSql = imgFields.length > 0 ? ', ' + imgFields.join(', ') : '';
        let setCore = 'name = ?, role = ?, description = ?, personality = ?, appearance = ?';
        const coreParams = [char.name, char.role ?? null, char.description ?? null, char.personality ?? null, char.appearance ?? null];
        if ('negative_prompt' in char) {
          setCore += ', negative_prompt = ?';
          coreParams.push(char.negative_prompt ?? null);
        }
        db.prepare(
          `UPDATE characters SET ${setCore}${imgSql}, updated_at = ? WHERE id = ?`
        ).run(...coreParams, ...imgParams, new Date().toISOString(), char.id);
        continue;
      }
    }
    const byName = db.prepare('SELECT id FROM characters WHERE drama_id = ? AND name = ?').get(did, char.name);
    if (byName) {
      characterIds.push(byName.id);
      // 如果通过名字找到已存在的角色（包含软删除的），也要更新它的信息并复活
      const imgFieldsN = [];
      const imgParamsN = [];
      if ('image_url' in char) { imgFieldsN.push('image_url = ?'); imgParamsN.push(char.image_url ?? null); }
      if ('local_path' in char) { imgFieldsN.push('local_path = ?'); imgParamsN.push(char.local_path ?? null); }
      if (imgFieldsN.length > 0) {
        const prevN = db
          .prepare('SELECT id, local_path, image_url, seedance2_asset FROM characters WHERE id = ?')
          .get(byName.id);
        if (prevN) {
          seedance2AssetGuards.markStaleOnCharacterMainImageDrift(db, log, prevN, {
            image_url: 'image_url' in char ? char.image_url : prevN.image_url,
            local_path: 'local_path' in char ? char.local_path : prevN.local_path,
          });
        }
      }
      const imgSqlN = imgFieldsN.length > 0 ? ', ' + imgFieldsN.join(', ') : '';
      let setCoreN = 'role = ?, description = ?, personality = ?, appearance = ?';
      const coreParamsN = [char.role ?? null, char.description ?? null, char.personality ?? null, char.appearance ?? null];
      if ('negative_prompt' in char) {
        setCoreN += ', negative_prompt = ?';
        coreParamsN.push(char.negative_prompt ?? null);
      }
      db.prepare(
        `UPDATE characters SET ${setCoreN}${imgSqlN}, updated_at = ?, deleted_at = NULL WHERE id = ?`
      ).run(...coreParamsN, ...imgParamsN, new Date().toISOString(), byName.id);
      continue;
    }
    const now = new Date().toISOString();
    const info = db.prepare(
      `INSERT INTO characters (drama_id, name, role, description, personality, appearance, image_url, local_path, negative_prompt, sort_order, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)`
    ).run(did, char.name, char.role ?? null, char.description ?? null, char.personality ?? null, char.appearance ?? null, char.image_url ?? null, char.local_path ?? null, char.negative_prompt ?? null, now, now);
    characterIds.push(info.lastInsertRowid);
  }
  if (req.episode_id && characterIds.length > 0) {
    db.prepare('DELETE FROM episode_characters WHERE episode_id = ?').run(req.episode_id);
    const ins = db.prepare('INSERT OR IGNORE INTO episode_characters (episode_id, character_id) VALUES (?, ?)');
    for (const cid of characterIds) ins.run(req.episode_id, cid);
  }
  db.prepare('UPDATE dramas SET updated_at = ? WHERE id = ?').run(new Date().toISOString(), did);
  log.info('Characters saved', { drama_id: dramaId, count: chars.length });
  return true;
}

function saveEpisodes(db, log, dramaId, req) {
  const did = Number(dramaId);
  const drama = getDramaById(db, did);
  if (!drama) return false;
  const episodes = req.episodes || [];
  const now = new Date().toISOString();

  // 按 episode_number upsert：保留已有分集的 id，避免关联数据（角色/场景/道具/分镜）孤岛化
  const keptNumbers = new Set();
  for (const ep of episodes) {
    const num = ep.episode_number ?? 0;
    keptNumbers.add(num);
    // 查找已有的（包含软删除的，以防重新激活）
    const existing = db.prepare(
      'SELECT id FROM episodes WHERE drama_id = ? AND episode_number = ? ORDER BY deleted_at IS NOT NULL ASC, id ASC LIMIT 1'
    ).get(did, num);
    if (existing) {
      // 更新已有分集，保留 id
      db.prepare(
        `UPDATE episodes SET title = ?, script_content = ?, description = ?, duration = ?, deleted_at = NULL, updated_at = ? WHERE id = ?`
      ).run(ep.title || '', ep.script_content ?? null, ep.description ?? null, ep.duration ?? 0, now, existing.id);
    } else {
      // 新增
      db.prepare(
        `INSERT INTO episodes (drama_id, episode_number, title, script_content, description, duration, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, 'draft', ?, ?)`
      ).run(did, num, ep.title || '', ep.script_content ?? null, ep.description ?? null, ep.duration ?? 0, now, now);
    }
  }

  // 软删除本次未提交的分集（如用户删掉了某一集）
  const liveEpisodes = db.prepare(
    'SELECT id, episode_number FROM episodes WHERE drama_id = ? AND deleted_at IS NULL'
  ).all(did);
  for (const row of liveEpisodes) {
    if (!keptNumbers.has(row.episode_number)) {
      db.prepare('UPDATE episodes SET deleted_at = ? WHERE id = ?').run(now, row.id);
    }
  }

  db.prepare('UPDATE dramas SET updated_at = ? WHERE id = ?').run(now, did);
  log.info('Episodes saved', { drama_id: dramaId, count: episodes.length });
  return true;
}

function saveProgress(db, log, dramaId, req) {
  const drama = getDramaById(db, Number(dramaId));
  if (!drama) return false;
  // getDramaById 已通过 rowToDrama 把 metadata 解析为对象，不能对 object 再 JSON.parse，否则进 catch 得到 {} 会整表覆盖掉画风等字段
  const meta = storageLayout.parseMetadata(drama.metadata);
  meta.current_step = req.current_step;
  if (req.step_data) meta.step_data = req.step_data;
  const now = new Date().toISOString();
  db.prepare('UPDATE dramas SET metadata = ?, updated_at = ? WHERE id = ?').run(JSON.stringify(meta), now, dramaId);
  log.info('Progress saved', { drama_id: dramaId, step: req.current_step });
  return true;
}

/** 保存画布布局 / 工作流组到 metadata（合并现有 metadata） */
function saveCanvasLayout(db, log, dramaId, req) {
  const drama = getDramaById(db, Number(dramaId));
  if (!drama) return null;
  const layout = req?.canvas_layout;
  const workflowGroups = req?.workflow_groups;
  if (
    (layout == null || typeof layout !== 'object' || Array.isArray(layout)) &&
    workflowGroups === undefined
  ) {
    const err = new Error('请提供 canvas_layout 或 workflow_groups');
    err.code = 'BAD_REQUEST';
    throw err;
  }
  if (layout != null && (typeof layout !== 'object' || Array.isArray(layout))) {
    const err = new Error('canvas_layout 必须为对象');
    err.code = 'BAD_REQUEST';
    throw err;
  }
  if (workflowGroups !== undefined && !Array.isArray(workflowGroups)) {
    const err = new Error('workflow_groups 必须为数组');
    err.code = 'BAD_REQUEST';
    throw err;
  }
  const meta = storageLayout.parseMetadata(drama.metadata);
  if (layout) meta.canvas_layout = layout;
  if (workflowGroups !== undefined) meta.workflow_groups = workflowGroups;
  const now = new Date().toISOString();
  db.prepare('UPDATE dramas SET metadata = ?, updated_at = ? WHERE id = ?').run(JSON.stringify(meta), now, dramaId);
  log.info('Canvas state saved', {
    drama_id: dramaId,
    node_count: layout ? Object.keys(layout.nodes || {}).length : undefined,
    workflow_group_count: workflowGroups ? workflowGroups.length : undefined,
  });
  return getDrama(db, dramaId);
}

/**
 * 为合成器解析当前采用片的媒体地址。
 */
function takeUrl(selected, baseUrl) {
  if (selected?.local_path) return (baseUrl || '/static').replace(/\/$/, '') + '/' + selected.local_path.replace(/^\/+/, '');
  return selected?.video_url || null;
}

function getVideoUrlForStoryboard(db, storyboardId, baseUrl) {
  const sb = db.prepare('SELECT * FROM storyboards WHERE id=? AND deleted_at IS NULL').get(storyboardId);
  return takeUrl(takes.resolveTake(db,sb),baseUrl);
}

function localVideoDigest(root,take) {
  const file = takes.localFile(root,take?.local_path);
  return file ? require('./episodeSound').mediaDigest(file) : null;
}

function episodeDeliveryInputs(db, episodeId, baseUrl, options = {}) {
  const root = require('../config').loadConfig().storage?.local_path || './data/storage';
  const boards = episodeStoryboardRows(db, episodeId);
  return boards.map((sb, order) => {
    const take = takes.resolveTake(db,sb);
    return {
      scene_id: sb.id, storyboard_number: sb.storyboard_number, order,
      take_id: sb.adopted_video_generation_id ?? null, effective_take_id: take?.id ?? null,
      video_url: takeUrl(take,baseUrl), duration: Number(sb.duration) || 5,
      ...(options.delivery_mode === 'complete' && { video_digest: localVideoDigest(root,take) }),
      ...(sb.segment_ir && {segment_ir:sb.segment_ir}),
      sound: require('./episodeSound').soundSnapshot(sb, options, root),
    };
  });
}

function finalizeEpisode(db, log, episodeId, baseUrl, body = {}, audition = null) {
  const ep = db.prepare('SELECT id, drama_id, episode_number FROM episodes WHERE id = ? AND deleted_at IS NULL').get(episodeId);
  if (!ep) return null;
  const drama = db.prepare('SELECT title, metadata FROM dramas WHERE id = ? AND deleted_at IS NULL').get(ep.drama_id);
  const videoMergeService = require('./videoMergeService');
  const title = `${drama?.title || '项目 ' + ep.drama_id} - 第${ep.episode_number ?? episodeId}集`;
  const plan = require('./episodeCutPlan').readPlan(db, episodeId);
  const mode = body.delivery_mode ?? (plan.cuts.length ? 'complete' : undefined);
  let aspectRatio;
  try { aspectRatio = JSON.parse(drama?.metadata || '{}').aspect_ratio; } catch (_) {}
  if (mode != null && !['complete', 'draft'].includes(mode)) return { error: '未知的交付模式' };
  const inputs = episodeDeliveryInputs(db, episodeId, baseUrl, {...body,delivery_mode:mode});
  const missing = inputs.filter(sc => !sc.video_url).map(sc => sc.storyboard_number ?? sc.scene_id);
  const message = missing.length ? `${title}：第 ${missing.join('、')} 镜缺少视频` : '';
  if (missing.length && plan.cuts.length) {
    const absent = new Set(inputs.filter(s => !s.video_url).map(s => s.scene_id));
    require('./episodeCutPlan').markPending(db,episodeId,plan,plan.cuts.filter(c => absent.has(c.left.id) || absent.has(c.right.id)));
  }
  if (mode === 'complete' && (missing.length || !inputs.length || inputs.length > 100)) {
    return { error: message || `${title}：正式交付需要 1 至 100 个分镜`, missing_shots: missing };
  }
  const scenes = inputs.filter(sc => sc.video_url);
  if (scenes.length === 0) {
    log.warn('Finalize no scenes with video', { episode_id: episodeId });
    return { message: message || '本集没有可合成的视频片段', missing_shots: missing, merge_id: null, episode_id: episodeId, scenes_count: 0, task_id: null };
  }
  const mergeReq = {
    episode_id: episodeId,
    drama_id: ep.drama_id,
    title,
    scenes,
    provider: 'ffmpeg',
    merge_options: {
      delivery_mode: mode, reliable_render: true,
      ...(mode && { edit_revision: plan.revision, edit_plan: audition?.plan || plan, logical_order: inputs.map(s => s.scene_id) }),
      ...(audition && { audition_pair: audition.pair, audition_inputs:audition.inputs }),
      aspect_ratio: mode ? aspectRatio : undefined,
      burn_narration_subtitles: !!(body && body.burn_narration_subtitles),
      burn_dialogue_audio: !!(body && body.burn_dialogue_audio),
      watermark_text: (body && body.watermark_text != null)
        ? String(body.watermark_text).trim().slice(0, 200)
        : '',
      // 结构化剧集的成片选项（缺省时行为与原来一致）
      dialogue_subtitles: !!(body && body.dialogue_subtitles),
      cards: !!(body && body.cards),
      review_sheets: !!(body && body.review_sheets),
      bgm: body && body.bgm && body.bgm.url
        ? { url: String(body.bgm.url), volume_db: Number.isFinite(Number(body.bgm.volume_db)) ? Number(body.bgm.volume_db) : undefined }
        : undefined,
    },
  };
  const created = videoMergeService.create(db, log, mergeReq);
  const mergeId = created.merge_id || created.id;
  if (!mode && !videoMergeService.hasPublishedDelivery(db, episodeId)) {
    db.prepare('UPDATE episodes SET status = ? WHERE id = ?').run('processing', episodeId);
  }
  setImmediate(() => {
    videoMergeService.processVideoMerge(db, log, mergeId, baseUrl);
  });
  return {
    message: message || '视频合成任务已创建，正在后台处理',
    missing_shots: missing,
    merge_id: mergeId,
    episode_id: episodeId,
    scenes_count: scenes.length,
    task_id: created.task_id,
  };
}

function downloadEpisodeVideo(db, episodeId) {
  const ep = db.prepare('SELECT id, title, episode_number, video_url FROM episodes WHERE id = ? AND deleted_at IS NULL').get(episodeId);
  if (!ep) return null;
  if (!ep.video_url) return { error: '该剧集还没有生成视频' };
  return { video_url: ep.video_url, title: ep.title, episode_number: ep.episode_number };
}

module.exports = {
  getVideoUrlForStoryboard,
  createDrama,
  getDrama,
  getDramaById,
  listDramas,
  updateDrama,
  deleteDrama,
  getDramaStats,
  saveOutline,
  getCharacters,
  saveCharacters,
  saveEpisodes,
  saveProgress,
  saveCanvasLayout,
  finalizeEpisode,
  episodeDeliveryInputs,
  downloadEpisodeVideo,
  generateStoryboard,
};
