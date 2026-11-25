# 短剧创作方法 Skill 蓝图

> 2026-11-24。本文是设计产物，不改变软件运行时。它把 shortdramaskills.com 收录的外部方法按第一性原理筛选后，收敛为 6 个正交模块，交给后续各迭代实现。

## 一、目标与理想输入

目标：让一部多集短剧在**剧情、对白、人物、资产、镜头、成片**六个环节都有可复用的质量关卡，减少返工，而不是堆砌更多 skill 名称。

从目标正向推演，高质量输出需要一份完整的输入：

1. **全剧层**：题材与赛道、核心冲突、人物关系与反派层级、分集冲突弧线、卡点与钩子分布、伏笔的埋设与回收、跨集不可变事实。
2. **素材层**：若来自小说，需要事实卡、两条时间线（故事发生顺序 vs 作者呈现顺序）、可拍事件的切分、改编取舍记录。
3. **剧本层**：每集开场危机、攻防回合、可拍行为、活人感对白、集尾悬念，以及“问题在哪一行、为什么是问题、往哪个方向改”的诊断。
4. **资产层**：每个角色每套造型、每个场景每个时段、每件关键道具每个状态的全剧矩阵，以及何时用哪个变体。
5. **镜头层**：每场戏的主机位、站位与轴线、动作因果链、文戏的视线/停顿/微动作、打戏的攻防与落点。
6. **成片层**：实际提交的提示词、实际生成的视频、关键帧上的可见证据，用来区分“平台没执行”和“写法有问题”。

## 二、现状缺口（按杠杆排序）

本项目的原生能力已经覆盖第 4、5、6 层的一部分：`backend-node/src/services/segmentIr/`（schema、planner）、`segmentCompile/`（编译器、lint、整集检查、尾帧资格）、`assetStateProposalService.js`、`episodeContinuityService.js`、`workbenchContinuity.js`、`mediaDiagnostics.js`。外部 137 个 skill 中，多数 `pipeline` 与 `visual` 项目是在纯 CLI 里用 Markdown 文件和 Python 脚本模拟这些能力——对我们是重复建设，全盘引入只会造成双源真相。

真正的缺口：

| 优先级 | 环节 | 缺口 | 后果 |
|---|---|---|---|
| P0 | 全剧层 | 只有 `creative_direction.facts`（4000 字纯文本）和一次性生成 N 集；没有关系图、伏笔表、分集卡点台账、跨集事实校验 | 集数一多就人设漂移、伏笔遗忘、套路重复 |
| P0 | 剧本层 | `scriptReviewService.js` 已有 8 维打分与三道门槛，但只诊不改；缺选题级/前三集生死线诊断、缺对白去 AI 味、缺微创改稿 | 台词说明书腔、金句排比、问题知道但改不动 |
| P1 | 素材层 | `novelImportService.js` 按 2000 字硬切并带前段末 280 字逐段改写，不先建事实卡与事件线 | 改编成流水账，把小说心理描写带进剧本 |
| P1 | 资产层 | `assetStateProposalService.js` 只提议场景状态与造型，**不提议道具状态**；`prop_states` 表虽存在但未进提议闭环；没有全剧资产×场次矩阵 | 信物碎裂、伤口、手机亮屏等跨集穿帮 |
| P1 | 镜头层 | `creative-methods.json` 只有 4 个场面的一句话建议；`episodeContinuityService.js` 的 `position_lock`/`axis_lock` 是自由文本；没有打戏方法 | 站桩念词、群戏抢演、动作戏糊 |
| P2 | 成片层 | `mediaDiagnostics.js` 只用 ffmpeg 查黑屏/冻结；缺对照 IR 与参考图的视觉核查与归因 | 返工发现太晚，且分不清是平台偏差还是写法问题 |

## 三、模块划分（唯一事实源）

本节清单是机器可校验的唯一事实源；上面的推演与下面的分模块说明都引用它，不另建平行列表。

