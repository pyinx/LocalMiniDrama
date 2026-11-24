const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { openWorkbench } = require('./helpers/workbenchHttp');
const { exportDrama } = require('../src/services/dramaExportService');
const { importDrama } = require('../src/services/dramaImportService');

const noopLog = { info() {}, warn() {}, error() {}, debug() {}, errorw() {} };

const DEFAULTS = {
  resolution: '480p',
  subtitle: false,
  dialogue_burn: false,
  watermark: { enabled: false, text: '' },
  dialogue_subtitles: true,
  cards: true,
  bgm: { url: '', volume_db: -18 },
  review_sheets: true,
};

const NON_DEFAULTS = {
  resolution: '1080p',
  subtitle: true,
  dialogue_burn: true,
  watermark: { enabled: true, text: '示例水印' },
  dialogue_subtitles: false,
  cards: false,
  bgm: { url: '/static/bgm/a.mp3', volume_db: -24 },
  review_sheets: false,
};

/** 新建一部带两集的剧；返回剧 id 与各集 id（按集号） */
async function seedDrama(request, metadata = { aspect_ratio: '9:16' }) {
  const drama = await request('POST', '/dramas', { title: '设置测试', style: 'anime', metadata });
  await request('PUT', `/dramas/${drama.id}/episodes`, {
    episodes: [
      { episode_number: 1, title: '第1集', script_content: 'a' },
      { episode_number: 2, title: '第2集', script_content: 'b' },
    ],
  });
  return { dramaId: drama.id, ...(await readDrama(request, drama.id)) };
}

async function readDrama(request, dramaId) {
  const d = await request('GET', `/dramas/${dramaId}`);
  const byNumber = Object.fromEntries(d.episodes.map(e => [e.episode_number, e]));
  return { drama: d, ep1: byNumber[1], ep2: byNumber[2], ids: [byNumber[1]?.id, byNumber[2]?.id] };
}

