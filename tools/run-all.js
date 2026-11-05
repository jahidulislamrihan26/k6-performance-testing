// Starts the demo shop API, runs the k6 tests one after another, stops the API, builds the report.
//   node tools/run-all.js                 full run (about 12 minutes)
//   node tools/run-all.js --profile ci    short run for CI (smoke, load, spike at 25% length)
//   node tools/run-all.js --only load,spike
const { spawn, spawnSync } = require('child_process');
const os = require('os');
const fs = require('fs');
const path = require('path');
const http = require('http');

const ROOT = path.join(__dirname, '..');
const arg = (n) => { const i = process.argv.indexOf(n); return i >= 0 ? process.argv[i + 1] : null; };
const profile = arg('--profile') || 'full';
const PORT = process.env.PORT || '3111';
const BASE_URL = `http://localhost:${PORT}`;

const ALL = ['smoke', 'load', 'journey', 'stress', 'spike', 'soak', 'public-baseline'];
let tests = profile === 'ci' ? ['smoke', 'load', 'journey', 'spike'] : ALL;
if (arg('--only')) tests = arg('--only').split(',');
const scale = process.env.SCALE || (profile === 'ci' ? '0.4' : '1');

fs.mkdirSync(path.join(ROOT, 'results'), { recursive: true });
const ping = () => new Promise((res) => http.get(`${BASE_URL}/health`, (r) => { r.resume(); res(r.statusCode === 200); }).on('error', () => res(false)));
const wait = async () => { for (let i = 0; i < 50; i++) { if (await ping()) return true; await new Promise((r) => setTimeout(r, 200)); } return false; };

(async () => {
  const sut = spawn(process.execPath, ['--expose-gc', path.join(ROOT, 'sut', 'server.js')], { env: { ...process.env, PORT }, stdio: 'ignore' });
  if (!(await wait())) { console.error('Demo API did not start'); sut.kill(); process.exit(1); }
  console.log(`Demo API up on ${BASE_URL}. Profile=${profile} scale=${scale} tests=${tests.join(', ')}`);

  const results = [];
  for (const t of tests) {
    console.log(`\n=== ${t} ===`);
    const t0 = Date.now();
    // The CI profile uses gentler rates: GitHub's runners are slower than a developer machine and share two cores
    // between the generator and the shop, so a spike far above capacity would take longer to clear than the fixed drain window.
    const profileRates = profile === 'ci' ? { LOAD_RATE: '250', SPIKE_RATE: '900' } : {};
    const r = spawnSync('k6', ['run', '--quiet', path.join('k6', `${t}.js`)], { cwd: ROOT, stdio: 'inherit', env: { ...profileRates, ...process.env, BASE_URL, SCALE: scale } });
    results.push({ test: t, exitCode: r.status, seconds: Math.round((Date.now() - t0) / 1000) });
  }
  sut.kill();

  const k6v = spawnSync('k6', ['version'], { encoding: 'utf8' }).stdout.trim().split(' ')[1];
  const env = { profile, scale: Number(scale), date: new Date().toISOString(), os: `${os.type()} ${os.release()}`, cpu: os.cpus()[0].model.trim(), cores: os.cpus().length, memGb: +(os.totalmem() / 2 ** 30).toFixed(1), node: process.version, k6: k6v };
  // With --only, keep the earlier results of the tests that were not re-run so the report stays complete.
  let merged = results;
  const prevFile = path.join(ROOT, 'results', 'run.json');
  if (arg('--only') && fs.existsSync(prevFile)) {
    const prev = JSON.parse(fs.readFileSync(prevFile, 'utf8'));
    merged = [...prev.tests.filter((p) => !results.some((r) => r.test === p.test)), ...results].sort((a, b) => ALL.indexOf(a.test) - ALL.indexOf(b.test));
    env.date = prev.env.date; // the full run's environment still describes the other tests
    env.profile = prev.env.profile; env.scale = prev.env.scale;
  }
  fs.writeFileSync(prevFile, JSON.stringify({ env, tests: merged }, null, 2));
  spawnSync(process.execPath, [path.join(__dirname, 'report.js')], { cwd: ROOT, stdio: 'inherit' });

  const failed = results.filter((r) => r.exitCode !== 0);
  console.log('\n' + results.map((r) => `${r.exitCode === 0 ? 'PASS' : 'FAIL'}  ${r.test} (${r.seconds}s)`).join('\n'));
  process.exit(failed.length ? 1 : 0);
})();

