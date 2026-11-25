import fs from 'fs';
import path from 'path';
import { createRequire } from 'module';
import { fileURLToPath } from 'url';
import { z } from 'zod';
import { Agent } from '@mastra/core/agent';
import { Mastra } from '@mastra/core/mastra';
import { RequestContext } from '@mastra/core/request-context';
import { createTool } from '@mastra/core/tools';
import { LibSQLStore } from '@mastra/libsql';
import { Memory } from '@mastra/memory';
import { dramaThreadId } from './context.mjs';
import { resolveTextModel } from './model.mjs';
import { listSkillDirectories } from './skills.mjs';
import { guardDeleteApproval, toAgentSseEvent } from './sse.mjs';
import * as tools from './tools.mjs';

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));

let ready = false;
let agent;
let memory;
let appDb;
let appLog;
let appConfig;

function warn(message, err) {
  const error = err && err.message ? err.message : String(err || '');
  if (appLog && appLog.warn) appLog.warn(message, { error });
  else console.warn(message, error);
}

function readScope(ctx) {
  const source = ctx && ctx.requestContext;
  if (source && typeof source.get === 'function') {
    return { dramaId: source.get('dramaId'), episodeId: source.get('episodeId') };
  }
  return {
    dramaId: source && source.dramaId,
    episodeId: source && source.episodeId,
  };
}

function validateSkillMarkdown(markdown, dirName) {
  const fence = String(markdown || '').match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!fence) return { valid: false };
  const front = fence[1];
  const name = (front.match(/^name:\s*(\S+)\s*$/m) || [])[1];
  const description = (front.match(/^description:\s*(.+?)\s*$/m) || [])[1];
  if (!name || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name)) return { valid: false };
  if (!description || !description.trim()) return { valid: false };
  if (dirName && path.basename(dirName) !== name) return { valid: false };
  return { valid: true };
}

function loadService(name) {
  return require(`../services/${name}`);
}

function generationDeps() {
  return {
    startStoryGeneration: loadService('storyGenerationService.js').startStoryGeneration,
    generateCharacters: loadService('characterGenerationService.js').generateCharacters,
    extractBackgroundsForEpisode: loadService('backgroundExtractionService.js').extractBackgroundsForEpisode,
    generateStoryboard: loadService('episodeStoryboardService.js').generateStoryboard,
    generateCharacterFourViewImage: loadService('characterLibraryService.js').generateCharacterFourViewImage,
    generateSceneSingleImage: loadService('sceneService.js').generateSceneSingleImage,
    generateSceneFourViewImage: loadService('sceneService.js').generateSceneFourViewImage,
    updateStoryboard: loadService('storyboardService.js').updateStoryboard,
    createImage: loadService('imageService.js').create,
  };
}

function tool(id, description, inputSchema, execute, extra) {
  return createTool({ id, description, inputSchema, execute, ...extra });
}

