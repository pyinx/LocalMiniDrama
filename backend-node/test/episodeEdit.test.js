const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { setTimeout: delay } = require('node:timers/promises');
const { takeWorkspace } = require('./helpers/workbenchTakes');
const { getFfmpegPath, getFfprobePath } = require('../src/utils/ffmpegPath');
const config = require('../src/config');

function ffmpeg(args) {
  return execFileSync(getFfmpegPath(), ['-v', 'error', ...args]);
}

async function mediaWorkspace(t, frequencies) {
  const ws = await takeWorkspace(t);
  t.mock.method(config, 'loadConfig', () => ws.cfg);
  const episode = ws.episodes[0].id;
  const boards = ws.shots.slice(0, 2);
  if (frequencies.length === 3) boards.push(await ws.request('POST', '/storyboards', { episode_id: episode, storyboard_number: 3 }));
  for (const [i, tone] of frequencies.entries()) {
    const filename = 'clip-' + i + '.mp4';
    const id = ws.add(boards[i], filename);
    const args = ['-y', '-f', 'lavfi', '-i', 'color=' + ['red','blue','green'][i] + ':s=72x128:r=25:d=2'];
    if (tone) args.push('-f', 'lavfi', '-i', 'sine=frequency=' + tone + ':duration=2', '-c:a', 'aac');
    ffmpeg([...args, '-c:v', 'libx264', path.join(ws.storage, filename)]);
    await ws.adopt(boards[i], id);
  }
  const update = (i, patch) => ws.request('PUT', '/storyboards/' + boards[i].id, patch);
  async function finish(mode, options = {}) {
    const job = await ws.request('POST', '/episodes/' + episode + '/finalize', { delivery_mode: mode, ...options });
    for (let i = 0; i < 600; i++) {
      const row = await ws.request('GET', '/video-merges/' + job.merge_id);
      if (row.status === 'completed' || row.status === 'failed') return row;
      await delay(30);
    }
    assert.fail('导出超时');
  }
  const editUrl = '/episodes/' + episode + '/edit';
  const read = (options = {}) => ws.request('GET', editUrl + '?' + new URLSearchParams(options));
  async function audition(body) {
    const job = await ws.request('POST', editUrl+'/audition',body);
    for (let i = 0; i < 600; i++) {
      const task = await ws.request('GET','/tasks/'+job.task_id);
      if (task.status === 'failed') assert.fail(task.error);
      if (task.status === 'completed') return typeof task.result === 'string' ? JSON.parse(task.result) : task.result;
      await delay(30);
    }
    assert.fail('试听超时');
  }
  return { ...ws, episode, boards, update, finish, editUrl, read, audition };
}

function checkSound(ws, row, expected) {
  assert.equal(row.status, 'completed', row.error_msg);
  const file = path.join(ws.storage, row.merged_url);
  const { streams } = JSON.parse(execFileSync(getFfprobePath(), ['-v', 'error', '-show_streams', '-of', 'json', file]));
  const audio = streams.find(s => s.codec_type === 'audio');
  assert.ok(audio, '成片缺少主声轨');
  assert.ok(Math.abs(Number(audio.duration) - expected.length * 2) < 0.041, '音轨时长 ' + audio.duration);
  const video = streams.find(s => s.codec_type === 'video');
  assert.deepEqual([video.width, video.height], [72, 128]);
  for (const [i, tones] of expected.entries()) {
    const frameArgs = ['-frames:v','1','-vf','scale=1:1','-pix_fmt','rgb24','-f','rawvideo','-'];
    const srcPixel = ffmpeg(['-ss','0.5','-i', path.join(ws.storage,'clip-' + i + '.mp4'), ...frameArgs]);
    const pixel = ffmpeg(['-ss',String(i * 2 + 0.5),'-i',file,...frameArgs]);
    assert.ok(pixel.length === 3 && pixel.every((n,c) => Math.abs(n - srcPixel[c]) <= 4), '镜头顺序或画面变化');
    const pcm = ffmpeg(['-ss', String(i * 2 + 0.5), '-i', file, '-t', '0.25', '-map', '0:a:0', '-ar', '8000', '-ac', '1', '-f', 's16le', '-']);
    assert.equal(pcm.length, 4000);
    for (const hz of [440, 660, 880, 1000]) {
      let re = 0, im = 0;
      for (let n = 0; n < 2000; n++) {
        const angle = 2 * Math.PI * hz * n / 8000;
        re += pcm.readInt16LE(2 * n) * Math.cos(angle);
        im += pcm.readInt16LE(2 * n) * Math.sin(angle);
      }
      const magnitude = Math.hypot(re, im) / 1000;
      assert.ok(tones.includes(hz) ? magnitude > 120 : magnitude < 25, '镜 ' + (i+1) + ' 频率 ' + hz + ' 幅值 ' + magnitude);
    }
  }
}

