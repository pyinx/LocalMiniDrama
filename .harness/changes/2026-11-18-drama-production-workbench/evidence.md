# Evidence

2026-11-18：用户确认工作台需求与分支开发，另明确了默认随包候选范围。阶段一的两部样例均经真实 HTTP、SQLite 和 FFmpeg 验证；原创故事的文字供应商响应和镜头视频为本地夹具。每部各两集，每集两镜，异库导入后重新合成，共解码检查八份成片。两部作品各自复用了一个跨集角色，恢复后核对角色参考图字节、人物 ID 和镜头绑定。

基线风险复现：对临时三集工程调用现有分集保存入口，只提交前两集。返回的项目中只剩两集，第三集已被软删除，其分镜记录仍在数据库中。小说导入界面的多集自动保存会进入这一行为。后续局部导入须与整批编辑分开验证。

This file is for people. `hx check` reads only the records in `records/`, which `hx run` and
`hx review` write. A row typed here never satisfies an acceptance criterion.

## Baseline

Recorded before the first change, so pre-existing failures cannot be blamed on this work.

| Check | Command | Result | Rev | At |
|---|---|---|---|---|
| test | `cd backend-node && node --test test/*.test.js && cd ../frontweb && node --test test/*.test.js` | pass | 16a32d4+2e943a251e4d529e | 2026-11-18T12:13:12Z |
| build | `cd frontweb && npm run build` | pass | 16a32d4+2e943a251e4d529e | 2026-11-18T12:14:07Z |

## Criteria

A criterion is met only when each key in its `Required commands` has a current, successful
`hx run <key> --ac <id>` record. Only the latest record for that AC/key counts; another key
cannot replace it. Test totals must show nothing failed, skipped, or left unrun unless deferred.

