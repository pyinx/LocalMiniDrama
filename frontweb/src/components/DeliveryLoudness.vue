<template>
  <el-button size="large" @click="open">成片响度</el-button>
  <el-dialog v-model="visible" title="成片响度" width="min(680px, 94vw)" destroy-on-close>
    <el-checkbox v-model="allEpisodes">包含本剧其他集</el-checkbox>
    <div v-loading="busy" class="outputs">
      <p v-if="error" role="alert">{{ error }} <el-button link @click="open">重试</el-button></p>
      <template v-else>
        <article v-for="item in shown" :key="item.id">
          <b>第 {{ numberOf(item.episode_id) }} 集 · {{ item.delivery_mode === 'draft' ? '草稿' : '成片' }} #{{ item.id }}</b>
          <small>{{ new Date(item.completed_at || item.created_at).toLocaleString() }}</small>
          <MediaMeasurement :id="item.id" />
        </article>
        <el-empty v-if="!busy && !shown.length" description="还没有已编码完成的本地导出件" />
      </template>
    </div>
  </el-dialog>
</template>
<script setup>
import { computed, ref } from 'vue'
import request from '@/utils/request'
import MediaMeasurement from './MediaMeasurement.vue'

const props = defineProps({ dramaId: Number, episodeId: Number, episodes: Array })
const visible = ref(false), busy = ref(false), allEpisodes = ref(false), error = ref(''), items = ref([])
const shown = computed(() => items.value.filter(item => allEpisodes.value || Number(item.episode_id) === props.episodeId))
const numberOf = id => props.episodes?.find(ep => Number(ep.id) === Number(id))?.episode_number ?? '未知'

async function open() {
  if (busy.value) return
  visible.value = true
  busy.value = true
  error.value = ''
  items.value = []
  try {
    const rows = await request.get('/video-merges', { params: { drama_id: props.dramaId } })
    items.value = rows.filter(item => item.encoded_output).sort((a, b) => b.id - a.id)
  } catch (e) { error.value = e.message || '无法读取导出记录' }
  finally { busy.value = false }
}
</script>
<style scoped>
.outputs { min-height: 64px; }
article { border-top: 1px solid var(--el-border-color); padding: 12px 0; }
small { margin-left: 12px; color: var(--el-text-color-secondary); }
</style>
