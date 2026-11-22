const test = require('node:test');
const assert = require('node:assert/strict');
const { once } = require('node:events');
const http = require('node:http');
const { randomUUID } = require('node:crypto');
const sharp = require('sharp');
const { openWorkbench } = require('./helpers/workbenchHttp');

async function upload(ws, color = 'teal') {
  const file = await sharp({ create: { width: 21, height: 17, channels: 3, background: color } }).png().toBuffer();
  const form = new FormData();
  form.append('file', new Blob([file], { type: 'image/png' }), '画风.png');
  return (await ws.request('POST', '/style-library/images', form)).image;
}
async function modelServer(t, ws, service, reply) {
  const calls = [];
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    calls.push(JSON.parse(Buffer.concat(chunks)));
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(reply()));
  }).listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise(resolve => server.close(resolve)));
  const image = service === 'image';
  ws.db.prepare(`INSERT INTO ai_service_configs(service_type,provider,model,base_url,api_key,api_protocol)
    VALUES(?,?,?,?,?,?)`).run(service, image ? 'dashscope' : 'local', JSON.stringify([image ? 'qwen-image-3.0' : 'local-vision']),
      'http://127.0.0.1:' + server.address().port + (image ? '/dashscope' : ''), 'local', image ? 'dashscope' : 'openai');
  return calls;
}

test('image analysis returns editable style prompts without replacing user edits', async t => {
  const ws = await openWorkbench(t);
  const image = await upload(ws);
  let answer = JSON.stringify({ positive: '纸纤维与矿物平涂', negative: '镜面塑料质感' });
  const calls = await modelServer(t, ws, 'text', () => ({ choices: [{ message: { content: answer } }] }));
  const result = await ws.request('POST', '/style-library/analyze', { image });
  assert.deepEqual(result, JSON.parse(answer));
  assert.ok(calls[0].messages.some(m => Array.isArray(m.content) && m.content.some(c => c.image_url?.url.startsWith('data:image/png;base64,'))));
  assert.deepEqual(await ws.request('GET','/style-library'), []);
  const draft = { id: randomUUID(), name: '矿物色', image, ...result, positive: '我选的矿物色' };
  await ws.request('POST', '/style-library', draft);
  answer = '无有效分析';
  const response = await fetch(ws.url('/style-library/analyze'), { method: 'POST', headers: { 'Content-Type':'application/json' }, body: JSON.stringify({image}) });
  assert.equal(response.status, 422);
  assert.equal((await ws.request('GET','/style-library'))[0].positive, draft.positive);
});

test('generation sends style negatives according to the resolved model', async t => {
  const ws = await openWorkbench(t);
  const image = await upload(ws);
  const bytes = Buffer.from(await (await fetch(ws.url('/style-library/images/' + image))).arrayBuffer());
  const calls = await modelServer(t, ws, 'image', () => ({ output: { choices: [{ message: { content: [{ image: 'data:image/png;base64,' + bytes.toString('base64') }] } }] } }));
  const caps = await ws.request('GET','/style-library/capabilities');
  assert.equal(caps.negative, true);
  for (const model of [undefined, caps.model]) {
    const out = await ws.request('POST','/style-library/generate', { positive: '矿物颜料', negative: '塑料反光', model });
    assert.equal((await fetch(ws.url('/style-library/images/' + out.image))).status, 200);
    assert.equal(calls.at(-1).parameters.negative_prompt, '塑料反光');
    assert.ok(calls.at(-1).input.messages[0].content[0].text.includes('矿物颜料'));
  }
  ws.db.prepare("UPDATE ai_service_configs SET model=? WHERE service_type='image'").run('["qwen-image-2.1"]');
  assert.equal((await ws.request('GET','/style-library/capabilities')).negative, false);
  const response = await fetch(ws.url('/style-library/generate'), { method: 'POST', headers: { 'Content-Type':'application/json' },
    body: JSON.stringify({positive:'矿物色', negative:'塑料反光'}) });
  assert.equal(response.status, 409);
  assert.equal(calls.length, 2);
});

test('projects keep adopted style versions when the library advances', async t => {
  const ws = await openWorkbench(t);
  const first = await ws.request('POST','/style-library',{id:randomUUID(), name:'木偶剧场', positive:'木纹', negative:'金属', image:await upload(ws)});
  async function adopt(version) {
    const { positive, ...snapshot } = version;
    return ws.request('POST','/dramas',{ title:'新剧', style:'custom', metadata:{style_prompt_zh:positive,style_prompt_en:positive,custom_style:snapshot} });
  }
  const a = await adopt(first);
  const draft = {...first, base_version:1, negative:'塑胶', positive:'漆木', image:await upload(ws,'red')};
  const second = await ws.request('POST','/style-library',draft);
  assert.equal((await ws.request('POST','/style-library',draft)).version, 2);
  const b = await adopt(second);
  assert.equal((await ws.request('GET','/dramas/'+a.id)).metadata.custom_style.image, first.image);
  assert.equal((await ws.request('GET','/dramas/'+b.id)).metadata.style_prompt_zh, '漆木');
  assert.deepEqual(await ws.request('GET','/style-library'), [second]);
  const race = await fetch(ws.url('/style-library'), {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({...draft,name:'旧版本提交'})});
  assert.equal(race.status,409);
});


