/**
 * 把一条结构化分镜编译成当前（或指定）视频模型的请求：读库组装 bindings → compileSegment → lintSegment。
 * 预览接口、POST /videos、即梦渲染都走这里，保证同一份分镜在各入口编译结果一致。
 */
const videoClient = require('./videoClient');
const { parseSegmentIr } = require('./segmentIr/schema');
const { compileSegment } = require('./segmentCompile');
const { lintSegment } = require('./segmentCompile/lint');
const { deriveStyleSentences } = require('./segmentCompile/style');
const episodeContinuityService = require('./episodeContinuityService');
const { toPublicUrl } = require('../utils/storagePaths');
const characterHeadBody = require('./characterHeadBody');
const { mergeCfgStyleWithDrama } = require('../utils/dramaStyleMerge');
const { tailFrameEligibility } = require('./segmentCompile/continuity');
const videoSettings = require('./videoSettings');
const { resolveVoiceSource } = require('./modelCapabilities');

const VOICE_FALLBACK_MSG = {
  native_unsupported: '当前模型不支持原生人声，本段按后期配音编译（角色不开口）。要让成片带上台词声音，请把视频配置里的「台词声音」改选「后期配音」',
  cannot_silence: '当前模型的音轨无法关闭，台词声音已按原生人声处理',
};

/**
 * 尾帧衔接检查：来源必须是紧邻上一段、同场景版本且有共同角色；来源视频缺失或比尾帧新（重生成过）时阻断。
 * @returns {{ tailFrame: {url}|null, findings: object[] }}
 */
function checkTailFrame(db, sb, ir, bindings) {
  const from = ir.continuity.tail_ref_from;
  if (from == null) return { tailFrame: null, findings: [] };
  const block = (code, msg) => ({ tailFrame: null, findings: [{ level: 'block', code, where: { storyboard_id: from }, msg }] });
  const prev = db
    .prepare('SELECT id, segment_ir FROM storyboards WHERE episode_id = ? AND storyboard_number < ? AND deleted_at IS NULL ORDER BY storyboard_number DESC, id DESC LIMIT 1')
    .get(sb.episode_id, sb.storyboard_number || 0);
  if (!prev || prev.id !== from) return block('tail_frame_not_adjacent', '尾帧来源不是紧邻的上一段，请重新衔接或改用文字承接');
  const prevParsed = prev.segment_ir ? parseSegmentIr(prev.segment_ir) : null;
  const verdict = tailFrameEligibility(prevParsed && prevParsed.ok ? prevParsed.ir : null, ir);
  if (!verdict.ok) return block('tail_frame_not_applicable', verdict.reason);
  const video = db
    .prepare("SELECT created_at FROM video_generations WHERE storyboard_id = ? AND status = 'completed' AND deleted_at IS NULL ORDER BY created_at DESC, id DESC LIMIT 1")
    .get(from);
  if (!video) return block('tail_frame_source_missing', '尾帧来源段还没有成功生成的视频');
  const imgId = ir.continuity.first_frame_image_id;
  const img = imgId != null ? db.prepare('SELECT created_at FROM image_generations WHERE id = ? AND deleted_at IS NULL').get(imgId) : null;
  if (!img || !bindings.images[imgId]) return block('tail_frame_missing', '尾帧图片已不存在，请重新衔接');
  if (String(video.created_at) > String(img.created_at)) return block('tail_frame_stale', '尾帧来源段的视频在取帧之后重新生成过，尾帧已过期，请重新衔接');
  return { tailFrame: { url: bindings.images[imgId] }, findings: [] };
}

function tableExists(db, name) {
  return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name);
}

function byId(rows, map) {
  return Object.fromEntries(rows.map((r) => [r.id, map(r)]));
}

/**
 * 本剧所有可被 IR 引用的资产（已软删的不在内，编译时据此阻断）。
 * 给出集数时，未指定造型的角色用本集造型图（与全能模式、分镜图一致）；IR 里写明的造型仍以它为准。
 */
