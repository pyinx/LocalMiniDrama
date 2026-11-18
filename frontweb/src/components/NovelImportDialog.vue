<template>
  <el-dialog :model-value="true" title="导入小说 / 长文" width="min(740px, 94vw)"
    :close-on-click-modal="false" :close-on-press-escape="!busy" :show-close="!busy" @close="emit('close')">
    <template v-if="!preview">
      <el-input v-model="text" type="textarea" :rows="8" placeholder="粘贴正文，或选择 TXT / Markdown 文件" :disabled="busy" />
      <div class="options"><input type="file" accept=".txt,.md,text/plain" :disabled="busy" @change="readFile" /></div>
      <div class="options">
        <label>起始章 <el-input-number v-model="start" :min="1" :precision="0" size="small" /></label>
        <label>本批章数 <el-input-number v-model="limit" :min="1" :max="20" :precision="0" size="small" /></label>
      </div>
    </template>
    <template v-else>
      <p>共 {{ preview.total }} 章，本批第 {{ rows[0].chapter.index }}–{{ rows.at(-1).chapter.index }} 章。勾选需要写入的集。</p>
      <div v-for="row in rows" :key="row.chapter.index" class="chapter">
        <el-checkbox v-model="row.selected" :disabled="!!busy">
          第 {{ row.chapter.index }} 集 · {{ row.chapter.title }}
        </el-checkbox>
        <span class="state">{{ row.target ? '更新已有集 · ' + (row.target.storyboards?.length || 0) + ' 镜' : '新增' }}</span>
        <details><summary>核对原文、现稿与拟采用剧本</summary>
          <strong>原文 · {{ row.chapter.source.text.length }} 字符</strong><pre>{{ row.chapter.source.text }}</pre>
          <template v-if="row.target"><strong>已有 · {{ row.target.title }}</strong><pre>{{ row.target.script_content }}</pre></template>
          <strong>拟采用 · {{ adaptedCount(row) }}/{{ row.chapter.source.parts.length }} 段已改编</strong><pre>{{ scriptFor(row) }}</pre>
        </details>
        <p v-if="row.chapter.source.parts.some(p => p.error)" class="error">有分段改编失败。可重试失败段，也可采用该段原文。</p>
      </div>
      <div class="options">
        <el-button :disabled="!!busy || !remainingCalls" @click="adapt">AI 改编所选章节（{{ remainingCalls }} 次文本请求）</el-button>
        <el-button v-if="projectId" :disabled="!!busy" @click="refreshTargets">重新核对现有集</el-button>
      </div>
      <p v-if="progress" aria-live="polite">{{ progress }}</p>
    </template>
    <p v-if="error" class="error" role="alert">{{ error }}</p>
    <template #footer>
      <el-button :disabled="!!busy" @click="emit('close')">取消</el-button>
      <el-button v-if="preview" :disabled="!!busy" @click="back">更改章节范围</el-button>
      <el-button v-if="!preview" type="primary" :loading="busy === 'preview'" :disabled="!!busy || !text.trim()" @click="inspect">预览章节</el-button>
      <el-button v-else type="primary" :loading="busy === 'apply'" :disabled="!!busy || !selected.length" @click="apply">
        {{ projectId ? '采用' : '建项并采用' }}所选 {{ selected.length }} 集
      </el-button>
    </template>
  </el-dialog>
</template>

<script setup>
import { computed, onBeforeUnmount, ref } from 'vue'
import { dramaAPI } from '@/api/drama'

const props = defineProps({ projectId: [String, Number], project: { type: Object, required: true } })
const emit = defineEmits(['close', 'saved'])
const text = ref('')
const start = ref(1)
const limit = ref(10)
const preview = ref(null)
const rows = ref([])
const busy = ref('')
const progress = ref('')
const error = ref('')
let active = true
onBeforeUnmount(() => { active = false })
// getRandomValues also works on a LAN HTTP origin.
const operationId = Array.from(crypto.getRandomValues(new Uint8Array(16)), b => b.toString(16).padStart(2, '0')).join('')
const selected = computed(() => rows.value.filter(row => row.selected))
const remainingCalls = computed(() => selected.value.reduce((n, row) => n + row.chapter.source.parts.length - adaptedCount(row), 0))

