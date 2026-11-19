import test from 'node:test'
import assert from 'node:assert/strict'

import { groupFindings, findingTag, findingWhere, irToForm, formToIr, newShotForm } from '../src/utils/segmentUi.js'

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
