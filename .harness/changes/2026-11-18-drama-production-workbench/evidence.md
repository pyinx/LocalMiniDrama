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
