const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { resolveStylePreset } = require('../src/constants/generationStylePresets');
const promptI18n = require('../src/services/promptI18n');
const { deriveStoryboardFieldsFromAi } = require('../src/services/episodeStoryboardService');
const { universalDraftWithoutActionNote } = require('../src/services/universalOmniMultiBeatFormat');

const ANIME_ZH = resolveStylePreset('anime style').zh;
const REALISTIC_ZH = resolveStylePreset('realistic').zh;
const LLM_TEXT = [
  '画面风格和类型: 真人写实, 电影风格, 高清画质, 日本动漫画风',
  '生成一个由以下1个分镜组成的视频。',
  '分镜1： 5秒: 镜头缓推。无对白。',
].join('\n');

function universalFor(style) {
  const d = deriveStoryboardFieldsFromAi(
    { shot_number: 1, duration: 5, action: 'a', universal_segment_text: LLM_TEXT },
    style,
    '9:16',
    { universalOmni: true }
  );
  return d.universalSegmentText;
}

describe('universal style line (AC2)', () => {
  it('retains the handoff as source evidence without issuing a second staging direction', () => {
    const action = '助理把合同递给经理，经理抬手接住。';
    const draft = LLM_TEXT.replace('镜头缓推。', '合同已经放在桌面上。');
    const fields = deriveStoryboardFieldsFromAi({ duration: 5, action, universal_segment_text: draft }, ANIME_ZH, '9:16', { universalOmni: true });
    assert.equal(fields.action, action);
    assert.ok(!fields.universalSegmentText.includes(action));
    assert.match(fields.universalSegmentText, /分镜1： 5秒: 合同已经放在桌面上/);
  });

  it('removes the superseded system note on retry and preserves the authored beat timings', () => {
    const draft = '生成一个由以下2个分镜组成的视频。\n分镜1： 2秒: 一镜到底，桌面反光。\n分镜2： 3秒: 她收回手。';
    const old = '本镜动作依据（在以下节拍内各演一次，以此为准）：助理递出钥匙\n' + draft;
    assert.equal(universalDraftWithoutActionNote(old), draft);
    assert.equal(universalDraftWithoutActionNote(draft), draft);
    assert.equal(universalDraftWithoutActionNote(''), '');
  });

  it('keeps a sustained unoccupied shot and all offscreen narration in the batch fallback', () => {
    const narration = '远处传来报时。'.repeat(35);
    const fields = deriveStoryboardFieldsFromAi({ duration: 8, movement: '固定', action: '水面始终平静',
      narration, characters: [] }, ANIME_ZH, '9:16', { universalOmni: true });
    assert.match(fields.universalSegmentText, /分镜1： 8秒: 固定。水面始终平静/);
    assert.ok(fields.universalSegmentText.includes(narration));
    assert.doesNotMatch(fields.universalSegmentText, /@人物|@图片|推轨|横移|分镜2/);
  });

  it('anime drama has no realistic tag', () => {
    const text = universalFor(ANIME_ZH);
    assert.doesNotMatch(text, /真人写实/);
    assert.ok(text.startsWith('画面风格和类型: ' + ANIME_ZH), text.slice(0, 80));
    assert.match(text, /生成一个由以下1个分镜组成的视频/);
  });

  it('realistic drama keeps realistic tag', () => {
    const text = universalFor(REALISTIC_ZH);
    assert.ok(text.startsWith('画面风格和类型: ' + REALISTIC_ZH));
    assert.match(text, /写实/);
  });

  it('LLM spec text no longer forces 真人写实', () => {
    const texts = [
      promptI18n.getUniversalOmniSegmentPrompt(),
      promptI18n.getUniversalOmniMultiBeatFormatSpec({ app: { language: 'zh' } }),
      promptI18n.getUniversalOmniMultiBeatFormatSpec({ app: { language: 'en' } }),
    ];
    for (const t of texts) {
      assert.doesNotMatch(t, /MUST include 真人写实/);
      assert.doesNotMatch(t, /画面风格和类型: 真人写实, 电影风格, 高清画质/);
    }
  });
});

describe('style sentences (AC38)', () => {
  const { deriveStyleSentences } = require('../src/services/segmentCompile/style');

  it('asset style sentence', () => {
    const s = deriveStyleSentences('都市写实摄影，冷白顶光与窗外黄昏逆光，低饱和蓝灰色调，细腻皮肤纹理');
    assert.equal(s.video, '都市写实摄影，冷白顶光与窗外黄昏逆光，低饱和蓝灰色调，细腻皮肤纹理');
    assert.equal(s.asset, '都市写实摄影，低饱和蓝灰色调，细腻皮肤纹理');
    const onlyLight = deriveStyleSentences('柔和晨光');
    assert.equal(onlyLight.asset, '柔和晨光', 'falls back to the video sentence');
  });

  it('mixed vocabulary flagged', () => {
    assert.ok(deriveStyleSentences('真人写实，赛璐璐上色').findings.some((f) => f.code === 'mixed_style_vocabulary'));
    assert.deepEqual(deriveStyleSentences(ANIME_ZH).findings, []);
    assert.deepEqual(deriveStyleSentences('都市写实摄影，低饱和').findings, []);
  });
});
