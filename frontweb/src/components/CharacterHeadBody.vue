<template>
  <div class="head-body">
    <div class="head-body-hint">头只生成一次，锁定长相；身体随造型更换。视频和分镜收到的参考图由程序把头和身体拼成一张。</div>
    <div class="head-body-row">
      <div v-for="part in parts" :key="part.key" class="head-body-cell">
        <el-image v-if="part.url" :src="part.url" fit="contain" class="head-body-thumb" :preview-src-list="[part.url]" preview-teleported />
        <div v-else class="head-body-thumb head-body-thumb--empty">无图</div>
        <span class="head-body-caption">{{ part.label }}</span>
      </div>
      <div class="head-body-ops">
        <template v-if="state.head_body">
          <el-button size="small" :loading="running === 'head'" :disabled="!!running" @click="run('head')">重新生成头</el-button>
          <el-button size="small" :loading="running === 'body'" :disabled="!!running" @click="run('body')">重新生成身体</el-button>
        </template>
        <template v-else>
          <el-button size="small" type="primary" plain :loading="running === 'all'" :disabled="!!running" @click="run('all')">转为头身分离</el-button>
          <el-button v-if="state.head_local_path" size="small" :loading="running === 'body'" :disabled="!!running" @click="run('body')">用现有头生成身体</el-button>
        </template>
      </div>
    </div>
    <div v-if="state.error_msg" class="head-body-error">{{ state.error_msg }}</div>
  </div>
</template>

<script setup>
import { ref, computed, watch, onBeforeUnmount } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { characterAPI } from '@/api/characters'
import { assetImageUrl } from '@/utils/mediaUrl'

const props = defineProps({
  characterId: { type: [Number, String], required: true },
})
const emit = defineEmits(['changed'])

const state = ref({})
const running = ref('')
let pollTimer = null

const parts = computed(() => [
  { key: 'head', label: '头像', url: state.value.head_local_path ? assetImageUrl({ local_path: state.value.head_local_path }) : '' },
  { key: 'body', label: '身体', url: state.value.body_local_path ? assetImageUrl({ local_path: state.value.body_local_path }) : '' },
])

async function load() {
  if (!props.characterId) return
  try {
    const res = await characterAPI.get(props.characterId)
    state.value = res?.character || {}
  } catch (_) {}
}

function stop() {
  clearInterval(pollTimer)
  pollTimer = null
  running.value = ''
}

/** 后台任务：每 3 秒刷新，主图换成新拼合图或出现错误即结束；转为头身分离要生成两张图，等待更久 */
async function run(part) {
  // 当前主图不是头身拼合图时，这两个操作都会替换主图，先确认
  if (!state.value.head_body) {
    const message = part === 'all'
      ? '将先生成头像，再以它为参考生成身体，完成后拼成新的角色主图。'
      : '将用现有头像生成身体，完成后拼成新的角色主图。'
    try {
      await ElMessageBox.confirm(message + '旧主图保留在历史图里；已认证的 Seedance 2 素材会标记为需刷新。', '转为头身分离', { type: 'warning' })
    } catch (_) { return }
  }
  const before = state.value.local_path
  running.value = part
  try {
    await characterAPI.generateHeadBody(props.characterId, part)
    ElMessage.success('已开始生成')
  } catch (_) {
    running.value = ''
    return
  }
  state.value = { ...state.value, error_msg: null }
  const limit = part === 'all' ? 360 : 180
  let elapsed = 0
  clearInterval(pollTimer)
  pollTimer = setInterval(async () => {
    elapsed += 3
    await load()
    if (state.value.error_msg) {
      stop()
    } else if (state.value.local_path !== before && state.value.head_body) {
      stop()
      emit('changed')
    } else if (elapsed >= limit) {
      stop()
      ElMessage.warning('生成仍在进行，请稍后重新打开查看')
    }
  }, 3000)
}

watch(() => props.characterId, () => { stop(); load() }, { immediate: true })
onBeforeUnmount(stop)
</script>

<style scoped>
.head-body { display: flex; flex-direction: column; gap: 8px; width: 100%; }
.head-body-hint { font-size: 12px; color: var(--el-text-color-secondary); }
.head-body-row { display: flex; gap: 8px; align-items: center; }
.head-body-cell { display: flex; flex-direction: column; align-items: center; gap: 2px; }
.head-body-thumb { width: 72px; height: 72px; border-radius: 4px; background: var(--el-fill-color-light); }
.head-body-thumb--empty { display: flex; align-items: center; justify-content: center; font-size: 11px; color: var(--el-text-color-secondary); }
.head-body-caption { font-size: 11px; color: var(--el-text-color-secondary); }
.head-body-ops { display: flex; flex-direction: column; gap: 4px; margin-left: auto; }
.head-body-error { font-size: 12px; color: var(--el-color-danger); }
</style>