```json
{
  "version": 1,
  "principles": [
    "先立骨再写肉：全剧事实先于分集，分集先于镜头",
    "只补缺口，不重造 SegmentIR 编译器、资产表与审片台账",
    "每个模块只有一个数据归属，不跨模块同步副本",
    "诊断与改写分离：先定位证据，再给方向，作者确认后才落盘",
    "一套方法只留一个来源断言，重复能力合并而不是并列"
  ],
  "modules": [
    {
      "id": "drama-bible",
      "name": "全剧架构与连载记忆",
      "boundary": "维护跨集不可变事实、人物关系与反派层级、分集冲突弧线、卡点/钩子分布、伏笔埋设与回收；在写每集前提供约束，写完后核对是否违背；不写剧本文本，不生成分镜。",
      "non_goals": ["不替作者决定题材与画风", "不另建剧集数据库表", "不做单集台词润色", "不覆盖 creative_direction 的 revision 契约"],
      "stages": ["market", "structure", "revision"],
      "data_owner": "backend-node/data/agent-notes/<dramaId>/series-bible.json",
      "tools": [
        { "name": "get_series_notes", "input": "dramaId, kind", "errors": ["not_found", "invalid_kind"] },
        { "name": "save_series_notes", "input": "dramaId, kind, expected_revision, document", "errors": ["not_found", "conflict", "invalid_document"] },
        { "name": "check_series_continuity", "input": "dramaId, episodeId, script", "errors": ["not_found", "empty_script", "conflict"] }
      ],
      "reuse": [
        "backend-node/src/services/dramaService.js",
        "backend-node/src/services/workbenchCreativeMethods.js",
        "backend-node/src/services/storyGenerationService.js",
        "backend-node/src/mastra/context.mjs"
      ],
      "sources": [
        { "repo": "0xsline/short-drama", "license": "MIT", "use": "付费卡点分布、分集目录与全剧状态推进" },
        { "repo": "mengxiujie/ManjuForge", "license": "MIT-0", "use": "故事圣经、伏笔表、人物关系图与跨文件一致性检查" }
      ],
      "iteration": "P0"
    },
    {
      "id": "script-doctor",
      "name": "剧本深审与对白活人感精修",
      "boundary": "在现有 8 维剧本体检之上补选题级判断、前三集生死线、对抗式逻辑挑刺；对白层查说明书腔、排比金句、缺潜台词；先给带证据的诊断，再给最少改动的提议，作者确认后才保存。",
      "non_goals": ["不整篇重写剧本", "不擅自改台词原意与关键对白", "不改合规判断", "不替作者决定爽点与风格"],
      "stages": ["drafting", "revision"],
      "data_owner": "backend-node/data/agent-notes/<dramaId>/episode-<episodeId>-script-review.json",
      "tools": [
        { "name": "review_episode_deep", "input": "dramaId, episodeId, mode", "errors": ["not_found", "empty_script", "invalid_mode"] },
        { "name": "propose_script_edits", "input": "dramaId, episodeId, finding_ids", "errors": ["not_found", "conflict", "invalid_selection"] }
      ],
      "reuse": [
        "backend-node/src/services/scriptReviewService.js",
        "backend-node/src/services/scriptReview/rules/episodeRules.js",
        "backend-node/src/services/promptI18n.js",
        "backend-node/src/services/segmentCompile/lint.js"
      ],
      "sources": [
        { "repo": "Vi7QY/screenwriter-skill", "license": "MIT", "use": "分层审稿：选题、前三集生死线、改稿方向" },
        { "repo": "KKKKhazix/human-writing", "license": "MIT", "use": "中文活人感对白与去 AI 腔的可报警规则" },
        { "repo": "adoria111/emma-screenwriting-skills", "license": "MIT", "use": "逐集钩子诊断与对白效率检查" }
      ],
      "iteration": "P0"
    },
    {
      "id": "novel-deconstruct",
      "name": "小说与长素材先拆后改",
      "boundary": "在逐段改编之前先建事实卡、事件线、动机链与改编取舍记录；按可拍事件而非字数边界提议分集切点；把结果交给现有小说导入链路，不自行写剧本。",
      "non_goals": ["不下载或抓取外部小说", "不替换现有章节识别与导入接口", "不改已有分集正文与分镜", "不续写原文后文"],
      "stages": ["adaptation", "structure"],
      "data_owner": "backend-node/data/agent-notes/<dramaId>/source-deconstruction.json",
      "tools": [
        { "name": "get_source_facts", "input": "dramaId, source_hash", "errors": ["not_found", "source_changed"] },
        { "name": "propose_episode_split", "input": "dramaId, source_hash, episode_count", "errors": ["not_found", "source_changed", "invalid_count"] }
      ],
      "reuse": [
        "backend-node/src/services/novelImportService.js",
        "backend-node/src/services/aiClient.js",
        "backend-node/src/services/promptI18n.js",
        "backend-node/src/utils/safeJson.js"
      ],
      "sources": [
        { "repo": "VanGong1999/screen-creative-skills", "license": "MIT", "use": "小说摘要、情节点拆解、人物小传与改编评估" }
      ],
      "iteration": "P1"
    },
    {
      "id": "asset-bible",
      "name": "跨集资产盘点与状态锁",
      "boundary": "把角色造型、场景时段、关键道具状态、复现特效做成全剧矩阵；指出哪一集哪一场用哪个变体，以及状态变化前后的可见差别；把道具状态提议接入现有资产接口，由作者确认后创建。",
      "non_goals": ["不直接调用付费出图接口", "不改角色头身拼接规则", "不绕过变体的作者确认", "不新建资产表"],
      "stages": ["character", "adaptation", "production"],
      "data_owner": "backend-node/data/agent-notes/<dramaId>/asset-matrix.json",
      "tools": [
        { "name": "get_asset_matrix", "input": "dramaId", "errors": ["not_found"] },
        { "name": "propose_prop_states", "input": "dramaId, episodeId", "errors": ["not_found", "empty_script", "conflict"] },
        { "name": "check_asset_lock", "input": "dramaId, episodeId, storyboardId", "errors": ["not_found", "asset_unready"] }
      ],
      "reuse": [
        "backend-node/src/services/assetStateProposalService.js",
        "backend-node/src/services/assetVariantService.js",
        "backend-node/src/services/propService.js",
        "backend-node/src/services/episodeContinuityService.js",
        "backend-node/src/services/characterHeadBody.js"
      ],
      "sources": [
        { "repo": "EVZheng-Lab/ad-asset-bible", "license": "MIT", "use": "场景/服装/道具/特效的变体矩阵与静态-动态描述分离" },
        { "repo": "eternityspring/shuohao-skills", "license": "Apache-2.0", "use": "角色参考图与资产设定的可比较性纪律" }
      ],
      "iteration": "P1"
    },
    {
      "id": "shot-director",
      "name": "空间调度、文戏表演与打戏编排",
      "boundary": "为每场戏先定主机位与站位轴线，再分配动作因果、视线与停顿；文戏写可拍的表演节拍，打戏写攻防回合、持物手、运动方向和落点；产出建议写入分镜规划的输入，不直接改 SegmentIR。",
      "non_goals": ["不绕过分镜规划器的时长与事件约束", "不写情绪标签代替动作", "不引入 Blender/白模等外部运行时", "不改现有分镜字段结构"],
      "stages": ["storyboard", "prompt"],
      "data_owner": "backend-node/data/agent-notes/<dramaId>/episode-<episodeId>-direction.json",
      "tools": [
        { "name": "propose_blocking", "input": "dramaId, episodeId, scene_id", "errors": ["not_found", "asset_unready"] },
        { "name": "review_shot_continuity", "input": "dramaId, episodeId, storyboardId", "errors": ["not_found", "legacy_storyboard"] }
      ],
      "reuse": [
        "backend-node/src/services/workbenchCreativeMethods.js",
        "backend-node/src/services/segmentCompile/rules/storyboardRules.js",
        "backend-node/src/services/segmentCompile/continuity.js",
        "backend-node/skills/short-drama/references/creative-methods.json",
        "backend-node/skills/short-drama/references/beat-continuity.md"
      ],
      "sources": [
        { "repo": "irenerachel/fight-prompt-director", "license": "MIT", "use": "角色动作档案、攻防因果链与强度档位" },
        { "repo": "smixs/visual-skills", "license": "CC-BY-4.0", "use": "戏剧法则与逐镜三细节检查（文档署名）" },
        { "repo": "jtydhr88/screenwriting-skills", "license": "MIT", "use": "场景调度与对白场面的人物目标方法" }
      ],
      "iteration": "P1"
    },
    {
      "id": "clip-qc",
      "name": "成片视觉质检与归因",
      "boundary": "在实际提交的提示词、参考图与成片关键帧之间取证；按失败模式记录时间码与可见证据，并区分作者要求未被执行、模型单次抽卡偏差、写法表达不足；只出诊断，不自动重渲。",
      "non_goals": ["不自动改写或覆盖成片", "不把单次样片当成稳定倾向", "不编造未看到的证据", "不接入第三方付费质检服务"],
      "stages": ["production"],
      "data_owner": "backend-node/data/agent-notes/<dramaId>/episode-<episodeId>-qc.json",
      "tools": [
        { "name": "get_take_evidence", "input": "dramaId, storyboardId, take_id", "errors": ["not_found", "media_unavailable"] },
        { "name": "record_clip_findings", "input": "dramaId, episodeId, findings", "errors": ["not_found", "invalid_finding"] }
      ],
      "reuse": [
        "backend-node/src/services/mediaDiagnostics.js",
        "backend-node/src/services/workbenchTakeService.js",
        "backend-node/src/services/workbenchContinuity.js",
        "backend-node/src/services/segmentCompileService.js"
      ],
      "sources": [
        { "repo": "A-cat-with-carrots/OnlyShot", "license": "MIT", "use": "AI 视频失败模式清单与逐镜复看纪律" }
      ],
      "iteration": "P2"
    }
  ],
  "excluded": [
    "整套外挂流水线 skill（zenstory-ai/drama-skills、lixiaoxiao9888-create/manju-laoli-skill、shuohao-skills 的整包）：与 SQLite + SegmentIR 双源，只取方法不整套引入",
    "海量题材与模型提示词包（21 类漫剧模板、284 个案例库、prompt library）：边际收益递减且随模型迭代失效",
    "重外部运行时依赖（Blender MCP、ComfyUI、AutoDL、付费聚合 CLI、需登录的平台插件）：破坏本地轻量定位",
    "许可证不可商用或不可审计（CC BY-NC / ND / 无许可证 / 混淆加载器）的项目"
  ],
  "iterations": {
    "P0": ["drama-bible", "script-doctor"],
    "P1": ["novel-deconstruct", "asset-bible", "shot-director"],
    "P2": ["clip-qc"]
  },
  "runtime_changes": {
    "new_database_tables": 0,
    "frontend_files": 0,
    "api_endpoints": 0,
    "runtime_files_modified": 0
  }
}
```

