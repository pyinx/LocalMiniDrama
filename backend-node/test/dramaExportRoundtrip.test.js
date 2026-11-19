const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const AdmZip = require('adm-zip');
const { exportDrama } = require('../src/services/dramaExportService');
const { importDrama } = require('../src/services/dramaImportService');
const storyboardService = require('../src/services/storyboardService');
const segmentCompileService = require('../src/services/segmentCompileService');
const episodeContinuityService = require('../src/services/episodeContinuityService');
const { createIrTestDb, sampleIr, noopLog } = require('./helpers/segmentIrFixtures');
const { tmpStorage } = require('./helpers/mediaFixtures');

function writeFile(storage, rel) {
  fs.mkdirSync(path.dirname(path.join(storage, rel)), { recursive: true });
  fs.writeFileSync(path.join(storage, rel), Buffer.from('fake-image-' + rel));
  return rel;
}

/** 原剧：两段结构化分镜（第二段挂第一段尾帧），角色造型、场景状态、道具状态、连续性表都有 */
function buildSource() {
  const storage = tmpStorage();
  const cfg = { storage: { local_path: storage, base_url: 'http://localhost:5679/static' } };
  const { db, ids } = createIrTestDb();
  const now = '2026-11-18T10:00:00.000Z';
  db.prepare("UPDATE characters SET is_group = 1, tts_voice = 'v-hr' WHERE id = ?").run(ids.hrId);
  const propId = Number(db.prepare("INSERT INTO props (drama_id, name, created_at, updated_at) VALUES (?, '协议', ?, ?)").run(ids.dramaId, now, now).lastInsertRowid);
  const wid = Number(db.prepare("INSERT INTO character_wardrobes (character_id, name, change_phrase, local_path, created_at, updated_at) VALUES (?, '西装', '深灰西装', ?, ?, ?)").run(ids.linId, writeFile(storage, 'p/characters/w.png'), now, now).lastInsertRowid);
  const sid = Number(db.prepare("INSERT INTO scene_states (scene_id, name, kind, state_phrase, local_path, created_at, updated_at) VALUES (?, '夜', 'portrait', '夜晚', ?, ?, ?)").run(ids.sceneId, writeFile(storage, 'p/scenes/s.png'), now, now).lastInsertRowid);
  const psid = Number(db.prepare("INSERT INTO prop_states (prop_id, name, state_phrase, local_path, created_at, updated_at) VALUES (?, '撕碎', '撕成两半', ?, ?, ?)").run(propId, writeFile(storage, 'p/props/ps.png'), now, now).lastInsertRowid);

  const first = sampleIr(ids, { prop_refs: [{ prop_id: propId, state_id: psid, alias: '协议' }] });
  first.cast[0].wardrobe_id = wid;
  first.scene.state_id = sid;
  storyboardService.saveSegmentIr(db, noopLog, ids.sbIr, first);
  db.prepare("INSERT INTO video_generations (drama_id, storyboard_id, provider, prompt, status, local_path, created_at, updated_at) VALUES (?, ?, 't', 'p', 'completed', ?, ?, ?)")
    .run(ids.dramaId, ids.sbIr, writeFile(storage, 'p/videos/v1.mp4'), now, now);
  const tailImg = Number(db.prepare("INSERT INTO image_generations (drama_id, storyboard_id, provider, prompt, status, local_path, created_at, updated_at) VALUES (?, ?, 'tail-frame', 'p', 'completed', ?, ?, ?)")
    .run(ids.dramaId, ids.sbLegacy, writeFile(storage, 'p/images/tail.jpg'), '2026-11-18T10:05:00.000Z', '2026-11-18T10:05:00.000Z').lastInsertRowid);
  const second = sampleIr(ids);
  second.scene.state_id = sid;
  second.continuity = { mode: 'refs', tail_ref_from: ids.sbIr, first_frame_image_id: tailImg };
  storyboardService.saveSegmentIr(db, noopLog, ids.sbLegacy, second);
  episodeContinuityService.setContinuity(db, ids.episodeId, { [ids.sceneId]: { ambience: '空调低鸣', props: [] } });
  return { db, ids, cfg, storage, propId, wid, sid, psid, tailImg };
}

