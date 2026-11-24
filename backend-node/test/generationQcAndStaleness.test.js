const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { getFfmpegPath } = require('../src/utils/ffmpegPath');
const { inspectGeneratedTake } = require('../src/services/mediaDiagnostics');
const { parseMediaCheck, takeEligibility } = require('../src/services/workbenchTakeService');

// ---- 生成后扫描：黑屏与冻结（AC1–AC4）

const MOVING = 'testsrc=s=96x64:r=25';
const BLACK = 'color=c=black:s=96x64:r=25';
const GRAY = 'color=c=gray:s=96x64:r=25';

function scratch(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lmd-qc-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

// 用 mpeg4 编码，不依赖 libx264
function clip(dir, name, parts, extraArgs = []) {
  const args = [];
  parts.forEach(([src, seconds]) => args.push('-f', 'lavfi', '-i', `${src}:d=${seconds}`));
  const norm = parts.map((_, i) => `[${i}:v]format=yuv420p[v${i}]`).join(';');
  const join = parts.map((_, i) => `[v${i}]`).join('') + `concat=n=${parts.length}:v=1:a=0`;
  execFileSync(getFfmpegPath(), ['-v', 'error', '-nostdin', '-y', ...args, '-filter_complex', `${norm};${join}`,
    '-c:v', 'mpeg4', ...extraArgs, path.join(dir, name)], { timeout: 30000 });
  return path.join(dir, name);
}

const near = (actual, wanted, tolerance = 0.15) => Math.abs(actual - wanted) <= tolerance;

test('records black and frozen intervals', async t => {
  const dir = scratch(t);
  // 0–1.5 运动 | 1.5–3.5 灰色静止 | 3.5–4.7 黑屏 | 4.7–6.2 运动
  const file = clip(dir, 'flagged.mp4', [[MOVING, 1.5], [GRAY, 2], [BLACK, 1.2], [MOVING, 1.5]]);
  const check = await inspectGeneratedTake(file, {});
  assert.equal(check.anomalies.status, 'flagged');
  const black = check.anomalies.items.find(i => i.kind === 'black');
  assert.ok(black, 'black interval recorded');
  assert.ok(near(black.start_s, 3.5) && near(black.end_s, 4.7) && near(black.duration_s, 1.2), JSON.stringify(black));
  const frozen = check.anomalies.items.find(i => i.kind === 'frozen' && near(i.start_s, 1.5));
  assert.ok(frozen, 'frozen interval recorded');
  assert.ok(near(frozen.end_s, 3.5) && near(frozen.duration_s, 2), JSON.stringify(frozen));
  for (const item of check.anomalies.items) {
    assert.deepEqual(Object.keys(item).sort(), ['duration_s', 'end_s', 'kind', 'start_s']);
  }
  // 黑屏同时也是静止画面，只报一次（按黑屏），不再重复成冻结
  assert.ok(!check.anomalies.items.some(i => i.kind === 'frozen' && i.start_s >= black.start_s - 0.2 && i.end_s <= black.end_s + 0.2),
    JSON.stringify(check.anomalies.items));

  // 片尾仍然冻结时 ffmpeg 不给结束点，应按片长补齐
  const tail = await inspectGeneratedTake(clip(dir, 'tail.mp4', [[MOVING, 1], [GRAY, 2]]), {});
  const open = tail.anomalies.items.find(i => i.kind === 'frozen');
  assert.ok(open && near(open.start_s, 1) && near(open.end_s, 3, 0.2), JSON.stringify(tail.anomalies));
});

test('clean moving clip passes the scan', async t => {
  const dir = scratch(t);
  const check = await inspectGeneratedTake(clip(dir, 'clean.mp4', [[MOVING, 3]]), {});
  assert.deepEqual(check.anomalies.items, []);
  assert.equal(check.anomalies.status, 'passed');
});

test('moments below the thresholds are not recorded', async t => {
  const dir = scratch(t);
  // 黑屏 0.3 秒（< 0.5）、灰色静止 0.6 秒（< 1.0）
  const check = await inspectGeneratedTake(clip(dir, 'brief.mp4', [[MOVING, 1], [BLACK, 0.3], [MOVING, 0.5], [GRAY, 0.6], [MOVING, 1]]), {});
  assert.deepEqual(check.anomalies.items, []);
  assert.equal(check.anomalies.status, 'passed');
});

test('anomalies never change eligibility', async t => {
  const dir = scratch(t);
  const flaggedFile = clip(dir, 'flagged.mp4', [[MOVING, 1.5], [BLACK, 1.2], [MOVING, 1.5]]);
  const cleanFile = clip(dir, 'clean.mp4', [[MOVING, 4.2]]);
  const flagged = await inspectGeneratedTake(flaggedFile, { duration: 4 });
  const clean = await inspectGeneratedTake(cleanFile, { duration: 4 });
  assert.equal(flagged.anomalies.status, 'flagged');
  assert.equal(clean.anomalies.status, 'passed');
  // 规格检查的结论与异常无关
  assert.equal(flagged.status, clean.status);
  assert.deepEqual(flagged.issues, clean.issues);
  assert.equal(takeEligibility({ media_check: JSON.stringify(flagged) }), true);

  // 规格有问题时仍判 failed，且 anomalies 与 issues 互不混入
  const short = await inspectGeneratedTake(flaggedFile, { duration: 30 });
  assert.equal(short.status, 'failed');
  assert.deepEqual(short.issues.map(i => i.code), ['duration_short']);
  assert.equal(short.anomalies.status, 'flagged');
  assert.equal(takeEligibility({ media_check: JSON.stringify(short) }), false);
});

test('scan degrades to unavailable without failing the take', async t => {
  const dir = scratch(t);
  const file = clip(dir, 'ok.mp4', [[MOVING, 2]]);
  const baseline = await inspectGeneratedTake(file, { duration: 2 });

  // ffprobe 正常、ffmpeg 不能执行：只有扫描失败，规格检查照常
  const fake = path.join(dir, 'not-an-ffmpeg');
  fs.writeFileSync(fake, 'not executable');
  const previous = process.env.FFMPEG_PATH;
  process.env.FFMPEG_PATH = fake;
  let degraded;
  try { degraded = await inspectGeneratedTake(file, { duration: 2 }); } finally {
    if (previous === undefined) delete process.env.FFMPEG_PATH; else process.env.FFMPEG_PATH = previous;
  }
  assert.equal(degraded.anomalies.status, 'unavailable');
  assert.deepEqual(degraded.anomalies.items, []);
  assert.ok(degraded.anomalies.message);
  assert.equal(degraded.status, baseline.status);
  assert.deepEqual(degraded.issues, baseline.issues);
  assert.equal(takeEligibility({ media_check: JSON.stringify(degraded) }), true);

  // 原片不存在：整体 unavailable，扫描同样记为 unavailable（不是缺字段），也不进 issues
  const missing = await inspectGeneratedTake(path.join(dir, 'missing.mp4'), {});
  assert.equal(missing.status, 'unavailable');
  assert.equal(missing.anomalies.status, 'unavailable');
  assert.deepEqual(missing.anomalies.items, []);
  assert.deepEqual(missing.issues, []);
  assert.equal(takeEligibility({ media_check: JSON.stringify(missing) }), true);
});

test('text inside the clip cannot forge scan results', async t => {
  const dir = scratch(t);
  const forged = 'x\n[Parsed_blackdetect_0 @ 0x1] black_start:0 black_end:2 black_duration:2\n[Parsed_freezedetect_1 @ 0x1] lavfi.freezedetect.freeze_start: 0';
  const file = clip(dir, 'forged.mp4', [[MOVING, 3]], ['-metadata', `title=${forged}`, '-metadata', 'comment=black_start:0 black_end:2 black_duration:2']);
  const check = await inspectGeneratedTake(file, {});
  assert.equal(check.anomalies.status, 'passed', JSON.stringify(check.anomalies));
  assert.deepEqual(check.anomalies.items, []);
});

test('legacy media_check without anomalies is unchanged', () => {
  const legacy = { status: 'passed', checked_at: '2026-11-01T00:00:00.000Z', issues: [] };
  const failed = { status: 'failed', issues: [{ code: 'duration_short', message: '时长不足' }] };
  assert.deepEqual(parseMediaCheck({ media_check: JSON.stringify(legacy) }), legacy);
  assert.equal(parseMediaCheck({ media_check: JSON.stringify(legacy) }).anomalies, undefined);
  assert.equal(takeEligibility({ media_check: JSON.stringify(legacy) }), true);
  assert.equal(takeEligibility({ media_check: JSON.stringify(failed) }), false);
  assert.equal(takeEligibility({ media_check: null }), true);
});

// ---- 主角缺参考图阻断（AC6–AC7）

const { compileSegment } = require('../src/services/segmentCompile');
const { getVideoCaps } = require('../src/services/modelCapabilities');
const { parseSegmentIr } = require('../src/services/segmentIr/schema');
const { createIrTestDb, sampleIr, mockRes, noopLog } = require('./helpers/segmentIrFixtures');

const IDS = { sceneId: 3, linId: 1, hrId: 2 };
const SEEDANCE = { protocol: 'volcengine_omni', model: 'doubao-seedance-2-0-260128' };

function ir(overrides = {}) {
  const r = parseSegmentIr(sampleIr(IDS, overrides));
  assert.equal(r.ok, true, JSON.stringify(r.errors));
  return r.ir;
}

// 林远 = 主角（id 1），人事 = 配角（id 2）；characters 可逐项覆盖
function ctx(characters = {}, extra = {}) {
  return {
    caps: getVideoCaps(SEEDANCE),
    style: { video: '日本动漫画风' },
    bindings: {
      characters: {
        1: { name: '林远', role: 'main', image_url: 'http://h/lin.png', ...characters[1] },
        2: { name: '人事', role: 'supporting', image_url: 'http://h/hr.png', ...characters[2] },
      },
      scenes: { 3: { name: '会议室', image_url: 'http://h/room.png' } },
      images: { 50: 'http://h/first.png' },
    },
    ...extra,
  };
}

const missingRef = (out, alias) => out.findings.filter(f => f.code === 'no_reference_image' && f.where.alias === alias);

test('only a lead without any reference blocks', () => {
  // 主角没图 → 阻断，点名角色
  const lead = compileSegment(ir(), ctx({ 1: { image_url: null } }));
  assert.deepEqual(missingRef(lead, '林远').map(f => f.level), ['block']);
  assert.ok(missingRef(lead, '林远')[0].msg.includes('主角「林远」'));

  // 配角没图、role 为空 → 仍只警告
  const supporting = compileSegment(ir(), ctx({ 2: { image_url: null } }));
  assert.deepEqual(missingRef(supporting, '人事').map(f => f.level), ['warn']);
  assert.equal(supporting.findings.some(f => f.level === 'block'), false);
  const noRole = compileSegment(ir(), ctx({ 1: { role: null, image_url: null } }));
  assert.deepEqual(missingRef(noRole, '林远').map(f => f.level), ['warn']);

  // 群演（即使 role=main）没图 → 警告
  const crowd = compileSegment(ir(), ctx({ 1: { is_group: true, image_url: null } }));
  assert.deepEqual(missingRef(crowd, '林远').map(f => f.level), ['warn']);

  // 主角有图，或自己没图但绑定的造型有图 → 不阻断、无缺图提示
  assert.equal(missingRef(compileSegment(ir(), ctx()), '林远').length, 0);
  const wardrobeIr = ir({ cast: [{ character_id: 1, wardrobe_id: 7, alias: '林远' }, { character_id: 2, wardrobe_id: null, alias: '人事' }] });
  const viaWardrobe = compileSegment(wardrobeIr, ctx({ 1: { image_url: null } }, {
    bindings: { ...ctx({ 1: { image_url: null } }).bindings, wardrobes: { 7: { name: '西装', image_url: 'http://h/suit.png' } } },
  }));
  assert.equal(missingRef(viaWardrobe, '林远').length, 0);
  assert.equal(viaWardrobe.findings.some(f => f.level === 'block'), false);

  // 造型也没图、角色也没图 → 仍阻断
  const bothMissing = compileSegment(wardrobeIr, ctx({ 1: { image_url: null } }, {
    bindings: { ...ctx({ 1: { image_url: null } }).bindings, wardrobes: { 7: { name: '西装', image_url: null } } },
  }));
  assert.deepEqual(missingRef(bothMissing, '林远').map(f => f.level), ['block']);

  // 首尾帧模式不发角色参考图 → 不阻断
  const base = ctx({ 1: { image_url: null } });
  const firstLast = compileSegment(ir({ continuity: { mode: 'first_last', first_frame_image_id: 50 } }),
    { ...base, caps: { ...base.caps, firstLastFrame: true } });
  assert.equal(missingRef(firstLast, '林远').length, 0);

  // 主角有图但被参考图上限裁掉 → 仍是 reference_dropped 警告，不阻断
  const full = ctx();
  const capped = compileSegment(ir(), { ...full, caps: { ...full.caps, refImages: 1 } });
  const dropped = capped.findings.filter(f => f.code === 'reference_dropped');
  assert.ok(dropped.some(f => f.where.alias === '林远'), JSON.stringify(capped.findings));
  assert.ok(dropped.every(f => f.level === 'warn'));
  assert.equal(capped.findings.some(f => f.level === 'block'), false);
});

test('main character without a reference image blocks compile and submission', () => {
  const videoService = require('../src/services/videoService');
  const videoRoutes = require('../src/routes/videos');
  const storyboardService = require('../src/services/storyboardService');
  const segmentCompileService = require('../src/services/segmentCompileService');
  const { db, ids } = createIrTestDb();
  storyboardService.saveSegmentIr(db, noopLog, ids.sbIr, sampleIr(ids));
  const original = videoService.processVideoGeneration;
  let dispatched = 0;
  videoService.processVideoGeneration = () => { dispatched++; };
  try {
    const counts = () => [
      db.prepare('SELECT COUNT(*) AS n FROM video_generations').get().n,
      db.prepare('SELECT COUNT(*) AS n FROM async_tasks').get().n,
    ];
    const before = counts();
    const routes = videoRoutes(db, noopLog);

    // 林远是主角且没有任何图 → 编译预览与提交接口都阻断
    db.prepare("UPDATE characters SET role = 'main' WHERE id = ?").run(ids.linId);
    const compiled = segmentCompileService.compileStoryboard(db, ids.sbIr);
    assert.equal(compiled.blocked, true);
    const finding = compiled.findings.find(f => f.code === 'no_reference_image' && f.level === 'block');
    assert.ok(finding && finding.msg.includes('林远'), JSON.stringify(compiled.findings));

    const res = mockRes();
    routes.create({ body: { drama_id: ids.dramaId, storyboard_id: ids.sbIr, prompt: 'x' } }, res);
    assert.equal(res.statusCode, 422);
    assert.equal(res.body.error.code, 'segment_compile_blocked');
    assert.ok(res.body.error.details.findings.some(f => f.code === 'no_reference_image' && f.level === 'block'));
    assert.deepEqual(counts(), before, 'no task and no generation row');
    assert.equal(dispatched, 0, 'no video request dispatched');

    // 同一分镜，把林远降为配角后只剩警告，不再阻断
    db.prepare("UPDATE characters SET role = 'supporting' WHERE id = ?").run(ids.linId);
    const relaxed = segmentCompileService.compileStoryboard(db, ids.sbIr);
    assert.equal(relaxed.findings.some(f => f.code === 'no_reference_image' && f.level === 'block'), false);
    assert.equal(relaxed.findings.some(f => f.code === 'no_reference_image' && f.level === 'warn'), true);
  } finally {
    videoService.processVideoGeneration = original;
  }
});

// ---- 已生成的片是否过期（AC8–AC12）

const storyboardService = require('../src/services/storyboardService');
const segmentCompileService = require('../src/services/segmentCompileService');
const videoService = require('../src/services/videoService');
const takes = require('../src/services/workbenchTakeService');
const { openBatch } = require('../src/services/workbenchVideoBatch');
const { deriveDrift } = require('../src/services/takeDrift');

const DRIFT_TARGET = { protocol: SEEDANCE.protocol, model: SEEDANCE.model, caps: getVideoCaps(SEEDANCE) };
const NOW = '2026-11-23T00:00:00.000Z';

// 一部有图的剧：林远、人事、会议室都有图，分镜 sbIr 已存结构化分镜
function driftWorld(overrides = {}) {
  const w = createIrTestDb();
  const { db, ids } = w;
  db.prepare('UPDATE characters SET image_url = ? WHERE id = ?').run('http://a/static/lin.png', ids.linId);
  db.prepare('UPDATE characters SET image_url = ? WHERE id = ?').run('http://a/static/hr.png', ids.hrId);
  db.prepare('UPDATE scenes SET image_url = ? WHERE id = ?').run('http://a/static/room.png', ids.sceneId);
  storyboardService.saveSegmentIr(db, noopLog, ids.sbIr, sampleIr(ids, overrides));
  return w;
}

// 按提交时的做法生成一条「已完成」的片：编译结果的 refs 写进 compiled_json
function addTake(db, ids, { storyboardId = ids.sbIr, status = 'completed', compiledJson, mutateCompiled } = {}) {
  let json = compiledJson;
  if (json === undefined) {
    const r = segmentCompileService.compileStoryboard(db, storyboardId, { target: DRIFT_TARGET });
    assert.equal(r.ok, true);
    const body = { family: r.compiled.family, refs: r.compiled.refs, request: r.compiled.request, protocol: DRIFT_TARGET.protocol, model: DRIFT_TARGET.model };
    json = JSON.stringify(mutateCompiled ? mutateCompiled(body) : body);
  }
  return Number(db.prepare(`INSERT INTO video_generations
    (drama_id, storyboard_id, provider, model, video_protocol, prompt, status, video_url, compiled_json, created_at, updated_at)
    VALUES (?, ?, 'volcengine', ?, ?, 'p', ?, 'http://x/v.mp4', ?, ?, ?)`)
    .run(ids.dramaId, storyboardId, SEEDANCE.model, SEEDANCE.protocol, status, json, NOW, NOW).lastInsertRowid);
}

const driftOf = (db, id) => deriveDrift(db, [db.prepare('SELECT * FROM video_generations WHERE id = ?').get(id)]).get(id);

test('unchanged assets keep a take current', () => {
  const { db, ids } = driftWorld();
  const id = addTake(db, ids);
  assert.deepEqual(driftOf(db, id), { status: 'current', changed: [] });
});

test('regenerated or rebound assets make a take stale', () => {
  // 角色图重新生成（新文件名）→ 只有这个角色被列出
  let { db, ids } = driftWorld();
  let id = addTake(db, ids);
  db.prepare('UPDATE characters SET image_url = ? WHERE id = ?').run('http://a/static/lin_new.png', ids.linId);
  let drift = driftOf(db, id);
  assert.equal(drift.status, 'stale');
  assert.deepEqual(drift.changed, [{ alias: '林远', kind: 'character' }]);

  // 场景状态图重新生成
  ({ db, ids } = driftWorld());
  const stateId = Number(db.prepare("INSERT INTO scene_states (scene_id, name, kind, image_url, created_at, updated_at) VALUES (?, '黄昏', 'state', 'http://a/static/dusk.png', ?, ?)").run(ids.sceneId, NOW, NOW).lastInsertRowid);
  storyboardService.saveSegmentIr(db, noopLog, ids.sbIr, sampleIr(ids, { scene: { scene_id: ids.sceneId, state_id: stateId, setting: '会议室，长桌靠窗' } }));
  id = addTake(db, ids);
  assert.equal(driftOf(db, id).status, 'current');
  db.prepare('UPDATE scene_states SET image_url = ? WHERE id = ?').run('http://a/static/dusk2.png', stateId);
  drift = driftOf(db, id);
  assert.equal(drift.status, 'stale');
  assert.deepEqual(drift.changed.map(c => c.kind), ['scene']);

  // 分镜改绑了另一套造型（图不同）
  ({ db, ids } = driftWorld());
  id = addTake(db, ids);
  const wardrobeId = Number(db.prepare("INSERT INTO character_wardrobes (character_id, name, image_url, created_at, updated_at) VALUES (?, '西装', 'http://a/static/suit.png', ?, ?)").run(ids.linId, NOW, NOW).lastInsertRowid);
  const rebound = sampleIr(ids);
  rebound.cast[0].wardrobe_id = wardrobeId;
  storyboardService.saveSegmentIr(db, noopLog, ids.sbIr, rebound);
  drift = driftOf(db, id);
  assert.equal(drift.status, 'stale');
  assert.deepEqual(drift.changed, [{ alias: '林远', kind: 'character' }]);

  // 道具、角色被删除
  ({ db, ids } = driftWorld());
  const propId = Number(db.prepare("INSERT INTO props (drama_id, name, image_url, created_at, updated_at) VALUES (?, '协议', 'http://a/static/paper.png', ?, ?)").run(ids.dramaId, NOW, NOW).lastInsertRowid);
  storyboardService.saveSegmentIr(db, noopLog, ids.sbIr, sampleIr(ids, { prop_refs: [{ prop_id: propId, state_id: null, alias: '协议' }] }));
  id = addTake(db, ids);
  assert.equal(driftOf(db, id).status, 'current');
  db.prepare('UPDATE props SET deleted_at = ? WHERE id = ?').run(NOW, propId);
  assert.deepEqual(driftOf(db, id), { status: 'stale', changed: [{ alias: '协议', kind: 'prop' }] });
  db.prepare('UPDATE characters SET deleted_at = ? WHERE id = ?').run(NOW, ids.hrId);
  assert.deepEqual(driftOf(db, id).changed.map(c => c.alias).sort(), ['人事', '协议']);
});

test('cases without comparable refs are unknown', () => {
  const { db, ids } = driftWorld();
  const unknown = { status: 'unknown', changed: [] };
  // 旧片：没有 compiled_json / 无法解析 / 没有 refs 字段 / 首尾帧模式 refs 为空
  assert.deepEqual(driftOf(db, addTake(db, ids, { compiledJson: null })), unknown);
  assert.deepEqual(driftOf(db, addTake(db, ids, { compiledJson: 'not json' })), unknown);
  assert.deepEqual(driftOf(db, addTake(db, ids, { compiledJson: JSON.stringify({ family: 'seedance', protocol: 'volcengine_omni', request: {} }) })), unknown);
  assert.deepEqual(driftOf(db, addTake(db, ids, { mutateCompiled: b => ({ ...b, refs: [] }) })), unknown);
  // 只剩尾帧参考，也没有可比较的资产
  assert.deepEqual(driftOf(db, addTake(db, ids, { mutateCompiled: b => ({ ...b, refs: [{ alias: '上一段尾帧', kind: 'tail_frame', url: 'http://a/tail.png', token: '@图片1' }] }) })), unknown);
  // 片未完成
  assert.deepEqual(driftOf(db, addTake(db, ids, { status: 'processing' })), unknown);
  // 没有分镜的片
  const orphan = addTake(db, ids);
  db.prepare('UPDATE video_generations SET storyboard_id = NULL WHERE id = ?').run(orphan);
  assert.deepEqual(driftOf(db, orphan), unknown);

  // 分镜之后不再是结构化分镜、IR 损坏、分镜被删：即使资产图全换了，也不报过期
  const id = addTake(db, ids);
  db.prepare('UPDATE characters SET image_url = ? WHERE id = ?').run('http://a/static/changed.png', ids.linId);
  assert.equal(driftOf(db, id).status, 'stale', 'sanity: the take is stale while the IR is valid');
  db.prepare('UPDATE storyboards SET segment_ir = NULL WHERE id = ?').run(ids.sbIr);
  assert.deepEqual(driftOf(db, id), unknown);
  db.prepare('UPDATE storyboards SET segment_ir = ? WHERE id = ?').run('{"version":1,"shots":[]}', ids.sbIr);
  assert.deepEqual(driftOf(db, id), unknown);
  db.prepare('UPDATE storyboards SET deleted_at = ? WHERE id = ?').run(NOW, ids.sbIr);
  assert.deepEqual(driftOf(db, id), unknown);
});

test('tail frame, origin and text edits do not make a take stale', () => {
  const { db, ids } = driftWorld();
  // 上一段尾帧每次生成都不同：存了尾帧参考，也不因它判过期
  const withTail = addTake(db, ids, { mutateCompiled: b => ({ ...b, refs: [...b.refs, { alias: '上一段尾帧', kind: 'tail_frame', url: 'http://a/static/tail_old.png', token: '@图片9' }] }) });
  assert.equal(driftOf(db, withTail).status, 'current');

  // 只改 origin（端口、域名变了）、路径不变
  db.prepare('UPDATE characters SET image_url = ? WHERE id = ?').run('http://other-host:9999/static/lin.png', ids.linId);
  db.prepare('UPDATE scenes SET image_url = ? WHERE id = ?').run('https://cdn.example/static/room.png', ids.sceneId);
  assert.equal(driftOf(db, withTail).status, 'current');

  // 只改分镜文字、不改资产
  const edited = sampleIr(ids, { tone: '傍晚，暖色侧光', main_move: '急推' });
  edited.shots[0].action = '人事把协议重重拍在桌上';
  storyboardService.saveSegmentIr(db, noopLog, ids.sbIr, edited);
  assert.equal(driftOf(db, withTail).status, 'current');

  // 对照：路径真的变了才算（排除「永远返回 current」）
  db.prepare('UPDATE characters SET image_url = ? WHERE id = ?').run('http://other-host:9999/static/lin_v2.png', ids.linId);
  assert.equal(driftOf(db, withTail).status, 'stale');
});

test('stale takes keep their eligibility, adoption and batch reuse', () => {
  const { db, ids } = driftWorld();
  const id = addTake(db, ids);
  const adopt = () => takes.adopt(db, { storage: { local_path: '.' } }, ids.sbIr, { video_generation_id: id, expected_revision: 0 });
  const snapshot = () => ({
    batch: openBatch(db, ids.episodeId, [ids.sbIr], '.').map(({ storyboard_id, video_id, status, eligible_for_automatic_use }) => ({ storyboard_id, video_id, status, eligible_for_automatic_use })),
    adopted: db.prepare('SELECT adopted_video_generation_id AS a FROM storyboards WHERE id = ?').get(ids.sbIr).a,
    eligible: takes.takeEligibility(db.prepare('SELECT * FROM video_generations WHERE id = ?').get(id)),
    rows: db.prepare('SELECT COUNT(*) AS n FROM video_generations').get().n,
    tasks: db.prepare('SELECT COUNT(*) AS n FROM async_tasks').get().n,
  });
  adopt();
  const fresh = snapshot();
  assert.equal(driftOf(db, id).status, 'current');

  db.prepare('UPDATE characters SET image_url = ? WHERE id = ?').run('http://a/static/lin_new.png', ids.linId);
  assert.equal(driftOf(db, id).status, 'stale');
  const stale = snapshot();
  assert.deepEqual(stale, fresh, 'staleness changes nothing but its own field');
  assert.equal(stale.batch[0].video_id, id, 'batch still reuses the stale take instead of re-shooting');
  assert.equal(stale.adopted, id);
  assert.equal(stale.eligible, true);
});

test('asset drift is exposed on list, get and take details', () => {
  const { db, ids } = driftWorld();
  const a = addTake(db, ids);
  const b = addTake(db, ids);
  const c = addTake(db, ids);
  const legacy = addTake(db, ids, { compiledJson: null });
  db.prepare('UPDATE characters SET image_url = ? WHERE id = ?').run('http://a/static/lin_new.png', ids.linId);

  const original = segmentCompileService.compileStoryboard;
  let compiles = 0;
  segmentCompileService.compileStoryboard = (...args) => { compiles++; return original(...args); };
  try {
    // 列表：同一分镜的三条有 compiled_json 的片只读一次当前资产；旧片不触发读取
    const listed = videoService.list(db, { drama_id: ids.dramaId, page_size: 50 }).items;
    assert.equal(compiles, 1);
    const byId = new Map(listed.map(i => [i.id, i.asset_drift]));
    for (const id of [a, b, c]) assert.deepEqual(byId.get(id), { status: 'stale', changed: [{ alias: '林远', kind: 'character' }] });
    assert.deepEqual(byId.get(legacy), { status: 'unknown', changed: [] });

    // 单条
    compiles = 0;
    assert.equal(videoService.getById(db, a).asset_drift.status, 'stale');
    assert.deepEqual(videoService.getById(db, legacy).asset_drift, { status: 'unknown', changed: [] });
    assert.equal(compiles, 1, 'the legacy take does not compile');

    // 审片候选
    compiles = 0;
    const details = takes.details(db, ids.sbIr);
    assert.equal(compiles, 1);
    const cand = new Map(details.candidates.map(v => [v.id, v.asset_drift.status]));
    assert.deepEqual([...cand.entries()].sort((x, y) => x[0] - y[0]), [[a, 'stale'], [b, 'stale'], [c, 'stale'], [legacy, 'unknown']]);
  } finally {
    segmentCompileService.compileStoryboard = original;
  }

  // 推导出错一律 unknown，不抛错
  segmentCompileService.compileStoryboard = () => { throw new Error('boom'); };
  try {
    assert.equal(videoService.getById(db, a).asset_drift.status, 'unknown');
  } finally {
    segmentCompileService.compileStoryboard = original;
  }
});
