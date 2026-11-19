/**
 * 即梦（jimeng-novel CLI）渲染后端：可选、默认关闭（ai_service_configs 里 api_protocol = jimeng_novel 才启用）。
 *
 * 花积分的铁律：
 * 1. 先报价（免费）→ 用户确认 → 才提交；报价 token 绑定每个节点的配置哈希，配置变了旧确认失效；
 *    token 里每个节点只能消费一次，提交失败或被拒都要重新报价。
 * 2. 节点 key 在调用 node run 之前写进生成记录；之后无论超时、结果不明还是进程重启，都只查（node result）不重提。
 * 3. 每次查询先用 node get 核对节点当前的 run 是否就是本次生成的 run，不是则判为被新一次渲染取代，不拿别人的结果。
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { createRunner } = require('./cli');
const taskService = require('../taskService');
const storageLayout = require('../storageLayout');
const segmentCompileService = require('../segmentCompileService');
const { storageRoot, toLocalPath, filesBaseUrl, assertInsideStorage } = require('../../utils/storagePaths');

const PROTOCOL = 'jimeng_novel';
const STATUS_TTL_MS = 60 * 1000;
/** run_key 的占位值：已认领提交、尚未拿到即梦 runId（含提交后进程崩溃的情况） */
const SUBMITTING = 'submitting';
const PENDING_ERRORS = new Set(['GUARD_REJECTED', 'SUBMISSION_UNKNOWN', 'PRECONDITION_FAILED', 'TIMEOUT', 'BAD_OUTPUT', 'RESULT_READ_FAILED']);

let deps = { runner: null, cfg: null, wait: { run: 5, result: 30, maxPolls: 120 } };
let statusCache = null;

/** 测试注入：假 runner、存储配置、轮询参数 */
function setDeps(next) {
  deps = { ...deps, ...next, wait: { ...deps.wait, ...(next && next.wait) } };
  statusCache = null;
}

function cfgNow() {
  return deps.cfg || require('../../config').loadConfig();
}

function codedError(code, message, extra) {
  return Object.assign(new Error(message), { code }, extra || {});
}

function activeConfig(db) {
  const aiConfigService = require('../aiConfigService');
  return aiConfigService
    .listConfigs(db, 'video')
    .find((c) => c.is_active && String(c.api_protocol || '').trim().toLowerCase() === PROTOCOL) || null;
}

/** 在 node 测试进程里禁止落到真实 CLI（真实 CLI 会在用户账号上建画布、甚至扣积分），除非显式 JIMENG_LIVE=1 */
const testBlockedRunner = async () => ({ status: 'error', data: null, error: { code: 'TEST_BLOCKED', message: '测试进程中禁止调用真实 jimeng-novel（设置 JIMENG_LIVE=1 才允许）' } });

function runnerFor(db) {
  if (deps.runner) return deps.runner;
  if (process.env.NODE_TEST_CONTEXT && process.env.JIMENG_LIVE !== '1') return testBlockedRunner;
  const config = activeConfig(db);
  let settings = {};
  try { settings = typeof config?.settings === 'string' ? JSON.parse(config.settings) : config?.settings || {}; } catch (_) {}
  return createRunner({ bin: settings.bin_path || 'jimeng-novel' });
}

function cliError(r, fallback) {
  const e = r && r.error ? r.error : {};
  return codedError('jimeng_cli_error', `${fallback}：${e.message || e.code || '未知错误'}`, { cli_code: e.code || null });
}