| AC | Criterion | Evidence | Source | Command | Result | Rev | At |
|---|---|---|---|---|---|---|---|
| AC1 | test:one | record 003 | cli | `node --test 'backend-node/test/workbench/multiProject.test.js'` | pass | 16a32d4+f667a32fcf9fc354 | 2026-11-18T12:19:36Z |
| AC1 | test:one | record 004 | cli | `node --test 'backend-node/test/workbench/multiProject.test.js'` | pass | cf8e72b+40a0265b327b8e93 | 2026-11-18T12:20:34Z |
| AC2 | test | record 005 | cli | `cd backend-node && node --test test/*.test.js && cd ../frontweb && node --test test/*.test.js` | pass | ff9bd8e+04023051707f22b7 | 2026-11-18T12:46:46Z |
| AC3 | test | record 006 | cli | `cd backend-node && node --test test/*.test.js && cd ../frontweb && node --test test/*.test.js` | pass | ff9bd8e+04023051707f22b7 | 2026-11-18T12:46:54Z |
| AC4 | test | record 007 | cli | `cd backend-node && node --test test/*.test.js && cd ../frontweb && node --test test/*.test.js` | pass | ff9bd8e+04023051707f22b7 | 2026-11-18T12:47:02Z |
| AC5 | test | record 008 | cli | `cd backend-node && node --test test/*.test.js && cd ../frontweb && node --test test/*.test.js` | pass | ff9bd8e+04023051707f22b7 | 2026-11-18T12:47:09Z |
| AC6 | test | record 009 | cli | `cd backend-node && node --test test/*.test.js && cd ../frontweb && node --test test/*.test.js` | pass | ff9bd8e+04023051707f22b7 | 2026-11-18T12:47:16Z |
| AC7 | test | record 010 | cli | `cd backend-node && node --test test/*.test.js && cd ../frontweb && node --test test/*.test.js` | pass | ff9bd8e+04023051707f22b7 | 2026-11-18T12:47:24Z |
| AC8 | test | record 011 | cli | `cd backend-node && node --test test/*.test.js && cd ../frontweb && node --test test/*.test.js` | pass | ff9bd8e+04023051707f22b7 | 2026-11-18T12:47:30Z |
| AC10 | test | record 012 | cli | `cd backend-node && node --test test/*.test.js && cd ../frontweb && node --test test/*.test.js` | pass | ff9bd8e+04023051707f22b7 | 2026-11-18T12:47:37Z |
| AC1 | test:one | record 013 | cli | `node --test 'backend-node/test/workbench/multiProject.test.js'` | pass | ff9bd8e+04023051707f22b7 | 2026-11-18T12:47:44Z |
| AC9 | build | record 014 | cli | `cd frontweb && npm run build` | pass | ff9bd8e+04023051707f22b7 | 2026-11-18T12:47:55Z |
| AC2 | test | record 016 | cli | `cd backend-node && node --test test/*.test.js && cd ../frontweb && node --test test/*.test.js` | pass | eb37316+399e26340223be93 | 2026-11-18T12:54:32Z |
| AC3 | test | record 017 | cli | `cd backend-node && node --test test/*.test.js && cd ../frontweb && node --test test/*.test.js` | pass | eb37316+399e26340223be93 | 2026-11-18T12:54:39Z |
| AC4 | test | record 018 | cli | `cd backend-node && node --test test/*.test.js && cd ../frontweb && node --test test/*.test.js` | pass | eb37316+399e26340223be93 | 2026-11-18T12:54:46Z |
| AC5 | test | record 019 | cli | `cd backend-node && node --test test/*.test.js && cd ../frontweb && node --test test/*.test.js` | pass | eb37316+399e26340223be93 | 2026-11-18T12:54:52Z |
| AC6 | test | record 020 | cli | `cd backend-node && node --test test/*.test.js && cd ../frontweb && node --test test/*.test.js` | pass | eb37316+399e26340223be93 | 2026-11-18T12:54:58Z |
| AC7 | test | record 021 | cli | `cd backend-node && node --test test/*.test.js && cd ../frontweb && node --test test/*.test.js` | pass | eb37316+399e26340223be93 | 2026-11-18T12:55:05Z |
| AC8 | test | record 022 | cli | `cd backend-node && node --test test/*.test.js && cd ../frontweb && node --test test/*.test.js` | pass | eb37316+399e26340223be93 | 2026-11-18T12:55:12Z |
| AC10 | test | record 023 | cli | `cd backend-node && node --test test/*.test.js && cd ../frontweb && node --test test/*.test.js` | pass | eb37316+399e26340223be93 | 2026-11-18T12:55:21Z |
| AC1 | test:one | record 024 | cli | `node --test 'backend-node/test/workbench/multiProject.test.js'` | pass | eb37316+399e26340223be93 | 2026-11-18T12:55:28Z |
| AC9 | build | record 025 | cli | `cd frontweb && npm run build` | pass | eb37316+399e26340223be93 | 2026-11-18T12:55:39Z |
| AC1 | test:one | record 028 | cli | `node --test 'backend-node/test/workbench/multiProject.test.js'` | pass | 53a8973+e8d925bd6ae91d89 | 2026-11-19T01:00:06Z |
| AC2 | test | record 029 | cli | `cd backend-node && node --test test/*.test.js && cd ../frontweb && node --test test/*.test.js` | pass | 53a8973+e8d925bd6ae91d89 | 2026-11-19T01:00:16Z |
| AC3 | test | record 030 | cli | `cd backend-node && node --test test/*.test.js && cd ../frontweb && node --test test/*.test.js` | pass | 53a8973+e8d925bd6ae91d89 | 2026-11-19T01:00:27Z |
| AC4 | test | record 031 | cli | `cd backend-node && node --test test/*.test.js && cd ../frontweb && node --test test/*.test.js` | pass | 53a8973+e8d925bd6ae91d89 | 2026-11-19T01:00:35Z |
| AC5 | test | record 032 | cli | `cd backend-node && node --test test/*.test.js && cd ../frontweb && node --test test/*.test.js` | pass | 53a8973+e8d925bd6ae91d89 | 2026-11-19T01:00:45Z |
| AC6 | test | record 033 | cli | `cd backend-node && node --test test/*.test.js && cd ../frontweb && node --test test/*.test.js` | pass | 53a8973+e8d925bd6ae91d89 | 2026-11-19T01:01:00Z |
| AC7 | test | record 034 | cli | `cd backend-node && node --test test/*.test.js && cd ../frontweb && node --test test/*.test.js` | pass | 53a8973+e8d925bd6ae91d89 | 2026-11-19T01:01:09Z |
| AC8 | test | record 035 | cli | `cd backend-node && node --test test/*.test.js && cd ../frontweb && node --test test/*.test.js` | pass | 53a8973+e8d925bd6ae91d89 | 2026-11-19T01:01:18Z |
| AC10 | test | record 036 | cli | `cd backend-node && node --test test/*.test.js && cd ../frontweb && node --test test/*.test.js` | pass | 53a8973+e8d925bd6ae91d89 | 2026-11-19T01:01:25Z |
| AC9 | build | record 037 | cli | `cd frontweb && npm run build` | pass | 53a8973+1b180489441eefdc | 2026-11-19T01:01:36Z |
| AC1 | test:one | record 038 | cli | `node --test 'backend-node/test/workbench/multiProject.test.js'` | pass | 53a8973+1b180489441eefdc | 2026-11-19T01:02:40Z |
| AC2 | test | record 039 | cli | `cd backend-node && node --test test/*.test.js && cd ../frontweb && node --test test/*.test.js` | pass | 53a8973+1b180489441eefdc | 2026-11-19T01:03:07Z |
| AC3 | test | record 040 | cli | `cd backend-node && node --test test/*.test.js && cd ../frontweb && node --test test/*.test.js` | pass | 53a8973+1b180489441eefdc | 2026-11-19T01:03:33Z |
| AC4 | test | record 041 | cli | `cd backend-node && node --test test/*.test.js && cd ../frontweb && node --test test/*.test.js` | pass | 53a8973+1b180489441eefdc | 2026-11-19T01:04:00Z |
| AC5 | test | record 042 | cli | `cd backend-node && node --test test/*.test.js && cd ../frontweb && node --test test/*.test.js` | pass | 53a8973+1b180489441eefdc | 2026-11-19T01:04:14Z |
| AC6 | test | record 043 | cli | `cd backend-node && node --test test/*.test.js && cd ../frontweb && node --test test/*.test.js` | pass | 53a8973+1b180489441eefdc | 2026-11-19T01:04:33Z |
| AC7 | test | record 044 | cli | `cd backend-node && node --test test/*.test.js && cd ../frontweb && node --test test/*.test.js` | pass | 53a8973+1b180489441eefdc | 2026-11-19T01:04:48Z |
| AC8 | test | record 045 | cli | `cd backend-node && node --test test/*.test.js && cd ../frontweb && node --test test/*.test.js` | pass | 53a8973+6238614a8fc94d89 | 2026-11-19T01:05:07Z |
| AC10 | test | record 046 | cli | `cd backend-node && node --test test/*.test.js && cd ../frontweb && node --test test/*.test.js` | pass | 53a8973+2f46c3543b55a51b | 2026-11-19T01:05:20Z |
| AC9 | build | record 047 | cli | `cd frontweb && npm run build` | pass | 53a8973+fad896970f24998a | 2026-11-19T01:05:45Z |
| AC1 | test:one | record 048 | cli | `node --test 'backend-node/test/workbench/multiProject.test.js'` | pass | 53a8973+6886a6f46ec52e7a | 2026-11-19T01:07:47Z |
| AC2 | test | record 049 | cli | `cd backend-node && node --test test/*.test.js && cd ../frontweb && node --test test/*.test.js` | pass | 53a8973+6886a6f46ec52e7a | 2026-11-19T01:08:39Z |
| AC3 | test | record 050 | cli | `cd backend-node && node --test test/*.test.js && cd ../frontweb && node --test test/*.test.js` | pass | 53a8973+6886a6f46ec52e7a | 2026-11-19T01:09:45Z |
| AC4 | test | record 051 | cli | `cd backend-node && node --test test/*.test.js && cd ../frontweb && node --test test/*.test.js` | pass | 53a8973+6886a6f46ec52e7a | 2026-11-19T01:10:35Z |
| AC5 | test | record 052 | cli | `cd backend-node && node --test test/*.test.js && cd ../frontweb && node --test test/*.test.js` | pass | 53a8973+6886a6f46ec52e7a | 2026-11-19T01:11:43Z |
| AC6 | test | record 053 | cli | `cd backend-node && node --test test/*.test.js && cd ../frontweb && node --test test/*.test.js` | pass | 53a8973+6886a6f46ec52e7a | 2026-11-19T01:12:42Z |
| AC7 | test | record 054 | cli | `cd backend-node && node --test test/*.test.js && cd ../frontweb && node --test test/*.test.js` | pass | 53a8973+6886a6f46ec52e7a | 2026-11-19T01:13:50Z |
| AC8 | test | record 055 | cli | `cd backend-node && node --test test/*.test.js && cd ../frontweb && node --test test/*.test.js` | pass | 53a8973+6886a6f46ec52e7a | 2026-11-19T01:14:43Z |
| AC10 | test | record 056 | cli | `cd backend-node && node --test test/*.test.js && cd ../frontweb && node --test test/*.test.js` | pass | 53a8973+6886a6f46ec52e7a | 2026-11-19T01:15:22Z |
| AC9 | build | record 057 | cli | `cd frontweb && npm run build` | pass | 53a8973+6886a6f46ec52e7a | 2026-11-19T01:16:10Z |
<!-- hx run appends a row here for each record it writes. Rows you add are notes, not evidence. -->

