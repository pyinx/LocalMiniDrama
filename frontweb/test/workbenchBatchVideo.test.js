import test from 'node:test'
import assert from 'node:assert/strict'
import { dispatchBatchVideo } from '../src/utils/batchVideo.js'

test('resuming a canvas batch reuses its task without requesting new inputs', () => {
  const unused = () => { throw new Error('unexpected dispatch') }
  const item = { operation_key: 'batch-shot', video_id: 31, task_id: 'video-task' }
  for (const status of ['processing', 'completed']) {
    const result = dispatchBatchVideo({ ...item, status }, unused, unused)
    assert.equal(result.id, 31)
    assert.equal(result.task_id, 'video-task')
  }
  assert.throws(() => dispatchBatchVideo({ ...item, dispatch_state: 'unknown' }, unused, unused), /核查/)
  assert.throws(() => dispatchBatchVideo(null, unused, unused), /批次/)
  assert.equal(dispatchBatchVideo({ ...item, video_id: null, status: 'completed' }, unused, unused).status, 'completed')
  assert.deepEqual(dispatchBatchVideo({ operation_key: 'batch-shot', status: 'waiting' },
    () => ({ prompt: '灯渐暗' }), body => body), { operation_key: 'batch-shot', prompt: '灯渐暗' })
})

test('a completed batch slot with a failed media check is surfaced as a failure', () => {
  const item = { operation_key: 'batch-shot', video_id: 31, status: 'completed', media_check: {
    status: 'failed', issues: [{ code: 'duration_short', message: '时长不足：实际 5s' }],
  } }
  assert.throws(() => dispatchBatchVideo(item, () => ({}), () => ({})), /时长不足：实际 5s/)
})