/** @returns {Promise<{ available: boolean, reason?: string, message?: string }>} */
async function status(db) {
  if (!activeConfig(db)) return { available: false, reason: 'not_configured', message: '未在 AI 配置里启用即梦（jimeng_novel）视频配置' };
  if (statusCache && Date.now() - statusCache.at < STATUS_TTL_MS) return statusCache.value;
  const r = await runnerFor(db)(['status']);
  let value;
  if (r.status !== 'success') {
    value = r.error && r.error.code === 'NOT_INSTALLED'
      ? { available: false, reason: 'not_installed', message: r.error.message }
      : { available: false, reason: 'cli_error', message: (r.error && r.error.message) || 'jimeng-novel 不可用' };
  } else if (!r.data || !r.data.logged_in) {
    value = { available: false, reason: 'not_logged_in', message: '即梦未登录或登录已过期，请在终端执行 jimeng-novel login' };
  } else {
    value = { available: true, expires_at: r.data.expires_at || null };
  }
  statusCache = { at: Date.now(), value };
  return value;
}

async function assertAvailable(db) {
  const st = await status(db);
  if (!st.available) throw codedError('jimeng_unavailable', st.message, { reason: st.reason });
}

/** 每部剧一个即梦画布，绑定目录在存储根下 */
function projectDir(dramaId) {
  return assertInsideStorage(cfgNow(), path.join(storageRoot(cfgNow()), 'jimeng', `drama_${Number(dramaId)}`));
}

const initializing = new Map();
async function ensureProject(db, dramaId) {
  const dir = projectDir(dramaId);
  if (!initializing.has(dir)) initializing.set(dir, initProject(db, dramaId, dir).finally(() => initializing.delete(dir)));
  return initializing.get(dir);
}

async function initProject(db, dramaId, dir) {
  fs.mkdirSync(dir, { recursive: true });
  for (const name of ['.jimeng/config.json', '.jimeng-bound']) assertInsideStorage(cfgNow(), path.join(dir, name));
  if (fs.existsSync(path.join(dir, '.jimeng', 'config.json')) || fs.existsSync(path.join(dir, '.jimeng-bound'))) return dir;
  const drama = db.prepare('SELECT title FROM dramas WHERE id = ?').get(Number(dramaId));
  const r = await runnerFor(db)(['init', '--title', (drama && drama.title) || `剧 ${dramaId}`], { cwd: dir });
  if (r.status !== 'success') throw cliError(r, '即梦画布初始化失败');
  fs.writeFileSync(path.join(dir, '.jimeng-bound'), String((r.data && r.data.projectId) || ''));
  return dir;
}

function pad(n) {
  return String(Math.max(0, Number(n) || 0)).padStart(2, '0');
}

function fileRef(cfg, url) {
  let abs;
  try {
    abs = toLocalPath(cfg, url);
  } catch (e) {
    throw codedError('reference_outside_storage', '参考图不在存储目录内，不能交给即梦');
  }
  if (!abs) throw codedError('reference_not_local', `参考图不是本地文件（${String(url).slice(0, 80)}），请先把图片保存到本地`);
  if (!fs.existsSync(abs)) throw codedError('reference_missing', `参考图文件不存在：${path.basename(abs)}`);
  if (!fs.statSync(abs).isFile()) throw codedError('reference_not_local', '参考图必须是普通文件');
  return abs;
}

/**
 * 由当前库内容生成一个节点的完整规格（提示词、参考、参数）与配置哈希。纯读，不调用 CLI。
 */
