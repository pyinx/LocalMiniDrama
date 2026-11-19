import test from 'node:test'
import assert from 'node:assert/strict'
import { comparisonTime, playheadSourceUs, steppedUs } from '../src/utils/episodeSeam.js'

test('maps original and trial playheads to source time', () => {
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

import { after, before } from 'node:test'
import { fileURLToPath } from 'node:url'
import { createServer } from 'vite'
import { createSSRApp } from 'vue'
import { renderToString } from 'vue/server-renderer'

let server, component, request
before(async () => {
  server = await createServer({ root: fileURLToPath(new URL('..', import.meta.url)),
    server: { middlewareMode: true, hmr: false }, optimizeDeps: { noDiscovery: true, include: [] } })
  component = (await server.ssrLoadModule('/src/components/EpisodeSeamEditor.vue')).default
  request = (await server.ssrLoadModule('/src/utils/request.js')).default
})
after(() => server.close())

async function editor(t) {
  const shots = [1,2,3,4].map(id => ({id, number:id, digest:'media'+id, duration_us:2000000,
    in_us:0, out_us:2000000, audio_end_us:2000000, mixed_audio:true, speech_ranges_us:[]}))
  const state = {shots, cuts:[], revision:0, fps:'25/1'}
  const writes = []
  t.mock.method(request, 'get', async url => url.includes('/tasks/')
    ? {status:'completed',result:{video_url:'test.mp4',seam_seconds:1}} : structuredClone(state))
  t.mock.method(request, 'post', async () => ({task_id:'test'}))
  t.mock.method(request, 'put', async (url, body) => {
    body = JSON.parse(JSON.stringify(body))
    writes.push(body)
    state.cuts = body.action === 'restore' ? [] : [body]
    shots[0].out_us = state.cuts[0]?.out_us ?? shots[0].duration_us
  })
  let ui
  await renderToString(createSSRApp({setup() {
    ui = component.setup({episodeId:1,options:{}},{expose(){}})
    return () => ''
  }}))
  t.mock.method(ui.ElMessage, 'success', () => {})
  ui.video.value = {play:async () => {}, currentTime:0, volume:1, muted:false}
  return {ui, shots, writes}
}

test('auditions accepts and restores a seam', async t => {
  const {ui, writes} = await editor(t)
  await ui.open(1)
  await new Promise(resolve=>setImmediate(resolve))
  const play=t.mock.fn(async()=>{})
  ui.video.value={play,currentTime:1}
  await ui.listen('original')
  assert.equal(play.mock.callCount(),1)

  ui.setPoint('out',1.2)
  await ui.listen('trim')
  assert.equal(ui.auditioned.value,false)
  ui.heard()
  assert.equal(ui.auditioned.value,true)
  await ui.save('trim')
  await ui.open(1)
  assert.equal(ui.adopted.value.out_us,1200000)
  await ui.save('restore')
  assert.deepEqual(writes.map(w=>w.action),['trim','restore'])
  assert.equal(ui.adopted.value,undefined)
})

test('a missing neighbor cannot select or audition a different seam', async t => {
  const {ui,shots} = await editor(t)
  shots[1].digest = null
  await ui.open(1)
  assert.equal(ui.pair.value,undefined)
  assert.equal(request.post.mock.callCount(),0)
})

test('saving freezes cut points until the persisted plan is loaded', async t => {
  const {ui} = await editor(t)
  await ui.open(1)
  ui.setPoint('out',1.3)
  let release
  request.put.mock.mockImplementation(()=>new Promise(resolve=>{release=resolve}))
  const saving=ui.save('trim')
  ui.setPoint('out',0.8)
  assert.equal(ui.outUs.value,1300000)
  release()
  await saving
})

test('shows available tail and restores synchronous sound', async t => {
  const {ui,shots,writes} = await editor(t)
  shots[0].audio_start_us=500000
  shots[1].speech_ranges_us=[{start_us:450000,end_us:750000}]
  await ui.open(1)
  assert.equal(ui.tailLimit.value,0)
  ui.setPoint('out',0.4)
  assert.equal(ui.tailLimit.value,0)
  ui.setPoint('out',1.2)
  assert.equal(ui.tailLimit.value,450000)
  ui.setTail(0.6)
  assert.equal(ui.tailUs.value,450000)
  await ui.listen('trim')
  ui.heard()
  assert.equal(ui.auditioned.value,true)
  ui.setTail(0.200001)
  ui.heard()
  assert.equal(ui.auditioned.value,false)
  await ui.listen('trim')
  ui.heard()
  await ui.save('trim')
  assert.equal(writes[0].tail_us,200001)
  assert.equal(ui.tailUs.value,200001)
  ui.setPoint('in',0.5)
  assert.equal(ui.tailLimit.value,0)
  assert.equal(ui.tailUs.value,0)
  ui.setPoint('in',0)
  ui.setTail(0.24)
  ui.setTail(0)
  assert.equal(ui.payload('trim').tail_us,0)
  await ui.save('restore')
  assert.equal(ui.tailUs.value,0)
  assert.equal(ui.outUs.value,2000000)
})
