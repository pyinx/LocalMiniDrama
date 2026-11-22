const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const sharp = require('sharp');
const AdmZip = require('adm-zip');
const config = require('../src/config');
const imageClient = require('../src/services/imageClient');
const aiClient = require('../src/services/aiClient');
const headBody = require('../src/services/characterHeadBody');
const assetVariantService = require('../src/services/assetVariantService');
const characterLibraryService = require('../src/services/characterLibraryService');
const characterRoutes = require('../src/routes/characters');
const A = require('../src/services/segmentCompile/rules/assetPhrases');
const { createIrTestDb, sampleIr, mockRes, noopLog } = require('./helpers/segmentIrFixtures');
const segmentCompileService = require('../src/services/segmentCompileService');
const storyboardService = require('../src/services/storyboardService');
const aiConfigService = require('../src/services/aiConfigService');

/** 在 Seedance 2.x（9 张参考）配置下执行 */
function withSeedance(fn) {
  const saved = aiConfigService.listConfigs;
  aiConfigService.listConfigs = () => [{ id: 1, service_type: 'video', is_active: true, is_default: true, provider: 'volcengine', api_protocol: 'volcengine_omni', base_url: 'https://ark', api_key: 'k', model: ['doubao-seedance-2-0-260128'], default_model: 'doubao-seedance-2-0-260128' }];
  try { return fn(); } finally { aiConfigService.listConfigs = saved; }
}

const BASE = 'http://localhost:5679/static';
let db, ids, cfg, root, captured, originals;

async function png(rel, width, height, rgb) {
  const abs = path.join(root, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  await sharp({ create: { width, height, channels: 3, background: rgb } }).png().toFile(abs);
  return rel;
}

/** 让第 i 个提交的生图完成：先落一张真实图片，再触发回调，等拼合写库结束 */
async function complete(i, rel, size = [512, 512], rgb = { r: 200, g: 0, b: 0 }) {
  await png(rel, size[0], size[1], rgb);
  await captured[i].on_completed({ image_url: 'http://cdn/x.png', local_path: rel, image_gen_id: i + 1 });
}

function character(id = ids.linId) {
  return db.prepare('SELECT * FROM characters WHERE id = ?').get(id);
}

/** 造一个已处于头身模式的角色 */
async function headBodyCharacter(id = ids.linId) {
  const head = await png('p/characters/head.png', 512, 512, { r: 200, g: 0, b: 0 });
  const body = await png('p/characters/body.png', 896, 512, { r: 0, g: 0, b: 200 });
  const main = await headBody.composeSheet(cfg, head, body);
  db.prepare('UPDATE characters SET head_local_path = ?, body_local_path = ?, local_path = ?, image_url = ? WHERE id = ?')
    .run(head, body, main, '/static/' + main, id);
  return { head, body, main };
}

async function pixel(rel, x, y) {
  const { data } = await sharp(path.join(root, rel)).extract({ left: x, top: y, width: 1, height: 1 }).raw().toBuffer({ resolveWithObject: true });
  return [data[0], data[1], data[2]];
}

beforeEach(() => {
  ({ db, ids } = createIrTestDb());
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'headbody-'));
  cfg = { app: { name: 'test' }, storage: { local_path: root, base_url: BASE } };
  captured = [];
  originals = { imageConfig: imageClient.getDefaultImageConfig, create: imageClient.createAndGenerateImage, loadConfig: config.loadConfig, callImageApi: imageClient.callImageApi, generateText: aiClient.generateText };
  imageClient.createAndGenerateImage = (_db, _log, opts) => {
    captured.push(opts);
    return { id: captured.length, status: 'pending' };
  };
  config.loadConfig = () => cfg;
});

afterEach(() => {
  imageClient.createAndGenerateImage = originals.create;
  imageClient.callImageApi = originals.callImageApi;
  imageClient.getDefaultImageConfig = originals.imageConfig;
  aiClient.generateText = originals.generateText;
  config.loadConfig = originals.loadConfig;
  fs.rmSync(root, { recursive: true, force: true });
});

