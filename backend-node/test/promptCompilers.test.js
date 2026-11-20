const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { compileSegment } = require('../src/services/segmentCompile');
const { getVideoCaps } = require('../src/services/modelCapabilities');
const { parseSegmentIr } = require('../src/services/segmentIr/schema');
const P = require('../src/services/segmentCompile/rules/phrases');
const { sampleIr } = require('./helpers/segmentIrFixtures');

const IDS = { sceneId: 3, linId: 1, hrId: 2 };
const TARGETS = {
  seedance: { protocol: 'volcengine_omni', model: 'doubao-seedance-2-0-260128' },
  minimax_h3: { protocol: 'minimax_h3', model: 'MiniMax-H3' },
  wan: { protocol: 'dashscope', model: 'wan2.6-r2v-flash' },
  jimeng: { protocol: 'jimeng_novel', model: 'Seedance_2.5' },
};

function irOf(overrides = {}) {
  const r = parseSegmentIr({ ...sampleIr(IDS), ...overrides });
  assert.equal(r.ok, true, JSON.stringify(r.errors));
  return r.ir;
}

function ctxFor(target, extra = {}) {
  return {
    caps: getVideoCaps(target),
    style: { video: '日本动漫画风，精细赛璐璐上色' },
    bindings: {
      characters: {
        1: { name: '林远', role: 'main', image_url: 'http://h/lin.png', voice_style: '男声，三十岁上下，音调偏低，略带沙哑' },
        2: { name: '人事', role: 'supporting', image_url: 'http://h/hr.png', voice_style: '女声，四十岁上下，语速平稳' },
      },
      scenes: { 3: { name: '会议室', image_url: 'http://h/room.png' } },
      props: { 9: { name: '离职协议', image_url: 'http://h/paper.png' } },
      images: { 50: 'http://h/first.png', 51: 'http://h/last.png' },
    },
    ...extra,
  };
}

/** 解析编译产物逐条核对 AC7 的结构要求 */
function checkStructure(out, ir, caps) {
  const { prompt, refs } = out;
  assert.ok(prompt.startsWith(P.stylePrefix), 'style sentence first');
  assert.equal(prompt.split(P.stylePrefix).length - 1, 1, 'style sentence exactly once');
  // 每个参考恰好一句说明，顺序与参考列表一致，且按 角色 > 场景 > 道具 > 其他
  const lines = prompt.split('\n');
  const refLineIdx = refs.map((r) => lines.findIndex((l) => l.startsWith(r.token + ' ')));
  refLineIdx.forEach((i, k) => assert.ok(i > 0, `reference sentence for ${refs[k].token}`));
  assert.deepEqual([...refLineIdx].sort((a, b) => a - b), refLineIdx, 'reference sentences follow the reference list order');
  const rank = { character: 0, crowd: 0, scene: 1, prop: 2, tail_frame: 3 };
  assert.deepEqual(refs.map((r) => rank[r.kind]), [...refs.map((r) => rank[r.kind])].sort((a, b) => a - b));
  // 正文出现的每个参考记号都已绑定
  const tokenRe = out.family === 'jimeng' ? /\{\{([^}]+)\}\}/g : /(?:@图片|character|图)(\d+)/g;
  const bound = new Set(refs.map((r) => r.token));
  for (const m of prompt.matchAll(tokenRe)) assert.ok(bound.has(m[0]), `unbound token ${m[0]}`);
  // 每个镜头：景别、机位、每个出镜者的朝向与视线
  const shotLines = lines.filter((l) => /^镜头\d+（/.test(l));
  assert.equal(shotLines.length, ir.shots.length);
  ir.shots.forEach((shot, k) => {
    const l = shotLines[k];
    assert.ok(l.includes(shot.size) && l.includes(shot.camera), `framing in shot ${k + 1}`);
    for (const s of shot.subjects) assert.ok(l.includes(s.facing) && l.includes(`眼睛看着${s.gaze}`), `facing/gaze in shot ${k + 1}`);
    for (const line of shot.lines) {
      if (caps.nativeAudio) assert.ok(l.includes(`"${line.text}"`), 'native audio quotes the line');
      else assert.ok(!l.includes(line.text), 'dubbed models do not get the spoken text');
    }
    if (caps.nativeAudio) {
      const speakers = new Set(shot.lines.filter((x) => x.kind === 'dialogue').map((x) => x.speaker));
      for (const line of shot.lines.filter((x) => x.kind === 'dialogue')) assert.ok(l.includes('嘴型与每个字对齐'), 'lip-sync phrasing');
      for (const s of shot.subjects.filter((x) => !speakers.has(x.alias) && !shot.lines.some((y) => y.speaker === x.alias))) {
        assert.ok(l.includes('嘴唇合着，不说话'), `silent co-present subject ${s.alias} keeps mouth closed`);
      }
    } else {
      assert.ok(!l.includes('嘴型与每个字对齐'));
      if (shot.lines.some((x) => x.kind === 'dialogue')) assert.ok(l.includes('后期配音'));
    }
  });
  assert.ok(prompt.endsWith(caps.nativeAudio ? P.tailNative : P.tailDubbed), 'tail note follows caps');
  assert.equal(out.findings.filter((f) => f.level === 'block').length, 0, JSON.stringify(out.findings));
}

