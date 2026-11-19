---
tier: T2
language: zh
slug: 2026-11-18-jimeng-quality-chain
---

# 借鉴即梦短剧方法论，补齐 LocalMiniDrama 视频质量链路（三模型定向优化 + 即梦可选后端）

## Intent

LocalMiniDrama 产出的分镜视频与即梦短剧画布相比明显"玩具感"：竖屏被塞进横屏加黑边、画风被强制写实污染、镜头语言和空间关系弱、角色造型无法区分、片段之间没有可交付的成片工艺。
本变更把即梦 `jimeng-drama` 的方法论（分段装箱、镜头/朝向/口型写法、参考图绑定、资产造型与场景状态、成片后期）**用自己的话**重写为与模型无关的规则层，
再为 Seedance 2.x、MiniMax H3、阿里 Wan 三个视频模型各做一套定向编译，并把即梦 `jimeng-novel` CLI 接为**可选、默认关闭、先报价后提交**的渲染后端。
完成后，同一份分镜可以编译成符合各模型上限与写法的请求；剧本生成与体检规则在视频链路之后补齐。

## Scope

覆盖面（实施顺序以 Tasks 为准）：

1. **正确性修复**：MiniMax H3 多参考图时下发 ratio；Wan 参考图丢失与尺寸写死横屏；风格行去掉强制"真人写实"；段时长按目标模型上下限归一。
2. **模型能力表**：Seedance 2.x / MiniMax H3 / Wan / 即梦各模型的时长范围、参考图上限、prompt 长度上限、比例、首尾帧、是否原生出人声，单一来源；请求路径从这里取上限。
3. **结构化分镜段（中间表示）+ 分模型编译器 + prompt 检查器**：分段装箱与时长计算、每个分镜的景别/机位/绝对朝向/视线落点/运镜/动作/台词口型/音效、参考说明句、尾注、禁写项检查、超长裁剪与参考图排序。
4. **资产矩阵**：角色多造型（基于基础形象派生）与场景多状态/竖屏主机位版本；分镜段按造型与场景状态绑定参考图。
5. **成片工艺**：拼接、按分镜结构生成台词字幕与字卡、BGM 混音、接缝拼图与抽帧审片图、前段尾帧提取（衔接参考）。
6. **即梦可选后端**：`jimeng-novel` 渲染器（建节点 → 报价 → 用户确认 → 提交 → 只查不重提 → 落盘回写）。
8. **IR 为唯一来源**：有 IR 的分镜，旧文本字段由 IR 投影生成且只读；编辑走结构化编辑（前端与应用内助手同一入口）。
9. **非原生人声模型的台词**：按 IR 逐句 TTS、按分镜时间轴混入成片；视频 prompt 改写为说话人闭口/背对/画外。
10. **整集层面检查**：开场钩子、相邻段主运镜不同、同场景环境声一致、尾帧依赖最多两轮。
11. **补充资产与衔接**：道具参考图与道具状态变体、群像参考图、场景反打版本、编译器首尾帧模式。
12. **数据完整性**：导出/导入携带 IR、造型、场景/道具状态；删除角色/场景/道具时其变体随之软删。
13. **剧本层**（视频链路之后）：分集剧本写法规则与剧本体检（结构化评分报告）。

## Non-goals

- 不证明画质"变好"：按用户决定只做结构检查，不花生成费；真实画质提升未经验证（见 Assumptions A1）。
- 不原样复制即梦 `jimeng-drama` 的文本（AC18 以连续重合字数为机械判据，见 D15）（仓库是公开 fork，即梦 skill 无许可证）；只移植方法，固定段落全部自写。
- 不使用 `jimeng_ai_api`（jimeng-free-api-all 逆向接口）作为新能力的载体，也不扩展它。
- 不调用即梦付费能力做验收（`node run` / `generate-*` / `transcribe` / `upscale` / `script`）。
- 不自动迁移已有分镜和视频（新旧并存，用户对某集"重新生成分镜"时才走新链路）。
- 不接入 `dreamina-canvas` CLI（主体/时间轴/导演台）。
- 不做超分、白模预演、剧本医生之外的 doctor 节点。
- 不做生成后的审片清单/归因表与局部重拍；即梦后端不做样片（draft）转成片（D12 未选）。
- 不把 `jimeng-drama` skill 装进应用内助手（应用内助手无命令行工具，只能当知识用；用户可自行放入 `data/skills/`，本变更不打包、不依赖）。
- 顺带发现但不在本变更修：`routes/storyboards.js:997` 调用不存在的 `getClassicVideoPromptPolishPrompt`；`ttsService.js:148` 打印 API key —— 建议各开一个 T1 单独修。

## Deferred

| # | Item | Why deferred | Unblocks when |
|---|---|---|---|
| | | | |

## Facts

