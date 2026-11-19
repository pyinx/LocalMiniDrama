const { test } = require('node:test');
const assert = require('node:assert/strict');
const { once } = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const express = require('express');
const Database = require('better-sqlite3');
const { runMigrationsAndEnsure } = require('../src/db/migrate');
const { setupRouter } = require('../src/routes');
const ai = require('../src/services/aiClient');
const { importNovel } = require('../src/services/novelImportService');
const { openWorkbench } = require('./helpers/workbenchHttp');
const { setTimeout: delay } = require('node:timers/promises');

test('separates bracket subtitles from prose and maps only explicit episode numbers', async () => {
  const text = ['【第一章 暗灯】', '灯灭。', '《第九集 迟到》钟响。', '雨停。', '第１０集 她推门。',
    '第十二集', '灯亮。', '【第三十六章】尾声。'].join('\n');
  const { chapters } = await importNovel(null, console, { text });
  assert.deepEqual(chapters.map(c => [c.title, c.episode_number, c.source.text]), [
    ['第一章 暗灯', undefined, '灯灭。'], ['第九集 迟到', 9, '钟响。\n雨停。'],
    ['第１０集', 10, '她推门。'], ['第十二集', 12, '灯亮。'], ['第三十六章', undefined, '尾声。'],
  ]);
  assert.deepEqual(chapters[1].source.parts, [{ start: 0, end: '钟响。\n雨停。'.length }]);
});

test('adopts large multipart previews into the chosen episodes and rejects stale mappings', async t => {
  const ws = await openWorkbench(t);
  const { novelSelectionForm } = await import('../../frontweb/src/utils/novelSelection.js');
  const original = '雪'.repeat(1_800_000);
  const file = new Blob(['【第九集 暗灯】\n', original, '\n第十集\n灯亮。']);
  const input = new FormData();
  input.append('file', file, 'novel.txt');
  input.append('compact', 'true');
  const { chapters } = await ws.request('POST', '/dramas/import-novel', input);
  assert.deepEqual(chapters.map(c => c.episode_number), [9, 10]);
  assert.equal(chapters[0].source.text, original);
  assert.equal('script' in chapters[0], false);
  const metadata = { project: { title: '续集' }, operation_id: 'large-novel-project-9' };
  const first = { chapter: chapters[0], targetNumber: 9, target: null };
  const makeForm = (rows, creation) => novelSelectionForm(file, '续集', rows, creation);
  const form = makeForm([first], metadata);
  assert.ok(form.get('selection').size < 100_000);
  const { id } = await ws.request('POST', '/dramas/import-novel-project', form);
  const base = '/dramas/' + id;
  const read = () => ws.db.prepare('SELECT * FROM episodes WHERE drama_id=? AND deleted_at IS NULL ORDER BY episode_number').all(id);
  const [episode] = read();
  assert.equal(episode.episode_number, 9);
  assert.equal(episode.script_content, original);
  assert.equal(JSON.parse(episode.novel_source).text, original);
  const retry = await ws.request('POST', '/dramas/import-novel-project', makeForm([first], metadata));
  assert.equal(retry.id, id);
  const apply = rows => ws.request('PUT', base + '/novel-episodes', makeForm(rows));
  first.target = episode;
  chapters[0].source.parts[0].adaptation = '灯灭。';
  const second = { chapter: chapters[1], targetNumber: 13, target: null };
  const adopted = await apply([first, second]);
  assert.deepEqual(adopted.episode_numbers, [9, 13]);
  assert.ok(read()[0].script_content.startsWith('灯灭。\n\n雪'));
  assert.equal(read()[1].script_content, '灯亮。');
  chapters[0].source.parts[0].adaptation = '迟到的改编';
  const stale = await fetch(ws.url(base + '/novel-episodes'), { method: 'PUT', body: makeForm([{ ...second, targetNumber: 10 }, first]) });
  assert.equal(stale.status, 409);
  assert.deepEqual(read().map(e => e.episode_number), [9, 13]);
});

test('generated proposals preserve finalized episodes until individually adopted', async t => {
  const ws = await openWorkbench(t);
  const { id } = await ws.request('POST', '/dramas', { title: '三集定稿' });
  const base = '/dramas/' + id;
  const scripts = [1,2,3].map(i => ({ episode_number: i, title: '原稿' + i, script_content: '原文' + i }));
  await ws.request('PUT', base + '/episodes', { episodes: scripts });
  const eps = (await ws.request('GET', base)).episodes;
  for (const ep of eps) await ws.request('POST', '/storyboards', { episode_id: ep.id, storyboard_number: 1, title: '定镜' });
  const snapshot = (await ws.request('GET', base)).episodes;
  t.mock.method(ai, 'generateText', async () => '纯文本单集拟稿');
  const job = await ws.request('POST', '/generation/story', { drama_id: id, premise: '创意', episode_count: 3 });
  let task;
  for (let i = 0; i < 200; i++) {
    task = await ws.request('GET', '/tasks/' + job.task_id);
    if (['failed', 'completed'].includes(task.status)) break;
    await delay(10);
  }
  assert.equal(task.status, 'completed', task.error);
  assert.deepEqual((await ws.request('GET', base)).episodes, snapshot);
  const [draft] = await ws.request('GET', base + '/story-proposals');
  assert.equal(draft.episodes[0].script_content, '纯文本单集拟稿');
  const url = base + '/story-proposals/' + draft.id;
  const stale = await fetch(ws.url(url), { method: 'PUT', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ episodes: [{ episode_number: 1, expected: null }] }) });
  assert.equal(stale.status, 409);
  await ws.request('PUT', url, { episodes: [{ episode_number: 1, expected: snapshot[0] }] });
  const adopted = (await ws.request('GET', base)).episodes;
  assert.equal(adopted[0].script_content, '纯文本单集拟稿');
  assert.deepEqual(adopted[0].storyboards, snapshot[0].storyboards);
  assert.deepEqual(adopted.slice(1), snapshot.slice(1));
  assert.deepEqual(await ws.request('GET', base + '/story-proposals'), []);
});

