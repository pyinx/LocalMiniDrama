const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { getFfmpegPath } = require('../../src/utils/ffmpegPath');
const { openWorkbench } = require('./workbenchHttp');

async function takeWorkspace(t) {
  const ws = await openWorkbench(t);
  const { id } = await ws.request('POST', '/dramas', { title: '双镜审片' });
  await ws.request('PUT', '/dramas/' + id + '/episodes', { episodes: [1, 2].map(i => ({ episode_number: i, title: '集 ' + i })) });
  const { episodes } = await ws.request('GET', '/dramas/' + id);
  const shots = [];
  for (const ep of episodes) {
    for (const n of [1, 2]) shots.push(await ws.request('POST', '/storyboards', { episode_id: ep.id, storyboard_number: n, duration: 1 }));
  }
  function add(board, file, color) {
    if (color) execFileSync(getFfmpegPath(), ['-loglevel', 'error', '-f', 'lavfi', '-i',
      'color=c=' + color + ':s=48x80:r=2:d=1', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', path.join(ws.storage, file)]);
    else if (file) fs.writeFileSync(path.join(ws.storage, file), file);
    return ws.db.prepare(`INSERT INTO video_generations(drama_id,storyboard_id,provider,prompt,status,local_path,created_at)
      VALUES(?,?,'test','clip','completed',?,CURRENT_TIMESTAMP)`).run(id, board.id, file).lastInsertRowid;
  }
  async function adopt(board, video_generation_id, expected_revision = 0) {
    return ws.request('PUT', '/storyboards/' + board.id + '/takes/adoption', { video_generation_id, expected_revision });
  }
  async function error(method, resource, body) {
    return fetch(ws.url(resource), { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  }
  return { ...ws, id, episodes, shots, add, adopt, error };
}

module.exports = { takeWorkspace };
