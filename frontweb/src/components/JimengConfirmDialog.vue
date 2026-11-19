<template>
  <el-dialog :model-value="modelValue" title="即梦渲染：报价确认" width="560px" append-to-body @update:model-value="(v) => emit('update:modelValue', v)" @open="onOpen">
    <div v-if="state.phase === 'estimating'" class="jm-hint">正在报价（免费，不扣积分）…</div>
    <template v-else-if="state.confirmation">
      <el-table :data="state.confirmation.items" size="small" max-height="260">
        <el-table-column prop="key" label="节点" width="110" />
        <el-table-column label="预计积分">
          <template #default="{ row }">{{ row.credits ?? '未知' }}<span v-if="row.price_status !== 'available'" class="jm-warn">（参考价）</span></template>
        </el-table-column>
      </el-table>
      <div class="jm-total">
        合计约 <b>{{ state.confirmation.total ?? '未知' }}</b> 积分，当前余额 {{ state.confirmation.balance ?? '未知' }}
        <el-tag v-if="state.confirmation.affordable === false" type="danger" size="small">余额不足</el-tag>
        <el-tag v-else-if="state.confirmation.price_status !== 'available'" type="warning" size="small">含参考价，实际以扣费为准</el-tag>
      </div>
      <div class="jm-hint">确认后才会提交并扣即梦积分；结果不明时只查询、不会重复提交。</div>
    </template>
    <el-alert v-if="state.phase === 'stale'" type="warning" :closable="false" show-icon :title="state.error || '报价之后有改动，原报价已失效'" />
    <el-alert v-else-if="state.error" type="error" :closable="false" show-icon :title="state.error" />
    <div v-if="progress.total" class="jm-hint">已提交 {{ progress.done }} / {{ progress.total }}</div>
    <template #footer>
      <el-button @click="emit('update:modelValue', false)">取消</el-button>
      <el-button v-if="['stale', 'error', 'done'].includes(state.phase)" @click="runEstimate">重新报价</el-button>
      <el-button
        type="primary"
        :disabled="state.phase !== 'estimated' || state.confirmation?.affordable === false"
        :loading="state.phase === 'submitting'"
        @click="onConfirm"
      >确认并提交</el-button>
    </template>
  </el-dialog>
</template>

<script setup>
import { ref, watch } from 'vue'
import { ElMessage } from 'element-plus'
import { storyboardsAPI } from '@/api/storyboards'
import { videosAPI } from '@/api/videos'
import { confirmReducer } from '@/utils/segmentUi'

const props = defineProps({
  modelValue: { type: Boolean, default: false },
  dramaId: { type: [Number, String], required: true },
  episodeId: { type: [Number, String], required: true },
  storyboardIds: { type: Array, default: () => [] },
})
const emit = defineEmits(['update:modelValue', 'submitted'])

const state = ref({ phase: 'idle', confirmation: null, error: '' })
const progress = ref({ done: 0, total: 0 })
const dispatch = (e) => { state.value = confirmReducer(state.value, e) }
const errMsg = (e) => e?.response?.data?.error?.message || e?.message || '操作失败'

// 打开期间所选分镜变了，原报价作废
watch(() => props.storyboardIds.join(','), () => dispatch({ type: 'configChanged' }))

function onOpen() {
  state.value = { phase: 'idle', confirmation: null, error: '' }
  progress.value = { done: 0, total: 0 }
  runEstimate()
}

async function runEstimate() {
  dispatch({ type: 'estimate' })
  progress.value = { done: 0, total: 0 }
  try {
    const r = await storyboardsAPI.jimengEstimate(props.episodeId, props.storyboardIds)
    dispatch({ type: 'estimated', confirmation: r.confirmation })
  } catch (e) {
    dispatch({ type: 'failed', message: errMsg(e) })
  }
}

async function onConfirm() {
  dispatch({ type: 'confirm' })
  if (state.value.phase !== 'confirmed') return
  dispatch({ type: 'submit' })
  const { token, items } = state.value.confirmation
  progress.value = { done: 0, total: items.length }
  const created = []
  for (const it of items) {
    try {
      created.push(await videosAPI.create({ drama_id: props.dramaId, storyboard_id: it.storyboard_id, jimeng_confirmation: token }))
      progress.value = { ...progress.value, done: progress.value.done + 1 }
    } catch (e) {
      dispatch({ type: 'rejected', code: e?.response?.data?.error?.code, message: `${it.key}：${errMsg(e)}` })
      if (created.length) emit('submitted', created)
      return
    }
  }
  dispatch({ type: 'submitted' })
  ElMessage.success(`已提交 ${created.length} 段即梦渲染`)
  emit('submitted', created)
  emit('update:modelValue', false)
}
</script>

<style scoped>
.jm-hint { font-size: 12px; color: var(--el-text-color-secondary); margin: 6px 0; }
.jm-total { margin: 10px 0 4px; display: flex; gap: 8px; align-items: center; }
.jm-warn { color: var(--el-color-warning); }
</style>