test('preserves selected sound across missing tracks', async t => {
  for (const sources of [[0,440], [440,0], [440,0,660], [0,0]]) {
    await t.test(sources.join('-'), async t => {
      const ws = await mediaWorkspace(t, sources);
      for (const mode of ['draft','complete']) checkSound(ws, await ws.finish(mode), sources.map(hz => hz ? [hz] : []));
    });
  }
});

test('keeps undubbed shots and respects explicit sound choices', async t => {
  const ws = await mediaWorkspace(t, [440,660]);
  for (const [name,hz,d] of [['dub',880,2], ['narr',1000,2], ['long',880,3]]) {
    ffmpeg(['-f','lavfi','-i','sine=frequency=' + hz + ':duration=' + d,path.join(ws.storage, name + '.wav')]);
  }
  await ws.update(0, { audio_local_path: 'dub.wav' });
  await ws.update(1, { dialogue: '还在。' });
  for (const mode of ['draft','complete']) {
    checkSound(ws, await ws.finish(mode), [[440],[660]]);
    checkSound(ws, await ws.finish(mode, {burn_dialogue_audio:true}), [[880],[660]]);
  }
  checkSound(ws, await ws.finish(undefined, {burn_dialogue_audio:true}), [[880],[660]]);
  await ws.update(1, { audio_local_path:'dub.wav', sound_source:'dub' });
  await ws.update(0, { sound_source:'original' });
  checkSound(ws, await ws.finish('complete', {burn_dialogue_audio:true}), [[440],[880]]);
  await ws.update(1, { audio_local_path:'long.wav' });
  checkSound(ws, await ws.finish('complete'), [[440],[880]]);
  const { buffer } = require('../src/services/dramaExportService').exportDrama(ws.db, ws.cfg, console, ws.id);
  const dest = await require('./helpers/workbenchHttp').openWorkbench(t);
  const form = new FormData();
  form.append('file', new Blob([buffer]), '试剪.zip');
  const restored = await dest.request('POST','/dramas/import',form);
  const project = await dest.request('GET','/dramas/' + restored.drama_id);
  const copy = project.episodes[0].storyboards;
  assert.deepEqual(copy.map(s => s.sound_source), ['original','dub']);
  const pin = JSON.parse(dest.db.prepare('SELECT adopted_sound FROM storyboards WHERE id=?').get(copy[1].id).adopted_sound);
  assert.deepEqual(fs.readFileSync(path.join(dest.storage, pin.path)), fs.readFileSync(path.join(ws.storage,'dub.wav')));
  assert.notEqual(pin.path, copy[1].audio_local_path);
  await ws.update(0, { sound_source:'mute', narration:'旁白', narration_audio_local_path:'narr.wav' });
  checkSound(ws, await ws.finish('complete', {burn_narration_subtitles:true}), [[1000],[880]]);
  await ws.update(0, { sound_source:'original' });
  checkSound(ws, await ws.finish('complete', {burn_narration_subtitles:true}), [[440,1000],[880]]);
  await ws.update(1, { sound_source:'dub' });
  assert.match((await ws.finish('complete')).error_msg, /第 2 镜.*(超出|超过)/);
  fs.unlinkSync(path.join(ws.storage, 'long.wav'));
  assert.match((await ws.finish('complete')).error_msg, /第 2 镜.*配音/);
  checkSound(ws, await ws.finish('draft'), [[440],[660]]);
});

function change(state,i,outUs,inUs) {
  return { revision:state.revision,action:'trim',left:state.shots[i],right:state.shots[i+1],out_us:outUs,in_us:inUs };
}
function fileOf(ws,row) {
  assert.equal(row.status,'completed',row.error_msg);
  return path.join(ws.storage,row.merged_url);
}
function pixels(file) {
  return ffmpeg(['-i',file,'-map','0:v:0','-vf','scale=1:1','-fps_mode','passthrough','-pix_fmt','gray','-f','rawvideo','-']);
}