## Review

2026-11-19，按分支评审的 13 项发现逐项修复。复现数据来自临时数据库、实际 HTTP 接口、本地供应商、Chrome 和 FFmpeg。

| # | Finding | Severity | Disposition | Where |
|---|---|---|---|---|
| R1 | 整集重拆失败可导致原采用镜消失。 | blocking | 已修复。已有分镜时在完整生成后事务切换，保留采用、手动保留和已审镜头。覆盖上游失败与写入中途回滚。 | episodeStoryboardService.js、workbenchTake.test.js |
| R2 | 缺任务号的成功接单会被批次重发。 | blocking | 已修复。接单不明持久化为待核实，升级时恢复旧的可疑记录。真实 HTTP 适配器验证重开批次未增加 POST，明确拒单仍可补镜。 | videoClient.js、videoService.js、workbenchBatch.test.js |
| R3 | 隐藏的历史重复镜会阻断正式交付。 | blocking | 已修复。编辑、交付和复核共用有效镜序，旧工程实际合成通过。 | episodeStoryboardRows.js、workbenchTake.test.js |
| R4 | 分集刷新会播错采用版。 | blocking | 已修复。刷新接口返回统一采用结果，Chrome 验证晚到候选出现后仍播放原采用片。 | episodeStoryboardService.js、workbenchTake.test.js |
| R5 | 同一个旧片重复打包，意见被列为历史。 | blocking | 已修复。候选和旧片按统一媒体表示匹配，唯一匹配的 ZIP 只有一份候选。 | workbenchTakeService.js、workbenchTake.test.js |
| R6 | 只有旧视频地址的镜头无法按时间码审片。 | blocking | 已修复。作者可为当前旧片登记稳定候选，并发请求复用同一 ID。Chrome 实测记录意见、采用、重开及跨集查看。 | workbenchTakeService.js、TakeReviewDialog.vue、workbenchTake.test.js |
| R7 | 替换已锁定场景的参考图没有复核提示。 | blocking | 已修复。本地图片按内容核对，纯远程引用按 URL 核对，旧文字锁遇到参考图时提示复核。覆盖异库导入重新命名。 | workbenchContinuity.js、workbenchArchiveIdentity.test.js |
| R8 | 跨作品重复样片可能被计作两个独立胜例。 | blocking | 已修复。使用单条最终样片的哈希识别跨作品复用，将相关配对全部标为待测。盲评夹具覆盖各自使用不同基线的情形。 | quality-study.cjs、workbenchQualityStudy.test.js |
| R9 | 通过素材库绑定的三人镜误选双人对白方法。 | blocking | 已修复。复核面板、生成与助手共用有效演员名单，三人群像回归通过。 | workbenchCreativeMethods.js、workbenchCreativeMethods.test.js |
| R10 | 括号内的章节副标题混入正文。 | blocking | 已修复。完整解析标题边界，源文追溯与实际浏览器采用均核对原文。 | novelImportService.js、novelSourceCoverage.test.js |
| R11 | 作者无法修正部分导入的集号。 | should-fix | 已修复。预填正式集号，可改选、核对现稿并拦截重复目标。Chrome 验证将第十集改投第十三集且保留原第一集。 | NovelImportDialog.vue、novelSourceCoverage.test.js |
| R12 | 实际竖屏、横向编码的合法视频无法交付。 | blocking | 已修复。按旋转与像素宽高比检查显示画幅，混合布局逐段归一。FFmpeg 测试核对输入、输出与逐段构图。 | videoMergeService.js、workbenchDelivery.test.js |
| R13 | 大章能预览但采用请求超限。 | blocking | 已修复。采用复用原文件，单独传选集与分段改编，服务端生成最终剧本。5.4 MB 单章走真实 HTTP/SQLite 成功。 | novelSelection.js、novelImportService.js、novelSourceCoverage.test.js |
| R14 | 尾帧写入会覆盖下一镜保存在 local_path 的唯一旧片引用。 | blocking | 已修复。成功提取后在一次事务中保留旧片并绑定首帧，失败时清理临时帧。 | tailFrameLinkService.js、storyboardFrameBinding.js |
| R15 | 有片无候选的旧镜被列为待制作，批量与一键修复可能实际重拍。 | blocking | 已修复。导航、补镜、连帧派发及服务端按镜头的有效视频判定。请求持有过期批次快照时，服务端也复用旧片。 | FilmCreate.vue、workbenchVideoBatch.js、workbenchBatch.test.js |
| R16 | 尾帧衔接与助手上下文会选中已被同号新行替代的历史镜。 | blocking | 已修复。尾帧按有效镜序找相邻镜，助手按同一规则给出镜头列表。 | tailFrameLinkService.js、tools.mjs、workbenchTake.test.js |
| AC1 | 独立复跑两个双集作品，源库及异库的交付画幅与镜序一致。 | verdict | met | workbench/multiProject.test.js |
| AC2 | 章节边界、超大单章、选集与目标映射覆盖通过。Chrome 采用核对后仅目标集被写入。 | verdict | met | novelSourceCoverage.test.js、NovelImportDialog.vue |
| AC3 | 按实际图片内容核对引用，跨库迁移和阶段造型、对白锁回归通过。 | verdict | met | workbenchArchiveIdentity.test.js、workbenchContinuity.test.js |
| AC4 | 自动创作方法共用有效演员，重复镜号的助手与编辑器均给出可见镜序。 | verdict | met | workbenchCreativeMethods.test.js、workbenchTake.test.js |
| AC5 | 正式采用、旧片归档、刷新、重拆、尾帧衔接与异库往返通过。 | verdict | met | workbenchTake.test.js |
| AC6 | 真实浏览器为无候选旧片留评，重开和衔接后仍可定位相同媒体。 | verdict | met | workbenchReview.test.js、workbenchTake.test.js、Chrome |
| AC7 | 正式交付依据实际显示画幅，覆盖重复镜号、旋转、混剪及交付失败时保留上次成片。 | verdict | met | workbenchDelivery.test.js、workbenchTake.test.js |
| AC8 | 模拟供应商验证接单不明只提交一次。已有旧片时重开、派发和过期快照均新增零次出站。 | verdict | met | workbenchBatch.test.js、workbenchBatchVideo.test.js |
| AC9 | 独立 Chrome 复核旧片可播放、审片入口及导航完成状态。从项目页重开仍显示完成。 | verdict | met | FilmCreate.vue、CreativeReviewPanel.vue、Chrome |
| AC10 | 盲评、费用、弃片和独立样本门槛通过。同片复用保持待测。真实作品质量与默认启用的决定仍需实拍及真人盲评。 | verdict | met | workbenchQualityStudy.test.js |

