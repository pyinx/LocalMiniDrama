// Offline paired trials. Only the two reviewer directories are shared with reviewers.
const fs = require('node:fs');
const path = require('node:path');
const { createHash, randomInt, randomUUID } = require('node:crypto');
const { execFileSync } = require('node:child_process');

const arms = ['baseline', 'method'];
const dimensions = ['画风', '表演', '视线', '动作衔接', '身份', '对白时机'];
const costTypes = ['image', 'review', 'video'];
const read = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));
const write = (file, data) => fs.writeFileSync(file, JSON.stringify(data, null, 2) + '\n', { flag: 'wx' });
const hash = (value) => createHash('sha256').update(value).digest('hex');
const nonnegative = (n) => typeof n === 'number' && Number.isFinite(n) && n >= 0;
const present = (value) => typeof value === 'string' && !!value.trim();

function emptyArm() {
  return { attempts: [], final: null, costs: { image: null, review: null, video: null }, repairMinutes: null };
}

function template() {
  return {
    currency: 'CNY',
    method: '',
    reviewers: ['', ''],
    pairs: [
      {
        id: 'P001',
        work: '',
        episode: '',
        scene: '',
        segment: '',
        brief: '',
        dimensions: [...dimensions],
        controls: {
          scriptVersion: '',
          references: [],
          modelVersion: '',
          aspect: '',
          targetSeconds: null,
          seed: null,
        },
        baseline: emptyArm(),
        method: emptyArm(),
      },
    ],
  };
}

function load(file) {
  const study = read(file);
  if (!Array.isArray(study.pairs) || !present(study.currency))
    throw new Error('清单需要 pairs 数组及统一币种 currency');
  const ids = new Set();
  const locations = new Set();
  for (const p of study.pairs) {
    if (!present(p.id) || ids.has(p.id)) throw new Error('每个配对需要唯一 id');
    ids.add(p.id);
    const location = JSON.stringify([p.work, p.episode, p.scene, p.segment]);
    if ([p.work, p.episode, p.scene, p.segment].every(present) && locations.has(location)) {
      throw new Error(p.id + ' 与另一配对重复登记同一作品、集、场景与段');
    }
    locations.add(location);
    if (
      !Array.isArray(p.dimensions) ||
      !p.dimensions.length ||
      new Set(p.dimensions).size !== p.dimensions.length ||
      p.dimensions.some((d) => !dimensions.includes(d))
    )
      throw new Error(p.id + ' 的评审维度无效');
    for (const arm of arms) {
      const r = p[arm];
      if (
        !r ||
        !Array.isArray(r.attempts) ||
        r.attempts.some((a) => !a || !['usable', 'rejected', 'failed'].includes(a.outcome))
      ) {
        throw new Error(p.id + ' 每次视频提交都需登记 usable、rejected 或 failed');
      }
      if (
        r.final != null &&
        r.final !== 'discarded' &&
        (!Number.isInteger(r.final) || r.final < 1 || r.attempts[r.final - 1]?.outcome !== 'usable')
      )
        throw new Error(p.id + ' 的最终采用序号无效');
      if (r.final === 'discarded' && !r.attempts.length) throw new Error(p.id + ' 放弃试拍段须登记实际提交');
      for (const n of [...costTypes.map((k) => r.costs?.[k]), r.repairMinutes]) {
        if (n != null && !nonnegative(n)) throw new Error(p.id + ' 的费用或工时无效');
      }
    }
  }
  return study;
}

function design(study) {
  return {
    method: study.method,
    currency: study.currency,
    reviewers: study.reviewers,
    pairs: study.pairs.map(({ baseline, method, ...conditions }) => conditions),
  };
}

function register(file) {
  const study = load(file);
  if (!study.pairs.length || study.pairs.some((p) => setupIssues(study, p).length))
    throw new Error('请先填写作品、同条件及两位评审');
  if (
    study.pairs.some((p) =>
      arms.some(
        (a) =>
          p[a].attempts.length ||
          p[a].final != null ||
          costTypes.some((k) => p[a].costs?.[k] > 0) ||
          p[a].repairMinutes > 0,
      ),
    )
  )
    throw new Error('请在实际提交、费用或返修发生前登记对照条件');
  const registered = file + '.plan.json';
  write(registered, { registeredAt: new Date().toISOString(), design: design(study) });
  return { registered };
}

