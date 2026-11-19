const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const renderer = require('../src/services/jimeng/renderer');
const aiConfigService = require('../src/services/aiConfigService');
const videoService = require('../src/services/videoService');
const videoRoutes = require('../src/routes/videos');
const storyboardService = require('../src/services/storyboardService');
const { createIrTestDb, sampleIr, mockRes, noopLog } = require('./helpers/segmentIrFixtures');
const { tmpStorage } = require('./helpers/mediaFixtures');
const { fakeJimengCli } = require('./helpers/fakeJimengCli');

const JIMENG = { id: 9, service_type: 'video', is_active: true, is_default: true, provider: 'jimeng', api_protocol: 'jimeng_novel', model: ['Seedance_2.5'], default_model: 'Seedance_2.5' };
const SEEDANCE = { id: 1, service_type: 'video', is_active: true, is_default: true, provider: 'volcengine', api_protocol: 'volcengine_omni', base_url: 'https://ark', api_key: 'k', model: ['doubao-seedance-2-0-260128'], default_model: 'doubao-seedance-2-0-260128' };

let db, ids, storage, cli, savedList, savedProc;

function writeImage(rel, content = 'img') {
  fs.mkdirSync(path.dirname(path.join(storage, rel)), { recursive: true });
  fs.writeFileSync(path.join(storage, rel), content);
  return rel;
}

function setup(cliOpts = {}, config = JIMENG) {
  ({ db, ids } = createIrTestDb());
  storage = tmpStorage();
  db.prepare('UPDATE characters SET local_path = ? WHERE id = ?').run(writeImage('p/characters/lin.png'), ids.linId);
  db.prepare('UPDATE characters SET local_path = ? WHERE id = ?').run(writeImage('p/characters/hr.png'), ids.hrId);
  db.prepare('UPDATE scenes SET local_path = ? WHERE id = ?').run(writeImage('p/scenes/room.png'), ids.sceneId);
  storyboardService.saveSegmentIr(db, noopLog, ids.sbIr, sampleIr(ids));
  storyboardService.saveSegmentIr(db, noopLog, ids.sbLegacy, sampleIr(ids, { main_move: '跟拍' }));
  cli = fakeJimengCli(cliOpts);
  aiConfigService.listConfigs = () => [config];
  renderer.setDeps({ runner: cli.runner, cfg: { storage: { local_path: storage, base_url: 'http://localhost:5679/static' } }, wait: { run: 0, result: 0, maxPolls: 3 } });
}

beforeEach(() => {
  savedList = aiConfigService.listConfigs;
  savedProc = videoService.processVideoGeneration;
  videoService.processVideoGeneration = () => {};
});
afterEach(async () => {
  // 等本用例路由里起的后台提交/轮询跑完，避免它们落到下一个用例的假 CLI 上
  await new Promise((r) => setTimeout(r, 60));
  aiConfigService.listConfigs = savedList;
  videoService.processVideoGeneration = savedProc;
  // 不能复位为 null（null = 真实 CLI）：仍在跑的后台任务一旦落到真实 CLI 就会在用户账号上建画布
  renderer.setDeps({ runner: async () => ({ status: 'error', data: null, error: { code: 'TEST_ENDED', message: 'test ended' } }), cfg: { storage: { local_path: storage } }, wait: { run: 5, result: 30, maxPolls: 120 } });
});

describe('jimeng renderer never reaches the real CLI from unit tests', () => {
  it('real runner blocked inside the test process', async () => {
    renderer.setDeps({ runner: null });
    aiConfigService.listConfigs = () => [JIMENG];
    const st = await renderer.status(null);
    assert.equal(st.available, false);
    assert.match(st.message, /测试进程中禁止/);
  });
});

async function post(body) {
  const res = mockRes();
  await videoRoutes(db, noopLog).create({ body: { drama_id: ids.dramaId, ...body } }, res);
  return res;
}
const estimate = (sbIds = [ids.sbIr]) => renderer.estimate(db, noopLog, ids.episodeId, sbIds);
const gen = (id) => db.prepare('SELECT * FROM video_generations WHERE id = ?').get(id);
const genCount = () => db.prepare('SELECT COUNT(*) AS n FROM video_generations').get().n;

