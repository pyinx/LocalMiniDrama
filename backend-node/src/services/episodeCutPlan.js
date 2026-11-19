const { mediaDigest } = require('./episodeSound');

function fail(message, status = 422) { throw Object.assign(new Error(message), { status }); }

function readPlan(db, episodeId) {
  const row = db.prepare('SELECT edit_plan FROM episodes WHERE id=? AND deleted_at IS NULL').get(episodeId);
  if (!row) fail('剧集不存在', 404);
  return row.edit_plan ? JSON.parse(row.edit_plan) : { revision: 0, cuts: [], fps: null };
}

function inputOf(shot, info, file, digest) {
  return {
    id: shot.scene_id, number: shot.storyboard_number, take: shot.effective_take_id ?? null,
    duration_us: Math.round(info.seconds * 1e6), fps: info.constantRate,
    digest: digest || mediaDigest(file),
    sound_key: require('crypto').createHash('sha256').update(JSON.stringify(shot.sound)).digest('hex'),
  };
}

function rateOf(plan, inputs) {
  if (plan.fps) return plan.fps;
  const playable = inputs.filter(s => s.digest);
  const first = playable[0]?.fps;
  return first && playable.every(s => s.fps === first) ? first : '25/1';
}

function frameRate(rate) {
  if (typeof rate !== 'string' || !/^\d+\/\d+$/.test(rate)) fail('交付帧率无效');
  const [n,d] = rate.split('/').map(Number);
  if (!(n > 0 && d > 0 && Number.isSafeInteger(n) && Number.isSafeInteger(d) && n/d <= 240)) fail('交付帧率无效');
  return n / d;
}

function reference(input) { return { id: input.id, take: input.take, digest: input.digest }; }

function matches(input, ref) {
  return Boolean(input?.digest && input.id === ref?.id && input.take === ref.take && input.digest === ref.digest);
}

function compile(plan, inputs) {
  const fps = rateOf(plan, inputs);
  const hz = frameRate(fps);
  const rows = inputs.map(s => ({ ...s, in_us: 0, out_us: s.duration_us || 0 }));
  const stale = [];
  for (const cut of plan.cuts) {
    const index = rows.findIndex(s => s.id === cut.left.id);
    const left = rows[index], right = rows[index+1];
    if (cut.pending || !matches(left,cut.left) || !matches(right,cut.right)) {
      stale.push(cut);
      continue;
    }
    left.out_us = cut.out_us;
    right.in_us = cut.in_us;
  }
  let cumulative = 0, frame = 0;
  for (const row of rows) {
    if (!row.digest) continue;
    const span = row.out_us - row.in_us;
    if (!Number.isSafeInteger(row.in_us) || !Number.isSafeInteger(row.out_us) ||
        row.in_us < 0 || row.out_us > row.duration_us || span * hz < 1e6 - hz / 2) fail('第 ' + row.number + ' 镜需至少保留一个输出帧，且剪点须在源片范围内');
    cumulative += span;
    row.startFrame = frame;
    frame = Math.round(cumulative * hz / 1e6);
    row.frames = frame - row.startFrame;
    if (!row.frames) fail('第 ' + row.number + ' 镜没有可输出的画面');
  }
  return { fps, rows, stale, frames: frame };
}

function propose(plan, inputs, body) {
  if (body.revision !== plan.revision) fail('剪法已变化，请重新打开接缝', 409);
  const { left, right, action } = body;
  const existing = plan.cuts.find(c => c.left.id === left?.id && c.right.id === right?.id);
  if (!['restore','trim','original'].includes(action)) fail('未知剪辑操作');
  if (action === 'restore' && !existing) return plan;
  const index = inputs.findIndex(s => s.id === left?.id);
  if (action !== 'restore' && (!matches(inputs[index],left) || !matches(inputs[index+1],right))) fail('相邻采用片已变化，请重新试听',409);
  if (action !== 'restore' && (inputs[index].sound_key !== left.sound_key || inputs[index+1].sound_key !== right.sound_key)) fail('声源已变化，请重新试听',409);
  if (action === 'original') return plan;
  const cuts = plan.cuts.filter(c => c !== existing);
  if (action === 'trim' && (body.out_us !== inputs[index].duration_us || body.in_us !== 0)) {
    cuts.push({ left: reference(inputs[index]), right: reference(inputs[index+1]), out_us: body.out_us, in_us: body.in_us });
  }
  const result = { revision: plan.revision, cuts, fps: cuts.length ? rateOf(plan,inputs) : null };
  compile(result, inputs);
  return result;
}

function writePlan(db, id, before, after) {
  if (before.revision !== readPlan(db,id).revision) fail('剪法已变化，请重新试听',409);
  if (JSON.stringify(before) === JSON.stringify(after)) return before;
  const next = { ...after, revision: before.revision + 1 };
  const wrote = db.prepare("UPDATE episodes SET edit_plan=? WHERE id=? AND COALESCE(json_extract(edit_plan,'$.revision'),0)=?")
    .run(JSON.stringify(next),id,before.revision);
  if (wrote.changes !== 1) fail('剪法已变化，请重新试听',409);
  return next;
}

function markPending(db,id,before,stale) {
  if (!stale.some(c => !c.pending) || readPlan(db,id).revision !== before.revision) return before;
  return writePlan(db,id,before,{ ...before,cuts:before.cuts.map(c => stale.includes(c) ? {...c,pending:true} : c) });
}

module.exports = { readPlan, inputOf, rateOf, frameRate, compile, propose, reference, matches, writePlan, markPending, fail };
