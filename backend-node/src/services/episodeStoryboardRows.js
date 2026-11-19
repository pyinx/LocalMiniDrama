function normalizeStoryboardShotNumber(rawOrSb) {
  const raw = rawOrSb != null && typeof rawOrSb === 'object'
    ? rawOrSb.shot_number ?? rawOrSb.storyboard_number : rawOrSb;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

// Historical streaming saves can have several rows for a single positive shot number.
function dedupeStoryboardRowsByNumber(rows) {
  const byNum = new Map();
  const extras = [];
  for (const row of rows || []) {
    const number = normalizeStoryboardShotNumber(row.storyboard_number ?? row);
    if (number > 0) {
      const prev = byNum.get(number);
      if (!prev || Number(row.id) > Number(prev.id)) byNum.set(number, row);
    } else extras.push(row);
  }
  return [...byNum.values(), ...extras].sort((a, b) =>
    normalizeStoryboardShotNumber(a.storyboard_number) - normalizeStoryboardShotNumber(b.storyboard_number)
    || Number(a.id) - Number(b.id));
}

function episodeStoryboardRows(db, episodeId) {
  return dedupeStoryboardRowsByNumber(db.prepare(
    'SELECT * FROM storyboards WHERE episode_id = ? AND deleted_at IS NULL ORDER BY storyboard_number, id'
  ).all(episodeId));
}

module.exports = { normalizeStoryboardShotNumber, dedupeStoryboardRowsByNumber, episodeStoryboardRows };
