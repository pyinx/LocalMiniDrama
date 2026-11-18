// 根据故事梗概 + 风格/类型/集数，调用文本模型生成扩展后的故事/剧本（JSON 数组格式）
const aiClient = require('./aiClient');
const promptI18n = require('./promptI18n');
const taskService = require('./taskService');
const dramaService = require('./dramaService');
const { safeParseAIJSON } = require('../utils/safeJson');
const loadConfig = require('../config').loadConfig;
const { applySelectedEpisodes } = require('./novelImportService');

async function generateStory(db, log, body) {
  const premise = (body.premise || body.prompt || body.text || '').trim();
  if (!premise) {
    throw new Error('请提供故事梗概');
  }
  const cfg = loadConfig();
  const style = body.style || body.genre || null;
  const type = body.type || null;
  const episodeCount = Math.max(1, Math.floor(Number(body.episode_count) || 1));

  const systemPrompt = promptI18n.getStoryExpansionSystemPrompt(cfg, episodeCount);
  const userPrompt = require('./workbenchCreativeMethods').withCreativeGuidance(db,
    promptI18n.buildStoryExpansionUserPrompt(cfg, premise, style, type, episodeCount), body.drama_id, 'story');

  // 每集约 800 字（中文）≈ 1600 token，多留余量作为最低需求；
  // 不使用 max_tokens 硬上限，而是用 min_max_tokens 确保即使用户 AI 配置了小上限也能保证基本输出量。
  const minTokensNeeded = Math.max(2000, episodeCount * 2200);

  // 注意：不使用 json_mode=true，因为 response_format:json_object 要求返回 JSON 对象而非数组，
  // 会导致模型将数组包成 {"episodes":[...]} 对象，破坏解析逻辑。依靠 prompt 本身约束格式即可。
  const rawText = await aiClient.generateText(db, log, 'text', userPrompt, systemPrompt, {
    scene_key: 'story_generation',
    model: body.model || undefined,
    temperature: 0.8,
    min_max_tokens: minTokensNeeded,
  });

  log && log.info && log.info('Story raw response', {
    text_length: (rawText || '').length,
    episode_count: episodeCount,
    text_preview: (rawText || '').slice(0, 200),
  });

  // 解析 JSON，支持多种 AI 返回格式
  let parsed = null;
  try {
    parsed = safeParseAIJSON(rawText, log);
  } catch (e) {
    log && log.warn && log.warn('Story JSON parse failed', { error: e.message });
  }

  // 规范化为集数数组，兼容以下常见 AI 输出格式：
  // 1. 直接数组 [{episode,title,content}, ...]
  // 2. 包装对象 { episodes: [...] } 或 { data: [...] }
  // 3. 单个对象 {episode:1, title, content}（只生成1集时）
  let episodeList = null;
  if (Array.isArray(parsed)) {
    episodeList = parsed;
  } else if (parsed && typeof parsed === 'object') {
    const keys = Object.keys(parsed);
    // 找第一个 value 是数组的字段（如 episodes / data / items）
    const arrKey = keys.find(k => Array.isArray(parsed[k]));
    if (arrKey) {
      episodeList = parsed[arrKey];
    } else if (parsed.content || parsed.episode) {
      // 单集对象
      episodeList = [parsed];
    }
  }

  if (episodeList && episodeList.length > 0) {
    const result = episodeList.map((ep, i) => ({
      episode: Number(ep.episode ?? i + 1),
      title: (ep.title || `第${Number(ep.episode ?? i + 1)}集`).trim(),
      content: (ep.content || ep.script || ep.text || ep.body || '').trim(),
    })).filter(ep => ep.content.length > 0);

    if (result.length > 0) {
      log && log.info && log.info('Story episodes parsed', { count: result.length });
      return { episodes: result };
    }
  }

  // 兜底：JSON 解析失败或返回纯文本，把整段文本当作第 1 集正文
  log && log.warn && log.warn('Story JSON parse gave no valid episodes, treating as plain text', {
    text_length: (rawText || '').length,
  });
  const fallbackContent = (rawText || '').trim();
  return {
    episodes: [{
      episode: 1,
      title: '第1集',
      content: fallbackContent,
    }],
  };
}

function hasEpisodes(db, dramaId) {
  return Boolean(db.prepare('SELECT 1 FROM episodes WHERE drama_id=? AND deleted_at IS NULL LIMIT 1').get(dramaId));
}

