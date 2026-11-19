const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('node:child_process');
const { getFfprobePath } = require('../src/utils/ffmpegPath');
const { buildTimeline, planDialogueLines, estimatedLineSeconds, buildDialogueSrt, buildCardsSrt } = require('../src/services/episodeSubtitles');
const { runStructuredEpisodePost } = require('../src/services/structuredEpisodePost');
const storyboardService = require('../src/services/storyboardService');
const { parseSegmentIr } = require('../src/services/segmentIr/schema');
const { createIrTestDb, sampleIr, noopLog } = require('./helpers/segmentIrFixtures');
const { ffmpegSkip, makeClip, makeTone, concat, meanVolume, tmpStorage } = require('./helpers/mediaFixtures');

const IDS = { sceneId: 3, linId: 1, hrId: 2 };

function parseSrt(srt) {
  return srt.trim().split(/\n\n/).map((block) => {
    const [, time, ...text] = block.split('\n');
    const [a, b] = time.split(' --> ').map((t) => { const [h, m, rest] = t.split(':'); const [s, ms] = rest.split(','); return +h * 3600 + +m * 60 + +s + ms / 1000; });
    return { start: a, end: b, text: text.join('\n') };
  });
}

/** 准备一集：第 1 段为 IR（8 秒内容实拍 2 秒，测缩放），第 2 段为旧分镜 */
function setupEpisode(storage, tailSeconds = 2) {
  const { db, ids } = createIrTestDb();
  storyboardService.saveSegmentIr(db, noopLog, ids.sbIr, sampleIr(ids, { cards: [{ text: '人事部', at_s: 0, hold_s: 1 }] }));
  const clipA = makeClip(path.join(storage, 'a.mp4'), 2, null);
  const clipB = makeClip(path.join(storage, 'b.mp4'), tailSeconds, -6);
  const merged = concat([clipA, clipB], path.join(storage, 'merged.mp4'));
  const scenes = [{ scene_id: ids.sbIr, duration: 2 }, { scene_id: ids.sbLegacy, duration: tailSeconds }];
  const cfg = { storage: { local_path: storage, base_url: 'http://localhost:5679/static' } };
  return { db, ids, merged, scenes, cfg };
}

