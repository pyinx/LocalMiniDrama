import test from 'node:test'
import assert from 'node:assert/strict'

import { characterReference, omniReferenceUrls } from '../src/utils/storyboardMedia.js'

const abs = (u) => 'http://host' + u

test('uses the episode reference when present', () => {
  const scene = { local_path: 'p/scenes/room.png' }
  const lin = { id: 1, local_path: 'p/characters/lin_main.png', episode_reference: { wardrobe_id: 7, local_path: 'p/characters/lin_island.png' } }
  const hr = { id: 2, local_path: 'p/characters/hr.png', episode_reference: null }
  assert.deepEqual(omniReferenceUrls(scene, [lin, hr], [], abs), [
    'http://host/static/p/scenes/room.png',
    'http://host/static/p/characters/lin_island.png',
    'http://host/static/p/characters/hr.png',
  ])
  assert.equal(characterReference(hr), hr)
  assert.equal(characterReference(lin), lin.episode_reference)
})
