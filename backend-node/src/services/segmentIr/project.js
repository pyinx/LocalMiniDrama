/**
 * IR → 旧分镜字段的投影，以及 IR 分镜的字段所有权。
 * 有 segment_ir 的分镜以 IR 为唯一来源：下列旧字段只由投影写入，通用更新不得改变它们。
 * universal_segment_text 不投影（编译文本依赖 IR 之外的模型配置，只在预览时即时生成），
 * 但同样归 IR 所有：旧的全能文本生成/润色不能再改写它。
 */

const PROJECTED_FIELDS = ['dialogue', 'action', 'duration', 'shot_type', 'movement', 'characters', 'scene_id'];
const IR_OWNED_FIELDS = [...PROJECTED_FIELDS, 'universal_segment_text'];

const LINE_LABEL = { dialogue: '', os: '（os）', offscreen: '（画外）' };

function lineToLegacy(line) {
  if (line.kind === 'vo') return `旁白（vo）：${line.text}`;
  return `${line.speaker}${LINE_LABEL[line.kind]}：${line.text}`;
}

function distinct(values) {
  return [...new Set(values.filter(Boolean))];
}

/** @param {object} ir 已通过 parseSegmentIr 校验的 IR */
function projectLegacyFields(ir) {
  const shots = ir.shots;
  return {
    dialogue: shots.flatMap((s) => s.lines.map(lineToLegacy)).join('\n'),
    action: shots.map((s) => s.action).join('；'),
    duration: ir.duration_s,
    shot_type: distinct(shots.map((s) => s.size)).join('、'),
    movement: ir.main_move || distinct(shots.map((s) => s.movement && s.movement.type)).join('、'),
    characters: JSON.stringify(distinct(ir.cast.map((c) => c.character_id))),
    scene_id: ir.scene.scene_id,
  };
}

function idList(value) {
  let arr = value;
  if (typeof value === 'string') {
    try { arr = JSON.parse(value); } catch (_) { return null; }
  }
  if (!Array.isArray(arr)) return [];
  return arr.map((x) => Number(typeof x === 'object' && x != null ? x.id : x)).filter(Number.isFinite);
}

function sameValue(field, current, next) {
  if (field === 'characters') return JSON.stringify(idList(current)) === JSON.stringify(idList(next));
  if (field === 'duration' || field === 'scene_id') {
    const a = current == null || current === '' ? null : Number(current);
    const b = next == null || next === '' ? null : Number(next);
    return a === b;
  }
  return (current ?? '') === (next ?? '');
}

/** 通用更新里会改变 IR 所有字段的那些字段名；值未变（前端整对象保存）不算 */
function ownedFieldChanges(row, patch) {
  const changed = [];
  for (const field of IR_OWNED_FIELDS) {
    const next = field === 'characters' && patch.character_ids !== undefined ? patch.character_ids : patch[field];
    if (next === undefined) continue;
    if (!sameValue(field, row[field], next)) changed.push(field);
  }
  return changed;
}

class SegmentIrOwnedError extends Error {
  constructor(fields, message) {
    super(message || `该分镜由结构化分镜（IR）管理，${fields.length ? `字段 ${fields.join('、')} ` : ''}只能通过结构化编辑修改`);
    this.code = 'segment_ir_owned';
    this.fields = fields;
  }
}

class SegmentIrInvalidError extends Error {
  constructor(errors) {
    super('结构化分镜校验失败：' + errors.slice(0, 3).map((e) => `${e.path || '(root)'} ${e.message}`).join('；'));
    this.code = 'segment_ir_invalid';
    this.errors = errors;
  }
}

module.exports = {
  PROJECTED_FIELDS,
  IR_OWNED_FIELDS,
  projectLegacyFields,
  ownedFieldChanges,
  SegmentIrOwnedError,
  SegmentIrInvalidError,
};
