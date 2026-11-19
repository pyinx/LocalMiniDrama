'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  mergeCfgStyleWithDrama,
  resolvedStreamStyleFromDrama,
} = require('../src/utils/dramaStyleMerge');

test('merge ignores bare custom without metadata prompts', () => {
  const cfg = mergeCfgStyleWithDrama({ style: {} }, { style: 'custom', metadata: {} });
  assert.notEqual(cfg.style?.default_style, 'custom');
  assert.notEqual(cfg.style?.default_style_zh, 'custom');
  assert.notEqual(cfg.style?.default_style_en, 'custom');
});

test('merge uses metadata when style is custom', () => {
  const desc = '赛博朋克水墨';
  const cfg = mergeCfgStyleWithDrama(
    { style: {} },
    { style: 'custom', metadata: { style_prompt_zh: desc, style_prompt_en: desc } },
  );
  assert.equal(cfg.style.default_style_zh, desc);
  assert.equal(cfg.style.default_style_en, desc);
});

test('resolvedStreamStyleFromDrama skips bare custom', () => {
  assert.equal(resolvedStreamStyleFromDrama('custom', null), 'realistic');
  assert.equal(resolvedStreamStyleFromDrama('', { style: 'custom', metadata: {} }), 'realistic');
  assert.equal(
    resolvedStreamStyleFromDrama('', {
      style: 'custom',
      metadata: { style_prompt_en: 'ink neon' },
    }),
    'ink neon',
  );
});

test('legacy and saved snapshots survive catalog expansion', () => {
  const row = {style: 'retro film', metadata: JSON.stringify({style_prompt_zh:'作者原来的描述',style_prompt_en:'author snapshot'})};
  assert.equal(mergeCfgStyleWithDrama({}, row).style.default_style_en,'author snapshot');
  assert.match(mergeCfgStyleWithDrama({}, {style:'retro film'}).style.default_style_zh,/胶片/);
  assert.equal(resolvedStreamStyleFromDrama(null,{style:'自由文本'}),'自由文本');
});

test('custom style examples persist and legacy text can be completed', async t => {
  const {openWorkbench} = require('./helpers/workbenchHttp');
  const ws = await openWorkbench(t);
  const {id} = await ws.request('POST','/dramas',{title:'旧项目',style:'custom',metadata:{style_prompt_zh:'水彩纸'}});
  await ws.request('PUT','/dramas/'+id+'/outline',{summary:'其他修改'});
  const old = await ws.request('GET','/dramas/'+id);
  assert.equal(old.metadata.style_prompt_zh,'水彩纸');
  const library = require('../src/services/customStyleLibrary');
  const sample = require('node:fs').readFileSync(require.resolve('../../frontweb/public/style-thumbs/clay-stop-motion.webp'));
  const snapshot = {id:require('crypto').randomUUID(), version:1, name:'水彩纸', negative:'油光', image:library.storeImage(ws.db,sample)};
  await ws.request('PUT','/dramas/'+id+'/outline',{style:'custom',metadata:{custom_style:snapshot,style_prompt_zh:'水彩纸'}});
  const saved = await ws.request('GET','/dramas/'+id);
  assert.deepEqual(saved.metadata.custom_style,snapshot);
  assert.equal(mergeCfgStyleWithDrama({},saved).style.default_style_zh,'水彩纸');
});
