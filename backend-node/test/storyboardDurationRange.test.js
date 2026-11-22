const test = require('node:test');
const assert = require('node:assert/strict');
const dramaRoutes = require('../src/routes/drama');
const videoRoutes = require('../src/routes/videos');
const ai = require('../src/services/aiClient');
const videos = require('../src/services/videoService');
const videoClient = require('../src/services/videoClient');
const tasks = require('../src/services/taskService');
const { storyboardPlanningCaps } = require('../src/services/modelCapabilities');
const { createIrTestDb, sampleIr, mockRes, noopLog } = require('./helpers/segmentIrFixtures');

function setup(t) {
  const { db, ids } = createIrTestDb();
  t.after(() => db.close());
  db.prepare("INSERT INTO ai_service_configs(service_type,provider,model,default_model,is_default) VALUES('video','dashscope',?, ?,1)")
    .run('["wan3.0-video"]', 'wan3.0-video');
  db.prepare('UPDATE dramas SET metadata=? WHERE id=?').run(JSON.stringify({
    video_clip_duration: 5, pipeline_clip_range: { min: 7, max: 10 },
  }), ids.dramaId);
  db.prepare("UPDATE episodes SET script_content='他等风停。' WHERE id=?").run(ids.episodeId);
  const boards = () => db.prepare('SELECT * FROM storyboards WHERE episode_id=? AND deleted_at IS NULL ORDER BY storyboard_number').all(ids.episodeId);
  async function generate(options) {
    const res = mockRes();
    await dramaRoutes(db, {}, noopLog).generateStoryboard({ params: {episode_id: ids.episodeId}, body: options }, res);
    assert.equal(res.statusCode, 200, JSON.stringify(res.body));
    await new Promise(resolve => setImmediate(resolve));
    return tasks.getTask(db, res.body.data.task_id);
  }
  return { db, ids, boards, generate };
}

test('classic and universal preserve different shot durations', async t => {
  const { db, ids, boards, generate } = setup(t);
  let lengths = [3, 8, 13, 6, 4, 7, 10, 6, 4, 10, 12, 8];
  let prompt;
  t.mock.method(ai, 'generateText', async (_db, _log, _type, user) => {
    prompt = user;
    return JSON.stringify({ storyboards: lengths.map((duration, i) => ({
      shot_number: i + 1, title: '岸边' + i, duration, action: '风停了', result: '海面变平',
      universal_segment_text: '画面风格和类型: 黏土\n生成一个由以下子分镜组成的连贯视频。\n分镜1： 5秒: 风停了，海面变平。',
    })) });
  });
  const manual = await generate({ storyboard_count: 12 });
  assert.equal(manual.status, 'completed', manual.error);
  assert.deepEqual(boards().map(b => b.duration), lengths);
  assert.equal(JSON.parse(manual.result).total_duration, lengths.reduce((a,b) => a+b));
  assert.doesNotMatch(prompt, /整集目标总时长约|视频总时长必须控制在|约5秒（项目配置）/);
  lengths = [3, 7, 9, 14];
  const pipeline = await generate({ clip_duration_range: {min: 6, max: 11}, universal_omni_storyboard: true });
  assert.equal(pipeline.status, 'completed', pipeline.error);
  assert.match(prompt, /6–11/);
  const shots = boards();
  assert.deepEqual(shots.map(b => b.duration), [6,7,9,11]);
  for (const b of shots) assert.ok(b.universal_segment_text.includes('分镜1： ' + b.duration + '秒:'), b.universal_segment_text);
  t.mock.method(videos, 'processVideoGeneration', async () => {});
  const selected = shots[2];
  const res = mockRes();
  await videoRoutes(db, noopLog, {}).create({ body: {
    drama_id: ids.dramaId, storyboard_id: selected.id, duration: 5, prompt: selected.universal_segment_text,
    reference_image_urls: ['https://fixtures.invalid/island.png'],
  } }, res);
  assert.equal(res.statusCode, 201, JSON.stringify(res.body));
  assert.equal(db.prepare('SELECT duration FROM video_generations WHERE id=?').get(res.body.data.id).duration, 9);
  await new Promise(resolve => setImmediate(resolve));
  const mismatch = await generate({storyboard_count:12});
  assert.equal(mismatch.status, 'failed');
  assert.deepEqual(boards().map(b=>b.id), shots.map(b=>b.id));
});

