# 调研与验证记录

## Baseline
| test | `cd backend-node && node --test test/*.test.js && cd ../frontweb && node --test test/*.test.js` | pass | c103623+6886a6f46ec52e7a | 2026-11-19T02:38:21Z |
| build | `cd frontweb && npm run build` | pass | c103623+6886a6f46ec52e7a | 2026-11-19T02:38:27Z |

2026-11-19，工作台分支 c103623。用 Node 读取两端真实画风模块，得到前端 7 组、39 个条目，后端 39 个。逐项比较 value、中文描述与英文描述，差异数为 0。`node --test frontweb/test/styleOptions.test.js backend-node/test/generationStylePresets.test.js backend-node/test/dramaStyleMergeCustom.test.js` 通过 19/19。

同日读取 video-canvas f0b8ced3、Toonflow 6086cdff 和 ffmpeg-skill b8fbd1ce844883ecf678be2386ce1ad92692de1d。上游代码用于阅读，实验直接调用当前工作区 `desktop/ffmpeg-mac/ffmpeg` 与 `desktop/ffmpeg-mac/ffprobe`。

## Criteria
| ALL | test | record 001 | cli | `cd backend-node && node --test test/*.test.js && cd ../frontweb && node --test test/*.test.js` | pass | c103623+6886a6f46ec52e7a | 2026-11-19T02:38:09Z |
| AC1 | test | record 003 | cli | `cd backend-node && node --test test/*.test.js && cd ../frontweb && node --test test/*.test.js` | pass | c103623+217ee28e41b48a14 | 2026-11-19T03:09:24Z |
| AC2 | test | record 004 | cli | `cd backend-node && node --test test/*.test.js && cd ../frontweb && node --test test/*.test.js` | pass | c103623+217ee28e41b48a14 | 2026-11-19T03:09:48Z |
| AC3 | test | record 005 | cli | `cd backend-node && node --test test/*.test.js && cd ../frontweb && node --test test/*.test.js` | pass | c103623+217ee28e41b48a14 | 2026-11-19T03:10:14Z |
| AC4 | test | record 006 | cli | `cd backend-node && node --test test/*.test.js && cd ../frontweb && node --test test/*.test.js` | pass | c103623+217ee28e41b48a14 | 2026-11-19T03:10:36Z |
| AC6 | test | record 007 | cli | `cd backend-node && node --test test/*.test.js && cd ../frontweb && node --test test/*.test.js` | pass | c103623+217ee28e41b48a14 | 2026-11-19T03:10:52Z |
| AC7 | test | record 008 | cli | `cd backend-node && node --test test/*.test.js && cd ../frontweb && node --test test/*.test.js` | pass | c103623+217ee28e41b48a14 | 2026-11-19T03:11:06Z |
| AC8 | test | record 009 | cli | `cd backend-node && node --test test/*.test.js && cd ../frontweb && node --test test/*.test.js` | pass | c103623+217ee28e41b48a14 | 2026-11-19T03:11:17Z |
| AC9 | test | record 010 | cli | `cd backend-node && node --test test/*.test.js && cd ../frontweb && node --test test/*.test.js` | pass | c103623+217ee28e41b48a14 | 2026-11-19T03:11:29Z |
| AC10 | test | record 011 | cli | `cd backend-node && node --test test/*.test.js && cd ../frontweb && node --test test/*.test.js` | pass | c103623+217ee28e41b48a14 | 2026-11-19T03:11:46Z |
| AC11 | test | record 012 | cli | `cd backend-node && node --test test/*.test.js && cd ../frontweb && node --test test/*.test.js` | pass | c103623+217ee28e41b48a14 | 2026-11-19T03:11:58Z |
| AC1 | build | record 013 | cli | `cd frontweb && npm run build` | pass | c103623+af6f8569e52610fe | 2026-11-19T03:12:24Z |
| AC1 | test | record 014 | cli | `cd backend-node && node --test test/*.test.js && cd ../frontweb && node --test test/*.test.js` | pass | c103623+af6f8569e52610fe | 2026-11-19T03:12:52Z |
| AC2 | test | record 015 | cli | `cd backend-node && node --test test/*.test.js && cd ../frontweb && node --test test/*.test.js` | pass | c103623+af6f8569e52610fe | 2026-11-19T03:13:07Z |
| AC3 | test | record 016 | cli | `cd backend-node && node --test test/*.test.js && cd ../frontweb && node --test test/*.test.js` | pass | c103623+af6f8569e52610fe | 2026-11-19T03:13:20Z |
| AC4 | test | record 017 | cli | `cd backend-node && node --test test/*.test.js && cd ../frontweb && node --test test/*.test.js` | pass | c103623+af6f8569e52610fe | 2026-11-19T03:13:40Z |
| AC6 | test | record 018 | cli | `cd backend-node && node --test test/*.test.js && cd ../frontweb && node --test test/*.test.js` | pass | c103623+af6f8569e52610fe | 2026-11-19T03:13:57Z |
| AC7 | test | record 019 | cli | `cd backend-node && node --test test/*.test.js && cd ../frontweb && node --test test/*.test.js` | pass | c103623+af6f8569e52610fe | 2026-11-19T03:14:11Z |
| AC8 | test | record 020 | cli | `cd backend-node && node --test test/*.test.js && cd ../frontweb && node --test test/*.test.js` | pass | c103623+af6f8569e52610fe | 2026-11-19T03:14:34Z |
| AC9 | test | record 021 | cli | `cd backend-node && node --test test/*.test.js && cd ../frontweb && node --test test/*.test.js` | pass | c103623+af6f8569e52610fe | 2026-11-19T03:14:49Z |
| AC10 | test | record 022 | cli | `cd backend-node && node --test test/*.test.js && cd ../frontweb && node --test test/*.test.js` | pass | c103623+af6f8569e52610fe | 2026-11-19T03:15:00Z |
| AC11 | test | record 023 | cli | `cd backend-node && node --test test/*.test.js && cd ../frontweb && node --test test/*.test.js` | pass | c103623+af6f8569e52610fe | 2026-11-19T03:15:11Z |
| AC1 | build | record 024 | cli | `cd frontweb && npm run build` | pass | c103623+af6f8569e52610fe | 2026-11-19T03:15:54Z |
| AC2 | build | record 025 | cli | `cd frontweb && npm run build` | pass | c103623+af6f8569e52610fe | 2026-11-19T03:16:56Z |
| AC6 | build | record 026 | cli | `cd frontweb && npm run build` | pass | c103623+af6f8569e52610fe | 2026-11-19T03:17:31Z |

