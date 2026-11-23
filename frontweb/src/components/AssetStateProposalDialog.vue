<template>
  <el-dialog
    :model-value="modelValue"
    title="按本集剧本提议场景状态与造型"
    width="min(860px, 94vw)"
    @update:model-value="(v) => emit('update:modelValue', v)"
    @open="load"
  >
    <div class="sp-hint">场景状态以场景主图为参考，只换时段、光线和环境；造型以角色主图为参考，只换穿着。生成结构化分镜时会按段选用它们。取消勾选的不会创建。</div>
    <div v-if="loading" class="sp-loading" v-loading="true" element-loading-text="正在读本集剧本…" />
    <template v-else>
      <div v-if="loadError" class="sp-error">{{ loadError }}</div>
      <template v-else>
        <h4 class="sp-title">场景状态（{{ states.length }}）</h4>
        <div v-if="!states.length" class="sp-empty">本集没有需要新增的场景状态</div>
        <div v-for="(s, i) in states" :key="'s' + i" class="sp-row">
          <el-checkbox v-model="s.checked" />
          <span class="sp-parent" :title="s.scene_name">{{ s.scene_name }}</span>
          <el-input v-model="s.name" size="small" placeholder="名称" />
          <el-input v-model="s.state_phrase" size="small" placeholder="此刻和母版的不同" />
        </div>
        <h4 class="sp-title">造型（{{ wardrobes.length }}）</h4>
        <div v-if="!wardrobes.length" class="sp-empty">本集没有需要新增的造型</div>
        <div v-for="(w, i) in wardrobes" :key="'w' + i" class="sp-row">
          <el-checkbox v-model="w.checked" />
          <span class="sp-parent" :title="w.character_name">{{ w.character_name }}</span>
          <el-input v-model="w.name" size="small" placeholder="名称" />
          <el-input v-model="w.change_phrase" size="small" placeholder="换了什么" />
          <span class="sp-range">第 {{ rangeText(w.episode_range) }} 集</span>
        </div>
      </template>
    </template>
    <template #footer>
      <el-button @click="emit('update:modelValue', false)">取消</el-button>
      <el-button type="primary" :loading="applying" :disabled="loading || applying || !accepted.total" @click="apply">
        创建并出图（{{ accepted.total }}）
      </el-button>
    </template>
  </el-dialog>
</template>

<script setup>
import { ref, computed } from 'vue'
import { ElMessage } from 'element-plus'
import { variantsAPI } from '@/api/variants'
import { createStateProposals, startVariantImages } from '@/utils/assetStates'

const props = defineProps({
  modelValue: { type: Boolean, default: false },
  episodeId: { type: [Number, String], default: null },
})
const emit = defineEmits(['update:modelValue', 'done'])

const loading = ref(false)
const applying = ref(false)
const loadError = ref('')
const states = ref([])
const wardrobes = ref([])

const filled = (v, phrase) => v.checked && String(v.name || '').trim() && String(v[phrase] || '').trim()
const accepted = computed(() => {
  const scene_states = states.value.filter((s) => filled(s, 'state_phrase'))
  const wardrobeList = wardrobes.value.filter((w) => filled(w, 'change_phrase'))
  return { scene_states, wardrobes: wardrobeList, total: scene_states.length + wardrobeList.length }
})

function rangeText(range) {
  if (!Array.isArray(range) || !range.length) return '-'
  return range[1] && range[1] !== range[0] ? `${range[0]}–${range[1]}` : String(range[0])
}

async function load() {
  if (!props.episodeId) return
  loading.value = true
  loadError.value = ''
  states.value = []
  wardrobes.value = []
  try {
    const out = await variantsAPI.propose(props.episodeId)
    states.value = (out?.scene_states || []).map((s) => ({ ...s, checked: true }))
    wardrobes.value = (out?.wardrobes || []).map((w) => ({ ...w, checked: true }))
  } catch (e) {
    loadError.value = e?.response?.data?.error?.message || e?.message || '提议失败'
  } finally {
    loading.value = false
  }
}

/** 创建勾选的项并逐项提交出图；出图在后台进行，完成后会出现在场景和角色的变体里 */
async function apply() {
  if (applying.value) return
  applying.value = true
  try {
    const { created, errors } = await createStateProposals(variantsAPI, accepted.value)
    const images = await startVariantImages(variantsAPI, created)
    const failed = [...errors, ...images.errors]
    if (failed.length) ElMessage.warning(`已创建 ${created.length} 项，开始出图 ${images.started.length} 项；${failed.length} 项未完成：${failed.slice(0, 3).join('；')}`)
    else ElMessage.success(`已创建 ${created.length} 项，正在后台出图`)
    emit('done')
    emit('update:modelValue', false)
  } finally {
    applying.value = false
  }
}
</script>

<style scoped>
.sp-hint { font-size: 12px; color: var(--el-text-color-secondary); margin-bottom: 8px; }
.sp-loading { min-height: 120px; }
.sp-error { color: var(--el-color-danger); font-size: 13px; }
.sp-title { margin: 12px 0 6px; font-size: 13px; }
.sp-empty { font-size: 12px; color: var(--el-text-color-secondary); }
.sp-row { display: grid; grid-template-columns: auto 96px 140px 1fr auto; gap: 8px; align-items: center; margin-bottom: 6px; }
.sp-parent { font-size: 12px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.sp-range { font-size: 12px; color: var(--el-text-color-secondary); white-space: nowrap; }
</style>
