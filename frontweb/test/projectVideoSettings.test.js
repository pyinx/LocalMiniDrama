import test from 'node:test'
import assert from 'node:assert/strict'
import {
  VIDEO_SETTING_KEYS, visibleKeys, scopeOf, resolutionOf, mergeOptionsFromSettings,
  saveEpisodeSetting, saveProjectSetting, hasGeneratedAssets, assetMismatchNotice,
} from '../src/utils/videoSettings.js'

const project = {
  resolution: '720p', subtitle: true, voice_source: 'native', dialogue_burn: false,
  watermark: { enabled: false, text: '' }, dialogue_subtitles: true, cards: true,
  bgm: { url: '', volume_db: -18 }, review_sheets: true,
}

/** 假 api：记录调用，断言「只调了该调的接口」 */
function fakeApi() {
  const calls = []
  return {
    calls,
    saveVideoSettings: (id, patch) => { calls.push(['project', id, patch]); return Promise.resolve(patch) },
    saveEpisodeVideoSettings: (id, patch) => { calls.push(['episode', id, patch]); return Promise.resolve(patch) },
  }
}

test('合成选项与视频请求取有效设置', () => {
  // 覆盖了分辨率与水印的集 vs 完全跟随项目的集
  const overridden = { ...project, resolution: '1080p', watermark: { enabled: true, text: '  第一集专用  ' } }
  assert.equal(resolutionOf(overridden), '1080p')
  assert.equal(resolutionOf(project), '720p')
  assert.equal(resolutionOf(null), undefined, '没有有效设置时不传，由后端决定')

  const a = mergeOptionsFromSettings(overridden, { mode: 'complete', structured: false })
  assert.deepEqual(a, {
    delivery_mode: 'complete', burn_narration_subtitles: true, burn_dialogue_audio: false, watermark_text: '第一集专用',
  })
  const b = mergeOptionsFromSettings(project, { mode: 'draft', structured: false })
  assert.equal(b.delivery_mode, 'draft')
  assert.equal(b.watermark_text, '', '水印关闭不烧录')

  // 水印开启但文字为空：与改动前一致，不烧录
  assert.equal(mergeOptionsFromSettings({ ...project, watermark: { enabled: true, text: ' ' } }).watermark_text, '')
  // 超长文字截到 200
  assert.equal(mergeOptionsFromSettings({ ...project, watermark: { enabled: true, text: 'x'.repeat(250) } }).watermark_text.length, 200)

  // 结构化分镜才带四项；背景音乐地址为空则不传
  const s = mergeOptionsFromSettings({ ...project, cards: false, review_sheets: false }, { structured: true })
  assert.equal(s.dialogue_subtitles, true)
  assert.equal(s.cards, false)
  assert.equal(s.review_sheets, false)
  assert.equal(s.bgm, undefined)
  const withBgm = mergeOptionsFromSettings({ ...project, bgm: { url: ' /static/a.mp3 ', volume_db: -24 } }, { structured: true })
  assert.deepEqual(withBgm.bgm, { url: '/static/a.mp3', volume_db: -24 })
  for (const key of ['dialogue_subtitles', 'cards', 'review_sheets', 'bgm']) assert.ok(!(key in a), key + ' 不应出现在非结构化分镜的选项里')

  // 没有有效设置时全部为关，且不抛错
  assert.deepEqual(mergeOptionsFromSettings(null), {
    delivery_mode: 'complete', burn_narration_subtitles: false, burn_dialogue_audio: false, watermark_text: '',
  })
})

test('项目详情页改项目默认', async () => {
  const api = fakeApi()
  await saveProjectSetting(api, 7, 'resolution', '1080p')
  await saveProjectSetting(api, 7, 'watermark', { enabled: true, text: '全剧水印' })
  await saveProjectSetting(api, 7, 'resolution', null)
  assert.deepEqual(api.calls, [
    ['project', 7, { resolution: '1080p' }],
    ['project', 7, { watermark: { enabled: true, text: '全剧水印' } }],
    ['project', 7, { resolution: null }],
  ], '只调项目接口，一次一项，null 表示回到默认值')
})

