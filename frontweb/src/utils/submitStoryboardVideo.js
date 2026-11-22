/** 只在用户确认后重提一次。采用时校验原稿，保留其他窗口已保存的修改。 */
export async function submitStoryboardVideo(body, savedDraft, { create, review, adopt }) {
  try {
    return await create(body)
  } catch (error) {
    const issue = error.response?.data?.error
    if (error.response?.status !== 409 || issue?.code !== 'storyboard_review_needed' || !issue.details?.draft) throw error
    const { draft, action, result } = issue.details
    if (!await review(issue.details)) return null
    const saved = await adopt(draft, { universal_segment_text: savedDraft, action, result })
    return create({ ...body, prompt: saved })
  }
}