test('preview and delivery honor the same cut', async t => {
  const ws = await mediaWorkspace(t,[440,660]);
  for (const [i,rate] of ['25','30000/1001'].entries()) {
    const filter = "geq=lum='18+N*3':cb=128:cr=128" + (i ? ",select='not(eq(n,8)+eq(n,9))'" : '');
    ffmpeg(['-y','-f','lavfi','-i','color=s=72x128:r='+rate+':d=2','-vf',filter,'-fps_mode','vfr','-g','120','-c:v','libx264',path.join(ws.storage,'clip-'+i+'.mp4')]);
  }
  const state = await ws.read();
  assert.equal(state.fps,'25/1');
  const proposal = change(state,0,1320000,284000);
  const trial = await ws.audition(proposal);
  const before = pixels(fileOf(ws,await ws.finish('complete')));
  await ws.request('PUT',ws.editUrl,proposal);
  const accepted = pixels(fileOf(ws,await ws.finish('complete')));
  const heard = pixels(path.join(ws.storage,trial.video_url));
  assert.equal(accepted.length,Math.round((1320000+state.shots[1].duration_us-284000)*25/1e6));
  assert.equal(trial.seam_seconds,1.32);
  assert.ok(heard.length === accepted.length && heard.every((p,i) => Math.abs(p-accepted[i])<=2));
  const right = pixels(path.join(ws.storage,'clip-1.mp4'));
  assert.ok(Math.abs(accepted[33]-right[7])<=2,'VFR 入点处应保留当时正在显示的帧');
  assert.ok(Math.abs(accepted[35]-right[8])<=2,'VFR 长帧结束后应在真实源时刻显示新帧');
  assert.ok(Math.abs(accepted[32]-pixels(path.join(ws.storage,'clip-0.mp4'))[32])<=2);
  assert.notEqual(before.length,accepted.length);
  const stale = await ws.error('PUT',ws.editUrl,proposal);
  assert.equal(stale.status,409);
  const updated = await ws.read();
  await ws.request('PUT',ws.editUrl,{...proposal,revision:updated.revision,action:'restore'});
  assert.deepEqual(pixels(fileOf(ws,await ws.finish('complete'))),before);
  const fresh = await ws.read();
  for (const out of [0,1000,fresh.shots[0].duration_us+1]) assert.equal((await ws.error('PUT',ws.editUrl,change(fresh,0,out,0))).status,422);
  await ws.request('PUT',ws.editUrl,change(fresh,0,40000,0));
  assert.equal(pixels(fileOf(ws,await ws.finish('complete'))).length,1+Math.round(fresh.shots[1].duration_us*25/1e6));
});

test('keeps rotated mixed-rate cuts on the cumulative output frame grid', async t => {
  const ws = await mediaWorkspace(t, [0, 0]);
  const rates = ['25', '30', '30000/1001', '30', '25', '30'];
  const colors = ['white', 'black', 'white', 'black', 'white', 'black'];
  for (const [i, rate] of rates.entries()) {
    const name = `clip-${i}.mp4`;
    if (i >= 2) {
      const shot = await ws.request('POST', '/storyboards', { episode_id: ws.episode, storyboard_number: i + 1 });
      await ws.adopt(shot, ws.add(shot, name));
    }
    const rotated = i === 1;
    const file = path.join(ws.storage, name);
    const src = rotated ? path.join(ws.storage, 'landscape.mp4') : file;
    ffmpeg(['-y', '-f', 'lavfi', '-i', `color=${colors[i]}:s=${rotated ? '128x72' : '72x128'}:r=${rate}:d=1`, '-c:v', 'libx264', src]);
    if (rotated) ffmpeg(['-y', '-display_rotation', '90', '-i', src, '-c', 'copy', file]);
  }
  // Individually rounding five 12.55-frame spans would shift the last cut by two frames.
  for (let i = 0; i < rates.length - 1; i++) {
    const state = await ws.read();
    assert.equal(state.fps, '25/1');
    await ws.request('PUT', ws.editUrl, change(state, i, 502000, 0));
  }
  const movie = fileOf(ws, await ws.finish('complete'));
  const stream = JSON.parse(execFileSync(getFfprobePath(), ['-v', 'error', '-select_streams', 'v:0', '-show_streams', '-of', 'json', movie])).streams[0];
  assert.deepEqual([stream.width, stream.height], [72, 128]);
  const frames = pixels(movie);
  assert.equal(frames.length, Math.round(25 * (5 * 0.502 + 1)));
  for (let i = 1; i < rates.length; i++) {
    const cut = Math.round(25 * i * 0.502);
    assert.equal(frames[cut - 1] > 128, colors[i - 1] === 'white', `镜头 ${i} 的最后一帧`);
    assert.equal(frames[cut] > 128, colors[i] === 'white', `镜头 ${i + 1} 的第一帧`);
  }
});

