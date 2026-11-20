const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { resolveStylePreset } = require('../src/constants/generationStylePresets');
const promptI18n = require('../src/services/promptI18n');
const { deriveStoryboardFieldsFromAi } = require('../src/services/episodeStoryboardService');
const { withStoryboardAction } = require('../src/services/universalOmniMultiBeatFormat');

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
  it('keeps the handoff when the generated beat only describes the object', () => {
    const action = '助理把合同递给经理，经理抬手接住。';
    const draft = LLM_TEXT.replace('镜头缓推。', '合同已经放在桌面上。');
    const fields = deriveStoryboardFieldsFromAi({ duration: 5, action, universal_segment_text: draft }, ANIME_ZH, '9:16', { universalOmni: true });
    assert.ok(fields.universalSegmentText.includes(action));
    assert.match(fields.universalSegmentText, /分镜1： 5秒: 合同已经放在桌面上/);
  });

  it('rebuilds a single action note on retry, preserving intentional camera directions and beat timings', () => {
    const draft = '生成一个由以下2个分镜组成的视频。\n分镜1： 2秒: 一镜到底，桌面反光。\n分镜2： 3秒: 她收回手。';
    const first = withStoryboardAction(draft, '助理递出钥匙');
    assert.equal(withStoryboardAction(first, '助理递出钥匙'), first);
    const revised = withStoryboardAction(first, '经理拿起手机');
    assert.doesNotMatch(revised, /钥匙/);
    assert.match(revised, /经理拿起手机/);
    assert.equal(withStoryboardAction(revised, null), draft);
    assert.equal(withStoryboardAction(draft, '她收回手。'), draft);
    assert.equal(withStoryboardAction('', '经理拿起手机'), '');
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
