const response = require('../response');
const service = require('../services/workbenchTakeService');

module.exports = function registerTakes(router, db, cfg) {
  function handler(fn) {
    return (req, res) => {
      try { response.success(res, fn(req) ?? {}); }
      catch (err) { response.error(res, err.status || 500, 'VIDEO_TAKE_ERROR', err.message); }
    };
  }
  router.get('/dramas/:id/export-takes', handler(req => require('../services/workbenchTakeArchive').choices(db, req.params.id, cfg?.storage?.local_path || './data/storage')));
  const base = '/storyboards/:id/takes';
  router.get(base, handler(req => service.details(db, req.params.id)));
  router.put(base + '/adoption', handler(req => service.adopt(db, cfg, req.params.id, req.body)));
  router.put(base + '/:take/retention', handler(req =>
    service.keep(db, req.params.id, req.params.take, req.body.keep_in_archive)));
  router.post(base + '/:take/reviews', handler(req => {
    service.take(db, req.params.id, req.params.take);
    service.addReview(db, req.params.take, req.body);
  }));
  router.put(base + '/:take/reviews/:review', handler(req =>
    service.reviewStatus(db, req.params.id, req.params.take, req.params.review, req.body.status)));
};
