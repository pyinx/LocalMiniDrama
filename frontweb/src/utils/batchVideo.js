/** A resumed batch already owns an operation key. Only a waiting item needs new inputs. */
export function dispatchBatchVideo(item, buildBody, create) {
  if (!item?.operation_key) throw new Error('找不到本镜的批次操作，请重新载入')
  if (item.video_id || item.status === 'completed') {
    if (item.status === 'failed' || item.dispatch_state === 'unknown') {
      throw new Error(item.error_msg || '本次生成需要核查，可在分镜中查看后重拍')
    }
    return { ...item, id: item.video_id }
  }
  return create({ ...buildBody(), operation_key: item.operation_key })
}
