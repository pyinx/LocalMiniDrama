import test from 'node:test'
import assert from 'node:assert/strict'

import { groupFindings, findingTag, findingWhere, formatStoryboardDuration, savedCreationMode, irToForm, formToIr, newShotForm, needsManual, optimizeSummary, optimizeRows } from '../src/utils/segmentUi.js'

test('separates fixable and manual findings and counts them', () => {
  const findings = [
    { level: 'warn', code: 'mixed_style_vocabulary', where: {}, fixable: false },
    { level: 'warn', code: 'emotion_label', where: { path: 'shots.0.action' }, fixable: true },
    { level: 'warn', code: 'pronoun_reference', where: { path: 'shots.1.action' }, fixable: true },
    { level: 'block', code: 'asset_missing', where: {}, fixable: false },
    { level: 'info', code: 'padded', where: {}, fixable: false },
    { level: 'warn', code: 'old_server_without_flag', where: {} },
  ]
  assert.deepEqual(optimizeSummary(findings), { fixable: 2, manual: 3 })
  assert.equal(needsManual(findings[0]), true)
  assert.equal(needsManual(findings[1]), false)
  assert.equal(needsManual(findings[4]), false, 'info is not something to handle by hand')
  assert.deepEqual(optimizeSummary(undefined), { fixable: 0, manual: 0 })
  assert.deepEqual(optimizeSummary([]), { fixable: 0, manual: 0 })
})

test('builds before/after rows for optimized text edits', () => {
  const rows = optimizeRows([
    { path: 'shots.0.action', label: '镜头 1 · 动作', before: '眼神空洞地看着', after: '看着协议，一动不动', remaining: [] },
    { path: 'tone', label: '基调', before: '他很难过', after: '他不想说话', remaining: ['pronoun_reference', 'unknown_code'] },
  ])
  assert.deepEqual(rows[0], { path: 'shots.0.action', label: '镜头 1 · 动作', before: '眼神空洞地看着', after: '看着协议，一动不动', remaining: [] })
  assert.deepEqual(rows[1].remaining, ['代词指人', 'unknown_code'], 'known codes are named, unknown ones kept as-is')
  assert.deepEqual(optimizeRows(null), [])
})

test('planned storyboard duration preserves seconds and identifies unset values', () => {
  assert.equal(formatStoryboardDuration(6), '6 秒')
  assert.equal(formatStoryboardDuration('3.5'), '3.5 秒')
  for (const value of [null, undefined, 0, -1, '', '未知', Infinity]) {
    assert.equal(formatStoryboardDuration(value), '未设置')
  }
})

test('structured storyboard keeps server creation_mode; legacy follows local choice', () => {
  // 结构化镜头：服务器是 classic，即使本地残留 universal 也必须保住 classic（只读）
  assert.equal(savedCreationMode({ segment_ir: {}, creation_mode: 'classic' }, 'universal'), 'classic')
  assert.equal(savedCreationMode({ segment_ir: {}, creation_mode: 'universal' }, 'classic'), 'universal')
  assert.equal(savedCreationMode({ segment_ir: {} }, 'universal'), 'classic')
  // 旧镜头：本地单选决定写到服务器的模式
  assert.equal(savedCreationMode({ creation_mode: 'classic' }, 'universal'), 'universal')
  assert.equal(savedCreationMode({ creation_mode: 'universal' }, 'classic'), 'classic')
  assert.equal(savedCreationMode({}, undefined), 'classic')
})

const IR = {
  version: 1,
  duration_s: 8,
  scene: { scene_id: 3, state_id: null, setting: '会议室' },
  main_move: '缓推',
  tone: '',
  continuity: { mode: 'refs' },
  cast: [{ character_id: 1, wardrobe_id: null, alias: '林远', group: false }],
  prop_refs: [],
  cards: [],
  shots: [
    {
      seconds: 3, size: '中景', camera: '平视', cut: 'hard', event: null, movement: null,
      subjects: [{ alias: '林远', frame_pos: '画面右侧', facing: '侧身朝左', gaze: '协议', pose: '坐', holding: null }],
      action: '林远低头', lines: [], sfx: [],
    },
    {
      seconds: 5, size: '近景', camera: '正面', cut: 'continuous', event: '反问',
      movement: { type: '缓推', speed: '慢', direction: '向前' },
      subjects: [{ alias: '林远', frame_pos: '中央', facing: '面朝镜头', gaze: '画左', pose: '', holding: '笔' }],
      action: '林远抬头',
      lines: [{ kind: 'dialogue', speaker: '林远', text: '为什么？', delivery: '平静', voice: null }, { kind: 'vo', speaker: null, text: '那天。', delivery: '', voice: null }],
      sfx: ['空调声', '翻纸声'],
    },
  ],
}