test('remaps timed cues from one cut plan', async t => {
  const ws = await mediaWorkspace(t,[440,0,660]);
  ffmpeg(['-f','lavfi','-i','sine=frequency=1000:duration=0.4',path.join(ws.storage,'speech.wav')]);
  await ws.update(2,{narration:'看这里。',narration_audio_local_path:'speech.wav'});
  await ws.request('PUT',ws.editUrl,change(await ws.read(),0,1440000,200000));
  await ws.request('PUT',ws.editUrl,change(await ws.read(),1,1200000,0));
  const file = fileOf(ws,await ws.finish('complete',{burn_narration_subtitles:true}));
  const srt = fs.readdirSync(path.dirname(file)).find(n=>n.endsWith('.srt'));
  assert.match(fs.readFileSync(path.join(path.dirname(file),srt),'utf8'),/00:00:02,440 --> 00:00:02,840/);
  const tones = ffmpeg(['-ss','2.50','-t','0.20','-i',file,'-af','bandpass=f=1000:w=15','-ar','8000','-ac','1','-f','s16le','-']);
  assert.ok(tones.some((_,i)=>i%2===0 && Math.abs(tones.readInt16LE(i))>500),'字幕出现时应能听到旁白');
  const invalid = {...change(await ws.read({burn_narration_subtitles:true}),1,1200000,160000),burn_narration_subtitles:true};
  assert.equal((await ws.error('PUT',ws.editUrl,invalid)).status,422);
  const heard = change(await ws.read(),0,1400000,200000);
  await ws.audition(heard);
  await ws.update(0,{sound_source:'mute'});
  assert.equal((await ws.error('PUT',ws.editUrl,heard)).status,409,'已听过的声源发生变化不能直接采用');
  await ws.update(0,{sound_source:'dub',audio_local_path:'speech.wav'});
  fs.unlinkSync(path.join(ws.storage,'speech.wav'));
  fileOf(ws,await ws.finish('draft'));
  assert.equal((await ws.finish('complete')).status,'failed');
});

test('restores adopted cuts and invalidates changed inputs', async t => {
  const ws = await mediaWorkspace(t,[440,0,660]);
  const fourth = await ws.request('POST','/storyboards',{episode_id:ws.episode,storyboard_number:4});
  const id = ws.add(fourth,'four.mp4');
  fs.copyFileSync(path.join(ws.storage,'clip-2.mp4'),path.join(ws.storage,'four.mp4'));
  await ws.adopt(fourth,id);
  let state = await ws.read();
  await ws.request('PUT',ws.editUrl,change(state,0,1200000,200000));
  state = await ws.read();
  await ws.request('PUT',ws.editUrl,change(state,2,1600000,80000));
  const release = fileOf(ws,await ws.finish('complete'));
  const zip = require('../src/services/dramaExportService').exportDrama(ws.db,ws.cfg,console,ws.id).buffer;
  const dest = await require('./helpers/workbenchHttp').openWorkbench(t);
  dest.db.exec("INSERT INTO dramas(id,title) VALUES(80,'已存在的项目'); INSERT INTO episodes(id,drama_id,episode_number) VALUES(80,80,1); INSERT INTO storyboards(id,episode_id,storyboard_number) VALUES(80,80,1); INSERT INTO video_generations(id,drama_id,storyboard_id,provider,prompt,status) VALUES(80,80,80,'fixture','old','completed')");
  const restored = require('../src/services/dramaImportService').importDrama(dest.db,dest.cfg,console,zip);
  const ep = dest.db.prepare('SELECT id FROM episodes WHERE drama_id=? ORDER BY episode_number').get(restored.drama_id);
  const imported = await dest.request('GET','/episodes/'+ep.id+'/edit');
  assert.equal(imported.cuts.length,2);
  assert.ok(imported.cuts.every(c => c.left.take > 80 && c.left.id > 80));
  assert.ok(imported.cuts.every(c=>!c.pending));
  assert.deepEqual(imported.shots.map(s=>[s.in_us,s.out_us]),[[0,1200000],[200000,2000000],[0,1600000],[80000,2000000]]);
  const middle = path.join(ws.storage,'clip-1.mp4');
  const old = fs.readFileSync(middle);
  fs.writeFileSync(middle,'damaged');
  const preview = await ws.finish('draft');
  const {warnings} = JSON.parse(ws.db.prepare('SELECT result FROM async_tasks WHERE id=?').get(preview.task_id).result);
  assert.match(warnings.join(' '),/第 2 镜/);
  assert.equal(pixels(fileOf(ws,preview)).length,138,'临时 A→C 仅保留有效的 C→D 剪法');
  assert.equal((await ws.finish('complete')).status,'failed');
  assert.ok(fs.existsSync(release));
  fs.writeFileSync(middle,old);
  state = await ws.read();
  assert.equal(state.cuts.filter(c=>c.pending).length,1);
  assert.equal((await ws.finish('complete')).status,'failed');
  await ws.request('PUT',ws.editUrl,{...change(state,0,1200000,200000),action:'restore'});
  fileOf(ws,await ws.finish('complete'));
  fs.copyFileSync(path.join(ws.storage,'clip-0.mp4'),path.join(ws.storage,'clip-2.mp4'));
  assert.equal((await ws.finish('complete')).status,'failed','同路径换片需要复核');
});