function roundtrip(src) {
  const { buffer } = exportDrama(src.db, src.cfg, noopLog, src.ids.dramaId);
  return importDrama(src.db, src.cfg, noopLog, buffer).drama_id;
}

function newDrama(db, dramaId) {
  const ep = db.prepare('SELECT id, continuity_json FROM episodes WHERE drama_id = ?').get(dramaId);
  const sbs = db.prepare('SELECT * FROM storyboards WHERE episode_id = ? ORDER BY storyboard_number').all(ep.id);
  const chars = Object.fromEntries(db.prepare('SELECT id, name, is_group, tts_voice FROM characters WHERE drama_id = ?').all(dramaId).map((c) => [c.name, c]));
  const scene = db.prepare('SELECT id FROM scenes WHERE drama_id = ?').get(dramaId);
  const prop = db.prepare('SELECT id FROM props WHERE drama_id = ?').get(dramaId);
  return { ep, sbs, chars, scene, prop };
}

describe('drama export / import roundtrip (AC24)', () => {
  it('ir and variants survive roundtrip', () => {
    const src = buildSource();
    const dramaId = roundtrip(src);
    const { db, storage } = src;
    const n = newDrama(db, dramaId);
    assert.equal(n.sbs.length, 2);
    assert.ok(n.sbs.every((s) => s.segment_ir), 'both storyboards keep their IR');
    assert.equal(n.chars['人事'].is_group, 1);
    assert.equal(n.chars['人事'].tts_voice, 'v-hr');
    const w = db.prepare('SELECT * FROM character_wardrobes WHERE character_id = ?').get(n.chars['林远'].id);
    const st = db.prepare('SELECT * FROM scene_states WHERE scene_id = ?').get(n.scene.id);
    const ps = db.prepare('SELECT * FROM prop_states WHERE prop_id = ?').get(n.prop.id);
    assert.equal(w.name, '西装');
    assert.equal(st.kind, 'portrait');
    assert.equal(ps.state_phrase, '撕成两半');
    for (const v of [w, st, ps]) assert.ok(v.local_path && fs.existsSync(path.join(storage, v.local_path)), 'variant image copied: ' + v.local_path);
    assert.deepEqual(Object.keys(JSON.parse(n.ep.continuity_json)), [String(n.scene.id)]);
    // 尾帧在导入后仍然有效（视频生成时间随包保留，不会被判定过期）
    const r = segmentCompileService.compileStoryboard(db, n.sbs[1].id);
    assert.ok(!r.findings.some((f) => f.code.startsWith('tail_frame')), JSON.stringify(r.findings.filter((f) => f.level === 'block')));
    assert.equal(r.blocked, false);
  });

  it('ids remapped in ir', () => {
    const src = buildSource();
    const dramaId = roundtrip(src);
    const { db } = src;
    const n = newDrama(db, dramaId);
    const [a, b] = n.sbs.map((s) => JSON.parse(s.segment_ir));
    assert.equal(a.scene.scene_id, n.scene.id);
    assert.equal(a.scene.state_id, db.prepare('SELECT id FROM scene_states WHERE scene_id = ?').get(n.scene.id).id);
    assert.deepEqual(a.cast.map((c) => c.character_id).sort(), [n.chars['林远'].id, n.chars['人事'].id].sort());
    assert.equal(a.cast.find((c) => c.alias === '林远').wardrobe_id, db.prepare('SELECT id FROM character_wardrobes WHERE character_id = ?').get(n.chars['林远'].id).id);
    assert.equal(a.prop_refs[0].prop_id, n.prop.id);
    assert.equal(a.prop_refs[0].state_id, db.prepare('SELECT id FROM prop_states WHERE prop_id = ?').get(n.prop.id).id);
    assert.equal(b.continuity.tail_ref_from, n.sbs[0].id);
    const img = db.prepare('SELECT storyboard_id, drama_id FROM image_generations WHERE id = ?').get(b.continuity.first_frame_image_id);
    assert.deepEqual(img, { storyboard_id: n.sbs[1].id, drama_id: dramaId });
    assert.deepEqual(JSON.parse(n.sbs[0].characters).sort(), [n.chars['林远'].id, n.chars['人事'].id].sort(), 'projection follows the new ids');
    // 新剧的 IR 不再指向原剧的对象
    assert.notEqual(a.scene.scene_id, src.ids.sceneId);
    assert.notEqual(b.continuity.tail_ref_from, src.ids.sbIr);
    assert.notEqual(b.continuity.first_frame_image_id, src.tailImg);
  });

  it('keeps distinct scenes, states and continuity at the same location and time', () => {
    const src = buildSource();
    const { db, ids } = src;
    const otherScene = Number(db.prepare(`INSERT INTO scenes (drama_id, location, time, created_at, updated_at)
      SELECT drama_id, location, time, created_at, updated_at FROM scenes WHERE id = ?`).run(ids.sceneId).lastInsertRowid);
    const otherState = Number(db.prepare(`INSERT INTO scene_states (scene_id, name, kind, created_at, updated_at)
      SELECT ?, '停电', kind, created_at, updated_at FROM scene_states WHERE id = ?`).run(otherScene, src.sid).lastInsertRowid);
    const ir = sampleIr(ids);
    ir.scene.scene_id = otherScene;
    ir.scene.state_id = otherState;
    storyboardService.saveSegmentIr(db, noopLog, ids.sbLegacy, ir);
    const firstRule = { ambience: '空调低鸣', props: [] };
    const secondRule = { axis_lock: '面向窗户', props: [] };
    episodeContinuityService.setContinuity(db, ids.episodeId, { [ids.sceneId]: firstRule, [otherScene]: secondRule });

    const dramaId = roundtrip(src);
    const { ep, sbs } = newDrama(db, dramaId);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM scenes WHERE drama_id = ?').get(dramaId).n, 2);
    const [first, second] = sbs.map(sb => sb.scene_id);
    assert.notEqual(first, second);
    assert.deepEqual(episodeContinuityService.getContinuity(db, ep.id), { [first]: firstRule, [second]: secondRule });
    for (const [i, sb] of sbs.entries()) {
      const scene = JSON.parse(sb.segment_ir).scene;
      assert.equal(scene.scene_id, sb.scene_id);
      const state = db.prepare('SELECT scene_id, name FROM scene_states WHERE id = ?').get(scene.state_id);
      assert.deepEqual(state, { scene_id: sb.scene_id, name: ['夜', '停电'][i] });
    }
  });

  it('legacy package imports', () => {
    const { db } = createIrTestDb();
    const storage = tmpStorage();
    const zip = new AdmZip();
    zip.addFile('project.json', Buffer.from(JSON.stringify({
      version: '1.4',
      drama: { title: '旧包' },
      episodes: [{ episode_number: 1, title: '第1集', storyboards: [{ storyboard_number: 1, dialogue: '台词', duration: 5, character_indices: [0], scene_index: 1 }] }],
      characters: [{ name: '甲' }],
      scenes: [{ location: '客厅', time: '日' }, { location: '客厅', time: '日' }],
      props: [],
    })));
    const r = importDrama(db, { storage: { local_path: storage } }, noopLog, zip.toBuffer());
    const n = newDrama(db, r.drama_id);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM scenes WHERE drama_id = ?').get(r.drama_id).n, 1);
    assert.equal(n.sbs[0].scene_id, n.scene.id);
    assert.equal(n.sbs.length, 1);
    assert.equal(n.sbs[0].segment_ir, null);
    assert.equal(n.sbs[0].dialogue, '台词');
    assert.equal(n.ep.continuity_json, null);
  });
});
