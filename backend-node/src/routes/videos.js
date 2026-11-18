const response = require('../response');
const videoService = require('../services/videoService');
const taskService = require('../services/taskService');
const { normalizeAspectRatioForApi } = require('../services/videoClient');
const batch = require('../services/workbenchVideoBatch');

function routes(db, log) {
  return {
    list: (req, res) => {
      try {
        const query = { ...req.query };
        const { items, total, page, pageSize } = videoService.list(db, query);
        response.successWithPagination(res, items, total, page, pageSize);
      } catch (err) {
        log.error('videos list', { error: err.message });
        response.internalError(res, err.message);
      }
    },
    create: (req, res) => {
      try {
        const body = req.body || {};
        const now = new Date().toISOString();
        const dramaId = Number(body.drama_id) || 0;
        const storyboardId = body.storyboard_id != null ? Number(body.storyboard_id) : null;
        const operation = body.operation_key ?? null;
        if (operation !== null && (typeof operation !== 'string' || !/^[a-zA-Z0-9_-]{1,100}$/.test(operation))) {
          return response.badRequest(res, '视频操作标识无效');
        }
        const provider = body.provider || 'chatfire';
        let prompt = body.prompt || '';
        const style = (body.style || '').toString().trim();
        if (style) {
          const baseLower = String(prompt || '').toLowerCase();
          const styleLower = style.toLowerCase();
          if (!baseLower.includes(styleLower)) {
            prompt = prompt ? `${prompt}. Style: ${style}` : `Style: ${style}`;
          }
        }
        // The optional method only applies to project storyboards. Free creation keeps its own text.
        if (storyboardId) {
          prompt = require('../services/workbenchCreativeMethods').withCreativeGuidance(db, prompt, dramaId, 'video', storyboardId);
        }
        const model = body.model ?? null;
        const duration = body.duration ?? null;
        // 画幅：请求体归一化（全角冒号等）后写入 DB；未传则从 drama.metadata 读取并同样归一化
        let aspectRatio = null;
        if (body.aspect_ratio != null && String(body.aspect_ratio).trim() !== '') {
          aspectRatio = normalizeAspectRatioForApi(body.aspect_ratio);
        }
        if (!aspectRatio && dramaId) {
          try {
            const dramaRow = db.prepare('SELECT metadata FROM dramas WHERE id = ? AND deleted_at IS NULL').get(dramaId);
            if (dramaRow && dramaRow.metadata) {
              const meta = typeof dramaRow.metadata === 'string' ? JSON.parse(dramaRow.metadata) : dramaRow.metadata;
              if (meta && meta.aspect_ratio) aspectRatio = normalizeAspectRatioForApi(meta.aspect_ratio);
            }
          } catch (_) {}
        }
        const resolution = body.resolution ?? null;
        const seed = body.seed != null ? Number(body.seed) : null;
        const cameraFixed = body.camera_fixed != null ? (body.camera_fixed ? 1 : 0) : null;
        const watermark = body.watermark != null ? (body.watermark ? 1 : 0) : 0;
        const imageUrl = body.image_url ?? null;
        // 首尾帧：支持 URL 或本地路径（sxy，存到 first_frame_url / last_frame_url）
        const firstFrameUrl = body.first_frame_url ?? body.first_frame_local_path ?? null;
        const lastFrameUrl = body.last_frame_url ?? body.last_frame_local_path ?? null;
        // 多图模式：sxy，存 JSON 数组到 reference_image_urls
        const refImagesJson =
          body.reference_image_urls && Array.isArray(body.reference_image_urls)
            ? JSON.stringify(body.reference_image_urls.slice(0, 10))
            : null;
        const result = db.transaction(() => {
          if (operation) {
            const planned = db.prepare(`SELECT b.*, e.drama_id FROM video_batch_items b
              JOIN episodes e ON e.id=b.episode_id WHERE b.operation_key=?`).get(operation);
            if (planned && (planned.storyboard_id !== storyboardId || planned.drama_id !== dramaId)) return { conflict: true };
            const existing = planned ? batch.resolveBatchVideo(db, planned)
              : db.prepare('SELECT * FROM video_generations WHERE operation_key=?').get(operation);
            if (existing) {
              if (existing.deleted_at || existing.drama_id !== dramaId || existing.storyboard_id !== storyboardId) return { conflict: true };
              if (!planned) {
                const inputs = { prompt, provider, model, duration, aspect_ratio: aspectRatio, resolution, seed,
                  camera_fixed: cameraFixed, watermark, image_url: imageUrl, first_frame_url: firstFrameUrl,
                  last_frame_url: lastFrameUrl, reference_image_urls: refImagesJson };
                if (Object.entries(inputs).some(([key, value]) => existing[key] !== value)) return { conflict: true };
              }
              return { id: existing.id, reused: true };
            }
          }
          const task = taskService.createTask(db, log, 'video_generation', String(dramaId));
          const inserted = db.prepare(
            `INSERT INTO video_generations (drama_id, storyboard_id, provider, prompt, model, duration, aspect_ratio, resolution, seed, camera_fixed, watermark, image_url, first_frame_url, last_frame_url, reference_image_urls, status, task_id, created_at, updated_at, operation_key, dispatch_state)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'processing', ?, ?, ?, ?, 'queued')`
          ).run(dramaId, storyboardId, provider, prompt, model, duration, aspectRatio, resolution, seed, cameraFixed, watermark, imageUrl, firstFrameUrl, lastFrameUrl, refImagesJson, task.id, now, now, operation);
          return { id: inserted.lastInsertRowid };
        }).immediate();
        if (result.conflict) return response.error(res, 409, 'VIDEO_OPERATION_CONFLICT', '原提交内容已变化或记录已删除，请核查后重新发起');
        if (!result.reused) setImmediate(() => videoService.processVideoGeneration(db, log, result.id));
        const item = videoService.getById(db, result.id);
        if (result.reused) return response.success(res, item);
        response.created(res, item);
      } catch (err) {
        log.error('videos create', { error: err.message });
        response.internalError(res, err.message);
      }
    },
    get: (req, res) => {
      try {
        const item = videoService.getById(db, req.params.id);
        if (!item) return response.notFound(res, '记录不存在');
        response.success(res, item);
      } catch (err) {
        log.error('videos get', { error: err.message });
        response.internalError(res, err.message);
      }
    },
    delete: (req, res) => {
      try {
        const ok = videoService.deleteById(db, log, req.params.id);
        if (!ok) return response.notFound(res, '记录不存在');
        response.success(res, { message: '删除成功' });
      } catch (err) {
        if (err.status === 409) return response.error(res, 409, 'TAKE_IN_USE', err.message);
        log.error('videos delete', { error: err.message });
        response.internalError(res, err.message);
      }
    },
    /** 失败后复用 provider_task_id 继续轮询上游，避免浪费已提交任务 */
    resumePoll: (req, res) => {
      try {
        const result = videoService.resumeFailedVideoPoll(db, log, req.params.id);
        if (!result.ok) {
          if (result.status === 404) return response.notFound(res, result.error);
          return response.badRequest(res, result.error);
        }
        response.success(res, result.item);
      } catch (err) {
        log.error('videos resumePoll', { error: err.message });
        response.internalError(res, err.message);
      }
    },
    fromImage: (req, res) => {
      try {
        const task = taskService.createTask(db, log, 'video_generation', req.params.image_gen_id);
        response.success(res, { task_id: task.id });
      } catch (err) {
        log.error('videos fromImage', { error: err.message });
        response.internalError(res, err.message);
      }
    },
    episodeBatch: (req, res) => {
      try {
        const ids = req.body?.storyboard_ids || [];
        if (!Array.isArray(ids) || ids.some(id => !Number.isSafeInteger(id) || id <= 0)) return response.badRequest(res, '分镜清单无效');
        response.success(res, batch.openBatch(db, Number(req.params.episode_id), ids));
      } catch (err) {
        log.error('videos episode batch', { error: err.message });
        response.badRequest(res, err.message);
      }
    },
  };
}

module.exports = routes;
