import { test } from 'node:test'
import assert from 'node:assert/strict'
import { storyboardVideoUrl } from '../src/utils/mediaUrl.js'

test('canvas uses the adopted media and leaves an invalid selection visible as missing', () => {
  const board = { video_url: 'https://old.invalid/b.mp4', local_path: 'first.jpg', resolved_video: { id: 2, local_path: 'a.mp4' } }
  assert.equal(storyboardVideoUrl(board), '/static/a.mp4')
  assert.equal(storyboardVideoUrl({ ...board, resolved_video: null }), '')
  assert.equal(storyboardVideoUrl({ video_url: board.video_url }), board.video_url)
})
