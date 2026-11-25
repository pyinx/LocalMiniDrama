const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { createIrTestDb, sampleIr, noopLog } = require('./helpers/segmentIrFixtures');
const storyboardService = require('../src/services/storyboardService');
const segmentCompileService = require('../src/services/segmentCompileService');
const { compileSegment } = require('../src/services/segmentCompile');
const { getVideoCaps, resolveVoiceSource } = require('../src/services/modelCapabilities');
const { prepareWanVideo } = require('../src/services/wanVideoRequest');
const P = require('../src/services/segmentCompile/rules/phrases');

const H3 = { protocol: 'minimax_h3', model: 'MiniMax-H3' };
const SEEDANCE_10 = { protocol: 'volcengine', model: 'doubao-seedance-1-0-pro-250528' };
const WAN_FIXED_AUDIO = { protocol: 'dashscope', model: 'wan2.7-t2v' };
const KLING_OMNI = { protocol: 'kling_omni', model: 'kling-v2-master' };
const VIDU = { protocol: 'vidu', model: 'viduq2' };
const VOLC_UNRECOGNIZED = { protocol: 'volcengine', model: 'some-unrecognized-ark-model' };

const DIALOGUE = '签个字吧。';

function setup() {
  const { db, ids } = createIrTestDb();
  storyboardService.saveSegmentIr(db, noopLog, ids.sbIr, sampleIr({ sceneId: ids.sceneId, linId: ids.linId, hrId: ids.hrId }));
  const episodeId = db.prepare('SELECT episode_id FROM storyboards WHERE id = ?').get(ids.sbIr).episode_id;
  return { db, ids, episodeId };
}

function targetOf({ protocol, model }) {
  return { protocol, model, caps: getVideoCaps({ protocol, model }) };
}

function setProject(db, ids, settings) {
  db.prepare('UPDATE dramas SET metadata = ? WHERE id = ?').run(JSON.stringify({ video_settings: settings }), ids.dramaId);
}

function setEpisode(db, episodeId, settings) {
  db.prepare('UPDATE episodes SET video_settings = ? WHERE id = ?').run(settings ? JSON.stringify(settings) : null, episodeId);
}

function compile(db, ids, model) {
  const r = segmentCompileService.compileStoryboard(db, ids.sbIr, { target: targetOf(model) });
  assert.equal(r.ok, true);
  return r;
}

const notice = (r) => r.findings.find((f) => f.code === 'voice_source_fallback');
const isNative = (r) => r.compiled.request.generate_audio === true
  && r.compiled.prompt.includes(DIALOGUE) && !r.compiled.prompt.includes('放到后期配音');
const isDubbed = (r) => r.compiled.request.generate_audio === false
  && r.compiled.prompt.includes('放到后期配音') && !r.compiled.prompt.includes('嘴型与每个字对齐');

