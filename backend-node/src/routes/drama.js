const dramaService = require('../services/dramaService');
const propService = require('../services/propService');
const response = require('../response');
const videoSettings = require('../services/videoSettings');
const dramaExportService = require('../services/dramaExportService');
const dramaImportService = require('../services/dramaImportService');

function createDrama(db, log) {
  return (req, res) => {
    const body = req.body || {};
    if (!body.title || String(body.title).trim() === '') {
      return response.badRequest(res, '标题不能为空');
    }
    try {
      const drama = dramaService.createDrama(db, log, body);
      response.created(res, drama);
    } catch (err) {
      log.error('Create drama failed', { error: err.message, stack: err.stack });
      response.internalError(res, err.message || '创建失败');
    }
  };
}

function getDrama(db, cfg) {
  return (req, res) => {
    const drama = dramaService.getDrama(db, req.params.id, cfg?.storage?.base_url);
    if (!drama) return response.notFound(res, '剧本不存在');
    response.success(res, drama);
  };
}

function listDramas(db, log) {
  return (req, res) => {
    const page = req.query.page || 1;
    const page_size = req.query.page_size || 20;
    const status = req.query.status || '';
    const genre = req.query.genre || '';
    const keyword = req.query.keyword || '';
    try {
      const { dramas, total, page: p, pageSize: ps } = dramaService.listDramas(db, {
        page,
        page_size,
        status,
        genre,
        keyword,
      });
      response.successWithPagination(res, dramas, total, p, ps);
    } catch (err) {
      log.errorw('List dramas failed', { error: err.message });
      response.internalError(res, '获取列表失败');
    }
  };
}

function updateDrama(db, log) {
  return (req, res) => {
    const drama = dramaService.updateDrama(db, log, req.params.id, req.body || {});
    if (!drama) return response.notFound(res, '剧本不存在');
    response.success(res, drama);
  };
}

function deleteDrama(db, log) {
  return (req, res) => {
    const ok = dramaService.deleteDrama(db, log, req.params.id);
    if (!ok) return response.notFound(res, '剧本不存在');
    response.success(res, { message: '删除成功' });
  };
}

function getDramaStats(db, log) {
  return (req, res) => {
    try {
      const stats = dramaService.getDramaStats(db);
      response.success(res, stats);
    } catch (err) {
      log.errorw('Get drama stats failed', { error: err.message });
      response.internalError(res, '获取统计失败');
    }
  };
}

function saveOutline(db, log) {
  return (req, res) => {
    const ok = dramaService.saveOutline(db, log, req.params.id, req.body || {});
    if (!ok) return response.notFound(res, '剧本不存在');
    response.success(res, { message: '保存成功' });
  };
}

function videoSettingsHandler(save, idParam, notFoundMessage, db, log) {
  return (req, res) => {
    try {
      const result = save(db, log, req.params[idParam], req.body);
      if (!result) return response.notFound(res, notFoundMessage);
      response.success(res, result);
    } catch (err) {
      if (err.status === 400) return response.badRequest(res, err.message);
      log.errorw('Save video settings failed', { error: err.message });
      response.internalError(res, '保存视频配置失败');
    }
  };
}

function getCharacters(db) {
  return (req, res) => {
    const characters = dramaService.getCharacters(db, req.params.id, req.query.episode_id);
    if (characters === null) return response.notFound(res, '剧本或章节不存在');
    response.success(res, characters);
  };
}

function saveCharacters(db, log) {
  return (req, res) => {
    const body = req.body || {};
    if (!Array.isArray(body.characters)) return response.badRequest(res, 'characters 必填且为数组');
    const ok = dramaService.saveCharacters(db, log, req.params.id, body);
    if (!ok) return response.notFound(res, '剧本或章节不存在');
    response.success(res, { message: '保存成功' });
  };
}

function saveEpisodes(db, log) {
  return (req, res) => {
    const body = req.body || {};
    if (!Array.isArray(body.episodes)) return response.badRequest(res, 'episodes 必填且为数组');
    const ok = dramaService.saveEpisodes(db, log, req.params.id, body);
    if (!ok) return response.notFound(res, '剧本不存在');
    response.success(res, { message: '保存成功' });
  };
}

function saveProgress(db, log) {
  return (req, res) => {
    const body = req.body || {};
    if (!body.current_step) return response.badRequest(res, 'current_step 必填');
    const ok = dramaService.saveProgress(db, log, req.params.id, body);
    if (!ok) return response.notFound(res, '剧本不存在');
    response.success(res, { message: '保存成功' });
  };
}

