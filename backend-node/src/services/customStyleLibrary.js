'use strict';

const { createHash } = require('node:crypto');
const sharp = require('sharp');
const aiClient = require('./aiClient');
const imageClient = require('./imageClient');

const digestOf = bytes => createHash('sha256').update(bytes).digest('hex');
const isDigest = value => typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);
const fields = ['name', 'positive', 'negative', 'image'];
const maxBytes = 16 * 1024 * 1024;

function inputError(message, status = 400) {
  return Object.assign(new Error(message), { status });
}

function field(value, label, max, required = true) {
  if (value == null && !required) return '';
  if (typeof value !== 'string' || value.length > max || (required && !value.trim())) {
    throw inputError(label + '无效，最多 ' + max + ' 字');
  }
  return value.trim();
}

function imageBytes(db, hash) {
  const bytes = isDigest(hash) && db.prepare('SELECT content FROM style_example_images WHERE digest=?').get(hash)?.content;
  if (!bytes) throw inputError('画风示例图缺失，请重新选择图片', 404);
  return bytes;
}

function imageMime(bytes) {
  if (bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) return 'image/png';
  if (bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return 'image/jpeg';
  if (/^GIF8[79]a$/.test(bytes.toString('ascii', 0, 6))) return 'image/gif';
  if (bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
  throw inputError('示例图文件格式无效');
}

async function prepareImage(bytes) {
  if (!Buffer.isBuffer(bytes) || !bytes.length || bytes.length > maxBytes) throw inputError('示例图需小于 16 MB');
  try {
    const image = sharp(bytes, { limitInputPixels: 40000000, failOn: 'error' });
    const meta = await image.metadata();
    if (!['png', 'jpeg', 'webp', 'gif'].includes(meta.format)) throw Error();
    await image.resize(64, 64, { fit: 'inside', withoutEnlargement: true }).raw().toBuffer();
    return bytes;
  } catch {
    throw inputError('图片无法解码，请选择 JPG、PNG、WebP 或 GIF');
  }
}

function storeImage(db, bytes) {
  const digest = digestOf(bytes);
  db.prepare('INSERT OR IGNORE INTO style_example_images (digest,content) VALUES (?,?)').run(digest, bytes);
  return digest;
}

function list(db) {
  return db.prepare(`SELECT s.* FROM custom_style_versions s JOIN
    (SELECT id, MAX(version) AS version FROM custom_style_versions GROUP BY id) latest
    USING (id, version) ORDER BY name COLLATE NOCASE, id`).all();
}

function save(db, draft) {
  const { id, base_version: base = 0 } = draft;
  if (typeof id !== 'string' || !/^[a-zA-Z0-9-]{16,80}$/.test(id) || !Number.isSafeInteger(base) || base < 0) {
    throw inputError('画风版本无效');
  }
  const next = { name: field(draft.name, '名称', 100), positive: field(draft.positive, '正向提示词', 2000),
    negative: field(draft.negative, '反向提示词', 500, false), image: draft.image };
  return db.transaction(() => {
    imageBytes(db, next.image);
    const last = db.prepare('SELECT * FROM custom_style_versions WHERE id=? ORDER BY version DESC LIMIT 1').get(id);
    if (last && fields.every(k => last[k] === next[k])) return last;
    if ((last?.version || 0) !== base) throw inputError('画风库已有新版本，请重新打开后编辑', 409);
    const version = base + 1;
    db.prepare('INSERT INTO custom_style_versions(id,version,name,positive,negative,image) VALUES(?,?,?,?,?,?)')
      .run(id, version, next.name, next.positive, next.negative, next.image);
    return { id, version, ...next };
  }).immediate();
}

async function analyze(db, log, image, model) {
  const bytes = imageBytes(db, image);
  const answer = await aiClient.generateTextWithVision(db, log, 'text',
    '分析这张示例图可迁移到其他角色和场景的画风，并建议防止画风偏移的反向词。',
    '返回 JSON 对象，positive 为中文正向描述（媒介、线条、材质、色彩、光影和空间），negative 为可编辑的反向建议。两字段均为字符串。仅输出换任何主体、地点、动作都成立的特征。勿写原图中的人、物、场景或其布置。讲光影和构图只写抽象关系，例如层次叠压。无可靠反向建议时用空字符串。',
    { imageUrl: 'data:' + imageMime(bytes) + ';base64,' + bytes.toString('base64') }, { model, max_tokens: 1200 });
  try {
    const result = JSON.parse(answer.trim().replace(/^\x60\x60\x60(?:json)?\s*/i, '').replace(/\s*\x60\x60\x60$/, ''));
    if (typeof result.negative !== 'string') throw Error();
    return { positive: field(result.positive, '正向提示词', 2000), negative: field(result.negative, '反向提示词', 500, false) };
  } catch {
    throw inputError('识图模型未返回可编辑的画风提示词，可重试或手动填写', 422);
  }
}

async function generate(db, log, draft) {
  const positive = field(draft.positive, '正向提示词', 2000);
  const negative = field(draft.negative, '反向提示词', 500, false);
  const caps = imageClient.styleImageCapabilities(db, draft.model);
  if (!caps.model) throw inputError('请在 AI 配置中启用图片模型');
  if (negative && !caps.negative && draft.positive_only !== true) throw inputError('该模型的反向词能力未验证，可选择仅用正向词生成', 409);
  const result = await imageClient.callImageApi(db, log, {
    model: caps.model, preferred_provider: caps.provider, size: '1024x1024',
    prompt: '用以下媒介、材质和绘制方法描绘整个画面：' + positive + '\n画风样张内容：一位短发成年人在车站窗旁端起茶杯，中近景，单一画面。',
    user_negative_prompt: caps.negative ? negative : undefined,
  });
  if (!result.image_url || result.error) throw inputError(result.error || '模型未返回图片', 502);
  let bytes;
  if (result.image_url.startsWith('data:image/')) {
    const match = /^data:image\/[\w.+-]+;base64,([A-Za-z0-9+/=\s]+)$/.exec(result.image_url);
    if (!match || match[1].length > Math.ceil(maxBytes / 3) * 4) throw inputError('生成的图片数据无效', 502);
    bytes = Buffer.from(match[1], 'base64');
  } else {
    const url = new URL(result.image_url);
    if (!['https:', 'http:'].includes(url.protocol)) throw inputError('模型返回的图片地址无效', 502);
    const response = await fetch(url, { signal: AbortSignal.timeout(60000) });
    if (!response.ok || !response.body) throw inputError('示例图下载失败', 502);
    const chunks = [];
    let size = 0;
    for await (const chunk of response.body) {
      size += chunk.length;
      if (size > maxBytes) throw inputError('生成的图片超过 16 MB', 502);
      chunks.push(chunk);
    }
    bytes = Buffer.concat(chunks);
  }
  return { image: storeImage(db, await prepareImage(bytes)) };
}

function pack(db, zip, snapshot) {
  if (snapshot) zip.addFile('media/style/' + snapshot.image, imageBytes(db, snapshot.image));
}

function validateSnapshot(snapshot) {
  if (!snapshot || typeof snapshot.id !== 'string' || !/^[a-zA-Z0-9-]{16,80}$/.test(snapshot.id) ||
      !Number.isSafeInteger(snapshot.version) || snapshot.version < 1 || !isDigest(snapshot.image)) {
    throw inputError('画风快照缺少有效的版本或示例图');
  }
  field(snapshot.name, '名称', 100);
  field(snapshot.negative, '反向提示词', 500, false);
}

function unpack(db, files, snapshot) {
  if (!snapshot) return;
  validateSnapshot(snapshot);
  const hash = snapshot.image;
  const bytes = isDigest(hash) && files.get('media/style/' + hash);
  if (!bytes || bytes.length > maxBytes || digestOf(bytes) !== hash) {
    throw inputError('工程包的画风示例图缺失或损坏');
  }
  imageMime(bytes);
  storeImage(db, bytes);
}

module.exports = { inputError, prepareImage, storeImage, imageBytes, imageMime, validateSnapshot, list, save, analyze, generate, pack, unpack };
