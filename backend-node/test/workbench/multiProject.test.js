const { test } = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { setTimeout: delay } = require('node:timers/promises');
const config = require('../../src/config');
const aiClient = require('../../src/services/aiClient');
const { getFfmpegPath, getFfprobePath } = require('../../src/utils/ffmpegPath');

const projects = [
  {
    title: '最后一碗', style: 'realistic', size: [48, 80], lead: '女儿',
    premise: '母女各自把最后一碗面留给对方，无意中卖出了两份早餐。',
    episodes: [
      ['留面', '母亲把一碗面推回锅边，隔着出餐口对女儿说：“给下一位吧。”女儿把碗悄悄挪到母亲手边。'],
      ['开张', '第二天，女儿换上新围裙。母亲把空碗放回老位置，两人看见窗外排起的小队，互相让了半步。'],
    ],
  },
  {
    title: '借潮灯', style: 'cartoon', size: [80, 48], lead: '守灯人',
    episodes: [
      ['第一章 借火', '退潮以后，守灯人把熄灭的玻璃灯交给孩子。孩子在灯底摸到一粒带盐的蓝沙，往海堤外走去。'],
      ['第二章 还潮', '孩子沿着同一段海堤折返。玻璃灯里的蓝沙已经化成水，他将灯放回守灯人留下的石台上。'],
    ],
  },
];

const { openWorkbench } = require('../helpers/workbenchHttp');

async function scriptsFromSource(t, ws, project) {
  if (project.premise) {
    const provider = t.mock.method(aiClient, 'generateText', async () =>
      JSON.stringify(project.episodes.map(([title, content], i) => ({ episode: i + 1, title, content })))
    );
    const story = await ws.request('POST', '/generation/story', {
      premise: project.premise, style: project.style, episode_count: 2,
    });
    assert.equal(provider.mock.callCount(), 1);
    assert.ok(provider.mock.calls[0].arguments[3].includes(project.premise));
    return story.episodes.map(ep => ({ episode_number: ep.episode, title: ep.title, script_content: ep.content }));
  }
  const form = new FormData();
  form.append('file', new Blob([project.episodes.map(ep => ep.join('\n')).join('\n')]), 'story.txt');
  const novel = await ws.request('POST', '/dramas/import-novel', form);
  assert.equal(novel.total, 2);
  return novel.chapters.map(ch => ({ episode_number: ch.index, title: ch.title, script_content: ch.script }));
}

function addRenderedClip(ws, dramaId, shotId, size, color) {
  // The externally rendered clip enters at the completed-generation boundary.
  const filename = 'shot-' + shotId + '.mp4';
  execFileSync(getFfmpegPath(), ['-loglevel', 'error', '-f', 'lavfi', '-i',
    'color=c=' + color + ':s=' + size.join('x') + ':r=2:d=1', '-c:v', 'libx264',
    '-pix_fmt', 'yuv420p', path.join(ws.storage, filename)]);
  ws.db.prepare(`INSERT INTO video_generations
    (drama_id, storyboard_id, provider, prompt, status, local_path, created_at, updated_at)
    VALUES (?, ?, 'local-fixture', 'colour reference', 'completed', ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`)
    .run(dramaId, shotId, filename);
}

async function verifyCut(ws, ep, size, colorOrder) {
  const job = await ws.request('POST', '/episodes/' + ep.id + '/finalize', {});
  assert.equal(job.scenes_count, 2);
  let merge;
  const deadline = Date.now() + 20_000;
  do {
    merge = await ws.request('GET', '/video-merges/' + job.merge_id);
    if (merge.status === 'completed' || merge.status === 'failed') break;
    await delay(20);
  } while (Date.now() < deadline);
  assert.equal(merge.status, 'completed', JSON.stringify(merge));
  const output = path.join(ws.storage, merge.merged_url);
  const probe = JSON.parse(execFileSync(getFfprobePath(), ['-v', 'error', '-select_streams', 'v:0',
    '-show_entries', 'stream=width,height', '-of', 'json', output]));
  assert.deepEqual([probe.streams[0].width, probe.streams[0].height], size);
  const frames = execFileSync(getFfmpegPath(), ['-loglevel', 'error', '-i', output, '-vf', 'scale=1:1',
    '-pix_fmt', 'rgb24', '-f', 'rawvideo', 'pipe:1']);
  assert.equal(frames.length, 4 * 3, 'two one-second shots at two frames per second');
  for (let i = 0; i < 4; i++) {
    const [red, green, blue] = frames.subarray(i * 3, i * 3 + 3);
    const color = red > 200 && green < 40 && blue < 40 ? 'red'
      : blue > 200 && green < 40 && red < 40 ? 'blue' : 'unexpected';
    assert.equal(color, colorOrder[Math.floor(i / 2)], 'frame ' + i);
  }
}