test('structured timing respects model and project limits', async t => {
  const { db, ids, boards, generate } = setup(t);
  const discrete = {duration: {min:5,max:15,step:5}};
  assert.deepEqual(storyboardPlanningCaps(discrete, {min:6,max:14}).duration, {min:10,max:10,step:5});
  assert.throws(() => storyboardPlanningCaps(discrete, {min:6,max:9}), /不相交/);
  assert.throws(() => storyboardPlanningCaps(discrete, {min:12,max:3}), /有效/);
  let durations = [3,9];
  let prompt;
  t.mock.method(ai, 'generateText', async (_db, _log, _type, user) => {
    prompt = user;
    return JSON.stringify(durations.map(sec => {
      const ir = sampleIr(ids);
      ir.shots = [{...ir.shots[0], seconds:sec}];
      ir.duration_s = sec;
      return ir;
    }));
  });
  const manual = await generate({structured:true, storyboard_count:2});
  assert.equal(manual.status, 'completed', manual.error);
  assert.match(prompt, /恰好 2 段/);
  assert.deepEqual(boards().map(b=>b.duration), [3,9]);
  assert.equal(JSON.parse(manual.result).total_duration,12);
  assert.equal(db.prepare('SELECT duration FROM episodes WHERE id=?').get(ids.episodeId).duration,1);
  const pipeline = await generate({structured:true, clip_duration_range:{min:6,max:10}, video_duration:15});
  assert.equal(pipeline.status, 'completed', pipeline.error);
  assert.match(prompt, /整集目标总时长约 15 秒/);
  assert.deepEqual(boards().map(b=>b.duration), [6,9]);
  const original = boards().map(b=>b.id);
  durations = [13];
  const oversized = await generate({structured:true, clip_duration_range:{min:6,max:10}});
  assert.equal(oversized.status,'failed');
  assert.deepEqual(boards().map(b=>b.id),original);
});

test('discrete duration is identical in the saved storyboard and the provider request', async t => {
  const { db, boards, generate } = setup(t);
  db.prepare(`UPDATE ai_service_configs SET provider='kling', api_protocol='kling',
    model='["kling-video"]', default_model='kling-video', base_url='https://fixtures.invalid'
    WHERE service_type='video'`).run();
  t.mock.method(ai, 'generateText', async () => JSON.stringify({
    storyboards: [6, 9].map((duration, i) => ({ shot_number: i + 1, title: '海岸', duration, action: '风停了' })),
  }));
  const result = await generate({ storyboard_count: 2, clip_duration_range: { min: 4, max: 11 } });
  assert.equal(result.status, 'completed', result.error);
  const durations = boards().map(shot => shot.duration);
  assert.deepEqual(durations, [5, 10]);

  const submitted = [];
  t.mock.method(globalThis, 'fetch', async (url, request) => {
    assert.equal(new URL(url).hostname, 'fixtures.invalid');
    submitted.push(Number(JSON.parse(request.body).duration));
    return Response.json({ code: 0, data: { task_id: 'fixture' } });
  });
  for (const duration of durations) {
    const submission = await videoClient.callVideoApi(db, noopLog, { prompt: '海风', duration });
    assert.equal(submission.task_id, 't2v:fixture', submission.error);
  }
  assert.deepEqual(submitted, durations);
});

test('Veo relay uses the model default and Gemini accepts explicit Veo duration tiers', () => {
  const relay = videoClient.describeVideoTarget({ api_protocol: 'veo3', model: ['veo3.1'] }).caps;
  assert.deepEqual(relay.duration, { min: 8, max: 8, step: 1 });
  assert.throws(() => storyboardPlanningCaps(relay, { min: 6, max: 7 }), /可选秒数：8/);
  const gemini = videoClient.describeVideoTarget({ api_protocol: 'gemini', model: ['veo-3.1-generate-001'] }).caps;
  assert.deepEqual(storyboardPlanningCaps(gemini, { min: 5, max: 7 }).duration, { min: 6, max: 6, step: 2 });
});

test('frame-based video tiers fit the requested range before rounding to storyboard seconds', () => {
  const agnes = videoClient.describeVideoTarget({ api_protocol: 'agnes', model: ['agnes-video-v2.0'] }).caps;
  assert.throws(() => storyboardPlanningCaps(agnes, { min: 7, max: 7 }), /6\.71/);
  assert.deepEqual(storyboardPlanningCaps(agnes, { min: 6, max: 7 }).duration.values, [7]);
});
