<template>
  <el-button v-if="dramaId" size="small" @click="openAt()">创作与跨集复核</el-button>
  <el-dialog v-model="opened" :title="(data?.title || '作品') + ' · 创作与跨集复核'" width="min(760px, 94vw)" append-to-body>
    <section v-loading="loading" class="review-body" :aria-busy="loading">
      <div v-if="error" role="alert">{{ error }} <el-button size="small" @click="load()">重新读取</el-button></div>
      <template v-if="data">
        <details :open="!episodeId && !shotId">
          <summary>全剧事实与创作方法</summary>
          <label class="field">作者确认的事实
            <textarea v-model="draft.facts" maxlength="4000" rows="3" placeholder="例如：守灯人从未见过海面，蓝灯在第二集才亮。" />
          </label>
          <label><input type="checkbox" v-model="draft.enabled" /> 生成时使用创作方法 v{{ data.version }} 与全剧事实</label>
          <el-button size="small" :disabled="saving || !dirty" @click="saveDirection">保存全剧设置</el-button>
        </details>
        <p v-if="!data.episodes.length">暂无分集。可先保存全剧事实。</p>
        <template v-else>
          <label class="field">查看分集
            <select v-model="episodeId" @change="shotId = null">
              <option :value="null">全剧进度</option>
              <option v-for="ep in data.episodes" :key="ep.id" :value="ep.id">第 {{ ep.number }} 集 · {{ ep.title }}</option>
            </select>
          </label>
          <table v-if="!episode">
            <thead><tr><th>分集</th><th>视频就绪</th><th>待复核</th><th>缺项</th></tr></thead>
            <tbody><tr v-for="ep in data.episodes" :key="ep.id">
              <td><el-button link @click="episodeId = ep.id">第 {{ ep.number }} 集 · {{ ep.title }}</el-button></td>
              <td>{{ ep.shots.filter(s => s.has_video).length }} / {{ ep.shots.length }}</td>
              <td>{{ pendingShots(ep) || '无' }}</td>
              <td>{{ missing(ep) }}</td>
            </tr></tbody>
          </table>
          <template v-else>
            <p>{{ missing(episode) }} · 待复核：{{ pendingShots(episode) || '无' }}</p>
            <label v-if="episode.shots.length" class="field">查看镜头
              <select v-model="shotId"><option :value="null">选择分镜</option>
                <option v-for="s in episode.shots" :key="s.id" :value="s.id">镜 {{ s.number }} · {{ s.title || '未命名' }}{{ s.needs_review ? ' · 待复核' : '' }}{{ !s.has_video ? ' · 缺视频' : '' }}</option>
              </select>
            </label>
          </template>
          <article v-if="shot">
            <p>{{ shot.adopted_id ? (shot.has_video ? '当前采用 #' : '采用视频失效，请重选 #') + shot.adopted_id : shot.has_video ? '沿用旧镜视频' : '缺视频' }}</p>
            <MediaReviewNotes :key="shot.id" :current="shot.current_review" :history="shot.history_reviews" />
            <template v-if="data.direction.enabled">
              <label class="field">本镜创作方法
                <select :value="shot.lock.method || 'auto'" :disabled="saving" @change="saveShot({action:'method', method:$event.target.value})">
                  <option value="auto">按镜头判断（{{ shot.method_label }}）</option>
                  <option v-for="method in data.methods" :key="method.id" :value="method.id">{{ method.label }}</option>
                </select>
              </label>
              <p v-for="check in shot.checks" :key="check">{{ check }}</p>
              <el-button size="small" :disabled="saving || shot.approved" @click="saveShot({action:'approve'})">{{ shot.approved ? '已人工放行' : '核对后放行本镜方法' }}</el-button>
            </template>
            <div v-for="(label, field) in fields" :key="field" class="lock">
              <strong>{{ label }}{{ shot.changes.includes(field) ? ' · 待复核' : field in shot.lock ? ' · 已锁定' : '' }}</strong>
              <p v-if="shot.changes.includes(field)">上次确认 · {{ format(shot.lock[field]) }}</p>
              <p>当前 · {{ format(shot.current[field]) }}</p>
              <el-button v-if="!(field in shot.lock) || shot.changes.includes(field)" size="small" :disabled="saving" @click="saveShot({action:'accept', field})">
                {{ field in shot.lock ? '确认这次变化' : '锁定当前' + label }}
              </el-button>
              <el-button v-if="field in shot.lock" size="small" :disabled="saving" @click="saveShot({action:'unlock', field})">解除锁定</el-button>
            </div>
          </article>
        </template>
      </template>
    </section>
  </el-dialog>
