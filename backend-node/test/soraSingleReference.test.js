const { test } = require('node:test');
const assert = require('node:assert/strict');
const { openWorkbench } = require('./helpers/workbenchHttp');
const { callVideoApi } = require('../src/services/videoClient');

test('现有 Sora 配置关闭全能多图后，分镜参考图以单个文件提交', async (t) => {
  const { db, request } = await openWorkbench(t);
  const model = 'minimax-h3-original';
  const settings = JSON.stringify({ supports_universal_omni: true });
  const config = await request('POST', '/ai-configs', {
    service_type: 'video', name: 'MiniMax H3', provider: 'openai', api_protocol: 'sora',
    base_url: 'http://sora.test/minimax-h3/v1', endpoint: '/videos',
    api_key: 'test', model: [model], is_default: true, settings,
  });
  const resource = '/ai-configs/' + config.id;
  await request('PUT', resource, { default_model: model });
  assert.equal((await request('GET', resource)).settings, settings);
  await request('PUT', resource, { settings: null });
  assert.equal((await request('GET', resource)).settings, null);

  const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aV1sAAAAASUVORK5CYII=';
  // 生成服务对带参考图列表的普通分镜仅传 reference_urls。
  let submitted;
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    submitted = new Request(url, init);
    return Response.json({ id: 'local-task' });
  });
  const result = await callVideoApi(db, { info() {}, warn() {}, error() {} }, {
    model, prompt: '镜头推进', reference_urls: [png], aspect_ratio: '9:16', duration: 5,
  });
  assert.equal(result.task_id, 'local-task');
  assert.equal(submitted.method, 'POST');
  assert.equal(submitted.url, 'http://sora.test/minimax-h3/v1/videos');
  assert.match(submitted.headers.get('content-type'), /^multipart\/form-data;/);
  const body = await submitted.formData();
  assert.equal(body.get('model'), model);
  assert.equal(body.get('seconds'), '5');
  assert.equal(body.has('images'), false);
  assert.equal(body.getAll('input_reference').length, 1);
  assert.ok(body.get('input_reference').size > 0);

  submitted = undefined;
  const missing = await callVideoApi(db, { info() {}, warn() {}, error() {} }, {
    model, prompt: '镜头推进', reference_urls: ['/static/missing.png'],
  });
  assert.equal(missing.submission, 'rejected');
  assert.equal(submitted, undefined);
});

test('Sora 提交按模型处理时长，并对网关 HTML 错误给出可读原因', async (t) => {
  const { db, request } = await openWorkbench(t);
  const models = ['minimax-h3-fast', 'sora-2'];
  await request('POST', '/ai-configs', {
    service_type: 'video', name: 'Sora', provider: 'openai', api_protocol: 'sora',
    base_url: 'http://sora.test/v1', endpoint: '/videos', api_key: 'test', model: models,
  });
  const durations = [];
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    const fields = await new Request(url, init).formData();
    durations.push(fields.get('seconds'));
    return new Response('<html><title>400</title></html>', { status: 400 });
  });
  for (const model of models) {
    const result = await callVideoApi(db, { info() {}, warn() {}, error() {} }, {
      model, prompt: '镜头推进', duration: 5,
    });
    assert.equal(result.submission, 'rejected');
    assert.match(result.error, /Sora 视频创建失败.*400.*HTML/);
  }
  assert.deepEqual(durations, ['5', '8']);
});