test('a late export cannot publish over the new edit, and a reordered pair needs review', async t => {
  const ws = await mediaWorkspace(t, [440, 660]);
  await ws.request('PUT', ws.editUrl, change(await ws.read(), 0, 1500000, 0));
  const media = require('../src/services/episodeMediaRender');
  const render = media.renderDeliveryShots;
  let signalEntry, resumeRender;
  const entered = new Promise(resolve => { signalEntry = resolve; });
  const resumed = new Promise(resolve => { resumeRender = resolve; });
  let first = true;
  t.mock.method(media, 'renderDeliveryShots', async (...args) => {
    if (first) {
      first = false;
      signalEntry();
      await resumed;
    }
    return render(...args);
  });
  const slow = ws.finish('complete');
  let newest;
  try {
    await Promise.race([entered, slow.then(() => assert.fail('旧任务未进入渲染'))]);
    await ws.request('PUT', ws.editUrl, change(await ws.read(), 0, 1200000, 0));
    newest = await ws.finish('complete');
    fileOf(ws, newest);
  } finally {
    resumeRender();
  }
  const older = await slow;
  assert.equal(older.status, 'failed');
  assert.match(older.error_msg, /剪辑版本已变化/);
  const setNumber = ws.db.prepare('UPDATE storyboards SET storyboard_number=? WHERE id=?');
  setNumber.run(3, ws.boards[0].id);
  const reordered = await ws.read();
  assert.deepEqual(reordered.shots.map(s => s.id), [ws.boards[1].id, ws.boards[0].id]);
  assert.equal(reordered.cuts[0].pending, true);
  assert.equal((await ws.finish('complete')).status, 'failed');
  assert.equal(ws.db.prepare('SELECT video_url FROM episodes WHERE id=?').get(ws.episode).video_url, newest.merged_url);
  assert.ok(pixels(fileOf(ws, newest)).length > 0);
});

test('keeps a pending cut portable after repeated imports with a deleted shot', () => {
  const archive = require('../src/services/episodeCutArchive');
  const db = { prepare: () => ({run(json) { ep.edit_plan = json; }}) };
  const side = id => ({id,take:null,digest:'f'.repeat(64)});
  const ep = { edit_plan:JSON.stringify({ fps:'25/1', cuts:[{left:side(12),right:side(13),out_us:40000,in_us:0,pending:true}] }) };
  for (let pass=0; pass<2; pass++) archive.restoreCuts(db,1,archive.packCuts(db,ep,[]),[]);
  assert.equal(JSON.parse(ep.edit_plan).cuts[0].left.id,-12);
});

test('rejects a broken seam even when both video headers can be read', async t => {
  const ws = await mediaWorkspace(t,[440,660]);
  const source = path.join(ws.storage,'clip-0.mp4');
  const fast = path.join(ws.storage,'fast.mp4');
  ffmpeg(['-i',source,'-c','copy','-movflags','+faststart',fast]);
  const bytes = fs.readFileSync(fast);
  fs.writeFileSync(source,bytes.subarray(0,Math.floor(bytes.length/2)));
  const state = await ws.read();
  assert.ok(state.shots[0].digest,'文件头应仍可读取');
  const proposed = change(state,0,1200000,0);
  for (const [method,url] of [['POST',ws.editUrl+'/audition'],['PUT',ws.editUrl]]) {
    assert.equal((await ws.error(method,url,proposed)).status,409);
  }
  assert.equal((await ws.read()).cuts.length,0);
  fileOf(ws,await ws.finish('draft'));
});

