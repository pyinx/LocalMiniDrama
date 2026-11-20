/**
 * 全能模式 universal_segment_text 统一格式：多子分镜段落（与 generate/polish 接口一致）
 */

const { createHash } = require('node:crypto');

const LEGACY_SCENE_REFERENCE =
  '环境、光影与陈设定性参考 @图片1。若 @图片1 为宫格或多画面拼图，禁止成片复刻其分格或并列布局，仅提取统一的室内空间与光线语义；须单镜头完整连续画面。';
const DEFAULT_LINE3 = '环境、光影与陈设参考 @图片1。每个时刻使用完整画幅，禁止宫格或并列分屏。按剧情安排机位和切镜。';
const OLD_ACTION_PREFIX = '本镜动作依据（在以下节拍内各演一次，以此为准）：';

/** 编辑正文与系统补入的动作依据分开，避免旧动作在下次润色时又被写回。 */
function universalDraftWithoutActionNote(text) {
  if (!text) return text;
  return String(text).replace(LEGACY_SCENE_REFERENCE, DEFAULT_LINE3)
    .split(/\r?\n/).filter(line => !line.trimStart().startsWith(OLD_ACTION_PREFIX)).join('\n');
}

function beatSignature(text, action, result) {
  return createHash('sha256').update(JSON.stringify([text, action, result].map(s => String(s ?? '').trim()))).digest('hex');
}


function trim(s) {
  return s != null && String(s).trim() ? String(s).trim() : '';
}

const STYLE_LINE_PREFIX = '画面风格和类型: ';

/** 第 1 行（风格行）：剧集画风是唯一来源，不再强制追加写实标签 */
function buildUniversalStyleLine(styleZh) {
  return STYLE_LINE_PREFIX + (trim(styleZh) || '电影风格, 高清画质');
}

/**
 * 用剧集画风覆盖文本的风格行（LLM 可能写错或照旧写「真人写实」）。
 * 兼容多行文本与被压成一行的文本（风格行止于换行或「生成一个由以下」）。
 */
function enforceUniversalStyleLine(text, styleZh) {
  if (!text || !String(text).trim()) return text;
  const src = String(text);
  const line = buildUniversalStyleLine(styleZh);
  const m = src.match(/^\s*画面风格和类型\s*[:：][^\n]*?(?=\n|\s*生成一个由以下|$)/);
  if (!m) return line + (src.includes('\n') ? '\n' : ' ') + src.replace(/^\s+/, '');
  const rest = src.slice(m[0].length).replace(/^[ \t]+/, '');
  if (!rest) return line;
  return line + (rest.startsWith('\n') ? '' : ' ') + rest;
}

/** 保留多行，仅规范换行 */
function normalizeUniversalSegmentTextNewlines(text) {
  if (!text) return '';
  return String(text)
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .trim();
}

/** 根据总秒数决定子分镜数 M（约每 5 秒一拍，1–8） */
function chooseBeatCount(durationSec) {
  const dur = Math.max(1, Math.min(120, Math.round(Number(durationSec) || 5)));
  return Math.min(8, Math.max(1, Math.round(dur / 5)));
}

/** 将总秒数拆成 M 个正整数且和为 dur */
function splitDurationSeconds(dur, m) {
  const base = Math.floor(dur / m);
  const rem = dur - base * m;
  return Array.from({ length: m }, (_, i) => base + (i < rem ? 1 : 0));
}

/** 全能初稿缺少分拍正文时，沿用已有字段组成一拍。此处尚无参考图槽位。 */
function buildFallbackUniversalMultiBeatText(sb, { shotType, angle, movement, action, result, dialogue, narration, durationSec }, style) {
  const facts = [sb.location, sb.time, shotType, angle, movement, action || sb.description, result,
    sb.atmosphere, sb.lighting_style, sb.depth_of_field, sb.emotion, sb.sound_effect,
    dialogue || '无对白', narration && `旁白：「${narration}」`];
  const beat = facts.filter(Boolean).map(s => String(s).trim().replace(/\r?\n/g, ' ')).join('。');
  return [buildUniversalStyleLine(style), '生成一个由以下1个分镜组成的视频。',
    '每个时刻使用完整画幅。按分镜正文安排机位。', `分镜1： ${durationSec}秒: ${beat}`].join('\n');
}

module.exports = {
  DEFAULT_LINE3,
  universalDraftWithoutActionNote,
  beatSignature,
  buildUniversalStyleLine,
  enforceUniversalStyleLine,
  normalizeUniversalSegmentTextNewlines,
  chooseBeatCount,
  splitDurationSeconds,
  buildFallbackUniversalMultiBeatText,
};
