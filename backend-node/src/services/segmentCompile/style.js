/**
 * 风格句派生：视频风格句 = 剧集画风原文；资产风格句（角色/造型设定图用）去掉环境光与时段倾向，
 * 否则棚拍设定图会被拉成夜景、街景。另检查写实与动漫语汇混写。
 */
const LIGHT_WORDS = /光|照明|阴影|夜|黄昏|日落|清晨|霓虹|雾|雨|烟|氛围|曝/;
// 「摄影」「胶片」只有声明渲染媒介时才算写实语汇；「摄影般的浅景深」「胶片呼吸感」是镜头与颗粒效果，可用在任何画风上
const PHOTO_WORDS = /写实|实拍|照片|毛孔|RAW|皮肤纹理|真人|摄影风|摄影作品|专业摄影|胶片摄影|胶片电影/;
const DRAWN_WORDS = /动漫|二次元|赛璐璐|线稿|漫画|插画|卡通|平涂|厚涂|手绘|番剧|条漫/;

// 画风文案里常夹带「人物 / 场景」描述；道具图只要媒介与笔触，带上它们会把道具画成人物
const SUBJECT_WORDS = new RegExp(
  '人物|人像|人设|角色|主角|男人|女人|男子|女子|少年|少女|老人|中年|青年|胡须|面部|五官|肤质|皮肤|头发|发型|发饰|毛孔|' +
    '服饰|服装|衣纹|衣褶|衣着|汉服|身穿|头戴|穿着|神态|表情|姿态|肢体|说话|背景|场景|布景|街景|景观|建筑|亭台|室内|室外|宫殿|宫阙|' +
    '\\b(?:characters?|portrait|person|people|man|woman|face|facial|skin|hair|wearing|costume|clothing|figure|background|scenes?|environment)\\b',
  'i'
);
// 方括号里是整段人物/场景占位描述，先整体去掉
const BRACKETED = /[[［【][^\]］】]*[\]］】]/g;

function clauses(text) {
  return String(text || '').split(/[，,、；;]/).map((s) => s.trim()).filter(Boolean);
}

/** 去掉含人物/场景描述的分句，只留媒介、笔触、色调类词；全是主体描述时返回空串 */
function styleWithoutSubject(styleText) {
  return String(styleText || '')
    .replace(BRACKETED, '')
    .split(/[，,、；;。！？!?\n]/)
    .map((s) => s.trim())
    .filter((c) => c && !SUBJECT_WORDS.test(c))
    .join('，');
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

module.exports = { deriveStyleSentences, styleWithoutSubject };