function listProposals(db, dramaId) {
  const tasks = db.prepare(`SELECT id, completed_at, result FROM async_tasks
    WHERE type='story_generation' AND resource_id=? AND status='completed' AND deleted_at IS NULL
      AND CASE WHEN json_valid(result) THEN json_array_length(result,'$.proposals') > 0 END
    ORDER BY completed_at DESC`).all(String(dramaId));
  return tasks.map(({ id, completed_at, result }) => ({ id, completed_at, episodes: JSON.parse(result).proposals }));
}

function adoptProposal(db, dramaId, taskId, selections) {
  return db.transaction(() => {
    const task = taskService.getTask(db, taskId);
    if (task?.type !== 'story_generation' || task.resource_id !== String(dramaId) || task.status !== 'completed') {
      throw Object.assign(new Error('当前项目没有这份拟稿'), { status: 404 });
    }
    const result = JSON.parse(task.result);
    if (!Array.isArray(selections) || !selections.length) throw Object.assign(new Error('请先选择拟采用的集'), { status: 400 });
    const rows = selections.map(selection => {
      const proposal = result.proposals?.find(ep => ep.episode_number === selection?.episode_number);
      if (!proposal) throw Object.assign(new Error('拟稿已变化，请重新读取'), { status: 409 });
      return { ...proposal, expected: selection.expected };
    });
    const applied = applySelectedEpisodes(db, dramaId, rows);
    result.proposals = result.proposals.filter(ep => !applied.episode_numbers.includes(ep.episode_number));
    db.prepare('UPDATE async_tasks SET result=? WHERE id=?').run(JSON.stringify(result), taskId);
    return applied;
  }).immediate();
}

async function processStoryGeneration(db, log, taskId, req, startedWithEpisodes) {
  taskService.updateTaskStatus(db, taskId, 'processing', 10, '正在生成剧本...');
  try {
    const result = await generateStory(db, log, req);
    const episodes = result?.episodes || [];
    if (!episodes.length || episodes.some(ep => !ep.content?.trim() || !Number.isSafeInteger(ep.episode) || ep.episode < 1)
        || new Set(episodes.map(ep => ep.episode)).size !== episodes.length) {
      taskService.updateTaskError(db, taskId, 'AI 未能生成剧本');
      return;
    }

    const dramaId = Number(req.drama_id);
    const rows = episodes.map(ep => ({ episode_number: ep.episode, title: ep.title, script_content: ep.content }));
    db.transaction(() => {
      if (taskService.getTask(db, taskId)?.status !== 'processing') return;
      const result = { drama_id: dramaId, episode_count: rows.length };
      if (startedWithEpisodes || hasEpisodes(db, dramaId)) {
        result.proposals = rows;
      } else {
        applySelectedEpisodes(db, dramaId, rows.map(row => ({ ...row, expected: null })));
        if (req.summary || req.genre || req.drama_style || req.metadata || req.title) {
          dramaService.saveOutline(db, log, dramaId, {
            title: req.title, summary: req.summary, genre: req.genre, style: req.drama_style, metadata: req.metadata,
          });
        }
      }
      taskService.updateTaskResult(db, taskId, result);
    }).immediate();
  } catch (err) {
    log.error('processStoryGeneration failed', { task_id: taskId, error: err.message });
    taskService.updateTaskError(db, taskId, err.message || '故事生成失败');
  }
}

function startStoryGeneration(db, log, req) {
  const dramaId = String(req.drama_id || '');
  if (!dramaId) throw new Error('drama_id 必填');
  if (!dramaService.getDramaById(db, Number(dramaId))) {
    throw new Error('项目不存在');
  }

  const existing = db.prepare(
    `SELECT id FROM async_tasks
     WHERE resource_id = ? AND type = 'story_generation'
       AND status IN ('pending', 'processing') AND deleted_at IS NULL
     ORDER BY created_at DESC LIMIT 1`
  ).get(dramaId);
  if (existing) {
    log.info('Story generation already running', { task_id: existing.id, drama_id: dramaId });
    return existing.id;
  }

  const task = taskService.createTask(db, log, 'story_generation', dramaId);
  const startedWithEpisodes = hasEpisodes(db, dramaId);
  setImmediate(() => {
    if (taskService.getTask(db, task.id)?.status !== 'pending') return;
    processStoryGeneration(db, log, task.id, req, startedWithEpisodes).catch((err) => {
      log.error('processStoryGeneration fatal', { error: err.message, task_id: task.id });
      taskService.updateTaskError(db, task.id, err.message || '故事生成失败');
    });
  });
  return task.id;
}

module.exports = {
  generateStory,
  startStoryGeneration,
  listProposals,
  adoptProposal,
};