function adaptedCount(row) { return row.chapter.source.parts.filter(p => p.adaptation).length }
function scriptFor(row) {
  const { text, parts } = row.chapter.source
  if (!adaptedCount(row)) return text
  return parts.map(p => p.adaptation || text.slice(p.start, p.end)).join('\n\n')
}
async function readFile(event) {
  const file = event.target.files[0]
  if (!file) return
  busy.value = 'read'
  try { text.value = await file.text(); error.value = '' }
  catch { error.value = '文件读取失败，请重新选择文件。' }
  finally { busy.value = '' }
}
function back() { preview.value = null; rows.value = []; progress.value = ''; error.value = '' }
async function targets() {
  if (!props.projectId) return []
  return (await dramaAPI.get(props.projectId)).episodes || []
}
async function inspect() {
  busy.value = 'preview'
  error.value = ''
  try {
    const form = new FormData()
    form.append('file', new Blob([text.value], { type: 'text/plain' }), 'novel.txt')
    form.append('title', props.project.title)
    form.append('start_chapter', String(start.value))
    form.append('max_chapters', String(limit.value))
    const [result, existing] = await Promise.all([dramaAPI.previewNovel(form), targets()])
    rows.value = result.chapters.map(chapter => ({
      chapter, selected: false, target: existing.find(ep => ep.episode_number === chapter.index) || null,
    }))
    preview.value = result
  } catch (e) { error.value = e.message }
  finally { busy.value = '' }
}
async function refreshTargets() {
  busy.value = 'refresh'
  try {
    const existing = await targets()
    for (const row of rows.value) {
      row.target = existing.find(ep => ep.episode_number === row.chapter.index) || null
      row.selected = false
    }
    error.value = ''
  } catch (e) { error.value = e.message }
  finally { busy.value = '' }
}
async function adapt() {
  busy.value = 'adapt'
  error.value = ''
  try {
    for (const row of selected.value) {
      const source = row.chapter.source
      for (const [i, part] of source.parts.entries()) {
        if (!active) return
        if (part.adaptation) continue
        progress.value = '正在改编第 ' + row.chapter.index + ' 章，第 ' + (i + 1) + '/' + source.parts.length + ' 段'
        try {
          const result = await dramaAPI.adaptNovelPart({ text: source.text.slice(part.start, part.end),
            title: props.project.title, chapter_title: row.chapter.title, previous: source.parts[i - 1]?.adaptation })
          part.adaptation = result.adaptation
          delete part.error
        } catch (e) { part.error = e.message; error.value = e.message; return }
      }
    }
  } finally { progress.value = ''; busy.value = '' }
}
async function apply() {
  if (!selected.value.length || busy.value) return
  busy.value = 'apply'
  error.value = ''
  try {
    const episodes = selected.value.map(({ chapter, target }) => ({
      episode_number: chapter.index, title: chapter.title,
      script_content: scriptFor({ chapter }), source: chapter.source,
      expected: target ? { id: target.id, title: target.title, script_content: target.script_content, updated_at: target.updated_at } : null,
    }))
    let created = null
    if (props.projectId) await dramaAPI.applyNovelEpisodes(props.projectId, episodes)
    else created = await dramaAPI.createFromNovel(props.project, episodes, operationId)
    emit('saved', { created, count: episodes.length, first: episodes[0].episode_number })
  } catch (e) { error.value = e.message }
  finally { busy.value = '' }
}
</script>

<style scoped>
.options { display: flex; gap: 12px; align-items: center; flex-wrap: wrap; margin-top: 12px; }
.chapter { border-bottom: 1px solid var(--el-border-color); padding: 8px 0; }
.state { margin-left: 8px; color: var(--el-text-color-secondary); }
details { margin: 6px 0; }
summary { cursor: pointer; }
pre { white-space: pre-wrap; overflow-wrap: anywhere; max-height: 12rem; overflow: auto; font: inherit; }
.error { color: var(--el-color-danger); }
</style>
