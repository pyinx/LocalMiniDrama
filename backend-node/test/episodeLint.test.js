const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { lintEpisode } = require('../src/services/segmentCompile/episodeLint');

function seg(id, { scene = 1, move = '缓推', events = ['e'], firstEventShot = 0, tail = undefined } = {}) {
  const shots = [0, 1].map((i) => ({ seconds: 2, event: i === firstEventShot ? events[0] : null }));
  return { storyboard_id: id, ir: { main_move: move, scene: { scene_id: scene }, continuity: { mode: 'refs', ...(tail ? { tail_ref_from: tail } : {}) }, shots } };
}

describe('episode lint (AC28)', () => {
  it('flags each episode rule', () => {
    const segments = [
      seg(1, { firstEventShot: 1, events: ['x'] }), // 第 2 个镜头（2 秒处）才出事件——仍在 3 秒内
      seg(2, { move: '缓推' }),
      seg(3, { move: '急推', tail: 2 }),
      seg(4, { move: '环绕', tail: 3, scene: 2 }),
    ];
    segments[0].ir.shots[0].seconds = 4; // 事件推迟到 4 秒处
    const f = lintEpisode(segments, { continuity: {} });
    const by = (code) => f.filter((x) => x.code === code);
    assert.equal(by('weak_opening')[0].where.storyboard_id, 1);
    assert.equal(by('repeated_main_move')[0].where.segment, 1);
    assert.equal(by('ambience_inconsistent')[0].where.storyboard_id, 2);
    assert.equal(by('tail_chain_too_deep')[0].where.storyboard_id, 4);
    assert.equal(by('tail_chain_too_deep').length, 1, '2 轮以内不报');
  });

  it('clean episode has no findings', () => {
    const segments = [seg(1, { move: '缓推' }), seg(2, { move: '跟拍', tail: 1 }), seg(3, { move: '缓推', scene: 2 })];
    assert.deepEqual(lintEpisode(segments, { continuity: { 1: { ambience: '空调低鸣' } } }), []);
  });
});
