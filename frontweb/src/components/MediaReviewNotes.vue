<template>
  <section v-if="current || history.length" class="media-review">
    <template v-if="current">
      <strong>当前片待处理意见 · 候选 #{{ current.id }}</strong>
      <p v-for="r in current.notes" :key="r.id">
        <el-button link type="primary" :disabled="!current.media" @click="locate(current, r)">{{ time(r) }} 秒</el-button>
        {{ r.note }}
      </p>
    </template>
    <details v-if="history.length">
      <summary>历史候选待处理意见（{{ history.reduce((n, take) => n + take.notes.length, 0) }} 条）</summary>
      <div v-for="take in history" :key="take.id">
        <strong>候选 #{{ take.id }}</strong>
        <p v-for="r in take.notes" :key="r.id">
          <el-button link type="primary" :disabled="!take.media" @click="locate(take, r)">{{ time(r) }} 秒</el-button>
          {{ r.note }}
        </p>
      </div>
    </details>
    <figure v-if="preview">
      <figcaption>候选 #{{ preview.take.id }} · {{ time(preview.note) }} 秒</figcaption>
      <video ref="player" :key="preview.take.id" :src="videoRecordUrl(preview.take.media)" controls preload="metadata"
        @loadedmetadata="seek" @error="error = '这个版本的媒体无法播放，请检查文件或远程地址。'" />
      <p v-if="error" role="alert">{{ error }}</p>
    </figure>
  </section>
</template>
<script setup>
import { nextTick, ref } from 'vue'
import { videoRecordUrl } from '@/utils/storyboardMedia'

defineProps({ current: Object, history: { type: Array, required: true } })
const preview = ref(null)
const player = ref(null)
const error = ref('')
const time = note => (note.time_ms / 1000).toFixed(3)

async function locate(take, note) {
  preview.value = { take, note }
  error.value = ''
  await nextTick()
  if (player.value?.readyState >= 1) seek()
  else if (player.value?.error) player.value.load()
}
function seek() {
  if (!player.value || !preview.value) return
  const target = preview.value.note.time_ms / 1000
  if (Number.isFinite(player.value.duration) && target > player.value.duration) {
    error.value = '意见时间超过该版本的实际片长。'
  } else {
    player.value.currentTime = target
  }
}
</script>
<style scoped>
.media-review { margin: .8rem 0; }
details { margin-top: .55rem; }
summary { cursor: pointer; }
p { margin: .25rem 0 .55rem; white-space: pre-line; overflow-wrap: anywhere; }
figure { margin: .65rem 0; }
video { display: block; width: 100%; max-height: 36vh; background: #151515; }
</style>
