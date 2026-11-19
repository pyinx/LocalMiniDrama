<template>
  <el-dialog :model-value="true" :title="`第 ${episodeNumber} 集 · 第 ${board.storyboard_number} 镜审片`" width="min(680px, 94vw)" @close="$emit('close')">
    <div v-loading="busy">
      <el-button v-if="state.can_register_legacy" :disabled="busy" @click="registerLegacy">审阅当前旧片</el-button>
      <el-alert v-else-if="state.resolved_video && state.resolved_video.id == null" title="多个候选使用同一旧片路径，请预览并手动选择版本。" type="info" :closable="false" />
      <el-select v-model="selected" placeholder="选择候选视频" aria-label="候选版本">
        <el-option v-for="v in state.candidates" :key="v.id" :value="v.id"
          :label="`候选 #${v.id}${v.id === state.adopted_video_generation_id ? ' · 已采用' : ''}${v.reviews.length ? ' · ' + v.reviews.length + ' 条审片' : ''}`" />
      </el-select>
      <template v-if="candidate">
        <video ref="player" :key="candidate.id" :src="videoRecordUrl(candidate)" controls preload="metadata" class="take-player" />
        <el-button size="small" :disabled="busy || candidate.id === state.adopted_video_generation_id" @click="adopt">采用此版</el-button>
        <el-checkbox :model-value="candidate.keep_in_archive" :disabled="busy" @change="keep">工程包保留</el-checkbox>
        <el-form label-position="top" @submit.prevent>
          <el-form-item label="问题时间（秒）">
            <el-input-number v-model="seconds" :min="0" :step="0.1" :precision="3" />
            <el-button link @click="seconds = player?.currentTime || 0">取播放器时间</el-button>
          </el-form-item>
          <el-form-item label="审片意见"><el-input v-model="note" type="textarea" :rows="2" maxlength="4000" /></el-form-item>
          <el-form-item label="处理方式">
            <el-radio-group v-model="action">
              <el-radio-button v-for="(label,key) in labels" :key="key" :value="key">{{ label }}</el-radio-button>
            </el-radio-group>
            <el-button type="primary" :disabled="busy || !note.trim()" @click="save">记录意见</el-button>
          </el-form-item>
        </el-form>
        <div v-for="r in candidate.reviews" :key="r.id" class="take-note">
          <el-button link type="primary" @click="player.currentTime = r.time_ms / 1000">{{ (r.time_ms / 1000).toFixed(3) }} 秒</el-button>
          <span>{{ r.note }}</span>
          <el-tag size="small">{{ r.status === 'open' ? '待处理' : '已处理' }}</el-tag>
          <el-button v-if="r.status === 'open'" size="small" @click="follow(r)">{{ labels[r.action] }}</el-button>
          <el-button link :disabled="busy" @click="status(r)">{{ r.status === 'open' ? '标为已处理' : '重新打开' }}</el-button>
        </div>
      </template>
      <el-empty v-else-if="!busy && !state.can_register_legacy" description="本镜还没有可审阅的候选" />
    </div>
  </el-dialog>
</template>
<script setup>
import { computed, onMounted, ref, watch } from 'vue'
import { ElMessage } from 'element-plus'
import { storyboardsAPI } from '@/api/storyboards'
import { videoRecordUrl } from '@/utils/storyboardMedia'
const props = defineProps({ board: Object, episodeNumber: Number })
const emit = defineEmits(['close', 'selection', 'revise', 'reshoot'])
const labels = { revise: '改稿', replace: '换候选', reshoot: '重拍本镜' }
const state = ref({ candidates: [] }), selected = ref(null), player = ref(null)
const busy = ref(false), seconds = ref(0), note = ref(''), action = ref('revise')
const candidate = computed(() => state.value.candidates.find(v => v.id === selected.value))
watch(selected, () => { seconds.value = 0; note.value = '' })
async function refresh() {
  state.value = await storyboardsAPI.takes(props.board.id)
  emit('selection', state.value)
  if (!candidate.value) selected.value = state.value.resolved_video?.id || state.value.candidates[0]?.id
}
async function edit(fn) {
  if (busy.value) return
  busy.value = true
  try { await fn(); await refresh() }
  catch (e) { if (e.response?.status === 409) await refresh() }
  finally { busy.value = false }
}
onMounted(() => edit(async () => {}))
function adopt() {
  return edit(() => storyboardsAPI.adopt(props.board.id, selected.value, state.value.take_revision))
}
function registerLegacy() {
  return edit(async () => {
    const result = await storyboardsAPI.registerLegacyTake(props.board.id, state.value.resolved_video)
    selected.value = result.resolved_video.id
  })
}
function keep(value) {
  return edit(() => storyboardsAPI.retain(props.board.id, selected.value, value))
}
function save() {
  const time_ms = Math.round((seconds.value || 0) * 1000)
  if (Number.isFinite(player.value?.duration) && time_ms > player.value.duration * 1000) {
    ElMessage.warning('时间码超过所选视频的时长'); return
  }
  return edit(async () => {
    await storyboardsAPI.addTakeReview(props.board.id, selected.value, { time_ms, note: note.value, action: action.value })
    note.value = ''
  })
}
function status(r) {
  return edit(() => storyboardsAPI.takeReviewStatus(props.board.id, selected.value, r.id, r.status === 'open' ? 'resolved' : 'open'))
}
function follow(r) {
  if (r.action === 'replace') { ElMessage.info('在候选列表预览其他版本，点击「采用此版」'); return }
  emit(r.action, props.board); emit('close')
}
</script>
<style scoped>
.take-player { display:block; width:100%; max-height:38vh; background:#151515; margin:12px 0 }
.el-form { margin-top:16px }
.el-checkbox, .el-radio-group { margin:0 12px }
.take-note { display:flex; flex-wrap:wrap; gap:8px; align-items:center; padding:8px 0; border-top:1px solid var(--el-border-color) }
.take-note span { overflow-wrap:anywhere }
</style>