## 四、分模块说明

### P0 · `drama-bible` 全剧架构与连载记忆

- **职责边界**：管跨集不可变事实、人物关系与反派层级、分集冲突弧线、卡点/钩子分布、伏笔埋设与回收。写集之前提供约束，写完之后核对是否违背。不写剧本文本，不生成分镜。
- **非目标**：不替作者决定题材与画风；不另建剧集数据库表；不做单集台词润色；不覆盖 `creative_direction` 的 revision 契约。
- **数据归属**：`backend-node/data/agent-notes/<dramaId>/series-bible.json`，由 `get_series_notes` / `save_series_notes` 独占读写，`expected_revision` 做冲突检测。
- **所需 Agent 工具**：`get_series_notes`、`save_series_notes`、`check_series_continuity`（契约见清单）。
- **外部来源与许可证**：`0xsline/short-drama`（MIT，卡点分布与分集状态推进）、`mengxiujie/ManjuForge`（MIT-0，故事圣经、伏笔表与跨文件一致性检查）。
- **所属迭代**：P0。与 `script-doctor` 同批先定笔记与来源契约。

### P0 · `script-doctor` 剧本深审与对白活人感精修

- **职责边界**：在现有 8 维剧本体检之上补选题级判断、前三集生死线、对抗式逻辑挑刺；对白查说明书腔、排比金句、缺潜台词。先给带证据的诊断，再给最少改动的提议，作者确认后保存。
- **非目标**：不整篇重写；不擅改关键对白原意；不改合规判断；不替作者决定爽点与风格。
- **数据归属**：`agent-notes/<dramaId>/episode-<episodeId>-script-review.json`。
- **所需 Agent 工具**：`review_episode_deep`、`propose_script_edits`。
- **外部来源与许可证**：`Vi7QY/screenwriter-skill`（MIT，分层审稿）、`KKKKhazix/human-writing`（MIT，中文活人感）、`adoria111/emma-screenwriting-skills`（MIT，钩子与对白效率）。
- **所属迭代**：P0。

