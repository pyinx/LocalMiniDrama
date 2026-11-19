const fs = require('fs');
const { createHash } = require('crypto');
const { localFile } = require('./workbenchTakeService');

function mediaDigest(file) {
  const hash = createHash('sha256');
  const chunk = Buffer.allocUnsafe(256 * 1024);
  const fd = fs.openSync(file, 'r');
  try {
    let length;
    while ((length = fs.readSync(fd, chunk, 0, chunk.length)) > 0) hash.update(chunk.subarray(0, length));
    return hash.digest('hex');
  } finally { fs.closeSync(fd); }
}

function selectSound(source, relative, root) {
  if (source === 'auto' || source === null) return null;
  if (source === 'original' || source === 'mute') return JSON.stringify({ source });
  const file = source === 'dub' && localFile(root, relative);
  if (!file) throw Object.assign(new Error('请选择本镜已有的对白配音'), { status: 400 });
  return JSON.stringify({ source, path: relative, sha256: mediaDigest(file) });
}

function soundOf(row) {
  return row.adopted_sound ? JSON.parse(row.adopted_sound) : null;
}

function soundSnapshot(row, options, root) {
  const selected = soundOf(row);
  const dub = selected ? selected.source === 'dub' && selected.path : options.burn_dialogue_audio && row.audio_local_path;
  function digest(relative) {
    const file = localFile(root, relative);
    return file ? mediaDigest(file) : null;
  }
  return {
    selected, dialogue: row.dialogue, narration: row.narration,
    audio_local_path: row.audio_local_path, narration_audio_local_path: row.narration_audio_local_path,
    dub_digest: dub ? digest(dub) : null,
    narration_digest: options.burn_narration_subtitles ? digest(row.narration_audio_local_path) : null,
  };
}

module.exports = { selectSound, soundOf, soundSnapshot, mediaDigest };
