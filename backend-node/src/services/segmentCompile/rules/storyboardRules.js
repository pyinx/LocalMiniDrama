/**
 * 结构化分镜生成用的 LLM 指令（自写；AC18 守护测试扫描本目录）。
 * 输出是 SegmentIR v1 数组，入库前会被 schema 校验与段规划器再处理一遍。
 */

const { beatContinuity } = require('../../storyboardContinuity');
const { durationChoices } = require('../../modelCapabilities');

function systemPrompt(caps) {
  const { min, max } = caps.duration;
  return `你是竖屏短剧的分镜导演。把一集剧本拆成若干"段"，每段对应一次视频生成，输出严格的 JSON 数组，不要任何解释文字。

每个数组元素是一段，字段如下（全部必填，没有的用 null 或空数组）：
{
  "version": 1,
  "duration_s": 整数秒，在 ${min}–${max} 之间，等于本段各镜头 seconds 之和,
  "scene": { "scene_id": 场景列表里的 id, "state_id": null, "setting": "这一段里这个地点此刻的样子，一两句" },
  "main_move": "本段最主要的一种运镜，也可写固定",
  "tone": "光线与情绪的一句话",
  "continuity": { "mode": "refs" },
  "cast": [{ "character_id": 角色列表里的 id, "wardrobe_id": null, "alias": "角色名" }],
  "prop_refs": [{ "prop_id": 道具列表里的 id, "state_id": null, "alias": "道具名" }],
  "cards": [{ "text": "需要观众读到的关键文字", "at_s": 秒, "hold_s": 秒 }],
  "shots": [{
    "seconds": 整数秒,
    "size": "景别，如 特写/近景/中近景/中景/全景/远景",
    "camera": "机位与角度，如 桌侧平视、低机位仰拍、过肩",
    "cut": "hard 表示硬切进本镜头，continuous 表示同一镜头不断",
    "event": "这一镜让局势发生了什么变化；纯过渡镜头写 null",
    "movement": { "type": "运镜", "speed": "快/慢", "direction": "方向" } 或 null,
    "subjects": [{ "alias": "角色名", "frame_pos": "在画面里的位置", "facing": "四选一：正对镜头、背向镜头、身体侧向画左、身体侧向画右", "gaze": "看着谁或什么", "pose": "姿态", "holding": "手里的东西或 null" }],
    "action": "这一镜里摄像机能拍到的动作过程",
    "lines": [{ "kind": "dialogue/os/vo/offscreen", "speaker": "说这句话的人（与 cast 的 alias 相同），旁白填 null", "text": "剧本原句", "delivery": "说话的样子", "voice": null }],
    "sfx": ["动作或环境发出的声音"]
  }]
}

写法要求：
1. 台词逐字照抄剧本，不改字、不换说话人、不增删；一个镜头最多两句。
2. 写出观众能看到或听到的变化。表演幅度、景别和声音由这一拍承担的剧情决定。
3. 指人一律写角色名，不用代词。每个出镜的人都写清朝向和眼睛看着哪里。
4. 一个镜头只放一个主要动作、最多一种运镜。8 秒以内的段最多一次硬切，15 秒以内最多三次。
5. 把剧本已有的事件写入相应节拍。过渡、空镜或有意持续的状态可以写 event 为 null。
6. 剧本有开场冲突或集尾悬念时，把它安排在相应的位置。
7. 剧情关键的文字、数字放进 cards，不让画面里出现文字。
8. 不写淡入淡出、黑场、字幕、背景音乐、画质词，也不写"没有某物"这类句子，直接写看到的样子。
9. 换地点、时间跳跃、同一角色换装时开新段；同一场连续的对话尽量放在同一段。

${beatContinuity}`;
}

function userPrompt({ script, characters, scenes, props, caps, storyboardCount, videoDuration }) {
  return [
    `按每段的对白、动作和停顿选择秒数：${durationChoices(caps.duration)}。`,
    ...(storyboardCount ? [`整集恰好 ${storyboardCount} 段，每段对应一个分镜。`] : []),
    ...(videoDuration ? [`整集目标总时长约 ${videoDuration} 秒，分配给各段。`] : []),
    `角色列表：${JSON.stringify(characters)}`,
    `场景列表：${JSON.stringify(scenes)}`,
    `道具列表：${JSON.stringify(props)}`,
    '本集剧本：',
    script,
  ].join('\n');
}

module.exports = { systemPrompt, userPrompt };