/** 发请求并返回状态与响应体（不要求成功） */
async function raw(url, method, resource, body) {
  const res = await fetch(url(resource), { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  return { status: res.status, body: await res.json() };
}

describe('项目级视频设置', () => {
  it('项目设置写入后读回', async t => {
    const { request } = await openWorkbench(t);
    const { dramaId, drama } = await seedDrama(request);
    assert.deepEqual(drama.video_settings, DEFAULTS, '从未设置过的项目读回今天的默认值');

    const saved = await request('PUT', `/dramas/${dramaId}/video-settings`, NON_DEFAULTS);
    assert.deepEqual(saved, NON_DEFAULTS);
    const again = await readDrama(request, dramaId);
    assert.deepEqual(again.drama.video_settings, NON_DEFAULTS);
    assert.equal(again.drama.metadata.aspect_ratio, '9:16', '写设置不动画面比例');
    assert.equal(again.drama.style, 'anime');

    // 旧表单带着缓存的 metadata 提交大纲，不能把设置覆盖回去
    await request('PUT', `/dramas/${dramaId}/outline`, { metadata: { video_settings: { resolution: '720p' }, story_style: 'x' } });
    const afterOutline = await readDrama(request, dramaId);
    assert.deepEqual(afterOutline.drama.video_settings, NON_DEFAULTS);
    assert.equal(afterOutline.drama.metadata.story_style, 'x');

    // 新建项目时带 video_settings 也被丢弃
    const created = await request('POST', '/dramas', { title: '另一部', metadata: { video_settings: { resolution: '720p' } } });
    assert.equal((await request('GET', `/dramas/${created.id}`)).video_settings.resolution, '480p');
  });

  it('未覆盖的集跟随项目', async t => {
    const { request } = await openWorkbench(t);
    const { dramaId, drama } = await seedDrama(request);
    for (const ep of drama.episodes) {
      assert.deepEqual(ep.video_settings, { overrides: {}, effective: DEFAULTS });
    }
    await request('PUT', `/dramas/${dramaId}/video-settings`, { resolution: '720p', cards: false });
    for (const ep of (await readDrama(request, dramaId)).drama.episodes) {
      assert.deepEqual(ep.video_settings.overrides, {});
      assert.equal(ep.video_settings.effective.resolution, '720p');
      assert.equal(ep.video_settings.effective.cards, false);
    }
    await request('PUT', `/dramas/${dramaId}/video-settings`, { resolution: '1080p' });
    for (const ep of (await readDrama(request, dramaId)).drama.episodes) {
      assert.equal(ep.video_settings.effective.resolution, '1080p');
    }
  });

  it('分集覆盖只影响本集', async t => {
    const { request } = await openWorkbench(t);
    const { dramaId, ids: [e1, e2] } = await seedDrama(request);
    await request('PUT', `/dramas/${dramaId}/video-settings`, { subtitle: true });
    const watermark = { enabled: true, text: '第一集专用' };
    const result = await request('PUT', `/episodes/${e1}/video-settings`, { watermark });
    assert.deepEqual(result.overrides, { watermark });
    assert.deepEqual(result.effective, { ...DEFAULTS, subtitle: true, watermark });

    const after = await readDrama(request, dramaId);
    assert.deepEqual(after.ep1.video_settings.overrides, { watermark }, '只保存与项目不同的项');
    assert.deepEqual(after.ep2.video_settings, { overrides: {}, effective: { ...DEFAULTS, subtitle: true } });
    assert.deepEqual(after.drama.video_settings, { ...DEFAULTS, subtitle: true }, '项目默认不变');

    // 项目再改一项：未被覆盖的项仍跟随，被覆盖的项保持
    await request('PUT', `/dramas/${dramaId}/video-settings`, { resolution: '720p' });
    const later = await readDrama(request, dramaId);
    assert.equal(later.ep1.video_settings.effective.resolution, '720p');
    assert.deepEqual(later.ep1.video_settings.effective.watermark, watermark);
    assert.equal(e2, later.ep2.id);
  });

  it('清除覆盖后恢复跟随', async t => {
    const { request } = await openWorkbench(t);
    const { dramaId, ids: [e1] } = await seedDrama(request);
    await request('PUT', `/episodes/${e1}/video-settings`, { resolution: '1080p' });
    let state = (await readDrama(request, dramaId)).ep1.video_settings;
    assert.deepEqual(state.overrides, { resolution: '1080p' });

    const cleared = await request('PUT', `/episodes/${e1}/video-settings`, { resolution: null });
    assert.deepEqual(cleared.overrides, {});
    await request('PUT', `/dramas/${dramaId}/video-settings`, { resolution: '720p' });
    state = (await readDrama(request, dramaId)).ep1.video_settings;
    assert.equal(state.effective.resolution, '720p', '清除后继续跟随项目');

    // 重复清除不报错
    const twice = await request('PUT', `/episodes/${e1}/video-settings`, { resolution: null });
    assert.deepEqual(twice.overrides, {});

    // 改成与项目相同的值等于恢复，不留重复覆盖
    await request('PUT', `/episodes/${e1}/video-settings`, { resolution: '1080p' });
    const same = await request('PUT', `/episodes/${e1}/video-settings`, { resolution: '720p' });
    assert.deepEqual(same.overrides, {});
    await request('PUT', `/dramas/${dramaId}/video-settings`, { resolution: '480p' });
    assert.equal((await readDrama(request, dramaId)).ep1.video_settings.effective.resolution, '480p');

    // 水印整项比较：与项目相同的对象同样视为恢复
    await request('PUT', `/episodes/${e1}/video-settings`, { watermark: { enabled: true, text: 'x' } });
    const sameWm = await request('PUT', `/episodes/${e1}/video-settings`, { watermark: { text: '', enabled: false } });
    assert.deepEqual(sameWm.overrides, {});
  });

  it('分集不能改画面比例与风格', async t => {
    const { request, url } = await openWorkbench(t);
    const { dramaId, ids: [e1] } = await seedDrama(request);
    await request('PUT', `/episodes/${e1}/video-settings`, { cards: false });
    const before = await readDrama(request, dramaId);

    for (const patch of [{ aspect_ratio: '16:9' }, { style: 'realistic' }, { resolution: '720p', aspect_ratio: '1:1' }, { unknown: 1 }]) {
      const r = await raw(url, 'PUT', `/episodes/${e1}/video-settings`, patch);
      assert.equal(r.status, 400, JSON.stringify(patch));
      assert.equal(r.body.success, false);
    }
    // 项目接口同样不接受这两个键
    assert.equal((await raw(url, 'PUT', `/dramas/${dramaId}/video-settings`, { aspect_ratio: '16:9' })).status, 400);

    const after = await readDrama(request, dramaId);
    assert.deepEqual(after.ep1.video_settings, before.ep1.video_settings, '混合补丁整体拒绝，未部分写入');
    assert.equal(after.drama.metadata.aspect_ratio, '9:16');
    assert.equal(after.drama.style, 'anime');
    assert.deepEqual(after.drama.video_settings, before.drama.video_settings);
  });

  it('非法值被拒绝', async t => {
    const { request, url } = await openWorkbench(t);
    const { dramaId, ids: [e1] } = await seedDrama(request);
    await request('PUT', `/dramas/${dramaId}/video-settings`, NON_DEFAULTS);
    const before = await readDrama(request, dramaId);

    const invalid = [
      { resolution: '4k' },
      { resolution: 720 },
      { subtitle: 'yes' },
      { cards: 1 },
      { watermark: { enabled: true, text: 'x'.repeat(201) } },
      { watermark: { enabled: 'on', text: 'x' } },
      { watermark: 'text' },
      { bgm: { url: '/a.mp3', volume_db: -5 } },
      { bgm: { url: '/a.mp3', volume_db: -41 } },
      { bgm: { url: '/a.mp3', volume_db: 'loud' } },
      { bgm: { url: 123, volume_db: -18 } },
    ];
    for (const patch of invalid) {
      for (const resource of [`/dramas/${dramaId}/video-settings`, `/episodes/${e1}/video-settings`]) {
        const r = await raw(url, 'PUT', resource, patch);
        assert.equal(r.status, 400, resource + ' ' + JSON.stringify(patch));
      }
    }
    assert.equal((await raw(url, 'PUT', `/episodes/${e1}/video-settings`, [1])).status, 400, '补丁必须是对象');
    assert.equal((await raw(url, 'PUT', `/episodes/999999/video-settings`, { cards: false })).status, 404);
    assert.equal((await raw(url, 'PUT', `/dramas/999999/video-settings`, { cards: false })).status, 404);

    const after = await readDrama(request, dramaId);
    assert.deepEqual(after.drama.video_settings, before.drama.video_settings, '非法值不污染已存值');
    assert.deepEqual(after.ep1.video_settings, before.ep1.video_settings);

    // 边界值合法；水印开启但文字为空也合法（是否烧录由前端按文字决定）
    const ok = await request('PUT', `/episodes/${e1}/video-settings`, {
      watermark: { enabled: true, text: 'y'.repeat(200) },
      bgm: { url: '', volume_db: -40 },
    });
    assert.equal(ok.effective.watermark.text.length, 200);
    assert.equal(ok.effective.bgm.volume_db, -40);
    const empty = await request('PUT', `/episodes/${e1}/video-settings`, { watermark: { enabled: true, text: '' } });
    assert.deepEqual(empty.effective.watermark, { enabled: true, text: '' });
  });

  it('读取时丢弃库里的脏值', async t => {
    const { request, db } = await openWorkbench(t);
    const { dramaId, ids: [e1] } = await seedDrama(request);
    db.prepare('UPDATE episodes SET video_settings = ? WHERE id = ?').run(JSON.stringify({ resolution: '8k', cards: false, aspect_ratio: '1:1' }), e1);
    db.prepare('UPDATE dramas SET metadata = ? WHERE id = ?').run(JSON.stringify({ video_settings: { resolution: 'bad', subtitle: true } }), dramaId);
    const { drama, ep1 } = await readDrama(request, dramaId);
    assert.deepEqual(drama.video_settings, { ...DEFAULTS, subtitle: true });
    assert.deepEqual(ep1.video_settings.overrides, { cards: false });
    assert.equal(ep1.video_settings.effective.resolution, '480p');
  });

  it('保存剧本与导入导出保留设置', async t => {
    const { request, db, cfg } = await openWorkbench(t);
    const { dramaId, ids: [e1] } = await seedDrama(request);
    await request('PUT', `/dramas/${dramaId}/video-settings`, { resolution: '720p', subtitle: true });
    await request('PUT', `/episodes/${e1}/video-settings`, { watermark: { enabled: true, text: '本集' }, resolution: '1080p' });

    // 保存剧本（upsert 按集号保留 id）：改标题、新增第 3 集
    await request('PUT', `/dramas/${dramaId}/episodes`, {
      episodes: [
        { episode_number: 1, title: '改名后的第1集', script_content: 'a2' },
        { episode_number: 2, title: '第2集', script_content: 'b' },
        { episode_number: 3, title: '第3集', script_content: 'c' },
      ],
    });
    const saved = await readDrama(request, dramaId);
    const ep3 = saved.drama.episodes.find(e => e.episode_number === 3);
    assert.equal(saved.ep1.title, '改名后的第1集');
    assert.deepEqual(saved.ep1.video_settings.overrides, { watermark: { enabled: true, text: '本集' }, resolution: '1080p' }, '保存剧本后覆盖仍在');
    assert.deepEqual(ep3.video_settings.overrides, {}, '新增的集没有覆盖，跟随项目');
    assert.equal(ep3.video_settings.effective.resolution, '720p');

    // 整剧导出再导入
    const { buffer } = exportDrama(db, cfg, noopLog, dramaId);
    const imported = importDrama(db, cfg, noopLog, buffer);
    const copy = await readDrama(request, imported.drama_id);
    assert.deepEqual(copy.drama.video_settings, saved.drama.video_settings);
    assert.deepEqual(copy.ep1.video_settings, saved.ep1.video_settings);
    assert.deepEqual(copy.ep2.video_settings.overrides, {});
    assert.notEqual(copy.ep1.id, saved.ep1.id);

    // 老导出文件没有该字段：导入后跟随项目
    const AdmZip = require('adm-zip');
    const zip = new AdmZip(buffer);
    const project = JSON.parse(zip.readAsText('project.json'));
    for (const ep of project.episodes) delete ep.video_settings;
    zip.updateFile('project.json', Buffer.from(JSON.stringify(project)));
    const legacy = await readDrama(request, importDrama(db, cfg, noopLog, zip.toBuffer()).drama_id);
    assert.deepEqual(legacy.ep1.video_settings.overrides, {});
    assert.equal(legacy.ep1.video_settings.effective.resolution, '720p');
  });
});