## 2026-11-19 修复前的独立评审

Severity is `blocking`, `should-fix`, `nit`, `question`, or `verdict`. A blocking finding needs a
disposition before `hx check` passes. A criterion whose Tests say `review` needs a row with `#` set
to its id, severity `verdict` and disposition `met`. When the table is final, register it with
`hx review --reviewer independent` (or `self`); that binds it to the current revision.

2026-11-19，审阅提交 `53a8973` 相对 `main@16a32d4` 的变更。独立审阅使用新上下文，按验收条件和工程行为双轴检查。另以临时数据库核实旧工程及失败恢复。下列 blocking 的处置栏留空，表示缺陷仍可复现。本轮只登记发现。

| # | Finding | Severity | Disposition | Where |
|---|---|---|---|---|
| R1 | 整集重新拆镜先软删除旧镜。临时库里已采用并留评的候选 #11 在文本服务失败后从工作台和导出清单消失。建议先暂存新镜，成功后再原子切换；有采用或意见的历史镜应可回看。 | blocking | | backend-node/src/services/episodeStoryboardService.js:895 |
| R2 | 供应商接单后返回成功响应但缺少任务号，适配器的错误文案被当作确定失败。一次单镜提交再批量补镜，模拟供应商实际收到两次 POST。建议让适配器返回可区分的接单结果，未知状态只允许核查或显式重拍。 | blocking | | backend-node/src/services/videoService.js:575 |
| R3 | 旧库同镜号两行时，编辑器只显示较新行，交付与复核却遍历两行。有效行有采用片仍会因隐藏旧行缺片被拒。应共享宿主的有效镜序查询。 | blocking | | backend-node/src/services/dramaService.js:763 |
| R4 | 分集镜头列表直接返回原始 video_url，刷新时覆盖带采用信息的镜头。项目详情看到已采用 A，刷新列表后可能播放最新 B。应在分集查询复用采用结果序列化。 | blocking | | backend-node/src/services/episodeStoryboardService.js:236 |
| R5 | 两边同为 /static/ 路径、能唯一对应一条旧生成记录时，该记录仍被当作无身份旧片。实测同一候选写进 ZIP 两次，当前片未结意见被归到历史。应先统一路径表示，再判唯一性。 | blocking | | backend-node/src/services/workbenchTakeService.js:41 |
| R6 | 旧镜只有镜头视频、没有生成记录时能播放，但审片按钮隐藏，当前片也没有能关联意见的候选 ID。应在首次采用或审片时复用或建立稳定身份，并开放入口。 | blocking | | frontweb/src/views/FilmCreate.vue:1512 |
| R7 | 锁定外观后，只换被引用的场景主图并保持原提示词，受影响镜头依旧显示已确认。应把实际绑定图的可迁移身份纳入外观快照。 | blocking | | backend-node/src/services/workbenchContinuity.js:68 |
| R8 | 盲评独立性按整对样片哈希判断。两部作品复用同一方法组视频、各配不同基线，可通过独立获益门槛。应按单个样片检查跨作品复用，并把受影响组标记待核。 | blocking | | tools/quality-study.cjs:405 |
| R9 | 仅通过素材库关联三名演员的旧镜，复核能列出三人，自动创作方法仍选双人对白。应将有效演员名单传给场景判断。 | blocking | | backend-node/src/services/workbenchCreativeMethods.js:30 |
| R10 | 章节标题“【第一章 暗灯】”被拆开，副标题和右括号出现在改编原文里。应解析完整括号边界再计算正文范围。 | blocking | | backend-node/src/services/novelImportService.js:22 |
| R11 | 单独导入定稿的第九、十集时，导入对话框固定将两集映射到项目第 1、2 集。界面展示目标且需勾选，但无法选择实际目标。建议让作者在预览里核对并改目标集号。 | should-fix | 待处理 | frontweb/src/components/NovelImportDialog.vue:139 |
| R12 | 实际显示为竖屏的 MP4 可用横向编码尺寸及 90° 旋转矩阵保存。画幅检查只读取编码宽高，导致合法竖屏素材无法正式交付。建议按旋转与像素宽高比计算显示画幅，并用同一口径核对输出。 | blocking | | backend-node/src/services/videoMergeService.js:225 |
| R13 | 5.4 MB 单章能预览，采用时重复发送原文及相同剧本，10,827,812 字节的 JSON 超过 10 MiB 上限。该章单独提交仍失败。建议传一次原文并由服务端组装剧本，或通过暂存章节标识采用，核对预览与采用的大小契约。 | blocking | | frontweb/src/components/NovelImportDialog.vue:140 |
| AC1 | 本次独立复跑两部双集作品的回归，临时数据库与实际 FFmpeg 交付的两例通过。 | verdict | met | backend-node/test/workbench/multiProject.test.js |
| AC2 | 带括号副标题的章节丢失标题边界，大单章预览成功后无法采用。 | verdict | not met | R10、R13 |
| AC3 | 锁定外观后更换场景图，没有提示作者复核受影响的镜头。 | verdict | not met | R7 |
| AC4 | 关联演员表包含三人的旧镜仍自动选择双人对白方法。 | verdict | not met | R9 |
| AC5 | 刷新分集、重新拆镜失败及旧路径匹配均可能丢失当前采用片的身份。 | verdict | not met | R1、R4、R5 |
| AC6 | 部分旧镜无法添加时间码意见，或把当前片意见列作历史意见。 | verdict | not met | R5、R6 |
| AC7 | 隐藏的重复镜行和合法旋转竖屏素材都能阻止正式交付。 | verdict | not met | R3、R12 |
| AC8 | 供应商可能已接单但未返回任务号时，批量补镜会再次提交同一镜。 | verdict | not met | R2 |
| AC9 | 分集刷新、旧镜审片和重复镜数据使工作台的播放或复核状态与有效镜头不一致。 | verdict | not met | R3、R4、R5、R6 |
| AC10 | 同一方法组样片跨两部作品复用仍通过盲评独立性检查，不能据此判断质量提升。 | verdict | not met | R8 |