2026-11-19 核查画风卡。用 Node 导入前端目录，逐项检查 thumb 是否指向现存文件，对文件计算 SHA-256，并用 sips 读取尺寸。39 个路径引用均可读，独立图片有 38 张。“都市3D风格”和“3D 渲染”引用同一张 3d-render.jpg。此检查只说明资源的存在与重复情况，视觉代表性需要逐卡评审。

以下是实施前使用本机随附 FFmpeg 的可行性实验。画风的实施与样片证据见 [画风验证记录](style-validation.md)。

- 临时生成两段 3 秒媒体，统一 288×512、12 fps、H.264，音频均为 48 kHz 的 440 Hz 正弦信号，经 AAC 编码。一段由 288×160 的青色画面居中填黑，另一段为铺满画面的青色。
- `ffprobe -v error -select_streams v:0 -show_entries stream=width,height -of csv=p=0` 对两段均返回 288,512。
- 对视频运行 `-an -vf cropdetect=limit=24:round=2 -f null -`。第一段全部报告的裁切框为 288:160:0:176，第二段为 288:512:0:0。
- 对音频运行 `-vn -af loudnorm=print_format=json -f null -`，两段均测得 -21.80 LUFS、-16.08 dBTP。该值是合成信号的读数，不作为发布目标。
- `-filters` 证实此工作区随附的 macOS 可执行文件具有 cropdetect、loudnorm、ebur128。此次实验未覆盖 Windows 或另一架构、真人录音、真实暗场识别率。

## Review

用户于 2026-11-19 确认整体设计。独立评审按 spec、项目约定和补丁核对，随后复验原始 PNG、真实模型应答、请求体、两轮无标题比图和实际窗口。详见 [画风验证记录](style-validation.md) 与 [FFmpeg 接入设计](ffmpeg-integration.md)。

