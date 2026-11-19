import test from 'node:test'
import assert from 'node:assert/strict'
import { comparisonTime, playheadSourceUs, steppedUs } from '../src/utils/episodeSeam.js'

test('auditions accepts and restores a seam', () => {
  const original = { seam: 2, out_us: 4e6, in_us: 0 }
  const trial = { seam: 1.5, out_us: 1.5e6, in_us: 400000 }
  assert.equal(playheadSourceUs('in', original, 2.2), 200000)
  assert.equal(playheadSourceUs('in', trial, 1.7), 600000)
  assert.equal(playheadSourceUs('out', trial, 1.25), 1250000)
  assert.equal(playheadSourceUs('in', trial, 1.25), null)
  assert.equal(playheadSourceUs('out', trial, 1.7), null)
  assert.equal(comparisonTime({point:'out',us:3000000},{seam:2,out_us:3500000,in_us:0},4,'25/1'),1.5)
  assert.equal(steppedUs(1001000, 1, '30000/1001'), 1034367)
  assert.equal(steppedUs(1034367,-1,'30000/1001'), 1001000)
})
