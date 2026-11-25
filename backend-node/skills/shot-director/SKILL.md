---
name: shot-director
description: 空间调度、文戏表演与打戏编排。先定主机位与轴线，再给逐拍动作；用现有确定性编译器复核连续性，不直接改 SegmentIR。
---

# 空间调度、文戏表演与打戏编排

先定主机位与站位轴线，再分配动作因果、视线与停顿。不要写「他很愤怒」这种情绪标签，要写摄像机拍得到、模型画得出来的动作。

## 何时使用

- 用户说「这场戏怎么拍」「人物站位对不对」「打戏怎么编」时。
- 分镜写完后想用确定性检查复核连续性时。
- 文戏站桩念词、群戏抢演、动作戏糊成一团时。

## 工具调用步骤

1. `propose_blocking` 读取当前集剧本，按场景给出主机位、轴线与逐拍动作提议；传入 `scene_id` 可针对特定场景。提议写入 `episode-<id>-direction.json`。
2. 展示时按「主机位 → 轴线 → 逐拍」的顺序讲，每拍注明景别、动作、机位移动。打戏要说清攻防回合、持物手、运动方向与落点。
3. 用户确认后，把建议作为分镜规划的输入，用现有分镜工具落地；这个 Skill 不直接改 SegmentIR。
4. `review_shot_continuity` 对一条结构化分镜做确定性复核：调用现有编译器与尾帧资格检查，返回 `findings` 与 `blocked`。它不改分镜表。
5. 遇到 `legacy_storyboard`（非结构化分镜）时说明这条分镜没有 IR，建议用户先转结构化分镜。

## 证据与失败处理

- `not_found`：剧/集/场景/分镜不存在。
- `empty_script`：当前集没有剧本。
- `proposal_invalid`：模型输出不合约定，整份提议作废；不写入笔记。
- `segment_ir_invalid`：分镜的 IR 数据不合法，让用户先修复。
- `legacy_storyboard`：旧分镜没有 SegmentIR，复核不适用。
- 复核结果里的 `findings` 按级别展示；`blocked: true` 表示有阻断问题，先解决再生视频。

## 作者确认门槛

- 提议只写笔记，不改分镜、不改视频。
- 不绕过分镜规划器的时长与事件约束；建议里的每拍都要能落进现有秒数上限。
- 不写情绪标签代替动作；不引入 Blender/白模等外部运行时。

## 能力边界

- `propose_blocking` 用模型生成建议，`review_shot_continuity` 用确定性检查；两者互补，不可互相替代。
- 复用现有创作方法与连续性锁（`creative-methods.json`、`beat-continuity.md`）；项目未启用创作方法时建议为空，属正常。
- 详细方法见 `references/blocking-methods.md`。
