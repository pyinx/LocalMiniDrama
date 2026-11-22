const response = require('../response');
const { createHash } = require('node:crypto');
const videoService = require('../services/videoService');
const taskService = require('../services/taskService');
const batch = require('../services/workbenchVideoBatch');
const { normalizeAspectRatioForApi, resolveVideoTarget, videoTargetHash, prepareWanKeyframeInput } = require('../services/videoClient');
const { WAN_LEGACY_KEYFRAME_MODEL, promptChars } = require('../services/modelCapabilities');
const { prepareWanVideo, localImagePath } = require('../services/wanVideoRequest');
const { beatSignature, universalDraftWithoutActionNote } = require('../services/universalOmniMultiBeatFormat');
const { storageRoot: resolveStorageRoot, filesBaseUrl } = require('../utils/storagePaths');
const jimengRenderer = require('../services/jimeng/renderer');

const segmentCompileService = require('../services/segmentCompileService');

const JIMENG_CONFLICT = new Set(['confirmation_required', 'confirmation_consumed', 'confirmation_stale', 'generation_in_progress']);
const operationConflict = res => response.error(res, 409, 'VIDEO_OPERATION_CONFLICT', '原提交内容已变化或记录已删除，请核查后重新发起');

function resolveOperation(db, key, dramaId, storyboardId, storageRoot) {
  if (!key) return {};
  const planned = db.prepare(`SELECT b.*, e.drama_id FROM video_batch_items b
    JOIN episodes e ON e.id=b.episode_id WHERE b.operation_key=?`).get(key);
  if (planned && (planned.storyboard_id !== storyboardId || planned.drama_id !== dramaId)) return { conflict: true };
  const existing = planned ? batch.resolveBatchVideo(db, planned, storageRoot)
    : db.prepare('SELECT * FROM video_generations WHERE operation_key=?').get(key);
  if (existing && (existing.deleted_at || existing.drama_id !== dramaId || existing.storyboard_id !== storyboardId)) return { conflict: true };
  return { planned, existing };
}

/**
 * 结构化分镜：在插入生成记录之前同步编译并检查。阻断时直接返回错误响应（不建任务、不插行）。
 * @returns {null | { compiled, findings, target }} 旧分镜返回 null（沿用前端传来的提示词）
 */
