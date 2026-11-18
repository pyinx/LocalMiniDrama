const test = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const { runMigrationsAndEnsure } = require('../src/db/migrate');
const { reviewShot, readWorkbench, updateDirection } = require('../src/services/workbenchContinuity');
const dramaService = require('../src/services/dramaService');

test('scopes changes to referencing episodes', t => {
  const db = new Database(':memory:');
  t.after(() => db.close());
  runMigrationsAndEnsure(db);
  db.exec(`
    INSERT INTO dramas (id,title) VALUES (1,'守灯人'),(2,'另一部剧');
    INSERT INTO episodes (id,drama_id,episode_number) VALUES (10,1,1),(11,1,2),(12,2,1);
    INSERT INTO characters (id,drama_id,name,appearance) VALUES (30,1,'阿梁','灰衣');
    INSERT INTO props (id,drama_id,name,prompt) VALUES (40,1,'灯','蓝玻璃');
    INSERT INTO scenes (id,drama_id,location,time,prompt) VALUES (50,1,'海堤','傍晚','潮湿石阶');
    INSERT INTO storyboards (id,episode_id,storyboard_number,characters,scene_id,dialogue,video_url,updated_at) VALUES
      (20,10,1,'[30]',50,'我走了。','/static/e1.mp4','original'),
      (21,11,1,'[30]',50,'灯还亮着。',NULL,NULL),(22,11,2,'[]',NULL,'',NULL,NULL);
    INSERT INTO storyboard_props (storyboard_id,prop_id) VALUES (20,40),(21,40);
  `);
  const shots = () => readWorkbench(db, 1).episodes.flatMap(e => e.shots);
  const shot = id => shots().find(s => s.id === id);
  const review = (id, action, field) => reviewShot(db, 1, id, { action, field, review_token: shot(id).review_token });
  for (const id of [20, 21, 22]) { review(id, 'accept', 'visual'); review(id, 'accept', 'dialogue'); }
  const first = shot(20);
  const oldSecond = shot(21);
  assert.throws(() => dramaService.generateStoryboard(db, console, 10, {}), /替换锁定镜头 1/);
  db.prepare('UPDATE characters SET stages=? WHERE id=30').run(JSON.stringify([{ episode_range: [2, 2], appearance: '白衣' }]));
  assert.deepEqual(shots().filter(s => s.changes.length).map(s => [s.id, s.changes]), [[21, ['visual']]]);
  assert.ok(shot(21).current.visual.some(line => line.includes('白衣')));
  assert.deepEqual(shot(20), first);
  assert.throws(() => reviewShot(db, 1, 21, { action: 'accept', field: 'visual', review_token: oldSecond.review_token }), { status: 409 });
  review(21, 'accept', 'visual');
  db.prepare("UPDATE storyboards SET dialogue='灯灭了。' WHERE id=21").run();
  assert.deepEqual(shot(21).changes, ['dialogue']);
  assert.equal(shot(21).lock.dialogue, '灯还亮着。');
  review(21, 'accept', 'dialogue');
  assert.deepEqual(shot(21).changes, []);
  db.prepare("UPDATE props SET prompt='蓝玻璃裂口' WHERE id=40").run();
  assert.deepEqual(shots().filter(s => s.changes.length).map(s => s.id), [20, 21]);
  assert.equal(db.prepare('SELECT updated_at FROM storyboards WHERE id=20').get().updated_at, 'original');
  assert.throws(() => reviewShot(db, 2, 20, { action: 'unlock', field: 'dialogue' }), { status: 404 });
  updateDirection(db, 1, { enabled: true, facts: '灯在第二集才亮', revision: 0 });
  const spec = readWorkbench(db, 1).direction;
  assert.throws(() => updateDirection(db, 1, { enabled: false, facts: '', revision: 0 }), { status: 409 });
  dramaService.saveOutline(db, { info() {} }, 1, { metadata: { creative_direction: { revision: 0 }, aspect_ratio: '9:16' } });
  assert.deepEqual(readWorkbench(db, 1).direction, spec);
  review(21, 'approve');
  assert.equal(shot(21).approved, true);
  db.prepare("UPDATE storyboards SET action='她接过灯' WHERE id=21").run();
  assert.equal(shot(21).approved, false);
});
