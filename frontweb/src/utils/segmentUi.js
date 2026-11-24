/**
 * 结构化分镜（SegmentIR）界面逻辑：检查结果分级展示、IR ↔ 表单转换。
 * 不依赖 Vue，便于单测；组件只负责渲染。
 */

export function formatStoryboardDuration(value) {
  const seconds = typeof value === 'string' ? Number(value) : value
  return Number.isFinite(seconds) && seconds > 0 ? `${seconds} 秒` : '未设置'
}

/**
 * 保存分镜视频参数时决定 creation_mode：
 * 结构化分镜（有 segment_ir）由镜头包驱动，创作模式只读，必须保留服务器原值；
 * 只有旧的经典/全能分镜才允许本地单选生效。
 */
export function savedCreationMode(sb, localMode) {
  const serverMode = sb?.creation_mode === 'universal' ? 'universal' : 'classic'
  if (sb?.segment_ir) return serverMode
  return localMode === 'universal' ? 'universal' : 'classic'
}

export const FINDING_LEVELS = {
  block: { label: '阻断', type: 'danger', order: 0 },
  warn: { label: '提醒', type: 'warning', order: 1 },
  info: { label: '提示', type: 'info', order: 2 },
}

export const FACING_OPTIONS = ['正对镜头', '背向镜头', '身体侧向画左', '身体侧向画右']
export const LINE_KINDS = [
  { value: 'dialogue', label: '对白' },
  { value: 'os', label: '内心独白' },
  { value: 'vo', label: '旁白' },
  { value: 'offscreen', label: '画外音' },
]

/** 按级别分组；未知级别归入提示；blocked 表示有阻断项（不能提交） */
export function groupFindings(findings) {
  const out = { block: [], warn: [], info: [], blocked: false, total: 0 }
  for (const f of Array.isArray(findings) ? findings : []) {
    const level = FINDING_LEVELS[f && f.level] ? f.level : 'info'
    out[level].push(f)
    out.total++
  }
  out.blocked = out.block.length > 0
  return out
}

export function findingTag(f) {
  return FINDING_LEVELS[f && f.level] || FINDING_LEVELS.info
}

/** 一条问题的定位文字（段 / 镜头 / 字段） */
export function findingWhere(f) {
  const w = (f && f.where) || {}
  const parts = []
  if (w.storyboard_id != null) parts.push(`分镜 ${w.storyboard_id}`)
  else if (w.segment != null) parts.push(`第 ${w.segment + 1} 段`)
  const m = typeof w.path === 'string' ? w.path.match(/^shots\.(\d+)/) : null
  if (m) parts.push(`镜头 ${Number(m[1]) + 1}`)
  else if (w.shot != null) parts.push(`镜头 ${w.shot + 1}`)
  if (w.match) parts.push(`「${w.match}」`)
  return parts.join(' · ')
}

/** 阻断/提醒里不能交给一键优化的条目（fixable 由后端标记）；提示不算 */
export function needsManual(f) {
  return !!f && f.fixable !== true && (f.level === 'block' || f.level === 'warn')
}

/** 弹窗顶部的统计：可一键优化的条数、需手动处理的条数 */
export function optimizeSummary(findings) {
  const list = Array.isArray(findings) ? findings : []
  return { fixable: list.filter((f) => f && f.fixable === true).length, manual: list.filter(needsManual).length }
}

const FINDING_CODE_NAMES = {
  pronoun_reference: '代词指人',
  refers_previous: '承接上一段',
  fade_to_black: '淡出/黑场',
  text_or_bgm: '字幕/配乐',
  image_quality_words: '画质词',
  fraction_ratio: '分数占比',
  negation: '否定句',
  emotion_label: '情绪词',
}

/** 优化提议的逐处对比：字段名、改前、改后，以及改后仍命中的同类提醒 */
export function optimizeRows(changes) {
  return (Array.isArray(changes) ? changes : []).map((c) => ({
    path: c.path,
    label: c.label,
    before: c.before,
    after: c.after,
    remaining: (c.remaining || []).map((code) => FINDING_CODE_NAMES[code] || code),
  }))
}

const orEmpty = (v) => (v == null ? '' : String(v))
const orNull = (v) => {
  const s = v == null ? '' : String(v).trim()
  return s ? s : null
}

function clone(v) {
  return JSON.parse(JSON.stringify(v))
}

/** IR → 编辑表单：可空字段变成空串，运镜拆成开关 + 三个输入，音效用顿号连接 */
export function irToForm(ir) {
  const f = clone(ir)
  f.shots = f.shots.map((s) => ({
    ...s,
    event: orEmpty(s.event),
    hasMovement: !!s.movement,
    movement: s.movement ? { ...s.movement } : { type: '', speed: '', direction: '' },
    subjects: s.subjects.map((x) => ({ ...x, holding: orEmpty(x.holding) })),
    lines: s.lines.map((l) => ({ ...l, speaker: orEmpty(l.speaker), voice: orEmpty(l.voice) })),
    sfxText: (s.sfx || []).join('、'),
  }))
  for (const s of f.shots) delete s.sfx
  return f
}

/** 编辑表单 → IR：空串还原为 null，段时长 = 各镜头秒数之和 */
export function formToIr(form) {
  const f = clone(form)
  f.shots = f.shots.map((s) => {
    const { hasMovement, sfxText, ...rest } = s
    return {
      ...rest,
      seconds: Math.max(1, Math.round(Number(s.seconds) || 1)),
      event: orNull(s.event),
      movement: hasMovement ? { ...s.movement } : null,
      subjects: s.subjects.map((x) => ({ ...x, holding: orNull(x.holding) })),
      lines: s.lines.map((l) => ({ ...l, speaker: l.kind === 'vo' ? orNull(l.speaker) : orNull(l.speaker), voice: orNull(l.voice) })),
      sfx: String(sfxText || '').split(/[、,，]/).map((x) => x.trim()).filter(Boolean),
    }
  })
  f.duration_s = f.shots.reduce((n, s) => n + s.seconds, 0)
  // 下拉清空后可能是 undefined / ''：IR 里只能是 null 或整数 id
  f.cast = (f.cast || []).map((c) => ({ ...c, wardrobe_id: optionalId(c.wardrobe_id) }))
  f.prop_refs = (f.prop_refs || []).map((p) => ({ ...p, state_id: optionalId(p.state_id) }))
  if (f.scene) f.scene = { ...f.scene, state_id: optionalId(f.scene.state_id) }
  return f
}

function optionalId(v) {
  if (v === undefined || v === null || v === '') return null
  const n = Number(v)
  return Number.isInteger(n) && n > 0 ? n : null
}

export function newShotForm(previous) {
  return {
    seconds: 3,
    size: previous ? previous.size : '中景',
    camera: previous ? previous.camera : '平视',
    cut: 'hard',
    event: '',
    hasMovement: false,
    movement: { type: '', speed: '', direction: '' },
    subjects: [],
    action: '',
    lines: [],
    sfxText: '',
  }
}

export function newSubjectForm(alias) {
  return { alias: alias || '', frame_pos: '画面中央', facing: FACING_OPTIONS[0], gaze: '', pose: '', holding: '' }
}

export function newLineForm(speaker) {
  return { kind: 'dialogue', speaker: speaker || '', text: '', delivery: '', voice: '' }
}
