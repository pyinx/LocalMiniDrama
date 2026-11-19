# 调研证据 · 2026-11-19

## Baseline
| test | `cd backend-node && node --test test/*.test.js && cd ../frontweb && node --test test/*.test.js` | pass | c103623+99d5a76fabbabfa8 | 2026-11-19T05:16:35Z |

当前 `codex/drama-production-workbench` 工作树包含上一轮未提交的媒体诊断。对本次问题使用独立临时 SQLite 与媒体目录。源码回归使用 `cd backend-node && node --test test/workbench/multiProject.test.js test/mediaDiagnostics.test.js`。两套跨集项目、两镜交付与媒体测量等共 6 项通过。

## 同一输入的实验

用 FFmpeg 生成 A、B 两条各 2.00 秒、128 × 192、25 fps 的 H.264 MP4。A 为红色无音轨，B 为蓝色带 440 Hz 正弦音、48 kHz AAC。对照时保留 B 的原声，所有媒体在临时目录生成。

| 路径 | 操作 | 可核验结果 |
|---|---|---|
| 工作台正式交付 | 通过 HTTP 新建剧和两镜，为合成素材登记完成候选并分别采用，调用 `POST /episodes/:id/finalize`，指定 complete，不启用另行配音。轮询对应导出并使用 ffprobe 枚举流。 | 状态 completed。输出视频流 4.000 秒，未输出音轨。输入 B 明确有音轨。 |
| 即梦短剧 CLI 本地合成 | `jimeng-novel compose --clip A.mp4 --clip B.mp4 --trim A.mp4:0-1.5 --trim B.mp4:0.25-1.75 --clip-srt srt --no-burn --out cut.mp4`。B 的字幕在原片 0.50–1.00 秒。 | 输出视频流 3.040 秒（解码 76 帧，比名义 3.00 秒多一帧）、音频流 3.020 秒。解出字幕 1.750–2.250 秒。CLI 输出一处接缝拼图。于成片 0.25 秒、2 秒起各测 0.5 秒的平均音量，约 −91.0 dB 与 −24.1 dB，后段信号仍在。 |

比较用于验证裁剪、时码及音轨保留。色块和纯音无法评估动作匹配、对白节奏、剪点美感。四个开源项目的比较来自所列本地版本源码和 Skill；没有把它们的源码阅读当成四次成片实测。

## 对齐状态

最初调研完成后进行了独立方案评审，用户随后确认修订稿。阶段一和阶段二的实施验收见文末。

## 新清单的筛选和取舍

输入为[用户提供的中文项目清单](/Users/zyb/.workbuddy/skills/github-star-tools/reports/中文视频剪辑开源项目检索-2026-11-19.md)。去重得到 49 个仓库链接。先以“要接好的是已经采用的剧情镜头”初筛，排除录屏、GIF、移动 SDK、长视频切片等不同交付目标。对 15 个代表候选及一个关联的 Classic 仓库，读取远程默认分支提交、文件树，再选读共 20 个实现、Skill 或项目文档。以下链接固定到所读提交。本轮没有编译或运行这 16 个上游工程，没有将第三方代码或运行时写入工作台。

