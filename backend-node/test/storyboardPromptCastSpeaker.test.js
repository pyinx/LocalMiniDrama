const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const rules = require('../src/services/segmentCompile/rules/storyboardRules');

const caps = { duration: { min: 4, max: 15, step: 1 } };

// 校验器要求每句台词的说话人都在本段 cast 里（segmentIr/schema.js），规划器也按「出镜者 ∪ 说话人」保留 cast。
// 提示词必须把这个定义讲清楚，否则模型会把 cast 当成「出镜的人」，漏掉画外声的说话人。
// 这条测试只守住提示词里的这两条规则不被无意删掉；模型是否照做需要真实调用才能确认。
describe('storyboard prompt states the cast and speaker contract', () => {
  for (const [entry, build] of [
    ['generate from script', () => rules.systemPrompt(caps)],
    ['convert existing storyboards', () => rules.systemPrompt(caps) + rules.conversionSuffix],
  ]) {
    it(`${entry}: off-screen speakers belong in cast`, () => {
      const prompt = build();
      assert.match(prompt, /cast 列出本段所有出镜的人，以及本段所有台词的说话人/);
      assert.match(prompt, /不在这一段画面里（画外声、意象镜头里的吟诵、os 内心独白），也要放进 cast/);
      assert.match(prompt, /不写进 subjects/);
    });

    it(`${entry}: lines keep the speaker the script names`, () => {
      assert.match(build(), /仍由剧本写明的那个人说/);
    });

    // 校验器只允许 vo 没有说话人（segmentIr/schema.js）；提示词不讲清四种 kind，模型会把旁白标成 os、把无名画外声标成 offscreen 而不写说话人
    it(`${entry}: only vo may go without a speaker`, () => {
      const prompt = build();
      assert.match(prompt, /剧本里的旁白用 vo，speaker 填 null/);
      assert.match(prompt, /dialogue、os、offscreen 必须写 cast 里的具名说话人，speaker 不能是 null/);
    });

    it(`${entry}: unnamed voices stay out of lines`, () => {
      assert.match(build(), /剧本里没有名字的声音.*不写进 lines，写进该镜头的 sfx 或 action/);
    });
  }
});