function buildTools() {
  const empty = z.object({});
  return {
    get_current_project: tool('get_current_project', '读取当前短剧、分集、角色、场景和分镜', empty, async (_input, ctx) => {
      const scope = readScope(ctx);
      return tools.executeGetCurrentProject(appDb, scope.dramaId, scope.episodeId);
    }),
    generate_story: tool('generate_story', '为当前短剧生成剧本', empty, async (_input, ctx) => {
      const scope = readScope(ctx);
      return tools.executeGenerateStory(appDb, appLog, scope.dramaId, generationDeps());
    }),
    save_episode_script: tool('save_episode_script', '保存当前集的剧本', z.object({
      title: z.string().optional(),
      script: z.string(),
    }), async (input, ctx) => {
      const scope = readScope(ctx);
      return tools.executeSaveEpisodeScript(appDb, scope.dramaId, scope.episodeId, {
        title: input.title,
        scriptContent: input.script,
      });
    }),
    generate_characters: tool('generate_characters', '为当前集生成角色', empty, async (_input, ctx) => {
      const scope = readScope(ctx);
      return tools.executeGenerateCharacters(appDb, appConfig, appLog, scope.dramaId, scope.episodeId, generationDeps());
    }),
    update_character: tool('update_character', '新建或修改当前剧的角色', z.object({
      id: z.number().optional(),
      name: z.string().optional(),
      role: z.string().optional(),
      appearance: z.string().optional(),
      personality: z.string().optional(),
      description: z.string().optional(),
    }), async (input, ctx) => {
      const scope = readScope(ctx);
      return tools.executeUpdateCharacter(appDb, appLog, scope.dramaId, scope.episodeId, input);
    }),
    generate_scenes: tool('generate_scenes', '从当前集剧本提取场景', empty, async (_input, ctx) => {
      const scope = readScope(ctx);
      return tools.executeGenerateScenes(appDb, appConfig, appLog, scope.dramaId, scope.episodeId, generationDeps());
    }),
    update_scene: tool('update_scene', '新建或修改当前剧的场景', z.object({
      id: z.number().optional(),
      location: z.string().optional(),
      time: z.string().optional(),
      prompt: z.string().optional(),
    }), async (input, ctx) => {
      const scope = readScope(ctx);
      return tools.executeUpdateScene(appDb, appLog, scope.dramaId, scope.episodeId, input);
    }),
    generate_storyboards: tool('generate_storyboards', '为当前集生成分镜', z.object({
      storyboardCount: z.number().optional(),
    }), async (input, ctx) => {
      const scope = readScope(ctx);
      return tools.executeGenerateStoryboards(appDb, appLog, scope.dramaId, scope.episodeId, input, generationDeps());
    }),
    update_storyboard: tool('update_storyboard', '修改当前剧的一条分镜', z.object({
      id: z.number(),
      dialogue: z.string().optional(),
      action: z.string().optional(),
      description: z.string().optional(),
      imagePrompt: z.string().optional(),
      segmentIr: z.string().optional().describe('有 segment_ir 的分镜：修改后的完整结构化分镜 JSON；这类分镜的台词和动作只能这样改'),
    }), async (input, ctx) => {
      const scope = readScope(ctx);
      return tools.executeUpdateStoryboard(appDb, appLog, scope.dramaId, input);
    }),
    generate_image: tool('generate_image', '为角色、场景或分镜出图', z.object({
      type: z.enum(['character', 'scene', 'storyboard']),
      id: z.number(),
      view: z.enum(['single', 'four']).optional(),
      prompt: z.string().optional(),
    }), async (input, ctx) => {
      const scope = readScope(ctx);
      return tools.executeGenerateImage(appDb, appLog, appConfig, scope.dramaId, input, generationDeps());
    }),
    get_task: tool('get_task', '查询当前剧的一个生成任务', z.object({
      taskId: z.string(),
    }), async (input, ctx) => {
      const scope = readScope(ctx);
      return tools.executeGetTask(appDb, scope.dramaId, input);
    }),
    delete_item: tool('delete_item', '删除当前剧的角色、场景或分镜，必须等用户允许', z.object({
      type: z.enum(['character', 'scene', 'storyboard']),
      id: z.number(),
    }), async (input, ctx) => {
      const scope = readScope(ctx);
      return tools.executeDeleteItem(appDb, appLog, scope.dramaId, input);
    }, {
      requireApproval: true,
      beforeApproval(input, ctx) {
        const scope = readScope(ctx);
        const guard = guardDeleteApproval(appDb, scope.dramaId, input);
        if (guard.action === 'decline') return { proceed: false, output: { ok: false, error: guard.error } };
      },
    }),
    get_series_notes: tool('get_series_notes', '读取当前剧的全剧笔记（事实、伏笔、弧线）', z.object({
      kind: z.string().optional(),
    }), async (input, ctx) => {
      const scope = readScope(ctx);
      return tools.executeGetSeriesNotes(appDb, scope.dramaId, input);
    }),
    save_series_notes: tool('save_series_notes', '保存当前剧的全剧笔记，需带 revision 防止覆盖', z.object({
      kind: z.string().optional(),
      expected_revision: z.number(),
      document: z.record(z.string(), z.unknown()),
    }), async (input, ctx) => {
      const scope = readScope(ctx);
      return tools.executeSaveSeriesNotes(appDb, scope.dramaId, input);
    }),
    check_series_continuity: tool('check_series_continuity', '核对剧本是否保留全剧不可变事实', z.object({
      script: z.string(),
    }), async (input, ctx) => {
      const scope = readScope(ctx);
      return tools.executeCheckSeriesContinuity(appDb, scope.dramaId, scope.episodeId, input.script);
    }),
    review_episode_deep: tool('review_episode_deep', '对当前集做深审，产出带证据的诊断 finding', z.object({
      mode: z.enum(['selection', 'first-three', 'dialogue', 'full']).optional(),
    }), async (input, ctx) => {
      const scope = readScope(ctx);
      return tools.executeReviewEpisodeDeep(appDb, appLog, scope.dramaId, scope.episodeId, input);
    }),
    propose_script_edits: tool('propose_script_edits', '按 finding 产出最小改动提议，不直接改剧本', z.object({
      finding_ids: z.array(z.string()).min(1),
    }), async (input, ctx) => {
      const scope = readScope(ctx);
      return tools.executeProposeScriptEdits(appDb, appLog, scope.dramaId, scope.episodeId, input);
    }),
    get_source_facts: tool('get_source_facts', '读取小说源文本的事实卡，检测源是否变化', z.object({
      source_hash: z.string().optional(),
    }), async (input, ctx) => {
      const scope = readScope(ctx);
      return tools.executeGetSourceFacts(appDb, scope.dramaId, input);
    }),
    propose_episode_split: tool('propose_episode_split', '按可拍事件提议小说分集切点，不写剧集', z.object({
      source_hash: z.string().optional(),
      episode_count: z.number().int().min(1).max(200),
    }), async (input, ctx) => {
      const scope = readScope(ctx);
      return tools.executeProposeEpisodeSplit(appDb, scope.dramaId, input);
    }),
    get_asset_matrix: tool('get_asset_matrix', '读取全剧角色/场景/道具资产矩阵与状态提议', z.object({}), async (_input, ctx) => {
      const scope = readScope(ctx);
      return tools.executeGetAssetMatrix(appDb, scope.dramaId);
    }),
    propose_prop_states: tool('propose_prop_states', '按本集剧本提议道具状态，只写笔记不落库', z.object({}), async (_input, ctx) => {
      const scope = readScope(ctx);
      return tools.executeProposePropStates(appDb, appLog, scope.dramaId, scope.episodeId);
    }),
    check_asset_lock: tool('check_asset_lock', '检查分镜引用的资产是否就绪、是否有连续性锁', z.object({
      storyboard_id: z.number(),
    }), async (input, ctx) => {
      const scope = readScope(ctx);
      return tools.executeCheckAssetLock(appDb, scope.dramaId, scope.episodeId, input.storyboard_id);
    }),
    propose_blocking: tool('propose_blocking', '为一场戏提议主机位、轴线与逐拍动作，不写分镜', z.object({
      scene_id: z.number().optional(),
    }), async (input, ctx) => {
      const scope = readScope(ctx);
      return tools.executeProposeBlocking(appDb, appLog, scope.dramaId, scope.episodeId, input);
    }),
    review_shot_continuity: tool('review_shot_continuity', '用现有编译器复核结构化分镜的连续性，不修改分镜', z.object({
      storyboard_id: z.number(),
    }), async (input, ctx) => {
      const scope = readScope(ctx);
      return tools.executeReviewShotContinuity(appDb, scope.dramaId, scope.episodeId, input.storyboard_id);
    }),
    get_take_evidence: tool('get_take_evidence', '聚合成片的提交提示词、媒体检测、参考图与审片证据，不抽帧不改片', z.object({
      storyboard_id: z.number(),
      take_id: z.number(),
    }), async (input, ctx) => {
      const scope = readScope(ctx);
      return tools.executeGetTakeEvidence(appDb, scope.dramaId, scope.episodeId, input);
    }),
    record_clip_findings: tool('record_clip_findings', '把作者目视确认的成片问题与归因写入质检笔记，需引用证据', z.object({
      evidence: z.record(z.string(), z.unknown()),
      expected_revision: z.number().int().min(0),
      findings: z.array(z.object({
        class: z.enum(['requirement_not_executed', 'single_take_variance', 'prompt_under_specified']),
        evidence_ids: z.array(z.string()).min(1),
        visible_evidence: z.string(),
        action: z.enum(['revise', 'replace', 'reshoot']).optional(),
        note: z.string().optional(),
      })).min(1),
    }), async (input, ctx) => {
      const scope = readScope(ctx);
      return tools.executeRecordClipFindings(appDb, scope.dramaId, scope.episodeId, input);
    }),
  };
}

