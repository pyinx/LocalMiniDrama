const response = require('../response');
const videoService = require('../services/videoService');
const taskService = require('../services/taskService');
const batch = require('../services/workbenchVideoBatch');
const { normalizeAspectRatioForApi, resolveVideoTarget } = require('../services/videoClient');
const jimengRenderer = require('../services/jimeng/renderer');

const segmentCompileService = require('../services/segmentCompileService');

const JIMENG_CONFLICT = new Set(['confirmation_required', 'confirmation_consumed', 'confirmation_stale', 'generation_in_progress']);

/**
 * 结构化分镜：在插入生成记录之前同步编译并检查。阻断时直接返回错误响应（不建任务、不插行）。
 * @returns {null | { compiled, findings, target }} 旧分镜返回 null（沿用前端传来的提示词）
 */
function compileForRequest(db, res, storyboardId, model) {
  if (storyboardId == null) return null;
  const r = segmentCompileService.compileStoryboard(db, storyboardId, { model: model || undefined });
  if (!r.ok) {
    if (r.code === 'legacy_storyboard' || r.code === 'not_found') return null;
    response.error(res, 422, r.code, r.message, { errors: r.errors });
    return false;
  }
  if (r.blocked) {
    response.error(res, 422, 'segment_compile_blocked', '结构化分镜未通过编译检查，未提交视频生成', { findings: r.findings });
    return false;
  }
  return r;
}