| Fact | Source |
|---|---|
| MiniMax H3 带参考图且非首尾帧时 `body.ratio` 不下发 | `backend-node/src/services/videoClient.js:4013-4018` |
| 风格行固定以"真人写实, 电影风格, 高清画质"开头，项目风格只追加在后 | `universalOmniMultiBeatFormat.js:48`；`promptI18n.js:290,306,1364` |
| 每部剧已有风格设置（`dramas.style` + metadata），经 `mergeCfgStyleWithDrama` 解析 | `db/migrate.js:105`，`utils/dramaStyleMerge.js:52` |
| 段时长 `Math.max` 只抬下限；1–120 通用夹逼；各模型时长上限散落在 videoClient 请求时 | `episodeStoryboardService.js:413-415`；`videoClient.js:604,1818,2105,2510,3488,3874` |
| 无统一模型能力表；参考图/prompt 长度上限散落 | `videoClient.js:87,900,2218`；`FilmCreate.vue:6170` |
| 已支持三家目标模型的调用通道：Seedance 2.x（`volcengine`/`volcengine_omni`）、MiniMax H3、Wan（DashScope wan2.2-kf2v / wan2.6-t2v,i2v,r2v / wanx2.1-vace） | `videoClient.js:26-153,634,1635-1741,3874` |
| 已有成片合成（ffmpeg concat）、字幕烧录（subtitles 滤镜）、TTS 混音；无 BGM 混音 | `videoMergeService.js:134-185,281`；`mergedEpisodePostProcess.js:167,280,337-351` |
| 角色已有四视图设定卡；`characters.stages`（多阶段造型 JSON）有存储无消费；场景只有四宫格/单图 + `extra_images`，无状态版本 | `characterLibraryService.js:46,324,452`；`migrate.js:206`；`sceneService.js:150-379` |
| 当前视频请求不含任何负向约束/尾注；口型只出现在台词拆分模板；朝向写法是画面相对位置 | `episodeStoryboardService.js:1528-1549`；`promptI18n.js:485,491,575` |
| Wan `wanx2.1-vace-plus` / `wan2.6-r2v-flash` 用 `rawRefs.map(toImageInput)` 映射异步函数未 await，数组元素是 Promise，序列化为 `{}`，参考图实际未送达 | `videoClient.js:1669,1730,1740` |
| Wan `wan2.6-t2v` 与 `wanx2.1-vace-plus` 写死 `size:'1280*720'`，Wan 分支不接收 ratio，竖屏剧得到横屏片 | `videoClient.js:1710-1735,4185-4196` |
| `jimengMaterialHubService` 是第三方 Seedance2 角色资产托管（silvamux），与即梦 CLI 无关 | `jimengMaterialHubService.js:78,216` |
| `jimeng-novel` 1.0.8 已安装且登录；`compose`/`frames` 是本地 ffmpeg 封装，不读创作文件、不花积分 | `jimeng-novel --version`、`status -j`、`compose --help` |
| 即梦 `node run` / `node result` 返回的外层 `data.items[]` 形状未经实测（报告按惯例推断） | 即梦能力报告 §5.4/§5.5 |
| `jimeng-drama` skill 发布包无许可证文件，README 禁止拆出单独复制 | `~/.local/share/jimeng-novel/releases/.../README.md` |
| 本仓库为公开 GitHub fork（`pyinx/LocalMiniDrama`），MIT | `gh repo view`，`LICENSE` |
| 基线：后端 148、前端 29 个测试全部通过（16a32d4） | `node --test` 实跑 |
| 分镜可被前端与应用内助手编辑（允许字段含 dialogue/action/duration/shot_type/movement/characters/scene_id/universal_segment_text） | `storyboardService.js:87-90`；`mastra/index.mjs:128-134` |
| 导出按字段逐个映射分镜，无 IR；无造型/场景状态 | `dramaExportService.js:274-281` |
| 删除角色、按集重新生成角色会软删角色 | `characterLibraryService.js:345`；`characterGenerationService.js:114` |
| 重新生成分镜会软删该集全部旧分镜 | `episodeStoryboardService.js:651,894` |
| `POST /videos` 先插入行、`setImmediate` 调度生成、立即返回 201 | `routes/videos.js:63-73`；`videoService.js:472` |
| `provider_task_id` 在 `callVideoApi` 返回后才写入；重启时无 task id 的进行中行被标失败 | `videoService.js:437-452,577-580` |
| `linkTailFrame` 是 Express 处理器，直接写下一条分镜的 `first_frame_image_id` | `tailFrameLinkService.js:9-11,152-158` |
| 按音频拆分分镜、批量推断参数两条路径绕过 `updateStoryboard` 直接写分镜字段 | `episodeStoryboardService.js:1603-1660`；`routes/storyboards.js:374,1067-1083` |
| 成片已有 `burn_dialogue_audio`（逐分镜台词 TTS 混音） | `mergedEpisodePostProcess.js:202-206,245` |
| `characters.voice_style` 已存在，贯穿生成、导入与 DTO | `characterGenerationService.js:139-175`；`dramaImportService.js:187` |
| Wan 请求体带 `prompt_extend:true`（服务端改写 prompt） | `videoClient.js:1710-1745` |
| omni 模式下后端丢弃首/尾帧（DashScope 除外）；参考图由前端传入 | `videoService.js:563-565`；`FilmCreate.vue:6150-6577` |

## Decisions

| # | Decision | Choice | Date |
|---|---|---|---|
| D1 | "免费"的含义 | 即梦积分可作为**可选**后端；主链路不依赖即梦 | 2026-11-18 |
| D2 | 目标视频模型 | Seedance 2.x、MiniMax H3、阿里 Wan 三家，分别定向优化 | 2026-11-18 |
| D3 | 设计取向 | 通用设计而非逐例特判；尽量借鉴/集成即梦 | 2026-11-18 |
| D4 | 质量验收方式 | 只做结构检查，不花生成费 | 2026-11-18 |
| D5 | 交付节奏 | 一次做完整条链路（单个变更，内部按任务顺序推进） | 2026-11-18 |
| D6 | 剧本层 | 算在范围内，放在视频链路之后 | 2026-11-18 |
| D7 | 存量数据 | 新旧并存，按需重编译，不自动迁移 | 2026-11-18 |
| D9 | Wan 两个缺陷纳入验收 | 新增 AC21（参考图送达）、AC22（尺寸随比例），用户在 gate 1 之后明确要求加入 | 2026-11-18 |
| D8 | 即梦免费路径实测 | 允许在用户即梦账号上真实执行 init / node create / credit estimate，跑完删除测试画布；run/result 仍只用夹具 | 2026-11-18 |
| D10 | 有 IR 的分镜以谁为准 | IR 为唯一来源；旧字段由 IR 投影且只读；结构化编辑器 + 助手工具改为编辑 IR | 2026-11-18 |
| D11 | 非原生人声模型的台词 | 逐句 TTS 按时间轴混音；prompt 写说话人闭口/背对/画外 | 2026-11-18 |
| D12 | 补充范围 | 纳入：整集层面检查、道具参考图与道具状态、群像图、首尾帧模式、场景反打；不纳入：审片清单/重拍、即梦样片转成片 | 2026-11-18 |
| D13 | 需求修正（方案复查 R2/R3/R6/C3/C4） | 同意：导出导入、级联删除、编译期时长校验、前端逻辑抽工具函数测试 + 界面状态由评审判定、即梦实测用独立命令 | 2026-11-18 |
| D14 | 第二轮独立评审（30 条）处理 | 事实性修正与补充验收按推荐方案并入（AC34–AC40 及若干 AC 扩展）；角色设定图版式、防抄袭阈值待用户决定 | 2026-11-18 |
| D15 | 设定图版式与防抄袭阈值 | 新造型用"只留一张清晰脸"版式（正面全身糊脸、背面、一张面部特写；布局文字自写），旧四视图保留；AC18 阈值为连续重合 15 字，误报用经评审的白名单 | 2026-11-18 |
| D16 | 即梦实测登录过期 | AC20 判为未通过并提示重新登录后重跑，不算延期 | 2026-11-18 |

## Assumptions

| # | Assumption | Impact if wrong |
|---|---|---|
| A1 | 即梦针对 Seedance 的写法规则迁移到 MiniMax H3 / Wan 后不会让画面变差 | 上线后才发现某模型变差；缓解：新旧并存，可按集退回旧链路 |
| A2 | 三家模型的能力上限（时长/参考数/prompt 长度/是否原生人声）能从现有代码常量 + 官方文档确定；查不到的字段标"未知"并取保守值 | 上限取错 → 请求被拒或被截断；原生人声判断错 → 口型句式白写或台词丢失 |
| A3 | 字幕时间轴按分镜结构计划时长生成（不调付费 `transcribe`），与实际口播有偏差可接受 | 字幕明显错位；需改为人工微调或后续接识别 |
| A4 | prompt 检查器：硬上限（时长/参考数/长度/别名未绑定）阻断提交；写法类问题（代词指代、禁写词等）只警告 | 若用户要求更严或更松，调整严重级别即可（可逆） |
| A5 | 即梦渲染器的 `node run`/`node result` 解析按报告推断形状编写，只用夹具测试；首次真实运行时需核对 | 首次付费运行可能解析失败；不会重复扣费（只查不重提） |
| A7 | 能力表中"是否原生人声"未知的模型按非原生处理（走 TTS） | 若其实原生出声，会出现模型人声与 TTS 叠音；能力表改一个字段即可修正 |
| A8 | `wan2.6-r2v-flash` 支持尺寸参数；实现时按官方文档核对，若不支持则竖屏剧在发请求前报错（不静默出横屏） | 若不支持，竖屏剧不能用 r2v |
| A9 | 自写的固定句式（口型、尾注、参考说明句）与即梦原措辞效果相当 | 未经实测（D4）；措辞可调 |
| A6 | 资产矩阵新增的造型/场景状态图片生成沿用现有生图通道，不新增生图供应商 | 无 |

