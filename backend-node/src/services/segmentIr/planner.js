/**
 * 段规划器：按台词耗时、目标模型时长上下限、对白容量、硬切上限、叙事事件下限调整/拆分结构化分镜段。
 * 只在镜头边界拆段，不截断内容；一个镜头本身超上限时给出阻断级问题而不是裁短它。
 * 纯函数：输入已校验的 IR 列表与能力表，输出新的段列表与问题清单。
 */

const CHARS_PER_SECOND = 3.5; // 中文快语速：耗时下限
const SPEAKER_SWITCH_PAUSE = 0.3;
const TONE_PAUSE = 0.3; // 省略号、破折号
const CLOSING_SECONDS = 0.5; // 段尾说完收住

function countSpokenChars(text) {
  return (String(text).match(/[\p{L}\p{N}]/gu) || []).length;
}

function speakerKey(line) {
  return line.kind === 'vo' ? '__vo__' : line.speaker;
}

/** 一组台词的最短耗时（秒）：字数 / 语速 + 换人停顿 + 语气停顿 */
function lineSeconds(lines) {
  let total = 0;
  let prev = null;
  for (const line of lines) {
    total += countSpokenChars(line.text) / CHARS_PER_SECOND;
    total += (String(line.text).match(/…+|—+|\.{3,}/g) || []).length * TONE_PAUSE;
    const key = speakerKey(line);
    if (prev !== null && key !== prev) total += SPEAKER_SWITCH_PAUSE;
    prev = key;
  }
  return total;
}

/** 段时长对应的对白条数上限（>15 秒时只按单镜头 ≤2 句约束） */
function dialogueCapacity(seconds) {
  if (seconds <= 8) return 2;
  if (seconds <= 15) return 4;
  return Infinity;
}

function hardCutCap(seconds) {
  if (seconds <= 8) return 1;
  if (seconds <= 15) return 3;
  return Math.floor(seconds / 5);
}

function eventMinimum(seconds) {
  if (seconds >= 15) return 3;
  if (seconds >= 10) return 2;
  return 1;
}

const SHOT_LINE_CAP = 2;

function stats(shots) {
  return {
    seconds: shots.reduce((n, s, i) => n + (i === shots.length - 1 ? requiredShotSeconds(s, true) : s.seconds), 0),
    lines: shots.reduce((n, s) => n + s.lines.length, 0),
    cuts: shots.slice(1).filter((s) => s.cut === 'hard').length,
    events: shots.filter((s) => s.event).length,
  };
}

function upperOk(st, caps) {
  return st.seconds <= caps.duration.max && st.lines <= dialogueCapacity(st.seconds) && st.cuts <= hardCutCap(st.seconds);
}

function eventsOk(st) {
  return st.events >= eventMinimum(st.seconds);
}

/** 贪心装箱：加入下一个镜头会突破上限，或会破坏当前已满足的事件下限时，就在此处切段 */
function packShots(shots, caps) {
  const groups = [];
  let cur = [];
  for (const shot of shots) {
    if (cur.length) {
      const before = stats(cur);
      const after = stats([...cur, shot]);
      if (!upperOk(after, caps) || (eventsOk(before) && !eventsOk(after))) {
        groups.push(cur);
        cur = [];
      }
    }
    cur.push(shot);
  }
  if (cur.length) groups.push(cur);
  return groups;
}

function clone(v) {
  return JSON.parse(JSON.stringify(v));
}

/** 用一段镜头组成新的 IR：cast 只留本段出现的人；首帧/衔接参考归第一段，尾帧归最后一段；字卡按时间落段 */
function buildPart(ir, shots, startSec, isFirst, isLast) {
  const used = new Set();
  for (const s of shots) {
    s.subjects.forEach((x) => used.add(x.alias));
    s.lines.forEach((l) => l.speaker && used.add(l.speaker));
  }
  const duration = shots.reduce((n, s) => n + s.seconds, 0);
  const continuity = { mode: ir.continuity.mode };
  if (isFirst && ir.continuity.first_frame_image_id != null) continuity.first_frame_image_id = ir.continuity.first_frame_image_id;
  if (isFirst && ir.continuity.tail_ref_from != null) continuity.tail_ref_from = ir.continuity.tail_ref_from;
  if (isLast && ir.continuity.last_frame_image_id != null) continuity.last_frame_image_id = ir.continuity.last_frame_image_id;
  if (continuity.mode === 'first_last' && continuity.first_frame_image_id == null) continuity.mode = 'refs';
  return {
    ...clone(ir),
    duration_s: duration,
    continuity,
    cast: ir.cast.filter((c) => used.has(c.alias)).map(clone),
    cards: ir.cards
      .filter((c) => c.at_s >= startSec && c.at_s < startSec + duration)
      .map((c) => ({ ...c, at_s: c.at_s - startSec, hold_s: Math.min(c.hold_s, startSec + duration - c.at_s) })),
    shots: shots.map(clone),
  };
}

function splitIr(ir, groups) {
  let start = 0;
  return groups.map((shots, i) => {
    const part = buildPart(ir, shots, start, i === 0, i === groups.length - 1);
    start += part.duration_s;
    return part;
  });
}

function requiredShotSeconds(shot, closing) {
  const need = lineSeconds(shot.lines) + (closing ? CLOSING_SECONDS : 0);
  return Math.max(shot.seconds, Math.ceil(need - 1e-9));
}

/** 镜头时长不得短于其台词耗时（段尾镜头另加收束时间） */
function applyDialogueFloors(ir, withClosing) {
  ir.shots.forEach((shot, i) => {
    shot.seconds = requiredShotSeconds(shot, withClosing && i === ir.shots.length - 1);
  });
  ir.duration_s = ir.shots.reduce((n, s) => n + s.seconds, 0);
}

