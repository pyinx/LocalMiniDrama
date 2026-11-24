/**
 * 视频模型能力表：时长范围、参考图上限、prompt 长度上限、比例、首尾帧、是否原生出人声。
 * 这是各模型上限的唯一来源；videoClient 请求时、分镜规划与编译时都从这里取。
 *
 * 来源：
 * - 火山方舟 Seedance、MiniMax H3、DashScope Wan 的时长/参考图数：原 videoClient 中已在用的常量
 * - Seedance 2.x 原生人声：即梦能力报告 §0（同一模型族）
 * 查不到依据的字段列入 unknownFields 并取保守值（未知的原生人声一律按非原生处理）。
 */

const STANDARD_RATIOS = ['16:9', '4:3', '1:1', '3:4', '9:16', '21:9'];
const wanVideoModels = require('../constants/wanVideoModels.json');
const WAN_LEGACY_KEYFRAME_MODEL = 'wan2.2-kf2v-flash';
const AGNES_ALLOWED_NUM_FRAMES = [81, 121, 161, 241, 441];
const AGNES_FRAME_RATE = 24;

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
  ...[['kling_omni', 2500], ['vidu', 5000]].map(([protocol, maxPromptChars]) => ({
    protocols: new Set([protocol]), match: () => true,
    caps: { ...CONSERVATIVE, maxPromptChars },
    unknownFields: ['duration', 'refImages', 'ratios', 'firstLastFrame', 'nativeAudio'],
  })),
  ...Object.entries(wanVideoModels).map(([id, mode]) => {
    const omni = mode === 'omni';
    const legacy = id.startsWith('wan2.6-');
    return {
      protocols: new Set(['dashscope']), match: m => m === id, unknownFields: [],
      caps: {
        family: 'wan', wanMode: mode, wan26: legacy,
        // 万相 3.0 Prompt 指南将负向清单列入正文；2.6/2.7 的接口另有 input.negative_prompt。
        styleNegativeMode: omni ? 'prompt' : 'field',
        refImages: omni ? 10 : mode === 'reference' ? 5 : 0,
        refToken: legacy && mode === 'reference' ? 'character' : '图',
        firstLastFrame: omni || (!legacy && mode === 'image'), nativeAudio: true,
        audioSwitch: omni || id.endsWith('-flash'),
        duration: { min: 2, max: omni ? 30 : legacy && mode === 'reference' ? 10 : 15, step: 1 },
        ratios: omni ? [...STANDARD_RATIOS, 'adaptive'] : Object.keys(WAN_SIZES),
        resolutions: omni ? ['480P', '720P', '1080P'] : ['720P', '1080P'],
        defaultResolution: '1080P', maxPromptChars: omni ? 20000 : legacy ? 1500 : 5000,
        ...(legacy && mode !== 'image' ? { sizes: WAN_SIZES } : {}),
      },
    };
  }),
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
  {
    protocols: new Set(['dashscope']),
    match: m => m === 'wanx2.1-vace-plus',
    caps: {
      family: 'wan', wanMode: 'reference', vace: true, refToken: '图', refImages: 3, firstLastFrame: false,
      duration: { min: 5, max: 5, step: 1 }, sizes: WAN_SIZES, ratios: Object.keys(WAN_SIZES),
      resolutions: ['720P'], defaultResolution: '720P', maxPromptChars: 800, nativeAudio: false,
    },
    unknownFields: [],
  },
  {
    protocols: new Set(['dashscope']),
    match: model => model === WAN_LEGACY_KEYFRAME_MODEL,
    caps: {
      family: 'wan', refImages: 0, firstLastFrame: true, duration: { min: 5, max: 5, step: 1 },
      maxPromptChars: 800, ratios: STANDARD_RATIOS, nativeAudio: false,
      resolutions: ['480P', '720P', '1080P'], defaultResolution: '720P',
    },
    unknownFields: ['maxPromptChars'],
  },
];

function clone(caps) {
  return {
    ...caps,
    duration: { ...caps.duration },
    ratios: [...caps.ratios],
    ...(caps.resolutions ? { resolutions: [...caps.resolutions] } : {}),
    ...(caps.sizes ? { sizes: { ...caps.sizes } } : {}),
  };
}

/**
 * @param {{ protocol?: string, model?: string, provider?: string }} q
 * @returns {{ family: string, duration: {min:number,max:number,step:number,values?:number[]}, refImages: number,
 *   maxPromptChars: number, ratios: string[], sizes?: Record<string,string>, firstLastFrame: boolean,
 *   nativeAudio: boolean, unknown: boolean, unknownFields: string[] }}
 */
function getVideoCaps({ protocol, model, provider } = {}) {
  const p = String(protocol || '').trim();
  const raw = String(model || '').trim();
  const m = raw.toLowerCase();
  const hit = ENTRIES.find((e) => e.protocols.has(p) && e.match(m, raw));
  const caps = hit
    ? { ...clone(hit.caps), unknown: false, unknownFields: [...hit.unknownFields] }
    : { ...clone(CONSERVATIVE), unknown: true, unknownFields: Object.keys(CONSERVATIVE).filter(k => k !== 'family') };
  const duration = adapterDuration(p, m, String(provider || '').trim().toLowerCase());
  if (duration) {
    caps.duration = duration;
    caps.unknownFields = caps.unknownFields.filter(key => key !== 'duration');
  }
  return caps;
}

