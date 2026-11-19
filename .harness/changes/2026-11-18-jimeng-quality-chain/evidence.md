# Evidence

This file is for people. `hx check` reads only the records in `records/`, which `hx run` and
`hx review` write. A row typed here never satisfies an acceptance criterion.

## Gates

- Gate 1（需求）：2026-11-18 用户在对话中对需求摘要选择「确认」，同一回答中允许即梦免费路径实测（D8）。确认后据 D8 补入 AC20（直接对应该回答，未改动其他条目），已在下一条消息中告知用户；用户随后回复「确认」，AC20 获得明确同意。
- 需求变更（restate）：2026-11-18 用户明确要求「把 Wan 这两个 bug 也加进验收标准」→ 新增 AC21、AC22，Facts 与 Scope 第 1 项同步更新，Decisions 记为 D9。
- 方案复查：两个独立评审代理因 API 限额（429）中断，由作者本人复查（非独立）。发现 R1–R6、C1–C6；用户决定 D10–D13，新增 AC23–AC33，修改 AC7/AC15/AC20，设计与任务重排。待用户重新确认整份 spec 后 `hx confirm --restate`。额度恢复后需在全新上下文重跑独立评审。
- 第二轮独立评审（两个全新上下文代理，从中断处续跑）：准确性 10 条（2 阻断）、完整性 20 条（1 阻断）；全部并入 spec（D14，AC34–AC40，多条 AC 扩展）；角色设定图版式、防抄袭阈值待用户决定。
- 整份 spec 确认：2026-11-18 用户选择推荐版式与 15 字阈值（D15）、登录过期判未通过（D16），并选择「确认，开始实现」。
- 2026-11-19 用户同意 AC18 测试名由 `::no 40-char overlap` 改为 `::no 15-char overlap`（另加检测器自检用例），与 D15 阈值一致；已 `hx confirm --restate`。这两项选择写入后执行 `hx confirm --restate`（需求在 gate 1 之后有变更，用户已逐轮同意）。

## Incidents

- 2026-11-19 单元测试副作用（已修复、已清理）：jimengNovelRenderer 单测的 afterEach 把 runner 复位为 null（= 真实 CLI），用例里路由起的后台提交/轮询在复位后落到真实 jimeng-novel，
  在用户即梦账号上建了 4 个名为「测试剧」的空画布，并在 backend-node/data/storage/jimeng/drama_1 写了绑定目录。
  核查：4 个画布节点数均为 0；绑定项目 credit get 显示 deductedTotal 0、runs 0；余额前后均为 181——未提交任何生成、未扣费。
  处理：逐个确认名称与 0 节点后删除 4 个画布（D8 授权范围内）、删除本地绑定目录；renderer 在 node 测试进程中（NODE_TEST_CONTEXT）除 JIMENG_LIVE=1 外一律拒绝真实 CLI；
  单测 afterEach 改为复位成拒绝型 runner；全量 265 个测试前后对比画布列表无新增。
- 2026-11-19 实测发现契约偏差：`jimeng-novel status -j` 输出裸对象而非 {status,data,error} 信封（能力报告的推断有误）；CLI 端口改为退出码 0 时接受裸对象并补单测。

## Baseline

Recorded before the first change, so pre-existing failures cannot be blamed on this work.

| Check | Command | Result | Rev | At |
|---|---|---|---|---|
| test | `cd backend-node && node --test test/*.test.js && cd ../frontweb && node --test test/*.test.js` | pass | 16a32d4+146d86f6f9e24528 | 2026-11-18T07:11:21Z |

## Criteria

A criterion is met only when each key in its `Required commands` has a current, successful
`hx run <key> --ac <id>` record. Only the latest record for that AC/key counts; another key
cannot replace it. Test totals must show nothing failed, skipped, or left unrun unless deferred.