function saveCanvasLayout(db, log) {
  return (req, res) => {
    try {
      const updated = dramaService.saveCanvasLayout(db, log, req.params.id, req.body || {});
      if (!updated) return response.notFound(res, '剧本不存在');
      response.success(res, updated);
    } catch (err) {
      if (err.code === 'BAD_REQUEST') return response.badRequest(res, err.message);
      log.error('Save canvas layout failed', { error: err.message });
      response.internalError(res, err.message || '保存画布布局失败');
    }
  };
}

function listProps(db) {
  return (req, res) => {
    const props = propService.listByDramaId(db, req.params.id);
    response.success(res, props);
  };
}

function finalizeEpisode(db, log, cfg) {
  return (req, res) => {
    const episodeId = req.params.episode_id;
    if (!episodeId) return response.badRequest(res, 'episode_id不能为空');
    const baseUrl = cfg?.storage?.base_url || '';
    const result = dramaService.finalizeEpisode(db, log, episodeId, baseUrl, req.body || {});
    if (!result) return response.notFound(res, '剧集不存在');
    if (result.error) return response.error(res, 422, 'INCOMPLETE_DELIVERY', result.error, { missing_shots: result.missing_shots });
    response.success(res, result);
  };
}

function downloadEpisodeVideo(db) {
  return (req, res) => {
    const episodeId = req.params.episode_id;
    if (!episodeId) return response.badRequest(res, 'episode_id不能为空');
    const result = dramaService.downloadEpisodeVideo(db, episodeId);
    if (!result) return response.notFound(res, '剧集不存在');
    if (result.error) return response.badRequest(res, result.error);
    response.success(res, result);
  };
}