## 2026-11-18 的验收记录

以下是当时的复核结论，保留当时的证据范围与时间顺序。

| # | Finding | Severity | Disposition | Where |
|---|---|---|---|---|
| AC1 | 两部双集作品从两个数据库走正式交付，八份成片的尺寸与镜序通过逐帧断言。 | verdict | met | workbench/multiProject.test.js |
| AC2 | 短返回和纯文本回复保存为待采用拟稿。选章、逐集采用及并发保护均走实际业务入口。 | verdict | met | novelSourceCoverage.test.js |
| AC3 | 角色名单、阶段外观和同名同时间地点的独立场景可跨库恢复。 | verdict | met | workbenchArchiveIdentity.test.js |
| AC4 | 四类镜头的创作方法、可选开关及人工放行通过。 | verdict | met | workbenchCreativeMethods.test.js |
| AC5 | 导出和连帧读取采用片。跨过已完成镜头时正确使用紧邻上镜的尾帧。 | verdict | met | workbenchTake.test.js、FilmCreate.vue |
| AC6 | 时间码与原片绑定，改稿可写回当前镜的对白和旁白。 | verdict | met | workbenchReview.test.js、FilmCreate.vue |
| AC7 | 缺片或后期失败保留上次正式成片。草稿带交付设置，能够降级并返回具体警告。 | verdict | met | workbenchDelivery.test.js |
| AC8 | 单镜和批量交错时，重开与真正派发均复核历史任务。重复请求没有增加供应商接单数。 | verdict | met | workbenchBatch.test.js |
| AC9 | 项目、分集、分镜显示待复核位置，当前与历史片可定位播放。缺失本地文件、远端引用分别显示。 | verdict | met | workbenchReview.test.js、CreativeReviewPanel.vue |
| AC10 | 粗剪、费用、返修和双人盲评工具已核验，未试拍和同文件误配保持待测。真实作品的观感改善仍待试拍。 | verdict | met | workbenchQualityStudy.test.js、docs/quality-study.md |

