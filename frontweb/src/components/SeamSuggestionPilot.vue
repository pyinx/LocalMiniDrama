<template>
  <div v-if="route.query.seamPilot === '1'">
    <label><input type="checkbox" v-model="enabled" @change="remember"> 显示剪点建议</label>
    <p v-if="readError" role="status">{{ readError }}</p>
    <p v-for="mark in marks" :key="mark.id">
      第 {{ left.number }} 镜 · 源片 {{ (mark.time_ms / 1000).toFixed(3) }} 秒 · {{ mark.reason }}
      <el-button link :disabled="busy" @click="$emit('audition', mark.time_ms / 1000)">试听建议剪点</el-button>
    </p>
  </div>
</template>

<script setup>
import { ref, watch } from 'vue'
import { useRoute } from 'vue-router'
import { storyboardsAPI } from '@/api/storyboards'
import { reviewedSeamMarks } from '../utils/episodeSeam.js'

const props = defineProps({ left: Object, fps: String, busy: Boolean })
defineEmits(['audition'])
const route = useRoute()
const storageKey = 'episode-seam-pilot.show-suggestions'
const enabled = ref(window.localStorage.getItem(storageKey) === '1')
const marks = ref([]), readError = ref('')
function remember() {
  window.localStorage.setItem(storageKey, enabled.value ? '1' : '0')
}
watch(() => [route.query.seamPilot, enabled.value, props.left, props.fps], async ([pilot, show, left, fps], _, onCleanup) => {
  let current = true
  onCleanup(() => { current = false })
  marks.value = []
  readError.value = ''
  if (pilot !== '1' || !show || !left.take) return
  try {
    const details = await storyboardsAPI.takes(left.id)
    if (current) marks.value = reviewedSeamMarks(details, left, fps)
  } catch {
    if (current) readError.value = '未能读取候选的审片标记。'
  }
}, { immediate: true })
</script>
