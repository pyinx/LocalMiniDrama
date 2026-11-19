const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { planSegments, lineSeconds, dialogueCapacity, hardCutCap, eventMinimum } = require('../src/services/segmentIr/planner');
const { parseSegmentIr } = require('../src/services/segmentIr/schema');
const { createIrTestDb, mockRes, noopLog } = require('./helpers/segmentIrFixtures');

const CAPS_15 = { duration: { min: 4, max: 15, step: 1 } };
const CAPS_STEP5 = { duration: { min: 5, max: 10, step: 5 } };
const IDS = { sceneId: 3, linId: 1, hrId: 2 };

function shot(seconds, extra = {}) {
  return {
    seconds, size: '中景', camera: '平视', cut: 'hard', event: '事件', movement: null,
    subjects: [{ alias: '林远', frame_pos: '画面中央', facing: '面朝镜头', gaze: '画左', pose: '站', holding: null }],
    action: '林远抬头', lines: [], sfx: [], ...extra,
  };
}
function say(text, speaker = '林远', kind = 'dialogue') {
  return { kind, speaker, text, delivery: '', voice: null };
}
function ir(shots, extra = {}) {
  const parsed = parseSegmentIr({
    version: 1,
    duration_s: shots.reduce((n, s) => n + s.seconds, 0),
    scene: { scene_id: IDS.sceneId, state_id: null, setting: '会议室' },
    main_move: '缓推', tone: '',
    cast: [{ character_id: IDS.linId, wardrobe_id: null, alias: '林远' }, { character_id: IDS.hrId, wardrobe_id: null, alias: '人事' }],
    shots,
    ...extra,
  });
  assert.equal(parsed.ok, true, JSON.stringify(parsed.errors));
  return parsed.ir;
}
function valid(seg) {
  const r = parseSegmentIr(seg.ir);
  assert.equal(r.ok, true, JSON.stringify(r.errors));
}

