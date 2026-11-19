/**
 * 结构化剧集的成片时间轴、逐句台词摆放与字幕（纯函数）。
 * 时间轴以各片段实际时长为准；IR 里的镜头秒数按比例缩放到实际片段长度上。
 */
const { lineSeconds } = require('./segmentIr/planner');

const MAX_SUB_CHARS = 12;
const LINE_GAP = 0.3;
const MAX_TEMPO = 1.25;
const ITALIC_KINDS = new Set(['os', 'vo', 'offscreen']);

/**
 * @param {{ storyboard_id: number, ir: object|null, clip_s: number, native: boolean }[]} segments 合成顺序
 * @returns {{ storyboard_id, ir, native, start_s, clip_s, shots: { start_s, end_s, shot }[] }[]}
 */
function buildTimeline(segments) {
  let t = 0;
  return segments.map((seg) => {
    const start = t;
    t += seg.clip_s;
    if (!seg.ir) return { ...seg, start_s: start, shots: [] };
    const sourceDuration = seg.edit_range ? seg.edit_range.duration_us / 1e6 : seg.clip_s;
    const scale = seg.ir.duration_s > 0 ? sourceDuration / seg.ir.duration_s : 1;
    const origin = start - (seg.edit_range?.in_us || 0) / 1e6;
    const visibleEnd = seg.edit_range ? Math.min(t, origin + seg.edit_range.out_us / 1e6) : t;
    let cursor = origin;
    const shots = seg.ir.shots.map((shot) => {
      const s = { start_s: cursor, end_s: cursor + shot.seconds * scale, shot };
      cursor = s.end_s;
      return s;
    });
    return { ...seg, start_s: start, scale, origin, visibleEnd, shots };
  });
}

/**
 * 逐句摆放：在所在镜头内依次排开；放不下就加速（至多 1.25 倍），仍放不下给出告警。
 * @param {(line, seg) => number} durationOf 句子时长（秒）：原生人声段用估算，配音段用实际 TTS 时长
 */
function planDialogueLines(timeline, durationOf) {
  const placements = [];
  const warnings = [];
  timeline.forEach((seg, si) => {
    seg.shots.forEach(({ start_s, end_s, shot }, k) => {
      let cursor = start_s;
      shot.lines.forEach((line, j) => {
        const raw = Math.max(0.2, Number(durationOf(line, seg)) || 0.2);
        const window = Math.max(0.2, end_s - cursor);
        const tempo = raw > window ? Math.min(raw / window, MAX_TEMPO) : 1;
        const dur = raw / tempo;
        if (dur > window + 1e-6) {
          warnings.push({ level: 'warn', code: 'line_overflows_shot', where: { storyboard_id: seg.storyboard_id, path: `shots.${k}.lines.${j}` }, msg: `「${line.text}」需要 ${raw.toFixed(1)} 秒，加速到 ${MAX_TEMPO} 倍后仍超出镜头剩余的 ${window.toFixed(1)} 秒` });
        }
        const visibleStart = seg.edit_range ? Math.max(seg.start_s, cursor) : cursor;
        const visibleEnd = seg.edit_range ? Math.min(cursor + dur, seg.visibleEnd) : cursor + dur;
        if (visibleEnd > visibleStart) placements.push({ segment: si, storyboard_id: seg.storyboard_id, native: seg.native, line, start_s: visibleStart, duration_s: visibleEnd - visibleStart, offset_s: visibleStart - cursor, raw_s: raw, tempo });
        cursor += dur + LINE_GAP;
      });
    });
  });
  return { placements, warnings };
}

/** 原生人声段的估算时长（与段规划器同一语速常量） */
function estimatedLineSeconds(line) {
  return lineSeconds([line]);
}

function countChars(s) {
  return (String(s).match(/[\p{L}\p{N}]/gu) || []).length;
}

/** 按标点切开再装箱，每行不超过 12 个字；单段超长时硬切；去掉行尾标点 */
function splitSubtitleText(text, max = MAX_SUB_CHARS) {
  const pieces = String(text).match(/[^，。！？；、,.!?;…—]+[，。！？；、,.!?;…—]*/g) || [String(text)];
  const lines = [];
  let cur = '';
  const push = () => { const t = cur.replace(/[，。！？；、,.!?;…—\s]+$/u, ''); if (t) lines.push(t); cur = ''; };
  for (let piece of pieces) {
    while (countChars(piece) > max) {
      let cut = 0;
      for (let n = 0; cut < piece.length && n < max; cut++) if (/[\p{L}\p{N}]/u.test(piece[cut])) n++;
      if (cur) push();
      cur = piece.slice(0, cut);
      push();
      piece = piece.slice(cut);
    }
    if (countChars(cur + piece) > max) push();
    cur += piece;
  }
  push();
  return lines;
}

function ts(sec) {
  const ms = Math.max(0, Math.round(sec * 1000));
  const h = Math.floor(ms / 3600000);
  const m = Math.floor((ms % 3600000) / 60000);
  const s = Math.floor((ms % 60000) / 1000);
  const r = ms % 1000;
  const p = (n, w = 2) => String(n).padStart(w, '0');
  return `${p(h)}:${p(m)}:${p(s)},${p(r, 3)}`;
}

function toSrt(cues) {
  return cues.map((c, i) => `${i + 1}\n${ts(c.start)} --> ${ts(c.end)}\n${c.text}\n`).join('\n');
}

/** 台词字幕：每句按字数比例分给各行；内心独白、旁白、画外音用斜体 */
function buildDialogueSrt(placements) {
  const cues = [];
  for (const p of placements) {
    const rows = splitSubtitleText(p.line.text);
    const total = rows.reduce((n, r) => n + Math.max(1, countChars(r)), 0);
    let t = p.start_s;
    for (const row of rows) {
      const d = (p.duration_s * Math.max(1, countChars(row))) / total;
      cues.push({ start: t, end: t + d, text: ITALIC_KINDS.has(p.line.kind) ? `<i>${row}</i>` : row });
      t += d;
    }
  }
  return toSrt(cues);
}

/** 字卡：IR cards 的时间换算到成片时间轴，每张至少停 2 秒 */
function buildCardsSrt(timeline) {
  const cues = [];
  for (const seg of timeline) {
    if (!seg.ir) continue;
    for (const c of seg.ir.cards) {
      const sourceStart = seg.origin + c.at_s * seg.scale;
      const sourceEnd = sourceStart + Math.max(2, c.hold_s * seg.scale);
      const start = Math.max(seg.start_s, sourceStart);
      const end = seg.edit_range ? Math.min(sourceEnd, seg.visibleEnd) : sourceEnd;
      if (end > start) cues.push({ start, end, text: c.text });
    }
  }
  return toSrt(cues.sort((a, b) => a.start - b.start));
}

module.exports = { buildTimeline, planDialogueLines, estimatedLineSeconds, splitSubtitleText, buildDialogueSrt, buildCardsSrt, MAX_TEMPO };
