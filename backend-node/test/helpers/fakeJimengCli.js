const fs = require('fs');
const path = require('path');

const ok = (data) => ({ status: 'success', data, error: null });
const err = (code, message = code) => ({ status: 'error', data: null, error: { code, message } });

/**
 * 假 jimeng-novel：维护节点 → 当前 run，node result 在 finish(key) 之后返回成片。
 * opts.onRun(key) 可返回一个 envelope（例如 SUBMISSION_UNKNOWN）或一个永不完成的 Promise（模拟进程在提交后崩溃）。
 */
function fakeJimengCli(opts = {}) {
  const calls = [];
  const nodes = new Map();
  let seq = 0;
  const arg = (args, flag) => args[args.indexOf(flag) + 1];
  const node = (key) => {
    if (!nodes.has(key)) nodes.set(key, { runId: null, done: new Set(), args: null, finishNext: false });
    return nodes.get(key);
  };
  const runner = async (args, ctx = {}) => {
    calls.push(args);
    const [a, b] = args;
    if (opts.installed === false) return err('NOT_INSTALLED', '找不到 jimeng-novel');
    if (a === 'status') return ok({ logged_in: opts.loggedIn !== false, expires_at: '2026-12-01T00:00:00+08:00' });
    if (a === 'init') return ok({ projectId: 'p1' });
    if (a === 'credit') {
      const keys = args.filter((_, i) => args[i - 1] === '--key');
      return ok({ items: keys.map((k) => ({ key: k, estimatedCredits: 200, priceStatus: 'available' })), total: 200 * keys.length, balance: 1000, unknownCount: 0 });
    }
    const key = arg(args, '--key');
    if (a === 'node' && b === 'create') {
      node(key).args = args;
      return ok({ key, created: true, saved: true });
    }
    if (a === 'node' && b === 'run') {
      const n = node(key);
      n.runId = `r${++seq}`;
      if (n.finishNext) { n.done.add(n.runId); n.finishNext = false; }
      if (opts.onRun) {
        const r = opts.onRun(key, n.runId);
        if (r) return r;
      }
      return ok({ items: [{ key, status: 'running', runId: n.runId }] });
    }
    if (a === 'node' && b === 'get') {
      const n = node(key);
      return ok({ key, state: { runId: n.runId, status: n.runId ? 'running' : 'idle' } });
    }
    if (a === 'node' && b === 'result') {
      const n = node(key);
      if (!n.runId || !n.done.has(n.runId)) return ok({ items: [{ key, status: n.runId ? 'running' : 'idle' }] });
      const rel = path.join(path.relative(ctx.cwd, arg(args, '--out')), `${key.replace('/', '_')}_${n.runId}.mp4`);
      fs.mkdirSync(arg(args, '--out'), { recursive: true });
      fs.writeFileSync(path.join(ctx.cwd, rel), `video-${n.runId}`);
      return ok({ items: [{ key, status: 'succeeded', localPath: rel, credits: { deducted: 200 } }] });
    }
    return err('INVALID_ARGUMENT', 'unknown command ' + args.join(' '));
  };
  return {
    runner,
    calls,
    nodes,
    /** 让当前 run 完成；还没提交时让下一次提交的 run 完成 */
    finish: (key) => {
      const n = node(key);
      if (n.runId && !n.done.has(n.runId)) n.done.add(n.runId);
      else n.finishNext = true;
    },
    count: (a, b) => calls.filter((c) => c[0] === a && (b == null || c[1] === b)).length,
  };
}

module.exports = { fakeJimengCli };
