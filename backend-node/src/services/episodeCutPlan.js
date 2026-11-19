const { createHash } = require('crypto');
const { mediaDigest } = require('./episodeSound');

function fail(message, status = 422) { throw Object.assign(new Error(message), { status }); }

function readPlan(db, episodeId) {
  const row = db.prepare('SELECT edit_plan FROM episodes WHERE id=? AND deleted_at IS NULL').get(episodeId);
  if (!row) fail('剧集不存在', 404);
  return row.edit_plan ? JSON.parse(row.edit_plan) : { revision: 0, cuts: [], fps: null };
}

async function inputOf(shot, info, file, options, root, digest) {
  const bounds = await require('./episodeMediaRender').tailBounds(shot,info,options,root);
  const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
  return {
    id: shot.scene_id, number: shot.storyboard_number, take: shot.effective_take_id ?? null,
    duration_us: Math.round(info.seconds * 1e6), fps: info.constantRate,
    ...bounds,
    tail_sound_key:hash([bounds,shot.sound?.selected?.source,shot.sound?.dub_digest,shot.sound?.narration_digest]),
    digest: digest || mediaDigest(file),
    sound_key: hash([shot.sound,shot.segment_ir]),
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
    const changedSound = cut.tail_us && (cut.left.tail_sound_key !== left?.tail_sound_key ||
      cut.right.tail_sound_key !== right?.tail_sound_key);
    if (cut.pending || changedSound || !matches(left,cut.left) || !matches(right,cut.right)) {
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
  const invalidTails = [];
  for (const cut of plan.cuts) {
    if (!cut.tail_us || stale.includes(cut)) continue;
    const left = rows.find(row => row.id === cut.left.id);
    const right = rows.find(row => row.id === cut.right.id);
    const room = [left.audio_end_us - left.out_us, right.out_us - right.in_us, Math.floor(right.frames * 1e6 / hz)];
    for (const speech of right.speech_ranges_us) {
      if (speech.end_us > right.in_us) room.push(speech.start_us - right.in_us);
    }
    if (left.out_us < left.audio_start_us || cut.tail_us > Math.min(...room)) {
      invalidTails.push('第 ' + left.number + ' → ' + right.number + ' 镜尾音超出可用余量或与下一句冲突，请缩短或关闭尾音');
    } else left.tail_us = cut.tail_us;
  }
  return { fps, rows, stale, invalidTails, frames: frame };
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
  const tail_us = body.tail_us === undefined ? 0 : body.tail_us;
  if (!Number.isSafeInteger(tail_us) || tail_us < 0) fail('尾音时长必须为非负整数微秒');
  if (action === 'trim' && (tail_us || body.out_us !== inputs[index].duration_us || body.in_us !== 0)) {
    const side = input => ({...reference(input), ...(tail_us && {tail_sound_key:input.tail_sound_key})});
    cuts.push({ left: side(inputs[index]), right: side(inputs[index+1]), out_us: body.out_us, in_us: body.in_us, tail_us });
  }
  const result = { revision: plan.revision, cuts, fps: cuts.length ? rateOf(plan,inputs) : null };
  const {invalidTails} = compile(result, inputs);
  if (action === 'trim' && invalidTails.length) fail(invalidTails.join('；'));
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