| # | Finding | Severity | Disposition | Where |
|---|---|---|---|---|
| R1 | 首轮预设缺少足以比较的近邻证据。 | blocking | 已逐对比较；三组以相同人物、构图和服装重做，同步修订矢量提示词，再由独立评审盲判。 | style-neighbors.jpg、style-validation.md |
| R2 | 筛选、两处选择器与离线桌面需要实际操作。 | blocking | 用 Chrome 和 Electron 驱动详情与制作入口，核对真实请求、页面选项和已持久化选择。 | StylePickerButton.vue、桌面验证记录 |
| R3 | 旧工程若只存中文或自定义中英文分开，普通保存可能用模板重写。 | blocking | 保留旧值和语言槽；资料、剧本保存与显式采纳分别覆盖。 | styleOptions.js、FilmCreate.vue、useStoryGeneration.js |
| R4 | 静态检查和方法族不能证明运动结果与请求使用同一媒介。 | blocking | 4 条真实同题视频逐帧独立复核，角色、场景、道具、分镜与视频请求在 HTTP 边界捕获。 | style-motion.mp4、customStyleLibrary.test.js |
| R5 | FFmpeg 新增诊断、既有硬校验与并行 AC13/14 的所有者不够明确。 | should-fix | 指明候选身份解析、文件定位、渲染后的最终编码件、交付门槛和逐项降级。 | ffmpeg-integration.md |
| R6 | 旧预览的像素风等图片错配，两种 3D 共图。 | blocking | 重制全部内置预览，逐张校验、本地解码、对比和独立复核。 | style-thumbs、styleOptions.test.js |
| R7 | 采用时先更新界面可能掩盖服务器写入失败。 | blocking | 保存成功后再关闭、更新；实际浏览器模拟 503 和重试，旧选项保留。 | StylePickerButton.vue、DramaDetail.vue、FilmCreate.vue |
| R8 | 重新编码上传的图片会丢失原始内容。 | blocking | 验证图片之后保留原始字节，工程包异库往返校验上传 PNG 的 SHA-256、MIME 和逐字节内容。 | customStyleLibrary.js、workbenchArchiveIdentity.test.js |
| R9 | 单靠模拟模型不能说明反推结果是否夹带剧情。 | blocking | 使用真实视觉模型分析皮影，按最终提示词返回材质、色彩和层次，作者可改两个字段。 | style-validation.md |
| R10 | 模型不支持反向参数时，资产、分镜、视频入口缺少按实际模型的预告。 | blocking | 各入口走能力检查，道具复用默认供应商选择。支持路径去重传参，未知能力可取消或仅用正向继续。 | customStyles.js、stylePreflight.js、propImageGenerationService.js |
| R11 | 视频异步派发与分镜图可能读入项目后来采用的画风。 | blocking | 提交时固定视频正反向和分镜图画风，排队后改变项目再核对适配器实收。 | videos.js、imageService.js、customStyleLibrary.test.js |
| R12 | 长镜头文字可能挤掉 Qwen 的画风词。 | blocking | 在该模型的提示词长度范围内保留画风和镜头内容，复测新自定义、旧 noir 和自由文本。 | imageClient.js、customStyleLibrary.test.js |
| R13 | 并行质量链旧集的原始视频文字被默认写实描述改变。 | blocking | 保留旧调用裸提示词，另保留新目录及已采用图文，独立合并候选全量测试通过。 | videos.js、pipelineCoexistence.test.js |
| AC1 | 45+11 条来源归并、52 个稳定选项及两轮近邻审查。 | verdict | met | styleCatalog.json、style-neighbors.jpg |
| AC2 | 两入口别名搜索、空结果和恢复，桌面窗口与网页实测。 | verdict | met | StylePickerButton.vue、桌面验证记录 |
| AC3 | 原有 39 个值、自由文本、语言槽、工程包和旧项目保存。 | verdict | met | styleOptions.test.js、dramaStyleMergeCustom.test.js |
| AC4 | 实际资产、镜头请求与 4 条代表性短视频。 | verdict | met | customStyleLibrary.test.js、style-motion.jpg |
| AC5 | 逐镜有效画幅和最终混音的所有者、平台依赖、降级及样片。 | verdict | met | ffmpeg-integration.md |
| AC6 | 52 张独立可解码样图，逐卡复核、安装包资源和选择器实测。 | verdict | met | styleOptions.test.js、桌面验证记录 |
| AC7 | 创建、坏图、取消、写入失败重试、旧项目补图、重开。 | verdict | met | customStyleLibrary.test.js、实机浏览器 |
| AC8 | 新工程包在空白库恢复原始 PNG；缺失图片回滚。 | verdict | met | workbenchArchiveIdentity.test.js |
| AC9 | 真实反推、双向词可编辑、请求晚到保留草稿。 | verdict | met | style-validation.md |
| AC10 | 默认及显式模型、降级告知、真实候选生图和分镜参数。 | verdict | met | customStyleLibrary.test.js、custom-generated.png |
| AC11 | 两项目采用版本隔离，提交后更新项目仍使用原版，工程包保留图文。 | verdict | met | customStyleLibrary.test.js、workbenchArchiveIdentity.test.js |

## Deferred

FFmpeg 本期范围为调研、接入方案及原型测量。实时诊断界面、自动修正及跨平台误报率需要单独实施。

## Residual risks

代表性视频验证覆盖同题四秒镜头；长剧一致性、其他供应商的反向词能力及各平台黑边误报率尚需更多素材。

## macOS 安装包

营销版本 1.2.9，构建号 1.2.12。两份 Lite 安装包均通过 hdiutil 校验、只读挂载、应用深度签名校验、plist 版本、Mach-O 架构检查。在各自挂载卷内运行 Electron 44.8.0，实测 SQLite、Sharp、52 张随包图片、画风库接口及 FFmpeg 编解码。Intel 在 Apple Silicon 上通过 Rosetta 验证。本次是本地 ad-hoc 签名。两份安装包通过后，已将构建号 1.2.11 的两个 DMG 及其 blockmap 移到废纸篓。

| 架构 | desktop/release 中的产物 | SHA-256 |
|---|---|---|
| arm64 | LocalMiniDrama-Lite-1.2.9-build-1.2.12-mac-arm64.dmg | e6d2d5e80f764e7c18a98002781212b66eccb255ac394a6f64f9f452050a7f2b |
| x86_64 | LocalMiniDrama-Lite-1.2.9-build-1.2.12-mac-x64.dmg | 31a3be2da34743af1f73a2831bb6548722bf9253f598ecbbd7ceb30460ff9784 |

两个架构的实际 Electron 窗口均完成画风采用。用“浮世绘”在详情检索出唯一选项，选用“传统皮影”，在制作页重新打开并解码本地样图（宽 307 像素）。Intel 最终测试直接启动签名应用，使用单独的临时系统资料目录；Rosetta 的首次启动较慢。另从该架构的服务取回全部 52 张图片，与源码资源逐个字节相符。
