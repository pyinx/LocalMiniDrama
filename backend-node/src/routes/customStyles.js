const express = require('express');
const multer = require('multer');
const response = require('../response');
const library = require('../services/customStyleLibrary');
const imageClient = require('../services/imageClient');

module.exports = function customStyles(db, log) {
  const router = express.Router();
  const upload = multer({ limits: { fileSize: 16 * 1024 * 1024, files: 1 } }).single('file');
  const handle = fn => async (req, res) => {
    try {
      response.success(res, await fn(req));
    } catch (error) {
      response.error(res, error.status || 500, 'style_library', error.message);
    }
  };
  router.get('/', handle(() => library.list(db)));
  router.get('/capabilities', handle(req => {
    const configs = require('../services/aiConfigService');
    const models = type => [...new Set(configs.listConfigs(db, type).filter(c => c.is_active)
      .flatMap(c => Array.isArray(c.model) ? c.model : [c.model]).filter(m => typeof m === 'string' && m))];
    return { ...imageClient.styleImageCapabilities(db, req.query.model), image_models: models('image'), vision_models: models('text') };
  }));
  router.get('/preflight', handle(req => {
    const { kind, model, id } = req.query;
    const resources = { character: 'characters', scene: 'scenes', prop: 'props' };
    let dramaId = Number(id);
    if (Object.hasOwn(resources, kind)) {
      dramaId = db.prepare('SELECT drama_id FROM ' + resources[kind] + ' WHERE id=?').get(dramaId)?.drama_id;
    } else if (!['image','frame','video'].includes(kind)) throw library.inputError('未知生成操作');
    const project = imageClient.readProjectStyle(db, dramaId);
    const snapshot = project?.style === 'custom' && project.metadata.custom_style;
    if (!snapshot?.negative) return { warn: false };
    const provider = kind === 'prop'
      ? require('../services/propImageGenerationService').preferredImageProvider(model, require('../config').loadConfig())
      : undefined;
    const capabilities = kind === 'video' ? require('../services/videoClient').styleVideoCapabilities(db, model)
      : imageClient.styleImageCapabilities(db, model, provider, kind === 'frame' ? 'storyboard_image' : 'image');
    return { warn: !!capabilities.model && !capabilities.negative, model: capabilities.model, negative: snapshot.negative,
      style: snapshot.name, version: snapshot.version, project: dramaId };
  }));
  router.post('/', handle(req => library.save(db, req.body)));
  router.post('/analyze', handle(req => library.analyze(db, log, req.body.image, req.body.model)));
  router.post('/generate', handle(req => library.generate(db, log, req.body)));
  router.post('/images', (req, res, next) => upload(req, res, error => error
    ? response.badRequest(res, '请选择小于 16 MB 的单张图片') : next()), handle(async req => ({
    image: library.storeImage(db, await library.prepareImage(req.file?.buffer)),
  })));
  router.get('/images/:hash', (req, res) => {
    try {
      const bytes = library.imageBytes(db, req.params.hash);
      res.set('Cache-Control', 'private, max-age=31536000, immutable').type(library.imageMime(bytes)).send(bytes);
    } catch (error) {
      response.error(res, error.status || 500, 'style_image', error.message);
    }
  });
  return router;
};
