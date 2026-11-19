<template>
  <div class="measurement">
    <el-button size="small" :loading="busy" @click="measure">{{ boardId ? '检测有效画幅' : '测量响度' }}</el-button>
    <div v-if="report" role="status" class="reading">
      <span v-if="report.message">{{ report.message }}</span>
      <span v-if="report.status === 'measured'">综合响度 <b>{{ report.integrated_lufs.toFixed(2) }} LUFS</b></span>
      <span v-if="report.peak_dbtp != null">真峰值 <b>{{ report.peak_dbtp.toFixed(2) }} dBTP</b></span>
      <span v-if="report.width">画面 {{ report.width }} × {{ report.height }}<template v-if="report.rotation">（旋转 {{ report.rotation }}°）</template></span>
      <span v-if="report.rect">有效区域 {{ rectLabel(report.rect) }}</span>
      <small v-if="report.checked_at">检测于 {{ new Date(report.checked_at).toLocaleString() }}</small>
    </div>
    <div v-if="report?.samples" class="samples" aria-label="回看采样位置">
      <el-button v-for="(sample, i) in report.samples" :key="i" link type="primary" @click="$emit('seek', sample.seconds)">
        {{ sample.seconds.toFixed(2) }} 秒 · {{ sample.rect ? rectLabel(sample.rect) : sample.state === 'variable' ? '画幅变化' : '暗场或采样不足' }}
      </el-button>
    </div>
  </div>
</template>

<script setup>
import { ref } from 'vue'
import request from '@/utils/request'

const props = defineProps({ id: { type: Number, required: true }, boardId: Number })
defineEmits(['seek'])
const busy = ref(false)
const report = ref(null)
const rectLabel = r => r.w + ' × ' + r.h + '（左 ' + r.x + '，上 ' + r.y + '）'

async function measure() {
  if (busy.value) return
  busy.value = true
  report.value = null
  try {
    const url = props.boardId ? '/storyboards/' + props.boardId + '/takes/' + props.id + '/framing'
      : '/video-merges/' + props.id + '/loudness'
    report.value = await request.get(url)
  } catch (err) {
    report.value = { message: err.message || '检测失败，请重试' }
  } finally { busy.value = false }
}
</script>

<style scoped>
.measurement { margin: 8px 0; }
.reading, .samples { display: flex; flex-wrap: wrap; align-items: baseline; gap: 5px 14px; margin-top: 6px; }
.reading small { color: var(--el-text-color-secondary); }
.samples .el-button { margin: 0; }
</style>
