/**
 * 尾帧衔接规则：前一段的最后一帧只给同一场景版本、至少有一个共同出场角色的紧邻下一段使用；
 * 跨场景、换场景版本或没有共同角色时挂尾帧，会把上一场的空间或人物带进来。
 */
function tailFrameEligibility(prevIr, nextIr) {
  if (!prevIr) return { ok: false, reason: '上一段不是结构化分镜，无法判断能否衔接' };
  const sameScene = prevIr.scene.scene_id === nextIr.scene.scene_id && (prevIr.scene.state_id ?? null) === (nextIr.scene.state_id ?? null);
  if (!sameScene) return { ok: false, reason: '两段不在同一场景版本，挂尾帧会把上一场的空间带进来，请改用文字承接' };
  const prevChars = new Set(prevIr.cast.filter((c) => !c.group).map((c) => c.character_id));
  if (!nextIr.cast.some((c) => !c.group && prevChars.has(c.character_id))) {
    return { ok: false, reason: '两段没有共同出场的角色，尾帧衔接没有意义' };
  }
  return { ok: true };
}

module.exports = { tailFrameEligibility };
