/**
 * P2 结构校验：clip-qc 工具注册、Skill 操作内容、service 不调模型/付费接口/不写业务表。
 */
'use strict';
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const SKILLS = path.join(ROOT, 'skills');

describe('P2 skills', () => {
  it('P2 tool registration and clip-qc skill structure', async () => {
    const dir = path.join(SKILLS, 'clip-qc');
    const text = fs.readFileSync(path.join(dir, 'SKILL.md'), 'utf8');
    const match = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
    assert.ok(match, 'clip-qc 缺少 frontmatter');
    const front = Object.fromEntries(match[1].split(/\r?\n/).map((line) => {
      const m = line.match(/^([a-z-]+):\s*(.+)$/);
      return m ? [m[1], m[2].trim()] : [];
    }).filter((pair) => pair.length === 2));
    assert.equal(front.name, 'clip-qc');
    assert.ok(front.description && front.description.length > 10);
    const body = text.slice(match[0].length);
    for (const heading of ['工具调用步骤', '证据与失败处理', '作者确认门槛', '能力边界', '三类归因']) {
      assert.ok(body.includes(heading), `clip-qc 缺少 ${heading}`);
    }
    for (const needle of ['get_take_evidence', 'record_clip_findings', 'requirement_not_executed',
      'single_take_variance', 'prompt_under_specified', 'evidence_ids', 'visible_evidence']) {
      assert.ok(text.includes(needle), `clip-qc 未提及 ${needle}`);
    }
    assert.ok(fs.readdirSync(path.join(dir, 'references')).includes('failure-modes.md'));

    const source = fs.readFileSync(path.join(ROOT, 'src', 'mastra', 'index.mjs'), 'utf8');
    for (const tool of ['get_take_evidence', 'record_clip_findings']) {
      assert.match(source, new RegExp(`\\b${tool}:\\s*tool\\(`), `Agent 未注册 ${tool}`);
    }

    const code = fs.readFileSync(path.join(ROOT, 'src', 'services', 'agentClipQcService.js'), 'utf8');
    assert.ok(!/generateText\s*\(/.test(code), 'clip-qc service 调用了模型');
    assert.ok(!/generateImage|generateVideo|\.create\s*\(/.test(code), 'clip-qc service 调用了付费或写库接口');
    assert.ok(!/UPDATE\s+(video_generations|storyboards|episodes|video_take_reviews)/i.test(code), 'clip-qc service 写了业务表');

    // 工具 execute 必须做 scope 检查
    const tools = fs.readFileSync(path.join(ROOT, 'src', 'mastra', 'tools.mjs'), 'utf8');
    assert.match(tools, /export function executeGetTakeEvidence/);
    assert.match(tools, /export function executeRecordClipFindings/);

    // listSkillDirectories 能发现 clip-qc
    const { listSkillDirectories } = await import('../src/mastra/skills.mjs');
    const validator = (markdown, dirName) => {
      const m = String(markdown).match(/^---\r?\n([\s\S]*?)\r?\n---/);
      if (!m) return { valid: false };
      const name = (m[1].match(/^name:\s*(\S+)/m) || [])[1];
      if (!name || path.basename(dirName) !== name) return { valid: false };
      return { valid: /^description:\s*\S+/m.test(m[1]) };
    };
    const found = listSkillDirectories({ userSkillsDir: SKILLS, log: { warn() {} }, validate: validator });
    assert.ok(found.includes(dir), 'clip-qc 未被技能发现机制加载');
  });
});
