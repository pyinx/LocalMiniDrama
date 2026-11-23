import request from '@/utils/request'

/** 资产变体：wardrobe（角色造型）/ scene_state（场景状态）/ prop_state（道具状态） */
const PATHS = {
  wardrobe: { parent: (id) => `/characters/${id}/wardrobes`, item: (id) => `/wardrobes/${id}` },
  scene_state: { parent: (id) => `/scenes/${id}/states`, item: (id) => `/scene-states/${id}` },
  prop_state: { parent: (id) => `/props/${id}/states`, item: (id) => `/prop-states/${id}` },
}

export const variantsAPI = {
  list(kind, parentId) {
    return request.get(PATHS[kind].parent(parentId))
  },
  create(kind, parentId, data) {
    return request.post(PATHS[kind].parent(parentId), data)
  },
  update(kind, id, data) {
    return request.put(PATHS[kind].item(id), data)
  },
  remove(kind, id) {
    return request.delete(PATHS[kind].item(id))
  },
  generateImage(kind, id, body = {}) {
    return request.post(`${PATHS[kind].item(id)}/generate-image`, body)
  },
  /** 按本集剧本提议场景状态与造型（只返回提议，不创建） */
  propose(episodeId) {
    return request.post(`/episodes/${episodeId}/asset-states/propose`, {})
  },
}
