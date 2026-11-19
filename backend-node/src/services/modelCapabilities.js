/**
 * 视频模型能力表：时长范围、参考图上限、prompt 长度上限、比例、首尾帧、是否原生出人声。
 * 这是各模型上限的唯一来源；videoClient 请求时、分镜规划与编译时都从这里取。
 *
 * 来源：
 * - 火山方舟 Seedance、MiniMax H3、DashScope Wan 的时长/参考图数：原 videoClient 中已在用的常量
 * - 即梦（jimeng-novel）各模型：`jimeng-novel model describe` 实测（即梦能力报告 §4.4）
 * - Seedance 2.x 原生人声：即梦能力报告 §0（同一模型族）
 * 查不到依据的字段列入 unknownFields 并取保守值（未知的原生人声一律按非原生处理）。
 */

const STANDARD_RATIOS = ['16:9', '4:3', '1:1', '3:4', '9:16', '21:9'];

/** Wan 带 size 参数的模型：画面比例 → 720P 档尺寸 */
const WAN_SIZES = {
  '16:9': '1280*720',
  '9:16': '720*1280',
  '1:1': '960*960',
  '4:3': '1088*832',
  '3:4': '832*1088',
};

const CONSERVATIVE = {
  family: 'generic',
  duration: { min: 5, max: 10, step: 1 },
  refImages: 1,
  maxPromptChars: 2000,
  ratios: ['16:9', '9:16', '1:1'],
  firstLastFrame: false,
  nativeAudio: false,
};

function isSeedance2FamilyModel(modelName) {
  const m = String(modelName || '').toLowerCase().trim();
  if (!m) return false;
  if (/seedance[-_]?2|seedance2/.test(m)) return true;
  if (/2[-_]0[-_]/.test(m)) return true;
  // 网关别名：mingiz-sd2、foo_sd2、sd2-bar
  if (/(^|[-_./])sd2($|[-_./])/.test(m)) return true;
  return false;
}

const VOLC_PROTOCOLS = new Set(['volcengine', 'volcengine_omni']);

