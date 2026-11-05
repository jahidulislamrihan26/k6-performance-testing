// Tests for the project's own tooling and the committed results (run with: npm run test:tools).
// Built-in Node test runner, no extra dependencies.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..', '..');
const results = (name) => JSON.parse(fs.readFileSync(path.join(ROOT, 'results', `${name}.json`), 'utf8'));
const run = results('run');

test('run.json: records the machine, the versions and the date of the run', () => {
  for (const k of ['profile', 'date', 'os', 'cpu', 'cores', 'node', 'k6']) assert.ok(run.env[k] !== undefined, `env.${k} missing`);
  assert.ok(!Number.isNaN(Date.parse(run.env.date)));
});
test('run.json: every test that ran exited cleanly (a crossed threshold would show exit code 99)', () => {
  assert.ok(run.tests.length >= 6);
  for (const t of run.tests) assert.equal(t.exitCode, 0, `${t.test} exited with ${t.exitCode}`);
});
test('every test in run.json has a result file, and every result file is valid JSON', () => {
  for (const t of run.tests) assert.ok(fs.existsSync(path.join(ROOT, 'results', `${t.test}.json`)), `results/${t.test}.json missing`);
});
test('each result carries overall latency percentiles that are in a sensible order', () => {
  for (const name of ['smoke', 'load', 'journey', 'stress', 'spike', 'soak']) {
    const l = (results(name).overall || {}).latency;
    assert.ok(l, `${name}: no overall.latency block`);
    for (const k of ['med', 'p90', 'p95', 'p99', 'max']) assert.equal(typeof l[k], 'number', `${name}: latency.${k} is not a number`);
    assert.ok(l.med <= l.p90 && l.p90 <= l.p95 && l.p95 <= l.p99 && l.p99 <= l.max, `${name}: percentiles out of order ${JSON.stringify(l)}`);
  }
});
test('the report was generated from the committed results (REPORT.md names every test)', () => {
  const md = fs.readFileSync(path.join(ROOT, 'results', 'REPORT.md'), 'utf8').toLowerCase();
  for (const t of run.tests) assert.ok(md.includes(t.test.replace('-', ' ')) || md.includes(t.test), `REPORT.md never mentions ${t.test}`);
});
test('the shop in sut/ starts, answers /health and stops', async () => {
  const { spawn } = require('child_process');
  const port = 3191;
  const server = spawn(process.execPath, [path.join(ROOT, 'sut', 'server.js')], { env: { ...process.env, PORT: String(port), SEED_ROWS: '50', SEED_USERS: '2' }, stdio: 'ignore' });
  try {
    let ok = false;
    for (let i = 0; i < 100 && !ok; i++) { try { ok = (await fetch(`http://127.0.0.1:${port}/health`)).ok; } catch { await new Promise((r) => setTimeout(r, 100)); } }
    assert.ok(ok, 'health check never answered');
  } finally { server.kill(); }
});

// check-links.js is run as a black box in a throw-away folder that mimics the repository layout.
function linkCheck(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'links-'));
  fs.mkdirSync(path.join(dir, 'tools'));
  fs.copyFileSync(path.join(ROOT, 'tools', 'check-links.js'), path.join(dir, 'tools', 'check-links.js'));
  for (const [name, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
    fs.writeFileSync(path.join(dir, name), content);
  }
  const r = spawnSync(process.execPath, [path.join(dir, 'tools', 'check-links.js')], { encoding: 'utf8' });
  fs.rmSync(dir, { recursive: true, force: true });
  return r;
}
test('check-links: passes when links exist, fails and names a broken one', () => {
  assert.equal(linkCheck({ 'README.md': '[a](docs/a.md)', 'docs/a.md': 'x' }).status, 0);
  const bad = linkCheck({ 'README.md': '[gone](docs/missing.md)' });
  assert.equal(bad.status, 1);
  assert.match(bad.stdout, /docs\/missing\.md/);
});