function messageText(message) {
  const content = message && message.content;
  if (typeof content === 'string') return content;
  const parts = Array.isArray(content) ? content : (content && Array.isArray(content.parts) ? content.parts : []);
  return parts.map((part) => (part && part.type === 'text' ? part.text || '' : '')).join('');
}

async function emitStream(output, dramaId, writeEvent) {
  const stream = output && output.fullStream ? output.fullStream : output;
  for await (const chunk of stream) {
    const event = toAgentSseEvent(chunk);
    if (!event) continue;
    if (event.type === 'tool-call-approval') {
      const guard = guardDeleteApproval(appDb, dramaId, { type: event.itemType, id: event.id });
      if (guard.action === 'ask') event.label = guard.label;
    }
    writeEvent(event);
  }
  writeEvent({ type: 'done' });
}

function threadOptions(dramaId, requestContext) {
  const thread = dramaThreadId(dramaId);
  return {
    requestContext,
    memory: { thread, resource: thread },
  };
}

export function isAgentReady() {
  return ready;
}

export async function initAgent({ db, log, config, dataDir }) {
  ready = false;
  appDb = db;
  appLog = log;
  appConfig = config || {};
  try {
    const dir = dataDir || path.join(process.cwd(), 'data');
    fs.mkdirSync(dir, { recursive: true });
    tools.configureP0Tools({ db, dataDir: dir });
    const file = path.join(dir, 'agent.db').replace(/\\/g, '/');
    const storage = new LibSQLStore({ id: 'drama-agent', url: `file:${file}` });
    memory = new Memory({ storage, options: { lastMessages: 20, semanticRecall: false } });
    const builtinDir = path.resolve(here, '../../skills/short-drama');
    const userSkillsDir = path.join(dir, 'skills');
    agent = new Agent({
      id: 'drama-assistant',
      name: '短剧助手',
      instructions: '你是本地短剧助手。只操作当前打开的短剧。删除必须调用 delete_item 并等待用户允许。没有出视频、导入导出、道具、新建或删除整部剧的工具。',
      model: () => {
        const resolved = resolveTextModel(appDb);
        if (!resolved.ok) throw new Error(resolved.error);
        return resolved.model;
      },
      tools: buildTools(),
      skills: () => listSkillDirectories({
        builtinDir,
        userSkillsDir,
        log: appLog || { warn() {} },
        validate: validateSkillMarkdown,
      }),
      memory,
      requestContextSchema: z.object({
        dramaId: z.number(),
        episodeId: z.number().nullable(),
      }),
    });
    new Mastra({ agents: { dramaAssistant: agent }, storage });
    ready = true;
  } catch (err) {
    ready = false;
    agent = undefined;
    memory = undefined;
    warn('助手初始化失败', err);
  }
}

