<template>
  <div class="variant-editor">
    <div class="variant-hint">{{ cfg.hint }}</div>
    <div v-for="v in items" :key="v.id" class="variant-row">
      <el-image v-if="v.image_url" :src="v.image_url" fit="cover" class="variant-thumb" :preview-src-list="[v.image_url]" preview-teleported />
      <div v-else class="variant-thumb variant-thumb--empty">无图</div>
      <div class="variant-fields">
        <el-input v-model="v.name" size="small" placeholder="名称" @change="save(v)" />
        <el-select v-if="kind === 'scene_state'" v-model="v.kind" size="small" @change="save(v)">
          <el-option label="状态版本" value="state" />
          <el-option label="竖屏主机位" value="portrait" />
          <el-option label="反打" value="reverse" />
        </el-select>
        <el-input v-model="v[cfg.phraseField]" size="small" :placeholder="cfg.phrasePlaceholder" @change="save(v)" />
        <template v-if="kind === 'wardrobe'">
          <el-input-number v-model="v.rangeFrom" size="small" :min="1" controls-position="right" placeholder="起集" @change="save(v)" />
          <el-input-number v-model="v.rangeTo" size="small" :min="1" controls-position="right" placeholder="止集" @change="save(v)" />
        </template>
      </div>
      <div class="variant-ops">
        <el-button size="small" :loading="generating.has(v.id)" @click="generate(v)">{{ v.image_url ? '重新出图' : '出图' }}</el-button>
        <el-button size="small" link type="danger" @click="remove(v)">删除</el-button>
      </div>
    </div>
    <el-button size="small" @click="add">+ {{ cfg.addLabel }}</el-button>
  </div>
</template>

<script setup>
import { ref, reactive, computed, watch, onBeforeUnmount } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { variantsAPI } from '@/api/variants'

const props = defineProps({
  kind: { type: String, required: true },
  parentId: { type: [Number, String], required: true },
})
const emit = defineEmits(['changed'])

const CONFIG = {
  wardrobe: { hint: '造型以角色主图为身份参考派生；处境（淋雨、受伤）不算造型，写进分镜动作。', phraseField: 'change_phrase', phrasePlaceholder: '只写变了的部分，如：深灰西装、白衬衫', addLabel: '造型' },
  scene_state: { hint: '状态版本、竖屏主机位、反打都以场景主图（母版）为空间参考。', phraseField: 'state_phrase', phrasePlaceholder: '这个版本的不同之处，如：夜晚，台灯亮着', addLabel: '场景版本' },
  prop_state: { hint: '道具状态以道具初始图为外观参考。', phraseField: 'state_phrase', phrasePlaceholder: '现在的状态，如：屏幕碎裂', addLabel: '道具状态' },
}
const cfg = computed(() => CONFIG[props.kind])
const items = ref([])
const generating = reactive(new Set())
let pollTimer = null

function fromApi(v) {
  const range = Array.isArray(v.episode_range) ? v.episode_range : []
  return { ...v, rangeFrom: range[0] ?? null, rangeTo: range[1] ?? range[0] ?? null }
}

function payload(v) {
  const p = { name: v.name, [cfg.value.phraseField]: v[cfg.value.phraseField] }
  if (props.kind === 'scene_state') p.kind = v.kind || 'state'
  if (props.kind === 'wardrobe') {
    const r = [v.rangeFrom, v.rangeTo].filter((x) => Number.isInteger(x))
    p.episode_range = r.length ? r : null
  }
  return p
}

async function load() {
  if (!props.parentId) return
  try {
    items.value = ((await variantsAPI.list(props.kind, props.parentId)) || []).map(fromApi)
  } catch (_) {}
}

async function add() {
  try {
    const { value } = await ElMessageBox.prompt('名称', `新增${cfg.value.addLabel}`, { inputPattern: /\S/, inputErrorMessage: '请填写名称' })
    const { value: phrase } = await ElMessageBox.prompt(cfg.value.phrasePlaceholder, '变化描述', { inputPattern: /\S/, inputErrorMessage: '请填写' })
    const data = { name: value.trim(), [cfg.value.phraseField]: phrase.trim() }
    if (props.kind === 'scene_state') data.kind = 'state'
    await variantsAPI.create(props.kind, props.parentId, data)
    await load()
    emit('changed')
  } catch (_) {}
}

async function save(v) {
  if (!String(v.name || '').trim() || !String(v[cfg.value.phraseField] || '').trim()) return
  try {
    await variantsAPI.update(props.kind, v.id, payload(v))
    emit('changed')
  } catch (_) {
    await load()
  }
}

async function remove(v) {
  try {
    await ElMessageBox.confirm(`删除「${v.name}」？引用它的结构化分镜在生视频时会被拦下，需要改绑。`, '删除', { type: 'warning' })
    await variantsAPI.remove(props.kind, v.id)
    await load()
    emit('changed')
  } catch (_) {}
}

/** 出图是后台任务：每 3 秒刷新一次，直到图片变化或超过 3 分钟 */
async function generate(v) {
  generating.add(v.id)
  const before = v.image_url
  try {
    await variantsAPI.generateImage(props.kind, v.id)
    ElMessage.success('已开始出图')
    let elapsed = 0
    clearInterval(pollTimer)
    pollTimer = setInterval(async () => {
      elapsed += 3
      await load()
      const now = items.value.find((x) => x.id === v.id)
      if ((now && now.image_url && now.image_url !== before) || elapsed >= 180) {
        clearInterval(pollTimer)
        generating.delete(v.id)
        if (elapsed >= 180) ElMessage.warning('出图仍在进行，请稍后刷新查看')
        else emit('changed')
      }
    }, 3000)
  } catch (_) {
    generating.delete(v.id)
  }
}

watch(() => [props.kind, props.parentId], load, { immediate: true })
onBeforeUnmount(() => clearInterval(pollTimer))
</script>

<style scoped>
.variant-editor { display: flex; flex-direction: column; gap: 8px; width: 100%; }
.variant-hint { font-size: 12px; color: var(--el-text-color-secondary); }
.variant-row { display: flex; gap: 8px; align-items: center; }
.variant-thumb { width: 56px; height: 56px; border-radius: 4px; flex: none; }
.variant-thumb--empty { display: flex; align-items: center; justify-content: center; font-size: 11px; background: var(--el-fill-color); color: var(--el-text-color-secondary); }
.variant-fields { flex: 1; display: grid; grid-template-columns: 1fr 2fr auto auto; gap: 6px; }
.variant-ops { display: flex; flex-direction: column; gap: 4px; }
</style>
