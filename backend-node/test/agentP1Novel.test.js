'use strict';
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { createAgentTestDb, seedTwoDramas } = require('./helpers/agentTestDb');
const { createAgentNotesService } = require('../src/services/agentNotesService');
const { getSourceFacts, proposeEpisodeSplit, sha256 } = require('../src/services/agentNovelService');

function memoryFs() {
  const files = new Map();
  return {
    files,
    readFileSync(p) {
      if (!files.has(p)) { const e = new Error('missing'); e.code = 'ENOENT'; throw e; }
      return files.get(p);
    },
    mkdirSync() {},
    writeFileSync(p, d) { files.set(p, d); },
  };
}

const SOURCE = '第一章 开端\n甲走进房间，看见桌上的信。\n第二章 转折\n乙推门进来，把信撕成两半。\n第三章 结局\n甲拿起碎片，转身离开。';

function fixtures() {
  const db = createAgentTestDb();
  const ids = seedTwoDramas(db);
  const io = memoryFs();
  const notes = createAgentNotesService({ dataDir: '/tmp/p1-novel', fs: io });
  db.prepare('UPDATE episodes SET novel_source = ? WHERE id = ?')
    .run(JSON.stringify({ text: SOURCE, parts: [{ start: 0, end: SOURCE.length }] }), ids.episodeA1);
  return { db, ids, notes, io };
}

describe('novel deconstruction', () => {
  it('novel deconstruction reads source, detects change and proposes split', () => {
    const { db, ids, notes } = fixtures();

    assert.deepEqual(getSourceFacts(db, notes, ids.dramaB, {}), { ok: false, error: 'not_found' });
    const facts = getSourceFacts(db, notes, ids.dramaA, {});
    assert.equal(facts.ok, true);
    assert.equal(facts.source_hash, sha256(SOURCE));
    assert.deepEqual(facts.facts, []);
    assert.ok(facts.chapters.length >= 2);
    assert.equal(facts.chapters[0].title, '第一章 开端');

    const changed = getSourceFacts(db, notes, ids.dramaA, { source_hash: 'deadbeef' });
    assert.deepEqual(changed, { ok: false, error: 'source_changed' });

    assert.deepEqual(proposeEpisodeSplit(db, notes, ids.dramaA, { source_hash: sha256(SOURCE), episode_count: 0 }),
      { ok: false, error: 'invalid_count' });
    assert.deepEqual(proposeEpisodeSplit(db, notes, ids.dramaA, { source_hash: 'bad', episode_count: 3 }),
      { ok: false, error: 'source_changed' });

    const split = proposeEpisodeSplit(db, notes, ids.dramaA, { source_hash: sha256(SOURCE), episode_count: 3 });
    assert.equal(split.ok, true);
    assert.equal(split.proposal.reduce((n, p) => n + (p.to_episode - p.from_episode + 1), 0), 3);
    assert.equal(split.proposal[0].from_episode, 1);
    assert.equal(notes.read(ids.dramaA, 'source-deconstruction').document.split_proposal.length, split.proposal.length);

    // 回归：集数少于/等于章节数时，每个来源章节都要被覆盖，且区间不倒挂
    for (const n of [1, 2, 3]) {
      const small = proposeEpisodeSplit(db, notes, ids.dramaA, { source_hash: sha256(SOURCE), episode_count: n });
      assert.equal(small.ok, true);
      const titles = small.proposal.flatMap((p) => p.source_titles);
      assert.equal(new Set(titles).size, 3, `count=${n} 应覆盖全部 3 章`);
      for (const p of small.proposal) assert.ok(p.from_episode <= p.to_episode, `count=${n} 区间倒挂`);
    }

    // 源文本变化后旧 notes 不能再被当作有效事实
    db.prepare('UPDATE episodes SET novel_source = ? WHERE id = ?')
      .run(JSON.stringify({ text: SOURCE + '\n第四章 新章', parts: [] }), ids.episodeA1);
    assert.deepEqual(getSourceFacts(db, notes, ids.dramaA, {}), { ok: false, error: 'source_changed' });
    assert.deepEqual(proposeEpisodeSplit(db, notes, ids.dramaA, { episode_count: 3 }),
      { ok: false, error: 'source_changed' });
    assert.equal(db.prepare('SELECT script_content FROM episodes WHERE id = ?').get(ids.episodeA1).script_content, '甲集剧本');
  });
});
