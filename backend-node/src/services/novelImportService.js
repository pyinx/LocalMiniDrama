const aiClient = require('./aiClient');

const PART_LIMIT = 2000;
const heading = /^第\s*[〇零一二两三四五六七八九十百千万\d０-９]+\s*[章节集回]/u;
const bracketHeading = /^[【《<＜［\[]\s*(第\s*[〇零一二两三四五六七八九十百千万\d０-９]+\s*[章节集回])\s*[】》>＞］\]]?\s*(.*)$/u;

function detectChaptersByRules(text) {
  const chapters = [];
  let title = '序章';
  let lines = [];
  function finish() {
    const content = lines.join('\n').trim();
    if (content) chapters.push({ title, content });
    lines = [];
  }
  for (const line of text.split(/\r?\n/)) {
    const clean = line.trim();
    const wrapped = clean.match(bracketHeading);
    if (wrapped || heading.test(clean) || /^Chapter\s+\d+/i.test(clean) ||
        /^\d+[.、]\s*.{2,20}$/u.test(clean) || /^(?:【.{1,30}】|「.{1,30}」)$/u.test(clean)) {
      finish();
      title = wrapped ? wrapped[1] : clean;
      // 已定稿分集文本可将标题与正文写在同一行。
      const episode = (wrapped ? wrapped[1] + wrapped[2] : clean).match(/^(第\s*[〇零一二两三四五六七八九十百千万\d０-９]+\s*集)\s*(.*)$/u);
      if (episode) {
        title = episode[1];
        if (episode[2]) lines.push(episode[2]);
      } else if (wrapped && wrapped[2]) {
        lines.push(wrapped[2]);
      }
    } else {
      lines.push(line);
    }
  }
  finish();
  return chapters;
}

function chapterParts(text) {
  const parts = [];
  let start = 0;
  while (start < text.length) {
    let end = Math.min(start + PART_LIMIT, text.length);
    if (end < text.length) {
      const slice = text.slice(start, end);
      const boundary = Math.max(...['\n', '。', '！', '？'].map(mark => slice.lastIndexOf(mark)));
      if (boundary >= PART_LIMIT / 2) end = start + boundary + 1;
      else if (/[\uD800-\uDBFF]/.test(text[end - 1])) end--;
    }
    parts.push({ start, end });
    start = end;
  }
  return parts;
}

async function adaptPart(db, log, { text, title, chapter_title, previous }) {
  if (typeof text !== 'string' || !text.trim() || text.length > PART_LIMIT) {
    throw Object.assign(new Error('请选择一个完整的原文分段'), { status: 400 });
  }
  const continuation = previous ? '\n前段剧本结尾（只用于衔接）：' + String(previous).slice(-280) : '';
  const prompt = [
    '小说：' + (title || '未命名'), '章节：' + chapter_title + continuation,
    '待改编原文：', text,
    '把本段改写成可拍摄的中文短剧。保留人物、因果、关键对白和段尾状态。用可见的行为表现转折。只输出本段剧本，不续写后文。',
  ].join('\n');
  const result = await aiClient.generateText(db, log, 'text', prompt, null, {
    scene_key: 'novel_import', max_tokens: 1200, temperature: 0.7,
  });
  if (typeof result !== 'string' || !result.trim()) throw new Error('模型未返回本段剧本');
  return result.trim();
}

async function importNovel(db, log, { text, title, maxChapters = 20, startChapter = 1, aiSummarize }) {
  if (typeof text !== 'string' || !text.trim()) throw Object.assign(new Error('小说内容不能为空'), { status: 400 });
  if (!Number.isSafeInteger(maxChapters) || maxChapters < 1) {
    throw Object.assign(new Error('章节数必须是正整数'), { status: 400 });
  }
  const chapters = detectChaptersByRules(text);
  if (!chapters.length) chapters.push({ title: title || '第一集', content: text.trim() });
  else if (chapters.length === 1 && chapters[0].title === '序章') chapters[0].title = title || '第一集';
  if (!Number.isSafeInteger(startChapter) || startChapter < 1 || startChapter > chapters.length) {
    throw Object.assign(new Error('起始章节超出范围，共 ' + chapters.length + ' 章'), { status: 400 });
  }
  const result = [];
  for (const ch of chapters.slice(startChapter - 1, startChapter - 1 + maxChapters)) {
    const parts = chapterParts(ch.content);
    if (aiSummarize) {
      let previous = '';
      for (const part of parts) {
        try {
          part.adaptation = await adaptPart(db, log, {
            title, chapter_title: ch.title, text: ch.content.slice(part.start, part.end), previous,
          });
          previous = part.adaptation;
        } catch (error) {
          log.warn('[小说导入] 本段保留原文', { chapter: ch.title, start: part.start, error: error.message });
          part.error = '改编失败，保留此段原文';
          previous = '';
        }
      }
    }
    result.push({
      index: startChapter + result.length, title: ch.title, content: ch.content.slice(0, 300),
      script: parts.some(p => p.adaptation) ? parts.map(p => p.adaptation || ch.content.slice(p.start, p.end)).join('\n\n') : ch.content,
      source: { text: ch.content, parts },
    });
  }
  return { chapters: result, total: chapters.length };
}