## Open questions

（无；原问题已转为 D8）

## Acceptance criteria

| # | Criterion | How it is verified | Required commands | Tests |
|---|---|---|---|---|
| AC1 | MiniMax H3 带 1–9 张参考图、比例 9:16 时请求体含 `ratio:"9:16"`；首尾帧模式与纯文生的既有行为不变 | 单测断言请求体 | `test` | `backend-node/test/minimaxH3.test.js::sends ratio with reference images` |
| AC2 | 动漫风格剧的视频风格行不含"真人写实"；写实风格剧仍含写实描述；LLM 规格文本不再强制"真人写实" | 单测对两种风格分别生成风格行；断言 promptI18n 规格 | `test` | `backend-node/test/universalStyleLine.test.js::anime drama has no realistic tag`、`backend-node/test/universalStyleLine.test.js::realistic drama keeps realistic tag` |
| AC3 | 任一目标模型下，规划出的段时长落在该模型 [min,max] 内且按 step 对齐；段内各分镜整数秒之和等于段时长；超上限的内容被拆成多段而非截断 | 单测覆盖下限、上限、刚好等于上限、超上限拆段 | `test` | `backend-node/test/segmentPlanner.test.js::clamps to model envelope`、`backend-node/test/segmentPlanner.test.js::splits overflow into new segment` |
| AC4 | 能力表对 Seedance 2.x、MiniMax H3、Wan（各已接入型号）、即梦视频模型返回时长/参考图/prompt 长度/比例/首尾帧/原生人声字段；未知模型返回保守默认并带 `unknown` 标记；videoClient 的上限取自能力表 | 单测逐模型断言；grep 断言原散落常量已改为引用 | `test` | `backend-node/test/modelCapabilities.test.js::known models`、`backend-node/test/modelCapabilities.test.js::unknown model is conservative` |
| AC5 | 新链路生成的分镜段持久化为结构化表示并通过 schema 校验；校验失败返回明确错误且不发出视频请求；编译与检查在 `POST /videos` 插入行之前同步完成，阻断时同步返回 `422 segment_compile_blocked` 且不插入行；编译结果写入该生成记录，异步生成不再二次编译 | 单测：合法/缺字段/非法时长 | `test` | `backend-node/test/segmentIr.test.js::valid ir`、`backend-node/test/segmentIr.test.js::invalid ir rejected before request` |
| AC6 | 分段装箱：台词耗时按字数计算（含换人停顿）决定段时长下限；对白条数不超过时长对应容量；≤8s 段至多 1 次硬切、≤15s 至多 3 次；每段叙事事件数满足下限（≥1；≥10s 时 ≥2；≥15s 时 ≥3），开场与集尾钩子单独成段 | 单测用固定台词样例 | `test` | `backend-node/test/segmentPlanner.test.js::duration from dialogue`、`backend-node/test/segmentPlanner.test.js::dialogue capacity`、`backend-node/test/segmentPlanner.test.js::hard cut cap`、`backend-node/test/segmentPlanner.test.js::event minimum`、`backend-node/test/segmentPlanner.test.js::hooks isolated` |
| AC7 | 每个目标模型的编译结果满足：风格句恰好一次且在首段；每个绑定参考恰有一句说明且顺序与参考列表一致；正文中出现的每个参考别名都已绑定；每个说话角色带口型写法、同框不说话者标闭口（仅对能力表标为原生人声的模型；非原生/未知模型改写为说话人闭口、背对或画外，台词交给 AC27）；每个分镜含景别、机位、出镜角色的绝对朝向与视线落点；尾注按模型能力生成；请求体的音频开关由能力表推导，与口型写法一致；每个角色在每段首次开口时写入其音色描述（来自 `voice_style`），全剧逐字一致；Wan 族对 IR 请求关闭 `prompt_extend`；参考说明句按 角色 > 场景 > 道具 > 其他 的顺序输出（与截断优先级分开） | 每模型一组快照外的结构断言（解析编译产物逐条检查） | `test` | `backend-node/test/promptCompilers.test.js::seedance structure`、`backend-node/test/promptCompilers.test.js::minimax_h3 structure`、`backend-node/test/promptCompilers.test.js::wan structure`、`backend-node/test/promptCompilers.test.js::jimeng structure`、`backend-node/test/promptCompilers.test.js::audio flag follows caps`、`backend-node/test/promptCompilers.test.js::voice description identical across segments`、`backend-node/test/promptCompilers.test.js::wan disables prompt_extend` |
| AC8 | 编译结果超出模型 prompt 长度时按优先级裁剪（先动作细节、再氛围；不删镜头语言、台词与约束）；参考图超出上限时按 场景 > 主角造型 > 次要角色 > 道具 排序截断；裁剪后仍超限则拒绝并报错 | 单测：超长、刚好上限、无法裁剪三种 | `test` | `backend-node/test/promptCompilers.test.js::trims to max length`、`backend-node/test/promptCompilers.test.js::orders and caps references`、`backend-node/test/promptCompilers.test.js::rejects when untrimmable` |
| AC9 | prompt 检查器对禁写项给出带位置的告警：用代词回指角色、"接上一段/同上"、淡出/入黑/暗角、正文写字幕或 BGM、图像质量词（8K 等）、分数式占比、否定式排除；硬上限问题为阻断级 | 单测逐条命中与不误报样例 | `test` | `backend-node/test/promptLint.test.js::flags each banned pattern`、`backend-node/test/promptLint.test.js::clean prompt has no findings` |
| AC10 | 旧分镜行为不变：未重新生成的分镜仍用原 prompt 路径；对某集重新生成分镜后改走新链路；两者可共存于同一部剧 | 集成测试：内存库中新旧两集分别取视频 prompt | `test` | `backend-node/test/pipelineCoexistence.test.js::old storyboard keeps legacy prompt`、`backend-node/test/pipelineCoexistence.test.js::regenerated episode uses compiler` |
| AC11 | 角色可有多个造型，每个造型有独立设定图；派生造型的生图请求以基础造型设定图为参考；`characters.stages` 既有数据可读入为造型；新造型设定图为"只留一张清晰脸"版式（正面全身脸部遮蔽、背面全身、一张清晰面部特写），提示词断言只有一处要求清晰面部 | 单测 + 迁移测试 | `test` | `backend-node/test/characterWardrobes.test.js::variant references base sheet`、`backend-node/test/characterWardrobes.test.js::stages migrate to wardrobes`、`backend-node/test/characterWardrobes.test.js::wardrobe sheet has exactly one clear face clause` |
| AC12 | 场景可有多个状态版本与竖屏主机位版本；竖屏版生图请求以 16:9 母版为参考；分镜段按"造型""场景状态"绑定参考图，视频请求携带对应图片 | 单测 | `test` | `backend-node/test/sceneStates.test.js::portrait version references master`、`backend-node/test/segmentIr.test.js::binds wardrobe and scene state images` |
| AC13 | 成片：按分镜结构生成台词 SRT（每行 ≤12 字、os/vo 斜体）与字卡 SRT；BGM 混音音量低于台词；ffmpeg 无字幕滤镜时降级软字幕并返回原因；输出接缝拼图与每秒抽帧拼图 | 用 ffmpeg 生成的合成小片段做集成测试；无 ffmpeg 时跳过并标注 | `test` | `backend-node/test/episodeCompose.test.js::srt from segments`、`backend-node/test/episodeCompose.test.js::bgm under dialogue`、`backend-node/test/episodeCompose.test.js::soft subtitle fallback`、`backend-node/test/episodeCompose.test.js::seams and frames sheets` |
| AC14 | 可提取前一段尾帧作为下一段衔接参考；只用于同场景版本、有共同主角的紧邻段；被依赖段的视频缺失或比尾帧新时阻断（尾帧过期）；尾帧写入走 IR 编辑（`continuity.first_frame_image_id`），不直接写分镜列 | 单测（规则）+ ffmpeg 集成（取帧） | `test` | `backend-node/test/continuityRef.test.js::tail frame only for same scene state`、`backend-node/test/continuityRef.test.js::extracts last frame`、`backend-node/test/continuityRef.test.js::stale tail frame blocks`、`backend-node/test/continuityRef.test.js::tail frame written through ir` |
| AC15 | 即梦后端：未安装或未登录时状态接口报告不可用及原因，渲染请求被拒（不调用 CLI），其他协议链路不受影响 | 单测（模拟 CLI 缺失/未登录） | `test` | `backend-node/test/jimengNovelRenderer.test.js::unavailable when missing`、`backend-node/test/jimengNovelRenderer.test.js::unavailable when logged out` |
| AC16 | 即梦后端：提交前必须有与当前节点配置一致的报价且用户确认；配置变化后旧确认失效；`SUBMISSION_UNKNOWN`/超时只查结果不重提；同一 key 重复点击不产生第二次提交；参考图 URL 先落成本地绝对路径；确认 token 一次性使用，提交失败或被拒后需重新报价；节点 key 在调用 `node run` 之前写入生成记录，进程在提交后崩溃、重启后只轮询不重提；同一分镜重新渲染使用新的 run 标识轮询，不读到上一次结果 | 夹具驱动的单测（模拟 CLI 输出） | `test` | `backend-node/test/jimengNovelRenderer.test.js::requires matching estimate`、`backend-node/test/jimengNovelRenderer.test.js::stale confirmation rejected`、`backend-node/test/jimengNovelRenderer.test.js::never resubmits unknown`、`backend-node/test/jimengNovelRenderer.test.js::repeat click single submit`、`backend-node/test/jimengNovelRenderer.test.js::refs become local paths`、`backend-node/test/jimengNovelRenderer.test.js::consumed token cannot resubmit`、`backend-node/test/jimengNovelRenderer.test.js::crash after submit polls not resubmits`、`backend-node/test/jimengNovelRenderer.test.js::rerender polls new run` |
| AC17 | 剧本层：分集剧本生成提示遵循自写规则（开场冲突、集尾钩子、台词短句、可拍性）；剧本体检返回结构化报告（硬门槛 + 分维度评分 + 具体问题），不自动改写剧本 | 单测：格式解析、台词字数统计、报告 schema | `test` | `backend-node/test/scriptReview.test.js::parses script format`、`backend-node/test/scriptReview.test.js::report schema`、`backend-node/test/scriptReview.test.js::no auto rewrite` |
| AC18 | 仓库内新增的规则文本不包含即梦 `jimeng-drama` 文件中任意连续 15 字以上的原文（白名单仅收常见通用短语，白名单文件本身经评审） | 脚本对比新增文本与本机即梦 references（缺失时跳过并标注） | `test` | `backend-node/test/noVerbatimJimeng.test.js::no 15-char overlap`、`backend-node/test/noVerbatimJimeng.test.js::detector flags a 15-char quote and ignores 14 chars` |
| AC19 | 全部既有测试保持通过，前端可构建 | 运行全量测试与构建 | `test`, `build` | review |
| AC21 | Wan `wanx2.1-vace-plus`（≤3 张）与 `wan2.6-r2v-flash`（≤5 张）的请求体中，每张参考图都是可用的图片输入（http(s) URL 或 `data:` base64 字符串），数量与输入一致；本地/localhost 图片转为 base64；无参考图时仍在发请求前报错 | 用伪造 fetch 截获请求体断言 | `test` | `backend-node/test/wanDashscope.test.js::vace sends resolved reference images`、`backend-node/test/wanDashscope.test.js::r2v sends resolved reference images`、`backend-node/test/wanDashscope.test.js::errors without references` |
| AC22 | Wan 接收尺寸参数的模型（`wan2.6-t2v`、`wanx2.1-vace-plus`）按目标比例选用该模型支持的尺寸：9:16 → 竖屏尺寸，16:9 → `1280*720`；目标比例不受支持时在发请求前报错，不再静默出横屏；`wan2.6-r2v-flash` 同样按比例下发尺寸（A8） | 用伪造 fetch 截获请求体断言 | `test` | `backend-node/test/wanDashscope.test.js::portrait ratio yields portrait size`、`backend-node/test/wanDashscope.test.js::landscape ratio keeps 1280x720`、`backend-node/test/wanDashscope.test.js::unsupported ratio rejected before request`、`backend-node/test/wanDashscope.test.js::r2v portrait size` |
| AC23 | 有 IR 的分镜：旧文本字段（dialogue/action/duration/shot_type/movement/characters/scene_id/universal_segment_text）在保存 IR 时由 IR 投影写入；对这些字段的通用更新返回 `409 segment_ir_owned` 且不改数据；通过 IR 编辑接口修改后投影同步更新；应用内助手的分镜修改工具对 IR 分镜改走 IR 编辑；无 IR 的分镜行为不变；通用更新中投影字段值未改变时照常接受（兼容前端整对象保存），值改变才 409；按音频拆分与批量推断参数对 IR 分镜同样返回 409 | 单测 + 内存库集成测试 | `test` | `backend-node/test/segmentIrOwnership.test.js::legacy fields are projected`、`backend-node/test/segmentIrOwnership.test.js::generic update rejected for ir storyboard`、`backend-node/test/segmentIrOwnership.test.js::ir edit reprojects`、`backend-node/test/segmentIrOwnership.test.js::agent tool edits ir`、`backend-node/test/segmentIrOwnership.test.js::legacy storyboard update unchanged`、`backend-node/test/segmentIrOwnership.test.js::unchanged projected fields accepted`、`backend-node/test/segmentIrOwnership.test.js::split by audio rejected for ir storyboard`、`backend-node/test/segmentIrOwnership.test.js::batch infer rejected for ir storyboard` |
| AC24 | 导出再导入一部剧后，分镜 IR、角色造型、场景状态、道具状态及其图片完整保留，IR 中的角色/造型/场景/道具 id 正确重映射；旧版导出包（无这些数据）仍可导入 | 内存库往返测试 | `test` | `backend-node/test/dramaExportRoundtrip.test.js::ir and variants survive roundtrip`、`backend-node/test/dramaExportRoundtrip.test.js::ids remapped in ir`、`backend-node/test/dramaExportRoundtrip.test.js::legacy package imports` |
| AC25 | 删除角色/场景/道具（含按集重新生成角色）时其造型/状态随之软删；引用已删除对象的 IR 在编译时给出阻断级问题，不静默丢参考 | 单测 | `test` | `backend-node/test/variantCascade.test.js::character delete cascades wardrobes`、`backend-node/test/variantCascade.test.js::scene and prop delete cascade`、`backend-node/test/variantCascade.test.js::ir referencing deleted asset blocks compile` |
| AC26 | 编译时按当前目标模型校验段时长：超出上限或低于下限返回阻断级问题并提示重新规划，不截断、不发请求 | 单测（30s IR 编译到 15s 上限模型） | `test` | `backend-node/test/promptCompilers.test.js::blocks when duration outside current model envelope` |
| AC27 | 非原生人声/未知模型：成片时按 IR 台词逐句合成语音，起始时间 = 段起点 + 所在分镜起点，单句超出分镜时长时变速至不超过上限（≤1.25x）否则告警；os/vo/画外按角色音色；原生人声模型不重复合成；IR 剧集的逐句台词轨替代旧的 `burn_dialogue_audio`，两者不同时混入 | 用假 TTS 与 ffmpeg 合成样片做集成测试；无 ffmpeg 时跳过并标注 | `test` | `backend-node/test/dialogueTts.test.js::line timing from ir`、`backend-node/test/dialogueTts.test.js::overlong line tempo capped`、`backend-node/test/dialogueTts.test.js::native audio model skips tts`、`backend-node/test/dialogueTts.test.js::ir episode does not double mix dialogue` |
| AC28 | 整集检查：开场段前 3 秒无叙事事件、相邻段主运镜相同、同一场景各段环境声描述不一致、尾帧依赖链超过两轮——各给出带段号的告警；判定依据为 IR 字段 `shots[].event` 与段级 `main_move`，尾帧依赖链只按 `continuity.tail_ref_from` 计算；同场景的持续道具外观、站位锁、轴线锁、环境声取自剧集级连续性表，逐字一致 | 单测（逐条命中与不误报） | `test` | `backend-node/test/episodeLint.test.js::flags each episode rule`、`backend-node/test/episodeLint.test.js::clean episode has no findings` |
| AC29 | 道具可作为参考图绑定进 IR，道具可有状态变体（以初始状态图为参考派生）；群像以独立资产生成（一张图 2–4 个不同个体）并可绑定；参考排序为 场景 > 主角造型 > 次要角色 > 群像 > 道具 | 单测 | `test` | `backend-node/test/propAndCrowdRefs.test.js::prop state references initial image`、`backend-node/test/propAndCrowdRefs.test.js::crowd asset binds`、`backend-node/test/propAndCrowdRefs.test.js::reference order` |
| AC30 | IR 设为首尾帧模式时：编译结果不含普通参考与参考说明句、别名改为纯文字名、只携带首/尾帧；目标模型不支持首尾帧时阻断。场景可生成反打版本（以母版为参考，提示词要求换成另一面墙），并可被 IR 绑定 | 单测 | `test` | `backend-node/test/promptCompilers.test.js::first last frame mode`、`backend-node/test/promptCompilers.test.js::first last frame unsupported blocks`、`backend-node/test/sceneStates.test.js::reverse version references master` |
| AC31 | 前端新逻辑抽为可测试的工具函数：编译告警分级展示规则、即梦可用性→选项禁用、报价确认状态机（未报价/已报价/已确认/配置变化失效/提交中）、IR 结构化编辑的表单↔IR 转换 | 前端单测 | `test` | `frontweb/test/segmentUi.test.js::finding levels`、`frontweb/test/segmentUi.test.js::jimeng availability disables option`、`frontweb/test/segmentUi.test.js::estimate confirmation state machine`、`frontweb/test/segmentUi.test.js::ir form roundtrip` |
| AC32 | 界面可见状态：IR 分镜的结构化编辑器、编译预览与阻断提示、即梦不可用时选项置灰并显示原因、报价确认弹窗、造型/场景状态/道具状态/群像编辑、成片新选项、剧本体检报告——由独立评审在运行中的应用里逐项确认；另含整集检查面板、重新规划入口、整集报价确认 | 评审 | `build` | review |
| AC33 | 旧的通用分镜生成/润色接口对有 IR 的分镜返回 `409 segment_ir_owned`，不改写 `universal_segment_text` | 单测 | `test` | `backend-node/test/segmentIrOwnership.test.js::universal polish rejected for ir storyboard` |
| AC34 | 即梦整集报价：一次报出所选分镜的总价与余额，生成一个覆盖这些节点的一次性 token；任一节点配置变化使 token 失效 | 夹具单测 | `test` | `backend-node/test/jimengNovelRenderer.test.js::episode estimate single token`、`backend-node/test/jimengNovelRenderer.test.js::batch token invalid after config change` |
| AC35 | 四个写法族之外的协议（Vidu、Kling、Agnes 等）对 IR 分镜走通用编译族（只用能力表与通用规则）；通用族也满足 AC8/AC9/AC26 | 单测 | `test` | `backend-node/test/promptCompilers.test.js::generic family for other protocols` |
| AC36 | `POST /episodes/:id/replan`：按当前模型重新规划 IR 分镜，拆出的段按顺序重编号；被拆分段已绑定的视频/图片保留在原段（新段为空），返回变更清单；对旧分镜无效 | 内存库集成测试 | `test` | `backend-node/test/segmentPlanner.test.js::replan renumbers and keeps bindings` |
| AC37 | 台词保真：IR 台词与该集剧本比对，缺句、改字、换说话人给出告警（剧本为旧格式自由文本时只做模糊匹配并标注） | 单测 | `test` | `backend-node/test/promptLint.test.js::dialogue fidelity against script` |
| AC38 | 风格句派生：由剧风格得到视频风格句与资产风格句（后者去掉环境光倾向）；风格句混用写实与动漫语汇时告警 | 单测 | `test` | `backend-node/test/universalStyleLine.test.js::asset style sentence`、`backend-node/test/universalStyleLine.test.js::mixed vocabulary flagged` |
| AC39 | 剧集级连续性表：每集每场景一份（持续道具、站位锁、轴线锁、环境声），编译器逐字取用；修改后该场景所有 IR 分镜的编译结果同步变化 | 单测 | `test` | `backend-node/test/promptCompilers.test.js::continuity table copied verbatim` |
| AC40 | 投影不含 `universal_segment_text`（它依赖 IR 之外的模型配置）；预览接口按当前配置即时编译展示 | 单测 | `test` | `backend-node/test/segmentIrOwnership.test.js::projection excludes compiled text` |
| AC20 | 在已登录的即梦账号上真实执行免费路径：建测试画布 → 用渲染器建一个视频节点（带一张本地参考图）→ 报价返回 `status==success` 且余额前后不变；结束后测试画布被删除（`canvas list` 不再包含）；即梦登录过期时用例失败并给出"请重新登录后重跑"，不判为通过或跳过 | 手动触发的实测用例（需 `JIMENG_LIVE=1`），默认测试套件不包含 | `test:live` | `backend-node/test/live/jimengFreePath.live.test.js::free path creates, estimates and cleans up` |

