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
<!-- hx run appends a row here for each record it writes. Rows you add are notes, not evidence. -->

## Review

Severity is `blocking`, `should-fix`, `nit`, `question`, or `verdict`. A blocking finding needs a
disposition before `hx check` passes. A criterion whose Tests say `review` needs a row with `#` set
to its id, severity `verdict` and disposition `met`. When the table is final, register it with
`hx review --reviewer independent` (or `self`); that binds it to the current revision.

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