describe('台词声音 voice_source 编译', () => {
  it('default native keeps dialogue on H3', () => {
    const { db, ids } = setup();
    const r = compile(db, ids, H3);
    assert.ok(isNative(r), r.compiled.prompt);
    assert.ok(r.compiled.prompt.includes('嘴型与每个字对齐'));
    assert.equal(notice(r), undefined);
  });

  it('project dubbed compiles silent mouths', () => {
    const { db, ids } = setup();
    setProject(db, ids, { voice_source: 'dubbed' });
    const r = compile(db, ids, H3);
    assert.ok(isDubbed(r), r.compiled.prompt);
    assert.ok(!r.compiled.prompt.includes(DIALOGUE), '台词句不进入提示词');
    assert.ok(r.compiled.prompt.endsWith(P.tailDubbed));
    assert.equal(notice(r), undefined);
  });

  it('episode override wins over project', () => {
    const { db, ids, episodeId } = setup();
    setProject(db, ids, { voice_source: 'dubbed' });
    setEpisode(db, episodeId, { voice_source: 'native' });
    assert.ok(isNative(compile(db, ids, H3)), '本集覆盖为原生');
    setProject(db, ids, { voice_source: 'native' });
    setEpisode(db, episodeId, { voice_source: 'dubbed' });
    assert.ok(isDubbed(compile(db, ids, H3)), '本集覆盖为配音');
    setEpisode(db, episodeId, null);
    assert.ok(isNative(compile(db, ids, H3)), '清除覆盖后跟随项目');
  });

  it('native falls back to dubbed on known non-native models', () => {
    const { db, ids } = setup();
    const r = compile(db, ids, SEEDANCE_10);
    assert.ok(isDubbed(r), r.compiled.prompt);
    const f = notice(r);
    assert.ok(f, '给出降级提示');
    assert.equal(f.level, 'info');
    assert.match(f.msg, /后期配音/);
    // 该型号因参考图上限等原因本来就可能阻断；降级提示自己不能引入阻断
    setProject(db, ids, { voice_source: 'dubbed' });
    const explicit = compile(db, ids, SEEDANCE_10);
    assert.equal(r.blocked, explicit.blocked, '降级提示不改变阻断状态');
    assert.deepEqual(r.findings.filter((x) => x.code !== 'voice_source_fallback'), explicit.findings);
  });

  it('dubbed falls back to native on models that cannot silence audio', () => {
    const { db, ids } = setup();
    setProject(db, ids, { voice_source: 'dubbed' });
    const caps = getVideoCaps(WAN_FIXED_AUDIO);
    assert.ok(caps.nativeAudio && !caps.audioSwitch, '前提：该型号有原生人声且没有音轨开关');
    const r = compile(db, ids, WAN_FIXED_AUDIO);
    assert.equal(r.compiled.request.generate_audio, true, '不得下发万相会拒绝的 generate_audio:false');
    const wan = prepareWanVideo(caps, { model: WAN_FIXED_AUDIO.model, prompt: 'p', duration: 5, generate_audio: r.compiled.request.generate_audio });
    assert.equal(wan.error, undefined, '编译出的请求能通过万相的请求校验');
    assert.ok(prepareWanVideo(caps, { model: WAN_FIXED_AUDIO.model, prompt: 'p', duration: 5, generate_audio: false }).error, '前提：false 会被万相拒绝');
    const f = notice(r);
    assert.ok(f);
    assert.equal(f.level, 'info');
    assert.match(f.msg, /原生人声/);
    assert.equal(r.findings.some((x) => x.level === 'block'), false);
  });

  it('unknown capability honors the choice without notice', () => {
    const { db, ids } = setup();
    const caps = getVideoCaps(VOLC_UNRECOGNIZED);
    assert.ok(caps.unknownFields.includes('nativeAudio'), '前提：该型号的原生人声能力未知');
    const native = compile(db, ids, VOLC_UNRECOGNIZED);
    assert.equal(native.compiled.request.generate_audio, true);
    assert.equal(notice(native), undefined);
    setProject(db, ids, { voice_source: 'dubbed' });
    const dubbed = compile(db, ids, VOLC_UNRECOGNIZED);
    assert.equal(dubbed.compiled.request.generate_audio, false);
    assert.equal(notice(dubbed), undefined);
  });

  it('kling omni is known silent so native falls back to dubbed', () => {
    const { db, ids } = setup();
    for (const silent of [KLING_OMNI, VIDU]) {
      const caps = getVideoCaps(silent);
      assert.ok(!caps.nativeAudio && !caps.unknownFields.includes('nativeAudio'), `${silent.protocol} 适配器固定关闭音轨，是已知不出人声`);
      const r = compile(db, ids, silent);
      assert.equal(r.compiled.request.generate_audio, false, `${silent.protocol} 不能默认编译成有声：成片会被核验为缺音轨`);
      assert.ok(notice(r), silent.protocol);
    }
  });

  it('explicit native override beats caps in compileSegment', () => {
    const { db, ids } = setup();
    const { ir } = segmentCompileService.compileStoryboard(db, ids.sbIr, { target: targetOf(H3) });
    const ctx = (caps, extra = {}) => ({ caps, style: { video: '风格' }, bindings: { characters: {}, scenes: {} }, ...extra });
    const nonNative = { ...getVideoCaps(SEEDANCE_10) };
    assert.equal(compileSegment(ir, ctx(nonNative)).request.generate_audio, false, '没传 native 时只看能力表');
    assert.equal(compileSegment(ir, ctx(nonNative, { native: true })).request.generate_audio, true);
    assert.equal(compileSegment(ir, ctx({ ...nonNative, nativeAudio: true }, { native: false })).request.generate_audio, false);
  });

  it('resolveVoiceSource covers every capability class', () => {
    const table = [
      [H3, 'native', 'native', null],
      [H3, 'dubbed', 'dubbed', null],
      [SEEDANCE_10, 'native', 'dubbed', 'native_unsupported'],
      [SEEDANCE_10, 'dubbed', 'dubbed', null],
      [WAN_FIXED_AUDIO, 'dubbed', 'native', 'cannot_silence'],
      [WAN_FIXED_AUDIO, 'native', 'native', null],
      [KLING_OMNI, 'native', 'dubbed', 'native_unsupported'],
      [VIDU, 'native', 'dubbed', 'native_unsupported'],
      [VOLC_UNRECOGNIZED, 'native', 'native', null],
      [VOLC_UNRECOGNIZED, 'dubbed', 'dubbed', null],
    ];
    for (const [model, preferred, source, fallback] of table) {
      assert.deepEqual(resolveVoiceSource(getVideoCaps(model), preferred), { source, fallback }, `${model.model} ${preferred}`);
    }
  });
});
