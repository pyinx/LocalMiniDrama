// 项目导入服务：解析 ZIP，还原剧集数据和媒体文件
const fs = require('fs');
const path = require('path');
const AdmZip = require('adm-zip');
const takeArchive = require('./workbenchTakeArchive');
const { randomUUID } = require('crypto');
const storageLayout = require('./storageLayout');

function getStoragePath(cfg) {
  const raw = cfg?.storage?.local_path || './data/storage';
  return path.isAbsolute(raw) ? raw : path.join(process.cwd(), raw);
}

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

/**
 * 解析 ZIP Buffer，返回 project.json 内容和媒体文件 Map
 * @returns {{ data: object, files: Map<string,Buffer> }}
 */
function parseZip(zipBuffer) {
  let zip;
  try {
    zip = new AdmZip(zipBuffer);
  } catch (e) {
    throw new Error('ZIP 文件损坏，无法解析');
  }

  const projectEntry = zip.getEntry('project.json');
  if (!projectEntry) {
    throw new Error('ZIP 格式不正确：缺少 project.json');
  }

  let data;
  try {
    data = JSON.parse(projectEntry.getData().toString('utf8'));
  } catch (e) {
    throw new Error('project.json 格式错误，无法解析 JSON');
  }

  if (!data.drama || !data.drama.title) {
    throw new Error('project.json 格式不正确：缺少 drama.title 字段');
  }

  // 读取所有媒体文件到 Map
  const files = new Map();
  for (const entry of zip.getEntries()) {
    if (!entry.isDirectory && entry.entryName !== 'project.json') {
      files.set(entry.entryName, entry.getData());
    }
  }

  return { data, files };
}

/**
 * 生成不重名的剧集标题
 */
function resolveTitle(db, baseTitle) {
  const existing = db.prepare('SELECT title FROM dramas WHERE deleted_at IS NULL').all().map(r => r.title);
  if (!existing.includes(baseTitle)) return baseTitle;
  let i = 1;
  while (existing.includes(`${baseTitle} 导入${i}`)) i++;
  return `${baseTitle} 导入${i}`;
}

/**
 * 保存媒体文件到 storage，返回相对路径
 * @param {string} projectDir 如 projects/0001_20250324_剧名，与工程内其它媒体一致
 */
function saveMediaFile(storagePath, projectDir, category, files, zipPath, prefix) {
  if (!zipPath) return null;
  const buf = files.get(zipPath);
  if (!buf) return null;
  const ext = path.extname(zipPath) || '.jpg';
  const categoryPath = path.join(storagePath, projectDir, category);
  ensureDir(categoryPath);
  const name = `${prefix}_${randomUUID().slice(0, 8)}${ext}`;
  const abs = path.join(categoryPath, name);
  fs.writeFileSync(abs, buf);
  return `${projectDir}/${category}/${name}`.replace(/\\/g, '/');
}

/**
 * 批量保存 extra_image_files 数组，返回本地路径 JSON 字符串
 */
const IMPORT_FIRST_FRAME_TYPES = ['storyboard_first', 'first', 'first_frame'];
const IMPORT_LAST_FRAME_TYPES = ['storyboard_last', 'last', 'tail', 'last_frame'];

/** 老版 ZIP 或未写入 frame_prompts 时，从已导入的首尾帧图生记录回填提示词 */
function restoreFramePromptsFromImageGens(db, sbId, now, log) {
  const insFp = db.prepare(
    'INSERT INTO frame_prompts (storyboard_id, frame_type, prompt, description, layout, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
  );
  for (const [types, frameType] of [[IMPORT_FIRST_FRAME_TYPES, 'first'], [IMPORT_LAST_FRAME_TYPES, 'last']]) {
    const has = db.prepare('SELECT id FROM frame_prompts WHERE storyboard_id = ? AND frame_type = ?').get(sbId, frameType);
    if (has) continue;
    const ph = types.map(() => '?').join(',');
    const ig = db.prepare(
      `SELECT prompt FROM image_generations WHERE storyboard_id = ? AND deleted_at IS NULL
       AND frame_type IN (${ph}) AND prompt IS NOT NULL AND TRIM(prompt) != ''
       ORDER BY created_at DESC LIMIT 1`
    ).get(sbId, ...types);
    if (ig?.prompt?.trim()) {
      insFp.run(sbId, frameType, ig.prompt.trim(), null, null, now, now);
      try { log?.info?.('[导入] 从分镜图历史恢复帧提示词', { storyboard_id: sbId, frame_type: frameType }); } catch (_) {}
    }
  }
}

