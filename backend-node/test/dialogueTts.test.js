const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { buildTimeline, planDialogueLines, MAX_TEMPO } = require('../src/services/episodeSubtitles');
const { buildDialogueTrack } = require('../src/services/dialogueTtsService');
const { parseSegmentIr } = require('../src/services/segmentIr/schema');
const { choosePostProcessor } = require('../src/services/videoMergeService');
const { ffprobeDurationSec } = require('../src/services/mergedEpisodePostProcess');
const storyboardService = require('../src/services/storyboardService');
const { createIrTestDb, sampleIr, noopLog } = require('./helpers/segmentIrFixtures');
const { ffmpegSkip, makeTone, tmpStorage } = require('./helpers/mediaFixtures');

const IR = parseSegmentIr(sampleIr({ sceneId: 3, linId: 1, hrId: 2 })).ir; // 镜头 3 秒 + 5 秒；台词 1 句 + 2 句

describe('per-line dialogue TTS (AC27)', () => {
  it('line timing from ir', () => {
    const tl = buildTimeline([
      { storyboard_id: 1, ir: null, clip_s: 4, native: false },
      { storyboard_id: 2, ir: IR, clip_s: 8, native: false },
    ]);
    const { placements, warnings } = planDialogueLines(tl, () => 1);
    assert.deepEqual(warnings, []);
    assert.deepEqual(placements.map((p) => +p.start_s.toFixed(3)), [4, 7, 8.3], 'segment start + shot start, then previous line + 0.3s');
    assert.ok(placements.every((p) => p.tempo === 1));
  });

  it('overlong line tempo capped', () => {
    const tl = buildTimeline([{ storyboard_id: 2, ir: IR, clip_s: 8, native: false }]);
    const lens = new Map([[IR.shots[0].lines[0], 3.3], [IR.shots[1].lines[0], 1], [IR.shots[1].lines[1], 9]]);
    const { placements, warnings } = planDialogueLines(tl, (l) => lens.get(l));
    const first = placements[0];
    assert.ok(first.tempo > 1 && first.tempo <= MAX_TEMPO, `slightly long line sped up (${first.tempo})`);
    assert.ok(Math.abs(first.duration_s - 3) < 1e-9);
    const last = placements[2];
    assert.equal(last.tempo, MAX_TEMPO, 'never faster than 1.25x');
    assert.equal(warnings.length, 1);
    assert.equal(warnings[0].code, 'line_overflows_shot');
  });

  it('native audio model skips tts', { skip: ffmpegSkip }, async () => {
    const tmp = tmpStorage();
    let calls = 0;
    const synth = async ({ text }) => { calls++; return makeTone(path.join(tmp, `l${calls}.wav`), Math.min(1.5, text.length / 4), 330, -6); };
    const native = await buildDialogueTrack({
      timeline: buildTimeline([{ storyboard_id: 1, ir: IR, clip_s: 8, native: true }]),
      synthesize: synth, voiceOf: () => null, totalDuration: 8, tmpDir: tmp, log: noopLog,
    });
    assert.equal(calls, 0, 'no TTS for a native-audio segment');
    assert.equal(native.audioPath, null);
    assert.equal(native.placements.length, 3, 'still placed for subtitles');

    const dubbed = await buildDialogueTrack({
      timeline: buildTimeline([{ storyboard_id: 1, ir: IR, clip_s: 8, native: true }, { storyboard_id: 2, ir: IR, clip_s: 8, native: false }]),
      synthesize: synth, voiceOf: (line) => (line.speaker === '林远' ? 'voice-lin' : null), totalDuration: 16, tmpDir: tmp, log: noopLog,
    });
    assert.equal(calls, 3, 'only the dubbed segment is synthesized');
    assert.ok(fs.existsSync(dubbed.audioPath));
    assert.ok(Math.abs(ffprobeDurationSec(dubbed.audioPath) - 16) < 0.2, 'track spans the whole episode');
  });

  it('ir episode does not double mix dialogue', () => {
    const { db, ids } = createIrTestDb();
    const scenes = [{ scene_id: ids.sbIr, duration: 8 }, { scene_id: ids.sbLegacy, duration: 5 }];
    assert.equal(choosePostProcessor(db, scenes, { burn_dialogue_audio: true }), 'legacy', 'no IR yet: old pipeline');
    storyboardService.saveSegmentIr(db, noopLog, ids.sbIr, sampleIr(ids));
    assert.equal(choosePostProcessor(db, scenes, { burn_dialogue_audio: true }), 'structured', 'IR episode: per-line track replaces burn_dialogue_audio');
    assert.equal(choosePostProcessor(db, scenes, {}), null, 'no options: unchanged behaviour');
    const src = fs.readFileSync(path.join(__dirname, '../src/services/structuredEpisodePost.js'), 'utf8');
    assert.ok(!src.includes('audio_local_path'), 'structured post never mixes the pre-generated per-storyboard dialogue audio');
  });
});
