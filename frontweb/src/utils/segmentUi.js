/**
 * 结构化分镜（SegmentIR）界面逻辑：检查结果分级展示、IR ↔ 表单转换。
 * 不依赖 Vue，便于单测；组件只负责渲染。
 */

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

// ---- 即梦（jimeng-novel）可选后端 ----

const JIMENG_REASONS = {
  not_configured: '未在「AI 配置」里启用即梦（jimeng_novel）',
  not_installed: '本机没有安装 jimeng-novel',
  not_logged_in: '即梦未登录或登录已过期（终端执行 jimeng-novel login）',
  cli_error: 'jimeng-novel 运行出错',
}

/** 即梦选项是否可用及原因：未知状态也先禁用，避免在检查完成前提交 */
export function jimengOptionState(status) {
  if (!status) return { disabled: true, label: '正在检查即梦是否可用…', detail: '' }
  if (status.available) return { disabled: false, label: '', detail: '' }
  return { disabled: true, label: JIMENG_REASONS[status.reason] || '即梦暂不可用', detail: status.message || '' }
}

/**
 * 报价确认状态机：idle(未报价) → estimating → estimated(已报价) → confirmed(已确认) → submitting(提交中) → done；
 * 报价后配置变化 → stale(失效，须重新报价)；提交被判定 token 过期/已用/缺失也回到 stale。
 * 非法事件不改变状态。
 */
export function confirmReducer(state, event) {
  const s = state || { phase: 'idle', confirmation: null, error: '' }
  const e = event || {}
  const to = (phase, extra = {}) => ({ ...s, phase, error: '', ...extra })
  switch (e.type) {
    case 'estimate':
      return ['idle', 'estimated', 'stale', 'error', 'done'].includes(s.phase) ? to('estimating', { confirmation: null }) : s
    case 'estimated':
      return s.phase === 'estimating' ? to('estimated', { confirmation: e.confirmation }) : s
    case 'failed':
      return ['estimating', 'submitting'].includes(s.phase) ? to('error', { error: e.message || '操作失败' }) : s
    case 'confirm':
      if (s.phase !== 'estimated' || !s.confirmation) return s
      if (s.confirmation.affordable === false) return { ...s, error: '积分余额不足' }
      return to('confirmed')
    case 'configChanged':
      return ['estimated', 'confirmed'].includes(s.phase) ? to('stale', { confirmation: null }) : s
    case 'submit':
      return s.phase === 'confirmed' ? to('submitting') : s
    case 'submitted':
      return s.phase === 'submitting' ? to('done') : s
    case 'rejected':
      if (s.phase !== 'submitting') return s
      if (['confirmation_stale', 'confirmation_consumed', 'confirmation_required'].includes(e.code)) {
        return to('stale', { confirmation: null, error: e.message || '报价已失效，请重新报价' })
      }
      return to('error', { error: e.message || '提交失败' })
    default:
      return s
  }
}