function buildNodeSpec(db, storyboardId, opts = {}) {
  const r = segmentCompileService.compileStoryboard(db, storyboardId, { model: opts.model });
  if (!r.ok) throw codedError(r.code, r.message);
  if (r.target.protocol !== PROTOCOL) throw codedError('not_jimeng_target', '当前视频配置不是即梦（jimeng_novel），不能走即梦渲染');
  if (r.blocked) throw codedError('segment_compile_blocked', '结构化分镜未通过编译检查', { findings: r.findings });
  const sb = db
    .prepare('SELECT s.id, s.storyboard_number, s.episode_id, e.episode_number, e.drama_id FROM storyboards s JOIN episodes e ON e.id = s.episode_id WHERE s.id = ?')
    .get(Number(storyboardId));
  const drama = db.prepare('SELECT metadata FROM dramas WHERE id = ?').get(sb.drama_id);
  let ratio = '9:16';
  try { ratio = (JSON.parse(drama.metadata || '{}').aspect_ratio) || ratio; } catch (_) {}
  const cfg = cfgNow();
  const c = r.compiled;
  const files = [];
  const addFile = (flag, url, alias = '') => {
    const abs = fileRef(cfg, url);
    const bytes = fs.readFileSync(abs);
    const digest = crypto.createHash('sha256').update(bytes).digest('hex');
    files.push({ flag, alias, digest, ext: path.extname(abs), bytes: opts.snapshot ? bytes : undefined });
  };
  c.refs.forEach(x => addFile('--ref', x.url, x.alias));
  if (c.request.mode === 'first_last') {
    addFile('--first-frame', c.request.first_frame_url);
    if (c.request.last_frame_url) addFile('--last-frame', c.request.last_frame_url);
  }
  const resolution = opts.resolution || '720p';
  const params = ['--param', `duration=${c.duration_s}`, '--param', `ratio=${ratio}`, '--param', `resolution=${resolution}`];
  const hash = crypto.createHash('sha256').update(JSON.stringify([sb, r.target.model, c.prompt, params,
    files.map(({ flag, alias, digest, ext }) => [flag, alias, digest, ext])])).digest('hex');
  return { hash, files, params, prompt: c.prompt, sb, model: r.target.model, duration: c.duration_s, compiled: r };
}

async function writeNode(db, dir, spec) {
  const id = crypto.randomUUID();
  spec.key = `E${pad(spec.sb.episode_number)}/S${pad(spec.sb.storyboard_number)}-${id}`;
  const rel = path.join('quotes', id);
  const snapshot = assertInsideStorage(cfgNow(), path.join(dir, rel));
  fs.mkdirSync(snapshot, { recursive: true });
  const promptRel = path.join(rel, 'prompt.md');
  fs.writeFileSync(path.join(dir, promptRel), `## 正文\n${spec.prompt}\n`, { flag: 'wx' });
  spec.args = ['node', 'create', '--key', spec.key, '--type', 'video', '--model', spec.model, '--prompt-file', `${promptRel}#正文`];
  spec.files.forEach(({ flag, alias, bytes, ext }, i) => {
    const dest = path.join(snapshot, `${i}${ext}`);
    fs.writeFileSync(dest, bytes, { flag: 'wx' });
    spec.args.push(flag, `${alias ? alias + '=' : ''}file:${dest}`);
  });
  spec.args.push(...spec.params);
  const r = await runnerFor(db)(spec.args, { cwd: dir });
  if (r.status !== 'success') throw cliError(r, `即梦节点 ${spec.key} 保存失败`);
}

/**
 * 报价：建/更新节点（免费）→ credit estimate（免费）→ 生成一次性确认 token。
 * @returns {Promise<{ token, items: object[], total, balance, price_status, affordable }>}
 */
