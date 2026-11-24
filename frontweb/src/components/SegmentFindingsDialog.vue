<template>
  <el-dialog
    :model-value="modelValue"
    title="编译预览结果"
    width="min(760px, 94vw)"
    destroy-on-close
    :show-close="!locked"
    :close-on-click-modal="!locked"
    :close-on-press-escape="!locked"
    @update:model-value="(v) => emit('update:modelValue', v)"
    @closed="reset"
  >
    <div v-loading="busy || applying">
      <template v-if="proposal">
        <div class="sf-hint">模型按提醒改写了下面 {{ rows.length }} 处。确认后才会保存，并重新编译预览。</div>
        <div v-for="r in rows" :key="r.path" class="sf-diff">
          <div class="sf-diff-label">{{ r.label }}</div>
          <div class="sf-before">{{ r.before }}</div>
          <div class="sf-after">{{ r.after }}</div>
          <div v-if="r.remaining.length" class="sf-remaining">改后仍有：{{ r.remaining.join('、') }}</div>
        </div>
      </template>
      <template v-else>
        <div v-if="!total" class="sf-empty">没有发现问题</div>
        <template v-else>
          <div class="sf-hint">
            共 {{ total }} 条。
            <template v-if="summary.fixable">其中 {{ summary.fixable }} 条可一键优化</template>
            <template v-else>没有可自动优化的提醒</template>
            <template v-if="summary.manual">，{{ summary.manual }} 条需手动处理</template>
          </div>
          <FindingList :findings="findings" mark-manual />
        </template>
        <div v-if="error" class="sf-error" role="alert">{{ error }}</div>
      </template>
    </div>
    <template #footer>
      <template v-if="proposal">
        <el-button :disabled="applying" @click="proposal = null">放弃</el-button>
        <el-button type="primary" :loading="applying" :disabled="busy || applying" @click="apply">应用</el-button>
      </template>
      <template v-else>
        <el-button :disabled="locked" @click="emit('update:modelValue', false)">关闭</el-button>
        <el-button
          v-if="total"
          type="primary"
          :loading="optimizing"
          :disabled="busy || optimizing || !summary.fixable"
          @click="optimize"
        >一键优化</el-button>
      </template>
    </template>
  </el-dialog>
</template>

<script setup>
import { ref, computed } from 'vue'
import { storyboardsAPI } from '@/api/storyboards'
import FindingList from '@/components/FindingList.vue'
import { groupFindings, optimizeSummary, optimizeRows } from '@/utils/segmentUi'

const props = defineProps({
  modelValue: { type: Boolean, default: false },
  storyboardId: { type: Number, required: true },
  findings: { type: Array, default: () => [] },
  /** 父组件正在重新编译预览 */
  busy: { type: Boolean, default: false },
})
const emit = defineEmits(['update:modelValue', 'applied'])

const proposal = ref(null)
const optimizing = ref(false)
const applying = ref(false)
const error = ref('')

// 请求进行中不能关：迟到的结果会落进已关闭的弹窗，再打开时被当成对当前分镜的提议
const locked = computed(() => optimizing.value || applying.value)
const total = computed(() => groupFindings(props.findings).total)
const summary = computed(() => optimizeSummary(props.findings))
const rows = computed(() => optimizeRows(proposal.value?.changes))

function reset() {
  proposal.value = null
  error.value = ''
}

async function optimize() {
  optimizing.value = true
  error.value = ''
  try {
    proposal.value = await storyboardsAPI.optimizePreview(props.storyboardId)
  } catch (e) {
    error.value = e?.message || '优化失败'
  } finally {
    optimizing.value = false
  }
}

async function apply() {
  applying.value = true
  try {
    const sb = await storyboardsAPI.updateSegmentIr(props.storyboardId, proposal.value.ir)
    proposal.value = null
    emit('applied', sb)
  } catch (_) {
    // 错误提示由请求拦截器展示，提议保留，可再次应用或放弃
  } finally {
    applying.value = false
  }
}
</script>

<style scoped>
.sf-hint { font-size: 12px; color: var(--el-text-color-secondary); margin-bottom: 8px; }
.sf-empty { font-size: 13px; color: var(--el-text-color-secondary); padding: 12px 0; }
.sf-error { margin-top: 8px; font-size: 12px; color: var(--el-color-danger); }
.sf-diff { display: flex; flex-direction: column; gap: 2px; padding: 8px 0; border-top: 1px dashed var(--el-border-color); font-size: 13px; line-height: 1.6; }
.sf-diff-label { font-size: 12px; color: var(--el-text-color-secondary); }
.sf-before { color: var(--el-text-color-secondary); text-decoration: line-through; }
.sf-after { color: var(--el-color-success); }
.sf-remaining { font-size: 12px; color: var(--el-color-warning); }
</style>
