import test from 'node:test'
import assert from 'node:assert/strict'

import { createStateProposals, listVariantsWithoutImage, startVariantImages } from '../src/utils/assetStates.js'

function fakeApi({ failCreate = null, failImage = null, lists = {} } = {}) {
  const calls = []
  let nextId = 100
  return {
    calls,
    async create(kind, parentId, data) {
      calls.push(['create', kind, parentId, data])
      if (failCreate === data.name) throw Object.assign(new Error('x'), { response: { data: { error: { message: '变体数据不合法' } } } })
      return { id: nextId++, ...data }
    },
    async list(kind, parentId) {
      calls.push(['list', kind, parentId])
      return lists[`${kind}:${parentId}`] || []
    },
    async generateImage(kind, id) {
      calls.push(['image', kind, id])
      if (failImage === id) throw new Error('请先为场景生成主图')
      return { id: 900 + id, task_id: `t${id}` }
    },
  }
}

test('creates the accepted proposals and keeps going past a failed item', async () => {
  const api = fakeApi({ failCreate: '坏的' })
  const { created, errors } = await createStateProposals(api, {
    scene_states: [
      { scene_id: 3, scene_name: '卧室', name: '凌晨', state_phrase: '只有手机屏幕光' },
      { scene_id: 3, scene_name: '卧室', name: '坏的', state_phrase: 'x' },
    ],
    wardrobes: [{ character_id: 1, character_name: '林默', name: '岛上便装', change_phrase: '草帽，背心', episode_range: [2] }],
  })
  assert.deepEqual(api.calls.filter((c) => c[0] === 'create'), [
    ['create', 'scene_state', 3, { name: '凌晨', kind: 'state', state_phrase: '只有手机屏幕光' }],
    ['create', 'scene_state', 3, { name: '坏的', kind: 'state', state_phrase: 'x' }],
    ['create', 'wardrobe', 1, { name: '岛上便装', change_phrase: '草帽，背心', episode_range: [2] }],
  ])
  assert.deepEqual(created.map((v) => [v.kind, v.label]), [['scene_state', '卧室·凌晨'], ['wardrobe', '林默·岛上便装']])
  assert.deepEqual(errors, ['卧室·坏的：变体数据不合法'])
  assert.equal(api.calls.some((c) => c[0] === 'image'), false, 'creating does not start image generation')
})

test('lists only this episode\'s state variants without an image and starts their images', async () => {
  const api = fakeApi({
    failImage: 12,
    lists: {
      'scene_state:3': [
        { id: 10, name: '凌晨', kind: 'state', image_url: null },
        { id: 11, name: '白天', kind: 'state', image_url: '/static/x.png' },
        { id: 13, name: '竖屏机位', kind: 'portrait', image_url: null },
      ],
      'wardrobe:1': [
        { id: 12, name: '岛上便装', episode_range: [1, 2], image_url: '' },
        { id: 14, name: '后来的西装', episode_range: [5], image_url: null },
        { id: 15, name: '没定集数', episode_range: null, image_url: null },
      ],
    },
  })
  const pending = await listVariantsWithoutImage(api, { scenes: [{ id: 3, location: '卧室' }], characters: [{ id: 1, name: '林默' }], episodeNumber: 2 })
  assert.deepEqual(pending, [
    { kind: 'scene_state', id: 10, label: '卧室·凌晨' },
    { kind: 'wardrobe', id: 12, label: '林默·岛上便装' },
  ])
  const { started, errors } = await startVariantImages(api, pending)
  assert.deepEqual(started.map((v) => [v.id, v.task_id]), [[10, 't10']])
  assert.deepEqual(errors, ['林默·岛上便装：请先为场景生成主图'])
})
