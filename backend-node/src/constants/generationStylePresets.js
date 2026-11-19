'use strict';

const groups = require('./styleCatalog.json');
const byValue = new Map(groups.flatMap(group => group.options.map(option => [option.value, option])));

function resolveStylePreset(value) {
  const option = byValue.get(String(value ?? '').trim());
  return option ? { zh: option.prompt, en: option.promptEn } : null;
}

function presetFamily(value) {
  return byValue.get(value)?.family;
}

module.exports = { resolveStylePreset, presetFamily, PRESET_VALUES: [...byValue.keys()] };
