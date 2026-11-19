<template>
  <div class="custom-style-editor">
    <label>画风名称<el-input v-model="draft.name" maxlength="100" /></label>
    <div class="actions">
      <label v-if="caps.vision_models?.length">识图模型<select v-model="visionModel"><option value="">默认文本模型</option><option v-for="m in caps.vision_models" :key="m">{{ m }}</option></select></label>
      <label v-if="caps.image_models?.length">生图模型<select :value="caps.model" :disabled="!!busy" @change="loadCaps($event.target.value)"><option v-for="m in caps.image_models" :key="m">{{ m }}</option></select></label>
    </div>
    <div class="example">
      <img v-if="draft.image" :src="imageUrl(draft.image)" alt="当前示例图" />
      <label class="upload">上传示例图<input type="file" accept="image/png,image/jpeg,image/webp,image/gif" @change="upload" /></label>
      <el-button :disabled="!draft.image || !!busy" @click="analyze">从图提取提示词</el-button>
    </div>
    <label>正向提示词<el-input v-model="draft.positive" type="textarea" :rows="3" maxlength="2000" placeholder="描述材质、线条、色彩和光影" /></label>
    <label>反向提示词<el-input v-model="draft.negative" type="textarea" :rows="2" maxlength="500" placeholder="可选，填写希望避免的视觉特征" /></label>
    <p v-if="draft.negative && !caps.negative">{{ caps.model || '当前模型' }} 的独立反向词能力尚未验证。</p>
    <div class="actions">
      <el-button :disabled="!draft.positive.trim() || !!busy" @click="generate">{{ draft.negative && !caps.negative ? '仅用正向词生图' : '生成示例图' }}</el-button>
      <span role="status">{{ busy || message }}</span>
    </div>
    <div v-if="candidate" class="example"><img :src="imageUrl(candidate)" alt="候选示例图" /><el-button @click="draft.image = candidate; candidate = ''">采用这张图</el-button></div>
    <div class="actions">
      <el-button @click="$emit('cancel')">取消</el-button>
      <el-button type="primary" :disabled="!!busy || !draft.name.trim() || !draft.positive.trim() || !draft.image" @click="save">存入画风库并采用</el-button>
    </div>
  </div>
</template>

<script setup>
import { onMounted, onBeforeUnmount, reactive, ref, watch } from 'vue'
import request from '@/utils/request'

const props = defineProps({ initial: Object })
const emit = defineEmits(['save','cancel'])
const initial = props.initial || {}
const localId = () => Array.from(crypto.getRandomValues(new Uint8Array(16)), n => n.toString(16).padStart(2, '0')).join('')
const draft = reactive({ id: initial.id || localId(), base_version: initial.version || 0,
  name: initial.name || '', positive: initial.positive || '', negative: initial.negative || '', image: initial.image || '' })
const caps = ref({}), visionModel = ref(''), candidate = ref(''), busy = ref(''), message = ref('')
let ticket = 0
const imageUrl = hash => '/api/v1/style-library/images/' + hash
async function loadCaps(model) {
  await run('正在读取模型能力…', () => request.get('/style-library/capabilities', { params: { model } }), value => { caps.value = value })
}
onMounted(() => loadCaps())
onBeforeUnmount(() => { ticket++ })
watch([() => draft.positive, () => draft.negative], () => { candidate.value = '' })

async function run(label, work, apply) {
  const id = ++ticket
  busy.value = label
  message.value = ''
  try {
    const result = await work()
    if (id === ticket) apply(result)
  } catch (error) {
    if (id === ticket) message.value = error.message
  } finally {
    if (id === ticket) busy.value = ''
  }
}
function upload(event) {
  const file = event.target.files?.[0]
  event.target.value = ''
  if (!file) return
  const form = new FormData()
  form.append('file', file)
  candidate.value = ''
  run('正在读取图片…', () => request.post('/style-library/images', form, { headers: { 'Content-Type': 'multipart/form-data' } }),
    result => { draft.image = result.image })
}
function analyze() {
  const { image, positive, negative } = draft
  run('正在提取画风…', () => request.post('/style-library/analyze', { image, model: visionModel.value || undefined }), result => {
    if (draft.image !== image || draft.positive !== positive || draft.negative !== negative) { message.value = '内容已修改，已保留你的编辑'; return }
    draft.positive = result.positive
    draft.negative = result.negative
  })
}
function generate() {
  const { positive, negative } = draft
  run('正在生成样图…', () => request.post('/style-library/generate', { positive, negative, model: caps.value.model, positive_only: !!negative && !caps.value.negative }),
    result => {
      if (draft.positive === positive && draft.negative === negative) candidate.value = result.image
      else message.value = '提示词已修改，请用当前提示词重新生成'
    })
}
function save() {
  run('正在保存…', () => request.post('/style-library', { ...draft }), item => emit('save', item))
}
</script>
<style scoped>
.custom-style-editor { display: grid; gap: 12px; margin-top: 14px; }
label { display: grid; gap: 5px; }
.example, .actions { display: flex; align-items: center; flex-wrap: wrap; gap: 10px; }
.example img { width: 116px; height: 116px; object-fit: contain; background: var(--el-fill-color-light); }
.upload { color: var(--el-color-primary); cursor: pointer; }
.upload input { max-width: 190px; }
p { margin: 0; color: var(--el-text-color-secondary); }
</style>
