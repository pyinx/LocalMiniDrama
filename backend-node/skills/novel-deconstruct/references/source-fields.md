# 小说事实卡字段参考

`source-deconstruction.json` 的 `document` 是自由对象。以下字段是约定，便于后续模块读取。

## source_hash

源文本 sha256，由 `get_source_facts` 和 `propose_episode_split` 自动维护。不要手改。源文本一变，旧笔记即失效。

## chapters

章节识别结果与每章内容预览。由 `get_source_facts` 在未保存过时按规则生成。

## facts

事实卡数组，每项推荐：

- `id`：稳定标识。
- `kind`：`identity` / `relationship` / `event` / `motivation` / `constraint`。
- `statement`：面向作者的描述。
- `source_quote`：原文依据（可选，但强烈建议写）。

## split_proposal

`propose_episode_split` 写入的分集提议，每集写明覆盖哪些源章节。它是算法按篇幅分配的初稿，用户应按可拍事件调整。

## 维护纪律

- 先 `get_source_facts` 再写事实卡；`source_changed` 时不得复用旧事实。
- 推断和原文明确写出的事实要分开标注。
- 事实卡只存在 notes 里，不写数据库、不写 `creative_direction`。