function saveExtraImages(storagePath, projectDir, category, files, zipPaths, prefix) {
  if (!Array.isArray(zipPaths) || zipPaths.length === 0) return null;
  const localPaths = [];
  for (const zipPath of zipPaths) {
    const localPath = saveMediaFile(storagePath, projectDir, category, files, zipPath, prefix);
    if (localPath) localPaths.push(localPath);
  }
  return localPaths.length > 0 ? JSON.stringify(localPaths) : null;
}

/**
 * 导入 ZIP，创建剧集并还原所有数据
 * @param {Buffer} zipBuffer
 * @returns {{ drama_id: number, title: string }}
 */
function importDrama(db, cfg, log, zipBuffer) {
  const storagePath = getStoragePath(cfg);
  const { data, files } = parseZip(zipBuffer);
  const [major, minor] = String(data.version || '').split('.').map(Number);
  const indexedAssets = major > 1 || (major === 1 && minor >= 6);
  const validIndex = (i, entries) => Number.isSafeInteger(i) && i >= 0 && i < (entries?.length || 0);
  const validIndices = (indices, entries) => Array.isArray(indices) && indices.every(i => validIndex(i, entries));
  for (const c of data.library_characters || []) {
    for (const file of [c.image_file, c.four_view_file]) {
      if (file && !files.get(file)?.length) throw new Error(`素材角色“${c.name}”的参考文件缺失：${file}`);
    }
  }
  for (const ep of data.episodes || []) {
    if (indexedAssets && !validIndices(ep.character_indices, data.characters)) {
      throw new Error(`第 ${ep.episode_number} 集的角色名单引用无效`);
    }
    for (const sb of ep.storyboards || []) {
      if (indexedAssets && (sb.scene_index != null && !validIndex(sb.scene_index, data.scenes) ||
          !validIndices(sb.character_indices ?? [], data.characters) ||
          !validIndices(sb.library_character_indices ?? [], data.library_characters))) {
        throw new Error(`第 ${ep.episode_number} 集第 ${sb.storyboard_number} 镜的角色或场景引用无效`);
      }
      takeArchive.validateBoard(sb, files);
    }
  }
  const d = data.drama;
  const title = resolveTitle(db, d.title || '导入项目');
  const now = new Date().toISOString();

  let metadata = d.metadata || {};
  if (typeof metadata === 'string') {
    try {
      metadata = JSON.parse(metadata);
    } catch (_) {
      metadata = {};
    }
  }
  metadata.storage_folder_label = storageLayout.sanitizeFolderLabel(title);
  delete metadata.novel_creation_id;
  const metaStr = JSON.stringify(metadata);

  // 用事务包裹全部写入：任何步骤失败时整体回滚，避免部分导入
  let result;
  const runImport = db.transaction(() => {
    if (d.style === 'custom') require('./customStyleLibrary').unpack(db, files, metadata.custom_style);
    result = _doImport(db, storagePath, files, data, d, title, metaStr, now, log, indexedAssets);
  });
  runImport();
  return result;
}

