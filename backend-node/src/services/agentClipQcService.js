/**
 * clip-qc：成片证据聚合与作者定稿的质检笔记。
 * 只读视频生成记录、媒体检测、编译器结果和已有审片；不抽帧、不调模型、不重渲、不写业务表。
 * 每条证据有稳定 id；写笔记时重新聚合同一条 take，拒绝过期证据与未引用的断言。
 */
'use strict';

const crypto = require('crypto');
const path = require('path');
const { z } = require('zod');
const takes = require('./workbenchTakeService');
const { parseSegmentIr } = require('./segmentIr/schema');

const CLASSES = ['requirement_not_executed', 'single_take_variance', 'prompt_under_specified'];
const ACTIONS = ['revise', 'replace', 'reshoot'];

const findingsSchema = z.array(z.object({
  class: z.enum(CLASSES),
  evidence_ids: z.array(z.string().min(1)).min(1).max(50),
  visible_evidence: z.string().trim().min(1).max(2000),
  action: z.enum(ACTIONS).optional(),
  note: z.string().trim().max(2000).optional(),
})).min(1).max(50);

function fail(error) {
  return { ok: false, error };
}

function sha256(value) {
  return crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function parseJson(value) {
  if (!value) return null;
  if (typeof value === 'object') return value;
  try { return JSON.parse(String(value)); } catch (_) { return null; }
}

function evidenceRef(prefix, value) {
  return { id: `${prefix}:${sha256(value).slice(0, 16)}`, value };
}

function referenceImages(row, deps) {
  const raw = parseJson(row.reference_image_urls);
  const urls = Array.isArray(raw) ? raw : typeof raw === 'string' ? [raw] : [];
  let root = deps.storageRoot;
  let base = deps.filesBaseUrl || '';
  if (!root || !base) {
    try {
      const cfg = require('../config').loadConfig();
      root ||= require('../utils/storagePaths').storageRoot(cfg);
      base ||= String((cfg && cfg.storage && cfg.storage.base_url) || '');
    } catch (_) {
      root ||= path.join(process.cwd(), 'data', 'storage');
    }
  }
  base = String(base).replace(/\/$/, '');
  const images = [];
  const seen = new Set();
  const unknownRemote = [];
  for (const candidate of [row.first_frame_url, row.last_frame_url, row.image_url, ...urls]) {
    const value = String(candidate || '').trim();
    if (!value || seen.has(value)) continue;
    seen.add(value);
    const ref = evidenceRef('ref', value);
    let exists = false;
    let local = value.replace(/^\/static\//, '');
    if (base && local.startsWith(base + '/')) local = local.slice(base.length + 1);
    try {
      const parsed = new URL(value);
      if (parsed.origin === base && parsed.pathname.startsWith('/static/')) local = parsed.pathname.slice('/static/'.length);
    } catch (_) { /* 非绝对 URL */ }
    if (/^https?:\/\//i.test(value)) {
      const isLocalServer = base && (value.startsWith(base + '/') || value.startsWith(base.replace(/\/static$/, '') + '/static/'));
      if (!isLocalServer) {
        exists = null; // 未发起网络请求，不能声称远程图片可见
        unknownRemote.push(ref.id);
      } else {
        exists = Boolean(takes.localFile(root, local));
      }
    } else {
      exists = Boolean(takes.localFile(root, local));
    }
    images.push({ id: ref.id, path: value, exists });
  }
  return { images, unknownRemote };
}

function submittedFindings(row) {
  const compiled = parseJson(row.compiled_json);
  if (!compiled || !Array.isArray(compiled.findings)) {
    return { findings: [], gap: '这条 take 没有提交时的编译 findings，无法逐条核对作者要求' };
  }
  const findings = compiled.findings.map((f, i) => evidenceRef(`submitted-${i}`, f));
  return {
    findings: findings.map((f) => ({
      id: f.id,
      level: f.value.level,
      code: f.value.code,
      where: f.value.where,
      msg: f.value.msg,
    })),
    gap: null,
  };
}

function hints(prompt, promptId, submitted, media, references) {
  const out = [];
  const text = String(prompt || '');
  const hasConcreteDetail = /(中景|近景|远景|特写|镜头|机位|光|向左|向右|靠近|推|拉|摇|递|转身|拿起|放下|medium|close|wide|shot|camera|light|push|pull|pan)/i.test(text);
  if (!text.trim() || !hasConcreteDetail) out.push({ class: 'prompt_under_specified', basis: [promptId] });
  // 只有提交时的编译 finding 指出「作者要求已写清但未执行」时才提示未执行；
  // 提示词质量问题（action_vague / padded / info）归 prompt_under_specified，不算执行失败；不用 take 数量推断模型倾向。
  const EXECUTION_FAILURE_CODES = /not_executed|missing|unsupported|exceeds|block/i;
  const executable = submitted.findings.find((f) => EXECUTION_FAILURE_CODES.test(String(f.code || '')));
  if (executable && text.trim()) {
    out.push({ class: 'requirement_not_executed', basis: [promptId, executable.id] });
  }
  // 媒体规格异常必须与提示词里写明的同一项规格对应，不能拿画幅偏差去指认未写画幅的提示词。
  const SPEC_TOKENS = [
    { issue: /duration_short/i, prompt: /(时长|秒|duration|seconds?)/i },
    { issue: /aspect/i, prompt: /(画幅|宽高比|aspect|ratio)/i },
    { issue: /resolution|resolution_low/i, prompt: /(分辨率|resolution|\d+p)/i },
    { issue: /audio_missing/i, prompt: /(音轨|声音|有声|audio|sound)/i },
  ];
  if (media && Array.isArray(media.issues) && media.issues.length) {
    for (const pair of SPEC_TOKENS) {
      const issue = media.issues.find((i) => pair.issue.test(String(i.code || '')));
      if (issue && pair.prompt.test(text)) {
        out.push({ class: 'requirement_not_executed', basis: [promptId, media.id] });
        break;
      }
    }
  }
  if (references.some((r) => r.exists === false)) {
    const missing = references.find((r) => r.exists === false);
    out.push({ class: 'requirement_not_executed', basis: [missing.id] });
  }
  return out;
}

function scopeCheck(db, dramaId, episodeId, storyboardId, takeId) {
  const row = db.prepare(
    `SELECT s.id, s.segment_ir, e.id AS episode_id, e.drama_id
     FROM storyboards s JOIN episodes e ON e.id = s.episode_id
     WHERE s.id = ? AND s.deleted_at IS NULL AND e.deleted_at IS NULL`
  ).get(Number(storyboardId));
  if (!row || Number(row.drama_id) !== Number(dramaId) || Number(row.episode_id) !== Number(episodeId)) return null;
  const take = db.prepare(
    'SELECT * FROM video_generations WHERE id = ? AND storyboard_id = ? AND drama_id = ? AND deleted_at IS NULL'
  ).get(Number(takeId), Number(storyboardId), Number(dramaId));
  if (!take || take.status !== 'completed') return null;
  return { shot: row, take };
}

function getTakeEvidence({ db, notes, dramaId, episodeId, storyboardId, takeId, deps = {} }) {
  if (!db) return fail('not_found');
  const scoped = scopeCheck(db, dramaId, episodeId, storyboardId, takeId);
  if (!scoped) return fail('not_found');
  const { shot, take } = scoped;

  const mediaRaw = takes.parseMediaCheck(take);
  const anomaliesRaw = mediaRaw && mediaRaw.anomalies && Array.isArray(mediaRaw.anomalies.items) ? mediaRaw.anomalies.items : [];
  const mediaRef = evidenceRef('media', { take_id: take.id, media_check: mediaRaw || null });
  const media = {
    id: mediaRef.id,
    status: mediaRaw ? mediaRaw.status || 'unknown' : 'unavailable',
    issues: Array.isArray(mediaRaw && mediaRaw.issues) ? mediaRaw.issues : [],
    anomalies: anomaliesRaw.map((item, i) => ({ ...item, id: evidenceRef(`anomaly-${i}`, item).id })),
  };
  const promptRef = evidenceRef('prompt', take.prompt || '');
  const reviews = takes.reviews(db, take.id).map((r) => ({
    id: evidenceRef('review', [r.id, r.time_ms, r.note]).id,
    time_ms: r.time_ms,
    note: r.note,
    action: r.action,
    status: r.status,
  }));
  const { images: references, unknownRemote } = referenceImages(take, deps);
  const submitted = submittedFindings(take);

  const evidenceGaps = ['当前工具不抽关键帧：画面内容、表演与切点需作者目视后写入 visible_evidence'];
  if (!mediaRaw) evidenceGaps.push('这条 take 没有媒体检测结果，黑屏/冻结等信息缺失');
  if (submitted.gap) evidenceGaps.push(submitted.gap);
  if (!references.length) evidenceGaps.push('这条 take 未记录参考图或首尾帧路径');
  if (unknownRemote.length) evidenceGaps.push('远程参考图未发起网络验证，存在性未知，不能作为目视证据');
  if (!reviews.length) evidenceGaps.push('这条 take 还没有时间码审片记录');
  if (!parseSegmentIr(shot.segment_ir || '').ok) evidenceGaps.push('分镜不是可解析的 SegmentIR，作者要求无法逐条核对');

  const snapshot = [take.id, take.prompt, mediaRaw, reviews, submitted.findings, references];
  const evidenceId = evidenceRef('evidence', snapshot).id;
  const evidenceIds = [
    promptRef.id,
    media.id,
    ...media.anomalies.map((a) => a.id),
    ...submitted.findings.map((f) => f.id),
    ...references.map((r) => r.id),
    ...reviews.map((r) => r.id),
  ];

  return {
    ok: true,
    evidence_id: evidenceId,
    evidence_ids: evidenceIds,
    drama_id: Number(dramaId),
    episode_id: Number(episodeId),
    storyboard_id: Number(storyboardId),
    take_id: take.id,
    model: take.model || null,
    prompt: { id: promptRef.id, text: String(take.prompt || '') },
    compiled_findings: submitted.findings,
    blocked: submitted.findings.some((f) => f.level === 'block'),
    media_check: media,
    reference_images: references,
    reviews,
    attribution_hints: hints(take.prompt, promptRef.id, submitted, media, references),
    evidence_gaps: evidenceGaps,
  };
}

function recordClipFindings({ db, notes, dramaId, episodeId, evidence, expected_revision, findings, deps = {} }) {
  if (!db || !notes) return fail('not_found');
  if (!evidence || evidence.ok !== true || !evidence.evidence_id) return fail('stale_evidence');
  if (Number(dramaId) !== Number(evidence.drama_id) || Number(episodeId) !== Number(evidence.episode_id)) {
    return fail('not_found');
  }
  const validated = findingsSchema.safeParse(findings);
  if (!validated.success) return fail('invalid_finding');
  const submittedIds = new Set(Array.isArray(evidence.evidence_ids) ? evidence.evidence_ids : []);
  if (validated.data.some((f) => f.evidence_ids.some((id) => !submittedIds.has(id)))) return fail('invalid_finding');

  const episode = db.prepare(
    'SELECT id FROM episodes WHERE id = ? AND drama_id = ? AND deleted_at IS NULL'
  ).get(Number(evidence.episode_id), Number(evidence.drama_id));
  if (!episode) return fail('not_found');

  const kind = `episode-${Number(evidence.episode_id)}-qc`;
  const note = notes.readOrEmpty(Number(evidence.drama_id), kind);
  if (!note.ok) return fail(note.error);
  const revision = Number(expected_revision);
  if (!Number.isSafeInteger(revision) || revision < 0) return fail('invalid_revision');
  if (revision !== note.revision) return fail('conflict');
  if (revision === 0 && note.document && Object.keys(note.document).length) return fail('conflict');

  const current = getTakeEvidence({
    db, notes,
    dramaId: evidence.drama_id,
    episodeId: evidence.episode_id,
    storyboardId: evidence.storyboard_id,
    takeId: evidence.take_id,
    deps,
  });
  if (!current.ok || current.evidence_id !== evidence.evidence_id) return fail('stale_evidence');
  const allowed = new Set(current.evidence_ids);
  if (validated.data.some((f) => f.evidence_ids.some((id) => !allowed.has(id)))) return fail('invalid_finding');

  const saved = notes.write(Number(evidence.drama_id), kind, note.revision, {
    ...note.document,
    take_evidence_id: evidence.evidence_id,
    findings: [...(Array.isArray(note.document.findings) ? note.document.findings : []), ...validated.data.map((f) => ({
      ...f,
      recorded_at: new Date().toISOString(),
    }))],
  });
  if (!saved.ok) return fail(saved.error);
  return { ok: true, revision: saved.revision, findings: saved.document.findings };
}

module.exports = { getTakeEvidence, recordClipFindings, CLASSES };
