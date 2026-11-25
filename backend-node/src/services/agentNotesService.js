/**
 * Agent Skill 的跨会话笔记：唯一存储是 <dataDir>/agent-notes/<dramaId>/<kind>.json。
 * kind 白名单、路径与 revision CAS 都在这里收敛；文件 IO 经 fs 适配器注入，便于测试。
 * 不建 DB 表，不写 dramas.metadata。
 */
'use strict';

const path = require('path');
const nodeFs = require('fs');

const KINDS = new Set([
  'series-bible',
  'source-deconstruction',
  'asset-matrix',
  'season-outline',
]);
const EPISODE_KINDS = new Set([
  'script-review',
  'script-proposal',
  'direction',
  'qc',
]);

function fail(error) {
  return { ok: false, error };
}

function positiveId(value) {
  const n = Number(value);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}

/** kind 白名单：固定 kind 或 episode-<正数>-<已知后缀> */
function normalizeKind(kind) {
  const value = String(kind || '');
  if (KINDS.has(value)) return value;
  const match = value.match(/^episode-(\d+)-(script-review|script-proposal|direction|qc)$/);
  if (match && EPISODE_KINDS.has(match[2])) {
    const id = positiveId(match[1]);
    if (id) return `episode-${id}-${match[2]}`;
  }
  return null;
}

function createAgentNotesService({ dataDir, fs: fsAdapter = nodeFs } = {}) {
  if (!dataDir || typeof dataDir !== 'string') throw new Error('dataDir is required');
  const root = path.resolve(dataDir, 'agent-notes');
  const io = fsAdapter;

  function notePath(dramaId, kind) {
    const id = positiveId(dramaId);
    const normalized = normalizeKind(kind);
    if (!id) return { error: 'invalid_drama' };
    if (!normalized) return { error: 'invalid_kind' };
    return { file: path.join(root, String(id), `${normalized}.json`) };
  }

  function parse(raw) {
    let value;
    try {
      value = JSON.parse(String(raw));
    } catch (_) {
      return { error: 'corrupt_note' };
    }
    if (!value || typeof value !== 'object' || Array.isArray(value)
      || !Number.isSafeInteger(value.revision) || value.revision < 1
      || !value.document || typeof value.document !== 'object' || Array.isArray(value.document)) {
      return { error: 'corrupt_note' };
    }
    return { revision: value.revision, document: value.document };
  }

  function read(dramaId, kind) {
    const location = notePath(dramaId, kind);
    if (location.error) return fail(location.error);
    let raw;
    try {
      raw = io.readFileSync(location.file, 'utf8');
    } catch (err) {
      if (err && (err.code === 'ENOENT' || err.code === 'EISDIR')) return fail('not_found');
      return fail('note_io_error');
    }
    const parsed = parse(raw);
    if (parsed.error) return fail(parsed.error);
    return { ok: true, kind: normalizeKind(kind), revision: parsed.revision, document: parsed.document };
  }

  function readOrEmpty(dramaId, kind) {
    const found = read(dramaId, kind);
    if (found.ok) return found;
    if (found.error === 'not_found') {
      const normalized = normalizeKind(kind);
      if (!positiveId(dramaId) || !normalized) return found;
      return { ok: true, kind: normalized, revision: 0, document: {} };
    }
    return found;
  }

  function write(dramaId, kind, expectedRevision, document) {
    const location = notePath(dramaId, kind);
    if (location.error) return fail(location.error);
    if (!document || typeof document !== 'object' || Array.isArray(document)) return fail('invalid_document');
    const expected = Number(expectedRevision);
    if (!Number.isSafeInteger(expected) || expected < 0) return fail('invalid_revision');

    let current = { revision: 0, document: {} };
    let raw;
    try {
      raw = io.readFileSync(location.file, 'utf8');
    } catch (err) {
      if (!err || (err.code !== 'ENOENT' && err.code !== 'EISDIR')) return fail('note_io_error');
    }
    if (raw != null) {
      const parsed = parse(raw);
      if (parsed.error) return fail(parsed.error);
      current = parsed;
    }
    if (current.revision !== expected) return fail('conflict');

    const next = { revision: current.revision + 1, document, updated_at: new Date().toISOString() };
    try {
      io.mkdirSync(path.dirname(location.file), { recursive: true });
      io.writeFileSync(location.file, JSON.stringify(next, null, 2), 'utf8');
    } catch (_) {
      return fail('note_io_error');
    }
    return { ok: true, kind: normalizeKind(kind), revision: next.revision, document };
  }

  return { root, read, readOrEmpty, write, normalizeKind };
}

module.exports = { createAgentNotesService, KINDS, EPISODE_KINDS };