function registered(file, study) {
  return (
    fs.existsSync(file + '.plan.json') &&
    JSON.stringify(read(file + '.plan.json').design) === JSON.stringify(design(study))
  );
}

function mediaHash(file) {
  const digest = createHash('sha256'),
    buf = Buffer.alloc(65536),
    fd = fs.openSync(file, 'r');
  try {
    let n;
    while ((n = fs.readSync(fd, buf, 0, buf.length, null)) > 0) digest.update(buf.subarray(0, n));
    return digest.digest('hex');
  } finally {
    fs.closeSync(fd);
  }
}

function setupIssues(study, pair) {
  const c = pair.controls || {};
  const issues = [];
  if (
    !present(study.method) ||
    ![pair.work, pair.episode, pair.scene, pair.segment, c.scriptVersion, c.modelVersion, c.aspect].every(
      present,
    ) ||
    !Array.isArray(c.references) ||
    !c.references.every(present) ||
    !nonnegative(c.targetSeconds) ||
    !c.targetSeconds
  ) {
    issues.push('作品、集、场景、段或同条件登记不全');
  }
  if (
    !Array.isArray(study.reviewers) ||
    study.reviewers.length !== 2 ||
    !study.reviewers.every(present) ||
    new Set(study.reviewers.map((s) => s.trim())).size !== 2
  )
    issues.push('须指定两位不同评审');
  return issues;
}

function media(root, r) {
  const file = r.attempts[r.final - 1]?.file;
  if (!present(file)) return null;
  const absolute = path.resolve(root, file);
  return fs.existsSync(absolute) && fs.statSync(absolute).isFile() ? absolute : null;
}

function blind(file, output) {
  const study = load(file),
    root = path.dirname(file);
  if (!registered(file, study)) throw new Error('当前作品和试拍条件与预登记不符，请检查 plan.json');
  if (fs.existsSync(output)) throw new Error('输出目录已存在，请使用新的目录，保留已有评审');
  const temp = output + '.tmp-' + randomUUID();
  const key = { round: randomUUID(), studyHash: hash(JSON.stringify(study)), cases: Object.create(null) };
  const ballots = [0, 1].map((i) => ({ round: key.round, reviewer: study.reviewers?.[i] || '', cases: [] }));
  const waiting = [];
  fs.mkdirSync(temp);
  try {
    for (const i of [0, 1]) fs.mkdirSync(path.join(temp, 'reviewer-' + (i + 1)));
    for (const [i, p] of study.pairs.entries()) {
      const files = arms.map((arm) => media(root, p[arm]));
      if (setupIssues(study, p).length || files.some((f) => !f)) {
        waiting.push(p.id);
        continue;
      }
      const code = 'S' + String(i + 1).padStart(3, '0');
      const clips = files.map((src, n) => {
        // Strip original filenames, metadata, subtitles and secondary tracks from the review copies.
        const dst = path.join(temp, code + '-' + n + '.mkv');
        execFileSync(
          'ffmpeg',
          [
            '-v',
            'error',
            '-nostdin',
            '-protocol_whitelist',
            'file,pipe',
            '-i',
            src,
            '-map',
            '0:v:0',
            '-map',
            '0:a:0?',
            '-map_metadata',
            '-1',
            '-map_metadata:s',
            '-1',
            '-map_chapters',
            '-1',
            '-c',
            'copy',
            dst,
          ],
          { stdio: 'pipe' },
        );
        const duration = Number(
          execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', dst], {
            encoding: 'utf8',
          }),
        );
        if (!(duration > 0)) throw new Error(p.id + ' 的媒体没有可核验时长');
        return { dst, durationMs: Math.round(duration * 1000) };
      });
      const orders = [];
      for (const reviewer of [0, 1]) {
        const order = randomInt(2) ? [0, 1] : [1, 0];
        orders.push(order);
        const dir = path.join(temp, 'reviewer-' + (reviewer + 1));
        order.forEach((n, j) => fs.copyFileSync(clips[n].dst, path.join(dir, code + '-' + (j + 1) + '.mkv')));
        ballots[reviewer].cases.push({
          code,
          brief: p.brief || '',
          overall: '',
          observations: Object.fromEntries(p.dimensions.map((d) => [d, { vote: '', timeMs: null, note: '' }])),
        });
      }
      key.cases[p.id] = {
        code,
        orders,
        durationMs: clips.map((c) => c.durationMs),
        mediaHashes: files.map(mediaHash),
      };
      for (const c of clips) fs.unlinkSync(c.dst);
    }
    for (const i of [0, 1]) write(path.join(temp, 'reviewer-' + (i + 1), 'ballot.json'), ballots[i]);
    write(path.join(temp, 'private-key.json'), key);
    fs.renameSync(temp, output);
  } catch (err) {
    fs.rmSync(temp, { recursive: true, force: true });
    throw err;
  }
  return { paired: Object.keys(key.cases).length, waiting };
}

