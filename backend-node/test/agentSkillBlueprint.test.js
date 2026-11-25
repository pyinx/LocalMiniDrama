/**
 * 蓝图交付的结构校验：只证明设计约束（6 模块、正交、覆盖全部阶段、许可白名单、复用路径存在），
 * 不证明任何一个 Skill 模块的实现效果；后者由各迭代自己的验收标准覆盖。
 */
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const DOC = path.join(ROOT, 'docs', 'agent-skill-method-blueprint.md');
const ALLOWED_LICENSES = new Set(['MIT', 'MIT-0', 'Apache-2.0', 'CC0-1.0', 'CC-BY-4.0']);
const STAGES = ['market', 'adaptation', 'character', 'structure', 'drafting', 'revision', 'storyboard', 'prompt', 'production'];
const MODULE_IDS = ['drama-bible', 'script-doctor', 'novel-deconstruct', 'asset-bible', 'shot-director', 'clip-qc'];
const EXPECTED_ITERATIONS = { P0: ['drama-bible', 'script-doctor'], P1: ['novel-deconstruct', 'asset-bible', 'shot-director'], P2: ['clip-qc'] };

function readDoc() {
  return fs.readFileSync(DOC, 'utf8');
}

function manifest() {
  const text = readDoc();
  const blocks = [...text.matchAll(/```json\s*\n([\s\S]*?)\n```/g)];
  assert.equal(blocks.length, 1, '文档必须只有一个 json 清单块');
  const value = JSON.parse(blocks[0][1]);
  assert.equal(value.version, 1);
  return value;
}

describe('agent skill method blueprint', () => {
  it('has all required blueprint sections', () => {
    const text = readDoc();
    for (const heading of [
      '## 一、目标与理想输入',
      '## 二、现状缺口',
      '## 三、模块划分（唯一事实源）',
      '## 四、分模块说明',
      '## 五、明确排除项',
      '## 六、迭代路线图',
      '## 七、边界声明',
    ]) {
      assert.ok(text.includes(heading), `缺少章节：${heading}`);
    }
    for (const id of MODULE_IDS) {
      assert.ok(text.includes('`' + id + '`'), `缺少模块说明：${id}`);
    }
    assert.match(text, /先立骨再写肉/);
    assert.match(text, /P0/);
    assert.match(text, /P1/);
    assert.match(text, /P2/);
  });

  it('manifest is exact, orthogonal and license-safe', () => {
    const m = manifest();
    assert.equal(m.modules.length, 6);
    assert.deepEqual(m.modules.map((x) => x.id), MODULE_IDS);
    assert.equal(new Set(m.modules.map((x) => x.id)).size, 6);
    for (const mod of m.modules) {
      for (const field of ['boundary', 'non_goals', 'stages', 'data_owner', 'tools', 'reuse', 'sources', 'iteration']) {
        assert.ok(Object.hasOwn(mod, field), `${mod.id} 缺少字段 ${field}`);
      }
      assert.ok(mod.boundary.length > 20, `${mod.id} 的职责边界太短`);
      assert.ok(Array.isArray(mod.non_goals) && mod.non_goals.length > 0, `${mod.id} 缺少非目标`);
      assert.ok(Array.isArray(mod.tools) && mod.tools.length > 0, `${mod.id} 缺少工具契约`);
      for (const tool of mod.tools) {
        assert.ok(tool.name && tool.input && Array.isArray(tool.errors) && tool.errors.length > 0, `${mod.id} 的工具契约不完整`);
      }
      assert.ok(Array.isArray(mod.sources) && mod.sources.length > 0 && mod.sources.length <= 3, `${mod.id} 的来源数量必须为 1–3`);
      for (const s of mod.sources) {
        assert.ok(s.repo && s.use, `${mod.id} 的来源记录不完整`);
        assert.ok(ALLOWED_LICENSES.has(s.license), `${mod.id} 的来源 ${s.repo} 许可不可接受：${s.license}`);
      }
      assert.ok(['P0', 'P1', 'P2'].includes(mod.iteration), `${mod.id} 的迭代非法`);
    }
    const allSources = m.modules.flatMap((x) => x.sources);
    assert.ok(allSources.length <= 12, `来源总数必须 ≤12，实际 ${allSources.length}`);
    assert.deepEqual(
      Object.fromEntries(Object.entries(EXPECTED_ITERATIONS).map(([k, v]) => [k, m.modules.filter((x) => x.iteration === k).map((x) => x.id)])),
      EXPECTED_ITERATIONS
    );
    assert.deepEqual(m.iterations, EXPECTED_ITERATIONS);
    assert.ok(Array.isArray(m.excluded) && m.excluded.length >= 4);
    assert.deepEqual(m.runtime_changes, { new_database_tables: 0, frontend_files: 0, api_endpoints: 0, runtime_files_modified: 0 });
  });

  it('covers every creation stage without adding modules', () => {
    const m = manifest();
    const covered = new Set(m.modules.flatMap((x) => x.stages));
    assert.deepEqual([...covered].sort(), [...STAGES].sort());
    for (const mod of m.modules) {
      assert.ok(mod.stages.every((s) => STAGES.includes(s)), `${mod.id} 含未知阶段`);
    }
  });

  it('every declared reuse path exists', () => {
    const m = manifest();
    const paths = new Set(m.modules.flatMap((x) => x.reuse));
    assert.ok(paths.size > 0);
    const missing = [...paths].filter((p) => !fs.existsSync(path.join(ROOT, p)));
    assert.deepEqual(missing, [], '清单声明的复用路径不存在：' + missing.join(', '));
  });
});
