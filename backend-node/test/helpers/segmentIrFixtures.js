const Database = require('better-sqlite3');
const { runMigrationsAndEnsure } = require('../../src/db/migrate');

const noopLog = { info() {}, warn() {}, error() {}, debug() {} };

/** 用真实迁移建内存库（覆盖 segment_ir 列迁移），并种一部剧/一集/两个角色/一个场景/两条分镜 */
function createIrTestDb() {
  const db = new Database(':memory:');
  const origLog = console.log;
  console.log = () => {};
  try { runMigrationsAndEnsure(db); } finally { console.log = origLog; }
  const now = new Date().toISOString();
  const dramaId = db.prepare('INSERT INTO dramas (title, created_at, updated_at) VALUES (?, ?, ?)').run('测试剧', now, now).lastInsertRowid;
  const episodeId = db.prepare('INSERT INTO episodes (drama_id, episode_number, title, created_at, updated_at) VALUES (?, 1, ?, ?, ?)').run(dramaId, '第1集', now, now).lastInsertRowid;
  const linId = db.prepare('INSERT INTO characters (drama_id, name, created_at, updated_at) VALUES (?, ?, ?, ?)').run(dramaId, '林远', now, now).lastInsertRowid;
  const hrId = db.prepare('INSERT INTO characters (drama_id, name, created_at, updated_at) VALUES (?, ?, ?, ?)').run(dramaId, '人事', now, now).lastInsertRowid;
  const sceneId = db.prepare('INSERT INTO scenes (drama_id, location, time, created_at, updated_at) VALUES (?, ?, ?, ?, ?)').run(dramaId, '会议室', '日', now, now).lastInsertRowid;
  const insSb = db.prepare(
    `INSERT INTO storyboards (episode_id, storyboard_number, title, duration, dialogue, action, shot_type, movement, characters, scene_id, universal_segment_text, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );
  const sbIr = insSb.run(episodeId, 1, '谈判', 5, '旧台词', '旧动作', '远景', '固定', '[]', null, '旧全能文本', now, now).lastInsertRowid;
  const sbLegacy = insSb.run(episodeId, 2, '旧分镜', 5, '原台词', '原动作', '中景', '缓推', JSON.stringify([linId]), sceneId, null, now, now).lastInsertRowid;
  return { db, ids: { dramaId, episodeId, linId, hrId, sceneId, sbIr, sbLegacy } };
}

function sampleIr(ids, overrides = {}) {
  return {
    version: 1,
    duration_s: 8,
    scene: { scene_id: ids.sceneId, state_id: null, setting: '会议室，长桌靠窗' },
    main_move: '缓推',
    tone: '午后，冷白顶光',
    continuity: { mode: 'refs' },
    cast: [
      { character_id: ids.linId, wardrobe_id: null, alias: '林远' },
      { character_id: ids.hrId, wardrobe_id: null, alias: '人事' },
    ],
    prop_refs: [],
    cards: [],
    shots: [
      {
        seconds: 3, size: '中景', camera: '桌侧平视', cut: 'hard', event: '人事推来协议',
        movement: { type: '缓推', speed: '慢', direction: '向前' },
        subjects: [
          { alias: '人事', frame_pos: '画面左侧', facing: '侧身朝右', gaze: '林远', pose: '坐', holding: '协议' },
          { alias: '林远', frame_pos: '画面右侧', facing: '侧身朝左', gaze: '协议', pose: '坐', holding: null },
        ],
        action: '人事把协议推过桌面',
        lines: [{ kind: 'dialogue', speaker: '人事', text: '签个字吧。', delivery: '公式化', voice: null }],
        sfx: ['纸张摩擦声'],
      },
      {
        seconds: 5, size: '近景', camera: '正面平视', cut: 'hard', event: '林远反问',
        movement: null,
        subjects: [{ alias: '林远', frame_pos: '画面中央', facing: '面朝镜头', gaze: '画左人事', pose: '坐', holding: null }],
        action: '林远手指收紧',
        lines: [
          { kind: 'dialogue', speaker: '林远', text: '是因为绩效吗？', delivery: '平静', voice: null },
          { kind: 'os', speaker: '林远', text: '果然轮到我了。', delivery: '低沉', voice: null },
        ],
        sfx: [],
      },
    ],
    ...overrides,
  };
}

/** 极简 express res 替身：记录状态码与 JSON */
function mockRes() {
  const res = { statusCode: 200, body: null, headersSent: false };
  res.status = (c) => { res.statusCode = c; return res; };
  res.json = (b) => { res.body = b; res.headersSent = true; return res; };
  res.setHeader = () => {};
  res.write = () => true;
  res.end = () => { res.headersSent = true; return res; };
  return res;
}

module.exports = { createIrTestDb, sampleIr, mockRes, noopLog };
