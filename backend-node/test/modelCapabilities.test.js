const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { getVideoCaps, clampDuration } = require('../src/services/modelCapabilities');

const FIELDS = ['family', 'duration', 'refImages', 'maxPromptChars', 'ratios', 'firstLastFrame', 'nativeAudio', 'unknown', 'unknownFields'];

function assertShape(c) {
  for (const f of FIELDS) assert.ok(f in c, 'missing field ' + f);
  assert.ok(Number.isInteger(c.duration.min) && Number.isInteger(c.duration.max) && Number.isInteger(c.duration.step));
  assert.ok(c.duration.min <= c.duration.max);
  assert.ok(Array.isArray(c.ratios) && c.ratios.length > 0);
  assert.ok(Array.isArray(c.unknownFields));
}

describe('model capabilities (AC4)', () => {
  it('known models', () => {
    const sd2 = getVideoCaps({ protocol: 'volcengine_omni', model: 'doubao-seedance-2-0-260128' });
    assertShape(sd2);
    assert.equal(sd2.family, 'seedance');
    assert.equal(sd2.unknown, false);
    assert.deepEqual(sd2.duration, { min: 4, max: 15, step: 1 });
    assert.equal(sd2.refImages, 9);

    const sd15 = getVideoCaps({ protocol: 'volcengine', model: 'doubao-seedance-1-5-pro-251215' });
    assert.deepEqual(sd15.duration, { min: 5, max: 12, step: 1 });

    const h3 = getVideoCaps({ protocol: 'minimax_h3', model: 'MiniMax-H3' });
    assertShape(h3);
    assert.equal(h3.family, 'minimax_h3');
    assert.deepEqual(h3.duration, { min: 4, max: 15, step: 1 });
    assert.equal(h3.refImages, 9);
    assert.ok(h3.unknownFields.includes('nativeAudio'), 'H3 native audio is unverified');
    assert.equal(h3.nativeAudio, false, 'unverified native audio is treated as non-native');

    const vace = getVideoCaps({ protocol: 'dashscope', model: 'wanx2.1-vace-plus' });
    assertShape(vace);
    assert.equal(vace.family, 'wan');
    assert.equal(vace.refImages, 3);
    assert.equal(vace.sizes['9:16'], '720*1280');
    assert.equal(getVideoCaps({ protocol: 'dashscope', model: 'wan2.6-r2v-flash' }).refImages, 5);
    assert.equal(getVideoCaps({ protocol: 'dashscope', model: 'wan2.2-kf2v-flash' }).firstLastFrame, true);

    const j25 = getVideoCaps({ protocol: 'jimeng_novel', model: 'Seedance_2.5' });
    assertShape(j25);
    assert.equal(j25.family, 'jimeng');
    assert.deepEqual(j25.duration, { min: 4, max: 30, step: 1 });
    assert.equal(j25.refImages, 30);
    assert.equal(j25.maxPromptChars, 15000);
    assert.equal(j25.nativeAudio, true);
    assert.equal(getVideoCaps({ protocol: 'jimeng_novel', model: 'Seedance_2.0_mini' }).firstLastFrame, false);
    assert.equal(getVideoCaps({ protocol: 'jimeng_novel', model: 'seedance2.0_fast_vision' }).maxPromptChars, 5000);
  });

  it('unknown model is conservative', () => {
    const u = getVideoCaps({ protocol: 'some_new_protocol', model: 'mystery-v9' });
    assertShape(u);
    assert.equal(u.unknown, true);
    assert.equal(u.family, 'generic');
    assert.equal(u.nativeAudio, false);
    assert.equal(u.firstLastFrame, false);
    assert.ok(u.duration.max <= 10);
    assert.ok(u.refImages <= 3);
    assert.ok(u.maxPromptChars <= 2000);
    const known = getVideoCaps({ protocol: 'jimeng_novel', model: 'Seedance_2.5' });
    u.ratios.push('x');
    assert.ok(!known.ratios.includes('x'), 'callers cannot mutate the table');
  });

  it('clampDuration aligns to envelope and step', () => {
    const c = { duration: { min: 5, max: 10, step: 5 } };
    assert.equal(clampDuration(c, 7), 5);
    assert.equal(clampDuration(c, 8), 10);
    assert.equal(clampDuration(c, 30), 10);
    assert.equal(clampDuration(c, 0), 5);
    assert.equal(clampDuration({ duration: { min: 4, max: 15, step: 1 } }, 3.6), 4);
  });

  it('videoClient reads limits from the table', () => {
    const src = fs.readFileSync(path.join(__dirname, '../src/services/videoClient.js'), 'utf8');
    assert.doesNotMatch(src, /const maxRef = 9/);
    assert.doesNotMatch(src, /Math\.min\(refs\.length, 9\)/);
    assert.doesNotMatch(src, /Math\.min\(15, Math\.max\(4, safe\)\)/);
    assert.doesNotMatch(src, /const WAN_SIZE_BY_RATIO/);
    assert.match(src, /require\('\.\/modelCapabilities'\)/);
  });
});
