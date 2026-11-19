const aiClient = require('./aiClient');

const PART_LIMIT = 2000;
const heading = /^第\s*([〇零一二两三四五六七八九十百千万\d０-９]+)\s*([章节集回])/u;
const brackets = { '【': '】', '《': '》', '<': '>', '＜': '＞', '［': '］', '[': ']', '「': '」' };

function episodeNumber(token) {
  const normalized = token.normalize('NFKC').replace(/〇/g, '零').replace(/两/g, '二');
  const digits = '零一二三四五六七八九';
  const units = { 十: 10, 百: 100, 千: 1000, 万: 10000 };
  let number;
  if (/^\d+$/.test(normalized)) number = Number(normalized);
  else if (/^[零一二三四五六七八九]+$/.test(normalized)) {
    number = Number(Array.from(normalized, c => digits.indexOf(c)).join(''));
  } else {
    let total = 0, group = 0, digit = 0;
    for (const c of normalized) {
      if (digits.includes(c)) digit = digits.indexOf(c);
      else if (c === '万') { total += (group + digit) * units[c]; group = digit = 0; }
      else if (units[c]) { group += (digit || 1) * units[c]; digit = 0; }
      else return null;
    }
    number = total + group + digit;
  }
  return Number.isSafeInteger(number) && number > 0 ? number : null;
}

function detectChaptersByRules(text) {
  const chapters = [];
  let title = '序章';
  let episode = null;
  let lines = [];
  function finish() {
    const content = lines.join('\n').trim();
    if (content) chapters.push({ title, content, ...(episode && { episode_number: episode }) });
    lines = [];
  }
  for (const line of text.split(/\r?\n/)) {
    const clean = line.trim();
    const close = brackets[clean[0]];
    const end = close ? clean.indexOf(close, 1) : -1;
    const inside = end > 0 ? clean.slice(1, end).trim() : '';
    const wrapped = heading.test(inside);
    const numbered = (wrapped ? inside : clean).match(heading);
    if (numbered || /^Chapter\s+\d+/i.test(clean) ||
        /^\d+[.、]\s*.{2,20}$/u.test(clean) || /^(?:【.{1,30}】|「.{1,30}」)$/u.test(clean)) {
      finish();
      episode = numbered?.[2] === '集' ? episodeNumber(numbered[1]) : null;
      title = wrapped ? inside : clean;
      // 括号里的副标题属于标题，闭括号之后才是同一行正文。
      if (wrapped || numbered?.[2] === '集') {
        if (!wrapped) title = numbered[0];
        const firstLine = clean.slice(wrapped ? end + 1 : title.length).trim();
        if (firstLine) lines.push(firstLine);
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

function readChapters(text, title) {
  if (typeof text !== 'string' || !text.trim()) throw Object.assign(new Error('小说内容不能为空'), { status: 400 });
  const chapters = detectChaptersByRules(text);
  if (!chapters.length) chapters.push({ title: title || '第一集', content: text.trim() });
  else if (chapters.length === 1 && chapters[0].title === '序章') chapters[0].title = title || '第一集';
  return chapters;
}

function scriptFromSource({ text, parts }) {
  return parts.some(p => p.adaptation) ? parts.map(p => p.adaptation || text.slice(p.start, p.end)).join('\n\n') : text;
}

async function importNovel(db, log, { text, title, maxChapters = 20, startChapter = 1, aiSummarize, compact = false }) {
  if (!Number.isSafeInteger(maxChapters) || maxChapters < 1) {
    throw Object.assign(new Error('章节数必须是正整数'), { status: 400 });
  }
  const chapters = readChapters(text, title);
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
    const source = { text: ch.content, parts };
    result.push({
      index: startChapter + result.length, title: ch.title, content: ch.content.slice(0, 300),
      ...(ch.episode_number && { episode_number: ch.episode_number }),
      ...(!compact && { script: scriptFromSource(source) }), source,
    });
  }
  return { chapters: result, total: chapters.length };
}

function normalizeNovelSource(source) {
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
  return { text: source.text, parts };
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
  const prepared = Array.isArray(rows) ? rows.map(row => {
    const source = normalizeNovelSource(row?.source);
    const script = Object.hasOwn(row, 'script_content') ? row.script_content : scriptFromSource(source);
    return { ...row, script_content: script, source };
  }) : rows;
  return applySelectedEpisodes(db, dramaId, prepared, row => JSON.stringify(row.source));
}

// 采用时重新划分预览用的同一份文件。请求只携带目标、原文范围和改编结果。
function episodesFromFile(text, selection) {
  const chapters = readChapters(text, selection?.title);
  if (!Array.isArray(selection?.episodes) || !selection.episodes.length) {
    throw Object.assign(new Error('请至少选择一集'), { status: 400 });
  }
  return selection.episodes.map(row => {
    const chapter = Number.isSafeInteger(row?.index) && chapters[row.index - 1];
    if (!chapter) throw Object.assign(new Error('未找到预览章节，请重新预览'), { status: 400 });
    const expected = row.expected?.script_is_source ? { ...row.expected, script_content: chapter.content } : row.expected;
    return { episode_number: row.episode_number, title: chapter.title, expected,
      source: { text: chapter.content, parts: row.parts } };
  });
}

module.exports = { importNovel, detectChaptersByRules, adaptPart, applyNovelEpisodes, applySelectedEpisodes, episodesFromFile };
