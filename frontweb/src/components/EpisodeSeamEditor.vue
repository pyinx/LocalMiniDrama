<template>
  <el-button size="large" @click="open">审接缝</el-button>
  <el-dialog v-model="visible" title="审接缝" width="min(700px, 94vw)" @close="invalidate" destroy-on-close>
    <p v-if="error" role="alert">{{ error }} <el-button link @click="open">刷新</el-button></p>
    <p v-if="!state && !error">正在读取采用片…</p>
    <template v-if="state">
      <p v-if="state.shots.length < 2">{{ state.shots.length ? '本集只有一镜，可直接预览或交付。' : '请先添加分镜。' }}</p>
      <p v-for="s in missing" :key="s.id">第 {{ s.number }} 镜缺少可播放素材</p>
      <p v-for="c in pending" :key="c.left.id + '/' + c.right.id">
        {{ label(c.left) }} → {{ label(c.right) }} 待复核
        <el-button link :disabled="busy" @click="save('restore', c)">撤回过期剪法</el-button>
      </p>
      <label v-if="pairs.length">接缝
        <select v-model.number="index" @change="selectPair" :disabled="saving">
          <option v-for="p in pairs" :key="p.index" :value="p.index">第 {{ p.left.number }} 镜 → 第 {{ p.right.number }} 镜</option>
        </select>
      </label>
      <template v-if="pair">
        <div class="actions">
          <el-button :type="playing?.action === 'original' ? 'primary' : 'default'" :disabled="busy" @click="listen('original')">听原版</el-button>
          <el-button :type="playing?.action === 'trim' ? 'primary' : 'default'" :disabled="busy" @click="listen('trim')">听试剪</el-button>
          <span v-if="busy" role="status">{{ saving ? '正在保存…' : '正在生成试听…' }}</span>
        </div>
        <video v-if="playing" ref="video" :src="playing.url" controls loop playsinline @loadedmetadata="startPlayer" @playing="heard" @error="playbackError" />
        <p v-for="warning in playing?.warnings || []" :key="warning" role="status">{{ warning }}</p>
        <div v-if="playing" class="actions">
          <el-button size="small" @click="mark('out')">在此结束前镜</el-button>
          <el-button size="small" @click="mark('in')">从此开始后镜</el-button>
        </div>
        <details><summary>逐帧微调</summary>
          <div class="points" v-for="point in ['out','in']" :key="point">
            <label :for="'cut-' + point">{{ point === 'out' ? '前镜结束' : '后镜开始' }}（秒）</label>
            <input :id="'cut-' + point" type="number" min="0" step="any" :max="limit(point)" :value="value(point)" @change="setPoint(point, $event.target.value)" />
            <el-button size="small" :aria-label="point + ' 前一帧'" @click="step(point,-1)">−1 帧</el-button>
            <el-button size="small" :aria-label="point + ' 后一帧'" @click="step(point,1)">+1 帧</el-button>
          </div>
        </details>
        <div class="actions">
          <el-button type="primary" :disabled="busy || !auditioned" @click="save('trim')">采用试剪</el-button>
          <el-button :disabled="busy || !adopted" @click="save('restore')">恢复此处完整源段</el-button>
        </div>
      </template>
    </template>
  </el-dialog>
</template>

<script setup>
import { computed, onBeforeUnmount, ref } from 'vue'
import { ElMessage } from 'element-plus'
import request from '@/utils/request'
import { comparisonTime, playheadSourceUs, steppedUs } from '../utils/episodeSeam.js'

const props = defineProps({ episodeId: Number, options: Object })
const visible = ref(false), state = ref(null), index = ref(-1), error = ref('')
const video = ref(null), playing = ref(null), busy = ref(false), saving = ref(false)
const outUs = ref(0), inUs = ref(0), auditioned = ref(false)
let generation = 0, anchor = null
const cache = new Map()
const pairs = computed(() => (state.value?.shots || []).flatMap((left,i,list) =>
  left.digest && list[i+1]?.digest ? [{left,right:list[i+1],index:i}] : []))
