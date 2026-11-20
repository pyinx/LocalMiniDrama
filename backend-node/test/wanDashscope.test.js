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
const WAN_MODELS = ['wan2.6-t2v', 'wanx2.1-vace-plus', 'wan2.6-r2v-flash', 'wan2.2-kf2v-flash'];

let sentBody;
WAN_MODELS.push('wan3.0-video', 'wan3.0-video-prime', 'wan2.7-r2v', 'wan2.7-t2v', 'wan2.7-i2v');

describe('Wan 2.7 and 3.0 image-based storyboard contracts', () => {
  const refs = ['https://cdn.example.com/scene.jpg', 'https://cdn.example.com/actor.png'];
  it('accepts a native API base for both default and customized query paths', () => {
    for (const query_endpoint of [undefined, '/api/v1/tasks/{taskId}', '/tasks/{taskId}']) {
      const cfg = { provider: 'dashscope', base_url: 'https://example.com/api/v1/', query_endpoint };
      assert.equal(videoClient.buildQueryUrl(cfg, 't1'), 'https://example.com/api/v1/tasks/t1');
    }
  });
  for (const model of ['wan2.7-r2v', 'wan3.0-video', 'wan3.0-video-prime']) {
    it(model + ' preserves references, portrait size and six seconds', async () => {
      const r = await call(model, { prompt: '@图片2 走入@图片1', reference_urls: refs,
        duration: 6, resolution: '720p', aspect_ratio: '9:16', generate_audio: true, seed: 0 });
      assert.equal(r.task_id, 't1', r.error);
      assert.deepEqual(sentBody.input.media, refs.map(url => ({ type: 'reference_image', url })));
      assert.equal(sentBody.input.prompt, '图2 走入图1');
      assert.equal(sentBody.parameters.duration, 6);
      assert.equal(sentBody.parameters.resolution, '720P');
      assert.equal(sentBody.parameters.ratio, '9:16');
      assert.equal(sentBody.parameters.seed, 0);
      assert.equal(sentBody.parameters.audio, model.startsWith('wan3.') ? true : undefined);
    });
  }
});
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

describe('Wan legacy first-frame video specifications', () => {
  const first = 'https://cdn.example.com/first.png';
  const last = 'https://cdn.example.com/last.png';

  it('sends each selected resolution and only an explicitly provided tail', async () => {
    for (const resolution of ['480p', '720p', '1080p']) {
      await call('wan2.2-kf2v-flash', { first_frame_url: first, resolution });
      assert.equal(sentBody.parameters.resolution, resolution.toUpperCase());
      assert.equal(sentBody.input.first_frame_url, first);
      assert.equal(Object.hasOwn(sentBody.input, 'last_frame_url'), false);
    }
    await call('wan2.2-kf2v-flash', { first_frame_url: first, last_frame_url: last });
    assert.equal(sentBody.parameters.resolution, '720P');
    assert.equal(sentBody.input.last_frame_url, last);
  });

  it('rejects unsupported duration or resolution without dispatching', async () => {
    const badDuration = await call('wan2.2-kf2v-flash', { first_frame_url: first, duration: 6 });
    assert.match(badDuration.error, /5 秒/);
    const badResolution = await call('wan2.2-kf2v-flash', { first_frame_url: first, resolution: '2160p' });
    assert.match(badResolution.error, /分辨率/);
    assert.equal(fetchCalls, 0);
  });
});

