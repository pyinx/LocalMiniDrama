const { test } = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const tool = path.resolve(__dirname, '../../tools/quality-study.cjs');
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'quality-study-fixture-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const run = (...args) =>
    JSON.parse(
      execFileSync(process.execPath, [tool, ...args], {
        cwd: root,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      }),
    );
  const read = (f) => JSON.parse(fs.readFileSync(path.join(root, f), 'utf8'));
  const write = (f, data) => fs.writeFileSync(path.join(root, f), JSON.stringify(data));
  run('init', 'study.json');
  const study = read('study.json');
  study.method = '自动化测试夹具';
  study.reviewers = ['fixture-reader-1', 'fixture-reader-2'];
  const pair = study.pairs[0];
  Object.assign(pair, {
    work: 'fixture-work-1',
    episode: '1',
    scene: '双人对话',
    segment: '镜一',
    controls: {
      scriptVersion: 'fixture-text',
      references: [],
      modelVersion: 'fixture-render',
      aspect: '1:1',
      targetSeconds: 1,
      seed: 123,
    },
  });
  study.pairs.push({ ...structuredClone(pair), id: 'P002', work: 'fixture-work-2' });
  write('study.json', study);
  run('register', 'study.json');
  return { root, run, read, write, study };
}

test('unshot, incomplete and discarded trials remain pending and retain submission costs', (t) => {
  const f = fixture(t);
  const pending = f.run('report', 'study.json');
  assert.equal(pending.status, '待测');
  assert.equal(pending.summary[0].baseline.firstPassRate, null);
  const r = f.study.pairs[0].baseline;
  Object.assign(r, {
    attempts: [{ outcome: 'failed' }, { outcome: 'rejected' }],
    final: 'discarded',
    costs: { image: 0, video: 2.5, review: 0 },
    repairMinutes: 7,
  });
  f.study.pairs[0].method.attempts = [{ outcome: 'failed' }];
  f.write('study.json', f.study);
  const blind = f.run('blind', 'study.json', 'packet');
  assert.equal(blind.paired, 0);
  assert.deepEqual(blind.waiting, ['P001', 'P002']);
  const report = f.run('report', 'study.json', 'packet');
  const group = report.summary[0];
  assert.equal(group.baseline.submissions, 2);
  assert.equal(group.baseline.usable, 0);
  assert.equal(group.baseline.submissionsPerUsable, null);
  assert.equal(group.baseline.costs.video, 2.5);
  assert.equal(group.method.submissions, 1);
  assert.equal(report.status, '待测');
  f.study.pairs[0].controls.modelVersion = 'changed';
  f.write('study.json', f.study);
  assert.throws(() => f.run('blind', 'study.json', 'other'), /预登记/);
});

test('synthetic clips exercise blinded ballots, scope, disagreements and regressions', (t) => {
  const f = fixture(t),
    colors = ['red', 'blue', 'green', 'yellow'];
  let n = 0;
  for (const p of f.study.pairs)
    for (const arm of ['baseline', 'method']) {
      const file = arm + '-' + ++n + '.mp4';
      execFileSync('ffmpeg', [
        '-v',
        'error',
        '-f',
        'lavfi',
        '-i',
        'color=c=' + colors[n - 1] + ':s=32x32:r=2:d=1',
        '-metadata',
        'title=' + arm,
        '-c:v',
        'libx264',
        path.join(f.root, file),
      ]);
      p[arm] = {
        attempts: [{ outcome: 'usable', file }],
        final: 1,
        costs: { image: 0, review: 0, video: 0 },
        repairMinutes: 0,
      };
    }
  f.write('study.json', f.study);
  assert.equal(f.run('blind', 'study.json', 'packet').paired, 2);
  assert.equal(f.run('report', 'study.json', 'packet').status, '待测');
  const key = f.read('packet/private-key.json');
  for (const i of [0, 1]) {
    const dir = 'packet/reviewer-' + (i + 1);
    assert.deepEqual(fs.readdirSync(path.join(f.root, dir)).sort(), [
      'S001-1.mkv',
      'S001-2.mkv',
      'S002-1.mkv',
      'S002-2.mkv',
      'ballot.json',
    ]);
    const ballot = f.read(dir + '/ballot.json');
    assert.doesNotMatch(JSON.stringify(ballot), /baseline|method|fixture-work/);
    const tags = execFileSync(
      'ffprobe',
      [
        '-v',
        'error',
        '-show_entries',
        'format_tags:stream_tags',
        '-of',
        'json',
        path.join(f.root, dir, 'S001-1.mkv'),
      ],
      { encoding: 'utf8' },
    );
    assert.doesNotMatch(tags, /baseline|method/);
    // Decode purposely constructed votes only inside the test; no human opinion is collected here.
    for (const [idx, row] of ballot.cases.entries()) {
      const order = key.cases[f.study.pairs[idx].id].orders[i];
      row.overall = String(order.indexOf(1) + 1);
      for (const obs of Object.values(row.observations))
        Object.assign(obs, { vote: row.overall, timeMs: 500, note: '仅验证字段映射' });
    }
    f.write(dir + '/ballot.json', ballot);
    if (!i) assert.equal(f.run('report', 'study.json', 'packet').status, '待测');
  }
  const full = f.run('report', 'study.json', 'packet');
  assert.equal(full.status, '已具备人工决策记录');
  assert.equal(full.summary.length, 2);
  assert.equal(full.pairs[0].votes[1].overall, 'method');
  const rel = 'packet/reviewer-2/ballot.json',
    ballot = f.read(rel);
  f.write(rel, { ...ballot, round: 'another-fixture' });
  assert.equal(f.run('report', 'study.json', 'packet').status, '待测');
  ballot.cases[0].observations['表演'].vote = String(key.cases.P001.orders[1].indexOf(0) + 1);
  f.write(rel, ballot);
  const disputed = f.run('report', 'study.json', 'packet');
  assert.equal(disputed.status, '待测');
  assert.match(disputed.pairs[0].issues.join(' '), /表演退化/);
  assert.match(disputed.pairs[0].issues.join(' '), /分歧/);
  fs.appendFileSync(path.join(f.root, f.study.pairs[0].method.attempts[0].file), 'fixture-changed');
  assert.match(f.run('report', 'study.json', 'packet').pairs[0].issues.join(' '), /制盲后发生变化/);
  fs.unlinkSync(path.join(f.root, f.study.pairs[0].method.attempts[0].file));
  assert.match(f.run('report', 'study.json', 'packet').pairs[0].issues.join(' '), /最终样片缺失/);
});