const pair = computed(() => pairs.value.find(p => p.index === index.value))
const missing = computed(() => state.value.shots.filter(s => !s.digest))
const pending = computed(() => state.value.cuts.filter(c => c.pending))
const adopted = computed(() => state.value?.cuts.find(c => c.left.id === pair.value?.left.id && c.right.id === pair.value?.right.id))
const endpoint = () => '/episodes/' + props.episodeId + '/edit'
function label(ref) { return '镜 ' + (state.value.shots.find(s => s.id === ref.id)?.number ?? '#' + ref.id) }
function invalidate() { generation++; busy.value = false; cache.clear(); playing.value = null; auditioned.value = false }
onBeforeUnmount(invalidate)
defineExpose({ open })
async function open(shotId) {
  visible.value = true
  invalidate()
  const stamp = generation
  error.value = ''
  state.value = null
  try {
    const next = await request.get(endpoint(), { params:props.options })
    if (stamp !== generation) return
    state.value = next
    const requested = pairs.value.find(p => p.left.id === shotId)
    if (requested) index.value = requested.index
    else if (!pair.value) index.value = pairs.value[0]?.index ?? -1
    selectPair()
  } catch (e) { if (stamp === generation) error.value = e.message }
}
function selectPair() {
  invalidate()
  error.value = ''
  outUs.value = pair.value?.left.out_us ?? 0
  inUs.value = pair.value?.right.in_us ?? 0
  if (pair.value) listen('original')
}
function value(p) { return (p === 'out' ? outUs.value : inUs.value) / 1e6 }
function limit(p) { return (p === 'out' ? pair.value.left : pair.value.right).duration_us / 1e6 }
function setPoint(p, seconds) {
  const n = Number(seconds)
  if (!Number.isFinite(n)) return
  if (p === 'out') outUs.value = Math.round(Math.min(limit(p),Math.max(0,n))*1e6)
  else inUs.value = Math.round(Math.min(limit(p),Math.max(0,n))*1e6)
  auditioned.value = false
  cache.delete('trim')
  if (busy.value && !saving.value) { generation++; busy.value = false }
}
function step(p, by) { setPoint(p,steppedUs(value(p)*1e6,by,state.value.fps)/1e6) }
function mark(p) {
  if (!video.value || !playing.value) return
  const us = playheadSourceUs(p,playing.value,video.value.currentTime)
  if (us == null) { error.value = p === 'out' ? '请在前镜画面暂停。' : '请在后镜画面暂停。'; return }
  error.value = ''
  setPoint(p,us/1e6)
}
function payload(action, item = pair.value) {
  return { ...props.options, revision:state.value.revision, action, left:item.left, right:item.right, out_us:outUs.value, in_us:inUs.value }
}
async function listen(action) {
  const stamp = ++generation
  const previous = playing.value
  const time = video.value?.currentTime
  anchor = null
  if (previous && Number.isFinite(time)) {
    const point = time < previous.seam ? 'out' : 'in'
    anchor = { point, us:playheadSourceUs(point,previous,time) }
  }
  busy.value = true
  error.value = ''
  try {
    let clip = cache.get(action)
    if (!clip) {
      const body = payload(action)
      const job = await request.post(endpoint()+'/audition',body)
      let result
      for (let attempt=0; attempt<900 && stamp === generation; attempt++) {
        const task = await request.get('/tasks/'+job.task_id)
        if (task.status === 'failed') throw new Error(task.error || '试听失败')
        if (task.status === 'completed') { result = typeof task.result === 'string' ? JSON.parse(task.result) : task.result; break }
        await new Promise(resolve => setTimeout(resolve,500))
      }
      if (stamp !== generation) return
      if (!result) throw new Error('试听超时，请重试')
      const out = action === 'original' ? pair.value.left.out_us : body.out_us
      const start = action === 'original' ? pair.value.right.in_us : body.in_us
      clip = { action, url:'/static/'+result.video_url, seam:result.seam_seconds, out_us:out, in_us:start, warnings:result.warnings }
      cache.set(action,clip)
    }
    if (playing.value === clip) await video.value?.play()
    else playing.value = clip
  } catch (e) { if (stamp === generation) error.value = e.message }
  finally { if (stamp === generation) busy.value = false }
}
function startPlayer() {
  const player = video.value
  if (!player || !playing.value) return
  player.currentTime = comparisonTime(anchor,playing.value,player.duration,state.value.fps)
  player.play().catch(() => {})
}
function heard() {
  const clip = playing.value
  if (clip?.action === 'trim' && clip.out_us === outUs.value && clip.in_us === inUs.value) auditioned.value = true
}
function playbackError() { error.value = '试听文件无法播放，请刷新后重试。'; auditioned.value = false }
async function save(action, item = pair.value) {
  if (saving.value) return
  saving.value = true
  busy.value = true
  try {
    await request.put(endpoint(),payload(action,item))
    ElMessage.success(action === 'restore' ? '已恢复此处完整源段' : '已采用此处试剪')
    if (visible.value) await open()
  } catch (e) { error.value = e.message; busy.value = false }
  finally { saving.value = false }
}
</script>

<style scoped>
video { display: block; width: 100%; max-height: 38vh; margin: 12px 0; background: #121212; }
.actions, .points { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; margin: 12px 0; }
select, input { font: inherit; color: inherit; padding: 4px; }
input { width: 7em; } summary { cursor: pointer; }
</style>
