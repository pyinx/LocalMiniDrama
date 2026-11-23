/**
 * 编译器使用的全部固定措辞（自写；AC18 守护测试会扫描本目录，确保不与即梦原文连续重合 ≥15 字）。
 * 改措辞只改这里；同一个意思全剧只用一种说法，模型才不会把两种说法当成两件事。
 */
module.exports = {
  stylePrefix: '视觉风格：',
  refCharacter: (tok, name) => `${tok} 对应人物「${name}」，此人的脸、发型和衣着一律照这张图。`,
  refCrowd: (tok, name) => `${tok} 是一群「${name}」的样子参照，人数与站位按下文。`,
  refScene: (tok, name) => `${tok} 对应地点「${name}」此刻的样子，房间格局、摆设与光线一律照这张图。`,
  /** 只有场景母版、没有本段状态图时：母版不代表此刻的时段，光线听文字的 */
  refSceneLayout: (tok, name) => `${tok} 对应地点「${name}」，房间格局与摆设照这张图；光线和时段以下文为准。`,
  refProp: (tok, name) => `${tok} 对应物件「${name}」，外形与颜色一律照这张图。`,
  refTailFrame: (tok) => `${tok} 只用来接住上一段收尾时的人物站位与物件位置，构图不必照搬。`,
  sceneLine: (place, setting) => `地点：${place}。${setting}。`,
  continuityProps: (list) => `一直在场的物件：${list}。`,
  positionLock: (text) => `站位固定：${text}。`,
  axisLock: (text) => `左右关系固定：${text}。`,
  ambience: (text) => `环境底噪：${text}。`,
  tone: (text) => `光线与时段：${text}。`,
  shotCount: (n, d) => `这段视频总长 ${d} 秒，由 ${n} 个镜头组成。`,
  shotHead: (k, s) => `镜头${k}（${s}秒）：`,
  cutHard: '直接切到',
  cutContinuous: '镜头不断，接着',
  framing: (size, camera) => `${size}，${camera}。`,
  subject: (who, pos, facing, gaze, pose, holding) =>
    `${who}在${pos}，${facing}，眼睛看着${gaze}${pose ? `，${pose}` : ''}${holding ? `，手里拿着${holding}` : ''}。`,
  movement: (m) => `运镜：${[m.type, m.speed, m.direction].filter(Boolean).join('，')}。`,
  action: (text) => `${text}。`,
  event: (text) => `本拍的叙事变化：${text}。`,
  voice: (who, desc) => `${who}的嗓音：${desc}。`,
  sayNative: (who, text, delivery) => `${who}开口${delivery ? `（${delivery}）` : ''}，嘴型与每个字对齐："${text}"，说完闭上嘴。`,
  innerNative: (who, text) => `${who}嘴没有动，画面里响起${who}自己心里的声音："${text}"。`,
  offscreenNative: (who, text) => `画面外传来${who}的声音："${text}"。`,
  narrationNative: (text) => `画面外有旁白："${text}"。`,
  silentNative: (who) => `${who}嘴唇合着，不说话。`,
  dubbed: (who) => `${who}嘴唇合着，这一拍的话放到后期配音。`,
  sfx: (list) => `声音：${list}。`,
  allSilent: '这一段里出镜的人都不开口。',
  tailNative: '音轨里只要人物对白、环境声与动作发出的声音，不加背景音乐，画面上不出现任何字幕或文字条。',
  tailDubbed: '音轨里只要环境声与动作发出的声音，没有人声，不加背景音乐，画面上不出现任何字幕或文字条。',
};