## Deferred

What this change did not do, and the number it maps to in the spec's `Deferred` table. A deferral
the user did not agree to is not a deferral; say so here.

| # | Item | Reported to user |
|---|---|---|
| | | |

## Residual risks

真实生成的自然度、首发可用率和单位可用镜成本尚待试拍与双人盲评。创作方法按项目启用，默认关闭。模型能力表、分镜 IR、逐句声音和资产变体仍按即梦质量链的分工对接。

2026-11-18 使用临时副本叠加了主工作树当时的在途源码与测试。两处同名文档内容一致，共同修改的 episodeStoryboardService.js 可三方自动合并。合并演练通过后端 185 项（含两部作品正式交付）和前端 32 项。主工作树的后续提交需按同一组用例再行核对。

实际 Chromium 验证了选章后只更新第二集、重开改编原文、核对并采用 AI 拟稿、在当前片与历史片之间按时间码切换、从审片修改对白和旁白，以及跨过已完成镜头时取得紧邻前镜的已采用尾帧。两部双集夹具使用临时库与合成视频，八份成片逐帧验证。将 FFmpeg 与 ffprobe 的路径切换为安装包内的版本后，草稿 / 正式交付及两部作品的异库往返仍通过。

## 2026-11-19 并行分支兼容性

将本次产品代码和 `feat/jimeng-quality-chain@bafc01b` 交给 Git 生成临时合并树。两边无需处理文本冲突。在合并树的独立目录执行 196 项后端测试（含两个双集作品往返）、32 项前端测试及 Vite 构建，全部通过。两个开发分支及主分支继续独立。

