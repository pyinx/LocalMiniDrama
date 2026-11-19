import { checkStyleModel } from './stylePreflight'
import request from '@/utils/request'
import { dispatchBatchVideo } from '@/utils/batchVideo'

export const videosAPI = {
  list(params) {
    return request.get('/videos', { params: params || {} })
  },
  /** 创建单条分镜视频生成任务，body: { drama_id, storyboard_id, prompt, image_url?, model?, ... } */
  async create(body) {
    if (body.storyboard_id) await checkStyleModel('video', body.drama_id, body.model)
    if (body.operation_key) return request.post('/videos', body)
    if (!body.storyboard_id) return request.post('/videos', body)
    const slot = 'video-submit:' + body.drama_id + ':' + body.storyboard_id
    const key = localStorage.getItem(slot) || Array.from(crypto.getRandomValues(new Uint32Array(4)), x => x.toString(16).padStart(8, '0')).join('')
    localStorage.setItem(slot, key)
    try {
      const item = await request.post('/videos', { ...body, operation_key: key })
      if (localStorage.getItem(slot) === key) localStorage.removeItem(slot)
      return item
    } catch (err) {
      if (err.response?.status >= 400 && err.response.status < 500 && localStorage.getItem(slot) === key) localStorage.removeItem(slot)
      throw err
    }
  },
  openBatch(episodeId, storyboardIds = []) {
    return request.post(`/videos/episode/${episodeId}/batch`, { storyboard_ids: storyboardIds })
  },
  async fillMissing(episodeId, body) {
    const items = await this.openBatch(episodeId, [body.storyboard_id])
    const item = items.find(i => i.storyboard_id === body.storyboard_id)
    return dispatchBatchVideo(item, () => body, data => this.create(data))
  },
  /** 失败后复用已存上游 task 继续轮询，返回 video_generations 记录（含 task_id） */
  resumePoll(id) {
    return request.post(`/videos/${id}/resume-poll`)
  },
}
