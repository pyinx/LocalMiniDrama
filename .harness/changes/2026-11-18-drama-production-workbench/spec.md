---
tier: T2
language: zh
slug: 2026-11-18-drama-production-workbench
---

# 全流程短剧工作台

## Intent

创作者在一个项目内完成多集短剧，能按镜采用生成结果，审片后局部返工，并在另一台机器继续制作。通用性由不同题材、画风和起点的作品检验。已确认的产品范围见[工作台方案](../../../docs/plans/2026-11-18-quality-porting-plan.md)。

## Scope

贯通创作入口、资产与分镜、候选采用、声音与成片、跨集审阅与恢复。借用外部项目的编剧、资产、导演和审阅方法，在宿主的能力表、分镜 IR 与现有服务上实现。分三次交付完整制作路径、创作质量、连续生产稳定性。各批形成独立提交。

## Non-goals

即梦质量链拥有分镜 IR、编译、场内连续性、逐句配音、资产变体和工程包的基础映射。供应商运行时、第二套画布和独立的风格库不在本变更范围内。素材夹具只用于功能验证。

## Deferred

| # | Item | Why deferred | Unblocks when |
|---|---|---|---|
| | | | |

## Facts

| 已核对的行为 | 证据 |
|---|---|
| 独立工作树从 `main@16a32d4` 分出。原工作树的在途实现没有包含在基线里。 | `git worktree list`、`git merge-base` |
| 章节摘要发送章首最多 2000 个 JS 字符，生成失败会返回章首 500 字。规则识别出的很短章节也可能被省略。 | `backend-node/src/services/novelImportService.js` |
| 现有导入弹窗在已有项目导入两章以上时可直接保存。保存接口将这次没有提交的集号软删除。 | `frontweb/src/views/FilmCreate.vue#onImportNovel`、`dramaService.saveEpisodes` |
| 镜头视频可来自分镜字段或生成记录，合成取片与工程包取片各有查询。合成允许跳过缺片；当前端到端用例覆盖每镜一个候选、媒体齐全的路径。 | `dramaService.getVideoUrlForStoryboard`、`dramaExportService`、`videoMergeService`、`test/workbench/multiProject.test.js` |
| 源码基线可运行后端及前端单测、Vite 构建。两套独立 SQLite 使用实际迁移，端到端测试调用真实路由、ZIP 导入和 FFmpeg。 | 本变更的 `records/` |

## Decisions

| # | 用户决定 | 日期 |
|---|---|---|
| D1 | 按整部短剧建设通用稳定工作台，既往单集为回归参考。已确认上一轮完整的产品方案。 | 2026-11-18 |
| D2 | 独立分支开发，后续再合并主分支。 | 2026-11-18 |
| D3 | 工程包默认携带采用片、审片记录引用及手动保留的候选，其余成功候选可在导出时勾选。 | 2026-11-18 |

## Assumptions

| # | 工程假设 | 假设变化时的处理 |
|---|---|---|
| A1 | 低成本验证可用本地文字响应和合成素材代替云端结果。 | 接口、数据和媒体可验证；自然度与首发可用率另做同条件真实试拍和盲评。 |
| A2 | 并行变更的对接点可能随实现调整。 | 以已合入和验收过的实现为准，移植提交单独重放；同一字段保留一个维护方。 |

## Open questions

无未决的产品目标。分批执行的接口设计见下。

## Acceptance criteria

| # | Criterion | How it is verified | Required commands | Tests |
|---|---|---|---|---|
| AC1 | 一部原创竖屏双集作品、一部小说改编横屏双集作品，通过真实 API 与 FFmpeg 做成逐集视频；导入 ID 不同的新库后剧本文本与镜序保持，能再次生成同尺寸同顺序的成片。 | 逐帧解码源库及目标库的成片；断言剧本、分集与分镜归属。 | `test:one` | `backend-node/test/workbench/multiProject.test.js::最后一碗 preserves two episode cuts across archive import`、`backend-node/test/workbench/multiProject.test.js::借潮灯 preserves two episode cuts across archive import` |
| AC2 | 创作者可从创意、小说、定稿剧本及原工程接续；长文可检查处理范围、失败章节与原文，已有剧本的改动可由作者采用。 | 真实导入、原文追溯、短章/长章与失败恢复；复查采用前后未选择的集。 | `test` | `backend-node/test/novelSourceCoverage.test.js::reports complete partial and failed coverage`、`backend-node/test/novelSourceCoverage.test.js::preserves unselected episodes and their bindings` |
| AC3 | 改换本集造型或场景状态只提示实际受影响的引用。项目事实、用户锁定的对白和外观能跨集复核。 | 两集共用角色和道具，第二集只换造型，核对上一集已采用片。 | `test` | `backend-node/test/workbenchContinuity.test.js::scopes changes to referencing episodes` |
| AC4 | 常用按钮、画布与助手共用按任务选取的创作方法；在写实对话、动画动作、无对白停顿或群像镜头中可得到符合该任务的检查，并可人工放行。 | 核对方法版本与执行入口，再用不同作品审查导演建议是否贴合作品。 | `test` | `backend-node/test/workbenchCreativeMethods.test.js::uses the same methods across entry points` |
| AC5 | 某镜采用 A 之后 B 迟到，详情、连帧、成片与工程包均继续采用 A。默认包包含采用、被审片引用、手动保留三类候选的并集；其他成功候选仅在勾选时加入。同一候选只出现一次。异库恢复后可重新采用包内候选，并发采用有可见冲突。 | 分别导出默认包与多选包，核对媒体哈希、审片引用和采用关系；在异库修改采用后再成片。 | `test` | `backend-node/test/workbenchTake.test.js::keeps the adopted take across consumers and restore`、`backend-node/test/workbenchTake.test.js::archives the selected candidate set once`、`backend-node/test/workbenchTake.test.js::rejects stale selections and foreign takes` |
| AC6 | 作者可按集、段和时间码记录真实媒体问题，选择改稿、换候选或重拍一段。旧媒体与审片意见可回看。 | 更换有问题的一段，检查另一段及前一集的媒体、任务数保持。 | `test` | `backend-node/test/workbenchReview.test.js::keeps notes on the reviewed take after a reshoot` |
| AC7 | 正式交付发现缺镜、坏片、失败的必需音轨或字幕时指出项目和镜号，保留上次可交付成片。草稿预览提示缺项。 | FFmpeg 解码出错、缺失输入、冻结期间切换采用等故障注入。 | `test` | `backend-node/test/workbenchDelivery.test.js::preserves the last release on incomplete media` |
| AC8 | 重复提交、关页重开、重启、取消后能逐项恢复；厂商是否已接单不可判定时可核查，自动出站数不会翻倍。 | 本地供应商计请求次数并模拟丢应答；统计任务和已完成片。 | `test` | `backend-node/test/workbenchBatch.test.js::recovers without repeating uncertain dispatches` |
| AC9 | 用户可在项目、分集和镜头打开同一作品，看到进度、缺项、当前采用及待复核段，普通供应商和旧工程均可用。 | 真实 UI 走旧工程、无 CLI、错误重试、回退再打开。 | `build` | review |
| AC10 | 质量方法按独立作品比较首发可用率、单可用段提交数、生成成本与人工返修时间；有画风、表演、动作和对白的盲评记录才能判断默认启用。 | 预先记录同条件实拍组合；账目计入失败与弃用。未实拍时明确待测。 | `test` | review |

