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
| ALL | test:one | record 042 | cli | `node --test 'backend-node/test/episodeCompose.test.js'` | pass | 54ec8d7+7b58dbfa513ad957 | 2026-11-19T08:07:54Z |
| AC1 | test | record 044 | cli | `cd backend-node && node --test test/*.test.js && cd ../frontweb && node --test test/*.test.js` | pass | 5d0e5b5+8f921f23b62b4e5f | 2026-11-19T08:12:38Z |
| AC2 | test | record 045 | cli | `cd backend-node && node --test test/*.test.js && cd ../frontweb && node --test test/*.test.js` | fail(exit 1) | cad462d+a3c3289da01cb407 | 2026-11-19T08:12:54Z |
| AC3 | test | record 046 | cli | `cd backend-node && node --test test/*.test.js && cd ../frontweb && node --test test/*.test.js` | fail(exit 1) | cad462d+a3c3289da01cb407 | 2026-11-19T08:13:02Z |
| AC4 | test | record 047 | cli | `cd backend-node && node --test test/*.test.js && cd ../frontweb && node --test test/*.test.js` | fail(exit 1) | cad462d+fb351d03df22028f | 2026-11-19T08:13:25Z |
| AC5 | test | record 048 | cli | `cd backend-node && node --test test/*.test.js && cd ../frontweb && node --test test/*.test.js` | pass | cad462d+fb351d03df22028f | 2026-11-19T08:13:45Z |
| AC6 | test | record 049 | cli | `cd backend-node && node --test test/*.test.js && cd ../frontweb && node --test test/*.test.js` | pass | cad462d+fb351d03df22028f | 2026-11-19T08:14:04Z |
| AC7 | test | record 050 | cli | `cd backend-node && node --test test/*.test.js && cd ../frontweb && node --test test/*.test.js` | pass | cad462d+fb351d03df22028f | 2026-11-19T08:14:12Z |
| AC8 | test | record 051 | cli | `cd backend-node && node --test test/*.test.js && cd ../frontweb && node --test test/*.test.js` | pass | cad462d+fb351d03df22028f | 2026-11-19T08:14:19Z |
| AC9 | test | record 052 | cli | `cd backend-node && node --test test/*.test.js && cd ../frontweb && node --test test/*.test.js` | pass | cad462d+fb351d03df22028f | 2026-11-19T08:14:25Z |
| AC10 | test | record 053 | cli | `cd backend-node && node --test test/*.test.js && cd ../frontweb && node --test test/*.test.js` | pass | cad462d+fb351d03df22028f | 2026-11-19T08:14:32Z |
| AC11 | test | record 054 | cli | `cd backend-node && node --test test/*.test.js && cd ../frontweb && node --test test/*.test.js` | pass | cad462d+fb351d03df22028f | 2026-11-19T08:14:38Z |
| AC12 | test | record 055 | cli | `cd backend-node && node --test test/*.test.js && cd ../frontweb && node --test test/*.test.js` | pass | cad462d+fb351d03df22028f | 2026-11-19T08:14:44Z |
| AC13 | test | record 056 | cli | `cd backend-node && node --test test/*.test.js && cd ../frontweb && node --test test/*.test.js` | pass | cad462d+fb351d03df22028f | 2026-11-19T08:14:55Z |
| AC14 | test | record 057 | cli | `cd backend-node && node --test test/*.test.js && cd ../frontweb && node --test test/*.test.js` | pass | cad462d+fb351d03df22028f | 2026-11-19T08:15:05Z |
| AC15 | test | record 058 | cli | `cd backend-node && node --test test/*.test.js && cd ../frontweb && node --test test/*.test.js` | pass | cad462d+fb351d03df22028f | 2026-11-19T08:15:11Z |
| AC16 | test | record 059 | cli | `cd backend-node && node --test test/*.test.js && cd ../frontweb && node --test test/*.test.js` | pass | cad462d+96072b1207b64a1d | 2026-11-19T08:15:20Z |
| AC17 | test | record 060 | cli | `cd backend-node && node --test test/*.test.js && cd ../frontweb && node --test test/*.test.js` | fail(exit 1) | cad462d+96072b1207b64a1d | 2026-11-19T08:15:29Z |
| AC18 | test | record 061 | cli | `cd backend-node && node --test test/*.test.js && cd ../frontweb && node --test test/*.test.js` | fail(exit 1) | cad462d+96072b1207b64a1d | 2026-11-19T08:15:36Z |
| AC19 | test | record 062 | cli | `cd backend-node && node --test test/*.test.js && cd ../frontweb && node --test test/*.test.js` | fail(exit 1) | cad462d+8999db1bfc309920 | 2026-11-19T08:15:46Z |
| AC19 | build | record 063 | cli | `cd frontweb && npm run build` | pass | 8aeebcf+8999db1bfc309920 | 2026-11-19T08:15:56Z |
| AC21 | test | record 064 | cli | `cd backend-node && node --test test/*.test.js && cd ../frontweb && node --test test/*.test.js` | fail(exit 1) | 8aeebcf+c818c898010fbef1 | 2026-11-19T08:16:04Z |
| AC22 | test | record 065 | cli | `cd backend-node && node --test test/*.test.js && cd ../frontweb && node --test test/*.test.js` | pass | 8aeebcf+c818c898010fbef1 | 2026-11-19T08:16:11Z |
| AC23 | test | record 066 | cli | `cd backend-node && node --test test/*.test.js && cd ../frontweb && node --test test/*.test.js` | pass | 8aeebcf+c818c898010fbef1 | 2026-11-19T08:16:18Z |
| AC24 | test | record 067 | cli | `cd backend-node && node --test test/*.test.js && cd ../frontweb && node --test test/*.test.js` | pass | 8aeebcf+c818c898010fbef1 | 2026-11-19T08:16:26Z |
| AC25 | test | record 068 | cli | `cd backend-node && node --test test/*.test.js && cd ../frontweb && node --test test/*.test.js` | pass | 68f5f88+c818c898010fbef1 | 2026-11-19T08:16:34Z |
| AC26 | test | record 069 | cli | `cd backend-node && node --test test/*.test.js && cd ../frontweb && node --test test/*.test.js` | pass | 68f5f88+c818c898010fbef1 | 2026-11-19T08:16:42Z |
| AC27 | test | record 070 | cli | `cd backend-node && node --test test/*.test.js && cd ../frontweb && node --test test/*.test.js` | pass | 68f5f88+c818c898010fbef1 | 2026-11-19T08:16:50Z |
| AC28 | test | record 071 | cli | `cd backend-node && node --test test/*.test.js && cd ../frontweb && node --test test/*.test.js` | pass | 68f5f88+c818c898010fbef1 | 2026-11-19T08:16:57Z |
| AC29 | test | record 072 | cli | `cd backend-node && node --test test/*.test.js && cd ../frontweb && node --test test/*.test.js` | pass | 68f5f88+c818c898010fbef1 | 2026-11-19T08:17:06Z |
| AC30 | test | record 073 | cli | `cd backend-node && node --test test/*.test.js && cd ../frontweb && node --test test/*.test.js` | pass | 68f5f88+c818c898010fbef1 | 2026-11-19T08:17:14Z |
| AC31 | test | record 074 | cli | `cd backend-node && node --test test/*.test.js && cd ../frontweb && node --test test/*.test.js` | pass | 68f5f88+c818c898010fbef1 | 2026-11-19T08:17:22Z |
| AC20 | test:live | record 070 | cli | `cd backend-node && JIMENG_LIVE=1 node --test test/live/*.live.test.js` | pass | 68f5f88+c818c898010fbef1 | 2026-11-19T08:17:26Z |
| AC32 | build | record 075 | cli | `cd frontweb && npm run build` | pass | 68f5f88+c818c898010fbef1 | 2026-11-19T08:17:30Z |
| AC33 | test | record 077 | cli | `cd backend-node && node --test test/*.test.js && cd ../frontweb && node --test test/*.test.js` | pass | 68f5f88+c818c898010fbef1 | 2026-11-19T08:17:38Z |
| AC34 | test | record 078 | cli | `cd backend-node && node --test test/*.test.js && cd ../frontweb && node --test test/*.test.js` | pass | 68f5f88+c818c898010fbef1 | 2026-11-19T08:17:46Z |
| AC35 | test | record 079 | cli | `cd backend-node && node --test test/*.test.js && cd ../frontweb && node --test test/*.test.js` | pass | 68f5f88+c818c898010fbef1 | 2026-11-19T08:17:53Z |
| AC36 | test | record 080 | cli | `cd backend-node && node --test test/*.test.js && cd ../frontweb && node --test test/*.test.js` | pass | 68f5f88+c818c898010fbef1 | 2026-11-19T08:18:07Z |
| AC37 | test | record 082 | cli | `cd backend-node && node --test test/*.test.js && cd ../frontweb && node --test test/*.test.js` | pass | 68f5f88+c818c898010fbef1 | 2026-11-19T08:18:16Z |
| AC38 | test | record 083 | cli | `cd backend-node && node --test test/*.test.js && cd ../frontweb && node --test test/*.test.js` | pass | 68f5f88+c818c898010fbef1 | 2026-11-19T08:18:25Z |
| AC39 | test | record 084 | cli | `cd backend-node && node --test test/*.test.js && cd ../frontweb && node --test test/*.test.js` | pass | 68f5f88+c818c898010fbef1 | 2026-11-19T08:18:35Z |
| AC40 | test | record 085 | cli | `cd backend-node && node --test test/*.test.js && cd ../frontweb && node --test test/*.test.js` | pass | 68f5f88+c818c898010fbef1 | 2026-11-19T08:18:43Z |
| AC1 | test | record 086 | cli | `cd backend-node && node --test test/*.test.js && cd ../frontweb && node --test test/*.test.js` | pass | 68f5f88+c818c898010fbef1 | 2026-11-19T08:19:04Z |
| AC2 | test | record 087 | cli | `cd backend-node && node --test test/*.test.js && cd ../frontweb && node --test test/*.test.js` | pass | 68f5f88+c818c898010fbef1 | 2026-11-19T08:19:13Z |
| AC3 | test | record 088 | cli | `cd backend-node && node --test test/*.test.js && cd ../frontweb && node --test test/*.test.js` | pass | 68f5f88+c818c898010fbef1 | 2026-11-19T08:19:32Z |
| AC19 | test | record 088 | cli | `cd backend-node && node --test test/*.test.js && cd ../frontweb && node --test test/*.test.js` | pass | 68f5f88+c818c898010fbef1 | 2026-11-19T08:19:39Z |
| AC4 | test | record 089 | cli | `cd backend-node && node --test test/*.test.js && cd ../frontweb && node --test test/*.test.js` | pass | 68f5f88+c818c898010fbef1 | 2026-11-19T08:19:42Z |
| AC5 | test | record 090 | cli | `cd backend-node && node --test test/*.test.js && cd ../frontweb && node --test test/*.test.js` | pass | 68f5f88+c818c898010fbef1 | 2026-11-19T08:19:50Z |
| AC19 | build | record 089 | cli | `cd frontweb && npm run build` | pass | 68f5f88+c818c898010fbef1 | 2026-11-19T08:19:59Z |
| AC6 | test | record 091 | cli | `cd backend-node && node --test test/*.test.js && cd ../frontweb && node --test test/*.test.js` | pass | 68f5f88+c818c898010fbef1 | 2026-11-19T08:19:59Z |
| AC25 | test | record 092 | cli | `cd backend-node && node --test test/*.test.js && cd ../frontweb && node --test test/*.test.js` | pass | 68f5f88+c818c898010fbef1 | 2026-11-19T08:20:13Z |
| AC7 | test | record 093 | cli | `cd backend-node && node --test test/*.test.js && cd ../frontweb && node --test test/*.test.js` | pass | 68f5f88+c818c898010fbef1 | 2026-11-19T08:20:13Z |
| AC8 | test | record 095 | cli | `cd backend-node && node --test test/*.test.js && cd ../frontweb && node --test test/*.test.js` | pass | 68f5f88+c818c898010fbef1 | 2026-11-19T08:20:20Z |
| AC9 | test | record 096 | cli | `cd backend-node && node --test test/*.test.js && cd ../frontweb && node --test test/*.test.js` | pass | 68f5f88+c818c898010fbef1 | 2026-11-19T08:20:28Z |
| AC10 | test | record 097 | cli | `cd backend-node && node --test test/*.test.js && cd ../frontweb && node --test test/*.test.js` | pass | 68f5f88+c818c898010fbef1 | 2026-11-19T08:20:38Z |
| AC11 | test | record 098 | cli | `cd backend-node && node --test test/*.test.js && cd ../frontweb && node --test test/*.test.js` | pass | 68f5f88+c818c898010fbef1 | 2026-11-19T08:20:46Z |
| AC12 | test | record 099 | cli | `cd backend-node && node --test test/*.test.js && cd ../frontweb && node --test test/*.test.js` | pass | 68f5f88+c818c898010fbef1 | 2026-11-19T08:20:58Z |
| AC13 | test | record 100 | cli | `cd backend-node && node --test test/*.test.js && cd ../frontweb && node --test test/*.test.js` | pass | 68f5f88+c818c898010fbef1 | 2026-11-19T08:21:07Z |
| AC14 | test | record 101 | cli | `cd backend-node && node --test test/*.test.js && cd ../frontweb && node --test test/*.test.js` | pass | 68f5f88+c818c898010fbef1 | 2026-11-19T08:21:15Z |
| AC15 | test | record 102 | cli | `cd backend-node && node --test test/*.test.js && cd ../frontweb && node --test test/*.test.js` | pass | 68f5f88+c818c898010fbef1 | 2026-11-19T08:21:25Z |
| AC16 | test | record 103 | cli | `cd backend-node && node --test test/*.test.js && cd ../frontweb && node --test test/*.test.js` | pass | 68f5f88+c818c898010fbef1 | 2026-11-19T08:21:33Z |
| AC17 | test | record 104 | cli | `cd backend-node && node --test test/*.test.js && cd ../frontweb && node --test test/*.test.js` | pass | 68f5f88+c818c898010fbef1 | 2026-11-19T08:21:51Z |
| AC3 | test | record 104 | cli | `cd backend-node && node --test test/*.test.js && cd ../frontweb && node --test test/*.test.js` | pass | 68f5f88+c818c898010fbef1 | 2026-11-19T08:21:57Z |
| AC18 | test | record 105 | cli | `cd backend-node && node --test test/*.test.js && cd ../frontweb && node --test test/*.test.js` | pass | 68f5f88+c818c898010fbef1 | 2026-11-19T08:21:59Z |
| AC21 | test | record 106 | cli | `cd backend-node && node --test test/*.test.js && cd ../frontweb && node --test test/*.test.js` | pass | 68f5f88+c818c898010fbef1 | 2026-11-19T08:22:06Z |
| AC17 | test | record 107 | cli | `cd backend-node && node --test test/*.test.js && cd ../frontweb && node --test test/*.test.js` | pass | 68f5f88+c818c898010fbef1 | 2026-11-19T08:22:53Z |
<!-- hx run appends a row here for each record it writes. Rows you add are notes, not evidence. -->