describe('jimeng renderer availability (AC15)', () => {
  it('unavailable when missing', async () => {
    setup({ installed: false });
    assert.equal((await renderer.status(db)).reason, 'not_installed');
    await assert.rejects(estimate(), (e) => e.code === 'jimeng_unavailable');
    const res = await post({ storyboard_id: ids.sbIr, jimeng_confirmation: 'x' });
    assert.equal(res.statusCode, 503);
    assert.equal(res.body.error.details.reason, 'not_installed');
    assert.equal(cli.count('node'), 0, 'no node commands');
    assert.equal(genCount(), 0);

    setup({}, SEEDANCE);
    assert.equal((await renderer.status(db)).reason, 'not_configured');
    const other = await post({ storyboard_id: ids.sbIr });
    assert.equal(other.statusCode, 201, 'other protocols unaffected');
    assert.equal(cli.calls.length, 0, 'CLI never touched for other protocols');
  });

  it('unavailable when logged out', async () => {
    setup({ loggedIn: false });
    const st = await renderer.status(db);
    assert.deepEqual([st.available, st.reason], [false, 'not_logged_in']);
    const res = await post({ storyboard_id: ids.sbIr, jimeng_confirmation: 'x' });
    assert.equal(res.statusCode, 503);
    assert.equal(cli.count('node'), 0);
  });
});

