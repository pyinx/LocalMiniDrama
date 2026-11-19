const fs = require('fs');
const os = require('os');
const path = require('path');
const cuts = require('./episodeCutPlan');
const drama = require('./dramaService');
const merge = require('./videoMergeService');
const { validateSpeechRange } = require('./episodeMediaRender');

async function editEpisode(db, cfg, log, id, operation, body = {}) {
  const root = path.resolve(cfg.storage?.local_path || './data/storage');
  const base = cfg.storage?.base_url || '';
  const before = cuts.readPlan(db,id);
  const options = { burn_dialogue_audio: !!body.burn_dialogue_audio, burn_narration_subtitles: !!body.burn_narration_subtitles };
  const scenes = drama.episodeDeliveryInputs(db,id,base,options);
  const temp = fs.mkdtempSync(path.join(os.tmpdir(),'episode-edit-'));
  try {
    const inputs = [];
    const localInputs = new Map();
    let canvas;
    for (const shot of scenes) {
      try {
        const file = shot.video_url && await merge.resolveVideoToLocalPath(shot.video_url,base,root,temp,shot.scene_id,log);
        if (!file) throw new Error('缺少视频');
        // The catalog can use headers. Audition and adoption must validate the actual pair.
        const verify = operation !== 'read' && body.action !== 'restore' && [body.left?.id,body.right?.id].includes(shot.scene_id);
        const info = await merge.inspectDeliveryClip(file,'第 ' + shot.storyboard_number + ' 镜',false,verify);
        inputs.push(cuts.inputOf(shot,info,file));
        localInputs.set(shot.scene_id,file);
        canvas ||= info;
      } catch (err) { inputs.push({ id:shot.scene_id,number:shot.storyboard_number, error:err.message }); }
    }
    if (JSON.stringify(scenes) !== JSON.stringify(drama.episodeDeliveryInputs(db,id,base,options))) cuts.fail('素材已变化，请重新打开',409);
    const current = cuts.readPlan(db,id);
    if (current.revision !== before.revision) cuts.fail('剪辑版本已变化，请重新打开',409);
    const compiled = cuts.compile(current,inputs);
    const plan = cuts.markPending(db,id,current,compiled.stale);
    if (operation === 'read') return { revision:plan.revision, fps:compiled.fps, shots:compiled.rows, cuts:plan.cuts };
    const next = cuts.propose(plan,inputs,body);
    const timeline = cuts.compile(next,inputs);
    if (body.action === 'trim') {
      for (const row of timeline.rows.filter(s => s.id === body.left.id || s.id === body.right.id)) {
        await validateSpeechRange(scenes.find(s => s.scene_id === row.id),row,options,root);
      }
    }
    if (cuts.readPlan(db,id).revision !== plan.revision || JSON.stringify(scenes) !== JSON.stringify(drama.episodeDeliveryInputs(db,id,base,options))) cuts.fail('镜头或剪法已变化，请重新试听',409);
    if (operation === 'save') {
      if (body.action === 'trim' && [body.left,body.right].some(ref => require('./episodeSound').mediaDigest(localInputs.get(ref.id)) !== ref.digest)) cuts.fail('采用素材已变化，请重新试听',409);
      return cuts.writePlan(db,id,plan,next);
    }
    if (body.action === 'restore') cuts.fail('请选择要试听的接缝');
    return drama.finalizeEpisode(db,log,id,base,{...body,delivery_mode:'draft'}, {plan:next,pair:[body.left,body.right],inputs,canvas});
  } finally { fs.rmSync(temp,{recursive:true,force:true}); }
}

module.exports = { editEpisode };
