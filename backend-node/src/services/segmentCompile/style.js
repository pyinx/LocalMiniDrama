/**
 * 风格句派生：视频风格句 = 剧集画风原文；资产风格句（角色/造型设定图用）去掉环境光与时段倾向，
 * 否则棚拍设定图会被拉成夜景、街景。另检查写实与动漫语汇混写。
 */
const LIGHT_WORDS = /光|照明|阴影|夜|黄昏|日落|清晨|霓虹|雾|雨|烟|氛围|曝/;
const PHOTO_WORDS = /写实|实拍|照片|摄影|毛孔|胶片|RAW|皮肤纹理|真人/;
const DRAWN_WORDS = /动漫|二次元|赛璐璐|线稿|漫画|插画|卡通|平涂|厚涂|手绘|番剧|条漫/;

function clauses(text) {
  return String(text || '').split(/[，,、；;]/).map((s) => s.trim()).filter(Boolean);
}

/** @returns {{ video: string, asset: string, findings: object[] }} */
function deriveStyleSentences(styleText) {
  const video = clauses(styleText).join('，');
  const kept = clauses(styleText).filter((c) => !LIGHT_WORDS.test(c));
  const asset = kept.length ? kept.join('，') : video;
  const findings = [];
  if (PHOTO_WORDS.test(video) && DRAWN_WORDS.test(video)) {
    findings.push({ level: 'warn', code: 'mixed_style_vocabulary', where: {}, msg: '风格句同时含写实与手绘/动漫语汇，画风可能在两者间摇摆' });
  }
  return { video, asset, findings };
}

module.exports = { deriveStyleSentences };