function novelSourceJson(source) {
  const invalid = message => Object.assign(new Error(message), { status: 400 });
  if (typeof source?.text !== 'string' || !source.text.trim() || !Array.isArray(source.parts)) throw invalid('缺少章节原文');
  const parts = chapterParts(source.text);
  if (parts.length !== source.parts.length) throw invalid('原文分段有变化，请重新预览');
  for (const [i, part] of parts.entries()) {
    const input = source.parts[i];
    if (input?.start !== part.start || input.end !== part.end) throw invalid('原文范围不完整');
    if (typeof input.adaptation === 'string' && input.adaptation.trim()) part.adaptation = input.adaptation.trim();
    else if (input.error) part.error = '改编失败，保留此段原文';
  }
  return JSON.stringify({ text: source.text, parts });
}

// 对照作者在预览时看到的正文。只更新本次采用的集，保留分镜、成片、描述及时长。
function applySelectedEpisodes(db, dramaId, rows, sourceFor = (_row, current) => current?.novel_source ?? null) {
  const invalid = message => Object.assign(new Error(message), { status: 400 });
  const conflict = number => Object.assign(new Error('第' + number + '集在预览后有变化，请重新核对'), { status: 409 });
  if (!Array.isArray(rows) || !rows.length) throw invalid('请至少选择一集');
  const numbers = new Set();
  const select = db.prepare('SELECT id,title,script_content,novel_source,updated_at FROM episodes WHERE drama_id=? AND episode_number=? AND deleted_at IS NULL ORDER BY id');
  return db.transaction(() => {
    if (!db.prepare('SELECT id FROM dramas WHERE id=? AND deleted_at IS NULL').get(dramaId)) {
      throw Object.assign(new Error('项目不存在'), { status: 404 });
    }
    const now = new Date().toISOString();
    for (const row of rows) {
      const n = row?.episode_number;
      if (!Number.isSafeInteger(n) || n < 1 || numbers.has(n)) throw invalid('目标集号无效或重复');
      numbers.add(n);
      if (typeof row.title !== 'string' || !row.title.trim() || typeof row.script_content !== 'string' ||
          !row.script_content.trim() || !Object.hasOwn(row, 'expected')) throw invalid('缺少集标题、正文或预览信息');
      const matches = select.all(dramaId, n);
      if (matches.length > 1) throw conflict(n);
      const current = matches[0];
      const sourceJson = sourceFor(row, current);
      if (current && current.title === row.title && current.script_content === row.script_content && current.novel_source === sourceJson) continue;
      if (current) {
        const expected = row.expected;
        if (current.id !== expected?.id || current.title !== expected.title ||
            current.script_content !== expected.script_content || current.updated_at !== expected.updated_at) throw conflict(n);
        db.prepare('UPDATE episodes SET title=?,script_content=?,novel_source=?,updated_at=? WHERE id=?')
          .run(row.title, row.script_content, sourceJson, now, current.id);
      } else {
        if (row.expected !== null) throw conflict(n);
        db.prepare("INSERT INTO episodes(drama_id,episode_number,title,script_content,novel_source,status,created_at,updated_at) VALUES(?,?,?,?,?,'draft',?,?)")
          .run(dramaId, n, row.title, row.script_content, sourceJson, now, now);
      }
    }
    db.prepare('UPDATE dramas SET updated_at=? WHERE id=?').run(now, dramaId);
    return { episode_numbers: [...numbers] };
  }).immediate();
}

function applyNovelEpisodes(db, dramaId, rows) {
  return applySelectedEpisodes(db, dramaId, rows, row => novelSourceJson(row.source));
}

module.exports = { importNovel, detectChaptersByRules, adaptPart, applyNovelEpisodes, applySelectedEpisodes };
