const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const videoClient = require('../src/services/videoClient');
const aiConfigService = require('../src/services/aiConfigService');

const originalListConfigs = aiConfigService.listConfigs;
const originalFetch = global.fetch;
const noopLog = { info() {}, warn() {}, error() {}, debug() {} };
const WAN_MODELS = ['wan2.6-t2v', 'wanx2.1-vace-plus', 'wan2.6-r2v-flash'];

let sentBody;
let fetchCalls;
let storageDir;

beforeEach(() => {
  aiConfigService.listConfigs = () => [{
    id: 1, service_type: 'video', is_active: true, is_default: true,
    provider: 'dashscope', api_protocol: 'dashscope',
    base_url: 'https://dashscope.aliyuncs.com', api_key: 'k',
    model: WAN_MODELS, default_model: 'wan2.6-t2v',
  }];
  sentBody = null;
  fetchCalls = 0;
  global.fetch = async (url, options) => {
    fetchCalls++;
    sentBody = JSON.parse(options.body);
    return { ok: true, status: 200, text: async () => JSON.stringify({ output: { task_id: 't1', task_status: 'PENDING' } }), json: async () => ({ output: { task_id: 't1', task_status: 'PENDING' } }) };
  };
  storageDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wan-refs-'));
  fs.writeFileSync(path.join(storageDir, 'a.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]));
});

afterEach(() => {
  aiConfigService.listConfigs = originalListConfigs;
  global.fetch = originalFetch;
  fs.rmSync(storageDir, { recursive: true, force: true });
});

function call(model, extra) {
  return videoClient.callVideoApi(null, noopLog, {
    prompt: 'p', model, duration: 5,
    files_base_url: 'http://localhost:5679/static',
    storage_local_path: storageDir,
    ...extra,
  });
}

function assertUsableImages(list, expectedCount) {
  assert.ok(Array.isArray(list), 'image list present');
  assert.equal(list.length, expectedCount);
  for (const v of list) {
    assert.equal(typeof v, 'string', 'each reference is a string, not ' + JSON.stringify(v));
    assert.ok(/^https?:\/\//.test(v) || v.startsWith('data:image/'), 'usable image input: ' + v.slice(0, 40));
  }
}

describe('Wan DashScope reference images (AC21)', () => {
  it('vace sends resolved reference images', async () => {
    await call('wanx2.1-vace-plus', {
      reference_urls: ['http://localhost:5679/static/a.png', 'https://cdn.example.com/b.jpg'],
    });
    assertUsableImages(sentBody.input.ref_images_url, 2);
    assert.ok(sentBody.input.ref_images_url[0].startsWith('data:image/png;base64,'));
    assert.equal(sentBody.input.ref_images_url[1], 'https://cdn.example.com/b.jpg');
  });

  it('r2v sends resolved reference images', async () => {
    await call('wan2.6-r2v-flash', {
      reference_urls: ['http://localhost:5679/static/a.png', 'https://cdn.example.com/b.jpg', 'https://cdn.example.com/c.jpg'],
    });
    assertUsableImages(sentBody.input.reference_urls, 3);
    assert.ok(sentBody.input.reference_urls[0].startsWith('data:image/png;base64,'));
  });

  it('errors without references', async () => {
    const r1 = await call('wanx2.1-vace-plus', { reference_urls: [] });
    const r2 = await call('wan2.6-r2v-flash', { reference_urls: [] });
    assert.ok(r1.error);
    assert.ok(r2.error);
    assert.equal(fetchCalls, 0);
  });
});

describe('Wan DashScope size follows aspect ratio (AC22)', () => {
  it('portrait ratio yields portrait size', async () => {
    await call('wan2.6-t2v', { aspect_ratio: '9:16' });
    assert.equal(sentBody.parameters.size, '720*1280');
    await call('wanx2.1-vace-plus', { aspect_ratio: '9:16', reference_urls: ['https://cdn.example.com/b.jpg'] });
    assert.equal(sentBody.parameters.size, '720*1280');
  });

  it('landscape ratio keeps 1280x720', async () => {
    await call('wan2.6-t2v', { aspect_ratio: '16:9' });
    assert.equal(sentBody.parameters.size, '1280*720');
    await call('wanx2.1-vace-plus', { aspect_ratio: '16:9', reference_urls: ['https://cdn.example.com/b.jpg'] });
    assert.equal(sentBody.parameters.size, '1280*720');
  });

  it('unsupported ratio rejected before request', async () => {
    const r = await call('wan2.6-t2v', { aspect_ratio: '21:9' });
    assert.ok(r.error);
    assert.match(r.error, /21:9/);
    assert.equal(fetchCalls, 0);
  });

  it('r2v portrait size', async () => {
    await call('wan2.6-r2v-flash', { aspect_ratio: '9:16', reference_urls: ['https://cdn.example.com/b.jpg'] });
    assert.equal(sentBody.parameters.size, '720*1280');
  });
});
