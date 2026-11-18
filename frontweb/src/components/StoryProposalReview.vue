<template>
  <el-button plain @click="open">审阅拟稿</el-button>
  <el-dialog v-model="visible" title="审阅剧本拟稿" width="min(740px, 94vw)" append-to-body>
    <section v-loading="busy">
      <p v-if="error" role="alert">{{ error }}</p>
      <p v-if="!tasks.length && !busy && !error">暂无待采用的剧本拟稿。</p>
      <article v-for="task in tasks" :key="task.id">
        <h3>{{ new Date(task.completed_at).toLocaleString() }} 生成的拟稿</h3>
        <div v-for="ep in task.episodes" :key="ep.episode_number">
          <el-checkbox v-model="ep.selected">第 {{ ep.episode_number }} 集 · {{ ep.title }} · {{ ep.target ? '更新' : '新增' }}</el-checkbox>
          <details><summary>查看现稿与拟稿</summary>
            <template v-if="ep.target"><strong>现稿 · {{ ep.target.title }}</strong><pre>{{ ep.target.script_content }}</pre></template>
            <strong>拟稿 · {{ ep.title }}</strong><pre>{{ ep.script_content }}</pre>
          </details>
        </div>
        <el-button type="primary" :disabled="busy || !task.episodes.some(ep => ep.selected)" @click="apply(task)">采用所选集</el-button>
      </article>
    </section>
    <template #footer><el-button :disabled="busy" @click="load">重新核对</el-button><el-button @click="visible = false">关闭</el-button></template>
  </el-dialog>
</template>

<script setup>
import { ref } from 'vue'
import request from '@/utils/request'
import { dramaAPI } from '@/api/drama'

const props = defineProps({ dramaId: { type: [Number, String], required: true } })
const emit = defineEmits(['saved'])
const visible = ref(false)
const tasks = ref([])
const busy = ref(false)
const error = ref('')
const url = () => '/dramas/' + props.dramaId + '/story-proposals'
async function open() { visible.value = true; await load() }
async function load() {
  busy.value = true
  error.value = ''
  try {
    const [drafts, project] = await Promise.all([request.get(url()), dramaAPI.get(props.dramaId)])
    const current = new Map(project.episodes.map(ep => [ep.episode_number, ep]))
    tasks.value = drafts.map(task => ({ ...task, episodes: task.episodes.map(ep =>
      ({ ...ep, selected: false, target: current.get(ep.episode_number) || null })) }))
  } catch (e) { tasks.value = []; error.value = e.message }
  finally { busy.value = false }
}
async function apply(task) {
  busy.value = true
  try {
    const episodes = task.episodes.filter(ep => ep.selected).map(ep => ({
      episode_number: ep.episode_number,
      expected: ep.target && { id: ep.target.id, title: ep.target.title, script_content: ep.target.script_content, updated_at: ep.target.updated_at },
    }))
    await request.put(url() + '/' + task.id, { episodes })
    emit('saved')
    await load()
  } catch (e) { error.value = e.message }
  finally { busy.value = false }
}
</script>
<style scoped>
article { margin-block: 1rem; }
details { margin: .25rem 0 .75rem; }
pre { white-space: pre-wrap; font: inherit; }
</style>