describe('structured episode compose (AC13)', () => {
  it('srt from segments', () => {
    const ir = parseSegmentIr(sampleIr(IDS, { cards: [{ text: '十年后', at_s: 1, hold_s: 1 }] })).ir;
    ir.shots[1].lines.push({ kind: 'dialogue', speaker: '林远', text: '我在这家公司干了整整十年，从来没有请过一天假', delivery: '', voice: null });
    const tl = buildTimeline([
      { storyboard_id: 1, ir: null, clip_s: 5, native: true },
      { storyboard_id: 2, ir, clip_s: 8, native: true },
    ]);
    assert.equal(tl[1].start_s, 5);
    assert.equal(tl[1].shots[1].start_s, 8, 'shot start = segment start + preceding shot seconds');
    const { placements } = planDialogueLines(tl, (line) => estimatedLineSeconds(line));
    const cues = parseSrt(buildDialogueSrt(placements));
    for (const c of cues) {
      const plain = c.text.replace(/<\/?i>/g, '');
      assert.ok((plain.match(/[\p{L}\p{N}]/gu) || []).length <= 12, `≤12 字：${plain}`);
      assert.ok(c.end > c.start);
    }
    assert.ok(cues.some((c) => c.text === '<i>果然轮到我了</i>'), 'os line italic');
    assert.ok(cues.some((c) => c.text === '签个字吧'), 'dialogue not italic, trailing punctuation removed');
    const first = cues.find((c) => c.text === '签个字吧');
    assert.ok(first.start >= 5 && first.end <= 8, 'line stays inside its shot window');
    const cards = parseSrt(buildCardsSrt(tl));
    assert.deepEqual(cards.map((c) => [c.text, c.start]), [['十年后', 6]]);
    assert.ok(cards[0].end - cards[0].start >= 2, 'cards hold at least 2s');
  });

  it('bgm under dialogue', { skip: ffmpegSkip }, async () => {
    const storage = tmpStorage();
    const { db, merged, scenes, cfg } = setupEpisode(storage);
    const bgm = makeTone(path.join(storage, 'bgm.wav'), 3, 220, -3);
    const r = await runStructuredEpisodePost(db, noopLog, {
      mergedAbsPath: merged, storageRoot: storage, scenes, episodeId: 1, cfg,
      mergeOpts: { bgm: { url: bgm, volume_db: -18 } }, filters: new Set(),
    });
    assert.equal(r.ok, true, r.error);
    const out = path.join(storage, r.relativePath);
    const clipLevel = meanVolume(path.join(storage, 'b.mp4'), 0.3, 1.4);
    const bgmSource = meanVolume(bgm, 0.3, 1.4);
    const bgmOnly = meanVolume(out, 0.3, 1.4);
    const withLine = meanVolume(out, 2.3, 1.4);
    assert.ok(Math.abs(withLine - clipLevel) < 1.5, `original clip audio kept (${withLine} vs source ${clipLevel} dB)`);
    assert.ok(Math.abs(bgmOnly - (bgmSource - 18)) < 2, `BGM lowered by 18 dB (${bgmOnly} vs source ${bgmSource} dB)`);
    assert.ok(bgmOnly <= withLine - 10, `BGM (${bgmOnly} dB) sits well under the dialogue section (${withLine} dB)`);
    const tail = meanVolume(out, 3.3, 0.6);
    assert.ok(tail > -60, 'BGM loops past its own 3s length');
  });

  for (const withBgm of [false, true]) {
    it(withBgm ? 'soft subtitle fallback with looping BGM' : 'soft subtitle fallback', { skip: ffmpegSkip }, async (t) => {
      const storage = tmpStorage();
      t.after(() => fs.rmSync(storage, { recursive: true, force: true }));
      const bgm = withBgm ? { url: makeTone(path.join(storage, 'bgm.wav'), 0.5) } : null;
      const { db, merged, scenes, cfg } = setupEpisode(storage);
      const r = await runStructuredEpisodePost(db, noopLog, {
        mergedAbsPath: merged, storageRoot: storage, scenes, episodeId: 1, cfg,
        mergeOpts: { dialogue_subtitles: true, cards: true, bgm }, filters: new Set(['amix']),
      });
      assert.equal(r.ok, true, r.error);
      assert.equal(r.info.subtitles.method, 'mov_text');
      assert.equal(r.info.subtitles.burned, false);
      assert.match(r.info.subtitles.reason, /subtitles 滤镜/);
      const { streams: s } = JSON.parse(execFileSync(getFfprobePath(), ['-v', 'error', '-show_entries',
        'stream=codec_type,duration', '-of', 'json', path.join(storage, r.relativePath)], { encoding: 'utf8' }));
      assert.equal(s.filter((x) => x.codec_type === 'subtitle').length, 2, 'dialogue + cards as soft subtitle tracks');
      for (const type of ['video', 'audio']) {
        const duration = Number(s.find((x) => x.codec_type === type)?.duration);
        assert.ok(Math.abs(duration - 4) <= 0.05, `${type} lasts ${duration}s, expected 4s`);
      }
      const cards = parseSrt(fs.readFileSync(path.join(storage, 'merged.cards.srt'), 'utf8'));
      assert.deepEqual(cards.map(({ start, end }) => [start, end]), [[0, 2]]);
      assert.ok(fs.existsSync(path.join(storage, 'merged.srt')));
    });
  }

  it('12 秒成片仅带开头 2 秒字卡时保留结尾画面', { skip: ffmpegSkip }, async (t) => {
    const storage = tmpStorage();
    t.after(() => fs.rmSync(storage, { recursive: true, force: true }));
    const { db, merged, scenes } = setupEpisode(storage, 10);
    t.after(() => db.close());
    const result = await runStructuredEpisodePost(db, noopLog, {
      mergedAbsPath: merged, storageRoot: storage, scenes, mergeOpts: { cards: true }, filters: new Set(),
    });
    assert.equal(result.ok, true, result.error);
    const duration = execFileSync(getFfprobePath(), ['-v', 'error', '-select_streams', 'v:0', '-show_entries',
      'stream=duration', '-of', 'csv=p=0', path.join(storage, result.relativePath)], { encoding: 'utf8' });
    assert.ok(Math.abs(Number(duration) - 12) < 0.05, `视频轨实际时长 ${duration}`);
    const cards = parseSrt(fs.readFileSync(path.join(storage, 'merged.cards.srt'), 'utf8'));
    assert.deepEqual(cards.map(({ start, end }) => [start, end]), [[0, 2]]);
  });

  it('seams and frames sheets', { skip: ffmpegSkip }, async () => {
    const storage = tmpStorage();
    const { db, merged, scenes, cfg } = setupEpisode(storage);
    const r = await runStructuredEpisodePost(db, noopLog, {
      mergedAbsPath: merged, storageRoot: storage, scenes, episodeId: 1, cfg,
      mergeOpts: { review_sheets: true }, filters: new Set(),
    });
    assert.equal(r.ok, true, r.error);
    for (const key of ['seams', 'frames']) {
      const p = path.join(storage, r.info.sheets[key]);
      assert.ok(fs.existsSync(p), key);
      assert.equal(fs.readFileSync(p).subarray(1, 4).toString(), 'PNG');
    }
  });
});