function routes(db, log, cfg) {
  const storageRoot = cfg?.storage?.local_path || './data/storage';
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
    create: async (req, res) => {
      let isJimeng = false;
      try {
        const body = req.body || {};
        const now = new Date().toISOString();
        const dramaId = Number(body.drama_id) || 0;
        const storyboardId = body.storyboard_id != null ? Number(body.storyboard_id) : null;
        const compiledIr = compileForRequest(db, res, storyboardId, body.model);
        if (compiledIr === false) return;
        const operation = body.operation_key ?? null;
        if (operation !== null && (typeof operation !== 'string' || !/^[a-zA-Z0-9_-]{1,100}$/.test(operation))) {
          return response.badRequest(res, '视频操作标识无效');
        }
        isJimeng = compiledIr?.target.protocol === jimengRenderer.PROTOCOL;
        if (isJimeng) {
          const st = await jimengRenderer.status(db);
          if (!st.available) return response.error(res, 503, 'jimeng_unavailable', st.message, { reason: st.reason });
        }
        if (!compiledIr && resolveVideoTarget(db, body.model || undefined).protocol === jimengRenderer.PROTOCOL) {
          return response.error(res, 422, 'jimeng_requires_structured', '即梦渲染只支持结构化分镜，请先用「结构化分镜」重新生成本集分镜');
        }
        const provider = body.provider || 'chatfire';
        let prompt = body.prompt || '';
        const row = storyboardId && dramaId ? db.prepare('SELECT style,metadata FROM dramas WHERE id=?').get(dramaId) : null;
        const { zh, en, legacy } = require('../utils/dramaStyleMerge').styleFieldsFromDramaRow(row);
        const catalog = require('../constants/generationStylePresets');
        const catalogStyle = catalog.presetFamily(legacy) ? catalog.resolveStylePreset(legacy)?.zh : '';
        const style = (body.style || zh || en || catalogStyle || '').toString().trim();
        const styleNegative = row?.style === 'custom' ? require('../utils/dramaStyleMerge').parseDramaMetadata(row)?.custom_style?.negative || null : null;
        if (!compiledIr && style) {
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
        let duration = body.duration ?? null;
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
        let imageUrl = body.image_url ?? null;
        // 首尾帧：支持 URL 或本地路径（sxy，存到 first_frame_url / last_frame_url）
        let firstFrameUrl = body.first_frame_url ?? body.first_frame_local_path ?? null;
        let lastFrameUrl = body.last_frame_url ?? body.last_frame_local_path ?? null;
        // 多图模式：sxy，存 JSON 数组到 reference_image_urls
        let refImagesJson =
          body.reference_image_urls && Array.isArray(body.reference_image_urls)
            ? JSON.stringify(body.reference_image_urls.slice(0, 10))
            : null;
        let compiledJson = null;
        if (compiledIr) {
          const c = compiledIr.compiled;
          prompt = c.prompt;
          duration = c.duration_s;
          imageUrl = null;
          firstFrameUrl = c.request.first_frame_url || null;
          lastFrameUrl = c.request.last_frame_url || null;
          refImagesJson = c.refs.length ? JSON.stringify(c.refs.map((r) => r.url)) : null;
          compiledJson = JSON.stringify({
            family: c.family,
            refs: c.refs,
            request: c.request,
            findings: compiledIr.findings,
            protocol: compiledIr.target.protocol,
            model: compiledIr.target.model,
          });
        }
        const result = db.transaction(() => {
          if (operation) {
            const planned = db.prepare(`SELECT b.*, e.drama_id FROM video_batch_items b
              JOIN episodes e ON e.id=b.episode_id WHERE b.operation_key=?`).get(operation);
            if (planned && (planned.storyboard_id !== storyboardId || planned.drama_id !== dramaId)) return { conflict: true };
            const existing = planned ? batch.resolveBatchVideo(db, planned, storageRoot)
              : db.prepare('SELECT * FROM video_generations WHERE operation_key=?').get(operation);
            if (existing) {
              if (existing.deleted_at || existing.drama_id !== dramaId || existing.storyboard_id !== storyboardId) return { conflict: true };
              if (!planned && isJimeng) {
                const quote = db.prepare('SELECT items FROM jimeng_confirmations WHERE token=?').get(String(body.jimeng_confirmation || ''));
                const node = quote && JSON.parse(quote.items).find(item => item.storyboard_id === storyboardId);
                if (!node || existing.provider !== jimengRenderer.PROTOCOL || existing.provider_task_id !== node.key || existing.model !== compiledIr.target.model) return { conflict: true };
              } else if (!planned) {
                const inputs = { prompt, style_negative: styleNegative, provider, model, duration, aspect_ratio: aspectRatio, resolution, seed,
                  camera_fixed: cameraFixed, watermark, image_url: imageUrl, first_frame_url: firstFrameUrl,
                  last_frame_url: lastFrameUrl, reference_image_urls: refImagesJson, compiled_json: compiledJson };
                if (Object.entries(inputs).some(([key, value]) => existing[key] !== value)) return { conflict: true };
              }
              return { id: existing.id, reused: true, legacy: existing.id == null ? existing : null };
            }
          }
          if (isJimeng) {
            const id = jimengRenderer.prepareSubmit(db, log, storyboardId, body.jimeng_confirmation, { model: body.model || undefined });
            if (operation) db.prepare('UPDATE video_generations SET operation_key=? WHERE id=?').run(operation, id);
            return { id };
          }
          const task = taskService.createTask(db, log, 'video_generation', String(dramaId));
          const inserted = db.prepare(
            `INSERT INTO video_generations (drama_id, storyboard_id, provider, prompt, style_negative, model, duration, aspect_ratio, resolution, seed, camera_fixed, watermark, image_url, first_frame_url, last_frame_url, reference_image_urls, compiled_json, status, task_id, created_at, updated_at, operation_key, dispatch_state)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'processing', ?, ?, ?, ?, 'queued')`
          ).run(dramaId, storyboardId, provider, prompt, styleNegative, model, duration, aspectRatio, resolution, seed, cameraFixed, watermark, imageUrl, firstFrameUrl, lastFrameUrl, refImagesJson, compiledJson, task.id, now, now, operation);
          return { id: inserted.lastInsertRowid };
        }).immediate();
        if (result.conflict) return response.error(res, 409, 'VIDEO_OPERATION_CONFLICT', '原提交内容已变化或记录已删除，请核查后重新发起');
        if (!result.reused) setImmediate(() => {
          if (isJimeng) return jimengRenderer.runSubmitted(db, log, result.id).catch(err => log.error('jimeng runSubmitted', { id: result.id, error: err.message }));
          videoService.processVideoGeneration(db, log, result.id);
        });
        const item = result.legacy || videoService.getById(db, result.id);
        if (result.reused) return response.success(res, item);
        response.created(res, item);
      } catch (err) {
        if (isJimeng && JIMENG_CONFLICT.has(err.code)) return response.error(res, 409, err.code, err.message, err.video_generation_id ? { video_generation_id: err.video_generation_id } : undefined);
        if (isJimeng && err.code === 'segment_compile_blocked') return response.error(res, 422, err.code, err.message, { findings: err.findings });
        if (isJimeng && err.code && !err.code.startsWith('SQLITE_')) return response.error(res, 422, err.code, err.message);
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
        response.success(res, batch.openBatch(db, Number(req.params.episode_id), ids, storageRoot));
      } catch (err) {
        log.error('videos episode batch', { error: err.message });
        response.badRequest(res, err.message);
      }
    },
  };
}

module.exports = routes;
