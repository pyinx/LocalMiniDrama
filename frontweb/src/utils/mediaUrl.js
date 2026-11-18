/** 统一媒体 URL：优先 local_path，其次 image_url / video_url */
export function assetImageUrl(item) {
  if (!item) return ''
  const lp = item.local_path && String(item.local_path).trim()
  if (lp) return '/static/' + lp.replace(/^\//, '')
  return item.image_url || ''
}

export function storyboardImageUrl(sb) {
  if (!sb) return ''
  return assetImageUrl(sb)
}

export function storyboardVideoUrl(sb) {
  if (!sb) return ''
  if ('resolved_video' in sb) {
    const v = sb.resolved_video
    return v?.local_path ? '/static/' + v.local_path.replace(/^\//, '') : v?.video_url || ''
  }
  const lp = sb.video_local_path && String(sb.video_local_path).trim()
  if (lp) return '/static/' + lp.replace(/^\//, '')
  return sb.video_url || ''
}

export function previousStoryboard(boards, currentId) {
  const index = boards.findIndex(board => board.id === currentId)
  return index > 0 ? boards[index - 1] : null
}

/** Read the adopted take at dispatch time, including completed shots skipped by the batch. */
export async function previousTakeUrl(boards, currentId, loadBoard) {
  const previous = previousStoryboard(boards, currentId)
  return previous ? storyboardVideoUrl(await loadBoard(previous.id)) : ''
}

export function audioUrl(localPath) {
  if (!localPath) return ''
  const p = String(localPath).trim()
  if (!p) return ''
  return '/static/' + p.replace(/^\//, '')
}