async function verifyProjectLifecycle(t, project) {
  const source = await openWorkbench(t);
  const dest = await openWorkbench(t);
  const storageConfig = t.mock.method(config, 'loadConfig', () => source.cfg);
  const drama = await source.request('POST', '/dramas', { title: project.title, style: project.style });
  const scripts = await scriptsFromSource(t, source, project);
  assert.deepEqual(scripts.map(ep => [ep.title, ep.script_content]), project.episodes);
  await source.request('PUT', '/dramas/' + drama.id + '/episodes', { episodes: scripts });
  const draft = await source.request('GET', '/dramas/' + drama.id);
  const characterPath = '/dramas/' + drama.id + '/characters';
  const reference = execFileSync(getFfmpegPath(), ['-loglevel', 'error', '-f', 'lavfi', '-i',
    'testsrc=size=48x48', '-frames:v', '1', '-f', 'image2pipe', '-c:v', 'png', 'pipe:1']);
  fs.writeFileSync(path.join(source.storage, 'lead.png'), reference);
  for (const ep of draft.episodes) {
    await source.request('PUT', characterPath, {
      episode_id: ep.id, characters: [{ name: project.lead, local_path: 'lead.png' }],
    });
  }
  const cast = await source.request('GET', characterPath);
  assert.equal(cast.length, 1, 'both episodes share the same character');
  const orders = [['red', 'blue'], ['blue', 'red']];
  const originalShotIds = [];
  for (const [i, ep] of draft.episodes.entries()) {
    for (const [j, color] of orders[i].entries()) {
      const shot = await source.request('POST', '/storyboards', {
        episode_id: ep.id, storyboard_number: j + 1, title: ep.title + ' 镜' + (j + 1), duration: 1,
      });
      originalShotIds.push(shot.id);
      await source.request('PUT', '/storyboards/' + shot.id, { character_ids: [cast[0].id] });
      addRenderedClip(source, drama.id, shot.id, project.size, color);
    }
    await verifyCut(source, ep, project.size, orders[i]);
  }
  const exported = await fetch(source.url('/dramas/' + drama.id + '/export'));
  assert.equal(exported.status, 200);
  const form = new FormData();
  form.append('file', await exported.blob(), 'project.zip');
  // Occupy IDs in the other database to make stale source IDs observable.
  await dest.request('POST', '/dramas/import', form);
  const restored = await dest.request('POST', '/dramas/import', form);
  const reopened = await dest.request('GET', '/dramas/' + restored.drama_id);
  assert.notEqual(reopened.id, drama.id);
  assert.equal(reopened.style, project.style);
  assert.equal(reopened.characters.length, 1);
  const lead = reopened.characters[0];
  assert.equal(lead.name, project.lead);
  assert.notEqual(lead.id, cast[0].id);
  assert.deepEqual(fs.readFileSync(path.join(dest.storage, lead.local_path)), reference);
  assert.deepEqual(reopened.episodes.map(ep => [ep.title, ep.script_content]), project.episodes);
  storageConfig.mock.mockImplementation(() => dest.cfg);
  for (const [i, ep] of reopened.episodes.entries()) {
    assert.notEqual(ep.id, draft.episodes[i].id);
    assert.deepEqual(ep.storyboards.map(shot => shot.storyboard_number), [1, 2]);
    assert.deepEqual(ep.characters.map(actor => actor.id), [lead.id]);
    for (const shot of ep.storyboards) assert.deepEqual(shot.characters, [lead.id]);
    assert.ok(ep.storyboards.every(shot => !originalShotIds.includes(shot.id)));
    await verifyCut(dest, ep, project.size, orders[i]);
  }
}

test('最后一碗 preserves two episode cuts across archive import', async t => {
  await verifyProjectLifecycle(t, projects[0]);
});

test('借潮灯 preserves two episode cuts across archive import', async t => {
  await verifyProjectLifecycle(t, projects[1]);
});
