/**
 * 交接检查（警告）：相邻镜头、相邻片段之间人物状态对不上——持物突变、人物凭空消失或多出、左右朝向翻转。
 * 只读 IR 字段（cast、shots[].subjects、shots[].action），不比较 frame_pos、gaze 等自由文本。
 * 「已交代」靠动作文字里的物品名与一小组固定动词判定，没列到的写法会误报；一律只给警告。
 */
const EXIT_VERBS = ['离开', '走出', '出画', '出门', '退出', '下场'];
const ENTRY_VERBS = ['走进', '进来', '入画', '进门', '赶到'];
const TURN_VERBS = ['转身', '转向', '绕', '走到', '换到'];

const holdingItems = (holding) => new Set(String(holding || '').split(/[、，,；;]/).map((s) => s.trim()).filter(Boolean));
const said = (action, alias, verbs) => !!action && action.includes(alias) && verbs.some((v) => action.includes(v));

/** 本段内的人物：身份键（有 character_id 用它，别名换写法也认得）→ { alias, group } */
function castOf(ir) {
  const byAlias = new Map();
  for (const c of ir.cast || []) byAlias.set(c.alias, { key: `c${c.character_id}`, alias: c.alias, group: !!c.group });
  return byAlias;
}

/** 一个镜头里的出镜人物：身份键 → { alias, subject }；群演不参与 */
function onScreen(ir, shot) {
  const cast = castOf(ir);
  const out = new Map();
  for (const s of shot.subjects || []) {
    const c = cast.get(s.alias) || { key: `a${s.alias}`, alias: s.alias, group: false };
    if (!c.group) out.set(c.key, { alias: c.alias, subject: s });
  }
  return out;
}

function holdingFinding(where, alias, from, to, before, after, label) {
  const lost = [...from].filter((x) => !to.has(x));
  const gained = [...to].filter((x) => !from.has(x));
  const unexplained = [...lost, ...gained].filter((x) => !before.includes(x) && !after.includes(x));
  if (!unexplained.length) return null;
  const fmt = (set) => (set.size ? [...set].join('、') : '空手');
  return {
    level: 'warn', code: 'holding_changed', where: { ...where, alias },
    msg: `${alias}${label}手里的东西从「${fmt(from)}」变成「${fmt(to)}」，动作里没有交代「${unexplained.join('、')}」的去向或来源`,
  };
}

function holdingBetween(a, aShot, b, bShot, where, label) {
  const prev = onScreen(a, aShot);
  const next = onScreen(b, bShot);
  const out = [];
  for (const [key, p] of prev) {
    const n = next.get(key);
    if (!n) continue;
    const from = holdingItems(p.subject.holding);
    const to = holdingItems(n.subject.holding);
    if (from.size === to.size && [...from].every((x) => to.has(x))) continue;
    const f = holdingFinding(where, n.alias, from, to, aShot.action || '', bShot.action || '', label);
    if (f) out.push(f);
  }
  return out;
}

/** 身体侧向画左/画右；背向镜头、两边都写了或没写的不判侧 */
function side(facing) {
  const f = facing || '';
  if (/背向/.test(f)) return null;
  const l = /画左/.test(f);
  const r = /画右/.test(f);
  return l === r ? null : l ? 'L' : 'R';
}

/**
 * @param {{ storyboard_id: number, storyboard_number?: number, ir: object }[]} segments 本集按顺序的 IR 段
 * @returns {{ level: 'warn', code: string, where: object, msg: string }[]}
 */
function lintHandoff(segments) {
  const findings = [];
  segments.forEach((seg, i) => {
    const shots = seg.ir.shots || [];
    for (let k = 1; k < shots.length; k++) {
      const where = { segment: i, storyboard_id: seg.storyboard_id, shot: k };
      findings.push(...holdingBetween(seg.ir, shots[k - 1], seg.ir, shots[k], where, `在第 ${k} 镜到第 ${k + 1} 镜之间，`));
    }
    if (i === 0) return;
    const prev = segments[i - 1];
    const adjacent = prev.ir.scene.scene_id === seg.ir.scene.scene_id
      && (prev.storyboard_number == null || seg.storyboard_number == null || seg.storyboard_number === prev.storyboard_number + 1);
    if (!adjacent || !prev.ir.shots.length || !shots.length) return;

    const lastShot = prev.ir.shots[prev.ir.shots.length - 1];
    const firstShot = shots[0];
    const where = { segment: i, storyboard_id: seg.storyboard_id, shot: 0 };
    findings.push(...holdingBetween(prev.ir, lastShot, seg.ir, firstShot, where, '从上一段末镜到本段首镜，'));

    const prevCast = castOf(prev.ir);
    const curCast = castOf(seg.ir);
    const curKeys = new Set([...curCast.values()].map((c) => c.key));
    const prevKeys = new Set([...prevCast.values()].map((c) => c.key));
    const last = onScreen(prev.ir, lastShot);
    const first = onScreen(seg.ir, firstShot);
    for (const [key, p] of last) {
      if (!curKeys.has(key) && !said(lastShot.action, p.alias, EXIT_VERBS)) {
        findings.push({ level: 'warn', code: 'character_vanished', where: { ...where, alias: p.alias }, msg: `${p.alias}在上一段末镜还在画面里，本段没有这个人物，上一段动作里也没有写离场` });
      }
    }
    for (const [key, n] of first) {
      if (!prevKeys.has(key) && !said(firstShot.action, n.alias, ENTRY_VERBS)) {
        findings.push({ level: 'warn', code: 'character_appeared', where: { ...where, alias: n.alias }, msg: `${n.alias}出现在本段首镜，上一段没有这个人物，本镜动作里也没有写入场` });
      }
    }
    const flips = [];
    let shared = 0;
    let flipped = 0;
    for (const [key, n] of first) {
      const p = last.get(key);
      const from = p && side(p.subject.facing);
      const to = side(n.subject.facing);
      if (!from || !to) continue;
      shared++;
      if (from === to) continue;
      flipped++;
      if (!said(firstShot.action, n.alias, TURN_VERBS)) flips.push({ alias: n.alias, from: p.subject.facing, to: n.subject.facing });
    }
    // 两人以上同时左右互换，是反打换了机位，不是人物转向
    if (shared >= 2 && flipped === shared) return;
    for (const f of flips) {
      findings.push({ level: 'warn', code: 'facing_flipped', where: { ...where, alias: f.alias }, msg: `${f.alias}的朝向从「${f.from}」变成「${f.to}」，左右颠倒且动作里没有转身或换边` });
    }
  });
  return findings;
}

module.exports = { lintHandoff };
