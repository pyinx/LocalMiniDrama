import request from '@/utils/request'
import { ElMessageBox } from 'element-plus'

const accepted = new Set()
const pending = new Map()

export async function checkStyleModel(kind, id, model, config) {
  if (!Number(id)) return
  const result = await request.get('/style-library/preflight', { ...config, params: { kind, id, model } })
  if (!result.warn) return
  const key = JSON.stringify([result.project, result.style, result.version, result.negative, result.model])
  if (accepted.has(key)) return
  if (!pending.has(key)) {
    const confirmation = ElMessageBox.confirm(
      `「${result.model}」的独立反向词能力尚未验证。继续生成将仅使用「${result.style}」的正向描述。`,
      '画风提示词', { confirmButtonText: '使用正向词继续', cancelButtonText: '返回选择模型' }
    ).then(() => accepted.add(key)).catch(() => { throw new Error('已取消本次生成') }).finally(() => pending.delete(key))
    pending.set(key, confirmation)
  }
  await pending.get(key)
}
