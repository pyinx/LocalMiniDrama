const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { lintText, lintSegment, lintDialogueFidelity } = require('../src/services/segmentCompile/lint');
const { compileSegment } = require('../src/services/segmentCompile');
const { getVideoCaps } = require('../src/services/modelCapabilities');
const { parseSegmentIr } = require('../src/services/segmentIr/schema');
const { sampleIr } = require('./helpers/segmentIrFixtures');

const IDS = { sceneId: 3, linId: 1, hrId: 2 };
const caps = getVideoCaps({ protocol: 'volcengine_omni', model: 'doubao-seedance-2-0-260128' });
function irOf(mut) {
  const raw = sampleIr(IDS);
  if (mut) mut(raw);
  const r = parseSegmentIr(raw);
  assert.equal(r.ok, true, JSON.stringify(r.errors));
  return r.ir;
}
function compiled(ir) {
  return compileSegment(ir, {
    caps,
    style: { video: '国漫三维' },
    bindings: {
      characters: { 1: { name: '林远', image_url: 'http://h/a.png' }, 2: { name: '人事', image_url: 'http://h/b.png' } },
      scenes: { 3: { name: '会议室', image_url: 'http://h/s.png' } },
    },
  });
}

describe('prompt lint (AC9 / AC37)', () => {
  it('flags each banned pattern', () => {
    const cases = {
      pronoun_reference: '他慢慢抬头',
      refers_previous: '接上一段的动作',
      fade_to_black: '画面渐暗',
      text_or_bgm: '屏幕下方出现字幕',
      image_quality_words: '8K 质感',
      fraction_ratio: '人物占画面 1/3',
      negation: '桌上没有杯子',
    };
    for (const [code, text] of Object.entries(cases)) {
      const f = lintText(text, 'x');
      assert.ok(f.some((x) => x.code === code && x.level === 'warn' && Number.isInteger(x.where.index)), `${code}: ${text}`);
    }
    // 位置定位到 IR 字段
    const ir = irOf((r) => { r.shots[1].action = '她看向窗外，画面淡出'; });
    const found = lintSegment(ir, compiled(ir), caps);
    const fade = found.find((f) => f.code === 'fade_to_black');
    assert.equal(fade.where.path, 'shots.1.action');
    assert.equal(fade.where.match, '淡出');
    // 硬上限为阻断级
    const c = compiled(ir);
    const blocks = lintSegment(ir, { ...c, prompt: c.prompt + ' @图片9' }, { ...caps, maxPromptChars: 10, refImages: 1 });
    for (const code of ['prompt_too_long', 'too_many_references', 'alias_unbound']) {
      assert.ok(blocks.some((f) => f.code === code && f.level === 'block'), code);
    }
  });

  it('clean prompt has no findings', () => {
    const ir = irOf();
    assert.deepEqual(lintSegment(ir, compiled(ir), caps), []);
    assert.deepEqual(lintText('其他同事低头看着屏幕'), [], '「其他」不是代词');
  });

  it('dialogue fidelity against script', () => {
    const ir = irOf();
    const script = [
      '## 场1 日 内 会议室',
      '出场：林远、人事',
      '△ 人事推来协议',
      '人事（公式化）：签个字吧。',
      '林远：是因为绩效吗？',
      '林远（os）：果然轮到我了。',
    ].join('\n');
    assert.deepEqual(lintDialogueFidelity([{ storyboard_id: 1, ir }], script), []);

    const altered = irOf((r) => {
      r.shots[1].lines[0].text = '是因为上个月的绩效吗？';
      r.shots[0].lines[0].speaker = '林远';
      r.shots[1].lines.pop();
    });
    const f = lintDialogueFidelity([{ storyboard_id: 1, ir: altered }], script);
    assert.ok(f.some((x) => x.code === 'line_altered'));
    assert.ok(f.some((x) => x.code === 'speaker_changed'));
    assert.ok(f.some((x) => x.code === 'line_missing' && x.msg.includes('果然轮到我了')));

    const prose = '会议室里，人事把协议推过来，说“签个字吧”。林远沉默片刻，问“是因为绩效吗”。';
    const fz = lintDialogueFidelity([{ storyboard_id: 1, ir }], prose);
    assert.ok(fz.every((x) => x.where.fuzzy === true));
    assert.ok(fz.some((x) => x.code === 'line_not_in_script' && x.msg.includes('果然轮到我了')));
    assert.ok(!fz.some((x) => x.code === 'line_missing'), 'no missing-line claims for prose scripts');
  });
});