/** 变体（造型/场景状态/道具状态）：插行并把图片落到新项目目录；返回 original_id → 新 id */
function importVariants(db, storagePath, projectDir, files, list, opts, now) {
  const map = new Map();
  if (!Array.isArray(list)) return map;
  const tableOk = !!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(opts.table);
  if (!tableOk) return map;
  for (const v of list) {
    if (!v || !v.name) continue;
    const localPath = saveMediaFile(storagePath, projectDir, opts.category, files, v.image_file, opts.prefix);
    const cols = [opts.parentCol, ...opts.fields, 'image_url', 'local_path', 'created_at', 'updated_at'];
    const vals = [opts.parentId, ...opts.fields.map((f) => v[f] ?? null), localPath ? null : v.image_url || null, localPath, now, now];
    const info = db.prepare(`INSERT INTO ${opts.table} (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`).run(...vals);
    if (v.original_id != null) map.set(Number(v.original_id), Number(info.lastInsertRowid));
  }
  return map;
}

/**
 * 把导出包里的 IR 引用的旧 id 换成新 id。必需的引用（角色、场景、道具）映射不到时返回 null（该分镜退回旧链路），
 * 可选引用（造型、状态、首尾帧图、尾帧来源段）映射不到时去掉。
 */
function remapIr(ir, m) {
  const req = (map, id) => (map.has(Number(id)) ? map.get(Number(id)) : undefined);
  const opt = (map, id) => (id == null ? null : map.has(Number(id)) ? map.get(Number(id)) : null);
  const out = JSON.parse(JSON.stringify(ir));
  out.scene.scene_id = req(m.scenes, ir.scene.scene_id);
  if (out.scene.scene_id === undefined) return null;
  out.scene.state_id = opt(m.sceneStates, ir.scene.state_id);
  for (const c of out.cast) {
    c.character_id = req(m.characters, c.character_id);
    if (c.character_id === undefined) return null;
    c.wardrobe_id = opt(m.wardrobes, c.wardrobe_id);
  }
  for (const p of out.prop_refs || []) {
    p.prop_id = req(m.props, p.prop_id);
    if (p.prop_id === undefined) return null;
    p.state_id = opt(m.propStates, p.state_id);
  }
  const cont = out.continuity || { mode: 'refs' };
  for (const [key, map] of [['first_frame_image_id', m.images], ['last_frame_image_id', m.images], ['tail_ref_from', m.storyboards]]) {
    if (cont[key] == null) continue;
    const v = opt(map, cont[key]);
    if (v == null) delete cont[key];
    else cont[key] = v;
  }
  if (cont.mode === 'first_last' && cont.first_frame_image_id == null) cont.mode = 'refs';
  out.continuity = cont;
  return out;
}

