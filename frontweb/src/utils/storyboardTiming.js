export function pipelineClipRange(metadata) {
  const range = metadata?.pipeline_clip_range
  if (range && Number.isInteger(range.min) && Number.isInteger(range.max) &&
      range.min >= 1 && range.min <= range.max && range.max <= 120) {
    return { min: range.min, max: range.max }
  }
  return { min: 4, max: 15 }
}

export function storyboardTiming(count, total, pipelineRange) {
  const timing = {}
  if (Number.isInteger(count) && count > 0) timing.storyboard_count = count
  if (Number.isInteger(total) && total > 0) timing.video_duration = total
  if (pipelineRange) timing.clip_duration_range = { ...pipelineRange }
  return timing
}
