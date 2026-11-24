/** 画面比例选项：项目详情页的下拉与创作页的只读展示共用 */
export const ASPECT_RATIO_OPTIONS = [
  { value: '16:9', label: '16:9 横屏（默认）' },
  { value: '9:16', label: '9:16 竖屏（短视频）' },
  { value: '3:4', label: '3:4 竖版' },
  { value: '1:1', label: '1:1 方形' },
  { value: '4:3', label: '4:3 传统横屏' },
  { value: '21:9', label: '21:9 宽银幕' },
]

export function aspectRatioLabel(value) {
  return ASPECT_RATIO_OPTIONS.find(o => o.value === value)?.label || value || ''
}
