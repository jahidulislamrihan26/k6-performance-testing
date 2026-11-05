import http from 'k6/http';
import { check } from 'k6';
import { SharedArray } from 'k6/data';
import { Trend } from 'k6/metrics';

export const BASE = __ENV.BASE_URL || 'http://localhost:3111';
export const SCALE = Number(__ENV.SCALE || 1); // shortens every duration, e.g. SCALE=0.4 for CI
const ROWS = Number(__ENV.SEED_ROWS || 30000);

// ---- service level objectives
// Overall targets plus a stricter or looser target per endpoint (search scans a table, login hashes a password).
export const SLO = { p95: 300, p99: 800, errorRate: 0.01, endpoints: { list: 150, detail: 150, search: 500, login: 400, order: 500 } };
export const STATS = ['avg', 'min', 'med', 'max', 'p(90)', 'p(95)', 'p(99)'];
export const ENDPOINTS = ['list', 'detail', 'search', 'login', 'order'];

// ---- test shoppers (same rule as the shop seeds its users); one shared copy for all virtual users
export const users = new SharedArray('users', () => JSON.parse(open('../../data/users.json')));

// ---- traffic mix: what real shoppers do
const MIX = [['list', 0.55], ['detail', 0.22], ['search', 0.12], ['login', 0.04], ['order', 0.07]];
const CATEGORIES = ['shirts', 'mugs', 'bags', 'lamps', 'books', 'shoes', 'hats', 'toys', 'games', 'tools', 'plants', 'music'];
const TERMS = ['alpine', 'urban', 'classic', 'modern', 'compact', 'deluxe', 'vintage', 'solar', 'smart', 'rustic'];
const JSON_HEADERS = { 'Content-Type': 'application/json' };
const rint = (a, b) => a + Math.floor(Math.random() * (b - a + 1));
const oneOf = (a) => a[rint(0, a.length - 1)];

function pick() {
  let r = Math.random(), acc = 0;
  for (const [name, w] of MIX) { acc += w; if (r < acc) return name; }
  return 'list';
}

export function login(user) {
  return http.post(`${BASE}/api/login`, JSON.stringify(user), { headers: JSON_HEADERS, tags: { endpoint: 'login', name: 'POST /api/login' } });
}

// Called once before the test: log in a few shoppers so order requests carry a real token.
export function makeSetup(stages) {
  return () => {
    const tokens = [];
    for (let i = 0; i < 20; i++) {
      const r = http.post(`${BASE}/api/login`, JSON.stringify(users[i]), { headers: JSON_HEADERS, tags: { endpoint: 'setup' } });
      if (r.status === 200) tokens.push(r.json('token'));
    }
    if (tokens.length === 0) throw new Error('Could not log in any test shopper: is the demo shop running and seeded?');
    return { start: Date.now(), stages, tokens };
  };
}

// One user action. Returns the response.
export function hit(stage, tokens) {
  const endpoint = pick();
  const tags = { endpoint, stage };
  let res;
  if (endpoint === 'list') {
    res = http.get(`${BASE}/api/products?category=${oneOf(CATEGORIES)}&page=${rint(1, 5)}`, { tags: { ...tags, name: 'GET /api/products' } });
    check(res, { 'list 200': (r) => r.status === 200, 'list has items': (r) => r.status !== 200 || r.json('items').length > 0 });
  } else if (endpoint === 'detail') {
    res = http.get(`${BASE}/api/products/${rint(1, ROWS)}`, { tags: { ...tags, name: 'GET /api/products/:id' } });
    check(res, { 'detail 200': (r) => r.status === 200, 'detail has id': (r) => r.status !== 200 || r.json('id') > 0 });
  } else if (endpoint === 'search') {
    res = http.get(`${BASE}/api/search?q=${oneOf(TERMS)}`, { tags: { ...tags, name: 'GET /api/search' } });
    check(res, { 'search 200': (r) => r.status === 200, 'search has results': (r) => r.status !== 200 || r.json('results').length > 0 });
  } else if (endpoint === 'login') {
    res = http.post(`${BASE}/api/login`, JSON.stringify(oneOf(users)), { headers: JSON_HEADERS, tags: { ...tags, name: 'POST /api/login' } });
    check(res, { 'login 200': (r) => r.status === 200, 'login has token': (r) => r.status !== 200 || !!r.json('token') });
  } else {
    const items = Array.from({ length: rint(1, 3) }, () => ({ productId: rint(1, ROWS), quantity: rint(1, 3) }));
    res = http.post(`${BASE}/api/orders`, JSON.stringify({ items }), { headers: { ...JSON_HEADERS, Authorization: `Bearer ${oneOf(tokens)}` }, tags: { ...tags, name: 'POST /api/orders' } });
    check(res, { 'order 201': (r) => r.status === 201, 'order has id and total': (r) => r.status !== 201 || (r.json('id') > 0 && r.json('total') > 0) });
  }
  return res;
}

// ---- resource telemetry: the shop reports its own CPU, event-loop lag and memory; sampled every 2 s during each test
const cpuPct = new Trend('cpu_pct');
const lagP99 = new Trend('event_loop_lag_ms');
const rssMb = new Trend('rss_mb');
const heapMb = new Trend('heap_mb');
export function monitor(d) {
  const r = http.get(`${BASE}/metrics?gc=1`, { tags: { name: 'metrics', endpoint: 'monitor' } });
  if (r.status !== 200) return;
  const tag = { stage: stageFor(d.start, d.stages) };
  cpuPct.add(r.json('cpuPct'), tag);
  lagP99.add(r.json('eventLoopLagMs.p99'), tag);
  rssMb.add(r.json('rssMb'), tag);
  heapMb.add(r.json('heapUsedMb'), tag);
}
export const monitorScenario = (totalSeconds) => ({ executor: 'constant-arrival-rate', rate: 1, timeUnit: '2s', duration: `${totalSeconds}s`, preAllocatedVUs: 1, maxVUs: 2, exec: 'monitor' });

