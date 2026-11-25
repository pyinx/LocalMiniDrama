/**
 * notes 服务：唯一事实源是注入的 fs 适配器；所有错误路径都必须可复现。
 */
'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { createAgentNotesService } = require('../src/services/agentNotesService');

function memoryFs(initial = {}) {
  const files = new Map(Object.entries(initial));
  return {
    files,
    readFileSync(p) {
      if (!files.has(p)) {
        const err = new Error('missing');
        err.code = 'ENOENT';
        throw err;
      }
      return files.get(p);
    },
    mkdirSync() {},
    writeFileSync(p, data) { files.set(p, data); },
  };
}

describe('agent notes service', () => {
  it('notes store enforces scope, revision and corruption handling', () => {
    const io = memoryFs();
    const notes = createAgentNotesService({ dataDir: '/tmp/lmd-test', fs: io });

    assert.deepEqual(notes.read(1, 'series-bible'), { ok: false, error: 'not_found' });
    assert.deepEqual(notes.readOrEmpty(1, 'series-bible'), { ok: true, kind: 'series-bible', revision: 0, document: {} });

    const created = notes.write(1, 'series-bible', 0, { facts: ['A 不能死'] });
    assert.equal(created.ok, true);
    assert.equal(created.revision, 1);
    const loaded = notes.read(1, 'series-bible');
    assert.deepEqual(loaded.document, { facts: ['A 不能死'] });
    assert.equal(loaded.revision, 1);

    const conflict = notes.write(1, 'series-bible', 0, { facts: ['B'] });
    assert.deepEqual(conflict, { ok: false, error: 'conflict' });
    assert.deepEqual(notes.read(1, 'series-bible').document, { facts: ['A 不能死'] });

    const updated = notes.write(1, 'series-bible', 1, { facts: ['A 活着'] });
    assert.equal(updated.revision, 2);
    assert.deepEqual(notes.write(1, 'series-bible', 1, { facts: ['again'] }), { ok: false, error: 'conflict' });

    assert.deepEqual(notes.read(0, 'series-bible'), { ok: false, error: 'invalid_drama' });
    assert.deepEqual(notes.read(1, '../secret'), { ok: false, error: 'invalid_kind' });
    assert.deepEqual(notes.read(1, 'episode-0-script-review'), { ok: false, error: 'invalid_kind' });
    assert.deepEqual(notes.write(1, 'series-bible', 0, null), { ok: false, error: 'invalid_document' });
    assert.deepEqual(notes.write(1, 'series-bible', -1, {}), { ok: false, error: 'invalid_revision' });

    const file = [...io.files.keys()][0];
    assert.ok(file.includes('/agent-notes/1/series-bible.json'));
    io.files.set(file, '{not json');
    assert.deepEqual(notes.read(1, 'series-bible'), { ok: false, error: 'corrupt_note' });
    assert.deepEqual(notes.write(1, 'series-bible', 2, {}), { ok: false, error: 'corrupt_note' });

    io.files.set(file, JSON.stringify({ revision: 2, document: [] }));
    assert.deepEqual(notes.read(1, 'series-bible'), { ok: false, error: 'corrupt_note' });

    const episodeKind = notes.write(1, 'episode-11-script-review', 0, { findings: [] });
    assert.equal(episodeKind.ok, true);
    assert.ok([...io.files.keys()].some((p) => p.endsWith('/agent-notes/1/episode-11-script-review.json')));
  });
});
