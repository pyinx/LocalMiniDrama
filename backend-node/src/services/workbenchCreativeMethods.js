'use strict';

const catalog = require('../../skills/short-drama/references/creative-methods.json');
const { parseDramaMetadata, styleFieldsFromDramaRow } = require('../utils/dramaStyleMerge');
const { parseDramaCharacterIds } = require('./storyboardService');

function directionOf(drama) {
  const stored = parseDramaMetadata(drama)?.creative_direction || {};
  return {
    enabled: stored.enabled === true,
    facts: typeof stored.facts === 'string' ? stored.facts : '',
    revision: Number(stored.revision) || 0,
  };
}

function styleAdvice(drama) {
  const { zh, en, legacy } = styleFieldsFromDramaRow(drama);
  const family = require('../constants/generationStylePresets').presetFamily(legacy);
  if (family && catalog.styles[family]) return catalog.styles[family];
  const style = zh || en || legacy;
  if (/动画|漫画|卡通|线稿|anime|cartoon|cel.shad|2d animation/i.test(style)) return catalog.styles.drawn;
  if (/写实|实拍|纪录|真人|photoreal|realistic|documentary/i.test(style)) return catalog.styles.live;
  return catalog.styles.other;
}

function characterIds(raw) {
  return [...new Set((parseDramaCharacterIds(raw) || []).filter(id => Number.isSafeInteger(id) && id > 0))];
}

function projectCast(db, dramaId, shotId) {
  const characters = new Map(db.prepare(`SELECT id, name, appearance, stages, local_path, image_url
    FROM characters WHERE drama_id=? AND deleted_at IS NULL`).all(dramaId).map(row => [row.id, row]));
  const libraryCast = new Map();
  const rows = db.prepare(`SELECT DISTINCT s.id AS storyboard_id, c.id, c.name, c.appearance, c.description,
      c.local_path, c.image_url, c.four_view_image_url
    FROM storyboard_characters sc JOIN character_libraries c ON c.id=sc.character_id
    JOIN storyboards s ON s.id=sc.storyboard_id JOIN episodes e ON e.id=s.episode_id
    WHERE e.drama_id=? AND e.deleted_at IS NULL AND s.deleted_at IS NULL AND c.deleted_at IS NULL
      AND (c.drama_id=e.drama_id OR c.drama_id IS NULL) AND TRIM(COALESCE(s.characters,''))=''
      ${shotId == null ? '' : 'AND s.id=?'} ORDER BY c.id`).all(...(shotId == null ? [dramaId] : [dramaId, shotId]));
  for (const row of rows) {
    if (!libraryCast.has(row.storyboard_id)) libraryCast.set(row.storyboard_id, []);
    libraryCast.get(row.storyboard_id).push(row);
  }
  return { characters, libraryCast };
}

function effectiveCast(shot, assets) {
  // Explicit project cast (including []) supersedes the legacy library IDs.
  if (Array.isArray(shot.characters) || String(shot.characters ?? '').trim()) {
    return characterIds(shot.characters).map(id => assets.characters.get(id)).filter(Boolean);
  }
  return assets.libraryCast.get(shot.id) || [];
}

function scenarioFor(shot, choice, castSize = characterIds(shot.characters).length) {
  if (Object.hasOwn(catalog.scenarios, choice)) return choice;
  if (castSize >= 3) return 'ensemble';
  const dialogue = String(shot.dialogue || '').trim();
  if (dialogue && !/^[（(]?(无|无对白|无台词|无对话|none|no dialogue)[）)。.!！]?$/i.test(dialogue)) return 'dialogue';
  if (/停顿|静候|等待|凝视|屏息|伫立|静默|沉默|pause|wait|stillness/i.test([shot.action, shot.description].join(' '))) return 'pause';
  return 'action';
}

function readLock(raw) {
  if (!raw) return {};
  return typeof raw === 'string' ? JSON.parse(raw) : raw;
}

function creativeGuidance(drama, task, shot, castSize, projectStyle = drama) {
  const setting = directionOf(drama);
  if (!Object.hasOwn(catalog.tasks, task)) throw new Error('未知创作任务');
  if (!setting.enabled) return { version: catalog.version, advice: [], checks: [] };
  const lock = readLock(shot?.creative_review_lock);
  const advice = [catalog.tasks[task]];
  if (task !== 'story') advice.push(styleAdvice(projectStyle));
  const checks = [];
  if (['story', 'storyboard', 'frame', 'video'].includes(task)) {
    if (shot) {
      const scenario = catalog.scenarios[scenarioFor(shot, lock.method, castSize)];
      advice.push(scenario.direction);
      checks.push(scenario.check);
    } else {
      for (const item of Object.values(catalog.scenarios)) {
        advice.push('仅在' + item.label + '场面：' + item.direction);
      }
    }
  }
  if (setting.facts && ['story', 'storyboard', 'video', 'frame'].includes(task)) {
    advice.push('作者锁定的故事事实，仅在相关场面体现：' + setting.facts);
  }
  return { version: catalog.version, advice, checks };
}

function withCreativeGuidance(db, prompt, dramaId, task, storyboardId, projectStyle) {
  if (!Number(dramaId) || !task) return prompt;
  const drama = db.prepare('SELECT style, metadata FROM dramas WHERE id = ? AND deleted_at IS NULL').get(Number(dramaId));
  if (!drama || !directionOf(drama).enabled) return prompt;
  let shot;
  let castSize;
  if (storyboardId) {
    shot = db.prepare(`SELECT s.* FROM storyboards s JOIN episodes e ON e.id = s.episode_id
      WHERE s.id = ? AND e.drama_id = ? AND e.deleted_at IS NULL AND s.deleted_at IS NULL`).get(Number(storyboardId), Number(dramaId));
    if (!shot) throw new Error('分镜不属于当前作品');
    // For new IR shots the segment compiler owns the complete outgoing text.
    // Their director guidance belongs upstream, at storyboard planning.
    if (task === 'video' && shot.segment_ir) return prompt;
    castSize = effectiveCast(shot, projectCast(db, dramaId, shot.id)).length;
  }
  const { version, advice } = creativeGuidance(drama, task, shot, castSize, projectStyle);
  return [prompt, '创作参考 v' + version + '（以作者要求为准）', ...advice].filter(Boolean).join('\n');
}

module.exports = { catalog, directionOf, creativeGuidance, withCreativeGuidance, projectCast, effectiveCast, scenarioFor, readLock };
