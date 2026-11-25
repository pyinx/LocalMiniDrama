const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { lintHandoff } = require('../src/services/segmentCompile/handoffLint');
const { lintEpisode } = require('../src/services/segmentCompile/episodeLint');
const { isFixableFinding } = require('../src/services/segmentCompile/lint');

const LIN = { character_id: 1, wardrobe_id: null, alias: '林远' };
const HR = { character_id: 2, wardrobe_id: null, alias: '人事' };

function subject(alias, { holding = null, facing = '正对镜头' } = {}) {
  return { alias, frame_pos: '画面中央', facing, gaze: '前方', pose: '站', holding };
}
function shot(subjects, action = '站着') {
  return { seconds: 3, size: '中景', camera: '平视', cut: 'hard', event: null, movement: null, subjects, action, lines: [], sfx: [] };
}
/** 一段 IR：cast 默认林远；shots 是镜头数组 */
function seg(n, shots, { cast = [LIN], scene = 1 } = {}) {
  return {
    storyboard_id: 100 + n,
    storyboard_number: n,
    ir: { version: 1, duration_s: shots.length * 3, scene: { scene_id: scene, state_id: null, setting: 's' }, main_move: '', continuity: { mode: 'refs' }, cast, shots },
  };
}
const codes = (f) => f.map((x) => x.code);