function exportDrama(db, cfg, log) {
  return (req, res) => {
    try {
      const { buffer, title } = dramaExportService.exportDrama(db, cfg, log, req.params.id,
        req.query.take_ids ? String(req.query.take_ids).split(',') : []);
      const safeName = (title || 'drama').replace(/[^\w\u4e00-\u9fff\-]/g, '_').slice(0, 50);
      res.setHeader('Content-Type', 'application/zip');
      res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(safeName)}.zip`);
      res.send(buffer);
    } catch (err) {
      if (err.status) return response.error(res, err.status, 'EXPORT_ERROR', err.message);
      log.error('Export drama failed', { error: err.message });
      response.internalError(res, err.message || '导出失败');
    }
  };
}

function importDrama(db, cfg, log) {
  return (req, res) => {
    try {
      if (!req.file || !req.file.buffer) {
        return response.badRequest(res, '请上传 ZIP 文件');
      }
      const result = dramaImportService.importDrama(db, cfg, log, req.file.buffer);
      response.created(res, result);
    } catch (err) {
      log.error('Import drama failed', { error: err.message });
      if (err.message && (err.message.includes('格式') || err.message.includes('缺少') || err.message.includes('损坏'))) {
        return response.badRequest(res, err.message);
      }
      response.internalError(res, err.message || '导入失败');
    }
  };
}

function getExampleDramaDir() {
  const path = require('path');
  const fs = require('fs');
  if (process.env.EXAMPLE_DRAMA_PATH && fs.existsSync(process.env.EXAMPLE_DRAMA_PATH)) {
    return process.env.EXAMPLE_DRAMA_PATH;
  }
  const devPath = path.join(__dirname, '..', '..', '..', 'example_drama');
  if (fs.existsSync(devPath)) return devPath;
  return null;
}

function listExamples(log) {
  return (_req, res) => {
    const fs = require('fs');
    const dir = getExampleDramaDir();
    if (!dir) return response.success(res, []);
    try {
      const files = fs.readdirSync(dir).filter(f => f.endsWith('.zip'));
      const items = files.map(f => {
        const name = f.replace(/\.zip$/, '');
        return { filename: f, name };
      });
      response.success(res, items);
    } catch (err) {
      log.error('List examples failed', { error: err.message });
      response.success(res, []);
    }
  };
}

function importExample(db, cfg, log) {
  return (req, res) => {
    const fs = require('fs');
    const path = require('path');
    const filename = req.body?.filename;
    if (!filename) return response.badRequest(res, '请指定示例文件名');
    if (filename.includes('..') || filename.includes('/') || filename.includes('\\')) {
      return response.badRequest(res, '文件名不合法');
    }
    const dir = getExampleDramaDir();
    if (!dir) return response.badRequest(res, '示例目录不存在');
    const filePath = path.join(dir, filename);
    if (!fs.existsSync(filePath)) return response.notFound(res, '示例文件不存在');
    try {
      const buffer = fs.readFileSync(filePath);
      const result = dramaImportService.importDrama(db, cfg, log, buffer);
      response.created(res, result);
    } catch (err) {
      log.error('Import example failed', { error: err.message });
      response.internalError(res, err.message || '导入示例失败');
    }
  };
}

function generateStoryboard(db, log) {
  return async (req, res) => {
    const body = req.body || {};
    try {
      // 显式处理 model 为空的情况，转为 undefined 以便 service 层触发默认逻辑
      const model = (body.model && String(body.model).trim()) ? body.model : undefined;
      log.info('Generate storyboard request', { episode_id: req.params.episode_id, storyboard_count: body.storyboard_count, video_duration: body.video_duration });
      if (body.structured) {
        const structured = require('../services/structuredStoryboardService');
        return response.success(res, structured.startStructuredStoryboardGeneration(db, log, req.params.episode_id, {
          model,
          videoModel: body.video_model || undefined,
          clipRange: body.clip_duration_range,
          storyboardCount: body.storyboard_count,
          videoDuration: body.video_duration,
        }));
      }
      const resData = await dramaService.generateStoryboard(db, log, req.params.episode_id, {
        model: model,
        style: body.style,
        storyboard_count: body.storyboard_count,
        clip_duration_range: body.clip_duration_range,
        video_duration: body.video_duration,
        aspect_ratio: body.aspect_ratio,
        include_narration: body.include_narration,
        universal_omni_storyboard: body.universal_omni_storyboard,
      });
      response.success(res, resData);
    } catch (err) {
      log.error('Generate storyboard failed', { error: err.message });
      if (err.status === 400) return response.badRequest(res, err.message);
      if (err.status === 404) return response.notFound(res, err.message);
      if (err.status === 409) return response.error(res, 409, 'storyboard_locked', err.message);
      response.internalError(res, err.message || '生成分镜失败');
    }
  };
}

/** 本集旧分镜原地转为结构化分镜（后台任务）；受保护的镜头不动 */
function convertStructured(db, log) {
  return (req, res) => {
    const body = req.body || {};
    try {
      const model = (body.model && String(body.model).trim()) ? body.model : undefined;
      const structured = require('../services/structuredStoryboardService');
      response.success(res, structured.startStructuredConversion(db, log, req.params.episode_id, {
        model,
        videoModel: body.video_model || undefined,
        clipRange: body.clip_duration_range,
      }));
    } catch (err) {
      log.error('Convert storyboards to structured failed', { error: err.message });
      if (err.status === 404) return response.notFound(res, err.message);
      if (err.status === 409) return response.error(res, 409, 'storyboard_locked', err.message);
      if (err.status === 400) return response.badRequest(res, err.message);
      response.internalError(res, err.message || '转换失败');
    }
  };
}

/** 按本集剧本提议场景状态与造型；只返回提议，不写库 */
function proposeAssetStates(db, log) {
  return async (req, res) => {
    try {
      const body = req.body || {};
      const out = await require('../services/assetStateProposalService').proposeForEpisode(db, log, req.params.episode_id, { model: body.model || undefined });
      response.success(res, out);
    } catch (err) {
      log.error('Propose asset states failed', { error: err.message });
      if (err.code === 'not_found') return response.notFound(res, err.message);
      if (err.code === 'script_empty') return response.badRequest(res, err.message);
      if (err.code === 'proposal_invalid') return response.error(res, 422, 'proposal_invalid', err.message);
      response.internalError(res, err.message || '状态提议失败');
    }
  };
}

module.exports = function dramaRoutes(db, cfg, log) {
  return {
    createDrama: createDrama(db, log),
    getDrama: getDrama(db, cfg),
    listDramas: listDramas(db, log),
    updateDrama: updateDrama(db, log),
    deleteDrama: deleteDrama(db, log),
    getDramaStats: getDramaStats(db, log),
    saveOutline: saveOutline(db, log),
    saveProjectVideoSettings: videoSettingsHandler(videoSettings.saveProject, 'id', '剧本不存在', db, log),
    saveEpisodeVideoSettings: videoSettingsHandler(videoSettings.saveEpisode, 'episode_id', '分集不存在', db, log),
    getCharacters: getCharacters(db),
    saveCharacters: saveCharacters(db, log),
    saveEpisodes: saveEpisodes(db, log),
    saveProgress: saveProgress(db, log),
    saveCanvasLayout: saveCanvasLayout(db, log),
    listProps: listProps(db),
    finalizeEpisode: finalizeEpisode(db, log, cfg),
    downloadEpisodeVideo: downloadEpisodeVideo(db),
    generateStoryboard: generateStoryboard(db, log),
    convertStructured: convertStructured(db, log),
    proposeAssetStates: proposeAssetStates(db, log),
    exportDrama: exportDrama(db, cfg, log),
    importDrama: importDrama(db, cfg, log),
    listExamples: listExamples(log),
    importExample: importExample(db, cfg, log),
  };
};
