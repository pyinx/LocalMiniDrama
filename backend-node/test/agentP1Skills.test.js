/**
 * P1 结构校验：7 工具注册、3 份 Skill 合法与操作内容、不调用付费接口。
 */
'use strict';
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const SKILLS = path.join(ROOT, 'skills');

function skillText(name, section) {
  const dir = path.join(SKILLS, name);
  const text = fs.readFileSync(path.join(dir, 'SKILL.md'), 'utf8');
  const match = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  assert.ok(match, `${name} 缺少 frontmatter`);
  const front = {};
  for (const line of match[1].split(/\r?\n/)) {
    const m = line.match(/^([a-z-]+):\s*(.+)$/);
    if (m) front[m[1]] = m[2].trim();
  }
  assert.equal(front.name, name, `${name} 的 name 必须与目录名一致`);
  assert.ok(front.description && front.description.length > 10, `${name} 缺少 description`);
  const body = text.slice(match[0].length);
  for (const heading of ['工具调用步骤', '证据与失败处理', '作者确认门槛', '能力边界']) {
    assert.ok(body.includes(heading), `${name} 缺少 ${heading}`);
  }
  assert.ok(fs.readdirSync(path.join(dir, 'references')).length >= 1, `${name} 缺少 references`);
  if (section) for (const needle of section) assert.ok(text.includes(needle), `${name} 未提及 ${needle}`);
  return text;
}

describe('P1 skills', () => {
  it('P1 tool registration and skill structure', async () => {
    skillText('novel-deconstruct', ['get_source_facts', 'propose_episode_split', 'source_changed']);
    skillText('asset-bible', ['get_asset_matrix', 'propose_prop_states', 'check_asset_lock', 'asset_unready']);
    skillText('shot-director', ['propose_blocking', 'review_shot_continuity', 'legacy_storyboard']);

    const source = fs.readFileSync(path.join(ROOT, 'src', 'mastra', 'index.mjs'), 'utf8');
    for (const tool of [
      'get_source_facts', 'propose_episode_split', 'get_asset_matrix', 'propose_prop_states',
      'check_asset_lock', 'propose_blocking', 'review_shot_continuity',
    ]) {
      assert.match(source, new RegExp(`\\b${tool}:\\s*tool\\(`), `Agent 未注册 ${tool}`);
    }

    // 付费接口只在 P1 service 的注释里出现「不调用」，真实调用不存在
    for (const file of ['agentAssetService.js', 'agentShotService.js', 'agentNovelService.js']) {
      const code = fs.readFileSync(path.join(ROOT, 'src', 'services', file), 'utf8');
      assert.ok(!/\.generateImage\s*\(|\.generateWardrobeBody\s*\(/.test(code), `${file} 调用了付费出图接口`);
      assert.ok(!/\.create\s*\([^)]*prop|\.setContinuity\s*\(/.test(code), `${file} 调用了写库接口`);
    }

    // listSkillDirectories 能发现三份新 Skill
    const { listSkillDirectories } = await import('../src/mastra/skills.mjs');
    const validator = (markdown, dirName) => {
      const m = String(markdown).match(/^---\r?\n([\s\S]*?)\r?\n---/);
      if (!m) return { valid: false };
      const name = (m[1].match(/^name:\s*(\S+)/m) || [])[1];
      if (!name || path.basename(dirName) !== name) return { valid: false };
      return { valid: /^description:\s*\S+/m.test(m[1]) };
    };
    const found = listSkillDirectories({ userSkillsDir: SKILLS, log: { warn() {} }, validate: validator });
    for (const name of ['novel-deconstruct', 'asset-bible', 'shot-director']) {
      assert.ok(found.includes(path.join(SKILLS, name)), `${name} 未被技能发现机制加载`);
    }
  });
});