/** 每条：protocols 命中且 match(model) 为真即采用；按顺序取第一条 */
const ENTRIES = [
  {
    protocols: VOLC_PROTOCOLS,
    match: isSeedance2FamilyModel,
    caps: {
      family: 'seedance',
      duration: { min: 4, max: 15, step: 1 },
      refImages: 9,
      maxPromptChars: 5000,
      ratios: [...STANDARD_RATIOS, 'adaptive'],
      firstLastFrame: true,
      nativeAudio: true,
    },
    unknownFields: ['maxPromptChars'],
  },
  {
    protocols: VOLC_PROTOCOLS,
    match: (m) => /seedance[-_]?1[-_.]?5|1-5-pro|1-5-lite|251215/.test(m),
    caps: {
      family: 'seedance',
      duration: { min: 5, max: 12, step: 1 },
      refImages: 0,
      maxPromptChars: 2000,
      ratios: [...STANDARD_RATIOS, 'adaptive'],
      firstLastFrame: true,
      nativeAudio: false,
    },
    unknownFields: ['maxPromptChars', 'nativeAudio'],
  },
  {
    protocols: VOLC_PROTOCOLS,
    match: (m) => /seedance|doubao-seedance/.test(m),
    caps: {
      family: 'seedance',
      duration: { min: 5, max: 10, step: 5 },
      refImages: 0,
      maxPromptChars: 2000,
      ratios: [...STANDARD_RATIOS, 'adaptive'],
      firstLastFrame: true,
      nativeAudio: false,
    },
    unknownFields: ['maxPromptChars'],
  },
  {
    protocols: VOLC_PROTOCOLS,
    match: () => true,
    // 方舟上未识别的模型：时长沿用原兜底 5–12；omni 通道原本对任意模型放行 9 张参考图
    caps: { ...CONSERVATIVE, family: 'seedance', duration: { min: 5, max: 12, step: 1 }, refImages: 9 },
    unknownFields: ['refImages', 'maxPromptChars', 'firstLastFrame', 'nativeAudio'],
  },
  {
    protocols: new Set(['minimax_h3']),
    match: () => true,
    caps: {
      family: 'minimax_h3',
      duration: { min: 4, max: 15, step: 1 },
      refImages: 9,
      maxPromptChars: 2000,
      ratios: [...STANDARD_RATIOS, 'adaptive'],
      firstLastFrame: true,
      nativeAudio: false,
    },
    unknownFields: ['maxPromptChars', 'nativeAudio'],
  },
  ...[
    ['wan2.2-kf2v-flash', { refImages: 0, firstLastFrame: true, duration: { min: 5, max: 5, step: 1 } }],
    ['wan2.6-t2v', { refImages: 0, firstLastFrame: false, duration: { min: 5, max: 15, step: 5 }, sizes: WAN_SIZES }],
    ['wan2.6-i2v-flash', { refImages: 0, firstLastFrame: false, duration: { min: 5, max: 15, step: 5 } }],
    ['wanx2.1-vace-plus', { refImages: 3, firstLastFrame: false, duration: { min: 5, max: 5, step: 1 }, sizes: WAN_SIZES }],
    ['wan2.6-r2v-flash', { refImages: 5, firstLastFrame: false, duration: { min: 5, max: 10, step: 5 }, sizes: WAN_SIZES }],
  ].map(([id, extra]) => ({
    protocols: new Set(['dashscope']),
    match: (m) => m === id,
    caps: {
      family: 'wan',
      maxPromptChars: 800,
      ratios: extra.sizes ? Object.keys(extra.sizes) : ['16:9', '9:16', '1:1'],
      nativeAudio: false,
      ...extra,
    },
    unknownFields: ['duration', 'maxPromptChars', 'nativeAudio'],
  })),
  ...[
    ['Seedance_2.5', 4, 30, 30, 15000, true],
    ['Seedance_2.5_flash', 4, 30, 10, 15000, true],
    ['Seedance_2.5_draft', 4, 30, 30, 15000, true],
    ['seedance2.0_vision', 4, 15, 9, 5000, true],
    ['seedance2.0_fast_vision', 4, 15, 9, 5000, true],
    ['Seedance_2.0_mini', 4, 15, 9, 5000, false],
    ['wan3.0', 4, 30, 10, 20000, true],
    ['happyhorse-1.1', 3, 15, 9, 5000, false],
  ].map(([id, min, max, refImages, maxPromptChars, firstLastFrame]) => ({
    protocols: new Set(['jimeng_novel']),
    match: (_m, raw) => raw === id,
    caps: {
      family: 'jimeng',
      duration: { min, max, step: 1 },
      refImages,
      maxPromptChars,
      ratios: STANDARD_RATIOS,
      firstLastFrame,
      nativeAudio: /seedance/i.test(id),
    },
    unknownFields: /seedance/i.test(id) ? [] : ['nativeAudio'],
  })),
];

function clone(caps) {
  return {
    ...caps,
    duration: { ...caps.duration },
    ratios: [...caps.ratios],
    ...(caps.sizes ? { sizes: { ...caps.sizes } } : {}),
  };
}

/**
 * @param {{ protocol?: string, model?: string }} q
 * @returns {{ family: string, duration: {min:number,max:number,step:number}, refImages: number,
 *   maxPromptChars: number, ratios: string[], sizes?: Record<string,string>, firstLastFrame: boolean,
 *   nativeAudio: boolean, unknown: boolean, unknownFields: string[] }}
 */
function getVideoCaps({ protocol, model } = {}) {
  const p = String(protocol || '').trim();
  const raw = String(model || '').trim();
  const m = raw.toLowerCase();
  const hit = ENTRIES.find((e) => e.protocols.has(p) && e.match(m, raw));
  if (!hit) {
    return { ...clone(CONSERVATIVE), unknown: true, unknownFields: Object.keys(CONSERVATIVE).filter((k) => k !== 'family') };
  }
  return { ...clone(hit.caps), unknown: false, unknownFields: [...hit.unknownFields] };
}

/** 把时长对齐到能力表范围与步长（就近取整，越界取边界） */
function clampDuration(caps, seconds) {
  const { min, max, step } = caps.duration;
  const d = Number(seconds);
  if (!Number.isFinite(d) || d <= 0) return min;
  const aligned = min + Math.round((d - min) / step) * step;
  return Math.min(max, Math.max(min, aligned));
}

module.exports = {
  getVideoCaps,
  clampDuration,
  isSeedance2FamilyModel,
};
