<template>
  <div class="ep-seg-tools">
    <span class="ep-seg-label">结构化分镜</span>
    <el-button size="small" :loading="checking" @click="onCheck">整集检查</el-button>
    <el-button size="small" :loading="replanning" @click="onReplan">按当前视频模型重新规划</el-button>
    <el-button size="small" @click="openContinuity">连续性表</el-button>
    <el-button v-if="jimengActive" size="small" type="warning" plain @click="emit('jimeng-episode')">即梦整集报价并生成</el-button>

    <el-dialog v-model="checkVisible" title="整集检查" width="640px" append-to-body>
      <FindingList :findings="checkFindings" show-empty />
    </el-dialog>

    <el-dialog v-model="continuityVisible" title="连续性表（同一场景各段逐字取用）" width="720px" append-to-body>
      <div v-for="scene in scenes" :key="scene.id" class="ep-seg-scene">
        <div class="ep-seg-scene-name">{{ scene.location || `场景 ${scene.id}` }}</div>
        <el-input v-model="table[scene.id].ambience" size="small" placeholder="环境底噪，如：空调低鸣，远处键盘声">
          <template #prepend>环境声</template>
        </el-input>
        <el-input v-model="table[scene.id].position_lock" size="small" placeholder="谁站在哪里">
          <template #prepend>站位</template>
        </el-input>
        <el-input v-model="table[scene.id].axis_lock" size="small" placeholder="谁始终在画面左/右">
          <template #prepend>左右关系</template>
        </el-input>
        <el-input v-model="table[scene.id].propsText" type="textarea" :rows="2" placeholder="一直在场的物件，一行一个：名称：外观" />
      </div>
      <template #footer>
        <el-button @click="continuityVisible = false">取消</el-button>
        <el-button type="primary" :loading="savingContinuity" @click="saveContinuity">保存</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<script setup>
import { ref } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { storyboardsAPI } from '@/api/storyboards'
import FindingList from '@/components/FindingList.vue'

const props = defineProps({
  episodeId: { type: [Number, String], required: true },
  scenes: { type: Array, default: () => [] },
  jimengActive: { type: Boolean, default: false },
})
const emit = defineEmits(['changed', 'jimeng-episode'])

const checking = ref(false)
const checkVisible = ref(false)
const checkFindings = ref([])
const replanning = ref(false)
const continuityVisible = ref(false)
const savingContinuity = ref(false)
const table = ref({})

async function onCheck() {
  checking.value = true
  try {
    const r = await storyboardsAPI.episodeSegmentCheck(props.episodeId)
    checkFindings.value = r?.findings || []
    checkVisible.value = true
  } catch (_) {
  } finally {
    checking.value = false
  }
}

async function onReplan() {
  try {
    await ElMessageBox.confirm('会按当前视频模型的时长上限拆分超长的段（新段排在原段后面、没有图和视频），原段保留已生成的内容。继续？', '重新规划', { type: 'warning' })
  } catch (_) {
    return
  }
  replanning.value = true
  try {
    const r = await storyboardsAPI.replanEpisode(props.episodeId)
    const created = (r?.changes || []).filter((c) => c.action === 'created').length
    const updated = (r?.changes || []).filter((c) => c.action === 'updated').length
    ElMessage.success(created || updated ? `已重新规划：新增 ${created} 段，调整 ${updated} 段` : '当前规划已符合模型要求')
    if (r?.findings?.length) {
      checkFindings.value = r.findings
      checkVisible.value = true
    }
    emit('changed')
  } catch (_) {
  } finally {
    replanning.value = false
  }
}

async function openContinuity() {
  let current = {}
  try {
    current = (await storyboardsAPI.getEpisodeContinuity(props.episodeId)) || {}
  } catch (_) {
    return
  }
  const t = {}
  for (const s of props.scenes) {
    const e = current[s.id] || {}
    t[s.id] = {
      ambience: e.ambience || '',
      position_lock: e.position_lock || '',
      axis_lock: e.axis_lock || '',
      propsText: (e.props || []).map((p) => `${p.name}：${p.look}`).join('\n'),
    }
  }
  table.value = t
  continuityVisible.value = true
}

async function saveContinuity() {
  const out = {}
  for (const [id, e] of Object.entries(table.value)) {
    const props = String(e.propsText || '')
      .split('\n')
      .map((l) => l.split(/[：:]/))
      .filter((x) => x.length >= 2 && x[0].trim() && x.slice(1).join('：').trim())
      .map((x) => ({ name: x[0].trim(), look: x.slice(1).join('：').trim() }))
    const entry = { props }
    for (const k of ['ambience', 'position_lock', 'axis_lock']) if (String(e[k] || '').trim()) entry[k] = String(e[k]).trim()
    if (props.length || entry.ambience || entry.position_lock || entry.axis_lock) out[id] = entry
  }
  savingContinuity.value = true
  try {
    await storyboardsAPI.putEpisodeContinuity(props.episodeId, out)
    continuityVisible.value = false
    ElMessage.success('连续性表已保存')
    emit('changed')
  } catch (_) {
  } finally {
    savingContinuity.value = false
  }
}
</script>

<style scoped>
.ep-seg-tools { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.ep-seg-label { font-size: 12px; color: var(--el-text-color-secondary); }
.ep-seg-scene { display: flex; flex-direction: column; gap: 6px; margin-bottom: 14px; }
.ep-seg-scene-name { font-weight: 600; font-size: 13px; }
</style>