function _doImport(db, storagePath, files, data, d, title, metaStr, now, log, indexedAssets) {
  const idMaps = { characters: new Map(), wardrobes: new Map(), scenes: new Map(), sceneStates: new Map(), props: new Map(), propStates: new Map(), storyboards: new Map(), images: new Map() };
  const pendingIr = []; // [{ sbId, ir }]

  // ---- 创建 drama ----
  const dramaInfo = db.prepare(
    `INSERT INTO dramas (title, description, genre, style, status, tags, metadata, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    title,
    d.description || null,
    d.genre || null,
    d.style || null,
    d.status || 'draft',
    d.tags || null,
    metaStr,
    now,
    now
  );
  const dramaId = dramaInfo.lastInsertRowid;
  const projectDir = storageLayout.buildProjectRelativeDir({
    id: dramaId,
    title,
    created_at: now,
    metadata: metaStr,
  });

  // ---- 导入角色 ----
  const charNewIds = []; // 按导出顺序保存新角色 id，用于恢复分镜 character_indices
  for (let i = 0; i < (data.characters || []).length; i++) {
    const c = data.characters[i];
    if (!c.name && !indexedAssets) { charNewIds.push(null); continue; }
    const localPath = saveMediaFile(storagePath, projectDir, 'characters', files, c.image_file, 'char_imp');
    const extraImagesJson = saveExtraImages(storagePath, projectDir, 'characters', files, c.extra_image_files, 'char_extra_imp');
    const info = db.prepare(
      `INSERT INTO characters (drama_id, name, role, description, personality, appearance, stages, voice_style, polished_prompt, local_path, image_url, extra_images, sort_order, is_group, tts_voice, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(dramaId, c.name ?? '', c.role || null, c.description || null, c.personality || null, c.appearance || null,
      typeof c.stages === 'string' ? c.stages : (c.stages == null ? null : JSON.stringify(c.stages)),
      c.voice_style || null, c.polished_prompt || null, localPath, c.image_url ?? null, extraImagesJson, i, c.is_group ? 1 : 0, c.tts_voice || null, now, now);
    charNewIds.push(info.lastInsertRowid);
    if (c.original_id != null) idMaps.characters.set(Number(c.original_id), Number(info.lastInsertRowid));
    for (const [o, n] of importVariants(db, storagePath, projectDir, files, c.wardrobes, {
      table: 'character_wardrobes', parentCol: 'character_id', parentId: info.lastInsertRowid, category: 'characters', prefix: 'wardrobe_imp',
      fields: ['name', 'change_phrase', 'prompt', 'episode_range', 'sort_order'],
    }, now)) idMaps.wardrobes.set(o, n);
  }

  // 旧镜引用的素材在新库归属于本次导入的项目，避免用名字绑定到其他项目。
  const libraryIds = (data.library_characters || []).map(c => {
    const image = saveMediaFile(storagePath, projectDir, 'characters', files, c.image_file, 'lib_char');
    const fourView = saveMediaFile(storagePath, projectDir, 'characters', files, c.four_view_file, 'lib_view');
    return db.prepare(`INSERT INTO character_libraries(drama_id,name,appearance,description,category,tags,
      identity_anchors,style_tokens,color_palette,local_path,image_url,four_view_image_url,source_type,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?, 'imported',?,?)`).run(dramaId, c.name, c.appearance ?? null,
        c.description ?? null, c.category ?? null, c.tags ?? null, c.identity_anchors ?? null, c.style_tokens ?? null,
        c.color_palette ?? null, image, c.image_url ?? null, fourView || c.four_view_url || null, now, now).lastInsertRowid;
  });

  // ---- 导入剧集（先建好所有集，再关联角色/场景/道具） ----
  const episodeIdList = []; // 按顺序保存新集 id
  for (const ep of (data.episodes || [])) {
    const epInfo = db.prepare(
      `INSERT INTO episodes (drama_id, episode_number, title, description, script_content, novel_source, duration, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(dramaId, ep.episode_number || 1, ep.title || `第${ep.episode_number || 1}集`, ep.description || null, ep.script_content || null, ep.novel_source?.text ? JSON.stringify(ep.novel_source) : null, ep.duration || 0, now, now);
    episodeIdList.push(epInfo.lastInsertRowid);
  }

  const insEC = db.prepare('INSERT OR IGNORE INTO episode_characters (episode_id, character_id) VALUES (?, ?)');
  for (const [index, epId] of episodeIdList.entries()) {
    const ep = data.episodes[index];
    const cast = indexedAssets ? ep.character_indices.map(i => charNewIds[i]) : charNewIds.filter(Boolean);
    for (const id of cast) insEC.run(epId, id);
  }

  // 旧包仅在没有结构化分镜时按地点、时段去重。
  const dedupeScenes = !indexedAssets && !(data.episodes || []).some(ep => (ep.storyboards || []).some(sb => sb.segment_ir));
  const sceneNewIds = []; // 按导出顺序保存新场景 id（含去重后的映射），用于恢复分镜 scene_index
  const sceneDedupeMap = new Map(); // key: "location|time" → 已创建的 scene id
  for (let i = 0; i < (data.scenes || []).length; i++) {
    const s = data.scenes[i];
    const dedupeKey = `${(s.location || '').trim()}|${(s.time || '').trim()}`;
    if (dedupeScenes && sceneDedupeMap.has(dedupeKey)) {
      // 同 location+time 已存在，直接复用，不重复插入
      sceneNewIds.push(sceneDedupeMap.get(dedupeKey));
      if (s.original_id != null) idMaps.scenes.set(Number(s.original_id), Number(sceneDedupeMap.get(dedupeKey)));
      continue;
    }
    const epIdx = s.episode_index;
    const epId = (epIdx != null && epIdx >= 0 && episodeIdList[epIdx])
      ? episodeIdList[epIdx]
      : (indexedAssets ? null : episodeIdList[0] || null);
    const localPath = saveMediaFile(storagePath, projectDir, 'scenes', files, s.image_file, 'scene_imp');
    const extraImagesJson = saveExtraImages(storagePath, projectDir, 'scenes', files, s.extra_image_files, 'scene_extra_imp');
    const info = db.prepare(
      `INSERT INTO scenes (drama_id, episode_id, location, time, prompt, polished_prompt, local_path, image_url, extra_images, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(dramaId, epId, s.location || '', s.time || '', s.prompt || '', s.polished_prompt || null, localPath, s.image_url ?? null, extraImagesJson, now, now);
    sceneNewIds.push(info.lastInsertRowid);
    if (dedupeScenes) sceneDedupeMap.set(dedupeKey, info.lastInsertRowid);
    if (s.original_id != null) idMaps.scenes.set(Number(s.original_id), Number(info.lastInsertRowid));
    for (const [o, n] of importVariants(db, storagePath, projectDir, files, s.states, {
      table: 'scene_states', parentCol: 'scene_id', parentId: info.lastInsertRowid, category: 'scenes', prefix: 'scene_state_imp',
      fields: ['name', 'kind', 'state_phrase', 'prompt', 'sort_order'],
    }, now)) idMaps.sceneStates.set(o, n);
  }

  // ---- 导入道具（带 episode_id） ----
  const propNewIds = []; // 按导出顺序保存新道具 id，用于恢复 storyboard_props
  for (const p of (data.props || [])) {
    if (!p.name) { propNewIds.push(null); continue; }
    const epIdx = p.episode_index;
    const epId = (epIdx != null && epIdx >= 0 && episodeIdList[epIdx])
      ? episodeIdList[epIdx]
      : (episodeIdList[0] || null);
    const localPath = saveMediaFile(storagePath, projectDir, 'props', files, p.image_file, 'prop_imp');
    const extraImagesJson = saveExtraImages(storagePath, projectDir, 'props', files, p.extra_image_files, 'prop_extra_imp');
    const pInfo = db.prepare(
      `INSERT INTO props (drama_id, episode_id, name, type, description, prompt, local_path, image_url, extra_images, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(dramaId, epId, p.name, p.type || null, p.description || null, p.prompt || null, localPath, p.image_url ?? null, extraImagesJson, now, now);
    propNewIds.push(pInfo.lastInsertRowid);
    if (p.original_id != null) idMaps.props.set(Number(p.original_id), Number(pInfo.lastInsertRowid));
    for (const [o, n] of importVariants(db, storagePath, projectDir, files, p.states, {
      table: 'prop_states', parentCol: 'prop_id', parentId: pInfo.lastInsertRowid, category: 'props', prefix: 'prop_state_imp',
      fields: ['name', 'state_phrase', 'prompt', 'sort_order'],
    }, now)) idMaps.propStates.set(o, n);
  }

  // ---- 导入分镜 ----
  for (let epIdx = 0; epIdx < (data.episodes || []).length; epIdx++) {
    const ep = data.episodes[epIdx];
    const episodeId = episodeIdList[epIdx];
    if (!episodeId) continue;

    for (const sb of (ep.storyboards || [])) {
      const sbAudioPath = saveMediaFile(storagePath, projectDir, 'audio', files, sb.audio_file, 'sb_audio_imp');
      const sbNarrationAudioPath = saveMediaFile(storagePath, projectDir, 'audio', files, sb.narration_audio_file, 'sb_narr_audio_imp');

      // 还原 characters：从导出时记录的下标映射回新 ID
      const charIndices = Array.isArray(sb.character_indices) ? sb.character_indices : [];
      const sbCharIds = charIndices
        .map(idx => charNewIds[idx])
        .filter(id => id != null);
      const libraryIndices = sb.library_character_indices || [];
      const charactersJson = libraryIndices.length && !sbCharIds.length ? null : JSON.stringify(sbCharIds);

      // 还原 scene_id：从导出时记录的下标映射回新 ID
      const sbSceneId = (sb.scene_index != null && sceneNewIds[sb.scene_index])
        ? sceneNewIds[sb.scene_index]
        : null;

      // 还原 prop_ids：从导出时记录的下标映射回新 ID
      const propIndices = Array.isArray(sb.prop_indices) ? sb.prop_indices : [];
      const sbPropNewIds = propIndices
        .map(idx => propNewIds[idx])
        .filter(id => id != null);

      // 先插入分镜（首尾帧绑定ID、layout 稍后更新；image_url/local_path 由绑定逻辑设置）
      // 使用并行数组维护列名与值，确保列数与传参数量永远一致，避免“44 values for 43 columns”类错误
      const sbCols = [
        'episode_id', 'scene_id', 'storyboard_number', 'title', 'description', 'location', 'time',
        'dialogue', 'narration', 'action', 'atmosphere', 'result', 'shot_type', 'angle', 'angle_h', 'angle_v', 'angle_s',
        'movement', 'lighting_style', 'depth_of_field', 'image_prompt', 'polished_prompt', 'video_prompt', 'duration',
        'emotion', 'emotion_intensity', 'segment_index', 'segment_title', 'continuity_snapshot', 'creation_mode',
        'universal_segment_text', 'layout_description', 'first_frame_image_id', 'last_frame_image_id',
        'last_frame_image_url', 'last_frame_local_path', 'image_url', 'local_path', 'characters',
        'audio_local_path', 'narration_audio_local_path', 'created_at', 'updated_at'
      ];
      const sbVals = [
        episodeId,
        sbSceneId,
        sb.storyboard_number || 1,
        sb.title || null,
        sb.description ?? null,
        sb.location || null,
        sb.time || null,
        sb.dialogue || null,
        sb.narration || null,
        sb.action ?? null,
        sb.atmosphere || null,
        sb.result || null,
        sb.shot_type || null,
        sb.angle || null,
        sb.angle_h || null,
        sb.angle_v || null,
        sb.angle_s || null,
        sb.movement || null,
        sb.lighting_style || null,
        sb.depth_of_field || null,
        sb.image_prompt || null,
        sb.polished_prompt || null,
        sb.video_prompt || null,
        sb.duration || 0,
        sb.emotion || null,
        sb.emotion_intensity != null ? sb.emotion_intensity : null,
        sb.segment_index ?? 0,
        sb.segment_title || null,
        sb.continuity_snapshot || null,
        sb.creation_mode === 'universal' ? 'universal' : 'classic',
        sb.universal_segment_text || null,
        sb.layout_description || null,
        null, // first_frame_image_id 后设
        null, // last_frame_image_id 后设
        sb.last_frame_image_url || null,
        sb.last_frame_local_path || null,
        null, // image_url 由首帧绑定设置
        null, // local_path 由首帧绑定设置
        charactersJson,
        sbAudioPath || null,
        sbNarrationAudioPath || null,
        now,
        now
      ];
      if (sb.creative_review_lock != null && db.prepare('PRAGMA table_info(storyboards)').all().some(c => c.name === 'creative_review_lock')) {
        sbCols.push('creative_review_lock');
        sbVals.push(typeof sb.creative_review_lock === 'string' ? sb.creative_review_lock : JSON.stringify(sb.creative_review_lock));
      }
      if (sbCols.length !== sbVals.length) {
        throw new Error(`storyboards 导入列数不匹配: cols=${sbCols.length}, vals=${sbVals.length}`);
      }
      const sbInfo = db.prepare(
        `INSERT INTO storyboards (${sbCols.join(', ')})
         VALUES (${sbCols.map(() => '?').join(', ')})`
      ).run(...sbVals);
      const sbId = sbInfo.lastInsertRowid;
      for (const i of libraryIndices) {
        db.prepare('INSERT INTO storyboard_characters(storyboard_id,character_id,created_at) VALUES(?,?,?)').run(sbId, libraryIds[i], now);
      }
      if (sb.original_id != null) idMaps.storyboards.set(Number(sb.original_id), Number(sbId));
      if (sb.segment_ir) pendingIr.push({ sbId: Number(sbId), ir: sb.segment_ir });

      // 还原 storyboard_props（分镜与道具的关联）
      if (sbPropNewIds.length > 0) {
        const insSP = db.prepare('INSERT OR IGNORE INTO storyboard_props (storyboard_id, prop_id) VALUES (?, ?)');
        for (const pid of sbPropNewIds) insSP.run(sbId, pid);
      }

      // 还原帧提示词（首尾帧/关键帧专用提示词 + layout 合同，必须恢复）
      if (Array.isArray(sb.frame_prompts) && sb.frame_prompts.length > 0) {
        const insFp = db.prepare('INSERT INTO frame_prompts (storyboard_id, frame_type, prompt, description, layout, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)');
        for (const fp of sb.frame_prompts) {
          insFp.run(sbId, fp.frame_type || 'first', fp.prompt || '', fp.description || null, fp.layout || null, fp.created_at || now, fp.updated_at || now);
        }
        try { require('../logger').info?.('[导入] 已恢复帧提示词', { storyboard_id: sbId, count: sb.frame_prompts.length }); } catch (_) {}
      }

      // 导入分镜图片完整历史（新版 v1.4+ 的 image_generations 数组；老版回退单张）
      const genOldToNew = new Map(); // original_id -> {newId, localPath}
      if (Array.isArray(sb.image_generations) && sb.image_generations.length > 0) {
        for (const gen of sb.image_generations) {
          const genLocalPath = saveMediaFile(storagePath, projectDir, 'images', files, gen.zip_file || gen.file, 'sb_imp_gen');
          if (genLocalPath) {
            const genInfo = db.prepare(
              `INSERT INTO image_generations (drama_id, storyboard_id, provider, prompt, negative_prompt, model, frame_type, size, quality, status, error_msg, local_path, created_at, updated_at, completed_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
            ).run(
              dramaId,
              sbId,
              gen.provider || 'imported',
              gen.prompt || sb.image_prompt || '',
              gen.negative_prompt || null,
              gen.model || null,
              gen.frame_type || null,
              gen.size || null,
              gen.quality || null,
              gen.status || 'completed',
              gen.error_msg || null,
              genLocalPath,
              gen.created_at || now,
              now,
              gen.completed_at || now
            );
            const newGenId = genInfo.lastInsertRowid;
            if (gen.original_id != null) {
              genOldToNew.set(Number(gen.original_id), { newId: newGenId, localPath: genLocalPath });
              idMaps.images.set(Number(gen.original_id), Number(newGenId));
            }
          }
        }
      } else {
        // 老版兼容：仅单张 image_file（导入后只有这一个历史图，首尾帧绑定丢失是旧行为）
        const sbImagePath = saveMediaFile(storagePath, projectDir, 'images', files, sb.image_file, 'sb_imp');
        if (sbImagePath) {
          db.prepare(
            `INSERT INTO image_generations (drama_id, storyboard_id, provider, prompt, status, local_path, created_at, updated_at)
             VALUES (?, ?, 'imported', ?, 'completed', ?, ?, ?)`
          ).run(dramaId, sbId, sb.image_prompt || '', sbImagePath, now, now);
        }
      }

      // 新包按分镜重建候选 ID，旧包只含单条 video_file。
      if (Array.isArray(sb.video_takes)) {
        takeArchive.restore(db, sb, dramaId, sbId, now, file => saveMediaFile(storagePath, projectDir, 'videos', files, file, 'vid_imp'));
      } else if (sb.video_file) {
        const videoLocalPath = saveMediaFile(storagePath, projectDir, 'videos', files, sb.video_file, 'vid_imp');
        if (videoLocalPath) {
          db.prepare(
            `INSERT INTO video_generations (drama_id, storyboard_id, provider, prompt, status, local_path, created_at, updated_at)
             VALUES (?, ?, 'imported', ?, 'completed', ?, ?, ?)`
          ).run(dramaId, sbId, sb.video_prompt || '', videoLocalPath, sb.video_created_at || now, now);
        }
      }

      // 绑定首尾帧到 storyboards（关键：恢复 first_frame_image_id + image_url/local_path，以及 last_*）
      const now2 = new Date().toISOString();
      const firstOld = sb.first_frame_image_original_id ?? sb.first_frame_image_id;
      const lastOld = sb.last_frame_image_original_id ?? sb.last_frame_image_id;
      let boundFirst = false, boundLast = false;
      if (firstOld != null && genOldToNew.has(Number(firstOld))) {
        const { newId, localPath } = genOldToNew.get(Number(firstOld));
        db.prepare(
          `UPDATE storyboards SET image_url = ?, local_path = ?, first_frame_image_id = ?, updated_at = ? WHERE id = ? AND deleted_at IS NULL`
        ).run(null, localPath, newId, now2, sbId);
        boundFirst = true;
      }
      if (lastOld != null && genOldToNew.has(Number(lastOld))) {
        const { newId, localPath } = genOldToNew.get(Number(lastOld));
        db.prepare(
          `UPDATE storyboards SET last_frame_image_url = ?, last_frame_local_path = ?, last_frame_image_id = ?, updated_at = ? WHERE id = ? AND deleted_at IS NULL`
        ).run(null, localPath, newId, now2, sbId);
        boundLast = true;
      }
      if ((sb.image_generations && sb.image_generations.length) || boundFirst || boundLast) {
        try {
          require('../logger').info?.('[导入] 分镜图片历史+首尾帧绑定完成', {
            storyboard_id: sbId,
            gens_restored: genOldToNew.size,
            first_bound: boundFirst,
            last_bound: boundLast,
            had_original_first: firstOld != null,
            had_original_last: lastOld != null
          });
        } catch (_) {}
      }

      // 兼容老工程：ZIP 无 frame_prompts 时，用已导入的首/尾帧图生 prompt 回填
      restoreFramePromptsFromImageGens(db, sbId, now2, log);
    }
  }

  // ---- 结构化分镜 IR 与剧集连续性表：所有对象都建好后再重映射 id（尾帧来源可能指向后面的分镜） ----
  const storyboardService = require('./storyboardService');
  let irDropped = 0;
  for (const { sbId, ir } of pendingIr) {
    const mapped = remapIr(ir, idMaps);
    if (!mapped) {
      irDropped++;
      log.warn('[导入] 结构化分镜引用的资产不在导出包内，该分镜退回旧链路', { storyboard_id: sbId });
      continue;
    }
    try {
      storyboardService.saveSegmentIr(db, log, sbId, mapped);
    } catch (e) {
      irDropped++;
      log.warn('[导入] 结构化分镜校验失败，该分镜退回旧链路', { storyboard_id: sbId, error: e.message });
    }
  }
  (data.episodes || []).forEach((ep, i) => {
    if (!ep.continuity || !episodeIdList[i]) return;
    const table = {};
    for (const [k, v] of Object.entries(ep.continuity)) {
      const n = idMaps.scenes.get(Number(k));
      if (n != null) table[String(n)] = v;
    }
    db.prepare('UPDATE episodes SET continuity_json = ? WHERE id = ?').run(JSON.stringify(table), episodeIdList[i]);
  });

  log.info('Drama imported', { drama_id: dramaId, title, segment_ir: pendingIr.length - irDropped, segment_ir_dropped: irDropped });
  return { drama_id: dramaId, title };
}

module.exports = { importDrama, parseZip };
