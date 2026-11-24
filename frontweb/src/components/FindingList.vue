<template>
  <div v-if="grouped.total" class="finding-list">
    <div v-for="level in ['block', 'warn', 'info']" :key="level">
      <div v-for="(f, i) in grouped[level]" :key="level + i" class="finding-row">
        <el-tag :type="findingTag(f).type" size="small" effect="plain">{{ findingTag(f).label }}</el-tag>
        <span class="finding-msg">{{ f.msg }}</span>
        <span v-if="findingWhere(f)" class="finding-where">{{ findingWhere(f) }}</span>
        <el-tag v-if="markManual && needsManual(f)" size="small" type="info" effect="plain">需手动处理</el-tag>
      </div>
    </div>
  </div>
  <div v-else-if="showEmpty" class="finding-empty">没有发现问题</div>
</template>

<script setup>
import { computed } from 'vue'
import { groupFindings, findingTag, findingWhere, needsManual } from '@/utils/segmentUi'

const props = defineProps({
  findings: { type: Array, default: () => [] },
  showEmpty: { type: Boolean, default: false },
  markManual: { type: Boolean, default: false },
})
const grouped = computed(() => groupFindings(props.findings))
</script>

<style scoped>
.finding-list { display: flex; flex-direction: column; gap: 4px; }
.finding-row { display: flex; align-items: baseline; gap: 6px; font-size: 12px; line-height: 1.5; }
.finding-msg { flex: 1; }
.finding-where { color: var(--el-text-color-secondary); white-space: nowrap; }
.finding-empty { font-size: 12px; color: var(--el-text-color-secondary); }
</style>