test('reports complete partial and failed coverage', async t => {
  const original = '雪'.repeat(1999) + '🌊' + '灯'.repeat(400) + '孩子推开门。';
  const text = ['第一章 暗灯', '灯灭。', '第二章 回信', original].join('\n');
  const calls = t.mock.method(ai, 'generateText', async (_db, _log, _service, prompt) => {
    if (prompt.includes('孩子推开门。')) throw Error('provider offline');
    return '改编成功';
  });
  const opts = { text, maxChapters: 1, startChapter: 2 };
  const parsed = await importNovel(null, console, opts);
  assert.equal(parsed.total, 2);
  assert.equal(parsed.chapters[0].index, 2);
  assert.equal(parsed.chapters[0].script, original);
  assert.equal(calls.mock.callCount(), 0);
  const short = await importNovel(null, console, { text, maxChapters: 1, aiSummarize: true });
  assert.equal(short.chapters[0].source.text, '灯灭。');
  assert.equal(short.chapters[0].script, '改编成功');
  const { chapters: [chapter] } = await importNovel(null, console, { ...opts, aiSummarize: true });
  const [first, last] = chapter.source.parts;
  assert.equal(first.start, 0);
  assert.equal(first.end, last.start);
  assert.equal(last.end, original.length);
  assert.equal(first.adaptation, '改编成功');
  assert.ok(last.error);
  assert.ok(original.slice(last.start).startsWith('🌊'));
  assert.equal(chapter.script, '改编成功\n\n' + original.slice(last.start));
  assert.ok(calls.mock.calls.at(-1).arguments[3].includes('孩子推开门。'));
  calls.mock.mockImplementation(async () => '  ');
  const fallback = await importNovel(null, console, { text: '灯灭。', aiSummarize: true });
  assert.equal(fallback.chapters[0].script, '灯灭。');
  assert.ok(fallback.chapters[0].source.parts[0].error);
});

test('preserves unselected episodes and their bindings', async t => {
  const db = new Database(':memory:');
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'novel-preview-'));
  t.after(() => { db.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  runMigrationsAndEnsure(db);
  const app = express();
  app.use(express.json(), setupRouter({ storage: { local_path: directory }, server: {} }, db, console));
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise(resolve => server.close(resolve)));
  const base = 'http://127.0.0.1:' + server.address().port;
  async function api(method, resource, data, status = 200) {
    const res = await fetch(base + resource, {
      method, body: JSON.stringify(data), headers: { 'Content-Type': 'application/json' },
    });
    const result = await res.json();
    assert.equal(res.status, status, JSON.stringify(result));
    return result.data;
  }
  const project = await api('POST', '/dramas', { title: '三集短剧' }, 201);
  const url = '/dramas/' + project.id;
  await api('PUT', url + '/episodes', { episodes: [1, 2, 3].map(i => ({
    episode_number: i, title: '标题' + i, script_content: '稿' + i, description: '已锁定',
  })) });
  const before = (await api('GET', url)).episodes;
  for (const ep of before) await api('POST', '/storyboards', { episode_id: ep.id, storyboard_number: 1, title: '已确认镜头' }, 201);
  const snapshot = (await api('GET', url)).episodes;
  const preview = await api('POST', '/dramas/import-novel', { text: '第一章\n保留。\n第二章\n改编。' });
  assert.deepEqual((await api('GET', url)).episodes, snapshot);
  const ch = preview.chapters[1];
  const row = { episode_number: 2, title: ch.title, script_content: ch.script, source: ch.source, expected: before[1] };
  const apply = (rows, status) => api('PUT', url + '/novel-episodes', { episodes: rows }, status);
  await apply([row]);
  await apply([row]);
  const after = (await api('GET', url)).episodes;
  assert.deepEqual([after[0], after[2]], [snapshot[0], snapshot[2]]);
  assert.equal(after[1].id, before[1].id);
  assert.deepEqual(after[1].storyboards, snapshot[1].storyboards);
  assert.equal(after[1].description, '已锁定');
  assert.equal(after[1].script_content, '改编。');
  assert.equal((await api('GET', url + '/episodes/' + after[1].id + '/novel-source')).text, '改编。');
  const fresh = { ...row, episode_number: 4, expected: null };
  await apply([fresh, { ...row, script_content: '迟到的改写' }], 409);
  await apply([fresh, fresh], 400);
  await apply([], 400);
  assert.deepEqual((await api('GET', url)).episodes, after);
  const archive = await fetch(base + url + '/export');
  const form = new FormData();
  form.append('file', await archive.blob(), 'project.zip');
  const imported = await (await fetch(base + '/dramas/import', { method: 'POST', body: form })).json();
  const restored = await api('GET', '/dramas/' + imported.data.drama_id);
  assert.deepEqual(await api('GET', '/dramas/' + restored.id + '/episodes/' + restored.episodes[1].id + '/novel-source'), ch.source);
  await api('GET', '/dramas/' + restored.id + '/episodes/' + after[1].id + '/novel-source', undefined, 404);
  const payload = { project: { title: '新作品' }, episodes: [fresh], operation_id: 'novel-test-operation-1' };
  const newProject = await api('POST', '/dramas/import-novel-project', payload, 201);
  const retried = await api('POST', '/dramas/import-novel-project', payload, 201);
  assert.equal(newProject.id, retried.id);
});