## Design

### Options considered

**1. 分镜意图放在哪里（决定全局形状）**

| 方案 | 做法 | 结论 |
|---|---|---|
| A 只改文本 | 继续让 LLM 直接写 `universal_segment_text`，再按模型对自由文本做正则改写 + 检查 | 否决：三模型定向编译需要可靠地拿到景别、朝向、台词说话人、参考别名，从自由文本里解析是脆弱的；AC5/AC7 无法稳定达成 |
| B 报告方案 | 新建 `uir_segments` 表 + renderer 抽象层 + 三张资产表 | 否决：`uir_segments` 与 `storyboards` 是一对一，段时长、段身份会有两个所有者需要同步（违反单一所有者）；renderer 抽象层与现有 `callVideoApi` 协议分发重复 |
| **C 选用** | 分镜行就是"段"（现有不变量：一条 storyboard = 一次视频请求）；在 `storyboards` 上加 `segment_ir` JSON 列作为该段的结构化意图；由后端确定性编译器按目标模型编出 prompt 与参考图；即梦作为 `callVideoApi` 的一个新协议分支 | 胜出：沿用现有段身份与协议分发；`segment_ir` 为空即旧链路，新旧并存天然成立（AC10）；编译放后端，是唯一知道实际协议/模型的地方 |