describe('handoff lint', () => {
  it('flags a holding change across segments', () => {
    const f = lintHandoff([
      seg(1, [shot([subject('林远', { holding: '纸箱' })])]),
      seg(2, [shot([subject('林远')])]),
    ]);
    assert.deepEqual(codes(f), ['holding_changed']);
    assert.equal(f[0].level, 'warn');
    assert.equal(f[0].where.storyboard_id, 102);
    assert.equal(f[0].where.segment, 1);
    assert.equal(f[0].where.alias, '林远');
    assert.ok(f[0].msg.includes('纸箱') && f[0].msg.includes('空手'));
  });

  it('stays quiet when the holding is unchanged or explained', () => {
    const quiet = (a, b, actA = '站着', actB = '站着') => lintHandoff([
      seg(1, [shot([subject('林远', { holding: a })], actA)]),
      seg(2, [shot([subject('林远', { holding: b })], actB)]),
    ]);
    assert.deepEqual(quiet('纸箱、传单', '传单，纸箱'), [], '顺序与分隔符不同');
    assert.deepEqual(quiet('纸箱', '纸箱 '), []);
    assert.deepEqual(quiet('纸箱', null, '林远把纸箱放在桌上'), [], '上一镜动作里交代了');
    assert.deepEqual(quiet(null, '纸箱', '站着', '林远拿起纸箱'), [], '下一镜动作里交代了');
    assert.deepEqual(quiet(null, null), []);
    assert.deepEqual(quiet('', null), []);
  });

  it('flags a holding change between shots in one segment', () => {
    const f = lintHandoff([
      seg(1, [
        shot([subject('林远', { holding: '纸箱' })]),
        shot([subject('林远', { holding: '纸箱、解除协议' })], '林远低头'),
      ]),
    ]);
    assert.deepEqual(codes(f), ['holding_changed']);
    assert.equal(f[0].where.shot, 1);
    assert.ok(f[0].msg.includes('解除协议'));
    const explained = lintHandoff([
      seg(1, [
        shot([subject('林远', { holding: '纸箱' })]),
        shot([subject('林远', { holding: '纸箱、解除协议' })], '林远接过解除协议'),
      ]),
    ]);
    assert.deepEqual(explained, []);
  });

  it('flags characters who vanish or appear without an exit or entry', () => {
    const two = [LIN, HR];
    const vanished = lintHandoff([
      seg(1, [shot([subject('林远'), subject('人事')])], { cast: two }),
      seg(2, [shot([subject('林远')])]),
    ]);
    assert.deepEqual(codes(vanished), ['character_vanished']);
    assert.equal(vanished[0].where.alias, '人事');

    const left = lintHandoff([
      seg(1, [shot([subject('林远'), subject('人事')], '人事转身走出会议室')], { cast: two }),
      seg(2, [shot([subject('林远')])]),
    ]);
    assert.deepEqual(left, [], '动作里有离场写法');

    const appeared = lintHandoff([
      seg(1, [shot([subject('林远')])]),
      seg(2, [shot([subject('林远'), subject('人事')])], { cast: two }),
    ]);
    assert.deepEqual(codes(appeared), ['character_appeared']);
    assert.equal(appeared[0].where.alias, '人事');

    const entered = lintHandoff([
      seg(1, [shot([subject('林远')])]),
      seg(2, [shot([subject('林远'), subject('人事')], '人事走进会议室')], { cast: two }),
    ]);
    assert.deepEqual(entered, [], '动作里有入场写法');

    const verbOnly = lintHandoff([
      seg(1, [shot([subject('林远'), subject('人事')], '林远离开座位')], { cast: two }),
      seg(2, [shot([subject('林远')])]),
    ]);
    assert.deepEqual(codes(verbOnly), ['character_vanished'], '离场动词要和角色名在同一镜头动作里对上');

    const crowd = { character_id: 3, wardrobe_id: null, alias: '路人', group: true };
    const group = lintHandoff([
      seg(1, [shot([subject('林远'), subject('路人')])], { cast: [LIN, crowd] }),
      seg(2, [shot([subject('林远')])]),
      seg(3, [shot([subject('林远'), subject('路人')])], { cast: [LIN, crowd] }),
    ]);
    assert.deepEqual(group, [], '群演不参与');
  });

  it('flags a left-right facing flip across segments', () => {
    const facing = (a, b, action = '站着') => lintHandoff([
      seg(1, [shot([subject('林远', { facing: a })])]),
      seg(2, [shot([subject('林远', { facing: b })], action)]),
    ]);
    const flip = facing('身体侧向画左', '身体侧向画右');
    assert.deepEqual(codes(flip), ['facing_flipped']);
    assert.equal(flip[0].where.alias, '林远');
    assert.deepEqual(codes(facing('身体侧向画右', '身体侧向画左')), ['facing_flipped']);
    assert.deepEqual(facing('身体侧向画左', '正对镜头'), []);
    assert.deepEqual(facing('背向镜头', '身体侧向画右'), []);
    assert.deepEqual(facing('身体侧向画左', '身体侧向画左'), []);
    assert.deepEqual(facing('身体侧向画左', '身体侧向画右', '林远转身看向窗外'), [], '动作里有转身');
    assert.deepEqual(facing('背向镜头，头偏向画右', '身体侧向画左'), [], '背向镜头不判侧');
    assert.deepEqual(facing('由画左转向画右', '身体侧向画左'), [], '两边都写了不判侧');

    const two = [LIN, HR];
    const reverse = lintHandoff([
      seg(1, [shot([subject('林远', { facing: '身体侧向画左' }), subject('人事', { facing: '身体侧向画右' })])], { cast: two }),
      seg(2, [shot([subject('林远', { facing: '身体侧向画右' }), subject('人事', { facing: '身体侧向画左' })])], { cast: two }),
    ]);
    assert.deepEqual(reverse, [], '两人同时左右互换是反打换机位');
    const oneOfTwo = lintHandoff([
      seg(1, [shot([subject('林远', { facing: '身体侧向画左' }), subject('人事', { facing: '身体侧向画右' })])], { cast: two }),
      seg(2, [shot([subject('林远', { facing: '身体侧向画右' }), subject('人事', { facing: '身体侧向画右' })])], { cast: two }),
    ]);
    assert.deepEqual(codes(oneOfTwo), ['facing_flipped']);
  });

  it('handles empty, single, cross-scene and non-consecutive input', () => {
    assert.deepEqual(lintHandoff([]), []);
    const a = seg(1, [shot([subject('林远', { holding: '纸箱' })])]);
    assert.deepEqual(lintHandoff([a]), []);
    assert.deepEqual(lintHandoff([seg(1, [shot([])], { cast: [] }), seg(2, [shot([])], { cast: [] })]), [], 'subjects 为空');
    assert.deepEqual(lintHandoff([a, seg(2, [shot([])], { cast: [] })]).map((f) => f.code), ['character_vanished'], '只在一侧出现的人物按规则报，不抛错');

    const changed = seg(2, [shot([subject('林远')])]);
    assert.equal(lintHandoff([a, changed]).length, 1);
    assert.deepEqual(lintHandoff([a, seg(2, [shot([subject('林远')])], { scene: 2 })]), [], '换场景不检查');
    const gap = seg(4, [shot([subject('林远')])]);
    assert.deepEqual(lintHandoff([a, gap]), [], '中间夹着旧分镜不检查');

    const noNumber = (s) => { const { storyboard_number, ...rest } = s; return rest; };
    assert.equal(lintHandoff([noNumber(a), noNumber(changed)]).length, 1, '没有分镜序号按相邻处理');
    assert.equal(lintHandoff([a, noNumber(gap)]).length, 1);

    const input = [a, changed];
    assert.deepEqual(lintHandoff(input), lintHandoff(input), '重复调用结果相同');
  });

  it('reports warnings that are not auto-fixable', () => {
    const segments = [
      seg(1, [shot([subject('林远', { holding: '纸箱', facing: '身体侧向画左' })])]),
      seg(2, [shot([subject('林远', { facing: '身体侧向画右' })])]),
    ];
    const f = lintEpisode(segments, { continuity: { 1: { ambience: '空调低鸣' } } }).filter((x) => x.code !== 'weak_opening');
    assert.deepEqual(f.map((x) => x.code).sort(), ['facing_flipped', 'holding_changed']);
    for (const x of f) {
      assert.equal(x.level, 'warn');
      assert.equal(isFixableFinding(x), false);
    }
  });
});
