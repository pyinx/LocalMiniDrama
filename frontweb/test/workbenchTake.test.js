import { test } from 'node:test'
import assert from 'node:assert/strict'
import { previousTakeUrl, storyboardVideoUrl } from '../src/utils/mediaUrl.js'
import { getSbVideosList, hasStoryboardVideo, mediaCheckIssueMessages, resolveSbVideoRecord } from '../src/utils/storyboardMedia.js'

test('canvas uses the adopted media and leaves an invalid selection visible as missing', () => {
  const board = { video_url: 'https://old.invalid/b.mp4', local_path: 'first.jpg', resolved_video: { id: 2, local_path: 'a.mp4' } }
  assert.equal(storyboardVideoUrl(board), '/static/a.mp4')
  assert.equal(storyboardVideoUrl({ ...board, resolved_video: null }), '')
  assert.equal(storyboardVideoUrl({ video_url: board.video_url }), board.video_url)
})

test('batch continuity reads the nearest preceding take from episode order for each pending shot', async () => {
  const boards = [10, 20, 30, 40, 50].map(id => ({ id }))
  // Only 20 and 50 are pending; 10 and 40 already have adopted clips.
  const adopted = new Map([[10, 'a.mp4'], [20, 'middle.mp4'], [40, 'last-a.mp4']])
  const reads = []
  const read = async id => {
    reads.push(id)
    return { video_url: 'https://old.invalid/newer-b.mp4', resolved_video: adopted.has(id) ? { local_path: adopted.get(id) } : null }
  }
  assert.equal(await previousTakeUrl(boards, 10, read), '')
  assert.equal(await previousTakeUrl(boards, 20, read), '/static/a.mp4')
  assert.equal(await previousTakeUrl(boards, 50, read), '/static/last-a.mp4')
  assert.equal(await previousTakeUrl(boards, 40, read), '')
  assert.deepEqual(reads, [10, 40, 30])
})

test('failed quality candidates stay in history but do not count as automatic storyboard video', () => {
  const failed = { id: 8, status: 'completed', local_path: 'bad.mp4', media_check: {
    status: 'failed', issues: [{ code: 'duration_short', message: '实际时长 5 秒' }],
  } }
  const videos = { 4: [failed] }
  assert.deepEqual(getSbVideosList(videos, 4), [failed])
  assert.equal(hasStoryboardVideo({ id: 4, resolved_video: null }, videos), false)
  assert.equal(resolveSbVideoRecord({ id: 4, video_url: null }, videos), null)
  assert.equal(resolveSbVideoRecord({ id: 4, video_url: '/static/bad.mp4' }, videos), null)
  assert.deepEqual(mediaCheckIssueMessages(failed), ['实际时长 5 秒'])
})
