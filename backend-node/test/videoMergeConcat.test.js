const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const videoMergeService = require('../src/services/videoMergeService');

const warnings = [];
const log = { info() {}, warn: (...a) => warnings.push(a), error() {}, debug() {} };

describe('buildConcatArgs', () => {
  it('uses stream copy by default (fast, lossless)', () => {
    const args = videoMergeService.buildConcatArgs('/tmp/list.txt', '/tmp/out.mp4');
    assert.deepEqual(args, ['-f', 'concat', '-safe', '0', '-i', '/tmp/list.txt', '-c', 'copy', '-y', '/tmp/out.mp4']);
  });

  it('uses re-encode args when transcode is requested (mixed-parameter clips fallback)', () => {
    const args = videoMergeService.buildConcatArgs('/tmp/list.txt', '/tmp/out.mp4', true);
    assert.equal(args.includes('-c:v'), true);
    assert.equal(args[args.indexOf('-c:v') + 1], 'libx264');
    assert.equal(args[args.indexOf('-pix_fmt') + 1], 'yuv420p');
    assert.equal(args[args.indexOf('-c:a') + 1], 'aac');
    assert.equal(args.includes('-movflags'), true);
    assert.equal(args.includes('-c'), false);
    assert.equal(args[args.length - 1], '/tmp/out.mp4');
  });
});

describe('runFfmpegConcat', () => {
  it('returns false when clips cannot be concatenated (no ffmpeg / missing inputs)', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'video-merge-concat-'));
    const outputPath = path.join(dir, 'merged.mp4');
    const missing = [path.join(dir, 'a.mp4'), path.join(dir, 'b.mp4')];

    const ok = videoMergeService.runFfmpegConcat(missing, outputPath, log);

    assert.equal(ok, false);
    assert.equal(fs.existsSync(outputPath), false);
    // concat list 文件必须被清理，不残留临时文件
    assert.deepEqual(
      fs.readdirSync(dir).filter((f) => f.startsWith('concat_list_')),
      []
    );
  });
});

const { createIrTestDb, sampleIr } = require('./helpers/segmentIrFixtures');
const { ffmpegSkip, makeClip, tmpStorage } = require('./helpers/mediaFixtures');
const config = require('../src/config');
const taskService = require('../src/services/taskService');
const structuredPost = require('../src/services/structuredEpisodePost');
const legacyPost = require('../src/services/mergedEpisodePostProcess');

function setupMerge(t) {
  const root = tmpStorage();
  const { db, ids } = createIrTestDb();
  t.after(() => { db.close(); fs.rmSync(root, { recursive: true, force: true }); });
  t.mock.method(config, 'loadConfig', () => ({ storage: { local_path: root } }));
  t.mock.method(global, 'fetch', () => { throw new Error('unexpected network access'); });
  async function merge(scenes, merge_options) {
    const item = videoMergeService.create(db, log, { drama_id: ids.dramaId, episode_id: ids.episodeId, scenes, merge_options });
    await videoMergeService.processVideoMerge(db, log, item.merge_id, '');
    return videoMergeService.getById(db, item.merge_id);
  }
  return { root, db, ids, merge };
}

describe('整集合并使用完整素材时间线', () => {
  it('中间片段解析失败时合并和任务失败，不发布部分成片', { skip: ffmpegSkip }, async (t) => {
    const { root, db, ids, merge } = setupMerge(t);
    const clip = makeClip(path.join(root, 'a.mp4'), 1, null);
    const item = await merge([clip, 'missing.mp4', clip].map(video_url => ({ video_url, duration: 9 })));
    assert.equal(item.status, 'failed');
    assert.equal(global.fetch.mock.callCount(), 0);
    assert.match(item.error_msg, /2/);
    assert.equal(taskService.getTask(db, item.task_id).status, 'failed');
    assert.equal(db.prepare('SELECT video_url FROM episodes WHERE id=?').get(ids.episodeId).video_url, null);
    assert.equal(item.merged_url, null);
    assert.equal(fs.existsSync(path.join(root, 'projects')), false);
  });

  for (const kind of ['legacy', 'structured']) {
    it(`${kind} 后期与成片共用拼接顺序和实测时长`, { skip: ffmpegSkip }, async (t) => {
      const { root, db, ids, merge } = setupMerge(t);
      if (kind === 'structured') db.prepare('UPDATE storyboards SET segment_ir=? WHERE id=?').run(JSON.stringify(sampleIr(ids)), ids.sbIr);
      const post = kind === 'structured' ? t.mock.method(structuredPost, 'runStructuredEpisodePost', () => ({ ok: true }))
        : t.mock.method(legacyPost, 'runMergedEpisodePostProcess', () => ({ ok: true }));
      const scenes = [ids.sbLegacy, ids.sbIr].map((scene_id, i) => ({ scene_id, duration: 9, video_url: makeClip(path.join(root, `${i}.mp4`), i+1, null) }));
      const item = await merge(scenes, { watermark_text: 'test' });
      assert.equal(item.status, 'completed');
      assert.equal(post.mock.callCount(), 1);
      const { scenes: actual, mergedAbsPath } = post.mock.calls[0].arguments[2];
      assert.deepEqual(actual.map(s => s.scene_id), scenes.map(s => s.scene_id));
      assert.deepEqual(actual.map(s => s.duration), scenes.map(s => legacyPost.ffprobeDurationSec(s.video_url)));
      assert.ok(Math.abs(legacyPost.ffprobeDurationSec(mergedAbsPath) - 3) < 0.1);
      assert.equal(item.duration, 3);
      assert.equal(JSON.parse(taskService.getTask(db, item.task_id).result).duration, 3);
    });
  }
});