export async function streamChat({ dramaId, episodeId, message, writeEvent }) {
  if (!ready) throw new Error('助手未就绪');
  const requestContext = new RequestContext();
  requestContext.set('dramaId', Number(dramaId));
  requestContext.set('episodeId', episodeId == null ? null : Number(episodeId));
  const output = await agent.stream(message, threadOptions(dramaId, requestContext));
  await emitStream(output, dramaId, writeEvent);
}

export async function resumeApproval({ dramaId, episodeId, runId, toolCallId, approved, writeEvent }) {
  if (!ready) throw new Error('助手未就绪');
  const requestContext = new RequestContext();
  requestContext.set('dramaId', Number(dramaId));
  // 恢复的运行沿用用户当前的集；不传时保持 null（工具会提示“请指定哪一集”）
  requestContext.set('episodeId', episodeId == null ? null : Number(episodeId));
  const options = { runId, toolCallId, ...threadOptions(dramaId, requestContext) };
  const output = approved
    ? await agent.approveToolCall(options)
    : await agent.declineToolCall({ ...options, reason: '用户拒绝了这次删除' });
  await emitStream(output, dramaId, writeEvent);
}

export async function getHistory(dramaId) {
  const thread = dramaThreadId(dramaId);
  const messages = [];
  const pendingApprovals = [];
  if (memory) {
    try {
      const recalled = await memory.recall({ threadId: thread, resourceId: thread });
      for (const message of recalled.messages || []) {
        messages.push({ role: message.role || '', text: messageText(message) });
      }
    } catch (_) {
      /* 新线程还没有记录 */
    }
  }
  if (agent) {
    try {
      const listed = await agent.listSuspendedRuns({ threadId: thread, resourceId: thread });
      for (const run of listed.runs || []) {
        for (const call of run.toolCalls || []) {
          if (!call.requiresApproval) continue;
          const args = call.args || {};
          const guard = guardDeleteApproval(appDb, dramaId, args);
          pendingApprovals.push({
            runId: run.runId,
            toolCallId: call.toolCallId,
            toolName: call.toolName,
            type: args.type,
            id: args.id,
            label: guard.action === 'ask' ? guard.label : '',
          });
        }
      }
    } catch (_) {
      /* 还没有待确认的操作 */
    }
  }
  return { messages, pendingApprovals };
}