describe('character head-body split', () => {
  it('composes a deterministic sheet from head and body', async () => {
    const head = await png('p/characters/h.png', 512, 512, { r: 200, g: 0, b: 0 });
    const body = await png('p/characters/b.png', 512, 512, { r: 0, g: 0, b: 200 });
    const rel = await headBody.composeSheet(cfg, head, body);
    assert.equal(rel, headBody.composedPath(head, body));
    assert.match(rel, /^p\/characters\/hb_[0-9a-f]{16}\.png$/);
    const meta = await sharp(path.join(root, rel)).metadata();
    assert.equal(meta.format, 'png');
    assert.equal(meta.height, 1024);
    assert.equal(meta.width, 1024 + 32 + 1024, 'head and body side by side at one height with a gap');
    assert.deepEqual(await pixel(rel, 10, 500), [200, 0, 0], 'left panel is the head');
    assert.deepEqual(await pixel(rel, 1024 + 32 + 10, 500), [0, 0, 200], 'right panel is the body');

    assert.equal(await headBody.composeSheet(cfg, head, body), rel, 'same pair, same file');
    const otherBody = await png('p/characters/b2.png', 512, 512, { r: 0, g: 200, b: 0 });
    const other = await headBody.composeSheet(cfg, head, otherBody);
    assert.notEqual(other, rel);
    assert.ok(fs.existsSync(path.join(root, rel)), 'earlier sheet kept for history');
    await assert.rejects(headBody.composeSheet(cfg, head, null), (e) => e.code === 'head_body_missing');

    // 生图模型返回的身体图更宽时，上下补底色，宽高比仍在视频接口允许的范围内（Seedance 2.0 上限 2.5）
    const wide = await headBody.composeSheet(cfg, head, await png('p/characters/wide.png', 1792, 512, { r: 0, g: 0, b: 200 }));
    const wm = await sharp(path.join(root, wide)).metadata();
    assert.ok(wm.width / wm.height <= 2.4, `ratio ${wm.width / wm.height}`);
    const top = Math.floor((wm.height - 1024) / 2);
    assert.deepEqual(await pixel(wide, 10, top + 500), [200, 0, 0], 'head stays whole, centred vertically');
    assert.deepEqual(await pixel(wide, 10, 2), [242, 242, 242], 'padding uses the sheet background');
  });

  it('converts a character: head, then body, then composite main image', async () => {
    db.prepare(`UPDATE characters SET appearance = ?, local_path = 'p/characters/old.png', image_url = 'http://cdn/old.png', seedance2_asset = ? WHERE id = ?`)
      .run('三十岁男性，短发，旧T恤', JSON.stringify({ status: 'active', hub_asset_id: 'asset-1', certified_local_path: 'p/characters/old.png' }), ids.linId);

    headBody.generate(db, noopLog, cfg, ids.linId, 'all');
    assert.equal(captured.length, 1);
    assert.equal(captured[0].character_id, undefined, 'head is not written as the main image');
    assert.equal(captured[0].size, '1024x1024');
    assert.equal(captured[0].reference_image_urls, undefined);
    assert.ok(captured[0].prompt.includes(A.headSheet('林远')));
    assert.ok(captured[0].prompt.includes('三十岁男性'));

    await complete(0, 'p/characters/head.png');
    assert.equal(character().head_local_path, 'p/characters/head.png');
    assert.equal(character().local_path, 'p/characters/old.png', 'main image unchanged until the body is done');
    assert.equal(captured.length, 2);
    assert.deepEqual(captured[1].reference_image_urls, [`${BASE}/p/characters/head.png`]);
    assert.ok(captured[1].prompt.includes(A.headlessBodyLayout));
    assert.equal(captured[1].size, '1024x1024', 'square body keeps the sheet within reference-image ratio limits');
    assert.equal(captured[1].character_id, undefined);

    await complete(1, 'p/characters/body.png', [896, 512], { r: 0, g: 0, b: 200 });
    const c = character();
    assert.equal(c.body_local_path, 'p/characters/body.png');
    assert.equal(c.local_path, headBody.composedPath('p/characters/head.png', 'p/characters/body.png'));
    assert.equal(c.image_url, '/static/' + c.local_path);
    assert.ok(headBody.isHeadBody(c));
    assert.ok(JSON.parse(c.extra_images).includes('p/characters/old.png'), 'old main image kept in history');
    assert.equal(JSON.parse(c.seedance2_asset).status, 'stale', 'certified asset follows the main image change');
  });

  it('a failed step leaves the main image and records the error', async () => {
    db.prepare(`UPDATE characters SET local_path = 'p/characters/old.png' WHERE id = ?`).run(ids.linId);
    headBody.generate(db, noopLog, cfg, ids.linId, 'all');
    captured[0].on_failed({ error: '额度不足' });
    assert.equal(character().error_msg, '额度不足');
    assert.equal(character().local_path, 'p/characters/old.png');

    headBody.generate(db, noopLog, cfg, ids.linId, 'all');
    assert.equal(character().error_msg, null, 'a new attempt clears the old error');
    await captured[1].on_completed({ image_url: 'http://cdn/x.png', local_path: null });
    assert.match(character().error_msg, /未能保存/);
    assert.equal(captured.length, 2, 'no body is requested without a saved head');
  });

  it('regenerating the head recomposes main and wardrobes', async () => {
    const { body } = await headBodyCharacter();
    const w = assetVariantService.create(db, 'wardrobe', ids.linId, { name: '岛上', change_phrase: '草帽，背心' });
    const wBody = await png('p/characters/wbody.png', 896, 512, { r: 0, g: 200, b: 0 });
    db.prepare('UPDATE character_wardrobes SET body_local_path = ?, local_path = ? WHERE id = ?')
      .run(wBody, await headBody.composeSheet(cfg, 'p/characters/head.png', wBody), w.id);

    headBody.generate(db, noopLog, cfg, ids.linId, 'head');
    assert.equal(captured.length, 1);
    await complete(0, 'p/characters/head2.png', [512, 512], { r: 0, g: 0, b: 0 });
    assert.equal(captured.length, 1, 'regenerating the head does not regenerate the body');
    assert.equal(character().local_path, headBody.composedPath('p/characters/head2.png', body));
    const wardrobe = () => db.prepare('SELECT * FROM character_wardrobes WHERE id = ?').get(w.id);
    assert.equal(wardrobe().local_path, headBody.composedPath('p/characters/head2.png', wBody));
    assert.deepEqual(await pixel(wardrobe().local_path, 10, 500), [0, 0, 0], 'wardrobe sheet carries the new face');

    const wardrobeBefore = wardrobe().local_path;
    headBody.generate(db, noopLog, cfg, ids.linId, 'body');
    assert.deepEqual(captured[1].reference_image_urls, [`${BASE}/p/characters/head2.png`]);
    await complete(1, 'p/characters/body2.png', [896, 512], { r: 0, g: 0, b: 200 });
    assert.equal(character().local_path, headBody.composedPath('p/characters/head2.png', 'p/characters/body2.png'));
    assert.equal(wardrobe().local_path, wardrobeBefore, 'a new base body leaves wardrobes as they were');
  });

  it('does not rewrite an existing sheet and leaves no temp files', async () => {
    const head = await png('p/characters/h.png', 512, 512, { r: 200, g: 0, b: 0 });
    const body = await png('p/characters/b.png', 512, 512, { r: 0, g: 0, b: 200 });
    const rel = await headBody.composeSheet(cfg, head, body);
    fs.writeFileSync(path.join(root, rel), 'in use');
    assert.equal(await headBody.composeSheet(cfg, head, body), rel);
    assert.equal(fs.readFileSync(path.join(root, rel), 'utf8'), 'in use', 'a sheet other requests may be reading is not rewritten');
    assert.deepEqual(fs.readdirSync(path.join(root, 'p/characters')).filter((n) => n.endsWith('.tmp')), []);
  });

  it('refuses a second head-body run for the same character until the first settles', async () => {
    headBody.generate(db, noopLog, cfg, ids.linId, 'all');
    assert.throws(() => headBody.generate(db, noopLog, cfg, ids.linId, 'head'), (e) => e.code === 'busy');
    const busy = mockRes();
    characterRoutes(db, cfg, noopLog, null).generateHeadBody({ params: { id: String(ids.linId) }, body: { part: 'all' } }, busy);
    assert.equal(busy.statusCode, 409);
    assert.equal(captured.length, 1, 'no second paid generation');

    headBody.generate(db, noopLog, cfg, ids.hrId, 'all');
    assert.equal(captured.length, 2, 'another character is not blocked');
    captured[1].on_failed({ error: '额度不足' });

    await complete(0, 'p/characters/head.png');
    assert.throws(() => headBody.generate(db, noopLog, cfg, ids.linId, 'head'), (e) => e.code === 'busy', 'still running while the body is drawn');
    await complete(2, 'p/characters/body.png', [512, 512], { r: 0, g: 0, b: 200 });
    headBody.generate(db, noopLog, cfg, ids.linId, 'head');
    captured[3].on_failed({ error: '超时' });
    headBody.generate(db, noopLog, cfg, ids.linId, 'body');
    assert.equal(captured.length, 5, 'released after success and after failure');
    captured[4].on_failed({ error: '收尾' });
  });

  it('rejects a body without a head and an unknown part', () => {
    assert.throws(() => headBody.generate(db, noopLog, cfg, ids.linId, 'body'), (e) => e.code === 'head_missing');
    const r = characterRoutes(db, cfg, noopLog, null);
    const conflict = mockRes();
    r.generateHeadBody({ params: { id: String(ids.linId) }, body: { part: 'body' } }, conflict);
    assert.equal(conflict.statusCode, 409);
    const bad = mockRes();
    r.generateHeadBody({ params: { id: String(ids.linId) }, body: { part: 'face' } }, bad);
    assert.equal(bad.statusCode, 400);
    const missing = mockRes();
    r.generateHeadBody({ params: { id: '99999' }, body: {} }, missing);
    assert.equal(missing.statusCode, 404);
    assert.equal(captured.length, 0);
  });

  it('wardrobe in head-body mode generates only a body', async () => {
    const { head, body } = await headBodyCharacter();
    const w = assetVariantService.create(db, 'wardrobe', ids.linId, { name: '岛上', change_phrase: '草帽，背心，赤脚' });
    const { prompt } = assetVariantService.generateImage(db, noopLog, 'wardrobe', w.id);
    assert.deepEqual(captured[0].reference_image_urls, [`${BASE}/${head}`, `${BASE}/${body}`]);
    assert.equal(captured[0].character_id, undefined);
    assert.ok(prompt.includes(A.bodyWardrobeLead('林远')));
    assert.ok(prompt.includes('草帽，背心，赤脚'));
    assert.ok(prompt.includes(A.headlessBodyLayout));
    assert.ok(!prompt.includes(A.oneClearFaceLayout), 'no face is drawn on the wardrobe sheet');

    await complete(0, 'p/characters/wbody.png', [896, 512], { r: 0, g: 200, b: 0 });
    const row = db.prepare('SELECT * FROM character_wardrobes WHERE id = ?').get(w.id);
    assert.equal(row.body_local_path, 'p/characters/wbody.png');
    assert.equal(row.local_path, headBody.composedPath(head, 'p/characters/wbody.png'));
    assert.deepEqual(await pixel(row.local_path, 10, 500), [200, 0, 0], 'same face as the main sheet');
  });

  it('replacing the main image leaves head-body mode', async () => {
    await headBodyCharacter();
    assert.ok(headBody.isHeadBody(character()));
    const lib = db.prepare(`INSERT INTO character_libraries (name, image_url, local_path, created_at, updated_at) VALUES ('别人', '/static/p/lib/other.png', 'p/lib/other.png', 'x', 'x')`).run();
    assert.ok(characterLibraryService.applyLibraryItemToCharacter(db, noopLog, ids.linId, lib.lastInsertRowid).ok);
    assert.ok(!headBody.isHeadBody(character()), 'main image is no longer the head-body sheet');

    const w = assetVariantService.create(db, 'wardrobe', ids.linId, { name: '西装', change_phrase: '深灰西装' });
    db.prepare('UPDATE character_wardrobes SET body_local_path = ? WHERE id = ?').run('p/characters/stale_body.png', w.id);
    const { prompt } = assetVariantService.generateImage(db, noopLog, 'wardrobe', w.id);
    assert.ok(prompt.includes(A.oneClearFaceLayout), 'falls back to the whole wardrobe sheet');
    assert.deepEqual(captured[0].reference_image_urls, [`${BASE}/p/lib/other.png`]);
    captured[0].on_completed({ image_url: 'http://cdn/w.png', local_path: 'p/characters/w.png' });
    assert.equal(db.prepare('SELECT body_local_path FROM character_wardrobes WHERE id = ?').get(w.id).body_local_path, null,
      'a whole wardrobe sheet drops the stale body so a later head change cannot overwrite it');
  });

  it('picks the wardrobe covering the episode', () => {
    const mk = (name, range, local, sort) => ({ id: name, name, episode_range: range, local_path: local, sort_order: sort });
    const list = [
      mk('无图', '[2]', null, 0),
      mk('城里', '[2,3]', 'p/w1.png', 1),
      mk('岛上A', '[5,9]', 'p/w2.png', 2),
      mk('岛上B', '[5]', 'p/w3.png', 3),
      mk('全剧', null, 'p/w4.png', 4),
    ];
    assert.equal(headBody.wardrobeForEpisode(list, 1), null);
    assert.equal(headBody.wardrobeForEpisode(list, 2).name, '城里', 'a wardrobe without an image is skipped');
    assert.equal(headBody.wardrobeForEpisode(list, 3).name, '城里', 'range includes both ends');
    assert.equal(headBody.wardrobeForEpisode(list, 4), null);
    assert.equal(headBody.wardrobeForEpisode(list, 5).name, '岛上A', 'first by sort order');
    assert.equal(headBody.wardrobeForEpisode(list, 10), null, 'no range means never picked automatically');
    assert.equal(headBody.coversEpisode('not json', 1), false);
    const main = { id: 1, local_path: 'p/main.png' };
    assert.equal(headBody.referenceRow(main, list, 4), main);
    assert.equal(headBody.referenceRow(main, list, 3).local_path, 'p/w1.png');
  });

  it('episode payload and storyboard image refs use the episode reference', async () => {
    const { main } = await headBodyCharacter();
    const now = new Date().toISOString();
    const ep2 = db.prepare('INSERT INTO episodes (drama_id, episode_number, title, created_at, updated_at) VALUES (?, 2, ?, ?, ?)').run(ids.dramaId, '第2集', now, now).lastInsertRowid;
    for (const ep of [ids.episodeId, ep2]) db.prepare('INSERT INTO episode_characters (episode_id, character_id) VALUES (?, ?)').run(ep, ids.linId);
    const w = assetVariantService.create(db, 'wardrobe', ids.linId, { name: '岛上', change_phrase: '草帽', episode_range: [2, 2] });
    db.prepare(`UPDATE character_wardrobes SET local_path = 'p/characters/island.png' WHERE id = ?`).run(w.id);

    const drama = require('../src/services/dramaService').getDrama(db, ids.dramaId);
    const byNumber = Object.fromEntries(drama.episodes.map((e) => [e.episode_number, e.characters.find((c) => c.id === ids.linId)]));
    assert.equal(byNumber[1].episode_reference, null);
    assert.equal(byNumber[1].head_body, true);
    assert.deepEqual(byNumber[2].episode_reference, { wardrobe_id: w.id, wardrobe_name: '岛上', local_path: 'p/characters/island.png', image_url: null });
    assert.equal(byNumber[2].local_path, main, 'the main image itself is untouched');

    // 分镜图生成：第 2 集的分镜取造型图，第 1 集取主图
    const sb2 = db.prepare(`INSERT INTO storyboards (episode_id, storyboard_number, title, characters, created_at, updated_at) VALUES (?, 1, '登岛', ?, ?, ?)`)
      .run(ep2, JSON.stringify([ids.linId]), now, now).lastInsertRowid;
    const refsFor = async (storyboardId) => {
      const gen = db.prepare(`INSERT INTO image_generations (drama_id, storyboard_id, prompt, status, created_at, updated_at) VALUES (?, ?, '画面', 'pending', ?, ?)`)
        .run(ids.dramaId, storyboardId, now, now).lastInsertRowid;
      let sent = null;
      imageClient.callImageApi = async (_db, _log, opts) => { sent = opts; return { error: 'stop' }; };
      aiClient.generateText = async () => { throw new Error('offline'); };
      imageClient.getDefaultImageConfig = () => ({ provider: 'openai', model: 'test-image' });
      await require('../src/services/imageService').processImageGeneration(db, noopLog, gen);
      return sent ? sent.reference_image_urls || [] : null;
    };
    assert.ok((await refsFor(sb2)).includes('p/characters/island.png'));
    const ep1Refs = await refsFor(ids.sbLegacy);
    assert.ok(ep1Refs.includes(main) && !ep1Refs.includes('p/characters/island.png'));

    // 结构化分镜：未指定造型时取本集造型图，写明的造型仍以它为准
    const ir = sampleIr(ids);
    ir.cast = [{ character_id: ids.linId, wardrobe_id: null, alias: '林远' }];
    ir.shots = ir.shots.map((shot) => ({ ...shot, subjects: shot.subjects.filter((x) => x.alias === '林远'), lines: shot.lines.filter((l) => l.speaker === '林远') }));
    db.prepare('UPDATE storyboards SET episode_id = ? WHERE id = ?').run(ep2, ids.sbIr);
    storyboardService.saveSegmentIr(db, noopLog, ids.sbIr, ir);
    const compiledRefs = () => withSeedance(() => segmentCompileService.compileStoryboard(db, ids.sbIr)).compiled.refs.map((r) => r.url);
    assert.ok(compiledRefs().includes(`${BASE}/p/characters/island.png`), 'episode wardrobe is the default');
    const suit = assetVariantService.create(db, 'wardrobe', ids.linId, { name: '西装', change_phrase: '西装' });
    db.prepare(`UPDATE character_wardrobes SET local_path = 'p/characters/suit.png' WHERE id = ?`).run(suit.id);
    ir.cast[0].wardrobe_id = suit.id;
    storyboardService.saveSegmentIr(db, noopLog, ids.sbIr, ir);
    assert.ok(compiledRefs().includes(`${BASE}/p/characters/suit.png`), 'an explicit wardrobe still wins');

    // 工作台视觉快照：第 2 集分镜的人物图摘要就是造型图的内容摘要
    await png('p/characters/island.png', 64, 64, { r: 0, g: 200, b: 0 });
    const digest = (rel) => require('crypto').createHash('sha256').update(fs.readFileSync(path.join(root, rel))).digest('hex');
    const { readWorkbench } = require('../src/services/workbenchContinuity');
    const shotImages = () => readWorkbench(db, ids.dramaId, root, '').episodes.flatMap((e) => e.shots).find((s) => s.id === sb2).current.visual_images;
    const characterDigest = () => shotImages().find(([label]) => label.startsWith('角色 · 林远') && label.endsWith('主图'))[1];
    assert.equal(characterDigest(), digest('p/characters/island.png'));
    db.prepare(`UPDATE character_wardrobes SET episode_range = '[3]' WHERE id = ?`).run(w.id);
    assert.equal(characterDigest(), digest(main), 'outside the range the snapshot follows the main image');
  });

  it('export and import keep head-body mode', async () => {
    const { main } = await headBodyCharacter();
    const w = assetVariantService.create(db, 'wardrobe', ids.linId, { name: '岛上', change_phrase: '草帽' });
    const wBody = await png('p/characters/wbody.png', 896, 512, { r: 0, g: 200, b: 0 });
    db.prepare('UPDATE character_wardrobes SET body_local_path = ?, local_path = ? WHERE id = ?')
      .run(wBody, await headBody.composeSheet(cfg, 'p/characters/head.png', wBody), w.id);

    const { exportDrama } = require('../src/services/dramaExportService');
    const { importDrama } = require('../src/services/dramaImportService');
    const { buffer } = await exportDrama(db, cfg, noopLog, ids.dramaId);
    const pack = JSON.parse(new AdmZip(buffer).getEntry('project.json').getData().toString('utf8'));
    const lin = pack.characters.find((c) => c.name === '林远');
    assert.ok(lin.head_file && lin.body_file);
    assert.ok(lin.wardrobes[0].body_file);

    const out = await importDrama(db, cfg, noopLog, buffer);
    const newId = out.drama_id ?? out.id ?? out.drama?.id;
    const c = db.prepare(`SELECT * FROM characters WHERE drama_id = ? AND name = '林远'`).get(newId);
    assert.ok(headBody.isHeadBody(c), 'imported character is still head-body');
    assert.deepEqual(fs.readFileSync(path.join(root, c.local_path)), fs.readFileSync(path.join(root, main)));
    const iw = db.prepare('SELECT * FROM character_wardrobes WHERE character_id = ?').get(c.id);
    assert.equal(iw.local_path, headBody.composedPath(c.head_local_path, iw.body_local_path));
    assert.ok(fs.existsSync(path.join(root, iw.local_path)));

    const hr = db.prepare(`SELECT * FROM characters WHERE drama_id = ? AND name = '人事'`).get(newId);
    assert.equal(hr.head_local_path, null, 'characters without head-body import as before');
  });

  it('library round trip keeps head-body mode', async () => {
    const { head, body, main } = await headBodyCharacter();
    const added = characterLibraryService.addCharacterToLibrary(db, noopLog, ids.linId);
    assert.ok(added.ok);
    assert.equal(added.item.head_local_path, head);
    assert.equal(added.item.body_local_path, body);
    assert.ok(characterLibraryService.applyLibraryItemToCharacter(db, noopLog, ids.hrId, added.item.id).ok);
    const hr = character(ids.hrId);
    assert.ok(headBody.isHeadBody(hr));
    assert.equal(hr.local_path, main);

    db.prepare(`UPDATE characters SET local_path = 'p/characters/upload.png' WHERE id = ?`).run(ids.linId);
    const again = characterLibraryService.addCharacterToMaterialLibrary(db, noopLog, ids.linId);
    assert.equal(again.item.head_local_path, null, 'a replaced main image does not carry the old head into the library');
  });
});
