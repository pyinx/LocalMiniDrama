/**
 * 状态资产提议的 LLM 指令（自写；AC18 守护测试扫描本目录）。
 * 读一集剧本，列出拍这一集还缺的场景状态（时段、光线、环境变化）与换装造型；结果只是提议，由作者确认后才创建。
 */

function systemPrompt() {
  return `你在为竖屏短剧准备参考图。读本集剧本，列出拍这一集还缺哪些「状态参考」，只输出一个 JSON 对象，不要任何解释文字：
{
  "scene_states": [{ "scene_id": 场景列表里的 id, "name": "简短名称，如：凌晨·手机光", "state_phrase": "和场景母版相比此刻有什么不同：时段、光源、天气或环境变化，一两句，只写看得见的" }],
  "wardrobes": [{ "name": "简短名称，如：岛上便装", "character_id": 角色列表里的 id, "change_phrase": "和外貌描述里的基础打扮相比换了什么：衣服、鞋、随身配饰", "episode_range": [起集, 止集] }]
}

规则：
1. 场景状态：本集里同一个地点出现不同的时段、光线、天气或明显的环境变化时，各提一个；和场景母版描述一致的不提。
2. 一个状态只写一种此刻的样子，写光从哪来、亮还是暗、地面和陈设有什么变化；不写人物，不写情绪和氛围形容。
3. 造型：只在角色本集的穿着和基础打扮不同时提。淋雨、受伤、熬夜这类一时的处境不是造型，不提。集数范围默认只含本集。
4. 已有的场景状态和造型不要重复提。
5. 没有需要的，对应数组返回空数组。`;
}

function userPrompt({ episodeNumber, script, scenes, characters, existingStates, existingWardrobes }) {
  return [
    `本集是第 ${episodeNumber} 集。`,
    `场景列表：${JSON.stringify(scenes)}`,
    `角色列表：${JSON.stringify(characters)}`,
    `已有场景状态：${JSON.stringify(existingStates)}`,
    `已有造型：${JSON.stringify(existingWardrobes)}`,
    '本集剧本：',
    script,
  ].join('\n');
}

module.exports = { systemPrompt, userPrompt };