**2. 编译发生在哪里**：后端 `POST /videos` 路由内、插入生成记录之前（选用：唯一能同步返回 422/409 的位置；解析出实际配置与协议；编译结果写入生成记录，`processVideoGeneration` 直接使用）vs 前端 `buildSbVideoPromptForApi`（否决：前端不知道最终模型，即梦分支也必须在后端）。前端只通过预览接口查看编译结果与告警。

**3. 造型/场景状态的存储**：扩展 `characters.stages` JSON（否决：没有稳定 id，分镜无法引用，图片无处挂）vs 新表 `character_wardrobes`、`scene_states`（选用：分镜 IR 按 id 引用；`stages` 列保留只读，迁移为造型行）。

**4. 即梦接入方式**：`jimeng-novel` CLI 子进程（选用：官方工具，报价免费，结果只查不重提）vs `jimeng_ai_api` 逆向网关（否决：违反条款，D1/Non-goals）vs `dreamina-canvas`（否决：无本地后期、协议更重，Non-goals）。

**6. 有 IR 的分镜以谁为准（D10）**：IR 唯一来源 + 旧字段投影只读（选用：真正单一所有者）vs 旧字段可改 + IR 标记过期（否决：两份数据，用户频繁被拦截）。

**7. 即梦 skill 级集成**：把 `jimeng-drama` 打包进应用内助手（否决：无许可证不可再分发；助手无命令行工具，只能当知识用）vs 方法论自写进编译器与规则（选用）。

