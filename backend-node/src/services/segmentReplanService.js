/**
 * 按当前视频模型重新规划一集的结构化分镜：拆出的段插在原段之后，全集按顺序重编号。
 * 原段保留已绑定的视频/图片（只更新 IR 与投影）；新段为空，等待重新出图出视频。旧分镜（无 IR）不动。
 */
const videoClient = require('./videoClient');
const storyboardService = require('./storyboardService');
const { parseSegmentIr } = require('./segmentIr/schema');
const { planSegments } = require('./segmentIr/planner');

function codedError(code, message) {
  const err = new Error(message);
  err.code = code;
  return err;
}

function normalizedIrJson(ir) {
  const r = parseSegmentIr(ir);
  if (!r.ok) throw codedError('segment_ir_invalid', '规划结果未通过校验：' + JSON.stringify(r.errors.slice(0, 3)));
  return JSON.stringify(r.ir);
}

function insertSplitRow(db, base, k, now) {
  return db.prepare(
    `INSERT INTO storyboards (episode_id, storyboard_number, title, location, time, atmosphere, segment_index, segment_title,
       creation_mode, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)`
  ).run(
    base.episode_id,
    base.storyboard_number,
    `${base.title || '分镜'}（续${k}）`,
    base.location ?? null,
    base.time ?? null,
    base.atmosphere ?? null,
    base.segment_index ?? 0,
    base.segment_title ?? null,
    base.creation_mode || 'classic',
    now,
    now
  ).lastInsertRowid;
}

/**
 * @returns {{ model: string|null, protocol: string|null, changes: object[], findings: object[] }}
 */
function replanEpisode(db, log, episodeId, opts = {}) {
  const epId = Number(episodeId);
  const ep = db.prepare('SELECT id FROM episodes WHERE id = ? AND deleted_at IS NULL').get(epId);
  if (!ep) throw codedError('not_found', '剧集不存在');
  const rows = db
    .prepare('SELECT * FROM storyboards WHERE episode_id = ? AND deleted_at IS NULL ORDER BY storyboard_number, id')
    .all(epId);
  const irRows = rows.filter((r) => r.segment_ir);
  if (!irRows.length) throw codedError('no_segment_ir', '本集没有结构化分镜，无需重新规划');

  const { caps, model, protocol } = videoClient.resolveVideoTarget(db, opts.model);
  const irs = irRows.map((r) => {
    const parsed = parseSegmentIr(r.segment_ir);
    if (!parsed.ok) throw codedError('segment_ir_invalid', `分镜 ${r.id} 的结构化数据已损坏`);
    return parsed.ir;
  });
  const plan = planSegments(irs, caps, {
    openingHook: !!rows[0].segment_ir,
    closingHook: !!rows[rows.length - 1].segment_ir,
  });
  const blockers = plan.findings.filter((f) => f.level === 'block');
  if (blockers.length) {
    const err = codedError('segment_replan_blocked', blockers[0].msg);
    err.findings = blockers;
    throw err;
  }
  const partsBySource = irRows.map(() => []);
  plan.segments.forEach((s) => partsBySource[s.source].push(s.ir));

  const changes = [];
  const now = new Date().toISOString();
  db.transaction(() => {
    const order = [];
    let irIndex = 0;
    for (const row of rows) {
      if (!row.segment_ir) {
        order.push({ id: row.id, change: null });
        continue;
      }
      const [first, ...rest] = partsBySource[irIndex++];
      const same = normalizedIrJson(first) === row.segment_ir;
      if (!same) storyboardService.saveSegmentIr(db, log, row.id, first);
      order.push({ id: row.id, change: { storyboard_id: row.id, from_storyboard_id: row.id, action: same ? 'unchanged' : 'updated' } });
      rest.forEach((ir, k) => {
        const newId = insertSplitRow(db, row, k + 1, now);
        storyboardService.saveSegmentIr(db, log, newId, ir);
        order.push({ id: newId, change: { storyboard_id: newId, from_storyboard_id: row.id, action: 'created' } });
      });
    }
    const base = Math.max(1, Math.min(...rows.map((r) => Number(r.storyboard_number) || 1)));
    const setNumber = db.prepare('UPDATE storyboards SET storyboard_number = ? WHERE id = ? AND storyboard_number IS NOT ?');
    order.forEach(({ id, change }, i) => {
      setNumber.run(base + i, id, base + i);
      if (change) changes.push({ ...change, storyboard_number: base + i });
    });
  })();
  log.info('Episode segments replanned', { episode_id: epId, protocol, model, changes: changes.filter((c) => c.action !== 'unchanged').length });
  return { model, protocol, changes, findings: plan.findings };
}

module.exports = { replanEpisode };