describe('segment planner (AC3 / AC6)', () => {
  it('clamps to model envelope', () => {
    // 低于下限：补到下限
    let out = planSegments([ir([shot(3)])], CAPS_15);
    assert.equal(out.segments.length, 1);
    assert.equal(out.segments[0].ir.duration_s, 4);
    // 恰好等于上限：不动
    out = planSegments([ir([shot(5), shot(5), shot(5, { cut: 'continuous' })])], CAPS_15);
    assert.equal(out.segments.length, 1);
    assert.equal(out.segments[0].ir.duration_s, 15);
    // 步长对齐：7 → 10（step 5）
    out = planSegments([ir([shot(3), shot(4, { cut: 'continuous' })])], CAPS_STEP5);
    assert.equal(out.segments[0].ir.duration_s, 10);
    for (const s of out.segments) {
      valid(s);
      assert.equal(s.ir.shots.reduce((n, x) => n + x.seconds, 0), s.ir.duration_s);
    }
  });

  it('splits overflow into new segment', () => {
    const shots = [shot(6, { event: 'a' }), shot(6, { event: 'b', cut: 'continuous' }), shot(6, { event: 'c', cut: 'continuous' }), shot(6, { event: 'd', cut: 'continuous' })];
    const out = planSegments([ir(shots, { cards: [{ text: '十年后', at_s: 13, hold_s: 2 }] })], CAPS_15);
    assert.ok(out.segments.length >= 2);
    const total = out.segments.reduce((n, s) => n + s.ir.duration_s, 0);
    assert.equal(total, 24, 'no content is cut');
    for (const s of out.segments) {
      valid(s);
      assert.ok(s.ir.duration_s >= 4 && s.ir.duration_s <= 15);
      assert.equal(s.source, 0);
    }
    assert.deepEqual(out.segments.map((s) => s.part), out.segments.map((_, i) => i));
    const withCard = out.segments.find((s) => s.ir.cards.length);
    assert.equal(withCard.ir.cards[0].text, '十年后');
    // 单个镜头超过上限：不截断，阻断
    const tooLong = planSegments([ir([shot(20)])], CAPS_15);
    assert.ok(tooLong.findings.some((f) => f.level === 'block' && f.code === 'shot_exceeds_max'));
    assert.equal(tooLong.segments[0].ir.shots[0].seconds, 20);
  });

  it('duration from dialogue', () => {
    assert.ok(Math.abs(lineSeconds([say('一二三四五六七')]) - 2) < 1e-9, '7 字 / 3.5 字每秒');
    assert.ok(Math.abs(lineSeconds([say('一二三四五六七'), say('一二三四五六七', '人事')]) - 4.3) < 1e-9, '换人停顿 0.3s');
    assert.ok(Math.abs(lineSeconds([say('等等……你说什么')]) - (6 / 3.5 + 0.3)) < 1e-9, '省略号停顿');
    // 21 字台词放在 4 秒镜头里：镜头被拉长到 ceil(6 + 0.5) = 7
    const out = planSegments([ir([shot(4, { lines: [say('一二三四五六七八九十一二三四五六七八九十一')] })])], CAPS_15);
    assert.equal(out.segments[0].ir.shots[0].seconds, 7);
    assert.equal(out.segments[0].ir.duration_s, 7);
  });

  it('includes the closing pause in the single-shot duration limit', () => {
    const plan = (count) => planSegments([ir([shot(15, { lines: [say('字'.repeat(count))] })])], CAPS_15);
    assert.equal(plan(50).findings.some((f) => f.level === 'block'), false);
    const out = plan(52);
    assert.equal(out.segments[0].ir.duration_s, 16);
    assert.ok(out.findings.some((f) => f.level === 'block' && f.code === 'shot_exceeds_max'));
  });

  it('dialogue capacity', () => {
    assert.equal(dialogueCapacity(8), 2);
    assert.equal(dialogueCapacity(15), 4);
    const lines = (n) => Array.from({ length: n }, (_, i) => say('好', i % 2 ? '人事' : '林远'));
    const out = planSegments([ir([shot(4, { lines: lines(2) }), shot(4, { lines: lines(1), cut: 'continuous' })])], CAPS_15);
    assert.equal(out.segments.length, 2, '8 秒装 3 句台词要拆开');
    for (const s of out.segments) {
      const n = s.ir.shots.reduce((k, x) => k + x.lines.length, 0);
      assert.ok(n <= dialogueCapacity(s.ir.duration_s));
    }
    const crowded = planSegments([ir([shot(8, { lines: lines(3) })])], CAPS_15);
    assert.ok(crowded.findings.some((f) => f.code === 'shot_lines_over_capacity'));
  });

  it('hard cut cap', () => {
    assert.equal(hardCutCap(8), 1);
    assert.equal(hardCutCap(15), 3);
    const out = planSegments([ir([shot(2), shot(2), shot(2), shot(2)])], CAPS_15);
    for (const s of out.segments) {
      const cuts = s.ir.shots.slice(1).filter((x) => x.cut === 'hard').length;
      assert.ok(cuts <= hardCutCap(s.ir.duration_s), `${cuts} cuts in ${s.ir.duration_s}s`);
    }
    assert.ok(out.segments.length >= 2);
  });

  it('event minimum', () => {
    assert.equal(eventMinimum(9), 1);
    assert.equal(eventMinimum(10), 2);
    assert.equal(eventMinimum(15), 3);
    // 17 秒超上限需拆；可行切法是 [6+3] [6+2]，每段 <10 秒且各有 1 个事件
    const shots = [shot(6, { event: 'a' }), shot(3, { event: null, cut: 'continuous' }), shot(6, { event: 'b', cut: 'continuous' }), shot(2, { event: null, cut: 'continuous' })];
    const out = planSegments([ir(shots)], CAPS_15);
    for (const s of out.segments) {
      const n = s.ir.shots.filter((x) => x.event).length;
      assert.ok(n >= eventMinimum(s.ir.duration_s), `${n} events in ${s.ir.duration_s}s`);
    }
    const none = planSegments([ir([shot(6, { event: null })])], CAPS_15);
    assert.ok(none.findings.some((f) => f.code === 'event_minimum' && f.level === 'warn'));
  });

  it('hooks isolated', () => {
    const first = ir([shot(4, { event: '开场钩子' }), shot(4, { event: 'b', cut: 'continuous' }), shot(4, { event: 'c', cut: 'continuous' })]);
    const middle = ir([shot(6, { event: 'm' })]);
    const last = ir([shot(5, { event: 'd' }), shot(5, { event: '集尾钩子', cut: 'continuous' })]);
    const out = planSegments([first, middle, last], CAPS_15, { episode: true });
    assert.equal(out.segments[0].ir.shots.length, 1);
    assert.equal(out.segments[0].ir.shots[0].event, '开场钩子');
    const tail = out.segments[out.segments.length - 1];
    assert.equal(tail.ir.shots.length, 1);
    assert.equal(tail.ir.shots[0].event, '集尾钩子');
    assert.equal(out.segments.length, 5);
    // 不按整集规划时不拆钩子
    assert.equal(planSegments([first], CAPS_15).segments.length, 1);
  });

  it('cast and continuity follow the split parts', () => {
    const shots = [
      shot(8, { event: 'a', lines: [say('签字吧', '人事')], subjects: [{ alias: '人事', frame_pos: '左', facing: '侧身朝右', gaze: '林远', pose: '坐', holding: null }] }),
      shot(8, { event: 'b' }),
    ];
    const out = planSegments([ir(shots, { continuity: { mode: 'refs', tail_ref_from: 7 } })], CAPS_15);
    assert.equal(out.segments.length, 2);
    assert.deepEqual(out.segments[0].ir.cast.map((c) => c.alias), ['人事']);
    assert.deepEqual(out.segments[1].ir.cast.map((c) => c.alias), ['林远']);
    assert.equal(out.segments[0].ir.continuity.tail_ref_from, 7);
    assert.equal(out.segments[1].ir.continuity.tail_ref_from, undefined);
  });
});