/** 时长补到下限并按步长向上对齐；补的时间加在最后一个镜头（不缩短） */
function alignToEnvelope(ir, caps) {
  const { min, max, step } = caps.duration;
  let target = Math.max(ir.duration_s, min);
  target = min + Math.ceil((target - min) / step) * step;
  if (caps.duration.values) target = caps.duration.values.find(value => value >= target) ?? target;
  if (target > max) target = ir.duration_s > max ? ir.duration_s : max;
  const pad = target - ir.duration_s;
  if (pad > 0) {
    ir.shots[ir.shots.length - 1].seconds += pad;
    ir.duration_s = target;
  }
  return pad;
}

/** 开场钩子：首段里第一个事件镜头及之前；集尾钩子：末段里最后一个事件镜头及之后 */
function isolateHook(seg, caps, which) {
  const shots = seg.ir.shots;
  const idx = which === 'opening' ? shots.findIndex((s) => s.event) : shots.map((s) => !!s.event).lastIndexOf(true);
  if (idx < 0) return null;
  const hook = which === 'opening' ? shots.slice(0, idx + 1) : shots.slice(idx);
  const rest = which === 'opening' ? shots.slice(idx + 1) : shots.slice(0, idx);
  if (!rest.length || !rest.some((s) => s.event)) return [seg];
  const restSt = stats(rest);
  const hookSt = stats(hook);
  if (hookSt.seconds < caps.duration.min || restSt.seconds < caps.duration.min) return null;
  const groups = which === 'opening' ? [hook, rest] : [rest, hook];
  return splitIr(seg.ir, groups).map((ir) => ({ ir, source: seg.source }));
}

/**
 * @param {object[]} irs 已校验的 IR（按播放顺序）
 * @param {{ duration: {min:number,max:number,step:number} }} caps
 * @param {{ episode?: boolean, openingHook?: boolean, closingHook?: boolean }} [opts] 整集规划时开场/集尾钩子单独成段
 * @returns {{ segments: { ir: object, source: number, part: number }[], findings: object[] }}
 */
function planSegments(irs, caps, opts = {}) {
  const openingHook = opts.openingHook ?? !!opts.episode;
  const closingHook = opts.closingHook ?? !!opts.episode;
  const findings = [];
  let segs = [];

  irs.forEach((input, source) => {
    const ir = clone(input);
    applyDialogueFloors(ir, false);
    ir.shots.forEach((s, shot) => {
      if (s.lines.length > SHOT_LINE_CAP) {
        findings.push({ level: 'warn', code: 'shot_lines_over_capacity', where: { source, shot }, msg: `单个镜头 ${s.lines.length} 句台词（建议 ≤${SHOT_LINE_CAP}），请拆镜或切到听者反应` });
      }
      const standaloneSeconds = requiredShotSeconds(s, true);
      if (standaloneSeconds > caps.duration.max) {
        findings.push({ level: 'block', code: 'shot_exceeds_max', where: { source, shot }, msg: `单个镜头 ${standaloneSeconds} 秒超过模型上限 ${caps.duration.max} 秒，需要拆镜` });
      }
    });
    const st = stats(ir.shots);
    const parts = upperOk(st, caps) && eventsOk(st) ? [ir] : splitIr(ir, packShots(ir.shots, caps));
    parts.forEach((p) => segs.push({ ir: p, source }));
  });

  if (segs.length && openingHook) {
    const r = isolateHook(segs[0], caps, 'opening');
    if (r) segs.splice(0, 1, ...r);
    else findings.push({ level: 'warn', code: 'hook_not_isolated', where: { source: segs[0].source }, msg: '开场钩子无法单独成段（时长不足模型下限）' });
  }
  if (segs.length && closingHook) {
    const last = segs.length - 1;
    const r = isolateHook(segs[last], caps, 'closing');
    if (r) segs.splice(last, 1, ...r);
    else findings.push({ level: 'warn', code: 'hook_not_isolated', where: { source: segs[last].source }, msg: '集尾钩子无法单独成段（时长不足模型下限）' });
  }

  const partCount = {};
  const segments = segs.map(({ ir, source }) => {
    const part = (partCount[source] = (partCount[source] ?? -1) + 1);
    applyDialogueFloors(ir, true);
    const pad = alignToEnvelope(ir, caps);
    const where = { source, part };
    if (pad > 0) findings.push({ level: 'info', code: 'padded', where, msg: `段时长补足 ${pad} 秒到模型范围，请在末镜补充真实动作` });
    const st = stats(ir.shots);
    if (!eventsOk(st)) {
      findings.push({ level: 'warn', code: 'event_minimum', where, msg: `${st.seconds} 秒段只有 ${st.events} 个叙事事件（至少 ${eventMinimum(st.seconds)} 个）` });
    }
    if (st.lines > dialogueCapacity(st.seconds)) {
      findings.push({ level: 'warn', code: 'dialogue_capacity', where, msg: `${st.seconds} 秒段 ${st.lines} 句台词，超过容量 ${dialogueCapacity(st.seconds)}` });
    }
    if (st.cuts > hardCutCap(st.seconds)) {
      findings.push({ level: 'warn', code: 'hard_cut_cap', where, msg: `${st.seconds} 秒段 ${st.cuts} 次硬切，超过 ${hardCutCap(st.seconds)}` });
    }
    return { ir, source, part };
  });
  return { segments, findings };
}

module.exports = { planSegments, lineSeconds, dialogueCapacity, hardCutCap, eventMinimum };