test('asset, storyboard and video adapters use the adopted prompts captured at submission', async t => {
  const ws = await openWorkbench(t);
  const image = await upload(ws);
  const style = await ws.request('POST', '/style-library', {
    id: randomUUID(), name: '纸偶', positive: '硬纸纤维', negative: '反光, 光滑', image,
  });
  const { positive, ...snapshot } = style;
  const { id } = await ws.request('POST', '/dramas', { title: '纸偶剧', style: 'custom',
    metadata: { style_prompt_zh: positive, custom_style: snapshot } });
  const episode = ws.db.prepare("INSERT INTO episodes(drama_id,episode_number,title) VALUES(?,1,'车站')").run(id).lastInsertRowid;
  const shot = ws.db.prepare('INSERT INTO storyboards(episode_id,storyboard_number) VALUES(?,1)').run(episode).lastInsertRowid;
  const imageCalls = await modelServer(t, ws, 'image', () => ({ output: { choices: [{ message: { content: [
    { image: 'https://example.invalid/image.png' },
  ] } }] } }));
  const client = require('../src/services/imageClient');
  const queued = client.readProjectStyle(ws.db, id);
  const log = { info(){}, warn(){}, error(){}, debug(){} };
  for (const binding of [{ character_id: 2 }, { scene_id: 3 }, { prop_id: 4 }, { storyboard_id: shot }]) {
    const result = await client.callImageApi(ws.db, log, { drama_id: id, prompt: '举起茶杯'.repeat(225), ...binding,
      project_style: queued, user_negative_prompt: '光滑，亮斑' });
    assert.ifError(result.error);
    assert.match(imageCalls.at(-1).input.messages[0].content[0].text, /硬纸纤维/);
    assert.equal(imageCalls.at(-1).parameters.negative_prompt, '反光, 光滑, 亮斑');
  }
  const videoRequests = [];
  const provider = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const part of req) chunks.push(part);
    videoRequests.push(JSON.parse(Buffer.concat(chunks)));
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ output: { task_id: 'local-request' } }));
  }).listen(0, '127.0.0.1');
  await once(provider, 'listening');
  t.after(() => new Promise(resolve => provider.close(resolve)));
  ws.db.prepare(`INSERT INTO ai_service_configs(service_type,provider,model,base_url,api_key,api_protocol)
    VALUES('video','dashscope','["wan3.0-video","wan3.0-video-prime","wan2.6-t2v","wan-future"]',?,'local','dashscope')`).run('http://127.0.0.1:' + provider.address().port);
  t.mock.method(require('../src/services/videoService'), 'processVideoGeneration', () => {});
  const preflight = '/style-library/preflight?kind=video&id=' + id;
  assert.equal((await ws.request('GET', preflight + '&model=wan-future')).warn, true);
  const tooLong = await fetch(ws.url('/videos'), {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ drama_id: id, storyboard_id: shot, prompt: positive.padEnd(20000, '风') }),
  });
  assert.equal(tooLong.status, 422);
  assert.match((await tooLong.json()).error.message, /20000/);
  assert.equal(ws.db.prepare('SELECT COUNT(*) AS n FROM video_generations').get().n, 0);
  const recorded = [];
  for (const model of [undefined, 'wan3.0-video-prime', 'wan2.6-t2v']) {
    const check = await ws.request('GET', preflight + (model ? '&model=' + model : ''));
    assert.equal(check.model, model || 'wan3.0-video');
    assert.equal(check.warn, false);
    const take = await ws.request('POST', '/videos', { drama_id: id, storyboard_id: shot, prompt: '举杯', model });
    recorded.push(ws.db.prepare('SELECT * FROM video_generations WHERE id=?').get(take.id));
  }
  await ws.request('PUT', '/dramas/'+id+'/outline', { style: 'realistic' });
  for (const row of recorded) {
    const video = await require('../src/services/videoClient').callVideoApi(ws.db, log, row);
    assert.ifError(video.error);
    const { model, input } = videoRequests.at(-1);
    assert.equal(model, row.model);
    assert.match(input.prompt, /举杯/);
    assert.match(input.prompt, /硬纸纤维/);
    if (model === 'wan2.6-t2v') {
      assert.equal(input.negative_prompt, '反光, 光滑');
      assert.doesNotMatch(input.prompt, /反光/);
    } else {
      assert.equal(Object.hasOwn(input, 'negative_prompt'), false);
      assert.match(input.prompt, /负向清单（避免出现）：反光, 光滑$/);
    }
  }
  await client.callImageApi(ws.db, log, { drama_id: id, prompt: '车窗', storyboard_id: shot, project_style: queued });
  assert.match(imageCalls.at(-1).input.messages[0].content[0].text, /硬纸纤维/);
  assert.equal(imageCalls.at(-1).parameters.negative_prompt, '反光, 光滑');
  ws.db.prepare("UPDATE dramas SET style='realistic', metadata='{}' WHERE id=?").run(id);
  await ws.request('POST', '/videos', { drama_id: id, storyboard_id: shot, prompt: '旧分镜原文' });
  assert.equal(ws.db.prepare('SELECT prompt FROM video_generations ORDER BY id DESC LIMIT 1').get().prompt, '旧分镜原文');
});
