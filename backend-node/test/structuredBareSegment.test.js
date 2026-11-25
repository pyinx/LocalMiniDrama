const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const aiClient = require('../src/services/aiClient');
const { runStructuredStoryboardGeneration } = require('../src/services/structuredStoryboardService');
const { createIrTestDb, sampleIr, noopLog } = require('./helpers/segmentIrFixtures');

let db, ids, savedGen;
beforeEach(() => {
  ({ db, ids } = createIrTestDb());
  savedGen = aiClient.generateText;
  db.prepare('UPDATE episodes SET script_content = ? WHERE id = ?').run('林远：是因为绩效吗？', ids.episodeId);
});
afterEach(() => {
  aiClient.generateText = savedGen;
});

function liveCount() {
  return db.prepare('SELECT COUNT(*) AS n FROM storyboards WHERE episode_id = ? AND deleted_at IS NULL AND segment_ir IS NOT NULL').get(ids.episodeId).n;
}

// 模型只规划出一段时，有的模型会直接返回这一段的对象，而不是只含一个元素的数组
describe('model returns a single segment object instead of an array', () => {
  it('treats the bare segment as the only segment, same as the one-element array', async () => {
    const seg = sampleIr(ids);
    assert.ok(seg.cast.length > 0, 'fixture must carry a non-empty cast, the array that used to be mistaken for the segments');
    aiClient.generateText = async () => JSON.stringify([seg]);
    const expected = (await runStructuredStoryboardGeneration(db, noopLog, ids.episodeId, {})).storyboard_ids.length;
    assert.ok(expected >= 1);

    aiClient.generateText = async () => JSON.stringify(seg, null, 2);
    const result = await runStructuredStoryboardGeneration(db, noopLog, ids.episodeId, {});
    assert.equal(result.storyboard_ids.length, expected);
    assert.equal(liveCount(), expected);
  });

  it('reports the real problem of an invalid bare segment, not its inner arrays', async () => {
    const seg = sampleIr(ids);
    delete seg.shots;
    aiClient.generateText = async () => JSON.stringify(seg);
    await assert.rejects(
      runStructuredStoryboardGeneration(db, noopLog, ids.episodeId, {}),
      (err) => /第 1 段 shots/.test(err.message) && !/version：|duration_s：|scene：/.test(err.message),
    );
    assert.equal(liveCount(), 0, 'nothing saved');
  });

  it('still accepts segments wrapped in an object', async () => {
    aiClient.generateText = async () => JSON.stringify([sampleIr(ids)]);
    const expected = (await runStructuredStoryboardGeneration(db, noopLog, ids.episodeId, {})).storyboard_ids.length;
    aiClient.generateText = async () => JSON.stringify({ segments: [sampleIr(ids)] });
    const result = await runStructuredStoryboardGeneration(db, noopLog, ids.episodeId, {});
    assert.equal(result.storyboard_ids.length, expected);
  });
});