function measures(pairs, arm) {
  const records = pairs.map((p) => p[arm]),
    closed = records.filter((r) => r.final != null);
  const tried = records.filter((r) => r.attempts.length);
  const first = tried.filter((r) => r.attempts[0]?.outcome === 'usable').length;
  const usable = closed.filter((r) => Number.isInteger(r.final)).length;
  const submissions = records.reduce((n, r) => n + r.attempts.length, 0);
  function total(get) {
    return tried.length && tried.every((r) => nonnegative(get(r)))
      ? Number(tried.reduce((sum, r) => sum + get(r), 0).toFixed(6))
      : null;
  }
  return {
    planned: records.length,
    tried: tried.length,
    closed: closed.length,
    firstUsable: first,
    usable,
    submissions,
    firstPassRate: tried.length ? first / tried.length : null,
    submissionsPerUsable: usable ? submissions / usable : null,
    costs: Object.fromEntries(costTypes.map((k) => [k, total((r) => r.costs?.[k])])),
    repairMinutes: total((r) => r.repairMinutes),
  };
}

function readBallot(dir, i) {
  try {
    return read(path.join(dir, 'reviewer-' + (i + 1), 'ballot.json'));
  } catch (err) {
    if (err.code === 'ENOENT' || err instanceof SyntaxError) return null;
    throw err;
  }
}

function inspectPair(study, p, entry, ballots, root) {
  const issues = setupIssues(study, p);
  const votes = [];
  for (const arm of arms) {
    const r = p[arm];
    if (!r.attempts.length || r.final == null) issues.push(arm + ' 尚未完成试拍');
    if (r.final === 'discarded') issues.push(arm + ' 最终弃用，缺少成对样片');
    if (Number.isInteger(r.final)) {
      const file = media(root, r);
      if (!file) issues.push(arm + ' 最终样片缺失');
      else if (entry && mediaHash(file) !== entry.mediaHashes[arms.indexOf(arm)])
        issues.push(arm + ' 样片在制盲后发生变化');
    }
    if (!nonnegative(r.repairMinutes) || costTypes.some((k) => !nonnegative(r.costs?.[k])))
      issues.push(arm + ' 费用或返修分钟未填全');
  }
  if (!entry) issues.push('缺少与当前清单匹配的盲评包');
  else
    for (const i of [0, 1]) {
      const ballot = ballots[i];
      const matches = Array.isArray(ballot?.cases) ? ballot.cases.filter((c) => c.code === entry.code) : [];
      const row = matches[0],
        who = '评审 ' + (i + 1);
      const decode = (vote) =>
        vote === 'tie' ? 'tie' : ['1', '2'].includes(vote) ? arms[entry.orders[i][Number(vote) - 1]] : null;
      if (!row || matches.length !== 1 || ballot.reviewer !== study.reviewers[i] || !decode(row.overall)) {
        issues.push(who + ' 尚未独立完成总评');
        continue;
      }
      const observations = {};
      for (const d of p.dimensions) {
        const obs = row.observations?.[d];
        if (
          !obs ||
          !decode(obs.vote) ||
          !present(obs.note) ||
          !Number.isInteger(obs.timeMs) ||
          obs.timeMs < 0 ||
          obs.timeMs >= Math.min(...entry.durationMs)
        ) {
          issues.push(who + ' 的' + d + '缺少有效时间码、现象或判定');
          continue;
        }
        observations[d] = { ...obs, vote: decode(obs.vote) };
        if (observations[d].vote === 'baseline') issues.push(who + ' 记录' + d + '退化，待复核');
      }
      votes.push({ reviewer: ballot.reviewer, overall: decode(row.overall), observations });
    }
  if (votes.some((v) => v.overall === 'baseline')) issues.push('总评出现劣势，待复核');
  if (
    votes.length === 2 &&
    (votes[0].overall !== votes[1].overall ||
      p.dimensions.some((d) => votes[0].observations[d]?.vote !== votes[1].observations[d]?.vote))
  )
    issues.push('两位评审意见有分歧');
  return {
    id: p.id,
    work: p.work,
    episode: p.episode,
    scene: p.scene,
    segment: p.segment,
    status: issues.length ? '待测' : '已完成对照',
    issues,
    votes,
  };
}

