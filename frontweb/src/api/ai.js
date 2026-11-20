import request from '@/utils/request'

let activeVideoConfig
let activeVideoConfigAt = 0

export function invalidateActiveVideoAiConfigCache() {
  activeVideoConfig = null
  activeVideoConfigAt = 0
}

export async function getActiveVideoAiConfig() {
  if (activeVideoConfig && Date.now() - activeVideoConfigAt < 15000) return activeVideoConfig
  try {
    const rows = await aiAPI.list('video')
    const active = (Array.isArray(rows) ? rows : []).filter(c => c.is_active !== false)
    activeVideoConfig = active.find(c => c.is_default) || active[0] || null
    activeVideoConfigAt = Date.now()
  } catch { activeVideoConfig = null }
  return activeVideoConfig
}

export const aiAPI = {
  list(serviceType) {
    return request.get('/ai-configs', { params: serviceType ? { service_type: serviceType } : {} })
  },
  get(id) {
    return request.get(`/ai-configs/${id}`)
  },
  create(body) {
    return request.post('/ai-configs', body)
  },
  update(id, body) {
    return request.put(`/ai-configs/${id}`, body)
  },
  delete(id) {
    return request.delete(`/ai-configs/${id}`)
  },
  testConnection(body) {
    return request.post('/ai-configs/test', body)
  },
  listWanVideoModels(baseUrl, apiKey) {
    return request.post('/ai-configs/wan-video-models', { base_url: baseUrl, api_key: apiKey })
  },
  /** 即梦2角色认证：GET /api/business/v1/assets（body: base_url, api_key, limit?, cursor?） */
  listJimeng2MaterialAssets(body) {
    return request.post('/ai-configs/jimeng2-list-assets', body)
  },
  /** ModelArk 私有资产库：action + payload，见 AI 配置页 SD2 资产管理 */
  modelArkAsset(body) {
    return request.post('/ai-configs/model-ark-asset', body)
  },
  getVendorLock() {
    return request.get('/ai-configs/vendor-lock')
  },
  bulkUpdateKey(apiKey) {
    return request.put('/ai-configs/bulk-update-key', { api_key: apiKey })
  }
}
