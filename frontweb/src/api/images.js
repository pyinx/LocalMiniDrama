import { checkStyleModel } from './stylePreflight'
import request from '@/utils/request'

export const imagesAPI = {
  list(params) {
    return request.get('/images', { params: params || {} })
  },
  async create(data) {
    await checkStyleModel(data.storyboard_id ? 'frame' : 'image', data.drama_id, data.model)
    return request.post('/images', data)
  },
  upload(data) {
    return request.post('/images/upload', data)
  },
  delete(id) {
    return request.delete(`/images/${id}`)
  }
}
