const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const aiClient = require('../src/services/aiClient');
const dramaService = require('../src/services/dramaService');
const storyboardService = require('../src/services/storyboardService');
const assetVariantService = require('../src/services/assetVariantService');
const { proposeForEpisode } = require('../src/services/assetStateProposalService');
const { runStructuredStoryboardGeneration, runStructuredConversion } = require('../src/services/structuredStoryboardService');
const { compileSegment } = require('../src/services/segmentCompile');
const { lintText, lintSegment, lintDialogueFidelity } = require('../src/services/segmentCompile/lint');
const { getVideoCaps, promptChars } = require('../src/services/modelCapabilities');
const { parseSegmentIr } = require('../src/services/segmentIr/schema');
const rules = require('../src/services/segmentCompile/rules/storyboardRules');
const P = require('../src/services/segmentCompile/rules/phrases');
const dramaRoutes = require('../src/routes/drama');
const { createIrTestDb, sampleIr, mockRes, noopLog } = require('./helpers/segmentIrFixtures');

const SCRIPT = '人事（公式化）：签个字吧。\n林远：是因为绩效吗？\n林远（os）：果然轮到我了。';
let db, ids, saved, calls;

beforeEach(() => {
  ({ db, ids } = createIrTestDb());
  db.prepare('UPDATE episodes SET script_content = ? WHERE id = ?').run(SCRIPT, ids.episodeId);
  saved = { gen: aiClient.generateText };
  calls = [];
});
afterEach(() => { aiClient.generateText = saved.gen; });

/** 让模型调用返回固定文本，并记下发出的提示词 */
function replyWith(text) {
  aiClient.generateText = async (_db, _log, _type, user, system) => {
    calls.push({ user, system });
    return typeof text === 'function' ? text() : text;
  };
}

function metadataOf(dramaId) {
  return JSON.parse(db.prepare('SELECT metadata FROM dramas WHERE id = ?').get(dramaId).metadata || '{}');
}

function storyboardState() {
  return db.prepare('SELECT id, storyboard_number, segment_ir, deleted_at, adopted_video_generation_id, dialogue FROM storyboards WHERE episode_id = ? ORDER BY id').all(ids.episodeId);
}

function addStoryboard(number, extra = {}) {
  const now = new Date().toISOString();
  return Number(db.prepare(
    `INSERT INTO storyboards (episode_id, storyboard_number, title, duration, dialogue, action, characters, scene_id, universal_segment_text, creation_mode, created_at, updated_at)
     VALUES (?, ?, ?, 5, ?, ?, ?, ?, ?, 'universal', ?, ?)`
  ).run(ids.episodeId, number, `镜${number}`, extra.dialogue || '林远：是因为绩效吗？', extra.action || '林远眼神空洞地看着协议',
    JSON.stringify([ids.linId]), ids.sceneId, '分镜1： 5秒: 林远悲伤地低头', now, now).lastInsertRowid);
}

/** 给分镜挂一条已采用的视频，使其成为受保护镜头 */
function adoptTake(storyboardId) {
  const now = new Date().toISOString();
  const take = Number(db.prepare(
    `INSERT INTO video_generations (drama_id, storyboard_id, provider, prompt, status, created_at, updated_at) VALUES (?, ?, 'test', 'p', 'completed', ?, ?)`
  ).run(ids.dramaId, storyboardId, now, now).lastInsertRowid);
  db.prepare('UPDATE storyboards SET adopted_video_generation_id = ? WHERE id = ?').run(take, storyboardId);
  return take;
}

function segment(overrides = {}) {
  const ir = sampleIr(ids);
  ir.shots = [ir.shots[0]];
  ir.shots[0].seconds = 5;
  ir.duration_s = 5;
  return { ...ir, ...overrides };
}

