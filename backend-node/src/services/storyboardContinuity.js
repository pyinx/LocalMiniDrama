const fs = require('node:fs');
const path = require('node:path');

const beatContinuity = fs.readFileSync(path.join(__dirname, '../../skills/short-drama/references/beat-continuity.md'), 'utf8').trim();

// 成功仍走原有的纯文本协议。仅在单镜生成/润色需要作者裁决时返回冲突。
const conflictFormat = '只有当来源实质矛盾、无法在保留作者意图的前提下完成本次修改时，改为只输出 JSON 对象 {"storyboard_conflict":{"beat":"节拍位置","source":"来源原句","candidate":"冲突原句","reason":"差异及影响"}}。其余情况按要求输出成稿。';

function draftConflict(raw) {
  const text = String(raw ?? '').trim().replace(/^```(?:json)?\s*|\s*```$/gi, '');
  if (!/^\s*\{/.test(text)) return null;
  let detail;
  try { detail = JSON.parse(text).storyboard_conflict; } catch (_) {}
  if (!detail || !['beat', 'source', 'candidate', 'reason'].every(k => typeof detail[k] === 'string' && detail[k].trim())) {
    return { code: 'invalid_storyboard_response', message: '模型返回的分镜格式不完整，当前稿已保留' };
  }
  return { code: 'storyboard_conflict', message: `${detail.beat}：来源「${detail.source}」与「${detail.candidate}」有分歧。${detail.reason}`, detail };
}

module.exports = { beatContinuity, conflictFormat, draftConflict };
