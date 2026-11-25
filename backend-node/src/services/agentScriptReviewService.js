/**
 * P0 深审与提议：模型调用通过 deps.generateText 注入；输出先 safeParseAIJSON，再 Zod 校验，
 * 最后才写 notes。提议只产出候选并落 notes，不写 episodes.script_content。
 */
'use strict';

const { z } = require('zod');
const { safeParseAIJSON } = require('../utils/safeJson');

const MODES = new Set(['selection', 'first-three', 'dialogue', 'full']);
const MODE_LABELS = {
  selection: '题材与赛道判断',
  'first-three': '前三集生死线',
  dialogue: '对白活人感',
  full: '综合深审',
};

const findingsSchema = z.object({
  findings: z.array(z.object({
    id: z.string().min(1).max(20),
    severity: z.enum(['blocking', 'warn', 'info']),
    location: z.string().min(1),
    what: z.string().min(1),
    why: z.string().default(''),
    direction: z.string().default(''),
  })).min(1).max(20),
});
const proposalsSchema = z.object({
  edits: z.array(z.object({
    finding_id: z.string().min(1),
    path: z.string().min(1),
    before: z.string(),
    after: z.string().min(1),
  })).min(1).max(20),
});

function fail(error) {
  return { ok: false, error };
}

function reviewSystemPrompt(mode) {
  return [
    '你是短剧深审编辑。只诊断，不改写剧本，不输出整段替换文本。',
    `本次重点：${MODE_LABELS[mode]}。`,
    '每个问题给出稳定 id（f1、f2…）、级别、剧本里的具体位置、问题、原因和一句修改方向。',
    '不要编造剧本里没有的内容；拿不出证据就不要写这条 finding。',
    '只输出一个 JSON 对象：{"findings":[{"id":"f1","severity":"blocking|warn|info","location":"...","what":"...","why":"...","direction":"..."}]}',
  ].join('\n');
}

function proposalSystemPrompt() {
  return [
    '你是剧本微创编辑。只输出被选 finding 对应的逐处改动，不输出其他建议，不重写整集。',
    'path 必须是原文中可定位的一句话或一个字段，before 必须与原文逐字一致。',
    '只输出一个 JSON 对象：{"edits":[{"finding_id":"f1","path":"原文句子","before":"原文","after":"改后文本"}]}',
  ].join('\n');
}

async function callModel(deps, userPrompt, systemPrompt) {
  if (!deps || typeof deps.generateText !== 'function') return { error: 'model_unavailable' };
  let raw;
  try {
    raw = await deps.generateText(userPrompt, systemPrompt);
  } catch (_) {
    return { error: 'review_failed' };
  }
  let parsed;
  try {
    parsed = safeParseAIJSON(String(raw || ''), {}, deps.log || { warn() {} });
  } catch (_) {
    return { error: 'review_invalid' };
  }
  return { parsed };
}

async function reviewEpisode({ db, log, episodeId, mode = 'full', notes, deps }) {
  const id = Number(episodeId);
  if (!Number.isSafeInteger(id) || id <= 0) return fail('not_found');
  const episode = db.prepare('SELECT id, script_content, description FROM episodes WHERE id = ? AND deleted_at IS NULL').get(id);
  if (!episode) return fail('not_found');
  const script = String(episode.script_content || episode.description || '').trim();
  if (!script) return fail('empty_script');
  if (!MODES.has(mode)) return fail('invalid_mode');

  const call = await callModel(deps, `本集剧本：\n${script}`, reviewSystemPrompt(mode));
  if (call.error) return fail(call.error);
  const validated = findingsSchema.safeParse(call.parsed);
  if (!validated.success || new Set(validated.data.findings.map((f) => f.id)).size !== validated.data.findings.length) {
    return fail('review_invalid');
  }

  // episodeId 不能直接当 dramaId：从 episodes 表取归属。
  const dramaRow = db.prepare('SELECT drama_id FROM episodes WHERE id = ?').get(id);
  const dramaId = dramaRow && dramaRow.drama_id;
  const kind = `episode-${id}-script-review`;
  const note = notes.readOrEmpty(dramaId, kind);
  const saved = notes.write(dramaId, kind, note.ok ? note.revision : 0, {
    mode,
    script_hash: require('crypto').createHash('sha256').update(script).digest('hex'),
    findings: validated.data.findings,
  });
  if (!saved.ok) return saved;
  return { ok: true, findings: validated.data.findings, revision: saved.revision, kind };
}

async function proposeEdits({ db, dramaId, episodeId, findingIds, notes, deps }) {
  const epId = Number(episodeId);
  const drama = Number(dramaId);
  if (!Number.isSafeInteger(epId) || epId <= 0 || !Number.isSafeInteger(drama) || drama <= 0) return fail('not_found');
  const episode = db.prepare(
    'SELECT id, script_content, description, drama_id FROM episodes WHERE id = ? AND drama_id = ? AND deleted_at IS NULL'
  ).get(epId, drama);
  if (!episode) return fail('not_found');
  const script = String(episode.script_content || episode.description || '').trim();
  if (!script) return fail('empty_script');
  const selected = Array.isArray(findingIds) ? [...new Set(findingIds.map(String))] : [];
  if (selected.length === 0) return fail('invalid_selection');

  const kind = `episode-${epId}-script-review`;
  const note = notes.read(drama, kind);
  if (!note.ok) return fail(note.error);
  const available = new Set((note.document.findings || []).map((f) => f.id));
  if (selected.some((id) => !available.has(id))) return fail('invalid_selection');

  const call = await callModel(deps, [
    `选中的 finding：${selected.join('、')}`,
    '可用 finding 列表：' + JSON.stringify(note.document.findings.filter((f) => selected.includes(f.id))),
    `本集剧本：\n${script}`,
  ].join('\n\n'), proposalSystemPrompt());
  if (call.error) return fail(call.error);
  const validated = proposalsSchema.safeParse(call.parsed);
  const covered = new Set(validated.success ? validated.data.edits.map((e) => e.finding_id) : []);
  if (!validated.success || validated.data.edits.some((e) => !selected.includes(e.finding_id))
    || selected.some((id) => !covered.has(id))) {
    return fail('review_invalid');
  }
  for (const edit of validated.data.edits) {
    if (!script.includes(edit.before) || !script.includes(edit.path)) return fail('invalid_path');
  }

  const proposalKind = `episode-${epId}-script-proposal`;
  const previous = notes.readOrEmpty(drama, proposalKind);
  const saved = notes.write(drama, proposalKind, previous.ok ? previous.revision : 0, {
    source_kind: kind,
    source_revision: note.revision,
    finding_ids: selected,
    edits: validated.data.edits,
  });
  if (!saved.ok) return saved;
  return { ok: true, proposal: validated.data.edits, revision: saved.revision, kind: proposalKind };
}

module.exports = { MODES, reviewEpisode, proposeEdits };
