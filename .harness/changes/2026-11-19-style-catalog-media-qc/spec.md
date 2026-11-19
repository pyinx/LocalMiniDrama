---
tier: T2
language: zh
slug: 2026-11-19-style-catalog-media-qc
---

# 可辨认的短剧画风库与 FFmpeg 移植评估

## Intent

作者在项目里一次选定画风，随后能从角色、场景、分镜到视频认出同一套视觉特征。扩充以实际能区分的选择为准，适用于多题材和跨集创作。另评估本地媒体处理可以挽回哪些返工，给出与既有成片流程相容的集成方案。

## Scope

1. 画风进入开发范围。清点源目录、合并重名与同义项、制作并对比同题样张、扩充正式选项和搜索、接通现有生成与工程迁移。上架数量依据样张，不规定名额。
2. 现有、新增和自定义画风都配对应的示例图。自定义编辑器支持上传图片反推正向词与反向词，也支持用作者编辑的两组提示词生成候选示例图。作者可选用上传原图或生成图。作品采用时保存该版本，其他作品可从本机画风库复用，工程包携带采用的完整图文。
3. FFmpeg 本次交付为评估和集成设计。下面给出可独立落地的顺序、触发点和验收样片。媒体处理代码的实施另行决定。

## Non-goals

本次边界包括现有项目级画风选择和既有制作入口。自由组合多套风格、创建第二个导演 Agent、通用剪辑工作站、自动裁切或自动重混超出本次范围。

## Deferred

暂无经用户确认的延期项。

## Facts

