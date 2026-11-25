const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { promptChars, canDisableAudio } = require('./modelCapabilities');
const { toLocalPath } = require('../utils/storagePaths');

const SIZES_1080 = { '16:9': '1920*1080', '9:16': '1080*1920', '1:1': '1440*1440', '4:3': '1632*1248', '3:4': '1248*1632' };
const MIME = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.bmp': 'image/bmp',
  '.tif': 'image/tiff', '.tiff': 'image/tiff' };

function dashScopeBaseUrl(value) {
  return String(value || '').trim().replace(/\/+$/, '').replace(/\/(?:api|compatible-mode)\/v1$/, '');
}

function localImagePath(value, baseUrl, storagePath) {
  const cfg = { storage: { base_url: baseUrl, local_path: storagePath } };
  const url = /^https?:\/\//i.test(value) ? new URL(value) : null;
  const loopback = url && /^(localhost|127\.0\.0\.1|\[::1\])$/i.test(url.hostname);
  if (loopback && !url.pathname.startsWith('/static/')) throw new Error('本地图片 URL 必须指向项目素材目录');
  return toLocalPath(cfg, loopback ? url.pathname : value);
}

// 图片和角色引用的顺序也是提示词中的编号顺序。首尾帧是独立的素材角色。
function prepareWanVideo(caps, opts) {
  const mode = caps.wanMode;
  const omni = mode === 'omni';
  const fail = reason => ({ error: `${opts.model} ${reason}` });
  // 已接入的 2.6 旧配置沿用原先的 720P 提交档位，避免升级后增加其费用。
  const previousTier = caps.wan26 && (mode !== 'reference' || opts.aspect_ratio) ? '720P' : caps.defaultResolution;
  const resolution = String(opts.resolution ?? previousTier).trim().toUpperCase();
  if (!caps.resolutions.includes(resolution)) return fail('支持的分辨率为 ' + caps.resolutions.join('、'));
  const duration = Number(opts.duration ?? 5);
  if (!(omni && duration === -1) && (!Number.isInteger(duration) || duration < caps.duration.min || duration > caps.duration.max)) {
    return fail(`支持 ${caps.duration.min}–${caps.duration.max} 秒的整数时长`);
  }
  const ratio = opts.aspect_ratio;
  if (ratio && !caps.ratios.includes(ratio)) return fail('不支持画面比例 ' + ratio);
  const first = opts.first_frame_url || opts.image_url;
  const last = opts.last_frame_url;
  const refs = opts.reference_urls ?? [];
  if (!Array.isArray(refs) || refs.some(url => typeof url !== 'string' || !url.trim())) return fail('参考图必须是有效图片地址列表');
  if ([first, last].some(url => url != null && typeof url !== 'string')) return fail('帧图片地址无效');
  if (opts.reference_mode === 'text' && (first || last || refs.length)) return fail('纯文本模式不能同时指定图片');
  if (opts.reference_mode === 'omni' && (!caps.refImages || !refs.length)) return fail('全能模式需要支持多图参考的模型和参考图');
  if (refs.length > caps.refImages) return fail(`支持最多 ${caps.refImages} 张参考图，当前选择了 ${refs.length} 张`);
  if (last && !first) return fail('提供尾帧时必须同时提供首帧');
  if (last && !caps.firstLastFrame) return fail('不支持指定尾帧');
  if (mode === 'text' && first) return fail('仅支持文生视频，请改用图生视频模型');
  if (mode === 'image' && !first) return fail('图生视频需要首帧');
  if (mode === 'reference' && !refs.length) return fail('参考生视频至少需要一张参考图');
  if (first && refs.length && (omni || caps.wan26 || caps.vace)) return fail('不能同时指定首尾帧和多图参考');
  let prompt = String(opts.prompt || '').replace(/@图片(\d+)/g, (_, n) => caps.refToken + n);
  if (!prompt.trim() && (mode === 'text' || mode === 'reference' || (omni && !first && !refs.length))) return fail('需要提示词');
  const negative = String(opts.style_negative || '').trim();
  if (negative && caps.styleNegativeMode === 'prompt') {
    prompt = [prompt, '负向清单（避免出现）：' + negative].filter(Boolean).join('\n\n');
  }
  if (promptChars(prompt) > caps.maxPromptChars) return fail(`提示词超过 ${caps.maxPromptChars} 字`);
  const input = prompt ? { prompt } : {};
  if (negative && caps.styleNegativeMode === 'field') input.negative_prompt = negative;
  const parameters = { duration };
  if (caps.vace) {
    const roles = opts.reference_roles ?? refs.map(() => 'obj');
    if (!Array.isArray(roles) || roles.length !== refs.length || roles.some(role => !['obj', 'bg'].includes(role))
      || roles.filter(role => role === 'bg').length > 1) return fail('参考图需要逐张标明主体或背景，背景最多一张');
    input.function = 'image_reference';
    parameters.obj_or_bg = roles;
  }
  if (caps.sizes) parameters.size = (resolution === '1080P' ? SIZES_1080 : caps.sizes)[ratio || '16:9'];
  else {
    parameters.resolution = resolution;
    if (ratio && (omni || !first)) parameters.ratio = ratio;
  }
  if (!(caps.wan26 && mode === 'reference') && typeof opts.prompt_extend === 'boolean') parameters.prompt_extend = opts.prompt_extend;
  if (['wan2.6-t2v', 'wan2.6-i2v-flash'].includes(opts.model) && opts.prompt_extend !== false) parameters.shot_type = 'multi';
  if (opts.generate_audio === false && !canDisableAudio(caps)) return fail('不支持通过参数关闭音轨');
  if (opts.generate_audio === true && !caps.nativeAudio) return fail('不支持生成音频');
  if (caps.audioSwitch && typeof opts.generate_audio === 'boolean') parameters.audio = opts.generate_audio;
  if (opts.watermark != null) parameters.watermark = Boolean(opts.watermark);
  if (opts.seed != null) {
    const seed = Number(opts.seed);
    if (!Number.isInteger(seed) || seed < (omni ? -1 : 0) || seed > 2147483647) return fail('随机种子超出范围');
    parameters.seed = seed;
  }
  const media = [];
  if (first) media.push({ type: 'first_frame', url: first });
  if (last) media.push({ type: 'last_frame', url: last });
  for (const url of refs) media.push({ type: 'reference_image', url });
  return { input, parameters, media, resolution, duration };
}

