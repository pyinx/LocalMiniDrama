<template>
  <el-dialog :model-value="modelValue" title="剧本体检（只诊断，不改写剧本）" width="680px" append-to-body @update:model-value="(v) => emit('update:modelValue', v)" @open="run">
    <div v-if="loading" class="sr-hint">正在体检…</div>
    <template v-else-if="result">
      <div class="sr-head">
        <span class="sr-total">{{ result.report.weighted_total ?? '—' }}</span>
        <el-tag :type="gradeType">{{ result.report.grade }}</el-tag>
        <span class="sr-hint">台词 {{ result.script.stats.line_count }} 句，最长 {{ result.script.stats.max_line_chars }} 字<span v-if="result.script.format === 'fuzzy'">；剧本不是「人名：台词」格式，台词统计不完整</span></span>
      </div>
      <el-alert v-if="result.report.gates.compliance_blocked" type="error" :closable="false" show-icon title="含不能拍的内容，不评分" />
      <el-alert v-else-if="result.report.gates.non_script" type="warning" :closable="false" show-icon title="还不是可拍的剧本（只有梗概或仍是小说叙述），总分封顶 4 分" />
      <el-alert v-if="result.report.gates.homogeneous" type="warning" :closable="false" show-icon title="同一种冲突套路重复太多，冲突与节奏两项封顶 5 分" />
      <el-table :data="result.report.dimensions" size="small" class="sr-table">
        <el-table-column prop="label" label="维度" width="110" />
        <el-table-column label="分数" width="70">
          <template #default="{ row }">{{ row.score }}<span v-if="row.capped" class="sr-hint">（封顶）</span></template>
        </el-table-column>
        <el-table-column prop="evidence" label="依据" />
      </el-table>
      <div v-if="result.report.problems.length" class="sr-sub">具体问题</div>
      <div v-for="(p, i) in result.report.problems" :key="i" class="sr-problem">
        <b>{{ p.location || '—' }}</b>：{{ p.what }}<span v-if="p.advice" class="sr-hint"> → {{ p.advice }}</span>
      </div>
      <div v-if="result.script.stats.long_lines.length" class="sr-sub">超过 15 字的台词（建议拆短）</div>
      <div v-for="(l, i) in result.script.stats.long_lines" :key="'l' + i" class="sr-hint">· {{ l }}</div>
    </template>
    <template #footer>
      <el-button @click="emit('update:modelValue', false)">关闭</el-button>
      <el-button :loading="loading" @click="run">重新体检</el-button>
    </template>
  </el-dialog>
</template>

<script setup>
import { ref, computed } from 'vue'
import { storyboardsAPI } from '@/api/storyboards'

const props = defineProps({
  modelValue: { type: Boolean, default: false },
  episodeId: { type: [Number, String], required: true },
})
const emit = defineEmits(['update:modelValue'])
const loading = ref(false)
const result = ref(null)
const gradeType = computed(() => ({ 强: 'success', 可上线: 'success', 需打磨: 'warning' })[result.value?.report.grade] || 'danger')

async function run() {
  loading.value = true
  try {
    result.value = await storyboardsAPI.scriptReview(props.episodeId)
  } catch (_) {
    // 错误提示由请求拦截器展示
  } finally {
    loading.value = false
  }
}
</script>

<style scoped>
.sr-head { display: flex; align-items: center; gap: 10px; margin-bottom: 8px; }
.sr-total { font-size: 28px; font-weight: 700; }
.sr-hint { font-size: 12px; color: var(--el-text-color-secondary); }
.sr-table { margin: 8px 0; }
.sr-sub { font-weight: 600; margin: 10px 0 4px; font-size: 13px; }
.sr-problem { font-size: 13px; line-height: 1.6; }
</style>