test('checks original media again before publishing an unedited episode', async t => {
  const ws = await mediaWorkspace(t,[440,660]);
  const renderer = require('../src/services/episodeMediaRender');
  const render = renderer.renderDeliveryShots;
  t.mock.method(renderer,'renderDeliveryShots',async (...args) => {
    await render(...args);
    fs.copyFileSync(path.join(ws.storage,'clip-1.mp4'),path.join(ws.storage,'clip-0.mp4'));
  });
  const result = await ws.finish('complete');
  assert.equal(result.status,'failed');
  assert.match(result.error_msg,/采用片内容已变化/);
});

test('composes structured cues from the accepted revision', async t => {
  const ws = await mediaWorkspace(t, [440, 660]);
  const { sampleIr } = require('./helpers/segmentIrFixtures');
  const ir = sampleIr({ sceneId: 1, hrId: 1, linId: 2 }, {
    cards: [{ text: '切后字卡', at_s: 5, hold_s: 2 }],
  });
  ir.shots[0].lines[0].text = '签字。';
  ws.db.prepare('UPDATE storyboards SET segment_ir=? WHERE id=?').run(JSON.stringify(ir), ws.boards[1].id);
  await ws.update(1, { sound_source: 'mute' });
  await ws.request('PUT', ws.editUrl, change(await ws.read(), 0, 1200000, 800000));
  const job = await ws.finish('complete', { dialogue_subtitles: true, cards: true, review_sheets: true, burn_dialogue_audio: true });
  const file = fileOf(ws, job);
  assert.equal(job.post_info.dialogue_track, false);
  assert.ok(fs.statSync(path.join(ws.storage, job.post_info.sheets.seams)).size > 0);
  const folder = path.dirname(file);
  const files = fs.readdirSync(folder);
  const cardsFile = files.find(name => name.endsWith('.cards.srt'));
  const dialogueFile = files.find(name => name.endsWith('.srt') && name !== cardsFile);
  assert.match(fs.readFileSync(path.join(folder, cardsFile), 'utf8'), /00:00:01,650 --> 00:00:02,400\s+切后字卡/);
  const dialogue = fs.readFileSync(path.join(folder, dialogueFile), 'utf8');
  assert.doesNotMatch(dialogue, /签字/);
  assert.match(dialogue, /00:00:01,200 --> .*\s+是因为绩效吗/);
  const pcm = ffmpeg(['-ss','1.6','-i',file,'-t','0.25','-map','0:a:0','-ar','8000','-ac','1','-f','s16le','-']);
  assert.equal(pcm.length, 4000);
  assert.ok(pcm.every(byte => byte === 0), '显式静音镜在结构化后期中保持安静');

  ir.shots[0].lines = [];
  ir.shots[1].lines = ir.shots[1].lines.slice(0, 1);
  ws.db.prepare('UPDATE storyboards SET segment_ir=? WHERE id=?').run(JSON.stringify(ir), ws.boards[1].id);
  await ws.update(1, { sound_source: 'auto' });
  await ws.request('PUT', ws.editUrl, change(await ws.read(), 0, 1200000, 750000));
  const tts = t.mock.method(require('../src/services/ttsService'), 'synthesize', async (_db, _log, req) => {
    const local_path = 'line-' + Buffer.from(req.text).toString('hex') + '.wav';
    ffmpeg(['-f', 'lavfi', '-i', 'sine=frequency=880:duration=0.4', path.join(req.storage_base, local_path)]);
    return { local_path };
  });
  const dubbed = await ws.finish('complete', { burn_dialogue_audio: true, dialogue_subtitles: true });
  const dubbedFile = fileOf(ws, dubbed);
  assert.equal(dubbed.post_info.dialogue_track, true);
  assert.ok(tts.mock.callCount() > 0);
  const speech = ffmpeg(['-ss', '1.25', '-i', dubbedFile, '-t', '0.15', '-af', 'bandpass=f=880:w=12', '-ar', '8000', '-ac', '1', '-f', 's16le', '-']);
  assert.ok(speech.some((_, i) => i % 2 === 0 && Math.abs(speech.readInt16LE(i)) > 500), '裁后接缝应能听到对应的逐句配音');
});

