# 全剧笔记字段参考

这份参考只定义字段含义，不替用户填内容。`save_series_notes` 的 `document` 是自由对象；以下字段是约定，便于 P1 的 `novel-deconstruct` 和 `asset-bible` 读取。

## premise（一句话故事）

一句话说清「谁、在什么处境、要什么、拦路的是什么」。不写风格、不写画风、不写「本剧讲述」这类套话。

## invariants（跨集不可变事实）

每项：

- `id`：稳定短标识，如 `inv-01`。
- `statement`：面向作者的描述，如「女主不能知道男主就是当年的目击者」。
- `tokens`：出现在剧本里应能认出的字符串数组，如 `["目击者", "那年的事", "旧案"]`。

`check_series_continuity` 只核对 `tokens`：剧本中至少出现其中一个字符串才算通过。别名越多越不容易误报，但不要塞入和事实无关的常见词。

## relationships（人物关系与反派层级）

用用户自己的语言记。推荐结构：

- `allies`：主角阵营及关系。
- `antagonists`：按层级排列，每层写「知道什么、想要什么、和主角的关系」。
- `shifts`：关系会反转的节点及集数。

## arcs（分集冲突弧线）

每集一项：

- `episode`：集号。
- `conflict`：这一集的主要对抗是什么。
- `turn`：局势在哪一点翻转。
- `hook`：集尾停在哪个画面或哪句话上。

不要把弧线写成剧情梗概；写「对抗什么、怎么变、停在哪」。

## payoffs（伏笔表）

每项：

- `id`：稳定标识，和 `invariants` 里的 id 区分（如 `pay-01`）。
- `planted_at`：埋设集数。
- `recalled_at`：计划回收集数；未定写 `null`。
- `status`：`planted` / `recalled` / `abandoned`。

用户决定废弃某条伏笔时改 `status`，不要删行；保留历史便于回看为什么没回收。

## 维护纪律

- 修改任何字段前先 `get_series_notes` 读最新 `revision`；`conflict` 时重读再写。
- 用户口头说的设定和你推断出来的内容要分清；推断的标注「待确认」，不直接当事实写。
- 这些字段只存在 notes 文件里；不写数据库、不写 `creative_direction`。