function report(file, output) {
  const study = load(file),
    root = path.dirname(file);
  let key;
  if (output && fs.existsSync(path.join(output, 'private-key.json')))
    key = read(path.join(output, 'private-key.json'));
  const current = key?.studyHash === hash(JSON.stringify(study));
  const ballots = current
    ? [0, 1].map((i) => {
        const ballot = readBallot(output, i);
        return ballot?.round === key.round ? ballot : null;
      })
    : [];
  const results = study.pairs.map((p) =>
    inspectPair(study, p, current && Object.hasOwn(key.cases, p.id) && key.cases[p.id], ballots, root),
  );
  const groups = new Map();
  for (const p of study.pairs) {
    const id = JSON.stringify([p.work, p.episode, p.scene]);
    if (!groups.has(id)) groups.set(id, []);
    groups.get(id).push(p);
  }
  const summary = Array.from(groups.values(), (pairs) => ({
    work: pairs[0].work,
    episode: pairs[0].episode,
    scene: pairs[0].scene,
    baseline: measures(pairs, 'baseline'),
    method: measures(pairs, 'method'),
  }));
  const issues = [];
  if (!registered(file, study)) issues.push('缺少与当前清单一致的预登记');
  const used = new Map();
  for (const p of study.pairs) {
    const hashes = current && key.cases[p.id]?.mediaHashes;
    if (!hashes) continue;
    const signature = [...hashes].sort().join('/');
    if (used.has(signature)) issues.push(p.id + ' 与 ' + used.get(signature) + ' 使用同一对样片，独立样本待补');
    else used.set(signature, p.id);
  }
  if (results.some((r) => r.issues.length)) issues.push('有配对待测或待复核');
  const wins = results.filter((r) => r.status === '已完成对照' && r.votes.every((v) => v.overall === 'method'));
  if (new Set(wins.map((r) => r.work.trim())).size < 2) issues.push('尚未在至少两部独立作品上重复取得一致优势');
  const reviewed = new Set(
    results.filter((r) => !r.issues.length).flatMap((r) => Object.keys(r.votes[0].observations)),
  );
  if (['画风', '表演', '动作衔接', '对白时机'].some((d) => !reviewed.has(d)))
    issues.push('关键维度的成对盲评尚未覆盖');
  for (const g of summary) {
    const a = g.baseline,
      b = g.method;
    if (a.closed !== a.planned || b.closed !== b.planned) continue;
    if (
      b.firstPassRate < a.firstPassRate ||
      (a.usable && !b.usable) ||
      (a.usable && b.usable && b.submissionsPerUsable > a.submissionsPerUsable)
    ) {
      issues.push(`${g.work} / ${g.episode} / ${g.scene} 的可用率或重抽指标退化`);
    }
    const costsKnown = costTypes.every((k) => a.costs[k] != null && b.costs[k] != null);
    const cost = (row) => costTypes.reduce((sum, k) => sum + row.costs[k], 0);
    if (
      (costsKnown && cost(b) > cost(a) + 0.000001) ||
      (a.repairMinutes != null && b.repairMinutes != null && b.repairMinutes > a.repairMinutes)
    ) {
      issues.push(`${g.work} / ${g.episode} / ${g.scene} 的费用或人工返修指标退化，待复核`);
    }
  }
  return {
    status: issues.length ? '待测' : '已具备人工决策记录',
    issues,
    currency: study.currency,
    summary,
    pairs: results,
  };
}

function main([command, file, output]) {
  if (command === 'init' && file && !output) {
    write(file, template());
    return { created: file };
  }
  if (command === 'register' && file && !output) return register(file);
  if (command === 'blind' && file && output) return blind(file, output);
  if (command === 'report' && file) return report(file, output);
  throw new Error(
    '用法：node tools/quality-study.cjs init 清单.json | register 清单.json | blind 清单.json 新目录 | report 清单.json [盲评目录]',
  );
}

if (require.main === module) {
  try {
    console.log(JSON.stringify(main(process.argv.slice(2)), null, 2));
  } catch (err) {
    console.error(err.message);
    process.exitCode = 1;
  }
}