</template>

<script setup>
import { computed, ref, watch } from 'vue'
import request from '@/utils/request'
import MediaReviewNotes from './MediaReviewNotes.vue'

const props = defineProps({ dramaId: [Number, String], currentEpisodeId: [Number, String] })
const opened = ref(false)
const data = ref(null)
const loading = ref(false)
const saving = ref(false)
const error = ref('')
const draft = ref({})
const episodeId = ref(null)
const shotId = ref(null)
const fields = { dialogue: '对白', visual: '外观与道具' }
const episode = computed(() => data.value?.episodes.find(e => e.id === episodeId.value))
const shot = computed(() => episode.value?.shots.find(s => s.id === shotId.value))
const dirty = computed(() => draft.value.enabled !== data.value?.direction.enabled || draft.value.facts !== data.value?.direction.facts)
const url = () => '/dramas/' + props.dramaId
let generation = 0

function format(value) { return (Array.isArray(value) ? value.join('\n') : value) || '无' }
function pendingShots(ep) {
  const numbers = ep.shots.filter(s => s.needs_review).map(s => s.number)
  return numbers.length ? '镜 ' + numbers.join('、') : ''
}
function missing(ep) {
  const items = []
  if (!ep.has_script) items.push('缺剧本')
  if (!ep.shots.length) items.push('缺分镜')
  const missingShots = ep.shots.filter(s => !s.has_video)
  if (missingShots.length) items.push('缺视频：镜 ' + missingShots.map(s => s.number).join('、'))
  return items.join('，') || '剧本、分镜和视频齐全'
}
async function load(resetDraft = true) {
  const token = ++generation
  loading.value = true
  error.value = ''
  try {
    const result = await request.get(url() + '/creative-review')
    if (token !== generation) return
    data.value = result
    if (resetDraft) draft.value = { ...result.direction }
  } catch (e) {
    if (token === generation) error.value = e.message
  } finally {
    if (token === generation) loading.value = false
  }
}
function openAt(id = null) {
  episodeId.value = Number(props.currentEpisodeId) || null
  shotId.value = id
  opened.value = true
  data.value = null
  load()
}
async function save(operation, direction = false) {
  if (saving.value) return
  const token = generation
  saving.value = true
  error.value = ''
  try {
    await operation()
    if (token === generation) await load(direction)
  } catch (e) {
    if (token === generation) error.value = e.message
  } finally { saving.value = false }
}
function saveDirection() {
  save(() => request.put(url() + '/creative-direction', draft.value), true)
}
function saveShot(action) {
  save(() => request.put(url() + '/creative-review/' + shot.value.id, { ...action, review_token: shot.value.review_token }))
}
watch(() => props.dramaId, () => { generation++; opened.value = false; data.value = null })
defineExpose({ openAt })
</script>

<style scoped>
.review-body { min-height: 4rem; display: grid; gap: .85rem; }
details { padding-bottom: .65rem; border-bottom: 1px solid var(--el-border-color); }
summary, select { cursor: pointer; }
summary { font-weight: 600; }
label.field { display: grid; gap: .35rem; margin: .6rem 0; }
select, textarea { color: var(--el-text-color-primary); background: var(--el-bg-color); border: 1px solid var(--el-border-color); border-radius: 4px; padding: .5rem; font: inherit; }
p { white-space: pre-line; overflow-wrap: anywhere; margin: .55rem 0; }
.lock { margin-top: .8rem; padding-top: .7rem; border-top: 1px solid var(--el-border-color-light); }
table { border-collapse: collapse; }
th, td { text-align: left; padding: .35rem; }
</style>