async function estimate(db, log, episodeId, storyboardIds, opts = {}) {
  await assertAvailable(db);
  const ids = [...new Set((storyboardIds || []).map(Number).filter(Boolean))];
  if (!ids.length) throw codedError('bad_request', '请选择要报价的分镜');
  const specs = ids.map((id) => buildNodeSpec(db, id, { ...opts, snapshot: true }));
  if (specs.some((s) => Number(s.sb.episode_id) !== Number(episodeId))) throw codedError('bad_request', '分镜不属于这一集');
  const dir = await ensureProject(db, specs[0].sb.drama_id);
  for (const spec of specs) await writeNode(db, dir, spec);
  const r = await runnerFor(db)(['credit', 'estimate', ...specs.flatMap((s) => ['--key', s.key])], { cwd: dir });
  if (r.status !== 'success') throw cliError(r, '即梦报价失败');
  const d = r.data || {};
  const byKey = new Map((d.items || []).map((it) => [it.key, it]));
  const items = specs.map((s) => ({
    storyboard_id: s.sb.id,
    key: s.key,
    config_hash: s.hash,
    snapshot: true,
    credits: byKey.get(s.key) ? byKey.get(s.key).estimatedCredits : null,
    price_status: byKey.get(s.key) ? byKey.get(s.key).priceStatus : 'unknown',
    consumed: false,
  }));
  const token = crypto.randomUUID();
  db.prepare('INSERT INTO jimeng_confirmations (token, episode_id, items, total, balance, created_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run(token, Number(episodeId), JSON.stringify(items), d.total ?? null, d.balance ?? null, new Date().toISOString());
  const priceStatus = Number(d.unknownCount) === 0 && items.every((i) => i.price_status === 'available') ? 'available' : 'reference';
  log.info('jimeng estimate', { episode_id: episodeId, keys: items.length, total: d.total, token_hash: token.slice(0, 8) });
  return {
    token,
    items: items.map(({ storyboard_id, key, credits, price_status }) => ({ storyboard_id, key, credits, price_status })),
    total: d.total ?? null,
    balance: d.balance ?? null,
    price_status: priceStatus,
    affordable: d.total != null && d.balance != null ? Number(d.balance) >= Number(d.total) : null,
  };
}

/**
 * 提交前的同步校验与落库（不调用 CLI）：token 有效、该节点未消费、配置未变、没有进行中的生成；
 * 消费 token 中该节点并插入生成记录（provider_task_id = 节点 key，先于 node run 写入）。
 * @returns 生成记录 id
 */
function prepareSubmit(db, log, storyboardId, token, opts = {}) {
  const sbId = Number(storyboardId);
  return db.transaction(() => {
    const row = token ? db.prepare('SELECT * FROM jimeng_confirmations WHERE token = ?').get(String(token)) : null;
    if (!row) throw codedError('confirmation_required', '请先报价并确认后再提交即梦渲染');
    const items = JSON.parse(row.items);
    const item = items.find((i) => Number(i.storyboard_id) === sbId);
    if (!item) throw codedError('confirmation_required', '这条分镜不在本次报价里，请重新报价');
    if (item.consumed) throw codedError('confirmation_consumed', '这次报价已经用过，请重新报价后再提交');
    const busy = db
      .prepare("SELECT id FROM video_generations WHERE storyboard_id = ? AND provider = ? AND status = 'processing' AND deleted_at IS NULL")
      .get(sbId, PROTOCOL);
    if (busy) throw codedError('generation_in_progress', '这条分镜正在即梦生成中，不会重复提交', { video_generation_id: busy.id });
    let spec;
    for (const quoted of items) {
      const current = buildNodeSpec(db, quoted.storyboard_id, opts);
      if (current.hash !== quoted.config_hash || !quoted.snapshot) {
        throw codedError('confirmation_stale', '报价之后批次内有分镜或参考图改动，请重新报价');
      }
      if (quoted === item) spec = current;
    }
    item.consumed = true;
    db.prepare('UPDATE jimeng_confirmations SET items = ? WHERE token = ?').run(JSON.stringify(items), row.token);
    const task = taskService.createTask(db, log, 'video_generation', String(spec.sb.drama_id));
    const now = new Date().toISOString();
    const compiledJson = JSON.stringify({ family: 'jimeng', protocol: PROTOCOL, model: spec.model, node_key: item.key, quoted_node: true, request: spec.compiled.compiled.request, findings: spec.compiled.findings });
    const info = db.prepare(
      `INSERT INTO video_generations (drama_id, storyboard_id, provider, prompt, model, duration, provider_task_id, compiled_json, status, task_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'processing', ?, ?, ?)`
    ).run(spec.sb.drama_id, sbId, PROTOCOL, spec.prompt, spec.model, spec.duration, item.key, compiledJson, task.id, now, now);
    return Number(info.lastInsertRowid);
  })();
}

function genRow(db, genId) {
  return db.prepare('SELECT * FROM video_generations WHERE id = ? AND deleted_at IS NULL').get(Number(genId));
}

function failGen(db, row, message) {
  if (genRow(db, row.id)?.status !== 'processing') return;
  const now = new Date().toISOString();
  db.prepare("UPDATE video_generations SET status = 'failed', error_msg = ?, updated_at = ? WHERE id = ?").run(String(message).slice(0, 500), now, row.id);
  if (row.task_id) taskService.updateTaskError(db, row.task_id, message);
}

function outputDir(dir, row) {
  return assertInsideStorage(cfgNow(), path.join(dir, 'out', String(row.id)));
}

function finalizeGen(db, log, row, dir, localPath) {
  if (genRow(db, row.id)?.status !== 'processing') return;
  const cfg = cfgNow();
  const sub = storageLayout.getProjectStorageSubdir(db, row.drama_id);
  let rel;
  try {
    const src = assertInsideStorage({ storage: { local_path: outputDir(dir, row) } }, path.resolve(dir, localPath));
    if (!/\.(mp4|mov|webm|m4v)$/i.test(src)) throw new Error('结果不是支持的视频文件');
    if (!fs.statSync(src).isFile()) throw new Error('结果不是普通文件');
    const relDir = path.join(sub, 'videos');
    fs.mkdirSync(assertInsideStorage(cfg, path.join(storageRoot(cfg), relDir)), { recursive: true });
    rel = `${sub}/videos/jm_${row.id}_${Date.now()}${path.extname(src) || '.mp4'}`;
    fs.copyFileSync(src, assertInsideStorage(cfg, path.join(storageRoot(cfg), rel)), fs.constants.COPYFILE_EXCL);
  } catch (e) {
    return failGen(db, row, '即梦结果文件不可用：' + e.message);
  }
  const base = filesBaseUrl(cfg);
  const url = base ? `${base}/${rel}` : `/static/${rel}`;
  const now = new Date().toISOString();
  db.prepare("UPDATE video_generations SET status = 'completed', video_url = ?, local_path = ?, completed_at = ?, updated_at = ? WHERE id = ?").run(url, rel, now, now, row.id);
  if (row.storyboard_id) db.prepare('UPDATE storyboards SET video_url = ?, local_path = ?, updated_at = ? WHERE id = ?').run(url, rel, now, row.storyboard_id);
  if (row.task_id) taskService.updateTaskResult(db, row.task_id, { video_generation_id: row.id, video_url: url, status: 'completed' });
  log.info('jimeng render completed', { id: row.id, key: row.provider_task_id });
}

function matchingItem(data, key) {
  const items = Array.isArray(data?.items) ? data.items : [data];
  const matches = items.filter(item => item?.key === key);
  return matches.length === 1 ? matches[0] : null;
}

function quotedNode(row) {
  try {
    const meta = JSON.parse(row.compiled_json || '{}');
    return meta?.quoted_node === true && meta.node_key === row.provider_task_id;
  } catch {
    return false;
  }
}

async function pollOnce(db, log, genId) {
  const row = genRow(db, genId);
  if (!row || row.status !== 'processing') return 'done';
  const key = row.provider_task_id;
  const known = row.run_key && row.run_key !== SUBMITTING;
  if (!known && (!quotedNode(row) || !row.run_key)) {
    failGen(db, row, '缺少可确认归属的提交记录，请核对即梦记录后重新报价');
    return 'done';
  }
  let dir, out;
  try {
    dir = projectDir(row.drama_id);
    out = outputDir(dir, row);
  } catch (e) {
    failGen(db, row, e.message);
    return 'done';
  }
  const run = runnerFor(db);
  const getRun = async () => {
    const got = await run(['node', 'get', '--key', key], { cwd: dir });
    return got.status === 'success' && got.data?.key === key && got.data.state?.runId || null;
  };
  const runId = await getRun();
  if (!runId) return 'pending';
  if (known && runId !== row.run_key) {
    failGen(db, row, '这条分镜在即梦上已被新一次渲染取代，本次结果不再采用');
    return 'done';
  }
  if (!known) db.prepare("UPDATE video_generations SET run_key = ? WHERE id = ? AND run_key = ? AND status = 'processing'").run(runId, row.id, SUBMITTING);
  const r = await run(['node', 'result', '--key', key, '--wait', String(deps.wait.result), '--out', out], { cwd: dir });
  if (r.status !== 'success') {
    if (PENDING_ERRORS.has(r.error && r.error.code)) return 'pending';
    failGen(db, row, `即梦查询失败：${(r.error && (r.error.message || r.error.code)) || '未知错误'}`);
    return 'done';
  }
  const it = matchingItem(r.data, key);
  if (!it?.runId && !quotedNode(row)) {
    failGen(db, row, '旧节点结果缺少可确认归属的运行标识，请核对即梦记录');
    return 'done';
  }
  if (!it || (it.runId ? it.runId !== runId : await getRun() !== runId)) return 'pending';
  if (it.status === 'succeeded' && it.localPath) {
    finalizeGen(db, log, row, dir, it.localPath);
    return 'done';
  }
  if (it.status === 'failed') {
    failGen(db, row, '即梦生成失败' + (it.message ? '：' + it.message : ''));
    return 'done';
  }
  return 'pending';
}

async function poll(db, log, genId) {
  for (let i = 0; i < deps.wait.maxPolls; i++) {
    if ((await pollOnce(db, log, genId)) === 'done') return;
  }
  const row = genRow(db, genId);
  if (row && row.status === 'processing') log.warn('jimeng poll budget exhausted, still processing', { id: genId });
}

/**
 * prepareSubmit 之后在后台执行：认领已报价的节点 → node run（唯一的提交点）→ 只查不重提。
 * 认领在库里原子完成（run_key 从空变为 submitting），同一条生成记录被重复调用时只有第一次会提交，其余只轮询。
 */
async function runSubmitted(db, log, genId) {
  const row = genRow(db, genId);
  if (!row || row.status !== 'processing') return;
  if (row.run_key) return poll(db, log, genId);
  if (!quotedNode(row)) return poll(db, log, genId);
  let dir, out;
  try {
    dir = projectDir(row.drama_id);
    out = outputDir(dir, row);
  } catch (e) {
    return failGen(db, row, e.message);
  }
  const run = runnerFor(db);
  const claim = db.prepare("UPDATE video_generations SET run_key = ? WHERE id = ? AND run_key IS NULL AND status = 'processing'").run(SUBMITTING, row.id);
  if (claim.changes !== 1) return;
  const r = await run(['node', 'run', '--key', row.provider_task_id, '--wait', String(deps.wait.run), '--out', out], { cwd: dir });
  if (r.status !== 'success') {
    const code = r.error && r.error.code;
    if (code === 'SUBMIT_REJECTED') return failGen(db, row, `即梦拒绝了提交（未扣费），请修改后重新报价：${(r.error && r.error.message) || ''}`);
    if (!PENDING_ERRORS.has(code)) return failGen(db, row, `即梦提交失败：${(r.error && (r.error.message || code)) || '未知错误'}`);
    log.warn('jimeng run outcome uncertain, polling only', { id: row.id, code });
  } else {
    const it = matchingItem(r.data, row.provider_task_id);
    if (!it?.runId) return poll(db, log, genId);
    db.prepare("UPDATE video_generations SET run_key = ? WHERE id = ? AND run_key = ? AND status = 'processing'").run(it.runId, row.id, SUBMITTING);
    if (it.status === 'succeeded' && it.localPath) return finalizeGen(db, log, genRow(db, genId), dir, it.localPath);
    if (it.status === 'failed') return failGen(db, row, '即梦生成失败');
  }
  await poll(db, log, genId);
}

module.exports = { PROTOCOL, setDeps, status, estimate, prepareSubmit, runSubmitted, pollOnce, poll, buildNodeSpec, projectDir };
