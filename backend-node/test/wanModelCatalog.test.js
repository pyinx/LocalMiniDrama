const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { once } = require('node:events');
const { openWorkbench } = require('./helpers/workbenchHttp');

test('万相目录按当前网关逐页发现视频模型，刷新反映上下架，查询不修改配置', async t => {
  const { request, url } = await openWorkbench(t);
  const video = model => ({ model, provider: 'wan', capabilities: ['VG'] });
  let pages = [
    [video('wan3.0-video'), video('wan-future'), { ...video('other-video'), provider: 'other' }],
    [video('wan3.0-video'), { ...video('wan-image'), capabilities: ['IG'] }],
  ];
  const requests = [];
  let status = 200;
  const upstream = http.createServer((req, res) => {
    const target = new URL(req.url, 'http://localhost');
    requests.push({ target, auth: req.headers.authorization });
    const page = Number(target.searchParams.get('page_no'));
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      success: status === 200,
      output: { page_no: page, total: pages.flat().length, models: pages[page - 1] || [] },
    }));
  }).listen(0, '127.0.0.1');
  await once(upstream, 'listening');
  t.after(() => new Promise(resolve => upstream.close(resolve)));
  const credentials = { base_url: 'http://127.0.0.1:' + upstream.address().port + '/api/v1/', api_key: 'test-key' };
  const route = '/ai-configs/wan-video-models';
  await request('POST', '/ai-configs', {
    ...credentials, service_type: 'video', provider: 'dashscope', name: '已有配置',
    model: ['previously-saved'], default_model: 'previously-saved', is_default: true,
  });
  const before = await request('GET', '/ai-configs?service_type=video');
  assert.deepEqual(await request('POST', route, credentials), [
    { id: 'wan3.0-video', supported: true }, { id: 'wan-future', supported: false },
  ]);
  assert.deepEqual(requests.map(r => r.target.searchParams.get('page_no')), ['1', '2']);
  for (const { target, auth } of requests) {
    assert.equal(target.pathname, '/api/v1/models');
    assert.equal(target.searchParams.get('providers'), 'wan');
    assert.equal(target.searchParams.get('capabilities'), 'VG');
    assert.equal(auth, 'Bearer ' + credentials.api_key);
  }
  pages = [[video('wan2.7-r2v')]];
  const compatibleBase = credentials.base_url.replace('/api/v1/', '/gateway/compatible-mode/v1/');
  assert.deepEqual(await request('POST', route, { ...credentials, base_url: compatibleBase }), [{ id: 'wan2.7-r2v', supported: true }]);
  assert.equal(requests.at(-1).target.pathname, '/gateway/api/v1/models');
  pages = [[]];
  assert.deepEqual(await request('POST', route, credentials), []);
  pages = [[], [video('unreachable')]];
  const post = body => fetch(url(route), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  assert.equal((await post(credentials)).ok, false);
  status = 401;
  const rejected = await post(credentials);
  assert.equal(rejected.ok, false);
  assert.match((await rejected.json()).error.message, /401/);
  const calls = requests.length;
  assert.equal((await post({ ...credentials, api_key: '' })).status, 400);
  assert.equal((await post({ ...credentials, base_url: 'invalid' })).status, 400);
  assert.equal(requests.length, calls);
  assert.deepEqual(await request('GET', '/ai-configs?service_type=video'), before);
});