describe('prompt compilers (AC7 / AC8 / AC26 / AC30 / AC35 / AC39)', () => {
  function familyStructure(family) {
    const target = TARGETS[family];
    const ir = irOf({ prop_refs: [{ prop_id: 9, state_id: null, alias: '协议' }] });
    const ctx = ctxFor(target);
    const out = compileSegment(ir, ctx);
    assert.equal(out.family, family);
    checkStructure(out, ir, ctx.caps);
    if (family === 'jimeng') assert.ok(out.refs.every((r) => r.token === `{{${r.alias}}}`));
    else if (family === 'wan') assert.deepEqual(out.refs.map(r => r.token), ['character1', 'character2', 'character3', 'character4']);
    else assert.deepEqual(out.refs.map((r) => r.token), out.refs.map((_, i) => `@图片${i + 1}`));
  }
  it('seedance structure', () => familyStructure('seedance'));
  it('minimax_h3 structure', () => familyStructure('minimax_h3'));
  it('wan structure', () => familyStructure('wan'));
  it('jimeng structure', () => familyStructure('jimeng'));

  it('audio flag follows caps', () => {
    for (const target of Object.values(TARGETS)) {
      const ctx = ctxFor(target);
      const out = compileSegment(irOf(), ctx);
      assert.equal(out.request.generate_audio, ctx.caps.nativeAudio);
      assert.equal(out.prompt.includes('嘴型与每个字对齐'), ctx.caps.nativeAudio);
    }
  });

  it('voice description identical across segments', () => {
    const ctx = ctxFor(TARGETS.seedance);
    const a = compileSegment(irOf(), ctx).prompt;
    const ir2 = irOf();
    ir2.shots[0].lines = [];
    const b = compileSegment(ir2, ctx).prompt;
    const sentence = P.voice('@图片1', ctx.bindings.characters[1].voice_style);
    assert.equal(a.split(sentence).length - 1, 1, 'once per segment, at first line');
    assert.equal(b.split(sentence).length - 1, 1);
  });

  it('wan disables prompt_extend', () => {
    assert.equal(compileSegment(irOf(), ctxFor(TARGETS.wan)).request.prompt_extend, false);
    for (const t of [TARGETS.seedance, TARGETS.minimax_h3, TARGETS.jimeng]) {
      assert.equal('prompt_extend' in compileSegment(irOf(), ctxFor(t)).request, false);
    }
  });

  it('trims to max length', () => {
    const ir = irOf({ tone: '冷白顶光压在长桌上，空气凝滞，窗外车流声很远' });
    ir.shots.forEach((s) => { s.action += '，' + '他的指节一点点发白'.repeat(8); s.sfx = ['空调低鸣', '远处打印机']; });
    const ctx = ctxFor(TARGETS.seedance);
    const full = compileSegment(ir, ctx).prompt;
    ctx.caps = { ...ctx.caps, maxPromptChars: full.length - 10 };
    const out = compileSegment(ir, ctx);
    assert.ok(out.prompt.length <= ctx.caps.maxPromptChars);
    assert.ok(out.findings.some((f) => f.code === 'prompt_trimmed'));
    for (const shot of ir.shots) for (const l of shot.lines) assert.ok(out.prompt.includes(l.text), 'lines are never trimmed');
    assert.ok(out.prompt.includes('中景，桌侧平视'), 'camera language kept');
    // 刚好等于上限不裁
    const exact = compileSegment(ir, { ...ctx, caps: { ...ctx.caps, maxPromptChars: full.length } });
    assert.equal(exact.prompt, full);
    assert.ok(!exact.findings.some((f) => f.code === 'prompt_trimmed'));
  });

  it('rejects when untrimmable', () => {
    const ctx = ctxFor(TARGETS.seedance);
    ctx.caps = { ...ctx.caps, maxPromptChars: 100 };
    const out = compileSegment(irOf(), ctx);
    assert.ok(out.findings.some((f) => f.level === 'block' && f.code === 'prompt_too_long'));
  });

  it('orders and caps references', () => {
    const ir = irOf({
      cast: [
        { character_id: 2, wardrobe_id: null, alias: '人事' },
        { character_id: 1, wardrobe_id: null, alias: '林远' },
        { character_id: 4, wardrobe_id: null, alias: '同事们', group: true },
      ],
      prop_refs: [{ prop_id: 9, state_id: null, alias: '协议' }],
    });
    const ctx = ctxFor(TARGETS.seedance);
    ctx.bindings.characters[4] = { name: '同事们', role: 'minor', image_url: 'http://h/crowd.png' };
    ctx.caps = { ...ctx.caps, refImages: 3 };
    const out = compileSegment(ir, ctx);
    // 截断优先级：场景 > 主角 > 次要 > 群像 > 道具；输出顺序：角色 > 场景
    assert.deepEqual(out.refs.map((r) => r.alias), ['人事', '林远', '会议室']);
    const dropped = out.findings.filter((f) => f.code === 'reference_dropped').map((f) => f.where.alias);
    assert.deepEqual(dropped.sort(), ['协议', '同事们'].sort());
    assert.ok(!out.prompt.includes('@图片4'));
  });

  it('blocks when duration outside current model envelope', () => {
    const ir = irOf();
    ir.shots[1].seconds = 25;
    ir.duration_s = 28;
    const out = compileSegment(ir, ctxFor(TARGETS.minimax_h3));
    assert.ok(out.findings.some((f) => f.level === 'block' && f.code === 'duration_outside_envelope'));
    assert.equal(out.duration_s, 28, 'never truncated');
    assert.ok(!compileSegment(ir, ctxFor(TARGETS.jimeng)).findings.some((f) => f.code === 'duration_outside_envelope'), '30s model accepts it');
  });

  it('first last frame mode', () => {
    const ir = irOf({ continuity: { mode: 'first_last', first_frame_image_id: 50, last_frame_image_id: 51 } });
    const out = compileSegment(ir, ctxFor(TARGETS.seedance));
    assert.deepEqual(out.refs, []);
    assert.equal(out.request.mode, 'first_last');
    assert.equal(out.request.first_frame_url, 'http://h/first.png');
    assert.equal(out.request.last_frame_url, 'http://h/last.png');
    assert.ok(!/@图片\d/.test(out.prompt));
    assert.ok(out.prompt.includes('林远在画面右侧'), 'aliases become plain names');
  });

  for (const [label, images] of [['missing image', {}], ['image without URL', { 51: null }]]) {
    it(`blocks an explicitly selected last frame: ${label}`, () => {
      const ir = irOf({ continuity: { mode: 'first_last', first_frame_image_id: 50, last_frame_image_id: 51 } });
      const ctx = ctxFor(TARGETS.seedance);
      ctx.bindings.images = { 50: 'http://h/first.png', ...images };
      const out = compileSegment(ir, ctx);
      assert.ok(out.findings.some((f) => f.level === 'block' && f.code === 'asset_missing' && f.msg.includes('尾帧')));
    });
  }

  it('blocks a lost explicit last frame on a split part in reference mode', () => {
    const ir = irOf({ continuity: { mode: 'refs', last_frame_image_id: 999 } });
    const out = compileSegment(ir, ctxFor(TARGETS.seedance));
    assert.ok(out.findings.some((f) => f.level === 'block' && f.code === 'asset_missing'));
  });

  it('accepts first frame alone when no last frame was selected', () => {
    const ir = irOf({ continuity: { mode: 'first_last', first_frame_image_id: 50 } });
    const out = compileSegment(ir, ctxFor(TARGETS.seedance));
    assert.ok(!out.findings.some((f) => f.level === 'block'));
    assert.equal(out.request.first_frame_url, 'http://h/first.png');
    assert.equal(Object.hasOwn(out.request, 'last_frame_url'), false);
  });

  it('first last frame unsupported blocks', () => {
    const ir = irOf({ continuity: { mode: 'first_last', first_frame_image_id: 50 } });
    const out = compileSegment(ir, ctxFor({ protocol: 'jimeng_novel', model: 'Seedance_2.0_mini' }));
    assert.ok(out.findings.some((f) => f.level === 'block' && f.code === 'first_last_unsupported'));
  });

  it('generic family for other protocols', () => {
    for (const protocol of ['vidu', 'kling_omni', 'agnes']) {
      const ctx = ctxFor({ protocol, model: 'whatever' });
      assert.equal(ctx.caps.family, 'generic');
      const ir = irOf({ duration_s: 8 });
      const out = compileSegment(ir, ctx);
      assert.equal(out.family, 'generic');
      assert.ok(out.refs.length <= ctx.caps.refImages, 'AC8 reference cap');
      assert.ok(out.prompt.length <= ctx.caps.maxPromptChars || out.findings.some((f) => f.code === 'prompt_too_long'));
      assert.ok(out.prompt.endsWith(P.tailDubbed), 'unknown audio treated as dubbed');
    }
    const tooLong = irOf();
    tooLong.shots[1].seconds = 11; tooLong.duration_s = 14;
    assert.ok(compileSegment(tooLong, ctxFor({ protocol: 'vidu', model: 'x' })).findings.some((f) => f.code === 'duration_outside_envelope'));
  });

  it('continuity table copied verbatim', () => {
    const table = {
      props: [{ name: '离职协议', look: '三页 A4 纸，右上角订书钉' }],
      position_lock: '林远坐长桌右侧，人事坐左侧，两人隔桌相对',
      axis_lock: '林远始终在画面右侧',
      ambience: '空调低鸣，远处键盘声',
    };
    const ctx = ctxFor(TARGETS.seedance, { continuity: table });
    const a = compileSegment(irOf(), ctx).prompt;
    const ir2 = irOf();
    ir2.shots[0].action = '人事敲了敲桌面';
    const b = compileSegment(ir2, ctx).prompt;
    for (const text of [table.position_lock, table.axis_lock, table.ambience, '离职协议（三页 A4 纸，右上角订书钉）']) {
      assert.ok(a.includes(text) && b.includes(text), text);
    }
    const changed = compileSegment(irOf(), { ...ctx, continuity: { ...table, ambience: '雨声' } }).prompt;
    assert.ok(changed.includes(P.ambience('雨声')) && !changed.includes(table.ambience), 'edit propagates');
  });
});
