/**
 * 状态资产（场景状态、角色造型）的采纳与出图：提议弹窗和一键全流程共用。
 * api 为 variantsAPI（create / list / generateImage），以参数传入便于测试。
 */

function errorText(e) {
  return e?.response?.data?.error?.message || e?.response?.data?.message || e?.message || String(e)
}

/** 按提议创建场景状态与造型（不出图）；单项失败不影响其他项 */
export async function createStateProposals(api, proposal) {
  const created = []
  const errors = []
  for (const s of proposal?.scene_states || []) {
    const label = `${s.scene_name || '场景'}·${s.name}`
    try {
      const row = await api.create('scene_state', s.scene_id, { name: s.name, kind: 'state', state_phrase: s.state_phrase })
      created.push({ kind: 'scene_state', id: row?.id, label })
    } catch (e) {
      errors.push(`${label}：${errorText(e)}`)
    }
  }
  for (const w of proposal?.wardrobes || []) {
    const label = `${w.character_name || '角色'}·${w.name}`
    try {
      const row = await api.create('wardrobe', w.character_id, { name: w.name, change_phrase: w.change_phrase, episode_range: w.episode_range || null })
      created.push({ kind: 'wardrobe', id: row?.id, label })
    } catch (e) {
      errors.push(`${label}：${errorText(e)}`)
    }
  }
  return { created: created.filter((v) => v.id != null), errors }
}

function coversEpisode(range, episodeNumber) {
  if (!Array.isArray(range) || !range.length || !Number.isFinite(Number(episodeNumber))) return false
  const from = Number(range[0])
  const to = Number(range[1] ?? range[0])
  return from <= Number(episodeNumber) && Number(episodeNumber) <= to
}

/**
 * 本集还没有图的场景状态与造型：只取时段光线版本（不含竖屏主机位、反打），
 * 以及起止集包含本集的造型；其他集或没定集数的造型由作者自己决定何时出图。
 */
export async function listVariantsWithoutImage(api, { scenes = [], characters = [], episodeNumber }) {
  const out = []
  for (const scene of scenes) {
    for (const v of (await api.list('scene_state', scene.id)) || []) {
      if (!v.image_url && (v.kind || 'state') === 'state') out.push({ kind: 'scene_state', id: v.id, label: `${scene.location || '场景'}·${v.name}` })
    }
  }
  for (const c of characters) {
    for (const v of (await api.list('wardrobe', c.id)) || []) {
      if (!v.image_url && coversEpisode(v.episode_range, episodeNumber)) out.push({ kind: 'wardrobe', id: v.id, label: `${c.name || '角色'}·${v.name}` })
    }
  }
  return out
}

/** 逐项提交出图（后台生成），返回各项任务 id 与失败项 */
export async function startVariantImages(api, variants) {
  const started = []
  const errors = []
  for (const v of variants) {
    try {
      const gen = await api.generateImage(v.kind, v.id)
      started.push({ ...v, task_id: gen?.task_id ?? null })
    } catch (e) {
      errors.push(`${v.label}：${errorText(e)}`)
    }
  }
  return { started, errors }
}
