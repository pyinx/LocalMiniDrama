/**
 * novel-deconstruct：从当前剧已有的小说源文本建事实卡、按可拍事件提议分集切点。
 * 只读 episodes.novel_source 与 notes，不调用任何写 episodes 的导入函数。
 */
'use strict';

const crypto = require('crypto');
const { detectChaptersByRules } = require('./novelImportService');

function fail(error) {
  return { ok: false, error };
}

function sha256(text) {
  return crypto.createHash('sha256').update(String(text)).digest('hex');
}

function findSource(db, dramaId) {
  const rows = db.prepare(
    `SELECT id, novel_source FROM episodes
     WHERE drama_id = ? AND deleted_at IS NULL AND novel_source IS NOT NULL AND TRIM(novel_source) != ''
     ORDER BY episode_number ASC, id ASC`
  ).all(Number(dramaId));
  for (const row of rows) {
    try {
      const parsed = JSON.parse(row.novel_source);
      if (parsed && typeof parsed.text === 'string' && parsed.text.trim()) {
        return { episodeId: row.id, text: parsed.text, parts: Array.isArray(parsed.parts) ? parsed.parts : [] };
      }
    } catch (_) { /* 损坏的源跳过 */ }
  }
  return null;
}

function getSourceFacts(db, notes, dramaId, input = {}) {
  if (!Number.isSafeInteger(Number(dramaId)) || Number(dramaId) <= 0) return fail('not_found');
  const source = findSource(db, dramaId);
  if (!source) return fail('not_found');
  const hash = sha256(source.text);
  const requested = input.source_hash ? String(input.source_hash) : null;
  const note = notes.readOrEmpty(Number(dramaId), 'source-deconstruction');
  if (!note.ok) return fail(note.error);
  if (requested && requested !== hash) return fail('source_changed');
  if (note.document && note.document.source_hash && note.document.source_hash !== hash) return fail('source_changed');
  return {
    ok: true,
    source_hash: hash,
    source_episode_id: source.episodeId,
    chapters: (note.document.chapters || []).length
      ? note.document.chapters
      : detectChaptersByRules(source.text).map((c) => ({ title: c.title, content_preview: String(c.content).slice(0, 120) })),
    facts: note.document.facts || [],
    revision: note.revision,
  };
}

function proposeEpisodeSplit(db, notes, dramaId, input = {}) {
  if (!Number.isSafeInteger(Number(dramaId)) || Number(dramaId) <= 0) return fail('not_found');
  const count = Number(input.episode_count);
  if (!Number.isSafeInteger(count) || count < 1 || count > 200) return fail('invalid_count');
  const source = findSource(db, dramaId);
  if (!source) return fail('not_found');
  const hash = sha256(source.text);
  if (input.source_hash && String(input.source_hash) !== hash) return fail('source_changed');
  const note = notes.readOrEmpty(Number(dramaId), 'source-deconstruction');
  if (!note.ok) return fail(note.error);
  if (note.document && note.document.source_hash && note.document.source_hash !== hash) return fail('source_changed');

  const chapters = detectChaptersByRules(source.text);
  const units = chapters.length ? chapters.map((c) => ({
    title: c.title,
    weight: Math.max(1, String(c.content).length),
    episode_number: c.episode_number || null,
  })) : [{ title: '序章', weight: Math.max(1, source.text.length), episode_number: null }];
  // 每个来源单元必须落进恰好一集；单元多于集数时合并，集数多于单元时按权重多分配。
  const totalWeight = units.reduce((n, u) => n + u.weight, 0);
  const proposal = [];
  if (units.length >= count) {
    // 每个单元恰好落进一集：按单元序号均匀分到 count 集，权重只影响提示不做丢弃。
    for (let ep = 1; ep <= count; ep++) {
      const from = Math.floor(((ep - 1) * units.length) / count);
      const to = Math.floor((ep * units.length) / count);
      proposal.push({
        source_titles: units.slice(from, Math.max(from + 1, to)).map((u) => u.title),
        from_episode: ep,
        to_episode: ep,
      });
    }
  } else {
    // 单元少于集数：一个单元可以横跨多集，按累计权重分配边界。
    let episode = 1;
    for (let i = 0; i < units.length; i++) {
      const start = episode;
      const remainingUnits = units.length - i - 1;
      const end = i === units.length - 1
        ? count
        : Math.min(count - remainingUnits, Math.max(start, Math.round((units[i].weight / totalWeight) * count)));
      proposal.push({ source_titles: [units[i].title], from_episode: start, to_episode: end });
      episode = end + 1;
    }
  }
  const saved = notes.write(Number(dramaId), 'source-deconstruction', note.ok ? note.revision : 0, {
    source_hash: hash,
    source_episode_id: source.episodeId,
    chapters: units,
    facts: note.document.facts || [],
    split_proposal: proposal,
    episode_count: count,
  });
  if (!saved.ok) return fail(saved.error);
  return { ok: true, source_hash: hash, proposal, revision: saved.revision };
}

module.exports = { getSourceFacts, proposeEpisodeSplit, sha256 };
