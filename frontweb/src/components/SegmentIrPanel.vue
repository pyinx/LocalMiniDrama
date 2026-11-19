<template>
  <div class="seg-ir">
    <div class="seg-ir-head">
      <span class="seg-ir-title">结构化分镜</span>
      <span class="seg-ir-meta">{{ form.shots.length }} 个镜头 · {{ totalSeconds }} 秒</span>
      <div class="seg-ir-actions">
        <el-button size="small" :loading="previewing" @click="onPreview">编译预览</el-button>
        <el-button size="small" type="primary" :loading="saving" :disabled="!dirty" @click="onSave">保存</el-button>
      </div>
    </div>

    <div class="seg-ir-row">
      <el-input v-model="form.scene.setting" size="small" placeholder="地点此刻的样子" @input="dirty = true">
        <template #prepend>场景</template>
      </el-input>
    </div>
    <div class="seg-ir-row seg-ir-row--2">
      <el-input v-model="form.main_move" size="small" placeholder="本段主运镜" @input="dirty = true">
        <template #prepend>主运镜</template>
      </el-input>
      <el-input v-model="form.tone" size="small" placeholder="光线与情绪" @input="dirty = true">
        <template #prepend>基调</template>
      </el-input>
    </div>

    <el-collapse v-model="openShots" class="seg-ir-shots">
      <el-collapse-item v-for="(shot, k) in form.shots" :key="k" :name="k">
        <template #title>
          <span class="seg-ir-shot-title">镜头{{ k + 1 }} · {{ shot.seconds }}秒 · {{ shot.size }} · {{ shot.action || '（未写动作）' }}</span>
        </template>
        <div class="seg-ir-row seg-ir-row--4">
          <el-input-number v-model="shot.seconds" :min="1" :max="60" size="small" @change="dirty = true" />
          <el-input v-model="shot.size" size="small" placeholder="景别" @input="dirty = true" />
          <el-input v-model="shot.camera" size="small" placeholder="机位" @input="dirty = true" />
          <el-select v-model="shot.cut" size="small" @change="dirty = true">
            <el-option label="硬切进入" value="hard" />
            <el-option label="镜头不断" value="continuous" />
          </el-select>
        </div>
        <div class="seg-ir-row">
          <el-input v-model="shot.event" size="small" placeholder="这一镜让局势发生了什么变化（过渡镜头留空）" @input="dirty = true">
            <template #prepend>事件</template>
          </el-input>
        </div>
        <div class="seg-ir-row seg-ir-row--4">
          <el-checkbox v-model="shot.hasMovement" @change="dirty = true">运镜</el-checkbox>
          <template v-if="shot.hasMovement">
            <el-input v-model="shot.movement.type" size="small" placeholder="方式" @input="dirty = true" />
            <el-input v-model="shot.movement.speed" size="small" placeholder="速度" @input="dirty = true" />
            <el-input v-model="shot.movement.direction" size="small" placeholder="方向" @input="dirty = true" />
          </template>
        </div>
        <div class="seg-ir-sub">出镜人物</div>
        <div v-for="(s, j) in shot.subjects" :key="'s' + j" class="seg-ir-row seg-ir-row--6">
          <el-select v-model="s.alias" size="small" placeholder="人物" @change="dirty = true">
            <el-option v-for="a in castAliases" :key="a" :label="a" :value="a" />
          </el-select>
          <el-input v-model="s.frame_pos" size="small" placeholder="画面位置" @input="dirty = true" />
          <el-select v-model="s.facing" size="small" filterable allow-create @change="dirty = true">
            <el-option v-for="o in FACING_OPTIONS" :key="o" :label="o" :value="o" />
          </el-select>
          <el-input v-model="s.gaze" size="small" placeholder="看着谁/什么" @input="dirty = true" />
          <el-input v-model="s.holding" size="small" placeholder="手里拿着" @input="dirty = true" />
          <el-button size="small" link type="danger" @click="shot.subjects.splice(j, 1); dirty = true">移除</el-button>
        </div>
        <el-button size="small" link :disabled="!castAliases.length" @click="shot.subjects.push(newSubjectForm(castAliases[0])); dirty = true">+ 出镜人物</el-button>
        <div class="seg-ir-row">
          <el-input v-model="shot.action" type="textarea" :rows="2" placeholder="摄像机拍得到的动作过程" @input="dirty = true" />
        </div>
        <div class="seg-ir-sub">台词</div>
        <div v-for="(l, j) in shot.lines" :key="'l' + j" class="seg-ir-row seg-ir-row--line">
          <el-select v-model="l.kind" size="small" @change="dirty = true">
            <el-option v-for="o in LINE_KINDS" :key="o.value" :label="o.label" :value="o.value" />
          </el-select>
          <el-select v-model="l.speaker" size="small" placeholder="说话人" :disabled="l.kind === 'vo'" clearable @change="dirty = true">
            <el-option v-for="a in castAliases" :key="a" :label="a" :value="a" />
          </el-select>
          <el-input v-model="l.text" size="small" placeholder="台词原文" @input="dirty = true" />
          <el-input v-model="l.delivery" size="small" placeholder="语气" @input="dirty = true" />
          <el-button size="small" link type="danger" @click="shot.lines.splice(j, 1); dirty = true">移除</el-button>
        </div>
        <el-button size="small" link @click="shot.lines.push(newLineForm(castAliases[0])); dirty = true">+ 台词</el-button>
        <div class="seg-ir-row">
          <el-input v-model="shot.sfxText" size="small" placeholder="动作与环境声，用顿号分隔" @input="dirty = true">
            <template #prepend>声音</template>
          </el-input>
        </div>
        <div class="seg-ir-shot-ops">
          <el-button size="small" link :disabled="k === 0" @click="moveShot(k, -1)">上移</el-button>
          <el-button size="small" link :disabled="k === form.shots.length - 1" @click="moveShot(k, 1)">下移</el-button>
          <el-button size="small" link type="danger" :disabled="form.shots.length <= 1" @click="removeShot(k)">删除镜头</el-button>
        </div>
      </el-collapse-item>
    </el-collapse>
    <el-button size="small" link @click="addShot">+ 镜头</el-button>

    <div v-if="saveErrors.length" class="seg-ir-errors">
      <div v-for="(e, i) in saveErrors" :key="i">{{ e.path || '整段' }}：{{ e.message }}</div>
    </div>
    <FindingList v-if="planFindings.length" :findings="planFindings" />

    <div v-if="preview" class="seg-ir-preview">
      <div class="seg-ir-sub">
        编译结果（{{ preview.family }} · {{ preview.model || '未配置视频模型，按保守能力' }}）
        <el-tag v-if="preview.blocked" type="danger" size="small">有阻断项，不能提交</el-tag>
      </div>
      <FindingList :findings="preview.findings" show-empty />
      <div v-if="preview.refs.length" class="seg-ir-refs">
        <span v-for="r in preview.refs" :key="r.token" class="seg-ir-ref">{{ r.token }} {{ r.alias }}</span>
      </div>
      <el-input :model-value="preview.prompt" type="textarea" :autosize="{ minRows: 6, maxRows: 18 }" readonly />
    </div>
  </div>