// ---- stage helpers (a "stage" is a named, fixed-rate step so results can be compared per step)
export const durS = (s) => Math.max(4, Math.round(s * SCALE));
export const totalSeconds = (stages) => stages.reduce((n, s) => n + s.seconds, 0);
export function k6Stages(stages) {
  return stages.flatMap((s) => [{ target: s.rate, duration: '1s' }, { target: s.rate, duration: `${s.seconds - 1}s` }]);
}
export function stageFor(start, stages) {
  const t = (Date.now() - start) / 1000;
  let acc = 0;
  for (const s of stages) { acc += s.seconds; if (t < acc) return s.name; }
  return stages[stages.length - 1].name;
}
// Declaring a threshold makes k6 keep a sub-metric for that tag, so the summary can show it.
export function thresholds(stages, extra = {}) {
  const th = {};
  const add = (k, v) => (th[k] = [...(th[k] || []), ...v]);
  for (const s of stages) {
    add(`http_req_duration{stage:${s.name}}`, ['max>=0']);
    add(`http_req_failed{stage:${s.name}}`, ['rate>=0']);
    add(`http_reqs{stage:${s.name}}`, ['count>=0']);
    add(`cpu_pct{stage:${s.name}}`, ['max>=0']);
    add(`event_loop_lag_ms{stage:${s.name}}`, ['max>=0']);
    add(`heap_mb{stage:${s.name}}`, ['max>=0']);
  }
  for (const e of ENDPOINTS) add(`http_req_duration{endpoint:${e}}`, ['max>=0']);
  add('rss_mb', ['max>=0']);
  add('heap_mb', ['max>=0']);
  for (const [k, v] of Object.entries(extra)) add(k, v);
  return th;
}
export const sloOverall = () => ({
  http_req_duration: [`p(95)<${SLO.p95}`, `p(99)<${SLO.p99}`],
  http_req_failed: [`rate<${SLO.errorRate}`],
  checks: ['rate>0.99'],
});
// Per-endpoint targets (only meaningful at normal load, so used by load and soak)
export const sloEndpoints = () => Object.fromEntries(Object.entries(SLO.endpoints).map(([e, ms]) => [`http_req_duration{endpoint:${e}}`, [`p(95)<${ms}`]]));
export const sloStage = (name) => ({
  [`http_req_duration{stage:${name}}`]: [`p(95)<${SLO.p95}`],
  [`http_req_failed{stage:${name}}`]: [`rate<${SLO.errorRate}`],
});

// ---- summary: machine-readable JSON per test + short console block
const val = (data, name) => { const m = data.metrics[name]; return m ? (m.values || m) : null; };
const dist = (v) => (v ? { avg: v.avg, med: v.med, p90: v['p(90)'], p95: v['p(95)'], p99: v['p(99)'], max: v.max } : null);
const res = (data, tag) => {
  const c = val(data, `cpu_pct{${tag}}`), l = val(data, `event_loop_lag_ms{${tag}}`);
  return c ? { cpuAvg: +c.avg.toFixed(1), cpuMax: +c.max.toFixed(1), lagP99Max: l ? +l.max.toFixed(1) : null, lagP99Avg: l ? +l.avg.toFixed(1) : null } : null;
};
export function makeSummary(test, stages, extra = () => ({})) {
  return (data) => {
    const dur = val(data, 'http_req_duration'), reqs = val(data, 'http_reqs'), failed = val(data, 'http_req_failed'), checks = val(data, 'checks');
    const dropped = val(data, 'dropped_iterations');
    const rss = val(data, 'rss_mb'), heap = val(data, 'heap_mb');
    const out = {
      test, finishedAt: new Date().toISOString(), durationSec: Math.round(data.state ? data.state.testRunDurationMs / 1000 : 0),
      overall: { requests: reqs && reqs.count, rps: reqs && +reqs.rate.toFixed(1), failedRate: failed && (failed.rate ?? failed.value), checksRate: checks && (checks.rate ?? checks.value), dropped: dropped ? dropped.count : 0, vusMax: (val(data, 'vus_max') || {}).max, latency: dist(dur) },
      memory: rss ? { rssMaxMb: +rss.max.toFixed(1), heapAvgMb: heap ? +heap.avg.toFixed(1) : null, heapMaxMb: heap ? +heap.max.toFixed(1) : null } : null,
      endpoints: {}, stages: [],
      ...extra(data, val),
    };
    for (const e of ENDPOINTS) { const d = val(data, `http_req_duration{endpoint:${e}}`); if (d) out.endpoints[e] = dist(d); }
    for (const s of stages || []) {
      const d = val(data, `http_req_duration{stage:${s.name}}`), f = val(data, `http_req_failed{stage:${s.name}}`), r = val(data, `http_reqs{stage:${s.name}}`);
      out.stages.push({ name: s.name, rate: s.rate, seconds: s.seconds, requests: r && r.count, rps: r && +(r.count / s.seconds).toFixed(1), failedRate: f && (f.rate ?? f.value), latency: dist(d), resources: res(data, `stage:${s.name}`) });
    }
    const L = out.overall.latency || {};
    const line = `\n[${test}] ${out.overall.requests} requests, ${out.overall.rps} req/s, p95 ${Math.round(L.p95)} ms, p99 ${Math.round(L.p99)} ms, errors ${(100 * (out.overall.failedRate || 0)).toFixed(2)}%, dropped ${out.overall.dropped}\n`;
    return { [`results/${test}.json`]: JSON.stringify(out, null, 2), stdout: line };
  };
}
