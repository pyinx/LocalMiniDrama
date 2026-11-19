import catalog from '../../../backend-node/src/constants/styleCatalog.json' with { type: 'json' }

export const CUSTOM_STYLE_VALUE = 'custom'
export const generationStyleOptions = catalog

export function searchStyleGroups(groups, search) {
  const query = String(search || '').trim().toLowerCase()
  if (!query) return groups
  return groups.map(group => ({ ...group, options: group.options.filter(option =>
    [option.label, option.value, ...(option.aliases || []), ...(option.tags || [])].some(term => term.toLowerCase().includes(query)))
  })).filter(group => group.options.length)
}

/**
 * 根据 value 查找风格选项对象
 * @param {string} val
 * @returns {object|null}
 */
export function findStyleOption(val) {
  for (const group of generationStyleOptions) {
    const found = group.options.find(o => o.value === val)
    if (found) return found
  }
  return null
}

/**
 * 获取传给图像/视频 AI 用的英文 prompt（效果最好）
 * @param {string} val - 风格 value
 * @returns {string|undefined}
 */
export function getStylePromptEn(val) {
  const v = (val || '').toString().trim()
  if (!v) return undefined
  // 无第二参数时无法拿到用户描述；勿把短标识 custom 当提示词
  if (v === CUSTOM_STYLE_VALUE) return undefined
  const opt = findStyleOption(v)
  if (opt) return opt.promptEn || opt.prompt || v
  return v
}

/**
 * 获取中文风格描述（用于界面展示或中文场景提示词拼接）
 * @param {string} val - 风格 value
 * @returns {string|undefined}
 */
export function getStylePromptZh(val) {
  const v = (val || '').toString().trim()
  if (!v) return undefined
  if (v === CUSTOM_STYLE_VALUE) return undefined
  const opt = findStyleOption(v)
  if (opt) return opt.prompt || opt.promptEn || v
  return v
}

/**
 * 保存剧集 metadata 时用：与后端约定字段 style_prompt_zh / style_prompt_en。
 * 未选风格时返回空串，写入后可覆盖旧 metadata 中的画风字段。
 * 自定义画风（custom）时第二参数为用户描述，zh/en 写入同一文本。
 */
export function stylePromptMetadataForSave(styleValue, customPrompt, snapshot, prior) {
  const v = (styleValue || '').toString().trim()
  if (v && prior?.style === v) {
    const meta = prior.metadata || {}
    const sameCustom = !snapshot || (snapshot.id === meta.custom_style?.id && snapshot.version === meta.custom_style?.version)
    const keep = v !== CUSTOM_STYLE_VALUE || (sameCustom && String(customPrompt || '').trim() === String(meta.style_prompt_zh || meta.style_prompt_en || '').trim())
    if (keep && (meta.style_prompt_zh || meta.style_prompt_en)) {
      return { style_prompt_zh: meta.style_prompt_zh || '', style_prompt_en: meta.style_prompt_en || '',
        ...(v === CUSTOM_STYLE_VALUE && snapshot ? { custom_style: snapshot } : {}) }
    }
  }
  if (!v) return { style_prompt_zh: '', style_prompt_en: '' }
  if (v === CUSTOM_STYLE_VALUE) {
    const text = (customPrompt != null ? String(customPrompt) : '').trim()
    return { style_prompt_zh: text, style_prompt_en: text, ...(snapshot ? { custom_style: snapshot } : {}) }
  }
  const opt = findStyleOption(v)
  if (!opt) return { style_prompt_zh: v, style_prompt_en: v }
  return {
    style_prompt_zh: opt.prompt || opt.promptEn || '',
    style_prompt_en: opt.promptEn || opt.prompt || '',
  }
}

/** 列表/触发器展示用中文名 */
export function getStyleLabel(val) {
  const v = (val || '').toString().trim()
  if (!v) return ''
  if (v === CUSTOM_STYLE_VALUE) return '自定义'
  const opt = findStyleOption(v)
  return opt?.label || v
}

/**
 * 旧项目只有 dramas.style（value）而 metadata 里没有画风长文案时，自动 saveOutline 合并写入，
 * 便于后端 mergeCfgStyleWithDrama 能拿到 default_style_en。不覆盖已有 style_prompt_en。
 * @returns {Promise<object>} 更新后的剧集对象（失败或未改则原样返回 drama）
 */
export async function backfillDramaStylePromptMetadataIfNeeded(dramaAPI, dramaId, drama) {
  if (!drama || dramaId == null) return drama
  const styleVal = (drama.style || '').toString().trim()
  if (!styleVal) return drama
  if (styleVal === CUSTOM_STYLE_VALUE) return drama
  if ([drama.metadata?.style_prompt_en, drama.metadata?.style_prompt_zh].some(text => String(text || '').trim())) return drama
  const patch = stylePromptMetadataForSave(styleVal)
  if (!(patch.style_prompt_en || '').toString().trim()) return drama
  try {
    await dramaAPI.saveOutline(dramaId, { metadata: patch })
    return await dramaAPI.get(dramaId)
  } catch (_) {
    return drama
  }
}
