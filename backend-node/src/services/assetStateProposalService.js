/**
 * 状态资产提议：按一集剧本提议场景状态（时段、光线、环境变化）与换装造型。
 * 只返回提议，不写库；作者确认后由现有的变体接口创建并出图。
 */
const { z } = require('zod');
const aiClient = require('./aiClient');
const R = require('./segmentCompile/rules/stateProposalRules');
const { safeParseAIJSON } = require('../utils/safeJson');

const text = z.string().trim().min(1);
const proposalSchema = z.object({
  scene_states: z.array(z.object({ scene_id: z.number().int(), name: text, state_phrase: text })).default([]),
  wardrobes: z
    .array(z.object({
      character_id: z.number().int(),
      name: text,
      change_phrase: text,
      episode_range: z.array(z.number().int().positive()).max(2).nullable().optional(),
    }))
    .default([]),
});

function codedError(code, message) {
  return Object.assign(new Error(message), { code });
}

function clip(value, n) {
  return String(value || '').trim().slice(0, n);
}

function parseRange(raw) {
  try { return raw ? JSON.parse(raw) : null; } catch (_) { return null; }
}

/** 同一父资产下同名或同描述的变体视为重复 */
function keyOf(parentId, name, phrase) {
  return [`${parentId}|n|${name}`, `${parentId}|p|${phrase}`];
}

/**
 * @returns {Promise<{ episode_number: number, scene_states: object[], wardrobes: object[] }>}
 */
async function proposeForEpisode(db, log, episodeId, opts = {}) {
  const ep = db.prepare('SELECT id, drama_id, episode_number, script_content, description FROM episodes WHERE id = ? AND deleted_at IS NULL').get(Number(episodeId));
  if (!ep) throw codedError('not_found', '剧集不存在');
  const script = String(ep.script_content || ep.description || '').trim();
  if (!script) throw codedError('script_empty', '剧本内容为空，请先生成剧集内容');

  const scenes = db.prepare('SELECT id, location, time, prompt FROM scenes WHERE drama_id = ? AND deleted_at IS NULL ORDER BY id').all(ep.drama_id);
  const characters = db.prepare('SELECT id, name, appearance FROM characters WHERE drama_id = ? AND deleted_at IS NULL ORDER BY id').all(ep.drama_id);
  const existingStates = db.prepare(
    `SELECT st.scene_id, st.name, st.state_phrase FROM scene_states st JOIN scenes s ON s.id = st.scene_id
     WHERE s.drama_id = ? AND st.deleted_at IS NULL AND s.deleted_at IS NULL`
  ).all(ep.drama_id);
  const existingWardrobes = db.prepare(
    `SELECT w.character_id, w.name, w.change_phrase, w.episode_range FROM character_wardrobes w JOIN characters c ON c.id = w.character_id
     WHERE c.drama_id = ? AND w.deleted_at IS NULL AND c.deleted_at IS NULL`
  ).all(ep.drama_id).map((w) => ({ ...w, episode_range: parseRange(w.episode_range) }));

  const reply = await aiClient.generateText(db, log, 'text', R.userPrompt({
    episodeNumber: ep.episode_number,
    script,
    scenes: scenes.map((s) => ({ id: s.id, location: s.location, time: s.time, description: clip(s.prompt, 200) })),
    characters: characters.map((c) => ({ id: c.id, name: c.name, appearance: clip(c.appearance, 300) })),
    existingStates,
    existingWardrobes,
  }), R.systemPrompt(), {
    scene_key: 'scene_extraction',
    model: opts.model || undefined,
    temperature: 0.3,
    max_tokens: 4000,
  });
  let parsed;
  try {
    parsed = proposalSchema.parse(safeParseAIJSON(String(reply || ''), null, log));
  } catch (e) {
    throw codedError('proposal_invalid', '状态提议失败：模型输出不合法（' + String(e.message || e).slice(0, 200) + '）');
  }

  const sceneName = new Map(scenes.map((s) => [s.id, s.location]));
  const characterName = new Map(characters.map((c) => [c.id, c.name]));
  const seenStates = new Set(existingStates.flatMap((s) => keyOf(s.scene_id, s.name, s.state_phrase)));
  const seenWardrobes = new Set(existingWardrobes.flatMap((w) => keyOf(w.character_id, w.name, w.change_phrase)));
  const fresh = (seen, keys) => {
    if (keys.some((k) => seen.has(k))) return false;
    keys.forEach((k) => seen.add(k));
    return true;
  };

  const scene_states = parsed.scene_states
    .filter((s) => sceneName.has(s.scene_id) && fresh(seenStates, keyOf(s.scene_id, s.name, s.state_phrase)))
    .map((s) => ({ scene_id: s.scene_id, scene_name: sceneName.get(s.scene_id), name: s.name, state_phrase: s.state_phrase }));
  const wardrobes = parsed.wardrobes
    .filter((w) => characterName.has(w.character_id) && fresh(seenWardrobes, keyOf(w.character_id, w.name, w.change_phrase)))
    .map((w) => ({
      character_id: w.character_id,
      character_name: characterName.get(w.character_id),
      name: w.name,
      change_phrase: w.change_phrase,
      episode_range: w.episode_range && w.episode_range.length ? w.episode_range : [ep.episode_number],
    }));
  log.info('Asset states proposed', { episode_id: ep.id, scene_states: scene_states.length, wardrobes: wardrobes.length });
  return { episode_number: ep.episode_number, scene_states, wardrobes };
}

module.exports = { proposeForEpisode };
