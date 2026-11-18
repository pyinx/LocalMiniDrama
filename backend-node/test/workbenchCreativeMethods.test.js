const test = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const http = require('node:http');
const { once } = require('node:events');
const { runMigrationsAndEnsure } = require('../src/db/migrate');
const { withCreativeGuidance, creativeGuidance, scenarioFor, catalog } = require('../src/services/workbenchCreativeMethods');
const { updateDirection } = require('../src/services/workbenchContinuity');
const aiClient = require('../src/services/aiClient');
const videoService = require('../src/services/videoService');
const videoHandlers = require('../src/routes/videos');
const story = require('../src/services/storyGenerationService');

test('uses the same methods across entry points', async t => {
  const db = new Database(':memory:');
  t.after(() => db.close());
  runMigrationsAndEnsure(db);
  db.exec(`INSERT INTO dramas (id,title,description,style) VALUES (1,'潮线','盒子被送回','cartoon');
    INSERT INTO episodes (id,drama_id,episode_number,title,script_content) VALUES(10,1,1,'候场','她静静等待'),(11,1,2,'开箱','她拿起盒子');
    INSERT INTO storyboards (id,episode_id,storyboard_number,action) VALUES (20,10,1,'屏息等待');
  `);
  assert.equal(withCreativeGuidance(db, '作者文字', 1, 'video', 20), '作者文字');
  updateDirection(db, 1, { enabled: true, facts: '盒子已经打开', revision: 0 });
  const { executeGetCurrentProject, executeGenerateStoryboards } = await import('../src/mastra/tools.mjs');
  const project = executeGetCurrentProject(db, 1, 10).project;
  assert.equal(project.creativeMethods.version, catalog.version);
  assert.equal(project.creativeDirection.facts, '盒子已经打开');

  let textCalls = [];
  t.mock.method(aiClient, 'generateText', async (...args) => {
    textCalls.push(args[3]);
    return '[{"episode":1,"title":"归来","content":"她静静等待"}]';
  });
  await story.generateStory(db, {}, { drama_id: 1, premise: '供货返程' });
  assert.ok(textCalls[0].includes(catalog.tasks.story) && textCalls[0].includes(project.creativeDirection.facts));
  const boards = require('../src/services/episodeStoryboardService');
  const log = { info() {}, error() {}, warn() {}, debug() {} };
  const result = executeGenerateStoryboards(db, log, 1, 11, {}, { generateStoryboard: boards.generateStoryboard });
  assert.equal(result.ok, true);
  // The agent, canvas and film view all submit the same generateStoryboard operation.
  await new Promise(resolve => setImmediate(resolve));
  assert.ok(textCalls.some(prompt => project.creativeMethods.advice.every(line => prompt.includes(line))));

  t.mock.method(videoService, 'processVideoGeneration', () => {});
  const response = { status(value) { this.code = value; return this; }, json(result) { this.body = result; } };
  videoHandlers(db, log).create({ body: { drama_id: 1, storyboard_id: 20, prompt: '望向渡口' } }, response);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(response.code, 201, JSON.stringify(response.body));
  const recorded = db.prepare('SELECT prompt FROM video_generations ORDER BY id DESC LIMIT 1').get().prompt;
  assert.ok(recorded.includes(catalog.scenarios.pause.direction) && recorded.includes(catalog.styles.drawn));
  assert.ok(recorded.startsWith('望向渡口'));

  const received = [];
  const provider = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    received.push(JSON.parse(Buffer.concat(chunks)).prompt);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ data: [{ url: 'https://example.invalid/result.png' }] }));
  }).listen(0, '127.0.0.1');
  await once(provider, 'listening');
  t.after(() => new Promise(resolve => provider.close(resolve)));
  const url = 'http://127.0.0.1:' + provider.address().port;
  db.prepare(`INSERT INTO ai_service_configs(service_type,provider,model,base_url,api_key,api_protocol)
    VALUES('image','local','["image-test"]',?,'local','openai')`).run(url);
  const imageClient = require('../src/services/imageClient');
  for (const [asset, binding] of Object.entries({ character: {character_id: 3}, scene: {scene_id: 4}, prop: {prop_id: 5}, frame: {storyboard_id: 20} })) {
    const result = await imageClient.callImageApi(db, log, { drama_id: 1, prompt: '素材图', ...binding });
    assert.equal(result.error, undefined);
    assert.ok(received.at(-1).includes(catalog.tasks[asset]));
  }
  db.prepare("UPDATE dramas SET style='realistic' WHERE id=1").run();
  assert.ok(withCreativeGuidance(db, '角色', 1, 'character').includes(catalog.styles.live));
  assert.equal(scenarioFor({ characters: '[1,2,3]', dialogue: '我来' }), 'ensemble');
  assert.equal(scenarioFor({ dialogue: '请进来。' }), 'dialogue');
  assert.equal(scenarioFor({ action: '越过门槛' }), 'action');
  assert.equal(scenarioFor({ action: '越过门槛' }, 'pause'), 'pause');
  assert.deepEqual(creativeGuidance({}, 'video').advice, []);
  assert.throws(() => withCreativeGuidance(db, '本镜', 1, 'video', 99), /不属于/);
});