describe('jimeng renderer credits safety (AC16 / AC34)', () => {
  it('requires matching estimate', async () => {
    setup();
    const none = await post({ storyboard_id: ids.sbIr });
    assert.equal(none.statusCode, 409);
    assert.equal(none.body.error.code, 'confirmation_required');
    assert.equal(genCount(), 0);
    const { token, items } = await estimate();
    const ok = await post({ storyboard_id: ids.sbIr, jimeng_confirmation: token });
    assert.equal(ok.statusCode, 201, JSON.stringify(ok.body));
    const row = gen(ok.body.data.id);
    assert.equal(row.provider, 'jimeng_novel');
    assert.equal(row.provider_task_id, items[0].key, 'node key stored before node run');
    assert.equal(cli.count('node', 'run'), 0, 'run happens only in the background step');
    const legacy = await post({ storyboard_id: ids.sbLegacy, jimeng_confirmation: token });
    assert.equal(legacy.body.error.code, 'confirmation_required', 'storyboard not in this estimate');
  });

  it('stale confirmation rejected', async () => {
    setup();
    const { token } = await estimate();
    const ir = sampleIr(ids);
    ir.shots[0].action = '人事把协议重重拍在桌上';
    storyboardService.saveSegmentIr(db, noopLog, ids.sbIr, ir);
    const res = await post({ storyboard_id: ids.sbIr, jimeng_confirmation: token });
    assert.equal(res.statusCode, 409);
    assert.equal(res.body.error.code, 'confirmation_stale');

    const again = await estimate();
    writeImage('p/characters/lin.png', 'redrawn');
    const imgChanged = await post({ storyboard_id: ids.sbIr, jimeng_confirmation: again.token });
    assert.equal(imgChanged.body.error.code, 'confirmation_stale', 'reference image content is part of the hash');
    assert.equal(genCount(), 0);
  });

  it('refs become local paths', async () => {
    setup();
    const quote = await estimate();
    const create = cli.nodes.get(quote.items[0].key).args;
    const refs = create.filter((_, i) => create[i - 1] === '--ref');
    assert.ok(refs.length >= 2);
    for (const r of refs) {
      const p = r.split('=file:')[1];
      assert.ok(path.isAbsolute(p) && p.startsWith(storage) && fs.existsSync(p), r);
    }
    assert.ok(create.includes('--prompt-file'));
    db.prepare("UPDATE characters SET local_path = NULL, image_url = 'https://cdn.example.com/lin.png' WHERE id = ?").run(ids.linId);
    await assert.rejects(estimate(), (e) => e.code === 'reference_not_local');
  });

  it('repeat click single submit', async () => {
    setup();
    const a = await estimate();
    const b = await estimate();
    assert.equal((await post({ storyboard_id: ids.sbIr, jimeng_confirmation: a.token })).statusCode, 201);
    const second = await post({ storyboard_id: ids.sbIr, jimeng_confirmation: b.token });
    assert.equal(second.statusCode, 409);
    assert.equal(second.body.error.code, 'generation_in_progress');
    assert.equal(genCount(), 1);
  });

  it('consumed token cannot resubmit', async () => {
    setup({ onRun: () => ({ status: 'error', data: null, error: { code: 'SUBMIT_REJECTED', message: '内容审核未通过' } }) });
    const { token } = await estimate();
    const first = await post({ storyboard_id: ids.sbIr, jimeng_confirmation: token });
    await renderer.runSubmitted(db, noopLog, first.body.data.id);
    assert.equal(gen(first.body.data.id).status, 'failed');
    assert.match(gen(first.body.data.id).error_msg, /未扣费/);
    const retry = await post({ storyboard_id: ids.sbIr, jimeng_confirmation: token });
    assert.equal(retry.statusCode, 409);
    assert.equal(retry.body.error.code, 'confirmation_consumed');
    assert.equal(cli.count('node', 'run'), 1);
  });

  it('never resubmits unknown', async () => {
    setup({ onRun: () => ({ status: 'error', data: null, error: { code: 'SUBMISSION_UNKNOWN', message: '提交结果不确定' } }) });
    const { token } = await estimate();
    const res = await post({ storyboard_id: ids.sbIr, jimeng_confirmation: token });
    cli.finish(gen(res.body.data.id).provider_task_id);
    await renderer.runSubmitted(db, noopLog, res.body.data.id);
    const row = gen(res.body.data.id);
    assert.equal(row.status, 'completed');
    assert.ok(fs.existsSync(path.join(storage, row.local_path)));
    assert.equal(cli.count('node', 'run'), 1, 'never resubmitted');
    assert.ok(cli.count('node', 'result') >= 1);
  });

  it('crash after submit polls not resubmits', async () => {
    setup({ onRun: () => new Promise(() => {}) }); // 进程在 node run 期间挂掉，永不返回
    const { token } = await estimate();
    const res = await post({ storyboard_id: ids.sbIr, jimeng_confirmation: token });
    renderer.runSubmitted(db, noopLog, res.body.data.id);
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(cli.count('node', 'run'), 1);
    assert.equal(gen(res.body.data.id).provider_task_id, cli.calls.find(a => a[1] === 'run')[3]);
    // 重启：startup 恢复只查结果
    cli.finish(gen(res.body.data.id).provider_task_id);
    await videoService.resumePollForVideoGeneration(db, noopLog, res.body.data.id);
    assert.equal(gen(res.body.data.id).status, 'completed');
    assert.equal(cli.count('node', 'run'), 1, 'restart polls, does not resubmit');
  });

  it('rerender polls new run', async () => {
    setup();
    const first = await post({ storyboard_id: ids.sbIr, jimeng_confirmation: (await estimate()).token });
    cli.finish(gen(first.body.data.id).provider_task_id);
    await renderer.runSubmitted(db, noopLog, first.body.data.id);
    const g1 = gen(first.body.data.id);
    assert.equal(g1.status, 'completed');

    const second = await post({ storyboard_id: ids.sbIr, jimeng_confirmation: (await estimate()).token });
    cli.finish(gen(second.body.data.id).provider_task_id);
    await renderer.runSubmitted(db, noopLog, second.body.data.id);
    const g2 = gen(second.body.data.id);
    assert.notEqual(g2.run_key, g1.run_key);
    assert.equal(fs.readFileSync(path.join(storage, g2.local_path), 'utf8'), `video-${g2.run_key}`, 'second render gets its own run output');
    assert.equal(fs.readFileSync(path.join(storage, g1.local_path), 'utf8'), `video-${g1.run_key}`, 'first output untouched');

    // 一条仍记着旧 run 的进行中记录（例如重启后恢复）不能拿到新 run 的结果
    const now = new Date().toISOString();
    const stale = Number(db.prepare("INSERT INTO video_generations (drama_id, storyboard_id, provider, prompt, provider_task_id, run_key, status, created_at, updated_at) VALUES (?, ?, 'jimeng_novel', 'p', ?, ?,  'processing', ?, ?)")
      .run(ids.dramaId, ids.sbIr, g2.provider_task_id, g1.run_key, now, now).lastInsertRowid);
    await renderer.pollOnce(db, noopLog, stale);
    assert.equal(gen(stale).status, 'failed');
    assert.equal(gen(stale).local_path, null);
    assert.match(gen(stale).error_msg, /取代/);
  });

  it('competing estimates keep separate nodes, prompts and reference bytes', async () => {
    setup();
    const [a, b] = await Promise.all([estimate(), estimate()]);
    assert.notEqual(a.items[0].key, b.items[0].key);
    assert.equal(cli.count('init'), 1);
    const args = cli.nodes.get(a.items[0].key).args;
    const promptFile = create => create[create.indexOf('--prompt-file') + 1].split('#')[0];
    assert.notEqual(promptFile(args), promptFile(cli.nodes.get(b.items[0].key).args));
    const refs = args.filter((_, i) => args[i - 1] === '--ref').map(x => x.split('=file:')[1]);
    const id = renderer.prepareSubmit(db, noopLog, ids.sbIr, a.token);
    const changed = sampleIr(ids);
    changed.shots[0].action = '人事把协议重重拍在桌上';
    storyboardService.saveSegmentIr(db, noopLog, ids.sbIr, changed);
    const c = await estimate();
    const readPrompt = create => fs.readFileSync(path.join(renderer.projectDir(ids.dramaId), promptFile(create)), 'utf8');
    assert.notEqual(readPrompt(args), readPrompt(cli.nodes.get(c.items[0].key).args));
    assert.equal(readPrompt(args), `## 正文\n${gen(id).prompt}\n`);
    writeImage('p/characters/lin.png', 'updated');
    assert.ok(refs.every(p => fs.readFileSync(p, 'utf8') === 'img'));
    await renderer.runSubmitted(db, noopLog, id);
    assert.equal(cli.count('node', 'create'), 3);
    assert.equal(cli.calls.find(c => c[1] === 'run')[3], a.items[0].key);
  });

  it('restart waits through a failed ownership query and rejects mismatched results', async () => {
    setup();
    const q = await estimate();
    const id = renderer.prepareSubmit(db, noopLog, ids.sbIr, q.token);
    await renderer.runSubmitted(db, noopLog, id);
    const key = q.items[0].key;
    cli.finish(key);
    renderer.setDeps({ runner: async (args, ctx) => args[1] === 'get'
      ? { status: 'error', error: { code: 'TIMEOUT' } } : cli.runner(args, ctx) });
    const prior = cli.count('node', 'result');
    assert.equal(await renderer.pollOnce(db, noopLog, id), 'pending');
    assert.equal(cli.count('node', 'result'), prior);
    for (const wrong of [{ key: 'other' }, { runId: 'other' }]) {
      renderer.setDeps({ runner: async (args, ctx) => {
        const r = await cli.runner(args, ctx);
        if (args[1] === 'result') Object.assign(r.data.items[0], wrong);
        return r;
      } });
      assert.equal(await renderer.pollOnce(db, noopLog, id), 'pending');
      assert.equal(gen(id).local_path, null);
    }
    renderer.setDeps({ runner: cli.runner });
    await videoService.resumePollForVideoGeneration(db, noopLog, id);
    assert.equal(gen(id).status, 'completed');
    assert.equal(cli.count('node', 'run'), 1);
  });

  it('legacy shared node with unknown run cannot adopt the current result', async () => {
    setup();
    const q = await estimate();
    const id = renderer.prepareSubmit(db, noopLog, ids.sbIr, q.token);
    db.prepare("UPDATE video_generations SET provider_task_id = 'E01/S01', compiled_json = '{}', run_key = 'submitting' WHERE id = ?").run(id);
    await videoService.resumePollForVideoGeneration(db, noopLog, id);
    assert.equal(gen(id).status, 'failed');
    assert.equal(gen(id).local_path, null);
    assert.equal(cli.count('node', 'result'), 0);
    assert.equal(cli.count('node', 'run'), 0);
  });

  for (const identified of [true, false]) {
    it(`legacy result with ${identified ? 'explicit' : 'missing'} run identity`, async () => {
      setup();
      const q = await estimate();
      const id = renderer.prepareSubmit(db, noopLog, ids.sbIr, q.token);
      const key = 'E01/S01';
      await cli.runner(['node', 'run', '--key', key]);
      cli.finish(key);
      const runId = cli.nodes.get(key).runId;
      db.prepare("UPDATE video_generations SET provider_task_id = ?, compiled_json = '{}', run_key = ? WHERE id = ?").run(key, runId, id);
      renderer.setDeps({ runner: async (args, ctx) => {
        const r = await cli.runner(args, ctx);
        if (identified && args[1] === 'result') r.data.items[0].runId = runId;
        return r;
      } });
      await videoService.resumePollForVideoGeneration(db, noopLog, id);
      assert.equal(gen(id).status, identified ? 'completed' : 'failed');
      assert.equal(Boolean(gen(id).local_path), identified);
      assert.equal(cli.count('node', 'run'), 1);
    });
  }

  it('external static URL and symlinked reference never reach node creation', async () => {
    setup();
    db.prepare('UPDATE characters SET local_path = NULL, image_url = ? WHERE id = ?').run('https://external.example/static/p/characters/lin.png', ids.linId);
    await assert.rejects(estimate(), { code: 'reference_not_local' });
    fs.symlinkSync(path.join(storage, 'p/characters/lin.png'), path.join(storage, 'ref.png'));
    db.prepare('UPDATE characters SET local_path = ? WHERE id = ?').run('ref.png', ids.linId);
    await assert.rejects(estimate(), { code: 'reference_outside_storage' });
    assert.equal(cli.count('node', 'create'), 0);
  });

  for (const redirect of ['absolute', 'symlink']) {
    it(`rejects ${redirect} output outside generation directory`, async () => {
      setup();
      const q = await estimate();
      const id = renderer.prepareSubmit(db, noopLog, ids.sbIr, q.token);
      cli.finish(q.items[0].key);
      const other = path.join(storage, writeImage('unrelated.mp4', 'unrelated'));
      renderer.setDeps({ runner: async (args, ctx) => {
        const r = await cli.runner(args, ctx);
        if (args[1] === 'result') {
          const link = path.join(args[args.indexOf('--out') + 1], 'link.mp4');
          if (redirect === 'symlink') fs.symlinkSync(other, link);
          r.data.items[0].localPath = redirect === 'symlink' ? link : other;
        }
        return r;
      } });
      await renderer.runSubmitted(db, noopLog, id);
      assert.equal(gen(id).status, 'failed');
      assert.equal(gen(id).local_path, null);
      assert.equal(db.prepare('SELECT video_url FROM storyboards WHERE id = ?').get(ids.sbIr).video_url, null);
    });
  }

  it('episode estimate single token', async () => {
    setup();
    const c = await estimate([ids.sbIr, ids.sbLegacy]);
    assert.equal(c.items.length, 2);
    assert.equal(c.total, 400);
    assert.equal(c.balance, 1000);
    assert.equal(c.affordable, true);
    assert.equal(c.price_status, 'available');
    assert.equal(cli.count('credit'), 1, 'one estimate call for the batch');
    assert.equal((await post({ storyboard_id: ids.sbIr, jimeng_confirmation: c.token })).statusCode, 201);
    assert.equal((await post({ storyboard_id: ids.sbLegacy, jimeng_confirmation: c.token })).statusCode, 201);
  });

  it('batch token invalid after config change', async () => {
    setup();
    const c = await estimate([ids.sbIr, ids.sbLegacy]);
    const ir = sampleIr(ids, { main_move: '跟拍' });
    ir.tone = '雨夜';
    storyboardService.saveSegmentIr(db, noopLog, ids.sbLegacy, ir);
    const changed = await post({ storyboard_id: ids.sbLegacy, jimeng_confirmation: c.token });
    assert.equal(changed.body.error.code, 'confirmation_stale');
    const sibling = await post({ storyboard_id: ids.sbIr, jimeng_confirmation: c.token });
    assert.equal(sibling.statusCode, 409);
    assert.equal(sibling.body.error.code, 'confirmation_stale');
    assert.equal(genCount(), 0);
    assert.equal(cli.count('node', 'run'), 0);
  });
});

