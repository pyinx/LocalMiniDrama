# 资产矩阵字段参考

## matrix.characters / matrix.scenes

`has_reference` 表示是否已有可用参考图（图片地址或本地路径）。缺参考图的资产会在 `check_asset_lock` 中触发 `asset_unready`。

## matrix.props

从现有 `props` 表读出的道具列表。提议里的 `prop_id` 必须在这里。

## matrix.locks

按集号索引的连续性锁，来自 `episodeContinuityService.getContinuity`，含场景状态、位置锁、轴线锁。只读。

## prop_proposals

`propose_prop_states` 写入的提议，每项：

- `prop_id` / `name`：目标道具。
- `state_phrase`：状态描述（「被撕成两半」「屏幕亮着」）。
- `reason`：剧本里的依据。
- `episode_id`：产生提议的集。

提议可重复积累；用户确认并用现有接口创建资产后，提议仍留在笔记里作为历史，不会自动删除。