function loadBindings(db, cfg, dramaId, ir, episodeNumber = null) {
  const url = (r) => toPublicUrl(cfg, r.image_url, r.local_path);
  const episodeImage = (r) => (episodeNumber == null ? r : characterHeadBody.referenceRow(r, characterHeadBody.listWardrobes(db, r.id), episodeNumber));
  const bindings = {
    characters: byId(
      db.prepare('SELECT id, name, role, voice_style, is_group, image_url, local_path FROM characters WHERE drama_id = ? AND deleted_at IS NULL').all(dramaId),
      (r) => ({ name: r.name, role: r.role, voice_style: r.voice_style, is_group: !!r.is_group, image_url: url(episodeImage(r)) })
    ),
    scenes: byId(
      db.prepare('SELECT id, location, image_url, local_path FROM scenes WHERE drama_id = ? AND deleted_at IS NULL').all(dramaId),
      (r) => ({ name: r.location, image_url: url(r) })
    ),
    props: byId(
      db.prepare('SELECT id, name, image_url, local_path FROM props WHERE drama_id = ? AND deleted_at IS NULL').all(dramaId),
      (r) => ({ name: r.name, image_url: url(r) })
    ),
    wardrobes: {},
    sceneStates: {},
    propStates: {},
    images: {},
  };
  if (tableExists(db, 'character_wardrobes')) {
    bindings.wardrobes = byId(
      db.prepare(
        `SELECT w.id, w.name, w.image_url, w.local_path FROM character_wardrobes w JOIN characters c ON c.id = w.character_id
         WHERE c.drama_id = ? AND w.deleted_at IS NULL AND c.deleted_at IS NULL`
      ).all(dramaId),
      (r) => ({ name: r.name, image_url: url(r) })
    );
  }
  if (tableExists(db, 'scene_states')) {
    bindings.sceneStates = byId(
      db.prepare(
        `SELECT st.id, st.name, st.image_url, st.local_path FROM scene_states st JOIN scenes s ON s.id = st.scene_id
         WHERE s.drama_id = ? AND st.deleted_at IS NULL AND s.deleted_at IS NULL`
      ).all(dramaId),
      (r) => ({ name: r.name, image_url: url(r) })
    );
  }
  if (tableExists(db, 'prop_states')) {
    bindings.propStates = byId(
      db.prepare(
        `SELECT st.id, st.name, st.image_url, st.local_path FROM prop_states st JOIN props p ON p.id = st.prop_id
         WHERE p.drama_id = ? AND st.deleted_at IS NULL AND p.deleted_at IS NULL`
      ).all(dramaId),
      (r) => ({ name: r.name, image_url: url(r) })
    );
  }
  const imageIds = [ir.continuity.first_frame_image_id, ir.continuity.last_frame_image_id].filter((x) => x != null);
  for (const id of imageIds) {
    const r = db.prepare('SELECT id, image_url, local_path FROM image_generations WHERE id = ? AND deleted_at IS NULL').get(id);
    if (r) bindings.images[id] = url(r);
  }
  return bindings;
}

/**
 * @param {{ model?: string, tailFrame?: { url: string } | null }} [opts]
 * @returns {{ ok: true, ir, compiled, findings, blocked: boolean, target } | { ok: false, code: string, message: string, errors?: object[] }}
 */
function compileStoryboard(db, storyboardId, opts = {}) {
  const sb = db
    .prepare(
      `SELECT s.id, s.segment_ir, s.episode_id, s.storyboard_number, e.drama_id, e.episode_number, e.video_settings FROM storyboards s JOIN episodes e ON e.id = s.episode_id
       WHERE s.id = ? AND s.deleted_at IS NULL AND e.deleted_at IS NULL`
    )
    .get(Number(storyboardId));
  if (!sb) return { ok: false, code: 'not_found', message: '分镜不存在' };
  if (!sb.segment_ir) return { ok: false, code: 'legacy_storyboard', message: '这条分镜不是结构化分镜，沿用原有提示词' };
  const parsed = parseSegmentIr(sb.segment_ir);
  if (!parsed.ok) return { ok: false, code: 'segment_ir_invalid', message: '结构化分镜数据不合法，请重新编辑', errors: parsed.errors };
  const ir = parsed.ir;

  const cfg = require('../config').loadConfig();
  const drama = db.prepare('SELECT style, metadata FROM dramas WHERE id = ?').get(sb.drama_id);
  const styleText = (mergeCfgStyleWithDrama(cfg, drama || {}).style || {}).default_style_zh || '';
  const style = deriveStyleSentences(styleText || '电影风格，高清画质');
  const target = opts.target || videoClient.resolveVideoTarget(db, opts.model);
  const continuity = (episodeContinuityService.getContinuity(db, sb.episode_id) || {})[String(ir.scene.scene_id)] || {};

  const bindings = loadBindings(db, cfg, sb.drama_id, ir, Number(sb.episode_number));
  const tail = opts.tailFrame ? { tailFrame: opts.tailFrame, findings: [] } : checkTailFrame(db, sb, ir, bindings);
  const voiceSetting = videoSettings.forEpisode(videoSettings.projectEffective(drama && drama.metadata), sb.video_settings).effective.voice_source;
  const voice = resolveVoiceSource(target.caps, voiceSetting);
  const compiled = compileSegment(ir, {
    caps: target.caps,
    native: voice.source === 'native',
    style,
    bindings,
    continuity,
    tailFrame: tail.tailFrame,
  });
  const findings = [...style.findings, ...tail.findings, ...compiled.findings, ...lintSegment(ir, compiled, target.caps)];
  if (voice.fallback) findings.push({ level: 'info', code: 'voice_source_fallback', where: {}, msg: VOICE_FALLBACK_MSG[voice.fallback] });
  return {
    ok: true,
    ir,
    compiled,
    findings,
    blocked: findings.some((f) => f.level === 'block'),
    target: { protocol: target.protocol, model: target.model, caps: target.caps },
  };
}

module.exports = { compileStoryboard, loadBindings };
