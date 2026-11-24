/**
 * 本机即梦 jimeng-novel CLI 渲染后端已从 main 移除（完整代码在远程 jimeng 分支）。
 * 保留项：火山 Seedance API、jimeng_ai_api、第三方素材托管（jimeng2_*）。
 */
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { setupRouter } = require('../src/routes');
const aiConfigService = require('../src/services/aiConfigService');
const videoService = require('../src/services/videoService');
const { getVideoCaps } = require('../src/services/modelCapabilities');
const { createIrTestDb, noopLog } = require('./helpers/segmentIrFixtures');

const REPO = path.join(__dirname, '..', '..');
const SCANNED = ['backend-node/src', 'backend-node/test', 'frontweb/src', 'frontweb/test'];
const EXTS = new Set(['.js', '.mjs', '.cjs', '.vue', '.json', '.md', '.sql']);
const CLI_TOKENS = [
  'jimeng_novel',
  'jimeng-novel',
  'services/jimeng/',
  'jimeng_confirmation',
  'JimengConfirmDialog',
  '即梦整集报价',
  'jimeng_unavailable',
  'jimeng_cli_error',
  'jimengStatus',
  'jimengEstimate',
  'jimengOption',
  '/integrations/jimeng',
];

function walk(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) return e.name === 'node_modules' ? [] : walk(p);
    return EXTS.has(path.extname(e.name)) ? [p] : [];
  });
}

describe('jimeng-novel CLI removal', () => {
  it('no CLI references remain in backend or frontend sources', () => {
    const hits = [];
    for (const dir of SCANNED) {
      for (const file of walk(path.join(REPO, dir))) {
        if (file === __filename) continue;
        const text = fs.readFileSync(file, 'utf8');
        for (const token of CLI_TOKENS) {
          if (text.includes(token)) hits.push(`${path.relative(REPO, file)}: ${token}`);
        }
      }
    }
    assert.deepEqual(hits, []);
  });

  it('router exposes no CLI routes and keeps the asset-list route', () => {
    const { db } = createIrTestDb();
    const router = setupRouter({ storage: { local_path: '/tmp/jimeng-cli-removed', base_url: 'http://localhost/static' } }, db, noopLog);
    const routes = router.stack.filter((l) => l.route).map((l) => `${Object.keys(l.route.methods)[0]} ${l.route.path}`);
    assert.deepEqual(routes.filter((r) => /jimeng/i.test(r)), ['post /ai-configs/jimeng2-list-assets']);
  });

  it('legacy jimeng_novel rows do not break migration, config listing or poll resume', async () => {
    const { db, ids } = createIrTestDb();
    const now = new Date().toISOString();
    db.prepare(
      `INSERT INTO ai_service_configs (service_type, provider, name, api_protocol, base_url, model, default_model, is_default, is_active, created_at, updated_at)
       VALUES ('video', 'jimeng', '旧即梦 CLI', 'jimeng_novel', 'local://jimeng-novel', ?, 'Seedance_2.5', 1, 1, ?, ?)`
    ).run(JSON.stringify(['Seedance_2.5']), now, now);
    const genId = db.prepare(
      `INSERT INTO video_generations (drama_id, storyboard_id, provider, prompt, model, status, provider_task_id, created_at, updated_at)
       VALUES (?, ?, 'jimeng_novel', 'p', 'Seedance_2.5', 'processing', 'E01/S01-legacy', ?, ?)`
    ).run(ids.dramaId, ids.sbIr, now, now).lastInsertRowid;

    const configs = aiConfigService.listConfigs(db, 'video');
    assert.equal(configs.length, 1);
    assert.equal(configs[0].api_protocol, 'jimeng_novel');

    // 没有 Base URL 校验时续查会进入真实轮询，所以给它一个上限，让回归表现为失败而不是无限等待
    const settled = await Promise.race([
      videoService.resumePollForVideoGeneration(db, noopLog, genId).then(() => true),
      new Promise((resolve) => setTimeout(() => resolve(false), 5000).unref()),
    ]);
    assert.equal(settled, true, 'resume must fail fast instead of polling a non-http base_url');
    const row = db.prepare('SELECT status, error_msg FROM video_generations WHERE id = ?').get(genId);
    assert.equal(row.status, 'failed');
    assert.match(row.error_msg, /Base URL/);
  });

  it('old CLI model ids fall back to the generic capability family', () => {
    const caps = getVideoCaps({ protocol: 'jimeng_novel', model: 'Seedance_2.5' });
    assert.equal(caps.family, 'generic');
    assert.equal(caps.unknown, true);
  });
});
