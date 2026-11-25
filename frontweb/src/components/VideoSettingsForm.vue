<template>
  <div class="video-settings-form">
    <el-form-item v-for="key in keys" :key="key" :label="LABELS[key]">
      <div class="video-option-row">
        <template v-if="key === 'resolution'">
          <el-select :model-value="settings.resolution" style="width: 160px" :disabled="disabled" @change="v => emit('change', key, v)">
            <el-option label="480p" value="480p" />
            <el-option label="720p" value="720p" />
            <el-option label="1080p" value="1080p" />
          </el-select>
        </template>

        <template v-else-if="key === 'subtitle'">
          <el-switch :model-value="settings.subtitle" :disabled="disabled" @change="v => emit('change', key, v)" />
          <span v-if="settings.subtitle" class="video-option-hint">开启后，合成整集时会检测解说旁白：若有文案则自动生成 SRT、按分镜时长合成旁白语音（过长加速 / 过短补静音）、与成片对齐后烧录字幕并混音。</span>
        </template>

        <template v-else-if="key === 'voice_source'">
          <el-radio-group :model-value="settings.voice_source" :disabled="disabled" @change="v => emit('change', key, v)">
            <el-radio-button value="native">模型原生人声</el-radio-button>
            <el-radio-button value="dubbed">后期配音</el-radio-button>
          </el-radio-group>
          <span class="video-option-hint">
            {{ settings.voice_source === 'dubbed'
              ? '视频里角色不开口，合成整集时按角色音色逐句配音并自动叠加，无需再开对白烧录（个别无法关闭音轨的模型会保留原声，编译预览会提示）。'
              : '由视频模型直接生成对白与口型。模型不支持原生人声时，编译预览会提示，并按角色不开口出片；需要台词声音请改选「后期配音」。' }}
            仅影响之后新生成的片段，已生成的片段不变。
          </span>
        </template>

        <template v-else-if="key === 'dialogue_burn'">
          <el-switch :model-value="settings.dialogue_burn" :disabled="disabled" @change="v => emit('change', key, v)" />
          <span v-if="settings.dialogue_burn" class="video-option-hint">跟随整集的镜头使用已有配音，其余保留原声。单镜选择优先，旁白可独立叠加。</span>
        </template>

        <template v-else-if="key === 'watermark'">
          <el-switch
            :model-value="settings.watermark.enabled"
            :disabled="disabled"
            @change="v => emit('change', key, { enabled: v, text: settings.watermark.text })"
          />
          <el-input
            v-if="settings.watermark.enabled"
            :model-value="settings.watermark.text"
            placeholder="右下角水印文字"
            maxlength="200"
            show-word-limit
            clearable
            :disabled="disabled"
            class="video-watermark-input"
            @change="v => emit('change', key, { enabled: true, text: v || '' })"
          />
        </template>

        <template v-else-if="key === 'dialogue_subtitles'">
          <el-switch :model-value="settings.dialogue_subtitles" :disabled="disabled" @change="v => emit('change', key, v)" />
          <span class="video-option-hint">结构化分镜：按镜头时间生成台词字幕（每行 ≤12 字，内心独白/旁白斜体）。本机 ffmpeg 不能烧录时自动改为软字幕。</span>
        </template>

        <template v-else-if="key === 'cards'">
          <el-switch :model-value="settings.cards" :disabled="disabled" @change="v => emit('change', key, v)" />
          <span class="video-option-hint">把分镜里的关键文字以画面上方字卡叠加，不交给视频模型画。</span>
        </template>

        <template v-else-if="key === 'bgm'">
          <el-input
            :model-value="settings.bgm.url"
            placeholder="音乐文件地址（/static/… 或 http）"
            clearable
            :disabled="disabled"
            class="video-watermark-input"
            @change="v => emit('change', key, { url: v || '', volume_db: settings.bgm.volume_db })"
          />
          <el-input-number
            :model-value="settings.bgm.volume_db"
            :min="-40"
            :max="-6"
            :step="1"
            size="small"
            :disabled="disabled"
            @change="v => v != null && emit('change', key, { url: settings.bgm.url, volume_db: v })"
          />
          <span class="video-option-hint">dB，压在台词下面（默认 -18）</span>
        </template>

        <template v-else-if="key === 'review_sheets'">
          <el-switch :model-value="settings.review_sheets" :disabled="disabled" @change="v => emit('change', key, v)" />
          <span class="video-option-hint">额外输出片段接缝拼图与每秒抽帧拼图，方便检查跳变。</span>
        </template>

        <template v-if="scopes">
          <template v-if="scopes[key] === 'episode'">
            <el-tag size="small" type="warning" effect="light">本集自定义</el-tag>
            <el-button link type="primary" size="small" :disabled="disabled" @click="emit('reset', key)">恢复随项目</el-button>
          </template>
        </template>
      </div>
    </el-form-item>
  </div>
</template>

<script setup>
/**
 * 视频配置 9 项的表单：只负责展示与抛出变更，保存由调用方决定。
 * 创作页（本集，传 scopes 以标出「本集自定义」并可恢复随项目）与项目详情页（项目默认，不传 scopes）共用。
 */
defineProps({
  /** 有效设置（后端合并好的完整对象） */
  settings: { type: Object, required: true },
  /** 要显示的项，顺序即界面顺序 */
  keys: { type: Array, required: true },
  /** 可选：{ [key]: 'project' | 'episode' } */
  scopes: { type: Object, default: null },
  disabled: { type: Boolean, default: false },
})
const emit = defineEmits(['change', 'reset'])

const LABELS = {
  resolution: '分辨率',
  subtitle: '字幕',
  voice_source: '台词声音',
  dialogue_burn: '对白烧录',
  watermark: '水印',
  dialogue_subtitles: '台词字幕',
  cards: '字卡',
  bgm: '背景音乐',
  review_sheets: '审片拼图',
}
</script>

<style scoped>
.video-settings-form {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(360px, 1fr));
  align-items: start;
  gap: 0 24px;
}
.video-option-row {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px 12px;
}
.video-option-hint {
  flex: 1;
  min-width: 200px;
  font-size: 12px;
  line-height: 1.45;
  color: var(--el-text-color-secondary);
}
.video-watermark-input {
  flex: 1;
  min-width: 200px;
  max-width: 360px;
}
</style>
