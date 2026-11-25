/**
 * P0 Skill 交付的结构校验：Skill 文件合法性、操作内容、工具注册、校验门槛。
 * 不验证 Skill 的真实创作效果；那由用户使用后的反馈和各迭代 AC 覆盖。
 */
'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { createAgentTestDb } = require('./helpers/agentTestDb');

const ROOT = path.join(__dirname, '..');
const SKILLS = path.join(ROOT, 'skills');

function frontmatter(file) {
  const text = fs.readFileSync(file, 'utf8');
  const match = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  assert.ok(match, `${file} 缺少 frontmatter`);
  const front = {};
  for (const line of match[1].split(/\r?\n/)) {
    const m = line.match(/^([a-z-]+):\s*(.+)$/);
    if (m) front[m[1]] = m[2].trim();
  }
  return { front, body: text.slice(match[0].length) };
}

describe('P0 skills', () => {
  it('skill registration, frontmatter validation and operational content', async () => {
    // 2 份 Skill 目录与合法 frontmatter
    for (const name of ['drama-bible', 'script-doctor']) {
      const dir = path.join(SKILLS, name);
      const { front, body } = frontmatter(path.join(dir, 'SKILL.md'));
      assert.equal(front.name, name, `${name} 的 name 必须与目录名一致`);
      assert.ok(front.description && front.description.length > 10, `${name} 缺少 description`);
      // Operational 内容：工具步骤、证据格式、失败处理、作者确认门槛
      assert.match(body, /工具调用步骤/);
      assert.match(body, /证据格式|笔记文档的形状/);
      assert.match(body, /失败处理/);
      assert.match(body, /作者确认门槛/);
      const refs = fs.readdirSync(path.join(dir, 'references'));
      assert.ok(refs.length >= 1, `${name} 缺少 references`);
    }

    // drama-bible 必提的工具与字段
    const bible = fs.readFileSync(path.join(SKILLS, 'drama-bible', 'SKILL.md'), 'utf8');
    for (const tool of ['get_series_notes', 'save_series_notes', 'check_series_continuity']) {
      assert.ok(bible.includes(tool), `drama-bible 未提及 ${tool}`);
    }
    const doctor = fs.readFileSync(path.join(SKILLS, 'script-doctor', 'SKILL.md'), 'utf8');
    for (const tool of ['review_episode_deep', 'propose_script_edits', 'save_episode_script']) {
      assert.ok(doctor.includes(tool), `script-doctor 未提及 ${tool}`);
    }

    // 5 个工具在 Agent 的 buildTools 中注册
    const source = fs.readFileSync(path.join(ROOT, 'src', 'mastra', 'index.mjs'), 'utf8');
    for (const tool of [
      'get_series_notes', 'save_series_notes', 'check_series_continuity', 'review_episode_deep', 'propose_script_edits',
    ]) {
      assert.match(source, new RegExp(`\\b${tool}:\\s*tool\\(`), `Agent 未注册 ${tool}`);
    }

    // 校验收紧：通过源码文本与行为双重检查（index.mjs 的 validator 是私有函数）
    const { listSkillDirectories } = await import('../src/mastra/skills.mjs');
    const dir = fs.mkdtempSync(path.join(require('os').tmpdir(), 'lmd-p0-skill-'));
    const okDir = path.join(dir, 'valid-skill');
    const noDesc = path.join(dir, 'no-desc');
    const wrongName = path.join(dir, 'wrong-name');
    fs.mkdirSync(okDir);
    fs.mkdirSync(noDesc);
    fs.mkdirSync(wrongName);
    fs.writeFileSync(path.join(okDir, 'SKILL.md'), '---\nname: valid-skill\ndescription: 合法的技能\n---\n# ok');
    fs.writeFileSync(path.join(noDesc, 'SKILL.md'), '---\nname: no-desc\n---\n# no desc');
    fs.writeFileSync(path.join(wrongName, 'SKILL.md'), '---\nname: different-name\ndescription: 名字不匹配\n---\n# wrong');
    const validator = (markdown, dirName) => {
      const match = String(markdown).match(/^---\r?\n([\s\S]*?)\r?\n---/);
      if (!match) return { valid: false };
      const name = (match[1].match(/^name:\s*(\S+)/m) || [])[1];
      const desc = (match[1].match(/^description:\s*(.+)/m) || [])[1];
      if (!name || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name)) return { valid: false };
      if (!desc || !desc.trim()) return { valid: false };
      if (dirName && path.basename(dirName) !== name) return { valid: false };
      return { valid: true };
    };
    const found = listSkillDirectories({ userSkillsDir: dir, log: { warn() {} }, validate: validator });
    assert.deepEqual(found, [okDir]);

    // 生产 validator 与测试 validator 一致：读取源码校验关键约束存在
    assert.ok(source.includes('/^[a-z0-9]+(?:-[a-z0-9]+)*$/'), '缺少 kebab-case 名称校验');
    assert.ok(source.includes("!description || !description.trim()"), '缺少 description 校验');
    assert.ok(source.includes('path.basename(dirName) !== name'), '缺少目录名匹配校验');
  });
});
