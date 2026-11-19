/**
 * 不原生出人声的视频模型：按 IR 台词逐句配音，按镜头时间摆放后混成一条与成片等长的台词轨。
 * 原生人声段不配音（只参与字幕摆放），避免模型人声与 TTS 叠在一起。
 */
const fs = require('fs');
const path = require('path');
const { planDialogueLines, estimatedLineSeconds } = require('./episodeSubtitles');
const { ffprobeDurationSec, runFfmpeg } = require('./mergedEpisodePostProcess');

function atempoChain(t) {
  return Math.abs(t - 1) < 1e-3 ? 'anull' : `atempo=${t.toFixed(4)}`;
}

/**
 * @param {{
 *   timeline: object[],
 *   synthesize: (req: { text: string, voice: string|null }) => Promise<string>,  返回音频绝对路径
 *   voiceOf: (line, seg) => string|null,
 *   totalDuration: number,
 *   tmpDir: string,
 *   log: object,
 * }} opts
 * @returns {Promise<{ audioPath: string|null, placements: object[], warnings: object[] }>}
 */
async function buildDialogueTrack({ timeline, synthesize, voiceOf, totalDuration, tmpDir, log }) {
  const synthDur = new Map();
  const synthPath = new Map();
  for (const seg of timeline) {
    if (seg.native) continue;
    for (const { shot } of seg.shots) {
      for (const line of shot.lines) {
        const p = await synthesize({ text: line.text, voice: voiceOf(line, seg) });
        const d = ffprobeDurationSec(p);
        if (!d) throw new Error(`台词配音时长读取失败：「${line.text}」`);
        synthPath.set(line, p);
        synthDur.set(line, d);
      }
    }
  }
  const { placements, warnings } = planDialogueLines(timeline, (line, seg) => (seg.native ? estimatedLineSeconds(line) : synthDur.get(line)));
  const dubbed = placements.filter((p) => !p.native);
  if (!dubbed.length) return { audioPath: null, placements, warnings };

  const args = ['-y'];
  dubbed.forEach((p) => args.push('-i', synthPath.get(p.line)));
  const chains = dubbed.map((p, i) => {
    const ms = Math.round(p.start_s * 1000);
    return `[${i}:a]aresample=44100,aformat=channel_layouts=stereo,${atempoChain(p.tempo)},atrim=start=${p.offset_s}:duration=${p.duration_s},asetpts=PTS-STARTPTS,adelay=${ms}|${ms}[d${i}]`;
  });
  const mix = `${dubbed.map((_, i) => `[d${i}]`).join('')}amix=inputs=${dubbed.length}:normalize=0:dropout_transition=0,apad,atrim=0:${totalDuration.toFixed(3)}[out]`;
  const out = path.join(tmpDir, 'dialogue_track.wav');
  args.push('-filter_complex', [...chains, mix].join(';'), '-map', '[out]', out);
  if (!runFfmpeg(args, log, 'dialogue_track') || !fs.existsSync(out)) throw new Error('台词轨混音失败');
  log.info('dialogue track built', { lines: dubbed.length, warnings: warnings.length });
  return { audioPath: out, placements, warnings };
}

module.exports = { buildDialogueTrack };
