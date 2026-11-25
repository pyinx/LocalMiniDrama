/**
 * 视频配置的前端侧：只做「怎么展示、怎么提交」，不持有默认值与校验。
 * 默认值、校验、合并全在后端 services/videoSettings.js，接口随分集返回
 * `video_settings = { overrides, effective }`，随项目返回 `video_settings`（项目有效设置）。
 */

/** 9 项，按界面顺序 */
export const VIDEO_SETTING_KEYS = [
  'resolution', 'subtitle', 'voice_source', 'dialogue_burn', 'watermark',
  'dialogue_subtitles', 'cards', 'bgm', 'review_sheets',
]

/** 仅结构化分镜才有意义的 5 项（沿用原先「视频配置」里的显示条件） */
const STRUCTURED_ONLY = ['voice_source', 'dialogue_subtitles', 'cards', 'bgm', 'review_sheets']

export function visibleKeys({ structured } = {}) {
  return structured ? [...VIDEO_SETTING_KEYS] : VIDEO_SETTING_KEYS.filter(k => !STRUCTURED_ONLY.includes(k))
}

/** 这一项当前是「随项目」还是「本集自定义」 */
export function scopeOf(episode, key) {
  return episode?.video_settings?.overrides && key in episode.video_settings.overrides ? 'episode' : 'project'
}

/** 视频提交用的分辨率；没有有效设置时不传，由后端决定 */
export function resolutionOf(effective) {
  return effective?.resolution || undefined
}

/** 草稿/交付的合成选项（字段名是后端 finalize 接口的既有约定） */
export function mergeOptionsFromSettings(effective, { mode = 'complete', structured = false } = {}) {
  const s = effective || {}
  const watermark = s.watermark?.enabled ? String(s.watermark.text || '').trim().slice(0, 200) : ''
  const bgmUrl = String(s.bgm?.url || '').trim()
  return {
    delivery_mode: mode,
    burn_narration_subtitles: !!s.subtitle,
    // 结构化分集选「后期配音」＝ 需要把逐句配音合进成片，不再要求用户另开对白烧录
    burn_dialogue_audio: !!s.dialogue_burn || (structured && s.voice_source === 'dubbed'),
    watermark_text: watermark,
    ...(structured
      ? {
          dialogue_subtitles: !!s.dialogue_subtitles,
          cards: !!s.cards,
          review_sheets: !!s.review_sheets,
          bgm: bgmUrl ? { url: bgmUrl, volume_db: s.bgm.volume_db } : undefined,
        }
      : {}),
  }
}

/** 创作页：改一项只写本集覆盖；value 为 null 表示恢复随项目 */
export function saveEpisodeSetting(api, episodeId, key, value) {
  return api.saveEpisodeVideoSettings(episodeId, { [key]: value })
}

/** 项目详情页：改项目默认；value 为 null 表示回到默认值 */
export function saveProjectSetting(api, dramaId, key, value) {
  return api.saveVideoSettings(dramaId, { [key]: value })
}

const hasImage = (e) => !!(e && (e.image_url || e.local_path || e.four_view_image_url || e.head_local_path || e.body_local_path))

/** 项目下是否已有生成素材：任意角色/场景/道具图或分镜视频 */
export function hasGeneratedAssets(drama) {
  if (!drama) return false
  if ([drama.characters, drama.scenes, drama.props].some(list => (list || []).some(hasImage))) return true
  return (drama.episodes || []).some(ep => (ep.storyboards || []).some(sb => !!sb.video_url))
}

/** 改画面比例或风格时的提示；没有生成素材返回空串 */
export function assetMismatchNotice(drama) {
  return hasGeneratedAssets(drama)
    ? '项目里已有生成的角色/场景/道具图或分镜视频，它们不会随新的画面比例或风格重新生成，与之后生成的内容可能不一致。'
    : ''
}