### P1 · `novel-deconstruct` 小说与长素材先拆后改

- **职责边界**：逐段改编之前先建事实卡、事件线、动机链与取舍记录；按可拍事件而非固定字数提议分集切点，交给现有小说导入链路。
- **非目标**：不下载外部小说；不替换章节识别与导入接口；不改已有分集与分镜；不续写原文。
- **数据归属**：`agent-notes/<dramaId>/source-deconstruction.json`，以 `source_hash` 判定原文是否变化。
- **所需 Agent 工具**：`get_source_facts`、`propose_episode_split`。
- **外部来源与许可证**：`VanGong1999/screen-creative-skills`（MIT，小说摘要、情节点拆解、人物小传）。
- **所属迭代**：P1。

### P1 · `asset-bible` 跨集资产盘点与状态锁

- **职责边界**：把造型、场景时段、关键道具状态、复现特效做成全剧矩阵；指出哪集哪场用哪个变体及状态变化的可见差别；把道具状态提议接入现有接口，由作者确认后创建。
- **非目标**：不直接调出图接口；不改头身拼接规则；不绕过作者确认；不新建资产表。
- **数据归属**：`agent-notes/<dramaId>/asset-matrix.json`。
- **所需 Agent 工具**：`get_asset_matrix`、`propose_prop_states`、`check_asset_lock`。
- **外部来源与许可证**：`EVZheng-Lab/ad-asset-bible`（MIT，变体矩阵）、`eternityspring/shuohao-skills`（Apache-2.0，参考图可比较性）。
- **所属迭代**：P1。