**5. 校验库**：zod（选用，`backend-node/package.json` 已依赖 `zod ^4`）vs 手写校验（否决：IR 嵌套深，手写易漏）。

### Interfaces and data

**数据（全部为新增，旧代码忽略新列/新表即可回退）**

- `storyboards.segment_ir TEXT NULL`（SegmentIR JSON）、`storyboards.segment_ir_version INTEGER NULL`。有 IR 时 `storyboards.duration` 在保存 IR 的同一事务里由 `ir.duration_s` 写入（派生，不单独编辑）。
- `character_wardrobes(id, character_id, name, base_wardrobe_id NULL, change_phrase, prompt, image_url, local_path, episode_range, sort_order, created_at, updated_at, deleted_at)`；`base_wardrobe_id` 为空即基础造型。迁移：每个角色建一个基础造型（指向现有主图）；`stages` 每项建一个派生造型（`change_phrase` = `appearance`），`stages` 列保留不删。
- `scene_states(id, scene_id, name, kind 'master'|'state'|'portrait', parent_state_id NULL, state_phrase, prompt, image_url, local_path, sort_order, created_at, updated_at, deleted_at)`；迁移：每个场景建一个 master 指向现有主图。
- `global_settings` 不新增键；即梦后端通过 `ai_service_configs`（`service_type='video'`, `api_protocol='jimeng_novel'`, `settings.bin_path` 可选）启用，未配置即关闭。
- `prop_states(id, prop_id, name, parent_state_id NULL, state_phrase, prompt, image_url, local_path, sort_order, timestamps, deleted_at)`；`scene_states.kind` 增加 `'reverse'`；`characters.is_group INTEGER DEFAULT 0`（群像资产）；`characters.tts_voice TEXT NULL`（TTS 供应商的音色 id；与现有 `voice_style` 区分：`voice_style` 是音色文字描述，用作 prompt 里逐字复用的音色句）；`episodes.continuity_json`（剧集级连续性表，按 scene_id 分组）；`video_generations.compiled_json`（编译结果与 findings）、`video_generations.run_key`。
- 投影：保存 IR 时在同一事务写入 dialogue/action/duration/shot_type/movement/characters/scene_id（不含 `universal_segment_text`，编译文本只在预览时即时生成）。
- 级联：`deleteCharacter`/`characterGenerationService` 软删角色、删除场景/道具时，同一事务软删其变体。
- 导出/导入：导出包增加 `segment_ir` 与 `wardrobes`/`scene_states`/`prop_states` 数组及图片；导入时重映射 IR 中的 id；字段缺失按旧包处理。

**SegmentIR v1（zod 校验，LLM 输出在入库边界校验一次）**

```
{ version:1, duration_s:int,
  scene:{ scene_id, state_id|null, setting:string },
  main_move:string,
  tone:string,
  continuity:{ mode:'refs'|'first_last', first_frame_image_id?, last_frame_image_id?, tail_ref_from?:storyboard_id,
             },   // 持续道具/站位锁/轴线锁/环境声在 episodes.continuity_json，按 scene_id 取用
  cast:[{ character_id, wardrobe_id|null, alias, group?:boolean }],
  prop_refs:[{ prop_id, state_id|null, alias }],
  cards:[{ text, at_s:number, hold_s:number }],
  shots:[{ seconds:int, size, camera, cut:'hard'|'continuous', event:string|null,
           movement:{type,speed,direction}|null,
           subjects:[{ alias, frame_pos, facing, gaze, pose, holding|null }],
           action:string,
           lines:[{ kind:'dialogue'|'os'|'vo'|'offscreen', speaker|null, text, delivery, voice|null }],
           sfx:[string] }] }
```

