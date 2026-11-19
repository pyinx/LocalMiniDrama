import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { generationStyleOptions } from '../src/constants/styleOptions.js'
import { createRequire } from 'node:module'

const mediaRequire = createRequire(new URL('../../backend-node/package.json', import.meta.url))

test('every built-in style has a distinct decodable example image', async () => {
  const images = new Set()
  const sharp = mediaRequire('sharp')
  for (const option of generationStyleOptions.flatMap(group => group.options)) {
    assert.match(option.thumb, /^\/style-thumbs\//)
    const bytes = await readFile(new URL('../public' + option.thumb, import.meta.url))
    const { data, info } = await sharp(bytes).resize(96, 96).removeAlpha().raw().toBuffer({ resolveWithObject: true })
    assert.equal(info.width, 96)
    const signature = createHash('sha256').update(data).digest('hex')
    assert.ok(!images.has(signature), option.label + ' 与其他卡片共用样图')
    images.add(signature)
  }
})
import {
  CUSTOM_STYLE_VALUE,
  stylePromptMetadataForSave,
  findStyleOption,
  getStyleLabel,
  getStylePromptEn,
  getStylePromptZh,
} from '../src/constants/styleOptions.js'

test('preset returns zh/en prompts', () => {
  const m = stylePromptMetadataForSave('realistic')
  assert.ok(m.style_prompt_zh.includes('写实'))
  assert.ok(m.style_prompt_en.includes('photorealistic'))
})

test('empty style clears prompts', () => {
  assert.deepEqual(stylePromptMetadataForSave(''), {
    style_prompt_zh: '',
    style_prompt_en: '',
  })
})

test('custom with prompt writes same zh/en', () => {
  const desc = '赛博朋克水墨，霓虹映在宣纸上'
  assert.deepEqual(stylePromptMetadataForSave(CUSTOM_STYLE_VALUE, desc), {
    style_prompt_zh: desc,
    style_prompt_en: desc,
  })
})

test('custom without prompt does not write literal custom', () => {
  assert.deepEqual(stylePromptMetadataForSave(CUSTOM_STYLE_VALUE), {
    style_prompt_zh: '',
    style_prompt_en: '',
  })
  assert.deepEqual(stylePromptMetadataForSave(CUSTOM_STYLE_VALUE, '  '), {
    style_prompt_zh: '',
    style_prompt_en: '',
  })
})

test('unknown legacy string still mirrors zh/en', () => {
  assert.deepEqual(stylePromptMetadataForSave('古风仙侠'), {
    style_prompt_zh: '古风仙侠',
    style_prompt_en: '古风仙侠',
  })
})

test('getStyleLabel covers custom and presets', () => {
  assert.equal(getStyleLabel('realistic'), '写实')
  assert.equal(getStyleLabel(CUSTOM_STYLE_VALUE), '自定义')
  assert.equal(getStyleLabel('2d gufeng'), '2D 古风')
  assert.equal(getStyleLabel('unknown-x'), 'unknown-x')
})

test('findStyleOption does not treat custom as preset', () => {
  assert.equal(findStyleOption(CUSTOM_STYLE_VALUE), null)
})

test('getStylePrompt helpers do not return literal custom', () => {
  assert.equal(getStylePromptEn(CUSTOM_STYLE_VALUE), undefined)
  assert.equal(getStylePromptZh(CUSTOM_STYLE_VALUE), undefined)
})

test('every source style maps to a reviewed catalog entry or tag', () => {
  const entries = generationStyleOptions.flatMap(g => g.options)
  const mapped = entries.flatMap(e => e.sources || [])
  assert.equal(mapped.length, new Set(mapped).size)
  assert.equal(mapped.filter(s => s.startsWith('Toonflow/')).length, 11)
  assert.equal(mapped.filter(s => s.startsWith('video-canvas/')).length, 45)
  const clay = entries.find(x => x.sources?.includes('video-canvas/claymation'))
  assert.ok(clay.sources.includes('Toonflow/3D_clay_stopmotion'))
  assert.equal(entries.filter(x => x.value === 'ink wash').length, 1)
})

test('aliases and tags find unique options', async () => {
  const { searchStyleGroups } = await import('../src/constants/styleOptions.js')
  const results = term => searchStyleGroups(generationStyleOptions, term).flatMap(x => x.options.map(y => y.value))
  assert.deepEqual(results(' 浮世绘 '), ['woodblock print'])
  assert.deepEqual(results('CLAYMATION'), ['clay stop motion'])
  assert.deepEqual(results('复古港片'), ['hong kong film'])
  assert.deepEqual(results('no such style'), [])
  assert.equal(results('').length, new Set(results('')).size)
})


test('routine saves preserve both positive language slots in old custom styles', () => {
  for (const metadata of [{style_prompt_zh:'水彩',style_prompt_en:'watercolour'}, {style_prompt_zh:'',style_prompt_en:'watercolour'}]) {
    assert.deepEqual(stylePromptMetadataForSave('custom', metadata.style_prompt_zh || metadata.style_prompt_en, null, {style:'custom', metadata}), metadata)
  }
});