## Design

### Options considered

保留现有工程格式和前后端，逐批扩展原服务。新建一套导演运行时或另起资产库会产生两套剧本或镜头来源。只在提示词附加导演建议能改善文案，但无法解决新片覆盖采用、缺镜交付或恢复时重复付费。

### Interfaces and data

- **小说改编与导入。** 保留原先的导入响应字段，补充各章已读取的范围、总长度及原文/改编/失败状态。导入预览明确新增集、拟更新集和现有分镜数。作者显式选择的集才能写入。已有的整批 `saveEpisodes` 继续承担原来“删除未提交集”的编辑行为；局部导入需使用保留其他集的事务写入路径。长章分批时先展示待处理量，失败保留全文与成功批次。
- **采用与交付。** 分镜持有经验证的采用记录 ID。采用校验分镜归属、状态和更新版本，生成完成回调只产出候选。旧片按已有读取规则查询，歧义显式提示。工程包从采用记录、审片记录、手动保留标志和本次额外勾选派生候选集合，逐项验证归属并按候选 ID 去重。必需媒体丢失须明示。通过 T15 的 ID 映射在新库恢复采用、保留和审片引用。交付冻结镜序、采用记录及声音配置，以完整校验通过的临时产物更新发布记录。
- **审片与恢复。** 审阅记录关联生成记录 ID、媒体时间码和制作者的处理状态；换候选保留原意见的归属。批次记录待派发项和外部任务 ID。进程重启后先查既有任务。无法判定提交结果的项等待用户核实，作者主动重拍是一次新操作。
- **创作能力与依赖。** 普通业务按钮和 Mastra 助手读取同份原创创作方法，按任务组合。新分镜只经并行任务的 IR 编辑；跨集复核消费每集连续性表，声音、模型编译和变体导入分别消费对方已验收的契约。

### Reuse

已查 `novelImportService`、`storyGenerationService`、`dramaService`、`storyboardService`、`dramaExportService`、`dramaImportService`、`taskService`、`videoMergeService`、画布批量执行器及 `test/helpers`。原测试数据库为助手工具裁剪了 schema；跨集验收直接跑项目原有迁移。分镜采用和审片意见属于尚未被生成状态表达的用户选择，单独持久化；进度从已有产物派生。

### Tasks

| # | 开发顺序 | 接入位置 | 验证 |
|---|---|---|---|
| T1 | 建立两部多集作品可重复执行的基线 | `backend-node/test/workbench/multiProject.test.js` | AC1；无外部计费 |
| T2 | 创作入口与长文覆盖，已有分集的差异预览和选中采用 | 现有小说导入服务、剧本分集服务、FilmCreate 导入区域 | AC2 |
| T3 | 跨集资产与事实，按任务分配编剧、资产、导演方法 | 既有剧本/画风/资产服务、Mastra 技能读取、既有工作区 | AC3、AC4；等 T4/T8/T9 对接点落地后验证 IR 编辑 |
| T4 | 候选采用、审片、时间码、局部重做 | 分镜、生成结果、FilmCreate、DramaCanvas、工程包映射 | AC5、AC6；往返部分对接质量链 T15 |
| T5 | 预览与正式交付、批量任务恢复、全剧状态 | 分集合成、任务服务、列表与工作区 | AC7–AC9；后期复用质量链 T13/T14 |
| T6 | 真实作品质量比较与发布验证 | 试拍记录、盲评、现有构建与桌面打包 | AC10、完整回归，发布应用改动时分别验证两架构 DMG |

## Related

[已确认的建设方案](../../../docs/plans/2026-11-18-quality-porting-plan.md) · [项目目标](../../memory/pages/short-drama-workbench-goal.md)。并行变更为 `2026-11-18-jimeng-quality-chain`，验收时对照其实际合入版本。
