import test from 'node:test'
import assert from 'node:assert/strict'
import { pipelineClipRange, storyboardTiming } from '../src/utils/storyboardTiming.js'

test('project range roundtrip and legacy projects', () => {
  assert.deepEqual(pipelineClipRange({ video_clip_duration: 5 }), { min: 4, max: 15 })
  assert.deepEqual(pipelineClipRange({ pipeline_clip_range: { min: 12, max: 5 } }), { min: 4, max: 15 })
  const metadata = JSON.parse(JSON.stringify({ pipeline_clip_range: { min: 6, max: 12 } }))
  assert.deepEqual(pipelineClipRange(metadata), { min: 6, max: 12 })
  assert.deepEqual(pipelineClipRange({ pipeline_clip_range: { min: 8, max: 8 } }), { min: 8, max: 8 })
})

test('manual constraints are independent from pipeline settings', () => {
  assert.deepEqual(storyboardTiming(12, null), { storyboard_count: 12 })
  assert.deepEqual(storyboardTiming(null, null), {})
  assert.deepEqual(storyboardTiming(null, 90), { video_duration: 90 })
  assert.deepEqual(storyboardTiming(12, 90), { storyboard_count: 12, video_duration: 90 })
  const range = { min: 4, max: 15 }
  const options = storyboardTiming(12, null, range)
  range.max = 9
  assert.deepEqual(options, { storyboard_count: 12, clip_duration_range: { min: 4, max: 15 } })
})
