const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const storyboardRoutes = require('../src/routes/storyboards');
const storyboardService = require('../src/services/storyboardService');
const aiClient = require('../src/services/aiClient');
const { createIrTestDb, sampleIr, mockRes, noopLog } = require('./helpers/segmentIrFixtures');

const generated = '分镜1：5秒：会议室内，人事推来协议，林远低头看向桌面。';
for (const [route, stream] of [
  ['generateUniversalSegmentPrompt', false],
  ['generateUniversalSegmentStream', true],
  ['polishUniversalSegmentStream', true],
]) {
  describe(route, () => {
    for (const outcome of ['IR takes ownership', 'storyboard is deleted', 'legacy storyboard remains']) {
      it(outcome, async (t) => {
        const { db, ids } = createIrTestDb();
        t.after(() => db.close());
        const routes = storyboardRoutes(db, noopLog);
        const id = ids.sbIr;
        const req = { params: { id }, body: { force_without_reference_images: true, draft_universal_segment_text: '当前草稿' } };
        const res = mockRes();
        const events = [];
        res.write = (line) => events.push(JSON.parse(line));
        let resume;
        const pending = new Promise((resolve) => { resume = resolve; });
        const provider = t.mock.method(aiClient, stream ? 'streamGenerateText' : 'generateText', (...args) => {
          if (stream) args.at(-1)(generated);
          return pending;
        });
        const request = routes[route](req, res);
        assert.equal(provider.mock.callCount(), 1);
        if (outcome === 'IR takes ownership') storyboardService.saveSegmentIr(db, noopLog, id, sampleIr(ids));
        if (outcome === 'storyboard is deleted') db.prepare('UPDATE storyboards SET deleted_at = ? WHERE id = ?').run(new Date().toISOString(), id);
        const readRow = () => db.prepare('SELECT * FROM storyboards WHERE id = ?').get(id);
        const before = readRow();
        resume(generated);
        await request;
        if (outcome === 'legacy storyboard remains') {
          const text = stream ? events.at(-1).universal_segment_text : res.body.data.universal_segment_text;
          assert.match(text, /人事推来协议/);
          assert.equal(readRow().universal_segment_text, text);
          if (stream) assert.deepEqual(events.map((e) => e.type), ['delta', 'done']);
        } else {
          const owned = outcome === 'IR takes ownership';
          if (stream) {
            assert.deepEqual(events.map((e) => e.type), ['delta', 'error']);
            assert.equal(events[1].code, owned ? 'segment_ir_owned' : 'NOT_FOUND');
            assert.ok(res.headersSent);
          } else {
            assert.equal(res.statusCode, owned ? 409 : 404);
            assert.equal(res.body.error.code, owned ? 'segment_ir_owned' : 'NOT_FOUND');
          }
          assert.deepEqual(readRow(), before);
        }
      });
    }
  });
}
