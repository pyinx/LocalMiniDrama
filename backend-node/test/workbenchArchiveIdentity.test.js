const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const AdmZip = require('adm-zip');
const { getFfmpegPath } = require('../src/utils/ffmpegPath');
const { openWorkbench } = require('./helpers/workbenchHttp');

async function restore(ws, buffer) {
  const form = new FormData();
  form.append('file', new Blob([buffer]), '两班船.zip');
  const result = await ws.request('POST', '/dramas/import', form);
  return result.drama_id;
}

test('restores episode cast, distinct scenes and approved costume stages in another database', async t => {
  const src = await openWorkbench(t);
  const dst = await openWorkbench(t);
  src.db.exec(`
    INSERT INTO dramas(id,title,metadata) VALUES(80,'两班船','{"creative_direction":{"enabled":true,"facts":"两班船靠同一码头"}}');
    INSERT INTO episodes(id,drama_id,episode_number) VALUES(91,80,1),(92,80,2);
    INSERT INTO characters(id,drama_id,name,appearance) VALUES
      (41,80,'船长','棉外套'),(42,80,'早班水手','白衫'),(43,80,'晚班水手','青衫'),(44,80,'未登场','长裤');
    INSERT INTO episode_characters(episode_id,character_id) VALUES(91,41),(91,42),(92,41),(92,43);
    INSERT INTO scenes(id,drama_id,episode_id,location,time,prompt,local_path) VALUES
      (71,80,91,'码头','凌晨','石阶','ferry-a.png'),(72,80,92,'码头','凌晨','木梯','ferry-b.png');
    INSERT INTO storyboards(id,episode_id,storyboard_number,characters,scene_id,dialogue,action,description)
      VALUES(51,91,1,'[{"id":41},42]',71,'点灯。','',''),(52,92,1,'[41,43]',72,'收锚。','摇头','');
    INSERT INTO character_libraries(id,name,appearance,local_path) VALUES(41,'领航员','油布斗篷','pilot.png');
    INSERT INTO storyboards(id,episode_id,storyboard_number) VALUES(53,91,2);
    INSERT INTO storyboard_characters(storyboard_id,character_id) VALUES(53,41);
  `);
  const stages = [{ episode_range: [1, 1], appearance: '红棉服' }, { episode_range: [2, 2], appearance: '蓝雨衣' }];
  src.db.prepare('UPDATE characters SET stages=? WHERE id=41').run(JSON.stringify(stages));
  for (const [file, color] of [['ferry-a.png','red'], ['ferry-b.png','blue'], ['pilot.png','green']]) {
    execFileSync(getFfmpegPath(), ['-loglevel','error','-f','lavfi','-i','color=c=' + color + ':s=16x16',
      '-frames:v','1', path.join(src.storage, file)]);
  }
  const review = (ws, id) => ws.request('GET', '/dramas/' + id + '/creative-review');
  for (const board of [51, 52, 53]) {
    for (const [action, field] of [['accept', 'visual'], ['accept', 'dialogue'], ['approve']]) {
      const item = (await review(src, 80)).episodes.flatMap(e => e.shots).find(s => s.id === board);
      await src.request('PUT', '/dramas/80/creative-review/' + board, { action, field, review_token: item.review_token });
    }
  }
  // Keep an outstanding change so an import cannot pass by silently re-approving every lock.
  src.db.prepare("UPDATE scenes SET prompt='湿木梯' WHERE id=72").run();
  const before = (await review(src, 80)).episodes.map(e => e.shots[0]);
  assert.deepEqual(before.map(s => s.approved), [true, false]);
  assert.deepEqual(before.map(s => s.changes), [[], ['visual']]);
  const exported = await fetch(src.url('/dramas/80/export'));
  assert.equal(exported.status, 200);
  const buffer = Buffer.from(await exported.arrayBuffer());
  const restored = await restore(dst, buffer);
  const restoredReview = await review(dst, restored);
  const after = restoredReview.episodes.map(e => e.shots[0]);
  const oldCast = restoredReview.episodes[0].shots[1];
  assert.equal(oldCast.approved, true);
  assert.deepEqual(oldCast.current.visual, ['角色 · 领航员 · 油布斗篷']);
  const pilot = dst.db.prepare(`SELECT c.id,c.local_path FROM character_libraries c JOIN storyboard_characters sc
    ON sc.character_id=c.id WHERE sc.storyboard_id=? AND c.drama_id=?`).get(oldCast.id, restored);
  assert.notEqual(pilot.id, 41);
  assert.deepEqual(fs.readFileSync(path.join(dst.storage, pilot.local_path)), fs.readFileSync(path.join(src.storage, 'pilot.png')));
  for (const [i, shot] of after.entries()) {
    assert.notEqual(shot.id, before[i].id);
    for (const key of ['current', 'lock', 'changes', 'approved', 'creative_revision', 'review_token']) {
      assert.deepEqual(shot[key], before[i][key], key);
    }
    assert.match(shot.current.visual.join(' '), new RegExp(stages[i].appearance));
  }
  const cast = dst.db.prepare(`SELECT e.episode_number, c.name FROM episodes e JOIN episode_characters ec ON e.id=ec.episode_id
    JOIN characters c ON c.id=ec.character_id WHERE e.drama_id=? ORDER BY e.episode_number,c.id`).all(restored);
  assert.deepEqual(cast.map(row => [row.episode_number, row.name]), [[1,'船长'],[1,'早班水手'],[2,'船长'],[2,'晚班水手']]);
  const captain = dst.db.prepare("SELECT id,stages FROM characters WHERE drama_id=? AND name='船长'").get(restored);
  assert.notEqual(captain.id, 41);
  assert.deepEqual(JSON.parse(captain.stages), stages);
  const sets = dst.db.prepare(`SELECT s.id,s.local_path,e.episode_number FROM storyboards b JOIN episodes e ON e.id=b.episode_id
    JOIN scenes s ON s.id=b.scene_id AND s.episode_id=e.id WHERE e.drama_id=? ORDER BY e.episode_number`).all(restored);
  assert.deepEqual(sets.map(s => s.episode_number), [1,2]);
  assert.notEqual(sets[0].id, sets[1].id);
  assert.ok(sets.every(s => ![71,72].includes(s.id)));
  assert.deepEqual(sets.map(s => fs.readFileSync(path.join(dst.storage, s.local_path))),
    ['ferry-a.png','ferry-b.png'].map(file => fs.readFileSync(path.join(src.storage, file))));
  const next = [stages[0], { episode_range: [2,2], appearance: '白雨衣' }];
  dst.db.prepare('UPDATE characters SET stages=? WHERE id=?').run(JSON.stringify(next), captain.id);
  const edited = (await review(dst, restored)).episodes.map(e => e.shots[0]);
  assert.deepEqual(edited[0], after[0]);
  assert.match(edited[1].current.visual.join(' '), /白雨衣/);
  assert.match(edited[1].lock.visual.join(' '), /蓝雨衣/);

  // 1.5 did not encode episode cast or distinct scene identities.
  const zip = new AdmZip(buffer);
  const old = JSON.parse(zip.readAsText('project.json'));
  old.version = '1.5';
  delete old.library_characters;
  for (const ep of old.episodes) {
    delete ep.character_indices;
    for (const sb of ep.storyboards) delete sb.library_character_indices;
  }
  for (const c of old.characters) delete c.stages;
  zip.updateFile('project.json', Buffer.from(JSON.stringify(old)));
  const legacy = await restore(dst, zip.toBuffer());
  assert.equal(dst.db.prepare('SELECT COUNT(*) n FROM scenes WHERE drama_id=?').get(legacy).n, 1);
  assert.equal(dst.db.prepare('SELECT COUNT(*) n FROM episode_characters ec JOIN episodes e ON e.id=ec.episode_id WHERE e.drama_id=?').get(legacy).n, 8);
});
