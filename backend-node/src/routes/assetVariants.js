const response = require('../response');
const assetVariantService = require('../services/assetVariantService');

/** 变体通用路由：kind = wardrobe | scene_state | prop_state */
function routes(db, log) {
  function fail(res, err, where) {
    if (err.code === 'variant_invalid') return response.error(res, 422, 'variant_invalid', err.message);
    if (err.code === 'base_image_missing') return response.error(res, 409, 'base_image_missing', err.message);
    if (err.code === 'not_found') return response.notFound(res, err.message);
    log.error(where, { error: err.message });
    return response.internalError(res, err.message);
  }
  return (kind) => ({
    list: (req, res) => {
      try {
        const items = assetVariantService.list(db, kind, req.params.id);
        if (!items) return response.notFound(res, '资产不存在');
        response.success(res, items);
      } catch (err) { fail(res, err, `${kind} list`); }
    },
    create: (req, res) => {
      try {
        const item = assetVariantService.create(db, kind, req.params.id, req.body || {});
        if (!item) return response.notFound(res, '资产不存在');
        response.created(res, item);
      } catch (err) { fail(res, err, `${kind} create`); }
    },
    update: (req, res) => {
      try {
        const item = assetVariantService.update(db, kind, req.params.id, req.body || {});
        if (!item) return response.notFound(res, '变体不存在');
        response.success(res, item);
      } catch (err) { fail(res, err, `${kind} update`); }
    },
    remove: (req, res) => {
      try {
        if (!assetVariantService.remove(db, kind, req.params.id)) return response.notFound(res, '变体不存在');
        response.success(res, { message: '删除成功' });
      } catch (err) { fail(res, err, `${kind} delete`); }
    },
    generateImage: (req, res) => {
      try {
        const r = assetVariantService.generateImage(db, log, kind, req.params.id, { model: (req.body || {}).model });
        response.success(res, r.image_generation);
      } catch (err) { fail(res, err, `${kind} generate`); }
    },
  });
}

module.exports = routes;
