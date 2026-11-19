/**
 * 剧本体检：只诊断、不改写。剧本解析与台词统计在本地确定性完成；评分由 LLM 给出、在边界处用 schema 校验；
 * 加权总分与门槛封顶由服务端计算，不采信模型自己算的总分。不写任何表。
 */
const { z } = require('zod');
const aiClient = require('./aiClient');
const { parseScriptLines } = require('./segmentCompile/lint');
const { safeParseAIJSON } = require('../utils/safeJson');
const { DIMENSIONS, reviewSystemPrompt } = require('./scriptReview/rules/episodeRules');

const LONG_LINE_CHARS = 15;

function countChars(s) {
  return (String(s).match(/[\p{L}\p{N}]/gu) || []).length;
}

/** 剧本格式解析与台词统计 */
function parseScript(text) {
  const src = String(text || '');
  const parsed = parseScriptLines(src);
  const lines = parsed.lines.map((l) => ({ ...l, chars: countChars(l.text) }));
  const sceneHeadings = src.split(/\r?\n/).filter((l) => /^\s*##\s*场/.test(l)).map((l) => l.trim());
  return {
    format: parsed.mode,
    scenes: sceneHeadings,
    lines,
    stats: {
      total_chars: countChars(src),
      line_count: lines.length,
      dialogue_chars: lines.reduce((n, l) => n + l.chars, 0),
      max_line_chars: lines.reduce((n, l) => Math.max(n, l.chars), 0),
      long_lines: lines.filter((l) => l.chars > LONG_LINE_CHARS).map((l) => l.text),
    },
  };
}

const KEYS = DIMENSIONS.map((d) => d.key);
const reportSchema = z.object({
  gates: z.object({
    non_script: z.boolean(),
    compliance_blocked: z.boolean(),
    homogeneous: z.boolean().default(false),
    notes: z.string().default(''),
  }),
  dimensions: z.array(z.object({ key: z.enum(KEYS), score: z.number().int().min(1).max(10), evidence: z.string().default('') })),
  problems: z.array(z.object({ location: z.string().default(''), what: z.string().min(1), advice: z.string().default('') })).max(20).default([]),
});

function grade(total) {
  if (total == null) return '不能拍';
  if (total >= 8) return '强';
  if (total >= 6.5) return '可上线';
  if (total >= 5) return '需打磨';
  return '不建议拍';
}

/** 由模型给的维度分计算报告（纯函数）：缺维度按 0 记并标出；门槛封顶 */
function scoreReport(raw) {
  const byKey = new Map(raw.dimensions.map((d) => [d.key, d]));
  const missing = KEYS.filter((k) => !byKey.has(k));
  const dims = DIMENSIONS.map((d) => {
    const got = byKey.get(d.key);
    let score = got ? got.score : 0;
    if (raw.gates.homogeneous && (d.key === 'conflict' || d.key === 'pacing')) score = Math.min(score, 5);
    return { key: d.key, label: d.label, weight: d.weight, score, evidence: got ? got.evidence : '', capped: !!got && score !== got.score };
  });
  let total = Math.round(dims.reduce((n, d) => n + d.score * d.weight, 0) * 10) / 10;
  if (raw.gates.non_script) total = Math.min(total, 4);
  if (raw.gates.compliance_blocked) total = null;
  return { gates: raw.gates, dimensions: dims, missing_dimensions: missing, weighted_total: total, grade: grade(total), problems: raw.problems };
}

/**
 * @returns {Promise<{ episode_id, script: object, report: object }>}；剧集不存在抛 code=not_found，剧本为空抛 code=empty_script，
 *   模型输出不合法抛 code=script_review_invalid
 */
async function reviewEpisode(db, log, episodeId, opts = {}) {
  const ep = db.prepare('SELECT id, script_content, description FROM episodes WHERE id = ? AND deleted_at IS NULL').get(Number(episodeId));
  if (!ep) throw Object.assign(new Error('剧集不存在'), { code: 'not_found' });
  const text = String(ep.script_content || ep.description || '').trim();
  if (!text) throw Object.assign(new Error('剧本为空，没有可体检的内容'), { code: 'empty_script' });
  const script = parseScript(text);
  const userPrompt = [
    `本集剧本（台词 ${script.stats.line_count} 句，最长一句 ${script.stats.max_line_chars} 字${script.format === 'fuzzy' ? '；剧本不是「人名：台词」格式' : ''}）：`,
    text,
  ].join('\n');
  const out = await aiClient.generateText(db, log, 'text', userPrompt, reviewSystemPrompt(), {
    scene_key: 'script_review',
    model: opts.model || undefined,
    temperature: 0.2,
    max_tokens: 4096,
  });
  let raw;
  try {
    raw = safeParseAIJSON(String(out || ''), {}, log);
  } catch (e) {
    throw Object.assign(new Error('剧本体检失败：模型输出不是可解析的 JSON'), { code: 'script_review_invalid' });
  }
  const r = reportSchema.safeParse(raw);
  if (!r.success) {
    throw Object.assign(new Error('剧本体检失败：模型输出不符合约定格式（' + r.error.issues.slice(0, 2).map((i) => `${i.path.join('.')} ${i.message}`).join('；') + '）'), { code: 'script_review_invalid' });
  }
  return { episode_id: ep.id, script, report: scoreReport(r.data) };
}

module.exports = { parseScript, scoreReport, reviewEpisode };