// 这些协议在提交时会把秒数转换为供应商的档位，规划时也必须使用同一组可提交值。
function adapterDuration(protocol, model, provider) {
  switch (protocol) {
    case 'kling': return { min: 5, max: 10, step: 5 };
    case 'kling_omni': return /v3-omni|kling-v3/.test(model)
      ? { min: 3, max: 15, step: 1 } : { min: 5, max: 10, step: 5 };
    case 'sora':
      if (provider === 'cheap_seedance2') return isCheapSeedance2FlexibleDurationModel(model)
        ? { min: 4, max: 15, step: 1 } : { min: 5, max: 10, step: 5 };
      if (/^minimax-h3-(original|fast)$/.test(model)) return { min: 4, max: 15, step: 1 };
      return { min: 4, max: 12, step: 4 };
    // Veo3 兼容 JSON 接口没有时长参数，使用模型默认的 8 秒。
    case 'veo3': return { min: 8, max: 8, step: 1 };
    case 'gemini': return /veo[-_]?3/.test(model) ? { min: 4, max: 8, step: 2 } : { min: 5, max: 8, step: 1 };
    case 'vidu': return { min: 1, max: 10, step: 1 };
    case 'xai': return { min: 1, max: 15, step: 1 };
    case 'agnes': {
      if (model.includes('agnes-video-2.5')) return { min: 4, max: 12, step: 1 };
      const values = AGNES_ALLOWED_NUM_FRAMES.map(frames => Math.round(frames / AGNES_FRAME_RATE));
      const actualSeconds = Object.fromEntries(values.map((value, i) => [value, AGNES_ALLOWED_NUM_FRAMES[i] / AGNES_FRAME_RATE]));
      return { min: values[0], max: values.at(-1), step: 1, values, actualSeconds };
    }
    case 'jimeng_ai_api': return model.includes('seedance')
      ? { min: 4, max: 15, step: 1, values: [4, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15] }
      : { min: 5, max: 10, step: 5 };
    default: return null;
  }
}

function isCheapSeedance2FlexibleDurationModel(model) {
  return ['yk-seedance-mini', 'yk-seedance2.0-fast', 'yk-seedance2.0', 'minimax-h3-1080p-15s']
    .includes(String(model || '').toLowerCase());
}

/** 一键流程可以进一步缩窄模型的可选秒数。档位仍从模型原有的 min 起算。 */
function storyboardPlanningCaps(caps, range) {
  if (range == null) return caps;
  if (!Number.isInteger(range.min) || !Number.isInteger(range.max) ||
      range.min < 1 || range.max > 120 || range.min > range.max) {
    throw Object.assign(new Error('请填写有效的单镜时长范围（1–120 秒，最短不超过最长）'), { status: 400 });
  }
  const { min, max, step } = caps.duration;
  const lower = min + Math.max(0, Math.ceil((range.min - min) / step)) * step;
  const upper = min + Math.floor((Math.min(max, range.max) - min) / step) * step;
  const values = caps.duration.values?.filter(value => {
    const actual = caps.duration.actualSeconds?.[value] ?? value;
    return value >= lower && value <= upper && actual >= range.min && actual <= range.max;
  });
  if (lower > upper || values?.length === 0) {
    throw Object.assign(new Error(`单镜范围 ${range.min}–${range.max} 秒与当前模型可用时长不相交（可选秒数：${durationChoices(caps.duration)}），请调整范围或视频模型`), { status: 400 });
  }
  return { ...caps, duration: values
    ? { ...caps.duration, min: values[0], max: values.at(-1), values }
    : { min: lower, max: upper, step } };
}

/** 把时长对齐到能力表范围与步长（就近取整，越界取边界） */
function clampDuration(caps, seconds) {
  const { min, max, step } = caps.duration;
  const d = Number(seconds);
  if (!Number.isFinite(d) || d <= 0) return min;
  if (caps.duration.values) {
    return caps.duration.values.reduce((best, value) => Math.abs(value - d) < Math.abs(best - d) ? value : best);
  }
  const aligned = min + Math.round((d - min) / step) * step;
  return Math.min(max, Math.max(min, aligned));
}

function durationChoices({ min, max, step, values, actualSeconds }) {
  if (actualSeconds) return values.map(value => `${value}（实际约 ${actualSeconds[value].toFixed(2)} 秒）`).join(', ');
  if (values) return values.join(', ');
  if (min === max) return String(min);
  if (step === 1) return `${min}–${max}`;
  const count = 1 + Math.floor((max - min) / step);
  return Array.from({ length: count }, (_, i) => min + i * step).join(', ');
}

// 各提交入口按 Unicode 码点计数，与万相的提示词上限一致。
function promptChars(text) {
  return Array.from(text).length;
}

module.exports = {
  promptChars,
  getVideoCaps,
  storyboardPlanningCaps,
  durationChoices,
  WAN_LEGACY_KEYFRAME_MODEL,
  AGNES_ALLOWED_NUM_FRAMES,
  AGNES_FRAME_RATE,
  clampDuration,
  isSeedance2FamilyModel,
  isCheapSeedance2FlexibleDurationModel,
};