function hasTone(file,start,hz) {
  const pcm = ffmpeg(['-ss',String(start),'-i',file,'-t','0.1','-map','0:a:0','-ar','8000','-ac','1','-f','s16le','-']);
  let re=0,im=0;
  for (let i=0; i<pcm.length/2;i++) {
    const phase=2*Math.PI*hz*i/8000, sample=pcm.readInt16LE(i*2);
    re+=sample*Math.cos(phase); im+=sample*Math.sin(phase);
  }
  return Math.hypot(re,im)/(pcm.length/2)>100;
}

test('extends available sound over a picture cut', async t => {
  const ws = await mediaWorkspace(t, [440,660]);
  const sceneId = ws.db.prepare("INSERT INTO scenes (drama_id,location,time) VALUES (?,'会议室','日')").run(ws.id).lastInsertRowid;
  const insertActor = ws.db.prepare('INSERT INTO characters (drama_id,name) VALUES (?,?)');
  const hrId = insertActor.run(ws.id,'人事').lastInsertRowid;
  const linId = insertActor.run(ws.id,'林远').lastInsertRowid;
  const ir = require('./helpers/segmentIrFixtures').sampleIr({sceneId,hrId,linId});
  ir.shots[0].lines = [];
  ws.db.prepare('UPDATE storyboards SET segment_ir=? WHERE id=?').run(JSON.stringify(ir),ws.boards[1].id);
  const leftIr = structuredClone(ir);
  leftIr.shots[1].lines = [leftIr.shots[1].lines[0]];
  leftIr.shots[1].lines[0].text = '上一句仍在说话。';
  ws.db.prepare('UPDATE storyboards SET segment_ir=? WHERE id=?').run(JSON.stringify(leftIr),ws.boards[0].id);
  const initial = await ws.read();
  assert.equal(initial.shots[0].audio_end_us,2000000);
  assert.equal(initial.shots[0].mixed_audio,true);
  assert.equal(initial.shots[1].speech_ranges_us[0].start_us,750000);
  const cut = change(initial,0,1200000,400000);
  for (const tail_us of [350001,-1,1.5,'5',null]) {
    assert.equal((await ws.error('PUT',ws.editUrl,{...cut,tail_us})).status,422);
  }
  const sync = pixels(path.join(ws.storage,(await ws.audition(cut)).video_url));
  const proposed = {...cut,tail_us:350000};
  const trial = path.join(ws.storage,(await ws.audition(proposed)).video_url);
  await ws.request('PUT',ws.editUrl,proposed);
  assert.equal((await ws.read()).cuts[0].tail_us,350000);
  for (const file of [trial,fileOf(ws,await ws.finish('complete'))]) {
    assert.deepEqual(pixels(file),sync);
    assert.ok(hasTone(file,1.30,440) && hasTone(file,1.30,660));
    assert.ok(!hasTone(file,1.65,440) && hasTone(file,1.65,660));
  }
  const captioned = fileOf(ws,await ws.finish('complete',{dialogue_subtitles:true}));
  const subdir = path.dirname(captioned);
  const srt = fs.readFileSync(path.join(subdir,fs.readdirSync(subdir).find(f => f.endsWith('.srt'))),'utf8');
  assert.match(srt,/00:00:00,750 --> 00:00:01,550\s+上一句仍在说话/);
  assert.match(srt,/00:00:01,550 --> .*\s+是因为绩效吗/);
  const {buffer} = require('../src/services/dramaExportService').exportDrama(ws.db,ws.cfg,console,ws.id);
  const dest = await require('./helpers/workbenchHttp').openWorkbench(t);
  const restored = require('../src/services/dramaImportService').importDrama(dest.db,dest.cfg,console,buffer);
  const copy = dest.db.prepare('SELECT edit_plan FROM episodes WHERE drama_id=? ORDER BY episode_number').get(restored.drama_id);
  assert.equal(JSON.parse(copy.edit_plan).cuts[0].tail_us,350000);
  const ep = dest.db.prepare('SELECT id FROM episodes WHERE drama_id=? ORDER BY episode_number').get(restored.drama_id);
  assert.equal((await dest.request('GET','/episodes/'+ep.id+'/edit')).cuts[0].pending,undefined);
  await ws.request('PUT',ws.editUrl,{...cut,revision:(await ws.read()).revision,tail_us:0});
  const off = fileOf(ws,await ws.finish('complete'));
  assert.deepEqual(pixels(off),sync);
  assert.equal(hasTone(off,1.30,440),false);
  const full = change(await ws.read(),0,2000000,0);
  assert.equal((await ws.error('PUT',ws.editUrl,{...full,tail_us:1})).status,422);
  ffmpeg(['-f','lavfi','-i','sine=frequency=880:duration=1.45',path.join(ws.storage,'dub.wav')]);
  await ws.update(1,{audio_local_path:'dub.wav',sound_source:'dub'});
  assert.equal((await ws.error('PUT',ws.editUrl,{...change(await ws.read(),0,1200000,0),tail_us:1})).status,422);
  await ws.update(1,{sound_source:'original'});
  await ws.update(0,{audio_local_path:'dub.wav',sound_source:'dub'});
  const dubbed = {...change(await ws.read(),0,1200000,0),tail_us:250000};
  await ws.request('PUT',ws.editUrl,dubbed);
  const file = fileOf(ws,await ws.finish('complete'));
  assert.ok(hasTone(file,1.27,880) && !hasTone(file,1.27,440));
  ffmpeg(['-f','lavfi','-i','sine=frequency=1000:duration=2.25',path.join(ws.storage,'long-dub.wav')]);
  await ws.update(0,{audio_local_path:'long-dub.wav',sound_source:'dub'});
  const longDub = {...change(await ws.read(),0,2000000,0),tail_us:250000};
  assert.equal((await ws.error('PUT',ws.editUrl,{...longDub,tail_us:100000})).status,422);
  await ws.request('PUT',ws.editUrl,longDub);
  assert.ok(hasTone(fileOf(ws,await ws.finish('complete')),2.05,1000));
  await ws.update(0,{sound_source:'original'});
  assert.equal((await ws.read()).cuts[0].pending,true);
  assert.equal((await ws.finish('complete')).status,'failed');
  await ws.request('PUT',ws.editUrl,{...dubbed,revision:(await ws.read()).revision,action:'restore'});
  assert.equal((await ws.read()).cuts.length,0);
  assert.equal(hasTone(fileOf(ws,await ws.finish('complete')),2.1,880),false);
});