function otherDramaScene() {
  const now = new Date().toISOString();
  const dramaId = db.prepare('INSERT INTO dramas (title, created_at, updated_at) VALUES (?, ?, ?)').run('别的剧', now, now).lastInsertRowid;
  return Number(db.prepare('INSERT INTO scenes (drama_id, location, time, created_at, updated_at) VALUES (?, ?, ?, ?, ?)').run(dramaId, '别处', '夜', now, now).lastInsertRowid);
}

describe('shot package as the input standard', () => {
  it('new projects default to structured storyboards', async () => {
    const created = dramaService.createDrama(db, noopLog, { title: '新剧' });
    assert.equal(metadataOf(created.id).storyboard_structured, true);
    const optedOut = dramaService.createDrama(db, noopLog, { title: '旧习惯', metadata: { storyboard_structured: false } });
    assert.equal(metadataOf(optedOut.id).storyboard_structured, false, 'an explicit choice is kept');
    assert.equal(metadataOf(ids.dramaId).storyboard_structured, undefined, 'existing projects keep their setting');

    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'shotpkg-'));
    try {
      const cfg = { app: { name: 'test' }, storage: { local_path: root, base_url: 'http://localhost:5679/static' } };
      const { buffer } = await require('../src/services/dramaExportService').exportDrama(db, cfg, noopLog, ids.dramaId);
      const out = await require('../src/services/dramaImportService').importDrama(db, cfg, noopLog, buffer);
      const importedId = out.drama_id ?? out.id ?? out.drama?.id;
      assert.equal(metadataOf(importedId).storyboard_structured, undefined, 'imported projects keep the exported setting');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('proposes scene states and wardrobes from the episode script without saving', async () => {
    const foreignScene = otherDramaScene();
    replyWith(JSON.stringify({
      scene_states: [
        { scene_id: ids.sceneId, name: '夜·台灯', state_phrase: '夜晚，只有桌上台灯亮着' },
        { scene_id: foreignScene, name: '别处夜', state_phrase: '不属于本剧' },
      ],
      wardrobes: [
        { character_id: ids.linId, name: '西装', change_phrase: '深灰西装，白衬衫' },
        { character_id: 99999, name: '路人', change_phrase: '不存在的角色' },
      ],
    }));
    const out = await proposeForEpisode(db, noopLog, ids.episodeId);
    assert.deepEqual(out.scene_states, [{ scene_id: ids.sceneId, scene_name: '会议室', name: '夜·台灯', state_phrase: '夜晚，只有桌上台灯亮着' }]);
    assert.deepEqual(out.wardrobes, [{ character_id: ids.linId, character_name: '林远', name: '西装', change_phrase: '深灰西装，白衬衫', episode_range: [1] }]);
    assert.ok(calls[0].user.includes(SCRIPT) && calls[0].user.includes('会议室'), 'the script and scene list reach the model');
    assert.match(calls[0].system, /一时的处境不是造型/);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM scene_states').get().n, 0, 'nothing is saved');
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM character_wardrobes').get().n, 0);

    replyWith('这不是 JSON');
    await assert.rejects(proposeForEpisode(db, noopLog, ids.episodeId), (e) => e.code === 'proposal_invalid');
    aiClient.generateText = async () => { throw new Error('模型超时'); };
    await assert.rejects(proposeForEpisode(db, noopLog, ids.episodeId), /模型超时/);
    db.prepare("UPDATE episodes SET script_content = '', description = '' WHERE id = ?").run(ids.episodeId);
    calls = [];
    replyWith('{}');
    await assert.rejects(proposeForEpisode(db, noopLog, ids.episodeId), (e) => e.code === 'script_empty');
    assert.equal(calls.length, 0, 'no model call without a script');
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM scene_states').get().n, 0);

    const routes = dramaRoutes(db, {}, noopLog);
    const empty = mockRes();
    await routes.proposeAssetStates({ params: { episode_id: String(ids.episodeId) }, body: {} }, empty);
    assert.equal(empty.statusCode, 400);
    const missing = mockRes();
    await routes.proposeAssetStates({ params: { episode_id: '99999' }, body: {} }, missing);
    assert.equal(missing.statusCode, 404);
    db.prepare('UPDATE episodes SET script_content = ? WHERE id = ?').run(SCRIPT, ids.episodeId);
    replyWith('{"scene_states": "oops"}');
    const invalid = mockRes();
    await routes.proposeAssetStates({ params: { episode_id: String(ids.episodeId) }, body: {} }, invalid);
    assert.equal(invalid.statusCode, 422);

    replyWith(JSON.stringify({ scene_states: [], wardrobes: [{ character_id: ids.linId, name: '西装', change_phrase: '深灰西装', episode_range: [] }] }));
    const emptyRange = await proposeForEpisode(db, noopLog, ids.episodeId);
    assert.deepEqual(emptyRange.wardrobes.map((w) => w.episode_range), [[1]], 'an empty range means this episode');
  });

  it('proposals skip variants that already exist', async () => {
    assetVariantService.create(db, 'scene_state', ids.sceneId, { name: '夜·台灯', state_phrase: '夜晚，只有桌上台灯亮着' });
    assetVariantService.create(db, 'wardrobe', ids.linId, { name: '西装', change_phrase: '深灰西装，白衬衫', episode_range: [1] });
    replyWith(JSON.stringify({
      scene_states: [
        { scene_id: ids.sceneId, name: '夜·台灯', state_phrase: '换个说法也算同名' },
        { scene_id: ids.sceneId, name: '清晨', state_phrase: '清晨，窗外灰白天光' },
        { scene_id: ids.sceneId, name: '清晨', state_phrase: '清晨，窗外灰白天光' },
      ],
      wardrobes: [{ character_id: ids.linId, name: '另一身', change_phrase: '深灰西装，白衬衫' }],
    }));
    const out = await proposeForEpisode(db, noopLog, ids.episodeId);
    assert.deepEqual(out.scene_states.map((s) => s.name), ['清晨'], 'existing and repeated proposals are dropped');
    assert.deepEqual(out.wardrobes, [], 'same outfit under another name is still a duplicate');
    assert.ok(calls[0].user.includes('夜·台灯') && calls[0].user.includes('深灰西装'), 'the model sees what already exists');
  });

  it('structured generation binds states that belong to the scene and character', async () => {
    const night = assetVariantService.create(db, 'scene_state', ids.sceneId, { name: '夜·台灯', state_phrase: '夜晚，只有桌上台灯亮着' });
    const suit = assetVariantService.create(db, 'wardrobe', ids.linId, { name: '西装', change_phrase: '深灰西装' });
    const hrCoat = assetVariantService.create(db, 'wardrobe', ids.hrId, { name: '风衣', change_phrase: '米色风衣' });
    const foreignState = assetVariantService.create(db, 'scene_state', otherDramaScene(), { name: '别处夜', state_phrase: '别处' });
    const later = assetVariantService.create(db, 'wardrobe', ids.linId, { name: '岛上装', change_phrase: '草帽', episode_range: [2, 3] });
    const portrait = assetVariantService.create(db, 'scene_state', ids.sceneId, { name: '竖屏机位', kind: 'portrait', state_phrase: '竖版取景' });

    const bound = segment();
    bound.scene.state_id = night.id;
    bound.cast[0].wardrobe_id = suit.id;
    replyWith(JSON.stringify([bound]));
    const result = await runStructuredStoryboardGeneration(db, noopLog, ids.episodeId, {});
    assert.match(calls[0].user, /场景状态列表：.*夜·台灯/);
    assert.match(calls[0].user, /造型列表：.*西装/);
    assert.match(calls[0].user, /本集是第 1 集/);
    assert.ok(!calls[0].user.includes('岛上装'), 'wardrobes scoped to other episodes are not offered');
    assert.ok(!calls[0].user.includes('竖屏机位'), 'camera variants are not offered as states');
    const stored = JSON.parse(db.prepare('SELECT segment_ir FROM storyboards WHERE id = ?').get(result.storyboard_ids[0]).segment_ir);
    assert.equal(stored.scene.state_id, night.id);
    assert.equal(stored.cast[0].wardrobe_id, suit.id);

    const before = JSON.stringify(storyboardState());
    const wrongScene = segment();
    wrongScene.scene.state_id = foreignState.id;
    replyWith(JSON.stringify([wrongScene]));
    await assert.rejects(runStructuredStoryboardGeneration(db, noopLog, ids.episodeId, {}), /不属于场景/);
    const wrongPerson = segment();
    wrongPerson.cast[0].wardrobe_id = hrCoat.id;
    replyWith(JSON.stringify([wrongPerson]));
    await assert.rejects(runStructuredStoryboardGeneration(db, noopLog, ids.episodeId, {}), /不属于角色/);
    const otherEpisode = segment();
    otherEpisode.cast[0].wardrobe_id = later.id;
    replyWith(JSON.stringify([otherEpisode]));
    await assert.rejects(runStructuredStoryboardGeneration(db, noopLog, ids.episodeId, {}), /不属于角色/);
    const cameraVariant = segment();
    cameraVariant.scene.state_id = portrait.id;
    replyWith(JSON.stringify([cameraVariant]));
    await assert.rejects(runStructuredStoryboardGeneration(db, noopLog, ids.episodeId, {}), /不属于场景/);
    assert.equal(JSON.stringify(storyboardState()), before, 'a rejected generation writes nothing');
  });

  it('scene reference governs light only when a state is bound', () => {
    const caps = getVideoCaps({ protocol: 'volcengine_omni', model: 'doubao-seedance-2-0-260128' });
    const ctx = (sceneStates) => ({
      caps,
      style: { video: '水彩' },
      bindings: {
        characters: { [ids.linId]: { name: '林远', role: 'main', image_url: 'http://h/lin.png' }, [ids.hrId]: { name: '人事', image_url: 'http://h/hr.png' } },
        scenes: { [ids.sceneId]: { name: '会议室', image_url: 'http://h/master.png' } },
        sceneStates,
      },
    });
    const ir = (stateId) => parseSegmentIr({ ...sampleIr(ids), scene: { scene_id: ids.sceneId, state_id: stateId, setting: '深夜，只有台灯亮着' } }).ir;
    const sceneRef = (out) => out.refs.find((r) => r.kind === 'scene');

    const withState = compileSegment(ir(7), ctx({ 7: { name: '夜·台灯', image_url: 'http://h/night.png' } }));
    assert.equal(sceneRef(withState).url, 'http://h/night.png');
    assert.ok(withState.prompt.includes(P.refScene(sceneRef(withState).token, '会议室')));

    const masterOnly = compileSegment(ir(null), ctx({}));
    assert.equal(sceneRef(masterOnly).url, 'http://h/master.png');
    assert.ok(masterOnly.prompt.includes(P.refSceneLayout(sceneRef(masterOnly).token, '会议室')));
    assert.ok(!masterOnly.prompt.includes('光线一律照这张图'));

    const stateWithoutImage = compileSegment(ir(7), ctx({ 7: { name: '夜·台灯', image_url: null } }));
    assert.equal(sceneRef(stateWithoutImage).url, 'http://h/master.png', 'falls back to the master for layout');
    assert.ok(stateWithoutImage.prompt.includes(P.refSceneLayout(sceneRef(stateWithoutImage).token, '会议室')));
    assert.ok(stateWithoutImage.findings.some((f) => f.code === 'state_image_missing'));

    // 提示词超长：状态图已给出光线时才省略「光线与时段」；只有母版时它是唯一的光线信息，保留
    const tight = (sceneStates, prompt) => ({ ...ctx(sceneStates), caps: { ...caps, maxPromptChars: promptChars(prompt) - 1 } });
    const trimmed = compileSegment(ir(7), tight({ 7: { name: '夜·台灯', image_url: 'http://h/night.png' } }, withState.prompt));
    assert.ok(!trimmed.prompt.includes('光线与时段'));
    assert.ok(trimmed.findings.some((f) => f.code === 'prompt_trimmed' && f.msg.includes('光线与时段')));
    const kept = compileSegment(ir(null), tight({}, masterOnly.prompt));
    assert.ok(kept.prompt.includes('光线与时段：午后，冷白顶光。'), 'the only light description is never dropped');
    assert.ok(!kept.findings.some((f) => f.code === 'prompt_trimmed'));
    assert.ok(kept.findings.some((f) => f.code === 'prompt_too_long' && f.level === 'block'));

    // 首尾帧模式：画面从首帧图出发，光线由首帧给出，超长时可以省略「光线与时段」
    assert.equal(caps.firstLastFrame, true, 'precondition: the model supports first/last frames');
    const firstLast = parseSegmentIr({ ...sampleIr(ids), continuity: { mode: 'first_last', first_frame_image_id: 50 } }).ir;
    const flCtx = { ...ctx({}), bindings: { ...ctx({}).bindings, images: { 50: 'http://h/first.png' } } };
    const flFull = compileSegment(firstLast, flCtx);
    const flTrimmed = compileSegment(firstLast, { ...flCtx, caps: { ...caps, maxPromptChars: promptChars(flFull.prompt) - 1 } });
    assert.ok(flTrimmed.findings.some((f) => f.code === 'prompt_trimmed'));
    assert.ok(!flTrimmed.findings.some((f) => f.level === 'block'), JSON.stringify(flTrimmed.findings));

    // 绑定的造型还没出图：退回角色主图并提示，不丢掉这个人的参考图
    const dressed = parseSegmentIr(sampleIr(ids)).ir;
    dressed.cast[0].wardrobe_id = 9;
    const noImage = compileSegment(dressed, { ...ctx({}), bindings: { ...ctx({}).bindings, wardrobes: { 9: { name: '西装', image_url: null } } } });
    assert.ok(noImage.refs.some((r) => r.kind === 'character' && r.url === 'http://h/lin.png'), 'falls back to the character image');
    assert.ok(noImage.findings.some((f) => f.code === 'wardrobe_image_missing' && f.level === 'warn' && f.msg.includes('改用本集参考图')));
    // 首尾帧模式不发角色参考图，没有「退回」可言，不提示
    const dressedFirstLast = parseSegmentIr({ ...sampleIr(ids), continuity: { mode: 'first_last', first_frame_image_id: 50 } }).ir;
    dressedFirstLast.cast[0].wardrobe_id = 9;
    const flNoImage = compileSegment(dressedFirstLast, { ...flCtx, bindings: { ...flCtx.bindings, wardrobes: { 9: { name: '西装', image_url: null } } } });
    assert.ok(!flNoImage.findings.some((f) => f.code === 'wardrobe_image_missing'));
  });

  it('prompts describe behaviour instead of emotion labels', () => {
    const caps = getVideoCaps({ protocol: 'volcengine_omni', model: 'doubao-seedance-2-0-260128' });
    assert.equal(caps.nativeAudio, true, 'precondition: spoken lines are compiled');
    const system = rules.systemPrompt(caps);
    assert.ok(!system.includes('光线与情绪') && !system.includes('说话的样子'));
    assert.match(system, /"tone": "这一段的光线与时段/);
    assert.match(system, /"delivery": "音量、语速、停顿/);

    const ir = parseSegmentIr({ ...sampleIr(ids), tone: '午后，冷白顶光' }).ir;
    ir.shots[0].lines[0].delivery = '压低声音';
    const out = compileSegment(ir, {
      caps,
      style: { video: '水彩' },
      bindings: { characters: { [ids.linId]: { name: '林远', image_url: 'http://h/lin.png' }, [ids.hrId]: { name: '人事', image_url: 'http://h/hr.png' } }, scenes: { [ids.sceneId]: { name: '会议室', image_url: 'http://h/room.png' } } },
    });
    assert.ok(out.prompt.includes('光线与时段：午后，冷白顶光。'));
    assert.ok(!out.prompt.includes('整段基调'));
    assert.ok(out.prompt.includes('开口（压低声音），嘴型与每个字对齐'));
    assert.ok(!/地开口/.test(out.prompt));
  });

  it('warns on emotion labels outside dialogue', () => {
    assert.deepEqual(lintText('林远眼神空洞地盯着屏幕').map((f) => f.code), ['emotion_label']);
    assert.deepEqual(lintText('林远把杯子推到桌角，停了两秒'), []);
    const ir = parseSegmentIr(sampleIr(ids)).ir;
    ir.shots[0].action = '人事悲伤地把协议推过桌面';
    ir.shots[1].lines[0].text = '我真的很难过。';
    const caps = getVideoCaps({ protocol: 'volcengine_omni', model: 'doubao-seedance-2-0-260128' });
    const emotion = lintSegment(ir, null, caps).filter((f) => f.code === 'emotion_label');
    assert.deepEqual(emotion.map((f) => f.where.path), ['shots.0.action'], 'dialogue text is never flagged');
    assert.ok(emotion.every((f) => f.level === 'warn'));
  });

  it('structured regeneration keeps protected shots', async () => {
    const take = adoptTake(ids.sbLegacy);
    db.prepare('UPDATE storyboards SET dialogue = ? WHERE id = ?').run('林远：是因为绩效吗？', ids.sbLegacy);
    const segA = segment();
    const segB = segment({ main_move: '跟拍' });
    replyWith(JSON.stringify([segA, segB]));
    const result = await runStructuredStoryboardGeneration(db, noopLog, ids.episodeId, {});
    const live = db.prepare('SELECT id, storyboard_number, adopted_video_generation_id, segment_ir FROM storyboards WHERE episode_id = ? AND deleted_at IS NULL ORDER BY storyboard_number').all(ids.episodeId);
    const kept = live.find((r) => r.id === ids.sbLegacy);
    assert.ok(kept, 'the protected shot survives');
    assert.equal(kept.storyboard_number, 2);
    assert.equal(kept.adopted_video_generation_id, take);
    assert.equal(kept.segment_ir, null, 'its content is untouched');
    assert.deepEqual(result.preserved_shot_ids, [ids.sbLegacy]);
    assert.equal(live.filter((r) => r.storyboard_number === 2).length, 1, 'the new segment at the same number is dropped');
    assert.equal(result.storyboard_ids.length, 1);
    assert.ok(!live.some((r) => r.id === ids.sbIr), 'unprotected shots are replaced');
    const missing = result.findings.filter((f) => f.code === 'line_missing').map((f) => f.msg);
    assert.ok(missing.some((m) => m.includes('果然轮到我了')), 'a line nobody covers is still reported');
    assert.ok(!missing.some((m) => m.includes('是因为绩效吗')), 'a line kept in a preserved legacy shot is not reported missing');
    // 短台词不能因为旧镜头里碰巧含有同一个字就算覆盖
    const shortScript = '甲：嗯。\n乙：好的。';
    const shortMissing = (covered) => lintDialogueFidelity([], shortScript, { coveredText: covered }).filter((f) => f.code === 'line_missing').length;
    assert.equal(shortMissing(['丙：嗯嗯你说，好的吧']), 2, 'a stray character does not cover a short line');
    assert.equal(shortMissing(['甲：嗯。', '乙："好的。"']), 0, 'a short line kept verbatim is covered');

    const before = JSON.stringify(storyboardState());
    replyWith(() => {
      db.prepare("UPDATE storyboards SET updated_at = '2099-01-01' WHERE id = ?").run(ids.sbLegacy);
      return JSON.stringify([segA]);
    });
    await assert.rejects(runStructuredStoryboardGeneration(db, noopLog, ids.episodeId, {}), /被编辑/);
    const after = JSON.parse(JSON.stringify(storyboardState()));
    assert.deepEqual(after.map((r) => [r.id, r.deleted_at, r.segment_ir]), JSON.parse(before).map((r) => [r.id, r.deleted_at, r.segment_ir]), 'nothing replaced');

    db.prepare('UPDATE storyboards SET creative_review_lock = ? WHERE id = ?').run(JSON.stringify({ dialogue: '已确认' }), result.storyboard_ids[0]);
    const locked = mockRes();
    await dramaRoutes(db, {}, noopLog).generateStoryboard({ params: { episode_id: String(ids.episodeId) }, body: { structured: true } }, locked);
    assert.equal(locked.statusCode, 409, 'a locked shot is reported before any background task starts');
  });

  it('converts legacy storyboards in place and keeps protected shots', async () => {
    const settings = { aspect_ratio: '9:16', style_prompt_zh: '水彩画风', creative_direction: { enabled: true, facts: '海岛', revision: 1 } };
    db.prepare('UPDATE dramas SET metadata = ? WHERE id = ?').run(JSON.stringify(settings), ids.dramaId);
    db.prepare('UPDATE episodes SET duration = 0 WHERE id = ?').run(ids.episodeId);
    storyboardService.saveSegmentIr(db, noopLog, ids.sbIr, segment());
    const take = adoptTake(ids.sbLegacy);
    const sb3 = addStoryboard(3);
    const sb4 = addStoryboard(4);
    const legacyDialogue = db.prepare('SELECT dialogue FROM storyboards WHERE id = ?').get(ids.sbLegacy).dialogue;
    const irBefore = db.prepare('SELECT segment_ir FROM storyboards WHERE id = ?').get(ids.sbIr).segment_ir;
    const untouched = () => db.prepare('SELECT segment_ir FROM storyboards WHERE id IN (?, ?)').all(sb3, sb4).every((r) => r.segment_ir === null);

    // 不合法的输出：整体失败，什么都不写
    const bad = [
      [{ ...segment(), storyboard_id: sb3 }],
      [{ ...segment(), storyboard_id: sb3 }, { ...segment(), storyboard_id: ids.sbLegacy }],
      [{ ...segment(), storyboard_id: sb3 }, { ...segment(), storyboard_id: sb3 }],
      [{ ...segment(), storyboard_id: sb3 }, { ...segment({ scene: { scene_id: otherDramaScene(), state_id: null, setting: '别处' } }), storyboard_id: sb4 }],
    ];
    for (const reply of bad) {
      replyWith(JSON.stringify(reply));
      await assert.rejects(runStructuredConversion(db, noopLog, ids.episodeId, {}), /转为结构化分镜失败/);
      assert.ok(untouched(), 'a rejected conversion writes nothing');
      assert.equal(metadataOf(ids.dramaId).storyboard_structured, undefined);
    }

    // 模型运行期间有镜头被采用或被锁定（不改 updated_at）：写入前重新核对，拒绝
    replyWith(() => {
      db.prepare('UPDATE storyboards SET adopted_video_generation_id = ? WHERE id = ?').run(take, sb3);
      return JSON.stringify([{ ...segment(), storyboard_id: sb3 }, { ...segment(), storyboard_id: sb4 }]);
    });
    await assert.rejects(runStructuredConversion(db, noopLog, ids.episodeId, {}), /被采用或标记保留/);
    assert.ok(untouched(), 'a shot adopted during conversion is not rewritten');
    db.prepare('UPDATE storyboards SET adopted_video_generation_id = NULL WHERE id = ?').run(sb3);
    replyWith(() => {
      db.prepare('UPDATE storyboards SET creative_review_lock = ? WHERE id = ?').run(JSON.stringify({ dialogue: '已确认' }), sb4);
      return JSON.stringify([{ ...segment(), storyboard_id: sb3 }, { ...segment(), storyboard_id: sb4 }]);
    });
    await assert.rejects(runStructuredConversion(db, noopLog, ids.episodeId, {}), /锁定镜头/);
    assert.ok(untouched(), 'a shot locked during conversion is not rewritten');

    const routes = dramaRoutes(db, {}, noopLog);
    const lockedRes = mockRes();
    routes.convertStructured({ params: { episode_id: String(ids.episodeId) }, body: {} }, lockedRes);
    assert.equal(lockedRes.statusCode, 409, 'a locked candidate is reported before any background task starts');
    db.prepare('UPDATE storyboards SET creative_review_lock = NULL WHERE id = ?').run(sb4);
    const missingRes = mockRes();
    routes.convertStructured({ params: { episode_id: '99999' }, body: {} }, missingRes);
    assert.equal(missingRes.statusCode, 404);

    // 转换期间有人编辑了分镜：拒绝写入
    replyWith(() => {
      db.prepare("UPDATE storyboards SET updated_at = '2099-01-01' WHERE id = ?").run(sb3);
      return JSON.stringify([{ ...segment(), storyboard_id: sb3 }, { ...segment(), storyboard_id: sb4 }]);
    });
    await assert.rejects(runStructuredConversion(db, noopLog, ids.episodeId, {}), /转换期间分镜已被编辑/);
    assert.ok(untouched(), 'an edit during conversion leaves the shots as they were');

    calls = [];
    replyWith(JSON.stringify([{ ...segment(), storyboard_id: sb4 }, { ...segment({ main_move: '跟拍' }), storyboard_id: sb3 }]));
    const out = await runStructuredConversion(db, noopLog, ids.episodeId, {});
    const sent = JSON.parse(calls[0].user.match(/已有分镜（共 2 条，逐条改写）：(.*)/)[1]);
    assert.deepEqual(sent.map((s) => s.storyboard_id), [sb3, sb4], 'only unprotected legacy shots are sent');
    assert.match(calls[0].system, /逐条改写成上面的段格式/);
    assert.deepEqual(out.converted_ids, [sb3, sb4]);
    assert.deepEqual(out.skipped_protected_ids, [ids.sbLegacy]);
    assert.deepEqual(out.skipped_structured_ids, [ids.sbIr]);
    const rows = db.prepare('SELECT id, storyboard_number, segment_ir, creation_mode, deleted_at FROM storyboards WHERE id IN (?, ?)').all(sb3, sb4);
    assert.deepEqual(rows.map((r) => [r.id, r.storyboard_number, !!r.segment_ir, r.creation_mode, r.deleted_at]), [[sb3, 3, true, 'classic', null], [sb4, 4, true, 'classic', null]]);
    const protectedRow = db.prepare('SELECT segment_ir, adopted_video_generation_id, dialogue FROM storyboards WHERE id = ?').get(ids.sbLegacy);
    assert.deepEqual(protectedRow, { segment_ir: null, adopted_video_generation_id: take, dialogue: legacyDialogue });
    assert.equal(db.prepare('SELECT segment_ir FROM storyboards WHERE id = ?').get(ids.sbIr).segment_ir, irBefore);
    assert.deepEqual(metadataOf(ids.dramaId), { ...settings, storyboard_structured: true }, 'the project switches to structured and keeps its other settings');
    assert.equal(db.prepare('SELECT duration FROM episodes WHERE id = ?').get(ids.episodeId).duration, 1, 'episode duration follows the converted shots');
    assert.ok(out.findings.some((f) => f.code === 'line_missing'), 'dialogue is checked against the script');

    calls = [];
    const again = await runStructuredConversion(db, noopLog, ids.episodeId, {});
    assert.equal(calls.length, 0, 'nothing left to convert, no model call');
    assert.deepEqual(again.converted_ids, []);
    assert.deepEqual(metadataOf(ids.dramaId), { ...settings, storyboard_structured: true }, 'a repeat conversion keeps the settings too');
  });
});