| AC | Criterion | Evidence | Source | Command | Result | Rev | At |
|---|---|---|---|---|---|---|---|
| AC1 | test | record 002 | cli | `cd backend-node && node --test test/*.test.js && cd ../frontweb && node --test test/*.test.js` | pass | 16a32d4+a72fdbc800b8ae19 | 2026-11-18T12:22:21Z |
| AC2 | test | record 003 | cli | `cd backend-node && node --test test/*.test.js && cd ../frontweb && node --test test/*.test.js` | pass | 16a32d4+a72fdbc800b8ae19 | 2026-11-18T12:22:40Z |
| AC21 | test | record 004 | cli | `cd backend-node && node --test test/*.test.js && cd ../frontweb && node --test test/*.test.js` | pass | 16a32d4+a72fdbc800b8ae19 | 2026-11-18T12:22:46Z |
| AC22 | test | record 005 | cli | `cd backend-node && node --test test/*.test.js && cd ../frontweb && node --test test/*.test.js` | pass | 16a32d4+a72fdbc800b8ae19 | 2026-11-18T12:22:51Z |
| AC4 | test | record 006 | cli | `cd backend-node && node --test test/*.test.js && cd ../frontweb && node --test test/*.test.js` | pass | 16a32d4+79333efad95b7031 | 2026-11-18T12:34:15Z |
| AC18 | test | record 007 | cli | `cd backend-node && node --test test/*.test.js && cd ../frontweb && node --test test/*.test.js` | pass | 16a32d4+bd851e980f45905c | 2026-11-19T00:39:01Z |
| AC23 | test | record 008 | cli | `cd backend-node && node --test test/*.test.js && cd ../frontweb && node --test test/*.test.js` | pass | bafc01b+835c8cbaf6859e05 | 2026-11-19T00:53:50Z |
| AC33 | test | record 009 | cli | `cd backend-node && node --test test/*.test.js && cd ../frontweb && node --test test/*.test.js` | pass | bafc01b+835c8cbaf6859e05 | 2026-11-19T00:53:54Z |
| AC40 | test | record 010 | cli | `cd backend-node && node --test test/*.test.js && cd ../frontweb && node --test test/*.test.js` | pass | bafc01b+835c8cbaf6859e05 | 2026-11-19T00:54:01Z |
| AC3 | test | record 011 | cli | `cd backend-node && node --test test/*.test.js && cd ../frontweb && node --test test/*.test.js` | pass | afcd9e3+6f4ef4b3b501ffeb | 2026-11-19T01:14:18Z |
| AC6 | test | record 012 | cli | `cd backend-node && node --test test/*.test.js && cd ../frontweb && node --test test/*.test.js` | pass | afcd9e3+6f4ef4b3b501ffeb | 2026-11-19T01:14:31Z |
| AC36 | test | record 013 | cli | `cd backend-node && node --test test/*.test.js && cd ../frontweb && node --test test/*.test.js` | pass | afcd9e3+6f4ef4b3b501ffeb | 2026-11-19T01:14:42Z |
| AC7 | test | record 014 | cli | `cd backend-node && node --test test/*.test.js && cd ../frontweb && node --test test/*.test.js` | pass | 4781cd1+f19da3d2803366b5 | 2026-11-19T01:19:21Z |
| AC8 | test | record 015 | cli | `cd backend-node && node --test test/*.test.js && cd ../frontweb && node --test test/*.test.js` | pass | 4781cd1+f19da3d2803366b5 | 2026-11-19T01:19:30Z |
| AC26 | test | record 016 | cli | `cd backend-node && node --test test/*.test.js && cd ../frontweb && node --test test/*.test.js` | pass | 4781cd1+f19da3d2803366b5 | 2026-11-19T01:19:38Z |
| AC35 | test | record 017 | cli | `cd backend-node && node --test test/*.test.js && cd ../frontweb && node --test test/*.test.js` | pass | 4781cd1+f19da3d2803366b5 | 2026-11-19T01:19:47Z |
| AC38 | test | record 018 | cli | `cd backend-node && node --test test/*.test.js && cd ../frontweb && node --test test/*.test.js` | pass | 4781cd1+f19da3d2803366b5 | 2026-11-19T01:19:59Z |
| AC39 | test | record 019 | cli | `cd backend-node && node --test test/*.test.js && cd ../frontweb && node --test test/*.test.js` | pass | 4781cd1+f19da3d2803366b5 | 2026-11-19T01:20:19Z |
| AC9 | test | record 020 | cli | `cd backend-node && node --test test/*.test.js && cd ../frontweb && node --test test/*.test.js` | pass | ca4f056+8d011de4cf680157 | 2026-11-19T01:22:22Z |
| AC28 | test | record 021 | cli | `cd backend-node && node --test test/*.test.js && cd ../frontweb && node --test test/*.test.js` | pass | ca4f056+8d011de4cf680157 | 2026-11-19T01:22:32Z |
| AC37 | test | record 022 | cli | `cd backend-node && node --test test/*.test.js && cd ../frontweb && node --test test/*.test.js` | pass | ca4f056+8d011de4cf680157 | 2026-11-19T01:22:39Z |
| AC5 | test | record 023 | cli | `cd backend-node && node --test test/*.test.js && cd ../frontweb && node --test test/*.test.js` | pass | 7c551ad+e3f3f85ebe3ee5d3 | 2026-11-19T01:34:02Z |
| AC10 | test | record 024 | cli | `cd backend-node && node --test test/*.test.js && cd ../frontweb && node --test test/*.test.js` | pass | 7c551ad+e3f3f85ebe3ee5d3 | 2026-11-19T01:34:08Z |
| AC11 | test | record 025 | cli | `cd backend-node && node --test test/*.test.js && cd ../frontweb && node --test test/*.test.js` | pass | b759773+dde1001f5c4172da | 2026-11-19T01:53:30Z |
| AC12 | test | record 026 | cli | `cd backend-node && node --test test/*.test.js && cd ../frontweb && node --test test/*.test.js` | pass | 17cc756+6e6fe28f35dd2f50 | 2026-11-19T01:57:27Z |
| AC29 | test | record 027 | cli | `cd backend-node && node --test test/*.test.js && cd ../frontweb && node --test test/*.test.js` | pass | 17cc756+6e6fe28f35dd2f50 | 2026-11-19T01:57:40Z |
| AC30 | test | record 028 | cli | `cd backend-node && node --test test/*.test.js && cd ../frontweb && node --test test/*.test.js` | pass | 17cc756+6e6fe28f35dd2f50 | 2026-11-19T01:57:53Z |
| AC25 | test | record 029 | cli | `cd backend-node && node --test test/*.test.js && cd ../frontweb && node --test test/*.test.js` | pass | 7a11676+7bb53629eaf85953 | 2026-11-19T02:01:16Z |
| AC13 | test | record 030 | cli | `cd backend-node && node --test test/*.test.js && cd ../frontweb && node --test test/*.test.js` | pass | 9445e30+73748845895bdc07 | 2026-11-19T05:36:59Z |
| AC27 | test | record 031 | cli | `cd backend-node && node --test test/*.test.js && cd ../frontweb && node --test test/*.test.js` | pass | 9445e30+73748845895bdc07 | 2026-11-19T05:37:06Z |
| AC14 | test | record 032 | cli | `cd backend-node && node --test test/*.test.js && cd ../frontweb && node --test test/*.test.js` | pass | 3e64516+758120eb6eae127d | 2026-11-19T05:40:26Z |
| AC24 | test | record 033 | cli | `cd backend-node && node --test test/*.test.js && cd ../frontweb && node --test test/*.test.js` | pass | 6882edc+2f6512f858fd66d1 | 2026-11-19T05:45:07Z |
| AC15 | test | record 034 | cli | `cd backend-node && node --test test/*.test.js && cd ../frontweb && node --test test/*.test.js` | pass | a257185+4bc2d9cba06df027 | 2026-11-19T06:00:23Z |
| AC16 | test | record 035 | cli | `cd backend-node && node --test test/*.test.js && cd ../frontweb && node --test test/*.test.js` | pass | a257185+4bc2d9cba06df027 | 2026-11-19T06:00:50Z |
| AC34 | test | record 036 | cli | `cd backend-node && node --test test/*.test.js && cd ../frontweb && node --test test/*.test.js` | pass | a257185+4bc2d9cba06df027 | 2026-11-19T06:01:05Z |
| AC31 | test | record 037 | cli | `cd backend-node && node --test test/*.test.js && cd ../frontweb && node --test test/*.test.js` | pass | a257185+4bc2d9cba06df027 | 2026-11-19T06:01:27Z |
| AC20 | test:live | record 038 | cli | `cd backend-node && JIMENG_LIVE=1 node --test test/live/*.live.test.js` | fail(exit 1) | 7280bdf+9eab70250b5f2ddf | 2026-11-19T06:02:47Z |
| AC20 | test:live | record 039 | cli | `cd backend-node && JIMENG_LIVE=1 node --test test/live/*.live.test.js` | pass | 7280bdf+67cb2f309e91aff2 | 2026-11-19T06:04:12Z |
| AC17 | test | record 040 | cli | `cd backend-node && node --test test/*.test.js && cd ../frontweb && node --test test/*.test.js` | pass | 1289973+d11b6e6630254ab1 | 2026-11-19T06:14:45Z |
| AC18 | test | record 041 | cli | `cd backend-node && node --test test/*.test.js && cd ../frontweb && node --test test/*.test.js` | pass | 1289973+d11b6e6630254ab1 | 2026-11-19T06:14:58Z |
<!-- hx run appends a row here for each record it writes. Rows you add are notes, not evidence. -->

## Review

Severity is `blocking`, `should-fix`, `nit`, `question`, or `verdict`. A blocking finding needs a
disposition before `hx check` passes. A criterion whose Tests say `review` needs a row with `#` set
to its id, severity `verdict` and disposition `met`. When the table is final, register it with
`hx review --reviewer independent` (or `self`); that binds it to the current revision.

| # | Finding | Severity | Disposition | Where |
|---|---|---|---|---|
| | | | | |

## Deferred

What this change did not do, and the number it maps to in the spec's `Deferred` table. A deferral
the user did not agree to is not a deferral; say so here.

| # | Item | Reported to user |
|---|---|---|
| | | |

## Residual risks

What you could not verify, what you assumed, and what remains unknown. Confidence must match
the evidence above.
