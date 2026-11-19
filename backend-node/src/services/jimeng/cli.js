/**
 * jimeng-novel CLI 端口：execFile 参数数组（不经 shell）、超时、JSON 信封解析与错误码映射。
 * 返回统一形状 { status: 'success'|'error', data, error: { code, message } }；测试用假 runner 替换它。
 */
const { execFile } = require('child_process');
const { z } = require('zod');

const envelope = z.object({
  status: z.enum(['success', 'error']),
  data: z.any().optional(),
  error: z.object({ code: z.string().optional(), message: z.string().optional() }).passthrough().nullable().optional(),
}).passthrough();

function fail(code, message) {
  return { status: 'error', data: null, error: { code, message } };
}

/**
 * 解析 -j 输出。大多数命令输出 {status, data, error} 信封；但个别命令（实测 `status -j`）直接输出数据对象，
 * 这类裸对象只在退出码为 0 时视为成功数据。
 */
function parseEnvelope(text, exitedOk = true) {
  const s = String(text || '').trim();
  if (!s) return null;
  const start = s.indexOf('{');
  if (start < 0) return null;
  let obj;
  try {
    obj = JSON.parse(s.slice(start));
  } catch (_) {
    return null;
  }
  const r = envelope.safeParse(obj);
  if (r.success) return exitedOk || r.data.status === 'error' ? r.data : null;
  if (exitedOk && obj && typeof obj === 'object' && !Array.isArray(obj) && !('status' in obj || 'error' in obj)) {
    return { status: 'success', data: obj, error: null };
  }
  return null;
}

/**
 * @param {{ bin?: string, timeoutMs?: number }} [opts]
 * @returns {(args: string[], ctx?: { cwd?: string, timeoutMs?: number }) => Promise<object>}
 */
function createRunner(opts = {}) {
  const bin = opts.bin || 'jimeng-novel';
  return (args, ctx = {}) =>
    new Promise((resolve) => {
      execFile(
        bin,
        [...args, '-j'],
        { cwd: ctx.cwd, timeout: ctx.timeoutMs || opts.timeoutMs || 120000, maxBuffer: 16 * 1024 * 1024, windowsHide: true },
        (err, stdout, stderr) => {
          if (err && err.code === 'ENOENT') return resolve(fail('NOT_INSTALLED', `找不到 ${bin}，请先安装即梦 jimeng-novel CLI`));
          if (err && err.killed) return resolve(fail('TIMEOUT', 'jimeng-novel 超时未返回'));
          const env = parseEnvelope(stdout, !err) || parseEnvelope(stderr, false);
          if (env) return resolve({ status: env.status, data: env.data ?? null, error: env.error || null });
          resolve(fail('BAD_OUTPUT', `jimeng-novel 输出无法解析${err ? '（退出码 ' + err.code + '）' : ''}`));
        }
      );
    });
}

module.exports = { createRunner, parseEnvelope };