describe('jimeng CLI output parsing', () => {
  const { parseEnvelope } = require('../src/services/jimeng/cli');
  it('cli accepts bare status object and envelopes', () => {
    // 实测：`jimeng-novel status -j` 输出裸对象；`credit get -j` 输出信封
    assert.deepEqual(parseEnvelope('{"logged_in":true,"expires_at":"2026-11-19T19:51:38+08:00"}'), { status: 'success', data: { logged_in: true, expires_at: '2026-11-19T19:51:38+08:00' }, error: null });
    const env = parseEnvelope('本次空间：个人空间\n{"context":{},"data":{"balance":181},"error":null,"status":"success"}');
    assert.equal(env.status, 'success');
    assert.equal(env.data.balance, 181);
    const e = parseEnvelope('{"context":{},"data":null,"error":{"code":"INVALID_ARGUMENT","message":"x"},"status":"error"}', false);
    assert.equal(e.error.code, 'INVALID_ARGUMENT');
    assert.equal(parseEnvelope('{"logged_in":true}', false), null, 'bare object on a failed exit is not success');
    assert.equal(parseEnvelope('{"status":"success","data":{}}', false), null);
    assert.equal(parseEnvelope('{"status":"error","error":"bad"}'), null);
    assert.equal(parseEnvelope('not json'), null);
  });
});
