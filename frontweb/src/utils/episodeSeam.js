export function steppedUs(us, step, fps) {
  const [n,d] = fps.split('/').map(Number)
  return Math.round((Math.round(us * n / (1e6*d)) + step) * 1e6*d/n)
}

export function comparisonTime(anchor, next, duration, fps) {
  if (!anchor) return 0
  const [n,d] = fps.split('/').map(Number)
  const t = next.seam + (anchor.us - (anchor.point === 'out' ? next.out_us : next.in_us)) / 1e6
  if (anchor.point === 'out') return Math.max(0, Math.min(t,next.seam - d/n))
  return Math.max(next.seam, Math.min(t,duration - d/n))
}

export function playheadSourceUs(point,clip,seconds) {
  const delta = Math.round((seconds - clip.seam)*1e6)
  if (point === 'out') return delta <= 0 ? clip.out_us + delta : null
  return delta >= 0 ? clip.in_us + delta : null
}