</template>

<script setup>
import { ref, computed, watch } from 'vue'
import { ElMessage } from 'element-plus'
import { storyboardsAPI } from '@/api/storyboards'
import FindingList from '@/components/FindingList.vue'
import { irToForm, formToIr, newShotForm, newSubjectForm, newLineForm, FACING_OPTIONS, LINE_KINDS } from '@/utils/segmentUi'

const props = defineProps({
  storyboard: { type: Object, required: true },
})
const emit = defineEmits(['saved'])

const form = ref(irToForm(props.storyboard.segment_ir))
const dirty = ref(false)
const saving = ref(false)
const previewing = ref(false)
const preview = ref(null)
const saveErrors = ref([])
const planFindings = ref([])
const openShots = ref([])

watch(
  () => props.storyboard.segment_ir,
  (ir) => {
    if (ir && !dirty.value) form.value = irToForm(ir)
  }
)

const castAliases = computed(() => (form.value.cast || []).map((c) => c.alias))
const totalSeconds = computed(() => form.value.shots.reduce((n, s) => n + (Number(s.seconds) || 0), 0))

function addShot() {
  form.value.shots.push(newShotForm(form.value.shots[form.value.shots.length - 1]))
  openShots.value = [...openShots.value, form.value.shots.length - 1]
  dirty.value = true
}
function removeShot(k) {
  form.value.shots.splice(k, 1)
  dirty.value = true
}
function moveShot(k, d) {
  const list = form.value.shots
  ;[list[k], list[k + d]] = [list[k + d], list[k]]
  dirty.value = true
}

async function onSave() {
  saving.value = true
  saveErrors.value = []
  try {
    const sb = await storyboardsAPI.updateSegmentIr(props.storyboard.id, formToIr(form.value))
    planFindings.value = sb?.plan_findings || []
    dirty.value = false
    if (sb?.segment_ir) form.value = irToForm(sb.segment_ir)
    preview.value = null
    ElMessage.success('结构化分镜已保存')
    emit('saved', sb)
  } catch (e) {
    saveErrors.value = e?.response?.data?.error?.details?.errors || []
  } finally {
    saving.value = false
  }
}

async function onPreview() {
  if (dirty.value) {
    ElMessage.warning('请先保存修改再预览')
    return
  }
  previewing.value = true
  try {
    preview.value = await storyboardsAPI.compilePreview(props.storyboard.id)
  } catch (_) {
    // 错误提示由请求拦截器展示
  } finally {
    previewing.value = false
  }
}
</script>

<style scoped>
.seg-ir { display: flex; flex-direction: column; gap: 6px; }
.seg-ir-head { display: flex; align-items: center; gap: 8px; }
.seg-ir-title { font-weight: 600; }
.seg-ir-meta { font-size: 12px; color: var(--el-text-color-secondary); }
.seg-ir-actions { margin-left: auto; display: flex; gap: 6px; }
.seg-ir-row { display: grid; gap: 6px; }
.seg-ir-row--2 { grid-template-columns: 1fr 1fr; }
.seg-ir-row--4 { grid-template-columns: auto 1fr 1fr 1fr; align-items: center; }
.seg-ir-row--6 { grid-template-columns: 1fr 1fr 1.2fr 1fr 1fr auto; }
.seg-ir-row--line { grid-template-columns: 0.8fr 0.9fr 2.4fr 0.9fr auto; }
.seg-ir-sub { font-size: 12px; color: var(--el-text-color-secondary); margin-top: 4px; display: flex; gap: 6px; align-items: center; }
.seg-ir-shot-title { font-size: 12px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.seg-ir-shot-ops { display: flex; gap: 8px; justify-content: flex-end; }
.seg-ir-errors { font-size: 12px; color: var(--el-color-danger); }
.seg-ir-preview { display: flex; flex-direction: column; gap: 6px; border-top: 1px dashed var(--el-border-color); padding-top: 6px; }
.seg-ir-refs { display: flex; flex-wrap: wrap; gap: 6px; font-size: 12px; }
.seg-ir-ref { background: var(--el-fill-color); padding: 0 6px; border-radius: 4px; }
</style>