| 资料 | 实际看到什么 | 对工作台的决定 |
|---|---|---|
| [baocut 剪辑提案](https://github.com/JimLiu/baocut/blob/dc740b76af113b51999c7b6d124262524fa83c32/crates/video-model/src/editorial_proposal.rs) | 源时间区间、建议 ID、待采用与已采用状态；引用的转写版本发生变化时不能直接沿用旧建议。 | **吸收提案与生效剪口分离。** 我们绑定镜头、采用片与内容身份。口播的口癖、静音阈值不作为剧情片自动删减依据。 |
| [LosslessCut 关键帧判断](https://github.com/mifi/lossless-cut/blob/4c7ab1cb0c9acaefabb48e997bc909562dc3624d/src/renderer/src/smartcut.ts) | 精确命中关键帧可直接切；未命中则另作 Smart Cut 判断并查后续关键帧。 | **吸收“用户选定的帧必须兑现”。** 本地按条件使用现有流拷贝，其余走可验证的准确重编码。首版省去局部重编码再拼 GOP 的复杂度。 |
| [OpenCut 主仓](https://github.com/OpenCut-app/OpenCut/blob/e668010778568641babef2cc40be4703ae6916d6/README.md)、[OpenCut Classic 联动移动](https://github.com/opencut-app/opencut-classic/blob/cf5e79e919144200294fb9fed22a222592a0aeea/apps/web/src/ripple/apply.ts)、[Shotcut 时间线命令](https://github.com/mltframework/shotcut/blob/7f7fab384e422e3d01525e50146fdc41be718e06/src/commands/timelinecommands.cpp) | OpenCut 的重写与 Classic 是两个代码入口。Classic 按轨应用后续元素位移，Shotcut 有可撤回的时间线编辑命令。 | 作为时间联动和撤销的参照。我们的镜头顺序已确定，移动后续字幕和音轨可直接从裁后时间推导。 |
| [video-use 剪点检视](https://github.com/browser-use/video-use/blob/43cfc566833548093455c9d4a46bd69913b7e552/SKILL.md)、[乘风口播剪辑](https://github.com/Agentchengfeng/chengfeng-videocut-skills/blob/a33b43e08c34fa8beeb5e78498e852f4e80975a5/plugins/chengfeng-videocut/skills/chengfeng-cut/SKILL.md)、[video-shotcraft 成片终检](https://github.com/Vincentwei1021/video-shotcraft/blob/075b548c2405a07b77129eb448b0b504fc60dea3/references/final-review.md) | 前者提醒剪点要同时检查声画，叹气和笑声也可能是节拍；乘风面向口播，从转录、修字走到复核；shotcraft 对产品片要求按实际成片及简报验收。 | 在同一接缝有声 A/B，保留反应和气口，用完整作品做盲评。无需词级转写服务、产品模板或单独的评审 Agent。 |
| [FFmpeg Skill 的静音区间](https://github.com/kajisho5/ffmpeg-skill/blob/096ba4044e10b8dd9879a391d0114b17083abc11/scripts/silence.py)、[Auto-Editor 的自动剪切](https://github.com/WyattBlue/auto-editor/blob/38efa1727635beee8a03ee29278ddce901e40e78/README.md)、[PySceneDetect 画面变化探测](https://github.com/Breakthrough/PySceneDetect/blob/8a0b5cea50fef0bc216fb230c7010556dcf5010e/scenedetect/detectors/content_detector.py) | 可列静音区间并保留边距，或依据能量、颜色与亮度变化标出剪切候选。 | 测量值可帮助定位。安静、低运动、画面突然变亮都不能单独说明表演无用；工作台本就知道镜头边界。新增检测器优先级低。 |
| [OpenMontage 的节奏校验样例](https://github.com/OpenMontageInc/OpenMontage/blob/2e003e65fa99a0f329478a2c1cdcf26bc481933a/lib/verify_scene_pacing.py)、[HyperFrames 渲染 Skill](https://github.com/heygen-com/hyperframes/blob/c672ef0e5d03a9f7410db7352172bd8fc75ddde6/skills/hyperframes/SKILL.md)、[Editly 声明式合成](https://github.com/mifi/editly/blob/dc46674052eacd15ef6e0f563a58eb378b3804ad/README.md) | OpenMontage 此样例核对终端演示步骤与旁白 cue 的时序；HyperFrames 按帧渲染 HTML composition；Editly 提供声明式视频合成。 | 说明时间安排可以显式验证。现有 Node/FFmpeg 能完成本轮目标，引入另一套编排、浏览器渲染或合成框架的收益不足。 |
| [Concat 项目定位](https://github.com/jub0t/concat/blob/cf9e4eeea93ceee029c0f1e9159ff9417a629d7a/README.md)、[Palmier Pro 支持范围](https://github.com/palmier-io/palmier-pro/blob/dfc810b561f1692947eb81bbb689e078923ebb59/README.md) | Concat 定位于通用跨平台剪辑器；所读 Palmier 版本要求 Apple Silicon 和 macOS 26。 | 两者作为完整编辑产品有价值，用作本项目基础会扩大操作面或缩窄平台覆盖。 |

### 与此前项目如何分工

**技术底线**优先用 video-canvas 的逐段音轨归一解决已经复现的丢声。**剪法**采用即梦短剧 CLI 的逐段裁剪和字幕重排思路，参照 waoowaoo 的区间和声音裁剪。**导演判断**借 Toonflow 与即梦的同场动作进度、视线和跨场区分。火宝的缺镜定位可借，现有交付入口保留完整性检查。并行质量链负责结构化字幕、字卡、混音、拼图与同场尾帧规则。核查时结构化后期和对应测试仍在另一工作区，`9445e30` 不能充当这些能力的集成基线。[调研事实表](spec.md#facts)

### 现有运行时能否做对白后出的技术验证

在临时目录，用仓库随附的 macOS FFmpeg、ffprobe 制作同一对 A/B 合成镜头，比较同步硬切与音尾后出。A 的声音用 440 Hz 纯音作为可测标记，B 无音轨。两个版本都用 A 的前 37 帧、B 的前 38 帧，交付帧率 25 fps。同步版保留 A 的前 1.48 秒音频，后出版保留前 1.80 秒，尾部补静音。解码每帧核对红蓝画面顺序，再对解码 PCM 分窗测 RMS。

| 输出 | 画面实测 | 切画面后 1.55–1.70 秒处的声音 | 1.90–2.10 秒处 |
|---|---|---|---|
| 同步硬切 | 75 帧、3.00 秒，1.48 秒进入 B | 数字静音 | 数字静音 |
| 声音延续 8 帧 | 同为 75 帧、3.00 秒，1.48 秒进入 B | −21.1 dBFS，A 的测试音仍在 | 数字静音 |

实验说明现有运行时足以实现精确的画面切点和独立的声音尾点。它未测定真实对白效果，亦不代表正式产品已有这一入口。真人表演、混合原声中两个人声冲突、可变帧率、多次裁剪累计误差和跨机恢复需在实施阶段另验。

修订稿已将「自动组装、试剪须采用才生效」写为默认行为。下列独立评审表及登记记录保留评审当时的结论。

## Review

2026-11-19 独立方案审查。下表记录修订前评审时的判断，阻断项针对依赖它们的发布阶段。逐项设计回应见[评审意见处理](#评审意见处理)。

| # | Finding | Severity | Disposition | Where |
|---|---|---|---|---|
| R1 | 「按作者选择保声」有两条不同的失败路径。缺少音轨会使 concat 丢声；全部有原声时，只给一镜配音，旧后期仍会替换整集声音。应拆开 AC1，明确每镜原声、独立配音及显式静音的缺省和持久化，旁白/BGM 单列叠加策略；仅在可用声源内延续，保护另一镜对白。 | blocking | 已修复并验证 AC1、AC7 | [AC1](spec.md#acceptance-criteria) · [旧后期音轨选择](../../../backend-node/src/services/mergedEpisodePostProcess.js) |
| R2 | 方案所引提交 9445e30 没有结构化后期、逐句配音服务或相应合成测试，文件只存在于另一个工作区。应标清来源；首版依赖当前路径，结构化字幕、字卡、BGM、接缝图在可复现提交上做联调和验收。 | blocking | 两阶段已独立构建，结构化联调另验 AC9 | [已核事实与复用范围](spec.md#facts) |
| R3 | 「待复核」没有定义发布行为。A、B、C 中 B 损坏时草稿可直接播放 A、C，原来 A→B 的尾音不能被套到 C。建议接缝绑定相邻两个采用版本；仅在草稿中临时跳过并显示缺镜，完整交付维持缺镜阻断。若已采用剪法过期，保留已发布片，提示处理受影响接缝或明确恢复完整源段后再发。 | blocking | 缺镜、过期与撤回经 AC5 验证 | [预览、归档与恢复](spec.md#interfaces-and-data) · [草稿和正式交付路径](../../../backend-node/src/services/videoMergeService.js) |
| R4 | 阶段二宣称可独立提供有声对照、采用和恢复，但检查这些交互的 AC4 留到了阶段三。应拆出「试听、采用、复原、重开」，移入阶段二；声音延续保留独立验收。 | should-fix | AC4 已实测，声音延续留在 AC8 | [AC4 与阶段退出条件](spec.md#tasks) |
| R5 | 输出帧率缺省、可变帧率选帧和不足一个输出帧的保留区间，需要可测试的取舍。建议由系统选定稳定的交付规格并写进快照，预览和导出共用同一编译器；原版和试剪版分别编译自己的修订。对过短区间提示调整，验证混合帧率和多次裁剪后无累计偏移。 | should-fix | AC2、AC3 已实测 | [AC2 和时间映射](spec.md#interfaces-and-data) |
| R6 | 原顺剪与作者精剪的偏好比较能验证剪法，无法分辨智能建议的增益，也未验证新手操作。分开测试成片有声盲评、首次用户能否独立导出和恢复，以及同工具/同素材下建议开关对误剪、耗时和返工的影响。 | should-fix | 已拆分为三个试验，等待真人试点 | [AC6](spec.md#acceptance-criteria) |
| I1 | 可变帧率长帧跨越入点时，后续画面提前。 | blocking | 已按真实源时刻放置长帧尾点，逐帧比对试听和交付。 | [剪点媒体回归](../../../backend-node/test/episodeEdit.test.js) |
| I2 | 省略交付模式的旧调用仍可能走旧声轨。 | blocking | 已共用逐镜主声合成，保留原有发布条件。 | [旧调用回归](../../../backend-node/test/episodeEdit.test.js) |
| I3 | 试听后更换声源时，旧页面可能采用未听过的声音。 | blocking | 采用前复核双侧素材与声源，冲突返回 409。 | [试听与采用](../../../backend-node/src/services/episodeEditService.js) |
| I4 | 指定配音缺失时，草稿可能丢失可用原声。 | blocking | 草稿提示镜号并回退，正式交付阻止发布。 | [逐镜保声测试](../../../backend-node/test/episodeEdit.test.js) |
| I5 | 无剪点的正式导出仍可能在渲染中遇到源文件同名替换。 | blocking | 发布前再校验采用片内容，失败时保留上次成片。 | [发布回归](../../../backend-node/test/episodeEdit.test.js) |
| I6 | 对听切换时直接沿用播放器秒数会落到另一个动作。 | blocking | 按前镜或后镜的源时码定位，验证两个方向。 | [播放器时间映射](../../../frontweb/test/episodeEdit.test.js) |
| I7 | 已删除镜头的待复核剪法在重复导入后可能丢失身份。 | blocking | 保留失效引用，两次打包和恢复后仍待复核。 | [工程包回归](../../../backend-node/test/episodeEdit.test.js) |
| I8 | 试听未显示降级警告；临时文件和草稿历史持续增长。 | should-fix | 窗口显示警告，草稿列表排除试听，单集保留最近 12 份试听。 | [试听窗口](../../../frontweb/src/components/EpisodeSeamEditor.vue) · [合成服务](../../../backend-node/src/services/videoMergeService.js) |
| I9 | 截断 MP4 可能仍有完整文件头，双镜试听可能意外变为单镜。 | blocking | 试听和采用均解码两侧，执行任务时校验双镜，缺失即失败。 | [损坏媒体回归](../../../backend-node/test/episodeEdit.test.js) |
| AC6 | 现有样片验证媒体技术。真实作品偏好、首次使用门槛及智能建议增益尚待对应试验。 | verdict | not met | [既有研究流程](../../../docs/quality-study.md) |
| AC10 | 首次用户的独立操作率尚待五人任务验证。 | verdict | not met | [试点判据](spec.md#acceptance-criteria) |
| AC11 | 剪点建议对误剪和用时的影响尚待对照试验。 | verdict | not met | [试点判据](spec.md#acceptance-criteria) |

### 本次复核结果

- 在临时 SQLite、媒体目录下，使用随包 FFmpeg/ffprobe，经采用片与正式交付 HTTP 入口调换两段各 2 秒样片顺序。无音轨在前时输出 4.000 秒视频且无音轨；有音轨在前时输出视频 4.000 秒、音轨 2.021 秒。两种导出均报告完成。
- 另做双镜均有原声的正式交付。仅第一镜有独立配音并启用对白，第二镜的测试音在源片取样为 −21.1 dBFS，在输出第二镜对应的 0.4 秒窗内为数字静音。后期把单独生成的配音轨映射为输出。结构化后期工作区的另一条路径会将原轨和对白轨叠加，也需验收重复人声的情况。产品应先定声源选择，再决定逐镜如何混合。
- 通过 `git ls-tree -r 9445e30` 和并行工作区的 `git status --short` 核实，`structuredEpisodePost.js`、`dialogueTtsService.js`、`episodeCompose.test.js` 均未进入该提交。
- 对首发的建议分层：缺镜完整性、保声、选帧和同步属于平台保证；普通作者从整集播放点进问题位置，一键试听、采用或恢复；「显示剪点建议」可做可记忆偏好，「上一句说完」仅在有余量的本接缝启用，逐帧调节按需展开。三处入口都沿用相同的采用版本和时间映射。

## 评审意见处理

| 原意见 | 写入修订稿的处理 | 实施阶段应补的证据 |
|---|---|---|
| R1 · 两条丢声路径 | 逐镜选择原声、已采用配音或静音。缺音补足本镜，旁白和整集音乐另行叠加。增加旧开关映射、声源缺失和超长对白的处理。 | 阶段一 AC1、AC7。草稿和正式导出的解码音频，覆盖无音轨正反顺序及部分配音。 |
| R2 · 未提交的外部依赖 | 更正提交归属，基础顺剪和精剪独立交付。结构化后期读取同一版剪辑映射和主声。 | 独立联调 AC9。锁定两边提交，从干净检出导出结构化成片，并回归普通工程。 |
| R3 · 跳镜和过期剪法 | 接缝绑定左右镜、采用版本与内容。草稿标出临时跳接，正式交付要求补齐缺镜和复核过期改动，保留之前成片。 | 阶段二 AC5。记录 A→B→C→D 中 B 缺失、换片、重排、复核、并发和跨机恢复的结果。 |
| R4 · 试听与尾音验收错位 | 有声对听、采用、撤回、重开列入阶段二，声音延续单列阶段三。 | 阶段二 AC4 浏览器记录，阶段三 AC8 局部声画对照。 |
| R5 · 输出时基不明 | 规定帧率选择顺序、可变帧率取帧及不足一输出帧的行为。预览与正式导出共用编译器，各版本使用各自修订。 | 阶段二 AC2、AC3。标帧源、分窗音标、非关键帧及长序列累计误差。 |
| R6 · 三种收益混在一次比较 | 将自然度、新手门槛和建议增益拆成三个试验，各有材料、判据和未达标时的决定。 | 试点 AC6、AC10、AC11。保留逐作品盲评、逐人操作记录及建议开关对照。 |

上表记录修订时安排的验收。方案评审、实施复审和真实用户试点分别记录。

## 阶段一与阶段二实施验收

### 一 · 可靠顺剪（AC1、AC7）

在独立的 SQLite 和本地媒体目录复现两条丢声路径后，先修复逐镜声源和整集主声合成。记录 003、004 的后端、前端全量回归及记录 005 的制作页构建通过后，才进入阶段二。最终版本再经记录 011、012、014 回归。

用同一套 25 fps、每镜 2 秒的输入，经草稿和正式交付分别导出，对解码后的单声道 PCM 取相同时间窗。下表各组三个值依次为 440、660、880 Hz 的幅值（16 位线性采样单位，0 表示该窗未检出）。两种导出结果相同。[输入素材](samples/rough-cut-inputs.zip)

| 情形 | 第 1 镜 0.30–0.55 秒 | 第 2 镜 2.40–2.65 秒 | 输出 |
|---|---|---|---|
| 第 1 镜无音轨，第 2 镜有 660 Hz 原声 | 0 / 0 / 0 | 1 / 2875 / 0 | [草稿](samples/no-track-draft.mp4) · [正式](samples/no-track-complete.mp4) |
| 第 1 镜采用 880 Hz 配音，原声 440 Hz；第 2 镜保留原声 | 0 / 1 / 2886 | 1 / 2875 / 0 | [草稿](samples/partial-dub-draft.mp4) · [正式](samples/partial-dub-complete.mp4) |

同一 HTTP 回归还逐镜核对画面、音轨全长，以及无音轨镜放在尾部、中间、全片无声的结果。反向配音、未采用的新配音、显式静音、旁白叠加、配音被替换或丢失、超长对白和工程包分别有断言。[媒体回归用例](../../../backend-node/test/episodeEdit.test.js)

### 二 · 接缝精剪（AC2、AC3、AC4、AC5）

| 验收项 | 实际操作与结果 |
|---|---|
| 帧精度与时码 | 长 GOP 的非关键帧和可变帧率长帧在试听与成片逐帧一致。24 镜交错使用 25、30、30000/1001 fps，解码检查每镜首尾，共 48 个位置全部匹配。输出 444 帧，主声与画面各 17.760 秒。专项回归另验 1 帧保留区间、越界输入、旋转矩阵及画幅。[24 镜成片](samples/mixed-rate-24.mp4) |
| 对白、旁白与字幕 | 连裁前两镜后，第三镜旁白字幕落在 2.440–2.840 秒，2.50 秒起的解码窗检出对应 1000 Hz 音标。试剪切入受保护发声时拒绝采用，试听后换声源须重新试听。[自动回归](../../../backend-node/test/episodeEdit.test.js) |
| 制作页 | 真实 Chrome 从制作页打开「审接缝」，有声播放原版、设前镜终点、播放试剪、采用、关闭重开、恢复，服务端剪辑修订从 0 到 2。另一轮实际验证空集说明、单镜直接预览、改动后旧试听迟到、未采用的试剪不影响当前剪法。[原版](samples/seam-original.mp4) · [试剪](samples/seam-trial.mp4) · [界面截图](samples/audition.png) |
| 缺镜和恢复 | A→B→C→D 中 B 损坏，草稿点明第 2 镜，A→C 临时顺接，C→D 仍用既有剪法。完整交付失败，上次成片保留。截断但能读取文件头的 MP4 在试听和采用两条入口均被拒绝。并发换源、旧修订和重复导入均有回归。[交付用例](../../../backend-node/test/episodeEdit.test.js) |
| 工程可移植 | 将浏览器中已采用的工程包导入有既有记录的独立数据库，用新镜号 63、64 和候选号 64、65 还原剪法，再走正式交付。解出的 80 帧和浏览器试听逐帧比对颜色一致（单通道容差 3）。[可导入的示例工程](samples/accepted-project.zip) |

最终版本全量回归 239 项通过（后端 202、前端 37），前端生产构建通过。记录 009 至 016 覆盖本轮六个验收项。独立复审复跑剪辑媒体回归 12 项和前端时间映射 1 项，并复核截断 MP4 的两条拒绝路径。桌面随包 FFmpeg 含字幕滤镜；使用缺少该滤镜的系统 FFmpeg 时，两项带字幕的独立回归会失败。

### 安装包验证

macOS 版本 1.2.9，构建号 1.2.14。两份 Lite DMG 均通过镜像校验、只读挂载、应用签名完整性及架构检查。分别用包内 Electron、SQLite 和 FFmpeg 实际导出无音轨及部分配音两种草稿和成片。另采用一个接缝，均得到 80 帧、3.20 秒的成片。Apple 芯片原生执行，Intel 包通过 Rosetta 执行。两个安装包均为本地 ad-hoc 签名，未公证。[剪后样片](samples/accepted-cut.mp4)

| 架构 | 安装包 | SHA-256 |
|---|---|---|
| Apple silicon | [arm64 DMG](../../../desktop/release/LocalMiniDrama-Lite-1.2.9-build-1.2.14-mac-arm64.dmg) | fdb79bf224328c44372f8f4f29e2ca7ff901e5f4f59170c4b058827175e09cc2 |
| Intel | [x86_64 DMG](../../../desktop/release/LocalMiniDrama-Lite-1.2.9-build-1.2.14-mac-x64.dmg) | d1c3da59eb300c0e76506709274f5fdc270a9104b046295c86518eaf5fe3d666 |

后续阶段分别验收可选的「上一句说完」AC8、并行结构化后期 AC9、真实作品盲评 AC6、首次用户任务 AC10 和建议开关 AC11。当前结论限于顺剪及手动精剪的功能、媒体正确性和安装包运行结果。

### 实施命令记录

| 验收 | 类别 | 记录 | 来源 | 命令 | 结果 | 修订 | UTC 时间 |
|---|---|---|---|---|---|---|---|
| AC1 | test | record 003 | cli | `cd backend-node && node --test test/*.test.js && cd ../frontweb && node --test test/*.test.js` | pass | c103623+5dcf04f2b0794461 | 2026-11-19T05:20:14Z |
| AC7 | test | record 004 | cli | `cd backend-node && node --test test/*.test.js && cd ../frontweb && node --test test/*.test.js` | pass | c103623+5dcf04f2b0794461 | 2026-11-19T05:20:30Z |
| AC7 | build | record 005 | cli | `cd frontweb && npm run build` | pass | c103623+5dcf04f2b0794461 | 2026-11-19T05:20:41Z |
| AC2 | test | record 006 | cli | `cd backend-node && node --test test/*.test.js && cd ../frontweb && node --test test/*.test.js` | fail(exit 1) | c103623+026956afe9cafa76 | 2026-11-19T05:31:24Z |
| AC2 | test | record 007 | cli | `cd backend-node && node --test test/*.test.js && cd ../frontweb && node --test test/*.test.js` | pass | c103623+ecca966e2266a251 | 2026-11-19T05:32:42Z |
| AC3 | test | record 008 | cli | `cd backend-node && node --test test/*.test.js && cd ../frontweb && node --test test/*.test.js` | pass | c103623+09732abbaca7e1e4 | 2026-11-19T05:33:16Z |
| AC4 | test | record 009 | cli | `cd backend-node && node --test test/*.test.js && cd ../frontweb && node --test test/*.test.js` | pass | c103623+09732abbaca7e1e4 | 2026-11-19T05:34:06Z |
| AC5 | test | record 010 | cli | `cd backend-node && node --test test/*.test.js && cd ../frontweb && node --test test/*.test.js` | pass | c103623+09732abbaca7e1e4 | 2026-11-19T05:34:44Z |
| AC1 | test | record 011 | cli | `cd backend-node && node --test test/*.test.js && cd ../frontweb && node --test test/*.test.js` | pass | c103623+09732abbaca7e1e4 | 2026-11-19T05:35:19Z |
| AC7 | test | record 012 | cli | `cd backend-node && node --test test/*.test.js && cd ../frontweb && node --test test/*.test.js` | pass | c103623+09732abbaca7e1e4 | 2026-11-19T05:35:57Z |
| AC4 | build | record 013 | cli | `cd frontweb && npm run build` | pass | c103623+09732abbaca7e1e4 | 2026-11-19T05:36:08Z |
| AC7 | build | record 014 | cli | `cd frontweb && npm run build` | pass | c103623+09732abbaca7e1e4 | 2026-11-19T05:36:16Z |
| AC2 | test | record 015 | cli | `cd backend-node && node --test test/*.test.js && cd ../frontweb && node --test test/*.test.js` | pass | c103623+09732abbaca7e1e4 | 2026-11-19T05:37:39Z |
| AC3 | test | record 016 | cli | `cd backend-node && node --test test/*.test.js && cd ../frontweb && node --test test/*.test.js` | pass | c103623+09732abbaca7e1e4 | 2026-11-19T05:38:37Z |