describe('replan endpoint (AC36)', () => {
  const storyboardService = require('../src/services/storyboardService');
  const storyboardRoutes = require('../src/routes/storyboards');

  it('saves 1+1+13 seconds within a 15-second cap and replans a 45-character closing line', (t) => {
    const { db, ids } = createIrTestDb();
    t.after(() => db.close());
    db.prepare(`INSERT INTO ai_service_configs (service_type, provider, api_protocol, model, is_default, is_active)
      VALUES ('video', 'minimax', 'minimax_h3', '["MiniMax-H3"]', 1, 1)`).run();
    const text = '字'.repeat(45);
    const input = ir([shot(1), shot(1), shot(13, { lines: [say(text)] })]);
    input.scene.scene_id = ids.sceneId;
    const rows = db.prepare(`SELECT duration, segment_ir FROM storyboards
      WHERE episode_id = ? AND segment_ir IS NOT NULL AND deleted_at IS NULL ORDER BY storyboard_number`);
    const saved = storyboardService.saveSegmentIr(db, noopLog, ids.sbIr, input, { caps: CAPS_15 });
    const before = rows.all(ids.episodeId);
    assert.deepEqual(before.map((r) => r.duration), [15]);
    assert.deepEqual(JSON.parse(before[0].segment_ir), input);
    assert.ok(saved.plan_findings.some((f) => f.code === 'needs_replan'));

    const res = mockRes();
    storyboardRoutes(db, noopLog).replanEpisode({ params: { episode_id: ids.episodeId } }, res);
    assert.equal(res.statusCode, 200, JSON.stringify(res.body));
    const after = rows.all(ids.episodeId);
    const segments = after.map((r) => JSON.parse(r.segment_ir));
    assert.deepEqual(after.map((r) => r.duration), [4, 14]);
    assert.deepEqual(segments.map((s) => s.duration_s), [4, 14]);
    assert.deepEqual(segments.map((s) => s.shots.length), [2, 1]);
    assert.deepEqual(segments[1].shots[0].lines, input.shots[2].lines);
  });

  it('rejects a 16-second closing shot before writing any episode changes', () => {
    const { db, ids } = createIrTestDb();
    db.prepare(`INSERT INTO ai_service_configs (service_type, provider, api_protocol, model, is_default, is_active)
      VALUES ('video', 'minimax', 'minimax_h3', '["MiniMax-H3"]', 1, 1)`).run();
    const input = ir([shot(6), shot(15, { lines: [say('字'.repeat(52))] })]);
    input.scene.scene_id = ids.sceneId;
    storyboardService.saveSegmentIr(db, noopLog, ids.sbIr, input);
    const rows = db.prepare('SELECT * FROM storyboards WHERE episode_id = ? ORDER BY id');
    const before = rows.all(ids.episodeId);
    const res = mockRes();
    storyboardRoutes(db, noopLog).replanEpisode({ params: { episode_id: ids.episodeId } }, res);
    assert.deepEqual(rows.all(ids.episodeId), before);
    assert.equal(res.statusCode, 422);
    assert.equal(res.body.error.code, 'segment_replan_blocked');
    assert.ok(res.body.error.details.findings.some((f) => f.code === 'shot_exceeds_max' && /16 秒.*15 秒/.test(f.msg)));
  });

  it('replan renumbers and keeps bindings', () => {
    const { db, ids } = createIrTestDb();
    const longIr = ir([shot(6, { event: 'a' }), shot(6, { event: 'b', cut: 'continuous' }), shot(6, { event: 'c', cut: 'continuous' })]);
    longIr.scene.scene_id = ids.sceneId;
    longIr.cast = [{ character_id: ids.linId, wardrobe_id: null, alias: '林远' }, { character_id: ids.hrId, wardrobe_id: null, alias: '人事' }];
    storyboardService.saveSegmentIr(db, noopLog, ids.sbIr, longIr);
    db.prepare("UPDATE storyboards SET video_url = 'v.mp4', image_url = 'i.png' WHERE id = ?").run(ids.sbIr);
    const legacyBefore = db.prepare('SELECT dialogue, duration FROM storyboards WHERE id = ?').get(ids.sbLegacy);

    const routes = storyboardRoutes(db, noopLog);
    const res = mockRes();
    routes.replanEpisode({ params: { episode_id: String(ids.episodeId) }, body: {} }, res);
    assert.equal(res.statusCode, 200, JSON.stringify(res.body));
    const changes = res.body.data.changes;
    assert.ok(changes.some((c) => c.action === 'created' && c.from_storyboard_id === ids.sbIr));

    const rows = db.prepare('SELECT id, storyboard_number, duration, video_url, image_url, segment_ir FROM storyboards WHERE episode_id = ? AND deleted_at IS NULL ORDER BY storyboard_number').all(ids.episodeId);
    assert.deepEqual(rows.map((r) => r.storyboard_number), rows.map((_, i) => i + 1), 'contiguous numbering');
    assert.equal(rows[0].id, ids.sbIr, 'original row keeps its place');
    assert.equal(rows[0].video_url, 'v.mp4');
    assert.equal(rows[0].image_url, 'i.png');
    const created = rows.filter((r) => r.id !== ids.sbIr && r.id !== ids.sbLegacy);
    assert.ok(created.length >= 1);
    for (const r of created) {
      assert.equal(r.video_url, null);
      assert.equal(r.image_url, null);
      assert.ok(r.segment_ir);
    }
    assert.equal(rows[rows.length - 1].id, ids.sbLegacy, 'legacy storyboard stays after the split parts');
    assert.deepEqual(db.prepare('SELECT dialogue, duration FROM storyboards WHERE id = ?').get(ids.sbLegacy), legacyBefore);
    const total = rows.filter((r) => r.segment_ir).reduce((n, r) => n + r.duration, 0);
    assert.equal(total, 18);

    const again = mockRes();
    routes.replanEpisode({ params: { episode_id: String(ids.episodeId) }, body: {} }, again);
    assert.equal(again.statusCode, 200);
    assert.ok(again.body.data.changes.every((c) => c.action === 'unchanged'), 'replan is idempotent');

    const { db: db2, ids: ids2 } = createIrTestDb();
    const none = mockRes();
    storyboardRoutes(db2, noopLog).replanEpisode({ params: { episode_id: String(ids2.episodeId) }, body: {} }, none);
    assert.equal(none.statusCode, 409);
    assert.equal(none.body.error.code, 'no_segment_ir');
  });
});
