import test from 'node:test'
import assert from 'node:assert/strict'
import { reviewedSeamMarks } from '../src/utils/episodeSeam.js'

test('only an open explicit cut mark for the adopted file can propose an audition', () => {
  const left = { take: 2, digest: 'hash', in_us: 400000, out_us: 2000000, duration: 1 }
  const mark = { id: 4, status: 'open', time_ms: 1250, note: '剪点建议[hash]：核听末尾重复响声' }
  const details = { resolved_video: { id: 2 }, candidates: [{ id: 2, reviews: [] }] }
  const read = () => reviewedSeamMarks(details, left, '25/1')
  assert.deepEqual(read(), [])
  details.candidates[0].reviews = [mark, { ...mark, status: 'resolved' }, { ...mark, note: '保留刻意停顿' },
    { ...mark, note: '剪点建议[旧文件]：前一版意见' }, { ...mark, time_ms: 420 }, { ...mark, time_ms: 1999 }]
  assert.deepEqual(read(), [{ id: 4, time_ms: 1250, reason: '核听末尾重复响声' }])
  details.resolved_video.id = 3
  assert.deepEqual(read(), [])
})
