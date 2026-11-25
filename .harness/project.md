# Project

Owned by humans. The agent proposes changes; a human approves them.
This file is loaded at session start. Keep it short.

## Stack

Pure JavaScript. Backend: Node.js + Express + better-sqlite3 (`backend-node/`, port 5679). Frontend: Vue 3 + Vite (`frontweb/`, port 3013). Desktop shell in `desktop/`. npm.

## Commands

The harness runs these; it never guesses them. Leave a value empty to disable that check.

| Key | Command | Notes |
|---|---|---|
| `test` | `cd backend-node && node --test test/*.test.js && cd ../frontweb && node --test test/*.test.js` | 需要带 libass 和 libx264 的 ffmpeg，否则 3 个配音/字幕相关测试失败（Homebrew 的 ffmpeg 缺 libass）。本机先 `export FFMPEG_PATH=$HOME/.local/share/ffmpeg-static/ffmpeg`。backend 483 + frontend 65 tests |
| `test:one` | `node --test {file}` | `{file}` relative to repo root |
| `lint` | | |
| `typecheck` | | |
| `build` | `cd frontweb && npm run build` | |
| `run` | `cd backend-node && npm run dev` | frontend dev server: `cd frontweb && npm run dev` |
| `e2e` | | end-to-end tests against a running app |
| `coverage` | | must exit 0 and print a total line (`TOTAL … N%` or istanbul's `All files` row), checked against `coverage-floor` |

## Gates

| Key | Value | Meaning |
|---|---|---|
| `coverage-floor` | | percent, e.g. `80`. Empty means no floor. |
| `review-required` | `T2` | lowest tier that requires an independent review |

## Hard constraints

Non-negotiable rules for this repository. Each one line. The harness copies these into the
always-loaded block, so keep the list under 15 lines.

<!-- - Never widen a database column without a migration. -->

## Capability map

Entry points for capabilities that already exist. This is a map of *where things live*, not an
inventory. Keep it small and stable; it exists so the agent reuses instead of rebuilding.
Drafted by `hx init`, confirmed by a human.

<!-- hx-draft: needs review -->
| Capability | Entry point | Notes |
|---|---|---|
| Video provider calls | `backend-node/src/services/videoClient.js` | all protocols (volcengine/omni Seedance, minimax_h3, dashscope wan, jimeng_ai_api, …); per-model limits currently scattered here |
| Image provider calls | `backend-node/src/services/imageClient.js` | incl. Volcengine Seedream |
| Storyboard + video prompt (classic) | `backend-node/src/services/episodeStoryboardService.js` | `generateVideoPrompt`, segment duration |
| Video prompt (universal multi-beat) | `backend-node/src/services/universalOmniMultiBeatFormat.js`, `universalSegmentPromptBundle.js` | |
| LLM prompt templates | `backend-node/src/services/promptI18n.js` | |
| Drama style resolution | `backend-node/src/utils/dramaStyleMerge.js` | `mergeCfgStyleWithDrama` |
| Character sheets | `backend-node/src/services/characterLibraryService.js` | four-view sheet; `characters.stages` column unused |
| Scene images | `backend-node/src/services/sceneService.js` | quad-grid or single |
| Episode merge + post | `backend-node/src/services/videoMergeService.js`, `mergedEpisodePostProcess.js` | ffmpeg concat, subtitles, TTS mix |
| TTS | `backend-node/src/services/ttsService.js` | minimax / OpenAI-compatible |
| DB schema + migrations | `backend-node/src/db/migrate.js` | `ensureColumns()` on startup |
| In-app agent + skills | `backend-node/src/mastra/index.mjs`, `skills.mjs` | loads `backend-node/skills/` (主助手只挂载 `skills/short-drama`) |
| Frontend HTTP | `frontweb/src/utils/request.js` | |
| Storyboard UI | `frontweb/src/views/FilmCreate.vue` | `buildSbVideoPromptForApi` |

## Regression watchlist

Areas that break easily or matter most. A change that touches one runs its regression check, not
only the new test. Each line: the path, then why it is fragile.

<!-- hx-draft: needs review -->
<!-- - `frontweb/src/views/FilmCreate.vue` — changed in 54 of the last 200 commits -->
<!-- - `backend-node/src/services/videoClient.js` — changed in 40 of the last 200 commits -->
<!-- - `backend-node/src/services/imageClient.js` — changed in 26 of the last 200 commits -->
<!-- - `frontweb/src/components/AIConfigContent.vue` — changed in 26 of the last 200 commits -->
<!-- - `backend-node/src/routes/index.js` — changed in 18 of the last 200 commits -->
<!-- - `backend-node/src/services/dramaService.js` — changed in 18 of the last 200 commits -->
<!-- - `backend-node/src/services/episodeStoryboardService.js` — changed in 18 of the last 200 commits -->
<!-- - `backend-node/src/services/promptI18n.js` — changed in 18 of the last 200 commits -->
<!-- - `backend-node/src/services/characterLibraryService.js` — changed in 17 of the last 200 commits -->
<!-- - `backend-node/src/db/migrate.js` — changed in 16 of the last 200 commits -->
<!-- - `src/billing/` — rounding; every change reruns the invoice fixtures. -->

## Conventions

<!-- naming, test layout, error handling, logging, commit style -->