async function uploadPolicy(config, model) {
  const url = new URL(dashScopeBaseUrl(config.base_url) + '/api/v1/uploads');
  url.search = new URLSearchParams({ action: 'getPolicy', model });
  const result = await fetch(url, { headers: { Authorization: 'Bearer ' + config.api_key } });
  if (!result.ok) throw new Error('获取百炼临时上传凭证失败（HTTP ' + result.status + '）');
  const { data } = await result.json();
  if (!data?.upload_host || !data.upload_dir || !data.signature || !data.policy || !data.oss_access_key_id) throw new Error('百炼返回的临时上传凭证不完整');
  return data;
}

async function uploadImage(policy, bytes, mime) {
  const filename = randomUUID() + '.' + mime.split('/')[1];
  const key = policy.upload_dir + '/' + filename;
  const form = new FormData();
  for (const [field, value] of Object.entries({
    OSSAccessKeyId: policy.oss_access_key_id, Signature: policy.signature, policy: policy.policy,
    'x-oss-object-acl': policy.x_oss_object_acl, 'x-oss-forbid-overwrite': policy.x_oss_forbid_overwrite,
    key, success_action_status: '200',
  })) form.set(field, value);
  form.set('file', new Blob([bytes], { type: mime }), filename);
  const res = await fetch(policy.upload_host, { method: 'POST', body: form });
  if (!res.ok) throw new Error('上传参考图到百炼临时存储失败（HTTP ' + res.status + '）');
  return 'oss://' + key;
}

async function buildWanVideoBody(config, caps, opts) {
  const plan = prepareWanVideo(caps, opts);
  if (plan.error) return plan;
  const { input, parameters, media } = plan;
  const requiresUpload = caps.vace || (caps.wan26 && caps.wanMode === 'reference');
  const maxBytes = (caps.vace ? 10 : 20) * 1024 * 1024;
  let policy;
  try {
    for (const item of media) {
      if (item.url.startsWith('oss://')) continue;
      const inline = /^data:(image\/(?:png|jpeg|webp|bmp|tiff));base64,([A-Za-z0-9+/]+=*)$/i.exec(item.url);
      if (!inline && /^(?!https?:)[a-z][a-z0-9+.-]*:/i.test(item.url)) throw new Error('参考图片格式或 URL 协议无效');
      const file = inline ? null : localImagePath(item.url, opts.files_base_url, opts.storage_local_path);
      if (!file && !inline) continue; // 已有公网 URL
      const mime = inline ? inline[1] : MIME[path.extname(file).toLowerCase()];
      if (!mime || (mime === 'image/tiff' && !caps.vace)) throw new Error('参考图格式不受此型号支持');
      const size = inline ? Buffer.byteLength(inline[2], 'base64') : (await fs.stat(file)).size;
      if (size > maxBytes) throw new Error(`单张参考图片不能超过 ${maxBytes / 1024 / 1024} MB`);
      if (inline && !requiresUpload) continue;
      const bytes = inline ? Buffer.from(inline[2], 'base64') : await fs.readFile(file);
      if (requiresUpload) {
        policy ??= await uploadPolicy(config, opts.model);
        item.url = await uploadImage(policy, bytes, mime);
      } else item.url = `data:${mime};base64,${bytes.toString('base64')}`;
    }
  } catch (err) {
    return { error: '万相参考图准备失败：' + (err.code === 'ENOENT' ? '找不到项目图片' : err.message) };
  }
  if (requiresUpload) input[caps.vace ? 'ref_images_url' : 'reference_urls'] = media.map(item => item.url);
  else if (caps.wan26 && caps.wanMode === 'image') input.img_url = media[0].url;
  else if (media.length) input.media = media;
  return { body: { model: opts.model, input, parameters }, usesOss: media.some(item => item.url.startsWith('oss://')) };
}

module.exports = { prepareWanVideo, buildWanVideoBody, localImagePath, dashScopeBaseUrl };
