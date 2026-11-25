---
name: clip-qc
description: 成片视觉质检与归因。聚合成片已提交的提示词、媒体检测、参考图与审片证据，按作者目视结果记录失败模式与三类归因，不抽帧、不重渲。
---

# 成片视觉质检与归因

复看一条生成片段时，先把已经存在的证据摆齐，再让作者写明看到了什么。工具不抽关键帧、不读取图像内容，也不把一次样片当成模型的稳定倾向。

## 何时使用

- 用户说「这条片子哪里不对」「是平台没执行还是提示词问题」「要重抽吗」时。
- 需要把成片问题与时间码、提交提示词、参考图、媒体检测对应起来时。
- 已有 `video_take_reviews` 时间码评论，需要转成可复看的质检笔记时。

## 工具调用步骤

1. 先确定当前剧、当前集，以及要复看的分镜 id 与 take id。take 是 `video_generations.id`，不是分镜号。
2. 调用 `get_take_evidence` 取得证据包：`prompt`、`compiled_findings`、`media_check`（含黑屏/冻结 `anomalies`）、`reference_images`、`reviews`、`evidence_gaps` 与 `attribution_hints`。
3. 把 `evidence_gaps` 原样告诉作者：本工具没有关键帧，画面内容、表演节奏与切点必须由作者目视后填写。
4. 展示 `attribution_hints` 时说明这是规则提示，不是最终结论。每条提示的 `basis` 是证据 id，可对照证据包查看。
5. 作者写明一条或多条问题后，调用 `record_clip_findings`。每条 finding 必须：选择三类 `class` 之一、引用至少一个本次证据包里的 `evidence_ids`、填写 `visible_evidence`（在画面上看到了什么）。可选 `action`（`revise` / `replace` / `reshoot`）与 `note`。
6. 写入前先读取当前 `expected_revision`（用笔记读取工具或上一次返回），写入后展示逐条结论与 revision。`record_clip_findings` 只写 `episode-<id>-qc.json`，不改视频、不改分镜、不改审片表。

## 三类归因

| class | 含义 | 需要的证据 |
|---|---|---|
| `requirement_not_executed` | 作者明确要求且已写进请求，但成片没有执行 | 提交提示词/IR 要求 + 作者写明的可见缺失；媒体检测异常或参考图缺失可作旁证 |
| `single_take_variance` | 同一条提示词下的一次生成偏差 | 至少一条 take 的证据；不能据此宣称模型稳定倾向 |
| `prompt_under_specified` | 提示词本身没写清可拍要求 | 提交提示词证据 + 作者指出的未写明项 |

详细失败模式与判据见 `references/failure-modes.md`。

## 证据与失败处理

- 证据包里每条证据都有 `id`；`record_clip_findings` 只接受本次同一条 take 的证据 id。换 take 或媒体变化后需重新取证。
- `not_found`：剧/集/分镜/take 不存在，或 take 未完成。
- `stale_evidence`：证据包已过期或与当前 take 不一致，重新调用 `get_take_evidence`。
- `invalid_finding`：没引用证据、没有 `visible_evidence`、class 或 action 不在允许集合。
- `conflict`：`expected_revision` 与笔记当前 revision 不符；重新读取后再写。
- `media_check.status = unavailable` 或 `evidence_gaps` 出现「未记录参考图」「没有媒体检测」时，不能据此推断画面好坏，只记录缺口。

## 作者确认门槛

- 只有作者目视并写明 `visible_evidence` 的问题才能写入笔记；工具不替作者判断画面。
- `attribution_hints` 只是规则提示，作者可以不同意；最终 class 由作者定稿。
- `record_clip_findings` 不自动重渲、不覆盖成片、不改 `video_generations` / `video_take_reviews`。
- 单次样片只记为一次观察；要判断稳定倾向，需要作者另行取得对照样本。

## 能力边界

- 本 Skill 不抽关键帧、不调用模型看图、不接第三方付费质检服务。
- 远程参考图只记录路径，不发起网络请求，存在性记为未知。
- 媒体检测只覆盖尺寸/时长/画幅/音轨与黑屏/冻结，不判断剧情、表演或风格一致性。
- 质检结论只写 notes；要改提示词、重抽或替换成片，使用软件里已有的对应工具。
