import request from '@/utils/request'

export const videoMergesAPI = {
  /** 合成记录（按创建时间倒序）；post_info 为结构化后期结果（字幕方式、审片拼图、告警） */
  list(params) {
    return request.get('/video-merges', { params: params || {} })
  },
}
