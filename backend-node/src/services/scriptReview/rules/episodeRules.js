/**
 * 短剧分集剧本的写作纪律与剧本体检评分细则（自写；AC18 守护测试会扫描本目录）。
 */
const WRITING_RULES_ZH = `
短剧单集写作纪律：
1. 前两三句之内就让冲突、异常或危机露面；不要用天气、风景、回忆或人物介绍做开头。
2. 结尾停在最紧的那一刻，用一个画面或一句台词亮出悬念，后面不再补收尾段落和感慨。
3. 台词以短句为主，一般每句不超过 15 个字、只说一件事；同一个人连着说话不超过三句，中间插入对方的反应或动作。
4. 只写摄像机拍得到、话筒录得到的内容：心理活动改写成表情和动作，比如把"他很失望"写成"他把杯子推到桌角"。
5. 人物之间不互相讲双方早就知道的背景；需要交代的信息让道具、屏幕或动作带出来。
6. 台词单独成行，写成「人名：台词」；内心独白写成「人名（os）：台词」，画外旁白写成「旁白：台词」。`;

const WRITING_RULES_EN = `
Short-drama episode discipline:
1. Put the conflict, anomaly or threat on screen within the first two or three sentences; never open with weather, scenery, memories or character introductions.
2. End on the tightest moment with an image or a line that exposes the hook; no wrap-up paragraph afterwards.
3. Keep dialogue short — one idea per line; one character speaks at most three lines in a row before the other reacts.
4. Write only what a camera can see and a microphone can hear: turn inner feelings into visible actions.
5. Characters never explain shared background to each other; let props, screens or actions carry the information.
6. Put each spoken line on its own line as "Name: line"; inner monologue as "Name (os): line"; narration as "Narrator: line".`;

/** 体检维度与权重（自定；合计 1） */
const DIMENSIONS = [
  { key: 'opening', label: '开场抓人', weight: 0.15, ask: '前 3 秒内有没有能看见的冲突或异常' },
  { key: 'hook', label: '集尾悬念', weight: 0.15, ask: '最后一个画面或一句话是否让人想看下一集' },
  { key: 'conflict', label: '冲突与反转', weight: 0.15, ask: '有没有攻防回合、信息差或局势翻转，而不是事件流水账' },
  { key: 'pacing', label: '节奏密度', weight: 0.12, ask: '每隔几秒是否有新的推动，是否有大段说明戏' },
  { key: 'dialogue', label: '台词质感', weight: 0.12, ask: '台词是否简短有力、像人说的话，有没有念设定和套话' },
  { key: 'character', label: '人物动机', weight: 0.1, ask: '主角是否有主动选择，人物行为是否有可信的动机' },
  { key: 'payoff', label: '爽点与记忆点', weight: 0.11, ask: '有没有能被截图传播的台词、反差或具体物件' },
  { key: 'shootability', label: '可拍性', weight: 0.1, ask: '是否只写了拍得到听得到的内容，有没有画不出来的心理描写' },
];

function reviewSystemPrompt() {
  return `你是竖屏短剧的剧本审读。只诊断，不改写剧本，也不要给出改写后的全文。
先判断三道门槛（布尔值）：
- non_script：这还不是可拍的剧本（只有梗概或仍是小说叙述）
- compliance_blocked：出现了不能拍的内容，例如涉及儿童的性内容、可照做的作案或伤害步骤、把违法行为写成值得效仿
- homogeneous：同一种冲突套路连续重复三次以上，对手、手段、结果都没有变化
再按下列维度各打 1–10 的整数分，每个分数都要给出剧本里的具体证据；拿不出证据的维度最多给 5 分，不要扎堆给 5–7 的稳妥分：
${DIMENSIONS.map((d) => `- ${d.key}（${d.label}）：${d.ask}`).join('\n')}
最后列出最多 8 条具体问题，每条写清在剧本哪里、问题是什么、建议怎么改（一句话方向，不写替换文本）。
只输出一个 JSON 对象，含三个字段：
- gates：对象，含布尔字段 non_script、compliance_blocked、homogeneous，以及字符串 notes
- dimensions：数组，每项含 key（上面的英文键）、score（1–10 整数）、evidence（剧本里的依据）
- problems：数组，每项含 location（剧本里的位置）、what（问题）、advice（改进方向）`;
}

module.exports = { WRITING_RULES_ZH, WRITING_RULES_EN, DIMENSIONS, reviewSystemPrompt };