function compileForRequest(db, res, storyboardId, target) {
  if (storyboardId == null) return null;
  const r = segmentCompileService.compileStoryboard(db, storyboardId, { target });
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
        const operation = body.operation_key ?? null;
        if (operation !== null && (typeof operation !== 'string' || !/^[a-zA-Z0-9_-]{1,100}$/.test(operation))) {
          return response.badRequest(res, '视频操作标识无效');
        }
        const requestHash = operation && createHash('sha256')
          .update(JSON.stringify(Object.entries(body).sort(([a], [b]) => a.localeCompare(b)))).digest('hex');
        const prior = operation ? db.transaction(() => resolveOperation(db, operation, dramaId, storyboardId, storageRoot)).immediate() : {};
        if (prior.conflict) return operationConflict(res);
        if (prior.existing && (prior.planned || prior.existing.video_request_hash)) {
          if (!prior.planned && prior.existing.video_request_hash !== requestHash) return operationConflict(res);
          return response.success(res, prior.existing.id == null ? prior.existing : videoService.getById(db, prior.existing.id));
        }
        const target = resolveVideoTarget(db, body.model || undefined);
        const compiledIr = compileForRequest(db, res, storyboardId, target);
        if (compiledIr === false) return;
        isJimeng = compiledIr?.target.protocol === jimengRenderer.PROTOCOL;
        if (isJimeng) {
          const st = await jimengRenderer.status(db);
          if (!st.available) return response.error(res, 503, 'jimeng_unavailable', st.message, { reason: st.reason });
        }
        if (!compiledIr && target.protocol === jimengRenderer.PROTOCOL) {
          return response.error(res, 422, 'jimeng_requires_structured', '即梦渲染只支持结构化分镜，请先用「结构化分镜」重新生成本集分镜');
        }
        const provider = target.config?.provider || body.provider || 'chatfire';
        const board = storyboardId && db.prepare('SELECT s.duration,s.dialogue,s.narration,s.action,s.result,s.universal_segment_text,s.universal_beat_signature,s.creation_mode,s.adopted_sound FROM storyboards s JOIN episodes e ON e.id=s.episode_id WHERE s.id=? AND e.drama_id=? AND s.deleted_at IS NULL AND e.deleted_at IS NULL').get(storyboardId, dramaId);
        let prompt = body.prompt || '';
        if (!compiledIr && (board?.creation_mode === 'universal' || (board && body.reference_mode === 'omni'))) {
          prompt = universalDraftWithoutActionNote(prompt || board.universal_segment_text || '');
          if (board.universal_beat_signature && board.universal_beat_signature !== beatSignature(prompt, board.action, board.result)) {
            return response.error(res, 409, 'storyboard_draft_changed', '提交正文、动作或结果与已保存的分拍版本不同，请核对当前稿后重新润色或保存修订');
          }
          if (!board.universal_beat_signature && [board.action, board.result].some(s => s?.trim() && !prompt.includes(s.trim()))) {
            return response.error(res, 409, 'storyboard_review_needed', '请先查看本镜的「片段描述」，确认动作和最后的画面符合预期。可以直接修改描述。要使用现有描述，请点「全能提示词」→「采用当前分拍」，再生成视频。',
              { action: board.action, result: board.result, draft: prompt });
          }
        }
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
        const model = target.model || body.model || null;
        let duration = body.duration ?? null;
        if (board?.duration > 0) duration = board.duration;
        // 画幅：请求体归一化（全角冒号等）后写入 DB；未传则从 drama.metadata 读取并同样归一化
        let aspectRatio = null;
        const wanCaps = target.protocol === 'dashscope' && target.caps?.wanMode ? target.caps : null;
        const allowedRatios = wanCaps ? new Set(wanCaps.ratios) : undefined;
        const explicitAspect = body.aspect_ratio != null && String(body.aspect_ratio).trim() !== '';
        if (explicitAspect) {
          aspectRatio = normalizeAspectRatioForApi(body.aspect_ratio, allowedRatios);
        }
        const invalidAspect = explicitAspect && !aspectRatio;
        if (!aspectRatio && dramaId) {
          try {
            const dramaRow = db.prepare('SELECT metadata FROM dramas WHERE id = ? AND deleted_at IS NULL').get(dramaId);
            if (dramaRow && dramaRow.metadata) {
              const meta = typeof dramaRow.metadata === 'string' ? JSON.parse(dramaRow.metadata) : dramaRow.metadata;
              if (meta && meta.aspect_ratio) aspectRatio = normalizeAspectRatioForApi(meta.aspect_ratio, allowedRatios);
            }
          } catch (_) {}
        }
        let resolution = body.resolution ?? null;
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
            ? JSON.stringify(wanCaps ? body.reference_image_urls : body.reference_image_urls.slice(0, 10))
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
        let incompatibility;
        if (!prior.existing && wanCaps) {
          let refs = refImagesJson ? JSON.parse(refImagesJson) : [];
          const mode = compiledIr ? undefined : body.reference_mode || (board?.creation_mode === 'universal' ? 'omni' : undefined);
          const identity = value => {
            if (typeof value !== 'string' || /^(data:|oss:)/i.test(value)) return value;
            try { return localImagePath(value, filesBaseUrl(cfg), resolveStorageRoot(cfg)) || value; } catch { return value; }
          };
          // 经典分镜旧客户端会把首尾帧同时填入参考图列表；只消除这类重复表达。
          if (storyboardId && !compiledIr && mode !== 'omni' && (firstFrameUrl || imageUrl) && refs.length) {
            const frames = [firstFrameUrl || imageUrl, lastFrameUrl].filter(Boolean).map(identity);
            if (refs.every(url => frames.includes(identity(url)))) {
              if (wanCaps.wanMode === 'reference' && !lastFrameUrl && (wanCaps.wan26 || wanCaps.vace)) firstFrameUrl = imageUrl = null;
              else if (wanCaps.wanMode !== 'reference') refs = [];
            }
          }
          const audio = body.generate_audio ?? compiledIr?.compiled.request.generate_audio;
          const extend = compiledIr?.compiled.request.prompt_extend ?? body.prompt_extend;
          let roles;
          if (wanCaps.vace) {
            if (compiledIr) roles = compiledIr.compiled.refs.map(ref => ref.kind === 'scene' ? 'bg' : 'obj');
            else if (body.reference_roles) roles = body.reference_roles;
            else if (storyboardId) {
              const scene = db.prepare('SELECT c.local_path,c.image_url FROM scenes c JOIN storyboards s ON s.scene_id=c.id WHERE s.id=?').get(storyboardId);
              const background = scene && [scene.local_path, scene.image_url].filter(Boolean).map(identity);
              roles = refs.map(url => background?.includes(identity(url)) ? 'bg' : 'obj');
            }
          }
          const plan = prepareWanVideo(wanCaps, { model, prompt, style_negative: styleNegative, duration, resolution, seed,
            aspect_ratio: aspectRatio, first_frame_url: firstFrameUrl, last_frame_url: lastFrameUrl,
            image_url: imageUrl, reference_urls: refs, reference_roles: roles, reference_mode: mode, generate_audio: audio });
          incompatibility = invalidAspect ? `${model} 不支持画面比例 ${body.aspect_ratio}` : plan.error;
          if (!Array.isArray(body.reference_image_urls) && body.reference_image_urls != null && !compiledIr) incompatibility = '参考图必须是图片地址列表';
          if (!incompatibility) {
            resolution = plan.resolution;
            duration = plan.duration;
            refImagesJson = refs.length ? JSON.stringify(refs) : null;
            if (roles || typeof audio === 'boolean' || typeof extend === 'boolean') {
              const metadata = compiledJson ? JSON.parse(compiledJson) : {};
              compiledJson = JSON.stringify({ ...metadata, request: { ...metadata.request, generate_audio: audio, prompt_extend: extend, reference_roles: roles } });
            }
          }
        }
        if (!prior.existing && target.protocol === 'dashscope' && target.model === WAN_LEGACY_KEYFRAME_MODEL) {
          const prepared = await prepareWanKeyframeInput(target.caps, {
            duration, resolution, aspect_ratio: aspectRatio, first_frame_url: firstFrameUrl, image_url: imageUrl,
            last_frame_url: lastFrameUrl, reference_urls: refImagesJson && JSON.parse(refImagesJson),
            reference_mode: !compiledIr && board?.creation_mode === 'universal' ? 'omni' : body.reference_mode,
            files_base_url: filesBaseUrl(cfg), storage_local_path: resolveStorageRoot(cfg),
          });
          const hasLines = compiledIr
            ? compiledIr.ir.shots.some(shot => shot.lines.length > 0)
            : Boolean(board?.dialogue?.trim() || board?.narration?.trim());
          let sound;
          try { sound = require('../services/episodeSound').soundOf(board || {}); } catch (_) {}
          const soundChosen = sound?.source === 'mute' || (sound?.source === 'dub' &&
            require('../services/workbenchTakeService').localFile(storageRoot, sound.path));
          incompatibility = (invalidAspect && '无法识别所选视频画幅，请重新选择') || prepared.error ||
            (hasLines && !soundChosen && '当前万相模型只生成无声视频。本镜包含台词或旁白，请换用支持人声的模型，或在剪辑工作台选定配音或静音');
          resolution = prepared.resolution;
          duration = target.caps.duration.min;
        }
        if (!compiledIr && !prior.existing && !target.caps.unknownFields.includes('maxPromptChars') && promptChars(prompt) > target.caps.maxPromptChars) {
          incompatibility ||= `本段完整提示词超过模型上限 ${target.caps.maxPromptChars} 字，请精简或拆段`;
        }
        const result = db.transaction(() => {
          if (operation) {
            const { conflict, planned, existing } = resolveOperation(db, operation, dramaId, storyboardId, storageRoot);
            if (conflict) return { conflict };
            if (existing) {
              if (!planned && existing.video_request_hash) {
                if (existing.video_request_hash !== requestHash) return { conflict: true };
              } else if (!planned && isJimeng) {
                const quote = db.prepare('SELECT items FROM jimeng_confirmations WHERE token=?').get(String(body.jimeng_confirmation || ''));
                const node = quote && JSON.parse(quote.items).find(item => item.storyboard_id === storyboardId);
                if (!node || existing.provider !== jimengRenderer.PROTOCOL || existing.provider_task_id !== node.key || existing.model !== compiledIr.target.model) return { conflict: true };
              } else if (!planned) {
                const inputs = { prompt, style_negative: styleNegative, duration, aspect_ratio: aspectRatio, resolution, seed,
                  camera_fixed: cameraFixed, watermark, image_url: imageUrl, first_frame_url: firstFrameUrl,
                  last_frame_url: lastFrameUrl, reference_image_urls: refImagesJson, compiled_json: compiledJson,
                  model: body.model ?? null, provider: body.provider || 'chatfire' };
                if (Object.entries(inputs).some(([key, value]) => existing[key] !== value)) return { conflict: true };
              }
              return { id: existing.id, reused: true, legacy: existing.id == null ? existing : null };
            }
          }
          if (incompatibility) return { incompatibility };
          if (isJimeng) {
            const id = jimengRenderer.prepareSubmit(db, log, storyboardId, body.jimeng_confirmation, { model: body.model || undefined });
            if (operation) db.prepare('UPDATE video_generations SET operation_key=? WHERE id=?').run(operation, id);
            return { id };
          }
          const task = taskService.createTask(db, log, 'video_generation', String(dramaId));
          const inserted = db.prepare(
            `INSERT INTO video_generations (drama_id, storyboard_id, provider, prompt, style_negative, model, duration, aspect_ratio, resolution, seed, camera_fixed, watermark, image_url, first_frame_url, last_frame_url, reference_image_urls, compiled_json, video_config_id, video_protocol, video_target_hash, video_request_hash, status, task_id, created_at, updated_at, operation_key, dispatch_state)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'processing', ?, ?, ?, ?, 'queued')`
          ).run(dramaId, storyboardId, provider, prompt, styleNegative, model, duration, aspectRatio, resolution, seed, cameraFixed, watermark, imageUrl, firstFrameUrl, lastFrameUrl, refImagesJson, compiledJson, target.config?.id ?? null, target.protocol, target.config ? videoTargetHash(target.config) : null, requestHash, task.id, now, now, operation);
          return { id: inserted.lastInsertRowid };
        }).immediate();
        if (result.conflict) return operationConflict(res);
        if (result.incompatibility) return response.error(res, 422, 'video_model_incompatible', result.incompatibility);
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
