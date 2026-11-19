/**
 * AC20：在已登录的即梦账号上真实跑免费路径（建画布 → 建视频节点带本地参考图 → 报价），余额不变，最后删掉测试画布。
 * 只在 JIMENG_LIVE=1 时运行（`test:live`）；不调用 node run / generate-*，不扣费。
 */
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const renderer = require('../../src/services/jimeng/renderer');
const { createRunner } = require('../../src/services/jimeng/cli');
const aiConfigService = require('../../src/services/aiConfigService');
const storyboardService = require('../../src/services/storyboardService');
const { createIrTestDb, sampleIr, noopLog } = require('../helpers/segmentIrFixtures');
const { tmpStorage, makeClip } = require('../helpers/mediaFixtures');
const { spawnSync } = require('child_process');
const { getFfmpegPath } = require('../../src/utils/ffmpegPath');

const live = process.env.JIMENG_LIVE === '1';

function png(abs, color) {
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  const r = spawnSync(getFfmpegPath(), ['-y', '-loglevel', 'error', '-f', 'lavfi', '-i', `color=c=${color}:s=256x256`, '-frames:v', '1', abs]);
  if (r.status !== 0) throw new Error('无法生成测试参考图');
}

describe('jimeng free path (AC20, live)', { skip: live ? false : '需要 JIMENG_LIVE=1' }, () => {
  it('free path creates, estimates and cleans up', async () => {
    const cli = createRunner();
    const st = await cli(['status']);
    if (st.status !== 'success' || !st.data || !st.data.logged_in) {
      assert.fail('即梦登录已过期或未登录，请重新登录后重跑（终端执行 jimeng-novel login）');
    }
    const before = await cli(['credit', 'get']);
    assert.equal(before.status, 'success');

    const storage = tmpStorage();
    const { db, ids } = createIrTestDb();
    const title = `LMD-live-test-${Date.now()}`;
    db.prepare('UPDATE dramas SET title = ? WHERE id = ?').run(title, ids.dramaId);
    for (const [table, id, rel, color] of [['characters', ids.linId, 'p/characters/lin.png', 'red'], ['characters', ids.hrId, 'p/characters/hr.png', 'green'], ['scenes', ids.sceneId, 'p/scenes/room.png', 'blue']]) {
      png(path.join(storage, rel), color);
      db.prepare(`UPDATE ${table} SET local_path = ? WHERE id = ?`).run(rel, id);
    }
    storyboardService.saveSegmentIr(db, noopLog, ids.sbIr, sampleIr(ids));
    const savedList = aiConfigService.listConfigs;
    aiConfigService.listConfigs = () => [{ id: 1, service_type: 'video', is_active: true, is_default: true, provider: 'jimeng', api_protocol: 'jimeng_novel', model: ['Seedance_2.5'], default_model: 'Seedance_2.5' }];
    renderer.setDeps({ runner: null, cfg: { storage: { local_path: storage, base_url: 'http://localhost:5679/static' } } });
    let projectId = null;
    try {
      const c = await renderer.estimate(db, noopLog, ids.episodeId, [ids.sbIr]);
      projectId = fs.readFileSync(path.join(renderer.projectDir(ids.dramaId), '.jimeng-bound'), 'utf8').trim();
      assert.ok(projectId, 'canvas created and bound');
      assert.equal(c.items.length, 1);
      assert.match(c.items[0].key, /^E01\/S01-/);
      assert.ok(typeof c.total === 'number' && c.total > 0, 'estimate returned a price: ' + JSON.stringify(c));
      assert.ok(c.token);

      const node = await cli(['node', 'get', '--key', c.items[0].key], { cwd: renderer.projectDir(ids.dramaId) });
      assert.equal(node.status, 'success');
      const refs = node.data.config.generation.references || [];
      assert.ok(refs.length >= 2, 'local reference images uploaded: ' + JSON.stringify(refs));

      const after = await cli(['credit', 'get']);
      assert.equal(after.data.balance, before.data.balance, 'balance unchanged');
    } finally {
      aiConfigService.listConfigs = savedList;
      // estimate 可能在画布绑定后、返回报价前失败，仍按绑定 ID 和唯一标题清理。
      const binding = path.join(renderer.projectDir(ids.dramaId), '.jimeng-bound');
      if (!projectId && fs.existsSync(binding)) projectId = fs.readFileSync(binding, 'utf8').trim();
      renderer.setDeps({ runner: null, cfg: null });
      if (projectId) {
        const list = await cli(['canvas', 'list', '--limit', '50']);
        const ours = (list.data && list.data.items || []).find((x) => String(x.projectId) === projectId);
        assert.ok(ours && ours.name === title, `只删除本用例建的画布（${projectId} / ${title}）`);
        const del = await cli(['canvas', 'delete', '--project-id', projectId]);
        assert.equal(del.status, 'success', JSON.stringify(del.error));
        const gone = await cli(['canvas', 'list', '--limit', '50']);
        assert.ok(!(gone.data.items || []).some((x) => String(x.projectId) === projectId), 'test canvas removed');
      }
    }
  });
});
