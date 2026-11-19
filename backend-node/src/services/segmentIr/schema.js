/**
 * 结构化分镜段（SegmentIR v1）：一条 storyboard = 一次视频请求，这里是该段的结构化意图。
 * 在入库边界校验一次（LLM 输出、IR 编辑接口、应用内助手）；之后的代码直接信任校验后的对象。
 */
const { z } = require('zod');

const text = z.string().trim().min(1);
const id = z.number().int().positive();
const nullableId = id.nullable().default(null);

const subjectSchema = z.object({
  alias: text,
  frame_pos: text,
  facing: text,
  gaze: text,
  pose: z.string().default(''),
  holding: z.string().nullable().default(null),
});

const lineSchema = z.object({
  kind: z.enum(['dialogue', 'os', 'vo', 'offscreen']),
  speaker: z.string().trim().min(1).nullable().default(null),
  text,
  delivery: z.string().default(''),
  voice: z.string().nullable().default(null),
});

const shotSchema = z.object({
  seconds: z.number().int().min(1),
  size: text,
  camera: text,
  cut: z.enum(['hard', 'continuous']).default('hard'),
  event: z.string().nullable().default(null),
  movement: z
    .object({ type: text, speed: z.string().default(''), direction: z.string().default('') })
    .nullable()
    .default(null),
  subjects: z.array(subjectSchema).default([]),
  action: text,
  lines: z.array(lineSchema).default([]),
  sfx: z.array(z.string()).default([]),
});

const segmentIrObject = z.object({
  version: z.literal(1),
  duration_s: z.number().int().min(1),
  scene: z.object({ scene_id: id, state_id: nullableId, setting: text }),
  main_move: z.string().default(''),
  tone: z.string().default(''),
  continuity: z
    .object({
      mode: z.enum(['refs', 'first_last']).default('refs'),
      first_frame_image_id: id.optional(),
      last_frame_image_id: id.optional(),
      tail_ref_from: id.optional(),
    })
    .default({ mode: 'refs' }),
  cast: z
    .array(z.object({ character_id: id, wardrobe_id: nullableId, alias: text, group: z.boolean().default(false) }))
    .default([]),
  prop_refs: z.array(z.object({ prop_id: id, state_id: nullableId, alias: text })).default([]),
  cards: z
    .array(z.object({ text, at_s: z.number().min(0), hold_s: z.number().positive() }))
    .default([]),
  shots: z.array(shotSchema).min(1),
});

const SPEAKER_KINDS = new Set(['dialogue', 'os', 'offscreen']);

/** 跨字段规则：秒数之和 = 段时长；别名唯一；出镜/说话人都在 cast 里；字卡不越出段；首尾帧模式要有首帧 */
const segmentIrSchema = segmentIrObject.superRefine((ir, ctx) => {
  const sum = ir.shots.reduce((n, s) => n + s.seconds, 0);
  if (sum !== ir.duration_s) {
    ctx.addIssue({ code: 'custom', path: ['duration_s'], message: `各分镜秒数之和 ${sum} 与段时长 ${ir.duration_s} 不一致` });
  }
  const seen = new Set();
  const castAliases = new Set();
  ir.cast.forEach((c, i) => {
    if (seen.has(c.alias)) ctx.addIssue({ code: 'custom', path: ['cast', i, 'alias'], message: `别名重复：${c.alias}` });
    seen.add(c.alias);
    castAliases.add(c.alias);
  });
  ir.prop_refs.forEach((p, i) => {
    if (seen.has(p.alias)) ctx.addIssue({ code: 'custom', path: ['prop_refs', i, 'alias'], message: `别名重复：${p.alias}` });
    seen.add(p.alias);
  });
  ir.shots.forEach((shot, si) => {
    shot.subjects.forEach((s, i) => {
      if (!castAliases.has(s.alias)) {
        ctx.addIssue({ code: 'custom', path: ['shots', si, 'subjects', i, 'alias'], message: `出镜角色 ${s.alias} 不在 cast 中` });
      }
    });
    shot.lines.forEach((l, i) => {
      if (l.speaker == null) {
        if (SPEAKER_KINDS.has(l.kind)) {
          ctx.addIssue({ code: 'custom', path: ['shots', si, 'lines', i, 'speaker'], message: `${l.kind} 台词必须有说话人` });
        }
      } else if (!castAliases.has(l.speaker)) {
        ctx.addIssue({ code: 'custom', path: ['shots', si, 'lines', i, 'speaker'], message: `说话人 ${l.speaker} 不在 cast 中` });
      }
    });
  });
  ir.cards.forEach((c, i) => {
    if (c.at_s + c.hold_s > ir.duration_s) {
      ctx.addIssue({ code: 'custom', path: ['cards', i], message: `字卡「${c.text}」超出段时长` });
    }
  });
  if (ir.continuity.mode === 'first_last' && ir.continuity.first_frame_image_id == null) {
    ctx.addIssue({ code: 'custom', path: ['continuity', 'first_frame_image_id'], message: '首尾帧模式需要首帧图片' });
  }
});

/**
 * @param {object|string} input
 * @returns {{ ok: true, ir: object } | { ok: false, errors: { path: string, message: string }[] }}
 */
function parseSegmentIr(input) {
  let value = input;
  if (typeof input === 'string') {
    try {
      value = JSON.parse(input);
    } catch (e) {
      return { ok: false, errors: [{ path: '', message: 'IR 不是合法 JSON：' + e.message }] };
    }
  }
  const r = segmentIrSchema.safeParse(value);
  if (r.success) return { ok: true, ir: r.data };
  return { ok: false, errors: r.error.issues.map((iss) => ({ path: iss.path.join('.'), message: iss.message })) };
}

module.exports = { parseSegmentIr, SEGMENT_IR_VERSION: 1 };
