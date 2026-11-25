const test = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const http = require('node:http');
const { once } = require('node:events');
const { runMigrationsAndEnsure } = require('../src/db/migrate');
const { resolveStylePreset } = require('../src/constants/generationStylePresets');

// 《AI励志古诗词》项目的真实画风：同一段文字里既有媒介笔触，也写了人物和场景。
const STYLE_WITH_SUBJECT =
  '9:16竖屏，中国水墨动画与三渲二结合风格，宣纸纤维质感底色，毛笔笔触边缘轻微晕染，工笔淡彩人物。' +
  '[中年苏轼，风格化写实比例，眉目舒展豁达，眼含笑意，自然胡须]，身穿宋代交领襕衫，天青与月白棉麻质感，头戴宋式东坡巾，衣纹线条如白描。' +
  '人物平视镜头，神态从容笃定，像老友闲谈般自然开口说话。' +
  '背景为[江南微雨竹林水榭，青瓦白墙，雾中远山，一叶扁舟，案上汝窑青瓷茶盏与袅袅沉香烟]，大面积留白的宋画构图，浅景深。' +
  '柔和散射天光，低饱和宋画色调（天青、月白、茶褐、墨灰），画面如《千里江山图》动起来。';

// 不含裸词「人物」：道具自己的提示词里有「禁止出现人物」
const SUBJECT_LEAK = /苏轼|胡须|东坡巾|襕衫|竹林|水榭|茶盏|淡彩人物|人物平视|神态|开口说话|身穿|头戴/;
const MEDIUM_KEPT = '中国水墨动画与三渲二结合风格';
const log = { info() {}, error() {}, warn() {}, debug() {}, errorw() {} };

function seed(db) {
  db.prepare('INSERT INTO dramas (id,title,style,metadata) VALUES (1,?,?,?)').run(
    '励志古诗词',
    'custom',
    JSON.stringify({ aspect_ratio: '9:16', style_prompt_zh: STYLE_WITH_SUBJECT, style_prompt_en: STYLE_WITH_SUBJECT })
  );
  db.prepare('INSERT INTO props (id,drama_id,name,type,description,prompt) VALUES (1,1,?,?,?,?)').run(
    '玉杯',
    '酒器',
    '通体暖白的唐代玉杯，是李白抒发金樽清酒意象的载体。',
    '单一无缝哑光深灰色背景，仅展示一个唐代玉杯。禁止出现人物、液体、桌面或文字。'
  );
}

test('styleWithoutSubject drops person and background clauses, keeps medium and brush words', () => {
  const { styleWithoutSubject } = require('../src/services/segmentCompile/style');
  const out = styleWithoutSubject(STYLE_WITH_SUBJECT);
  assert.doesNotMatch(out, SUBJECT_LEAK);
  assert.ok(out.includes(MEDIUM_KEPT), out);
  assert.ok(out.includes('宣纸纤维质感底色') && out.includes('毛笔笔触边缘轻微晕染'), out);
  assert.equal(styleWithoutSubject(''), '');
  // 一句话全是主体描述时得到空串，而不是退回原文
  assert.equal(styleWithoutSubject('身穿汉服的少女，人物表情细腻'), '');
});

test('styleWithoutSubject leaves pure style presets untouched', () => {
  const { styleWithoutSubject } = require('../src/services/segmentCompile/style');
  for (const key of ['ink wash', '3d render', 'watercolor']) {
    const zh = resolveStylePreset(key).zh;
    assert.equal(styleWithoutSubject(zh), zh.split(/[，,、；;]/).map((s) => s.trim()).filter(Boolean).join('，'), key);
  }
});

test('prop image request does not carry the project style\'s person or scene', async (t) => {
  const db = new Database(':memory:');
  t.after(() => db.close());
  runMigrationsAndEnsure(db);
  seed(db);

  const received = [];
  const provider = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    received.push(JSON.parse(Buffer.concat(chunks)).prompt);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ data: [{ url: 'https://example.invalid/result.png' }] }));
  }).listen(0, '127.0.0.1');
  await once(provider, 'listening');
  t.after(() => new Promise((resolve) => provider.close(resolve)));
  db.prepare(`INSERT INTO ai_service_configs(service_type,provider,model,base_url,api_key,api_protocol)
    VALUES('image','local','["image-test"]',?,'local','openai')`).run('http://127.0.0.1:' + provider.address().port);

  const taskService = require('../src/services/taskService');
  const { processPropImageGeneration } = require('../src/services/propImageGenerationService');
  const task = taskService.createTask(db, log, 'prop_image_generation', '1');
  await processPropImageGeneration(db, log, task.id, 1, {});

  assert.equal(received.length, 1);
  const prompt = received[0];
  assert.ok(prompt.includes('唐代玉杯'), prompt);
  assert.ok(prompt.includes(MEDIUM_KEPT), prompt);
  assert.doesNotMatch(prompt, SUBJECT_LEAK);
});

test('prop state variant prompt does not carry the project style\'s person or scene', () => {
  const { KINDS } = require('../src/services/assetVariantService');
  const { deriveStyleSentences } = require('../src/services/segmentCompile/style');
  const prompt = KINDS.prop_state.buildPrompt(
    { name: '玉杯', description: '通体暖白的唐代玉杯' },
    { state_phrase: '杯沿缺了一角' },
    deriveStyleSentences(STYLE_WITH_SUBJECT)
  );
  assert.ok(prompt.includes(MEDIUM_KEPT), prompt);
  assert.ok(prompt.includes('杯沿缺了一角'));
  assert.doesNotMatch(prompt, SUBJECT_LEAK);
});

test('character wardrobe prompt still carries the full style', () => {
  const { KINDS } = require('../src/services/assetVariantService');
  const { deriveStyleSentences } = require('../src/services/segmentCompile/style');
  const prompt = KINDS.wardrobe.buildPrompt(
    { name: '李白', appearance: '清瘦、长须' },
    { change_phrase: '换成夜行黑衣' },
    deriveStyleSentences(STYLE_WITH_SUBJECT)
  );
  assert.match(prompt, /东坡巾|襕衫/);
});
