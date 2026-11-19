const { resolveTake } = require('./workbenchTakeService');
const { frameRate } = require('./episodeCutPlan');

function packCuts(db, ep, boards) {
  if (!ep.edit_plan) return {};
  const plan = JSON.parse(ep.edit_plan);
  if (!plan.cuts.length) return {};
  const ref = side => {
    const index = boards.findIndex(b => b.id === side.id);
    const active = index >= 0 && (resolveTake(db,boards[index])?.id ?? null) === side.take;
    return { index, digest:side.digest, active, original_id:Math.abs(side.id) };
  };
  return { edit_plan:{ fps:plan.fps, cuts:plan.cuts.map(c => ({
    left:ref(c.left), right:ref(c.right), in_us:c.in_us, out_us:c.out_us, pending:!!c.pending,
  })) } };
}

function restoreCuts(db, id, ep, boards) {
  const plan = ep.edit_plan;
  if (!plan) return;
  if (!Array.isArray(plan.cuts) || plan.cuts.length > 500) throw new Error('工程包剪辑记录无效');
  frameRate(plan.fps);
  function side(ref) {
    if (!Number.isInteger(ref?.index) || ref.index < -1 || ref.index >= boards.length || !/^[a-f0-9]{64}$/.test(ref.digest)) throw new Error('工程包接缝引用无效');
    const board = boards[ref.index];
    if (!board && !(ref.original_id > 0 && Number.isSafeInteger(ref.original_id))) throw new Error('工程包缺少旧镜号');
    return {id:board ? board.id : -ref.original_id, take:board?.take ?? null, digest:ref.digest};
  }
  const cuts = plan.cuts.map(c => {
    if (![c.in_us,c.out_us].every(n => Number.isSafeInteger(n) && n >= 0)) throw new Error('工程包源片剪点无效');
    return {left:side(c.left),right:side(c.right),in_us:c.in_us,out_us:c.out_us,
      ...(c.pending || !c.left.active || !c.right.active ? { pending:true } : {})};
  });
  db.prepare('UPDATE episodes SET edit_plan=? WHERE id=?').run(JSON.stringify({revision:1,fps:plan.fps,cuts}),id);
}

module.exports = { packCuts,restoreCuts };