test('finding levels', () => {
  const g = groupFindings([
    { level: 'warn', code: 'a' },
    { level: 'block', code: 'b' },
    { level: 'info', code: 'c' },
    { level: 'weird', code: 'd' },
  ])
  assert.equal(g.blocked, true)
  assert.deepEqual([g.block.length, g.warn.length, g.info.length, g.total], [1, 1, 2, 4])
  assert.equal(groupFindings([]).blocked, false)
  assert.equal(groupFindings(null).total, 0)
  assert.equal(findingTag({ level: 'block' }).type, 'danger')
  assert.equal(findingTag({ level: 'warn' }).type, 'warning')
  assert.equal(findingTag({}).type, 'info')
  assert.equal(findingWhere({ where: { storyboard_id: 7, path: 'shots.1.action', match: '淡出' } }), '分镜 7 · 镜头 2 · 「淡出」')
  assert.equal(findingWhere({ where: { segment: 0 } }), '第 1 段')
})

test('ir form roundtrip', () => {
  const form = irToForm(IR)
  assert.equal(form.shots[0].event, '')
  assert.equal(form.shots[0].hasMovement, false)
  assert.equal(form.shots[1].sfxText, '空调声、翻纸声')
  assert.equal(form.shots[1].lines[1].speaker, '')
  assert.deepEqual(formToIr(form), IR)

  form.shots.push({ ...newShotForm(form.shots[1]), seconds: '4', action: '门开了' })
  const ir = formToIr(form)
  assert.equal(ir.duration_s, 12, 'duration follows shot seconds')
  assert.equal(ir.shots[2].seconds, 4)
  assert.equal(ir.shots[2].movement, null)
  assert.equal(ir.shots[2].event, null)
  assert.deepEqual(ir.shots[2].sfx, [])

  const cleared = irToForm(IR)
  cleared.cast[0].wardrobe_id = undefined
  cleared.scene.state_id = ''
  const back = formToIr(cleared)
  assert.equal(back.cast[0].wardrobe_id, null)
  assert.equal(back.scene.state_id, null)
  cleared.cast[0].wardrobe_id = '7'
  assert.equal(formToIr(cleared).cast[0].wardrobe_id, 7)
})

import { jimengOptionState, confirmReducer } from '../src/utils/segmentUi.js'

test('jimeng availability disables option', () => {
  assert.equal(jimengOptionState(null).disabled, true, 'unknown status disabled until checked')
  assert.deepEqual(jimengOptionState({ available: true }), { disabled: false, label: '', detail: '' })
  for (const reason of ['not_configured', 'not_installed', 'not_logged_in', 'cli_error', 'weird']) {
    const s = jimengOptionState({ available: false, reason, message: 'm' })
    assert.equal(s.disabled, true)
    assert.ok(s.label.length > 0)
  }
  assert.match(jimengOptionState({ available: false, reason: 'not_logged_in' }).label, /login/)
})

test('estimate confirmation state machine', () => {
  const run = (events, start) => events.reduce((s, e) => confirmReducer(s, e), start)
  const conf = { token: 't', total: 400, balance: 1000, affordable: true }
  let s = run([{ type: 'estimate' }, { type: 'estimated', confirmation: conf }])
  assert.equal(s.phase, 'estimated')
  assert.equal(confirmReducer(s, { type: 'submit' }).phase, 'estimated', 'cannot submit before confirming')
  s = run([{ type: 'confirm' }, { type: 'submit' }], s)
  assert.equal(s.phase, 'submitting')
  assert.equal(confirmReducer(s, { type: 'submitted' }).phase, 'done')
  const rejected = confirmReducer(s, { type: 'rejected', code: 'confirmation_stale', message: '有改动' })
  assert.equal(rejected.phase, 'stale')
  assert.equal(rejected.confirmation, null, 'stale token discarded')
  assert.equal(confirmReducer(s, { type: 'rejected', code: 'generation_in_progress', message: 'x' }).phase, 'error')
  const changed = run([{ type: 'estimate' }, { type: 'estimated', confirmation: conf }, { type: 'configChanged' }])
  assert.equal(changed.phase, 'stale')
  assert.equal(confirmReducer(changed, { type: 'confirm' }).phase, 'stale', 'stale estimate cannot be confirmed')
  assert.equal(confirmReducer(changed, { type: 'estimate' }).phase, 'estimating', 're-estimate allowed')
  const poor = run([{ type: 'estimate' }, { type: 'estimated', confirmation: { ...conf, affordable: false } }, { type: 'confirm' }])
  assert.equal(poor.phase, 'estimated')
  assert.match(poor.error, /余额不足/)
  assert.equal(confirmReducer(undefined, { type: 'confirm' }).phase, 'idle')
})