## Review

Severity is `blocking`, `should-fix`, `nit`, `question`, or `verdict`. A blocking finding needs a
disposition before `hx check` passes. A criterion whose Tests say `review` needs a row with `#` set
to its id, severity `verdict` and disposition `met`. When the table is final, register it with
`hx review --reviewer independent` (or `self`); that binds it to the current revision.

| # | Finding | Severity | Disposition | Where |
|---|---|---|---|---|
| AC19 | 独立复审实跑后端 297、前端 33，零失败零跳过，前端生产构建通过；最终 68f5f88 两项遗留场景独立复验 9/9 通过。 | verdict | met | 独立代码审核，2026-11-19 |
| AC32 | 独立浏览器在 5689 逐项核对八组状态，含纯旧分镜对照、缺失角色阻断、即梦禁用原因、体检错误。报价可用状态及金额为浏览器内模拟响应，止于确认弹窗。 | verdict | met | 创作页与配置页，2026-11-19 |
| R1 | 后一次报价能覆盖已确认生成的提示词。 | blocking | fixed (4faddd6) | jimeng/renderer.js |
| R2 | 提交超时可将上次运行的成片写回。 | blocking | fixed (4faddd6) | jimeng/renderer.js |
| R3 | 批次内另一分镜改变后，旧 token 仍接受提交。 | blocking | fixed | 54ec8d7，batch token invalid after config change |
| R4 | 通用更新可写入 IR 投影以外的角色值。 | should-fix | fixed (8aeebcf) | storyboardService.js |
| R5 | 旧提示词异步生成期间获得 IR，完成时仍覆写文本。 | should-fix | fixed (8aeebcf) | routes/storyboards.js |
| R6 | 规划完成补时后可超过模型时长上限。 | should-fix | fixed (8aeebcf) | segmentIr/planner.js |
| R7 | 显式指定的尾帧缺失时静默降级。 | should-fix | fixed (8aeebcf) | segmentCompile/index.js |
| R8 | 12 秒成片只有开头字卡，软字幕合成后只剩 2 秒。 | blocking | fixed (5d0e5b5) | structuredEpisodePost.js |
| R9 | 缺片时拼接列表和字幕、配音时间轴不一致。 | should-fix | fixed (5d0e5b5) | videoMergeService.js |
| R10 | 导出或导入时同名场景合并，丢失独立连续性。 | should-fix | fixed | 327ee5b，4 个往返测试通过 |
| R11 | 输入图片符号链接与 CLI 结果路径缺少真实路径边界。 | should-fix | fixed (4faddd6) | storagePaths.js，jimeng/renderer.js |
| R12 | 逐句配音产生永久中间文件，调用路径暴露已有凭据日志。 | should-fix | fixed (5d0e5b5) | structuredEpisodePost.js，ttsService.js |
| R14 | 错项、缺项等报价返回仍可签发确认；直接请求可能绕过余额不足的界面限制。 | blocking | fixed (68f5f88) | jimengNovelRenderer.test.js |
| R13 | 尾帧提取实际取倒数一秒的第一帧，双色视频复现。 | should-fix | fixed | 54ec8d7，extracts last frame |

## Deferred

What this change did not do, and the number it maps to in the spec's `Deferred` table. A deferral
the user did not agree to is not a deferral; say so here.

| # | Item | Reported to user |
|---|---|---|
| | | |

## Residual risks

真实生成画质与各厂商付费请求的最终接受情况未经测量。即梦付费提交与恢复由假 CLI 验证，真实账号只验证免费操作。65 个测试引用从 `::名称` 补全为 `文件::名称`，逐行比较只涉及路径前缀；冻结规格的再确认尚待用户明确同意。
