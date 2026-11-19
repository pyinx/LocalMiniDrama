/**
 * 整集检查（警告）：开场钩子、相邻段主运镜、同场景环境声、尾帧依赖轮数。
 * 判定只用 IR 字段（shots[].event、main_move、continuity.tail_ref_from）与剧集连续性表。
 */
const OPENING_SECONDS = 3;
const MAX_TAIL_ROUNDS = 2;

/**
 * @param {{ storyboard_id: number, ir: object }[]} segments 本集按顺序的 IR 段
 * @param {{ continuity?: Record<string, { ambience?: string }> }} [opts] 剧集连续性表（按 scene_id）
 */
function lintEpisode(segments, opts = {}) {
  const findings = [];
  const where = (i) => ({ segment: i, storyboard_id: segments[i].storyboard_id });
  if (segments.length) {
    let t = 0;
    let eventAt = null;
    for (const s of segments[0].ir.shots) {
      if (s.event) { eventAt = t; break; }
      t += s.seconds;
    }
    if (eventAt === null || eventAt >= OPENING_SECONDS) {
      findings.push({ level: 'warn', code: 'weak_opening', where: where(0), msg: `开场 ${OPENING_SECONDS} 秒内没有叙事事件，观众容易划走` });
    }
  }
  for (let i = 1; i < segments.length; i++) {
    const a = segments[i - 1].ir.main_move;
    if (a && a === segments[i].ir.main_move) {
      findings.push({ level: 'warn', code: 'repeated_main_move', where: where(i), msg: `与上一段主运镜相同（${a}），连着看会单调` });
    }
  }
  const table = opts.continuity || {};
  const scenesSeen = new Map();
  segments.forEach((s, i) => {
    const id = String(s.ir.scene.scene_id);
    scenesSeen.set(id, [...(scenesSeen.get(id) || []), i]);
  });
  for (const [sceneId, idxs] of scenesSeen) {
    if (idxs.length >= 2 && !(table[sceneId] && table[sceneId].ambience)) {
      findings.push({ level: 'warn', code: 'ambience_inconsistent', where: where(idxs[1]), msg: '同一场景有多段，但连续性表没有设定环境声，各段底噪会对不上' });
    }
  }
  const byId = new Map(segments.map((s) => [s.storyboard_id, s]));
  const depth = (s, seen = new Set()) => {
    const from = s.ir.continuity.tail_ref_from;
    if (from == null || !byId.has(from) || seen.has(s.storyboard_id)) return 1;
    seen.add(s.storyboard_id);
    return 1 + depth(byId.get(from), seen);
  };
  segments.forEach((s, i) => {
    const rounds = depth(s);
    if (rounds > MAX_TAIL_ROUNDS) {
      findings.push({ level: 'warn', code: 'tail_chain_too_deep', where: where(i), msg: `尾帧依赖已到第 ${rounds} 轮（一集最多 ${MAX_TAIL_ROUNDS} 轮），请把这一段改成文字承接` });
    }
  });
  return findings;
}

module.exports = { lintEpisode };