describe('Wan DashScope reference images (AC21)', () => {
  it('vace sends resolved reference images', async () => {
    for (const count of [1, 2, 3]) {
      const refs = Array.from({ length: count }, (_, i) => 'https://cdn.example.com/' + i + '.png');
      const roles = refs.map((_, i) => i === 0 ? 'bg' : 'obj');
      await call('wanx2.1-vace-plus', { reference_urls: refs, reference_roles: roles });
      assertUsableImages(sentBody.input.ref_images_url, count);
      assert.deepEqual(sentBody.parameters.obj_or_bg, roles);
      assert.deepEqual(sentBody.input.ref_images_url, refs);
      assert.equal(sentBody.input.function, 'image_reference');
    }
  });

  it('2.6 uploads a local reference to temporary OSS and preserves reference order', async () => {
    const requests = [];
    const model = 'wan2.6-r2v-flash';
    global.fetch = async (url, options) => {
      requests.push({ url: String(url), ...options });
      if (requests.length === 1) return Response.json({ data: { upload_host: 'https://oss.example.com',
        upload_dir: 'temporary', policy: 'policy', signature: 'sig', oss_access_key_id: 'key',
        x_oss_object_acl: 'private', x_oss_forbid_overwrite: 'true' } });
      if (requests.length === 2) return new Response('', { status: 200 });
      return Response.json({ output: { task_id: 't1' } });
    };
    const remote = 'https://cdn.example.com/b.jpg';
    const r = await call(model, { reference_urls: ['http://localhost:5679/static/a.png', remote],
      duration: 6, generate_audio: false, resolution: '1080P', aspect_ratio: '9:16' });
    assert.equal(r.task_id, 't1', r.error);
    const [policy, upload, submission] = requests;
    assert.equal(new URL(policy.url).searchParams.get('model'), model);
    assert.equal(policy.headers.Authorization, 'Bearer k');
    assert.equal(upload.url, 'https://oss.example.com');
    assert.deepEqual(Buffer.from(await upload.body.get('file').arrayBuffer()), fs.readFileSync(path.join(storageDir, 'a.png')));
    assert.deepEqual(JSON.parse(submission.body), { model, input: { prompt: 'p',
      reference_urls: ['oss://' + upload.body.get('key'), remote] }, parameters: { size: '1080*1920', duration: 6, audio: false } });
    assert.equal(submission.headers['X-DashScope-OssResourceResolve'], 'enable');
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
  it('2.7 uses the documented text, image and optional first-frame reference inputs', async () => {
    const first = 'https://cdn.example.com/first.jpg', last = 'https://cdn.example.com/last.jpg';
    await call('wan2.7-t2v', { duration: 15, resolution: '1080P', aspect_ratio: '3:4', style_negative: '水印' });
    assert.deepEqual(sentBody.input, { prompt: 'p', negative_prompt: '水印' });
    assert.deepEqual(sentBody.parameters, { duration: 15, resolution: '1080P', ratio: '3:4' });
    await call('wan2.7-i2v', { duration: 2, first_frame_url: first, last_frame_url: last, aspect_ratio: '9:16' });
    assert.deepEqual(sentBody.input.media, [{ type: 'first_frame', url: first }, { type: 'last_frame', url: last }]);
    assert.equal(sentBody.parameters.ratio, undefined);
    await call('wan2.7-r2v', { first_frame_url: first, reference_urls: [last], aspect_ratio: '3:4' });
    assert.deepEqual(sentBody.input.media, [{ type: 'first_frame', url: first }, { type: 'reference_image', url: last }]);
    assert.equal(sentBody.parameters.ratio, undefined);
  });
  it('3.0 supports portrait, smart duration, mute, and wide text-only video', async () => {
    await call('wan3.0-video', { prompt: '', first_frame_url: '/static/a.png', duration: -1, seed: -1,
      generate_audio: false, aspect_ratio: 'adaptive', style_negative: '水印' });
    assert.match(sentBody.input.media[0].url, /^data:image\/png;base64,/);
    assert.deepEqual(Object.keys(sentBody.input), ['media']);
    assert.deepEqual(sentBody.parameters, { duration: -1, seed: -1, ratio: 'adaptive', resolution: '1080P', audio: false });
    await call('wan3.0-video', { duration: 30, aspect_ratio: '21:9', resolution: '480P' });
    assert.deepEqual(sentBody.input, { prompt: 'p' });
    assert.equal(sentBody.parameters.ratio, '21:9');
  });
  it('rejects unrepresentable requests before touching the network', async () => {
    const ref = 'https://cdn.example.com/ref.jpg';
    for (const [model, options] of [
      ['wan3.0-video', { first_frame_url: ref, reference_urls: [ref] }],
      ['wan3.0-video', { last_frame_url: ref }], ['wan3.0-video', { duration: 31 }],
      ['wan3.0-video', { prompt: '' }], ['wan3.0-video', { reference_urls: Array(11).fill(ref) }],
      ['wan2.7-r2v', { reference_urls: Array(6).fill(ref) }], ['wan2.7-r2v', { reference_urls: [] }],
      ['wan2.7-r2v', { reference_urls: [ref], duration: 1 }], ['wan2.7-t2v', { resolution: '480P' }],
      ['wan2.7-i2v', {}], ['wan2.7-t2v', { first_frame_url: ref }], ['wan2.7-t2v', { seed: -1 }],
      ['wan3.0-video', { reference_urls: ['/static/missing.png'] }],
    ]) assert.equal((await call(model, options)).submission, 'rejected', model + JSON.stringify(options));
    assert.equal(fetchCalls, 0);
  });
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
