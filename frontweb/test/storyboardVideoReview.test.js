import test from 'node:test'
import assert from 'node:assert/strict'
import { ElMessage } from 'element-plus'
import request from '../src/utils/request.js'
import { submitStoryboardVideo } from '../src/utils/submitStoryboardVideo.js'

const body = { storyboard_id: 40, prompt: '编辑中的描述', reference_image_urls: ['图1'] }
const details = { action: '抱紧纸箱', result: '箱沿变形', draft: '将用于生成的描述' }
const blocked = { response: { status: 409, data: { error: { code: 'storyboard_review_needed', details } } } }

test('a handled submission error reaches the page without an extra toast; ordinary requests still notify', async t => {
  const toast = t.mock.method(ElMessage, 'error', () => {})
  const adapter = async config => {
    throw Object.assign(new Error('HTTP 409'), { config, response: {
      status: 409, data: { error: { code: 'storyboard_review_needed', message: '请确认片段描述', details } },
    } })
  }
  for (const config of [{ showErrorMessage: false }, {}]) {
    await assert.rejects(request.post('/videos', body, { adapter, ...config }),
      error => error.message === '请确认片段描述' && error.response.data.error.details === details)
    assert.equal(toast.mock.callCount(), config.showErrorMessage === false ? 0 : 1)
  }
})

test('only explicit approval adopts the displayed draft and resubmits once with the saved text', async () => {
  for (const approved of [false, true]) {
    const submissions = []
    const adoptions = []
    let reviews = 0
    const result = await submitStoryboardVideo(body, '原稿', {
      create: async data => {
        submissions.push(data)
        if (submissions.length === 1) throw blocked
        return { id: 12 }
      },
      review: async shown => { reviews++; assert.deepEqual(shown, details); return approved },
      adopt: async (draft, expected) => {
        adoptions.push({ draft, expected })
        return '保存后的描述'
      },
    })
    assert.equal(reviews, 1)
    assert.deepEqual(adoptions, approved ? [{ draft: details.draft, expected: {
      universal_segment_text: '原稿', action: details.action, result: details.result,
    } }] : [])
    assert.deepEqual(submissions, approved ? [body, { ...body, prompt: '保存后的描述' }] : [body])
    assert.deepEqual(result, approved ? { id: 12 } : null)
  }
})

test('unrelated errors, concurrent edits and another rejection never trigger an automatic retry loop', async () => {
  const conflict = new Error('描述已更新')
  for (const stage of ['submit', 'adopt', 'retry']) {
    let submissions = 0
    let reviews = 0
    await assert.rejects(() => submitStoryboardVideo(body, null, {
      create: async () => { submissions++; throw stage === 'submit' ? conflict : blocked },
      review: async () => { reviews++; return true },
      adopt: async () => { if (stage === 'adopt') throw conflict; return details.draft },
    }), error => error === (stage === 'retry' ? blocked : conflict))
    assert.equal(submissions, stage === 'retry' ? 2 : 1)
    assert.equal(reviews, stage === 'submit' ? 0 : 1)
  }
})
