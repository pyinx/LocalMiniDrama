const response = require('../response');
const { createDiagnostics } = require('../services/mediaDiagnostics');

module.exports = function registerDiagnostics(router, db, cfg) {
  const diagnostics = createDiagnostics(db, cfg);
  const handle = check => async (req, res) => {
    try {
      const result = await check(req.params);
      res.set('Cache-Control', 'no-store');
      response.success(res, result);
    } catch (err) {
      response.error(res, err.status || 500, 'MEDIA_DIAGNOSTIC', err.message);
    }
  };
  router.get('/storyboards/:id/takes/:take/framing', handle(p => diagnostics.take(p.id, p.take)));
  router.get('/video-merges/:id/loudness', handle(p => diagnostics.merge(p.id)));
};