test('创作页改动只保存为本集覆盖', async () => {
  const api = fakeApi()
  await saveEpisodeSetting(api, 21, 'subtitle', false)
  await saveEpisodeSetting(api, 21, 'subtitle', null)
  assert.deepEqual(api.calls, [
    ['episode', 21, { subtitle: false }],
    ['episode', 21, { subtitle: null }],
  ], '只调分集接口，从不改项目默认；null 表示恢复随项目')

  const episode = { video_settings: { overrides: { resolution: '1080p' }, effective: { ...project, resolution: '1080p' } } }
  assert.equal(scopeOf(episode, 'resolution'), 'episode')
  assert.equal(scopeOf(episode, 'subtitle'), 'project')
  assert.equal(scopeOf({}, 'resolution'), 'project', '没有 video_settings 时按随项目处理')
  assert.equal(scopeOf(null, 'resolution'), 'project')

  // 9 项齐全；非结构化分镜不显示结构化专属的 5 项
  assert.equal(VIDEO_SETTING_KEYS.length, 9)
  assert.deepEqual(visibleKeys({ structured: false }), ['resolution', 'subtitle', 'dialogue_burn', 'watermark'])
  assert.deepEqual(visibleKeys({ structured: true }), VIDEO_SETTING_KEYS)
})

test('台词声音只在结构化分集显示，并沿用既有保存路径', async () => {
  assert.ok(VIDEO_SETTING_KEYS.includes('voice_source'))
  assert.ok(visibleKeys({ structured: true }).includes('voice_source'))
  assert.ok(!visibleKeys({ structured: false }).includes('voice_source'), '非结构化分集不显示')

  const api = fakeApi()
  await saveEpisodeSetting(api, 21, 'voice_source', 'dubbed')
  await saveEpisodeSetting(api, 21, 'voice_source', null)
  await saveProjectSetting(api, 7, 'voice_source', 'native')
  assert.deepEqual(api.calls, [
    ['episode', 21, { voice_source: 'dubbed' }],
    ['episode', 21, { voice_source: null }],
    ['project', 7, { voice_source: 'native' }],
  ], '创作页只写本集覆盖（null 恢复随项目），项目页写项目默认')

  const episode = { video_settings: { overrides: { voice_source: 'dubbed' }, effective: { ...project, voice_source: 'dubbed' } } }
  assert.equal(scopeOf(episode, 'voice_source'), 'episode')
  assert.equal(scopeOf({ video_settings: { overrides: {}, effective: project } }, 'voice_source'), 'project')
})

test('后期配音在结构化分集下联动对白烧录', () => {
  const dubbed = { ...project, voice_source: 'dubbed', dialogue_burn: false }
  assert.equal(mergeOptionsFromSettings(dubbed, { structured: true }).burn_dialogue_audio, true)
  assert.equal(mergeOptionsFromSettings({ ...dubbed, voice_source: 'native' }, { structured: true }).burn_dialogue_audio, false)
  assert.equal(mergeOptionsFromSettings({ ...project, dialogue_burn: true }, { structured: true }).burn_dialogue_audio, true,
    '原生人声但用户自己开了对白烧录，保持开')
  assert.equal(mergeOptionsFromSettings(dubbed, { structured: false }).burn_dialogue_audio, false, '非结构化分集不受影响')
  assert.equal(mergeOptionsFromSettings({ ...dubbed, dialogue_burn: true }, { structured: false }).burn_dialogue_audio, true)
  assert.equal(dubbed.dialogue_burn, false, '不改写设置里的 dialogue_burn')
})

test('已有素材时提示比例与风格不一致', () => {
  const empty = { characters: [{ name: '甲' }], scenes: [{ location: '客厅' }], props: [], episodes: [{ storyboards: [{ id: 1, video_url: null }] }] }
  assert.equal(hasGeneratedAssets(empty), false)
  assert.equal(assetMismatchNotice(empty), '', '没有任何生成素材不提示')
  assert.equal(assetMismatchNotice(null), '')

  assert.equal(hasGeneratedAssets({ ...empty, characters: [{ name: '甲', local_path: 'p/c.png' }] }), true)
  assert.equal(hasGeneratedAssets({ ...empty, characters: [{ name: '甲', head_local_path: 'p/h.png' }] }), true)
  assert.equal(hasGeneratedAssets({ ...empty, scenes: [{ image_url: '/static/s.png' }] }), true)
  assert.equal(hasGeneratedAssets({ ...empty, props: [{ local_path: 'p/p.png' }] }), true)
  const withVideo = { ...empty, episodes: [{ storyboards: [{ id: 1, video_url: '/static/v.mp4' }] }] }
  assert.equal(hasGeneratedAssets(withVideo), true)
  assert.match(assetMismatchNotice(withVideo), /不会随新的画面比例或风格重新生成/)
})
