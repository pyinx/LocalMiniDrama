/**
 * AC18：仓库内新增的规则文本不得与即梦 jimeng-drama（无许可证，不可再分发）有连续 ≥15 字的重合。
 * 只读取本机已安装的 skill 做比对，不把其内容写进仓库。
 */
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const WINDOW = 15;
const JIMENG_DIR = process.env.JIMENG_DRAMA_DIR || path.join(os.homedir(), '.agents/skills/jimeng-drama');
const BACKEND = path.join(__dirname, '..');
/** 本变更新增的自写规则文本只放在这些目录里 */
const SCANNED_DIRS = ['src/services/segmentCompile/rules', 'src/services/scriptReview/rules'];
const ALLOWLIST = require('../src/services/segmentCompile/rules/verbatimAllowlist.json').phrases;

function walk(dir, exts) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) return walk(p, exts);
    return exts.includes(path.extname(e.name)) ? [p] : [];
  });
}

/** 去掉空白与 markdown 标记，避免靠换行或加粗绕过 */
function normalize(text) {
  return String(text).replace(/[\s*#`>|_~]/g, '');
}

function buildIndex(texts) {
  const set = new Set();
  for (const t of texts) {
    const n = normalize(t);
    for (let i = 0; i + WINDOW <= n.length; i++) set.add(n.slice(i, i + WINDOW));
  }
  return set;
}

function findOverlaps(text, index, allow) {
  const n = normalize(text);
  const allowed = allow.map(normalize);
  const hits = [];
  for (let i = 0; i + WINDOW <= n.length; i++) {
    const w = n.slice(i, i + WINDOW);
    if (index.has(w) && !allowed.some((a) => a.includes(w))) hits.push(w);
  }
  return hits;
}

const jimengFiles = walk(JIMENG_DIR, ['.md', '.txt']);
const skip = jimengFiles.length === 0 ? `未找到即梦 jimeng-drama（${JIMENG_DIR}），无法比对` : false;

describe('no verbatim jimeng text (AC18)', { skip }, () => {
  const index = buildIndex(jimengFiles.map((f) => fs.readFileSync(f, 'utf8')));

  it('detector flags a 15-char quote and ignores 14 chars', () => {
    const sample = normalize(fs.readFileSync(jimengFiles.find((f) => f.endsWith('SKILL.md')) || jimengFiles[0], 'utf8'));
    const start = sample.search(/[一-龥]{20}/);
    assert.ok(start >= 0, 'reference contains a long Chinese run');
    assert.equal(findOverlaps('自写前缀' + sample.slice(start, start + WINDOW) + '自写后缀', index, []).length > 0, true);
    const short = sample.slice(start, start + WINDOW - 1);
    assert.equal(findOverlaps('，' + short + '。', index, []).filter((w) => w.includes(short)).length, 0);
  });

  it('no 15-char overlap', () => {
    const files = SCANNED_DIRS.flatMap((d) => walk(path.join(BACKEND, d), ['.md', '.txt', '.js', '.json']))
      .filter((f) => !f.endsWith('verbatimAllowlist.json'));
    const report = [];
    for (const f of files) {
      const hits = findOverlaps(fs.readFileSync(f, 'utf8'), index, ALLOWLIST);
      if (hits.length) report.push(`${path.relative(BACKEND, f)}: ${hits.slice(0, 3).join(' | ')}`);
    }
    assert.deepEqual(report, [], '与即梦原文重合：\n' + report.join('\n'));
  });
});