## 2026-11-19 macOS 安装包

桌面版本 1.2.9，构建号 1.2.11。两个 Lite DMG 均通过映像校验、只读挂载、架构与版本检查、应用深度签名校验。比对了包内后端实现、前端入口及脚本与工作树的构建结果。在各自挂载卷里运行实际 Electron 44.8.0，以临时数据库验证 API、工作台、小说选集采用、SQLite、Sharp 和随包 FFmpeg 编解码。Intel 包在 Rosetta 上验证。两包使用本地 ad-hoc 签名，未做 Apple 公证。

| 架构 | desktop/release 下的文件 | SHA-256 |
|---|---|---|
| Apple Silicon | LocalMiniDrama-Lite-1.2.9-build-1.2.11-mac-arm64.dmg | `6f4b2b599117cf7ea5e885533fcc9b1c6d15d3a57bb2cf3503e09a50b1f1e448` |
| Intel | LocalMiniDrama-Lite-1.2.9-build-1.2.11-mac-x64.dmg | `f1ebd8fab62c7412fe1b694a700b3e72cd1f462a3682459d0558591c6f9098d9` |

## 2026-11-18 macOS 安装包历史记录

桌面版本 1.2.9，构建号 1.2.10。两个 Lite DMG 均通过磁盘映像校验、只读挂载和应用深度签名校验。在各自挂载卷内运行 Electron 44.8.0，加载 SQLite、Sharp 与助手依赖，使用独立临时数据库读取工作台、选择性采用小说章节，并用随包工具编解码 H.264。Intel 在 Apple Silicon 的 Rosetta 环境中验证。使用本地 ad-hoc 签名；Apple 公证未执行。Lite 省略示例工程。

| 架构 | desktop/release 下的文件 | SHA-256 |
|---|---|---|
| Apple Silicon | LocalMiniDrama-Lite-1.2.9-build-1.2.10-mac-arm64.dmg | `0bf30f080b7836e7a8ba2239c5723e043c6ea9ac59fa937f1979f9c160255631` |
| Intel | LocalMiniDrama-Lite-1.2.9-build-1.2.10-mac-x64.dmg | `abf3b33a31832e1f80d0b1a8eab8e769eb272dc2a2698400388b73a733b7cf3b` |