**模块接口（均为纯函数，除标注外）**

| 模块 | 接口 | 隐藏了什么 |
|---|---|---|
| `services/modelCapabilities.js` | `getVideoCaps({protocol, model}) → {duration:{min,max,step}, refImages, maxPromptChars, ratios, sizes?, firstLastFrame, nativeAudio, unknown:boolean}` | 各模型上限的唯一来源；videoClient 的 normalize 函数改为读它 |
| `services/segmentIr/schema.js` | `parseSegmentIr(json) → {ok, ir} | {ok:false, errors}` | zod 结构 + 跨字段规则（秒数之和 = 段时长、别名唯一、台词说话人在 cast 内） |
| `services/segmentIr/planner.js` | `planSegments(irs, caps) → irs'` | 台词耗时计算、时长取整对齐、超限按镜头边界拆段、对白容量与硬切上限 |
| `services/segmentCompile/index.js` | `compileSegment(ir, {caps, family, style, bindings}) → {prompt, refs:[{alias,url,kind}], duration_s, findings:[{level,code,where,msg}]}` | 风格句、参考说明句、镜头行、口型/闭口、尾注、裁剪、参考排序截断；`family` ∈ seedance / minimax_h3 / wan / jimeng / generic；写法、音频开关、`prompt_extend` 等族策略在此 |
| `services/segmentCompile/lint.js` | `lintPrompt(text, ctx) → findings` | 禁写项规则；`level:'block'` 只用于硬上限与别名未绑定 |
| `services/segmentCompile/rules/` | 自写规则文本与词表 | 全部自写，AC18 守护 |
| `services/jimeng/cli.js`（端口） | `runJimeng(args, {cwd, timeoutMs}) → {status, data, error}` | 第一个异步子进程集成：`execFile` 参数数组（无 shell）、超时、JSON 信封解析、错误码映射；测试注入假 runner |
| `services/jimeng/renderer.js` | `status()`、`estimate(storyboardIds[])`、`submit(storyboardId, confirmation)`、`poll(generationId)` | 画布绑定（每部剧一个 `.jimeng/`）、节点 key `E{集}/S{分镜}`、提交前先写 `provider_task_id`/`run_key`、一次性 token、参考图落地为存储根内的绝对路径、只查不重提 |
| `services/segmentIr/project.js` | `projectLegacyFields(ir, ctx) → {dialogue, action, ...}` | IR → 旧字段投影，唯一写入点 |
| `services/segmentCompile/episodeLint.js` | `lintEpisode(irs, caps) → findings` | 整集规则（AC28） |
| `services/dialogueTtsService.js` | `buildDialogueTrack(episodeIrs, {ttsCfg, caps}) → {audioPath, warnings}` | 逐句合成、按时间轴放置、变速上限（AC27）；复用 `ttsService.synthesize` |
| `utils/storagePaths.js` | `toLocalPath(urlOrPath)`、`assertInsideStorage(abs)` | URL→存储根内绝对路径（即梦 `file:` 与 TTS 共用） |

**HTTP（新增，均在 `/api/v1`）**

- `POST /storyboards/:id/compile-preview` `{config_id?}` → `{prompt, refs, duration_s, findings}`；旧分镜（无 IR）返回 `409 legacy_storyboard`。
- `POST /videos` 不改请求形状；若分镜有 IR，后端忽略前端 prompt，用编译结果；存在 `block` 级问题时返回 `422 {code:'segment_compile_blocked', findings}`，不发请求。即梦分支额外要求 `jimeng_confirmation`。
- `GET /integrations/jimeng/status` → `{available, reason?}`（未安装 / 未登录 / 未配置）。
- `POST /episodes/:id/jimeng/estimate` `{storyboard_ids}` → `{confirmation:{token, items, total, balance, price_status}}`；token 一次性，绑定各节点配置哈希，任一变化即失效。
- `POST /episodes/:id/replan` → 按当前模型重新规划（AC36）。
- `GET/PUT /episodes/:id/continuity` → 剧集级连续性表（AC39）。
- 造型：`GET/POST /characters/:id/wardrobes`、`PUT/DELETE /wardrobes/:id`、`POST /wardrobes/:id/generate-image`；场景状态同构 `/scenes/:id/states`、`/scene-states/:id`。
- `POST /episodes/:episode_id/finalize` 的 `merge_options` 新增可选 `dialogue_subtitles:boolean`、`cards:boolean`、`bgm:{url, volume_db}`、`review_sheets:boolean`（缺省时行为与现在一致）。
- `POST /episodes/:id/script-review` → 结构化体检报告（zod 校验 LLM 输出）。
- `PUT /storyboards/:id/segment-ir` `{ir}` → 校验、规划、投影后返回分镜；`PUT /storyboards/:id` 对 IR 分镜改投影字段返回 `409 segment_ir_owned`；通用分镜生成/润色接口对 IR 分镜同样返回 409。
- `POST /videos`：有 IR 时 prompt、参考图、首/尾帧、生成模式全部来自编译结果，忽略前端传入值。
- 道具状态 `/props/:id/states`、`/prop-states/:id`；群像沿用角色接口（`is_group`）。

**兼容性**：全部扩展式（新列、新表、新可选字段）；旧分镜、旧接口行为不变；`stages` 列不删（收缩留给以后）。回退：旧版本代码忽略新列/新表，可直接回滚代码。

**安全与边界**：信任边界 = LLM 输出（IR、体检报告，zod 校验）、CLI 输出（信封校验）、用户提供的图片 URL。传给 CLI 的 `file:` 路径必须解析到存储根之内，否则拒绝；子进程用 `execFile` 参数数组，prompt 写入画布目录下文件后用 `--prompt-file`，不经 shell。资产 = 即梦积分：无匹配确认 token 不提交；同一节点 key 有进行中生成时拒绝第二次提交（`409`）。日志不记录 CLI 凭据与 token 原文。

**可观测性（要能回答的问题）**：某段为什么没发出去 → `video_generations.error_msg` 记录 `segment_compile_blocked` 与 findings 代码；即梦花了多少、是否经过确认 → 日志记录 estimate token 哈希、credits、run key；CLI 为什么失败 → 记录 `error.code`/`message`（脱敏）；字幕为什么没烧录 → 合成结果记录 `subtitles.method` 与降级原因。

### Reuse