| 已核对的事实 | 依据 |
|---|---|
| 当前 7 组 39 个可选预设，另有自定义。两端各维护一份中英文文案，本次按 value 比对，39 项全部相符。项目详情和制作页共用选择器，现有搜索只看 label/value。 | `frontweb/src/constants/styleOptions.js`、`frontweb/src/components/StylePickerButton.vue`、`frontweb/src/views/{DramaDetail,FilmCreate}.vue`、`backend-node/src/constants/generationStylePresets.js` |
| 逐一检查 39 个预设的 thumb、文件内容摘要和图像尺寸，共 38 张有可读尺寸的不同图片。“都市3D风格”和“3D 渲染”共用 3d-render.jpg。自定义入口目前仅显示“自定”色块、保存文本。工程包序列化项目 metadata，自定义样图需要显式加入媒体清单并在导入时重建本地引用。 | `styleOptions.js`、`StylePickerButton.vue`、`frontweb/public/style-thumbs/`、`dramaExportService.js`、`dramaImportService.js` |
| 已保存的中英文描述优先于旧 style 值，只有旧值时展开预设或沿用原文。创作指导另用 3 类建议，靠文字匹配区分，新增手工媒介需核对分派。 | `backend-node/src/utils/dramaStyleMerge.js`、`backend-node/src/services/workbenchCreativeMethods.js` |
| 现有视觉调用 `generateTextWithVision` 支持传入图片和任务提示。既有图像描述接口只接受角色、场景、道具，返回单一描述。现有资产生图会组合自动反向词和用户反向词；分镜生图调用处传 `negative_prompt`，而 `callImageApi` 读取 `user_negative_prompt`。两处名称差异使这个入口有漏传风险。 | `backend-node/src/services/aiClient.js`、`backend-node/src/routes/index.js`、`backend-node/src/services/imageService.js`、`backend-node/src/services/imageClient.js` |
| video-canvas 的样式目录有 45 项，另列运镜和模板。Toonflow 的视觉知识给出 11 套规则，分别处理人物、场景、道具与运动。两者都写了黏土定格。 | 同级仓库 `video-canvas/web/src/constants/presets.ts`（f0b8ced3），`Toonflow-app/packages/skills/v118workflow/references/knowledge/visualStyles.md`（6086cdff） |
| 火宝有按项目绑定预设取提示词的服务；waoowaoo 的视频导演 Skill 把材质或光线与剧情事件分开；本地即梦的长镜头 Skill 属于运镜参考。 | `huobao-drama/backend/src/services/style-preset.ts`、`waoowaoo/src/lib/creative-skills/skills/video-direction/SKILL.md`、`dreamina-canvas-cli/references/creative-skills/film-and-short-videos/cinematic-long-take/SKILL.md` |
| 当前交付已探测画幅、旋转、像素宽高比、时长与音轨，拼接优先复用码流，有字幕与配音路径。并行需求 AC13/14/38 已覆盖接缝拼图、逐秒帧图、BGM、尾帧衔接与风格句派生。 | 本分支 c103623 的 `videoMergeService.js`、`mergedEpisodePostProcess.js` 和 `workbenchDelivery.test.js`，并行分支 feat/jimeng-quality-chain 的 spec 及 9445e30 的 `segmentCompile/style.js`。规划范围和已提交实现分别核对。 |
| 上游提供只读黑边检测、响度测量、双遍归一及写后验证。以相同容器宽高、相同音频的两段人工素材验证，桌面随附工具实际能分出满画面和内嵌黑边，也能读出响度、真峰值。 | `evidence.md`。上游 [cropdetect.py](https://github.com/kajisho5/ffmpeg-skill/blob/b8fbd1ce844883ecf678be2386ce1ad92692de1d/scripts/cropdetect.py)、[loudness.py](https://github.com/kajisho5/ffmpeg-skill/blob/b8fbd1ce844883ecf678be2386ce1ad92692de1d/scripts/loudness.py)、[check.py](https://github.com/kajisho5/ffmpeg-skill/blob/b8fbd1ce844883ecf678be2386ce1ad92692de1d/scripts/check.py)。 |

## Decisions

| # | 用户选择 | 日期 |
|---|---|---|
| D1 | 可辨认的年代、题材与画法组合可以独立选择。用同场景样张验证差异，其余归为别名或标签。 | 2026-11-19 |
| D2 | 每个内置与自定义画风都要有能展示该画风的示例图，工作台支持用户创建自定义画风。 | 2026-11-19 |
| D3 | 上传图片可以反推画风提示词，画风提示词也可用来生成示例图。编辑器支持正向、反向两组提示词。 | 2026-11-19 |
| D4 | 自定义画风保存在本机画风库，供其他项目复用。各剧保留采用时的图文版本。 | 2026-11-19 |

## Assumptions

| # | 假设 | 如果不成立 |
|---|---|---|
| A1 | 继续用项目级单选与现有自定义入口。内置样张随应用分发，作者日常浏览和选用无需额外生成。 | 若要在同一项目混合多款画风，需另定生成与保存规则。作者主动为自定义画风生成样图已在本次范围内。 |
| A2 | 可复用合法、可分发且满足同题对照的样张，补缺时制作原创。不将未验证项计入新增数。 | 真实生成资源、模型可用性或素材使用范围会影响首批数量与排期。 |
| A3 | 正向词必填，反向词可留空。反推得到的是可编辑的候选，上传原图可直接采用。手填提示词并上传图片的流程可在无模型配置时使用。 | 如要求自动调用或强制重画会增加等待与模型使用成本。 |

## Open questions

无待决需求选项，整体设计待确认。

## Acceptance criteria

| # | Criterion | How it is verified | Required commands | Tests |
|---|---|---|---|---|
| AC1 | 所核对的 45+11 个源条目各有归属。新增目录有可用样张、可复述的差异、稳定唯一标识及中英文描述；同义名称不会产生第二张卡。 | 核对来源映射、碰撞、缩略图文件与所有可选项在两端的一致性。 | `test`, `build` | `frontweb/test/styleOptions.test.js::every source style maps to a reviewed catalog entry or tag`、`backend-node/test/generationStylePresets.test.js::catalog entries resolve consistently across both clients` |
| AC2 | 两个入口可按中英文名、别名及标签找到同一项；无结果有提示，清空可恢复列表，自定义仍可选择或取消。 | 测搜索、保存、清空与空结果；在网页和桌面验证选择器。 | `test`, `build` | `frontweb/test/styleOptions.test.js::aliases and tags find unique options`、review |
| AC3 | 旧的 39 个值、完整提示词快照、自定义、空值和旧自由文本仍可读取，原工程再次打开及导入导出后保留创作者的选择与描述。 | 在旧工程样例和新预设工程执行保存、重开及包往返。 | `test` | `backend-node/test/dramaStyleMergeCustom.test.js::legacy and saved snapshots survive catalog expansion`、`backend-node/test/workbenchArchiveIdentity.test.js::project style survives archive round trip` |
| AC4 | 同一项目的角色、场景、分镜和视频提示保有同一媒介特征，允许镜头按剧情改变时间、光位与动作；代表性的近邻风格在同题样张及短镜头中可辨。 | 核实实际生成请求，固定角色、场景、动作、模型和参数比较邻近风格。独立评审记录证据；审核所有新卡的样张，对跨媒介和近邻组合补动态回读。 | `test` | `backend-node/test/workbenchCreativeMethods.test.js::catalog style persists through asset and shot guidance`、review |
| AC5 | FFmpeg 方案列出每项的入口、所有者、误报处理、平台依赖、失败降级和验证样片，现有正式交付规则有明确归属。 | 核对源码、并行 AC、随附工具的本地实验及下表。 | | review |
| AC6 | 每个可选内置画风在两个入口都显示能代表该画风的图片，旧目录与新增目录均覆盖。别名指向同一卡。独立项各有对应样图，网页及桌面离线可读。 | 校验全部资源文件可解码、独立卡的内容摘要无重复，抽查界面和人工核对图文对应关系。 | `test`, `build` | `frontweb/test/styleOptions.test.js::every built-in style has a distinct decodable example image`、review |
| AC7 | 新建自定义画风须有描述和可预览的有效示例图。确认后两个入口显示同一图文，重启后可见；取消、无效图片和失败重试保留原选择。旧工程的纯文本画风可继续使用，显示补图入口。 | 验证创建、重新打开、换图、取消、文件损坏及补图；以旧工程设置其他字段验证兼容性。 | `test` | `backend-node/test/dramaStyleMergeCustom.test.js::custom style examples persist and legacy text can be completed`、review |
| AC8 | 工程包带上采用的自定义示例图；换到空白存储导入后离线能显示，文件内容与原图一致，旧格式包依然可导入。 | 对实际工程包进行导出导入和同名冲突测试，核对本地资源引用和内容摘要。 | `test` | `backend-node/test/workbenchArchiveIdentity.test.js::portable archive restores the adopted custom style image` |
| AC9 | 上传图片并点击反推，可预览和分别编辑正向风格描述、建议的反向词。上传图可直接作为示例；模型未配置、返回无效、请求失败或晚到时保留已有草稿与原图。 | 通过真实上传、模型请求入口和编辑器核对字段；评审媒介、线条、色彩与质感，确认未将画中人的身份和场景误写作全剧约束。 | `test` | `backend-node/test/customStyleLibrary.test.js::image analysis returns editable style prompts without replacing user edits`、review |
| AC10 | 作者可用正向词及可选反向词生成候选样图。支持原生反向参数的模型实收相应字段，能力不足时生成前看到限制。采纳后才更新图文。重复点击、生成失败和切换草稿时保持原图与已编辑内容。 | 在线路边界捕获实际发给模型的请求体，覆盖显式与默认模型、空反向词、多个约束、未知能力，复查分镜调用处的参数名称。 | `test` | `backend-node/test/customStyleLibrary.test.js::generation sends style negatives according to the resolved model`、review |
| AC11 | 保存的自定义画风可以在另一项目中选用。库从第一版更新到第二版后，采用第一版的项目在重启及工程包往返后仍显示其原示例图，并用当时的正反向词生成。项目主动采用新版时才更新。 | 用两部剧、两个不同图文版本和一个空白导入目录验证版本、样图摘要与模型请求，额外覆盖重复提交和同名库项。 | `test` | `backend-node/test/customStyleLibrary.test.js::projects keep adopted style versions when the library advances`、`backend-node/test/workbenchArchiveIdentity.test.js::import keeps the adopted style prompts and image despite library name collisions` |

## Design

### Options considered

| 选择 | 成本与判断 |
|---|---|
| 在现有前后端两份表中分别追加整套外部预设 | 首次编辑少，每次扩充都要同步；同义模板、相机词以及题材限定会叠加。 |
| 单一数据源、稳定旧值、近邻同题比对、别名搜索 | 推荐。两端入口与工程格式可以继续使用；投入集中在真实预览、筛选和验证。 |
| 仅在项目里保存图文，或让所有项目总读取库最新版 | 前者缺少跨项目复用，后者会让旧剧换画风。采用本机库管理新版本、项目选用时固化图文的方式，覆盖两个需求。 |
| 依赖上游 Python/MCP 整体运行 | 上游的通用工具适合独立剪辑；桌面会多一套运行环境和任务入口，既有合成、字幕、帧图会重复。 |
| 在已有 Node 媒体与审片服务按需复用只读算法 | 推荐为后续集成路径。沿用随附二进制与任务状态，可先验证诊断价值，再决定是否值得开放修正。 |

### Interfaces and data

保留 `dramas.style` 与 `metadata.style_prompt_zh/en`，老工程读取优先级照旧。建议将权威目录放入后端已打包的 `src/constants` 下，Vite 静态导入同一份 JSON，后端同步读取。兼容现有导出函数及选择器字段，在目录内补别名、标签与必要的媒介说明。开发态 Vite、构建版与打包后的服务分别验证离线加载。目录内来源映射供核查，不要求新增管理页面或联网拉取。识别旧值继续优先精确匹配，自定义描述即便与某个别名相似也按作者原文保留。

**画风示例图**

内置样图随应用分发，两端复用同一资源。对共用 3d-render.jpg 的两个现有条目做同题比较。若有可辨差异，分别配置对应样图；若差异不足，展示为同一卡并保留两个旧值的读取兼容。自定义编辑器同时展示描述、候选图和已采用图。图片可解码并经作者确认后才提交图文，取消编辑保留此前采用的版本。更改描述时可确认继续使用原图或更换示例。旧工程保持已有描述并提示补图，浏览和保存其他资料不触发生图。示例图用于表达和选择画风；作为模型参考输入是另一个行为，须有独立依据。

工程包写入图片文件和相对资源引用。导入时复用现有存储布局，重定位到导入目标，并核对文件内容。新格式包缺失声明的示例图时提示具体资源；旧格式包继续兼容。

**自定义画风的两个入口**

| 起点 | 作者操作及结果 |
|---|---|
| 有一张喜欢的图 | 上传 → 点击「提取画风」 → 视觉模型返回可编辑的正向词和建议反向词 → 确认图文。提取维度是媒介、线条、色彩、材质、光影与构图。图里的人物、地点和剧情只作为观察背景。反向词用于表达容易让风格跑偏的特征，可删改或清空。 |
| 有一组提示词 | 填写名称、正向词和可选反向词 → 点击「生成示例图」 → 选用结果，或编辑词再试。编辑中始终保留已采用图。上传原图＋手填词也能完成保存。 |

识图复用 `generateTextWithVision`，单独定义画风分析输出。生图复用现有图片模型配置、任务和存储，采用中性的演示场景，隔离当前剧的角色与场景信息。识图、生图均由作者主动发起，编辑器显示待处理、成功和可重试状态。返回结果绑定发起任务的图片和提示词版本，迟到结果只能作为相应草稿的候选。以保存动作统一提交图文，重复提交同一草稿不会产生多条库记录。

依据最终选中的模型和协议决定如何应用反向词，覆盖默认选择模型的路径。已有原生支持的路线传独立反向参数，并与单个资产和模型已有约束按片段去重。该判断也用于采用此画风后的资产、分镜与视频请求。在未验证支持的路线，界面在发起前说明只能应用正向词，作者可更换模型或按正向继续；始终保留反向原文。旧工程的语言槽 `style_prompt_zh/en` 始终表示正向词的语言，不用来区分正反向。

**本机画风库与项目版本**

本机 SQLite 保存可复用画风的稳定标识、名称和最新版本。每次保存有效的图文变更形成版本，包含正向词、反向词和由应用管理的示例图引用。项目采用时在现有项目元数据中固化版本标识、名称、两组词及图片引用，正向文本复用既有语言槽。库与项目可共享同一不可变图片内容；替换示例图写入新资源，项目读取以已采用的版本为准。新包只携带该剧采用的版本和图片。导入使用包内快照并重建本地引用，同名或本机有更新版本时也不覆盖原库项。需要复用导入的版本时可显式存入库。旧工程缺少新字段时继续沿用已保存文本。

**上架规则与候选**

| 优先试样 | 固定题目时应看得见的差异 | 近邻处理 |
|---|---|---|
| 黏土定格、传统皮影 | 手塑体积与材料压痕；透光的镂空轮廓与平面叠层 | Toonflow 与 video-canvas 的黏土归一。定格可用于检索，更换偶的材质需重新比较。 |
| 工笔重彩动画、古埃及壁画、六十年代四色海报、二维扁平矢量 | 工细线描和矿物重彩；侧面轮廓与壁面平涂；印刷网点和套色偏移；平面色块与硬边遮挡 | 比较既有 2D 古风、国画水墨、版画、极简。仅保留可被评审指出的差异。 |
| 90 年代手绘赛璐璐、复古港片、昭和黑白、古典好莱坞彩色 | 旧式手绘阴影分层；冷暖混合实景光与硬轮廓；柔和黑白中间调；棚拍分色与饱和彩层 | 分别对照日本动漫、复古胶片、黑色电影、电影感。样张保持演员、服装、布景和动作一致。 |
| 原子朋克、国风赛博三维、高调荒诞 | 复古未来造型；东方形制与三维发光材质；明亮粉彩的高调影像 | 与科幻、赛博朋克、唯美梦幻比对。若区别只剩剧情道具或地名，作为题材标签。 |

以上 13 个方向是首批比较对象，不是上架承诺或数量上限。其余来源按相同办法逐项归入独立卡、别名、标签或有理由排除。优先合并已有的复古胶片、蒸汽朋克、中式水墨等明显重复项。“浮世绘”先核对现有版画卡，其提示已明确采用浮世绘。具体影人、画师和工作室名改写成可观察的视觉语言。固定剧情下比较人物近景及带动作的中景，隐藏名称，比较者要能指出画面证据；只靠换服装、地标或标题能辨认的候选回到标签。成对难分的另一批次复核；仍难分的只保留一个选项。上架文案中移除替作者决定剧情、画幅、相机运动的模板词。

**FFmpeg 选择性移植建议**

| 顺序、入口 | 借鉴与适配 | 误报与验收 |
|---|---|---|
| 1. 在已有逐镜审片中按需检查选中的候选 | 借鉴 cropdetect.py 的多时间窗采样和常见有效矩形。通过已有候选身份解析本地媒体，返回时间点、矩形和可复查帧。复用已有审片预览或并行帧图。 | 原生竖幅、内嵌黑边、旋转元数据、暗场、刻意遮幅和素材缺失分别测试。稳定黑边只提示复核；尊重作者的构图，检查不改源片和采用状态。 |
| 2. 在已完成的导出件上检查最终混音 | 借鉴 loudness.py 的只读模式与 check.py 的逐项结果。显示整集综合响度 LUFS 和真峰值 dBTP。由混音之后实际编码的文件计算；可对同一剧的集间结果作比较。只有项目已有明确目标时才判定偏差。 | 用两段不同电平、静音、无音轨、过短及多次检测样片验证。静音和无法测量单列；已有交付硬校验继续由原服务负责。 |
| 可选后续，有明确修正需求时单独评估 | 作者指定目标后才考虑上游双遍归一，生成新导出并重新测量编码后真峰值，保留原件。 | 比较修正前后实测值、视频时长及音画同步。只测总响度无法判断对白是否被音乐遮盖，应回听或调分轨。 |

诊断由现有 Node 服务后台调用已定位的 FFmpeg，使用固定参数和受管理的本地媒体路径。界面附候选或导出版本和检查时间，文件改变即重新取证。二进制、滤镜或本地源缺失时提示未能检测，允许继续人工审片。上下游以结构化测量结果连接，横纵像素比例、目标时长和音轨存在性沿用现有探测。上游通用剪辑命令、平台默认阈值、自动剪静音、MCP 服务及 Python 运行时不在建议集成项内。

### Reuse

复用 `StylePickerButton`、`generationStylePresets`、`dramaStyleMerge`、`workbenchCreativeMethods` 与现有归档。风格进入并行质量链时沿用该链拥有的风格句派生，验收通过真实入口观察结果。媒体沿用 `ffmpegPath`、`workbenchTakeService`、`TakeReviewDialog`、`videoMergeService`、`mergedEpisodePostProcess`。现有质量研究工具可做短片盲评；小范围同题图片可直接并排盲评。直接移用许可允许的代码或素材时保留上游标记和来源；预览图应有可分发来源。

### Tasks

| # | 工作 | 主要文件 | 核验 |
|---|---|---|---|
| T1 | 固化 39 项基线，统一目录，保留公开导出和保存语义 | 两端 constants、桌面打包路径及画风测试 | AC1、AC3，网页开发态、构建与桌面离线启动 |
| T2 | 对 45+11 条原始记录逐一归并，写中英文视觉描述与同题样张，记录近邻和取舍 | 目录、`frontweb/public/style-thumbs/`、来源及评审记录 | AC1、AC4，每批样张可回溯 |
| T3 | 扩充选择器搜索及空状态，验证项目详情与制作页、图像与分镜/视频请求、旧工程往返 | `StylePickerButton.vue`、现有创作指导与对应测试 | AC2–AC4，复核并行链合并状态。应用改动交付时按仓库约定验证两种架构的安装包 |
| T4 | 提供 FFmpeg 选择性移植结论与本地探测证据 | 本文和同目录 evidence.md | AC5；本任务产物为设计与验证样例 |
| T5 | 覆盖全部内置样图、定制画风图文编辑与旧项目补图，将实际采用的自定义图片接入工程包往返 | `StylePickerButton.vue`、`DramaDetail.vue`、`FilmCreate.vue`、`dramaService.js`、`dramaExportService.js`、`dramaImportService.js` | AC6–AC8，两端查看、损坏与取消、跨机离线复查 |
| T6 | 自定义画风双向创作，接通本机库、项目采用和模型参数。模型请求与工程包两端核对正反向原文。 | `aiClient.js`、`imageClient.js`、`imageService.js`、`videoService.js`、`dramaStyleMerge.js`、`db/migrate.js`、画风编辑器、库服务及对应测试 | AC9–AC11；验证手填、识图、生图、旧项目及默认模型路径 |

## Related

全流程工作台目标见 `.harness/memory/pages/short-drama-workbench-goal.md`。另一个工作区的 `.harness/changes/2026-11-18-jimeng-quality-chain/spec.md` 与本分支的前期工作台 spec 共同界定分工。