### P1 · `shot-director` 空间调度、文戏表演与打戏编排

- **职责边界**：先定主机位与站位轴线，再分配动作因果、视线与停顿；文戏写可拍表演节拍，打戏写攻防回合、持物手、运动方向与落点；产出作为分镜规划的输入，不直接改 SegmentIR。
- **非目标**：不绕过分镜规划器的时长与事件约束；不写情绪标签代替动作；不引入白模运行时；不改分镜字段结构。
- **数据归属**：`agent-notes/<dramaId>/episode-<episodeId>-direction.json`。
- **所需 Agent 工具**：`propose_blocking`、`review_shot_continuity`。
- **外部来源与许可证**：`irenerachel/fight-prompt-director`（MIT，动作档案与攻防链）、`smixs/visual-skills`（CC-BY-4.0，戏剧法则，文档署名）、`jtydhr88/screenwriting-skills`（MIT，场景调度）。
- **所属迭代**：P1。

### P2 · `clip-qc` 成片视觉质检与归因

- **职责边界**：在实际提示词、参考图与成片关键帧之间取证；按失败模式记录时间码与可见证据；区分作者要求未被执行、模型单次偏差、写法表达不足。只诊断，不自动重渲。
- **非目标**：不覆盖成片；不把一次样片当稳定倾向；不编造证据；不接第三方付费质检。
- **数据归属**：`agent-notes/<dramaId>/episode-<episodeId>-qc.json`。
- **所需 Agent 工具**：`get_take_evidence`、`record_clip_findings`。
- **外部来源与许可证**：`A-cat-with-carrots/OnlyShot`（MIT，失败模式清单与逐镜复看纪律）。
- **所属迭代**：P2。

## 五、明确排除项

1. **整套外挂流水线**：`zenstory-ai/drama-skills`、`lixiaoxiao9888-create/manju-laoli-skill`、`shuohao-skills` 的整包文件流水线。它们与本项目 SQLite + SegmentIR 形成双源真相；只取其方法要点，不整套安装。
2. **海量题材与提示词包**：21 类漫剧题材模板、284 个招式案例、`awesome-seedance` 类 prompt library。边际收益低，且随模型版本迭代失效。
3. **重外部运行时**：Blender MCP、ComfyUI、AutoDL、需登录的平台插件与付费聚合 CLI。会破坏本地轻量工作台定位。
4. **许可证不可接受**：CC BY-NC、CC BY-NC-ND、无许可证、代码混淆无法审计的项目，一律不纳入来源。CC BY-4.0 可用但必须在文档署名。

## 六、迭代路线图

| 迭代 | 模块 | 先决条件 | 交付形态 |
|---|---|---|---|
| **P0** | `drama-bible`、`script-doctor` | 本蓝图确认 | notes 读写工具（revision CAS）+ 2 份 `SKILL.md` + 各自验收测试；先定笔记与来源契约 |
| **P1** | `novel-deconstruct`、`asset-bible`、`shot-director` | P0 契约验证通过 | 3 份 `SKILL.md` + 来源字段与矩阵工具；道具状态提议只给提议不落库，沿用作者确认 |
| **P2** | `clip-qc` | P1 的成片证据读取方式定稳 | 1 份 `SKILL.md` + 取证工具；诊断只写 notes，不改视频 |

每个迭代都是独立 T2 变更：先 `hx-align` 确认该模块的 AC，再实现、验证、独立评审。后续迭代若需新增笔记字段，按 expand → migrate → contract 处理；旧笔记缺字段时按缺省值读取。

## 七、边界声明

本蓝图不实现任何模块，不新增数据库表、前端文件或 API 端点，不修改运行时代码。清单中的 `runtime_changes` 四个计数在本次交付中均为 0；工具名与错误码只是后续迭代必须遵守的契约。模块效果不由本次的结构测试证明，而由各迭代自己的验收标准覆盖。