| 需要 | 找到的现有实现 | 处理 |
|---|---|---|
| 协议分发、异步轮询、恢复轮询 | `videoClient.callVideoApi`/`pollVideoTask`、`video_generations.provider_task_id`、`resumeProcessingVideoGenerations` | 扩展：新增 `jimeng_novel` 分支，`provider_task_id` 存节点 key，恢复轮询走 `node result` |
| 多模型生图带参考图 | `imageClient.callImageApi` 已支持多家参考图；`createAndGenerateImage` 未透传 | 扩展：`createAndGenerateImage` 增加可选 `reference_image_urls` 透传 |
| 角色设定图 | `characterLibraryService.generateCharacterFourViewImage` | 旧四视图保留；新造型用自写的"只留一张清晰脸"版式（D15）；派生造型在其上加自写的变体前缀句 + 参考基础图 |
| 尾帧提取 | `tailFrameLinkService.linkTailFrame`（Express 处理器，直接写分镜列） | 抽出 ffmpeg 取帧为纯服务函数供两边复用；IR 分镜的写入走 IR 编辑（AC14） |
| 合成、字幕、混音 | `videoMergeService`、`mergedEpisodePostProcess.runMergedEpisodePostProcess`（含 `burn_dialogue_audio`） | 扩展：台词/字卡 SRT、BGM、滤镜探测降级、拼图；IR 剧集的逐句台词轨替代 `burn_dialogue_audio`；不重写 concat |
| ffmpeg 定位 | `utils/ffmpegPath.js` | 复用 |
| 音色描述 | `characters.voice_style` | 复用为 prompt 音色句；新增 `tts_voice` 只存供应商音色 id |
| 风格解析 | `utils/dramaStyleMerge.mergeCfgStyleWithDrama` | 复用为编译器风格句来源 |
| 校验 | `zod`（已依赖） | 复用 |
| 配置启用 | `ai_service_configs.api_protocol` + `AIConfigContent.vue` 协议列表 | 扩展一个协议选项 |
| 测试模式 | `test/helpers/agentTestDb.js`、替换 `global.fetch`（`volcOmniMultiReference.test.js`） | 沿用 |
| URL ↔ 本地路径 | 各服务各有一份（`videoMergeService.resolveVideoToLocalPath` 等），无共享实现 | 新增一个共享 `utils/storagePaths.js` 供本变更使用；不重构既有重复实现（报告为既有问题） |

`.harness/project.md` 能力地图原为自动草稿且有误（如把 Storage 指向 `mastra/model.mjs`），本次已按代码修正，需人工复核。

### Tasks

每一步结束时全量测试通过、应用可运行。

| # | Task | Files | Verification |
|---|---|---|---|
| T1 | 正确性修复：H3 ratio、Wan 参考图 await 与尺寸随比例（含 r2v）、风格行去强制写实（`promptI18n` 中英文两套同步改，保持一致性测试） | `videoClient.js`、`universalOmniMultiBeatFormat.js`、`promptI18n.js` | AC1、AC2、AC21、AC22 |
| T2 | 模型能力表（含 nativeAudio，未知按非原生）；videoClient 上限改读能力表 | 新 `modelCapabilities.js`；`videoClient.js` | AC4 |
| T3 | 防抄袭守护测试 | 新 `test/noVerbatimJimeng.test.js` | AC18 |
| T4 | IR schema + 列迁移 + 投影 + 所有权（仅值变化才 409；IR 编辑接口、助手工具、旧润色/按音频拆分/批量推断对 IR 分镜拒绝） | 新 `segmentIr/schema.js`、`segmentIr/project.js`；`migrate.js`、`storyboardService.js`、`routes/storyboards.js`、`mastra/*` | AC5、AC23、AC33、AC40 |
| T5 | 段规划器 + 重新规划接口 | 新 `segmentIr/planner.js`、路由 | AC3、AC6、AC36 |
| T6 | 编译器（四写法族、首尾帧模式、裁剪、参考排序、编译期时长校验、引用失效阻断）+ 自写规则 | 新 `segmentCompile/*` | AC7、AC8、AC26、AC30（前半）、AC35、AC38、AC39、AC18 |
| T7 | 单段检查器 + 整集检查器 | `segmentCompile/lint.js`、`episodeLint.js` | AC9、AC28、AC37 |
| T8 | 接线：结构化分镜生成、`/videos` 路由内同步编译并写入生成记录、预览接口、剧集连续性表接口 | `episodeStoryboardService.js`、`promptI18n.js`、`videoService.js`、路由 | AC5、AC10 |
| T9 | 前端：工具函数（告警分级、IR 表单转换）+ 结构化编辑器、编译预览 | `frontweb/src/utils/segmentUi.js`、`FilmCreate.vue` 及子组件 | AC31（部分）、AC32 |
| T10 | 造型 + 群像：表/列、`stages` 迁移、生图参考透传、接口、前端 | `migrate.js`、`imageClient.js`、`characterLibraryService.js`、路由、前端 | AC11、AC29（群像） |
| T11 | 场景状态（含竖屏主机位、反打）与道具状态：表、生成、接口、前端；IR 绑定 | `sceneService.js`、`imageClient.js`、道具服务、路由、`segmentCompile` 绑定、前端 | AC12、AC29、AC30（后半） |
| T12 | 级联软删 | `characterLibraryService.js`、`characterGenerationService.js`、场景/道具服务 | AC25 |
| T13 | 成片：台词/字卡 SRT、BGM、滤镜探测降级、拼图；逐句 TTS 轨 | `mergedEpisodePostProcess.js`、`videoMergeService.js`、新 `dialogueTtsService.js`、`dramaService.finalizeEpisode`、前端 | AC13、AC27 |
| T14 | 衔接：取帧抽为纯函数、尾帧适用与过期规则、IR 写入 | `tailFrameLinkService.js`、规则函数 | AC14 |
| T15 | 导出/导入携带 IR 与变体 | `dramaExportService.js`、`dramaImportService.js` | AC24 |
| T16 | 即梦：CLI 端口、渲染器、状态/报价/提交/轮询、确认 token、幂等、路径约束、协议注册、前端确认弹窗（状态机抽工具函数） | 新 `services/jimeng/*`、`utils/storagePaths.js`、`videoClient.js`、路由、`AIConfigContent.vue`、`FilmCreate.vue` | AC15、AC16、AC34、AC31（部分） |
| T17 | 即梦免费路径实测 | 新 `test/live/jimengFreePath.live.test.js` | AC20（`test:live`） |
| T18 | 剧本层：自写分集规则、格式解析与台词计数、体检服务与接口、前端入口 | `promptI18n.js`、`storyGenerationService.js`、新 `scriptReviewService.js`、路由、前端 | AC17、AC18 |
| T19 | 收尾：全量测试 + 构建；独立评审（含界面逐项确认）；`hx check` | — | AC19、AC32 |

## Related

- `.harness/project.md` 能力地图（本次已据代码修正草稿）
- 即梦报告：`/Users/zyb/WorkBuddy/manju/reports/jimeng-capability-2026-11-18/即梦CLI能力面与集成契约.md`、`/Users/zyb/WorkBuddy/manju/reports/localminidrama-vs-jimeng-ep1/02_追平方案_即梦CLI集成.md`