test('auditions the seam on the episode mix with preceding tails and continuous music', async t => {
  const ws = await mediaWorkspace(t,[440,0,660]);
  const ir = require('./helpers/segmentIrFixtures').sampleIr({sceneId:1,hrId:1,linId:2});
  ws.db.prepare('UPDATE storyboards SET segment_ir=? WHERE id=?').run(JSON.stringify(ir),ws.boards[0].id);
  const music = path.join(ws.storage,'music.wav');
  ffmpeg(['-f','lavfi','-i','sine=frequency=1000:duration=6','-af',"volume=0:enable='lt(t,1)'",music]);
  const post = require('../src/services/structuredEpisodePost');
  const runPost = post.runStructuredEpisodePost;
  t.mock.method(post,'runStructuredEpisodePost',(db,log,opts) => runPost(db,log,{...opts,filters:new Set()}));
  const opts = {dialogue_subtitles:true,bgm:{url:'/static/music.wav',volume_db:-6}};
  await ws.request('PUT',ws.editUrl,{...change(await ws.read(),0,1000000,0),tail_us:400000});
  const cut = {...change(await ws.read(),1,1480000,0),...opts};
  const heard = await ws.audition(cut);
  await ws.request('PUT',ws.editUrl,cut);
  const release = fileOf(ws,await ws.finish('complete',opts));
  assert.equal(heard.seam_seconds,1.48);
  const subtitles = ffmpeg(['-i',path.join(ws.storage,heard.video_url),'-map','0:s:0','-f','srt','-']).toString();
  assert.match(subtitles,/00:00:00,000 --> 00:00:00,400\s+是因为绩效吗/);
  for (const [file,offset] of [[release,1],[path.join(ws.storage,heard.video_url),0]]) {
    assert.ok(hasTone(file,offset+0.15,440),'前一接缝的尾音进入本试听窗');
    assert.ok(!hasTone(file,offset+0.7,440),'前一接缝的尾音按时结束');
    assert.ok(hasTone(file,offset+0.15,1000),'由首镜 IR 触发的整集配乐保持绝对时码');
  }
  fs.writeFileSync(path.join(ws.storage,'clip-0.mp4'),'damaged');
  const missing = await ws.audition({...change(await ws.read(),1,1480000,0),...opts});
  assert.equal(missing.seam_seconds,1.48);
  assert.match(missing.warnings.join(' '),/第 1 镜/);
  const skipped = path.join(ws.storage,missing.video_url);
  assert.ok(!hasTone(skipped,0.15,440) && !hasTone(skipped,0.15,1000));
  assert.ok(hasTone(skipped,1.2,1000),'草稿缺首镜后仍按剩余整集时间重新定位 BGM');

});
