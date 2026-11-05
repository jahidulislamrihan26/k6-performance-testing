import http from 'k6/http';
import { check } from 'k6';

export const BASE = __ENV.BASE_URL || 'http://localhost:3111';
export const SCALE = Number(__ENV.SCALE || 1); // shortens every duration, e.g. SCALE=0.25 for CI

// Service level objectives used by the tests
export const SLO = { p95: 300, p99: 800, errorRate: 0.01 };
export const STATS = ['avg', 'min', 'med', 'max', 'p(90)', 'p(95)', 'p(99)'];
export const ENDPOINTS = ['list', 'detail', 'search', 'order'];

// Traffic mix: what real shoppers do
const MIX = [['list', 0.70], ['detail', 0.20], ['search', 0.08], ['order', 0.02]];
const TERMS = ['shirt', 'mug', 'bag', 'lamp', 'book'];
const JSON_HEADERS = { 'Content-Type': 'application/json' };

function pick() {
  let r = Math.random(), acc = 0;
  for (const [name, w] of MIX) { acc += w; if (r < acc) return name; }
  return 'list';
}
const rint = (a, b) => a + Math.floor(Math.random() * (b - a + 1));

// One user action. Returns the response.
export function hit(stage) {
  const endpoint = pick();
  let res, ok;
  if (endpoint === 'list') {
    res = http.get(`${BASE}/api/products?page=${rint(1, 2)}`, { tags: { endpoint, stage, name: 'GET /api/products' } });
    ok = check(res, { 'list 200': (r) => r.status === 200, 'list has items': (r) => r.status !== 200 || r.json('items').length > 0 });
  } else if (endpoint === 'detail') {
    res = http.get(`${BASE}/api/products/${rint(1, 20)}`, { tags: { endpoint, stage, name: 'GET /api/products/:id' } });
    ok = check(res, { 'detail 200': (r) => r.status === 200, 'detail has id': (r) => r.status !== 200 || r.json('id') > 0 });
  } else if (endpoint === 'search') {
    res = http.get(`${BASE}/api/search?q=${TERMS[rint(0, 4)]}`, { tags: { endpoint, stage, name: 'GET /api/search' } });
    ok = check(res, { 'search 200': (r) => r.status === 200, 'search has results': (r) => r.status !== 200 || r.json('results').length > 0 });
  } else {
    res = http.post(`${BASE}/api/orders`, JSON.stringify({ productId: rint(1, 20), quantity: rint(1, 3), email: 'load@test.local' }), { headers: JSON_HEADERS, tags: { endpoint, stage, name: 'POST /api/orders' } });
    ok = check(res, { 'order 201': (r) => r.status === 201, 'order has id': (r) => r.status !== 201 || r.json('id') > 0 });
  }
  return res;
}

// ---- stage helpers (a "stage" is a named, fixed-rate step so results can be compared per step)
export const durS = (s) => Math.max(4, Math.round(s * SCALE));
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
  }
  for (const e of ENDPOINTS) add(`http_req_duration{endpoint:${e}}`, ['max>=0']);
  for (const [k, v] of Object.entries(extra)) add(k, v);
  return th;
}
export const sloOverall = () => ({
  http_req_duration: [`p(95)<${SLO.p95}`, `p(99)<${SLO.p99}`],
  http_req_failed: [`rate<${SLO.errorRate}`],
  checks: ['rate>0.99'],
});
export const sloStage = (name) => ({
  [`http_req_duration{stage:${name}}`]: [`p(95)<${SLO.p95}`],
  [`http_req_failed{stage:${name}}`]: [`rate<${SLO.errorRate}`],
});

// ---- summary: machine-readable JSON per test + short console block
const val = (data, name) => { const m = data.metrics[name]; return m ? (m.values || m) : null; };
const dist = (v) => (v ? { avg: v.avg, med: v.med, p90: v['p(90)'], p95: v['p(95)'], p99: v['p(99)'], max: v.max } : null);
export function makeSummary(test, stages, extra = () => ({})) {
  return (data) => {
    const dur = val(data, 'http_req_duration'), reqs = val(data, 'http_reqs'), failed = val(data, 'http_req_failed'), checks = val(data, 'checks');
    const dropped = val(data, 'dropped_iterations');
    const out = {
      test, finishedAt: new Date().toISOString(), durationSec: Math.round(data.state ? data.state.testRunDurationMs / 1000 : 0),
      overall: { requests: reqs && reqs.count, rps: reqs && +reqs.rate.toFixed(1), failedRate: failed && (failed.rate ?? failed.value), checksRate: checks && (checks.rate ?? checks.value), dropped: dropped ? dropped.count : 0, vusMax: (val(data, 'vus_max') || {}).max, latency: dist(dur) },
      endpoints: {}, stages: [],
      ...extra(data, val),
    };
    for (const e of ENDPOINTS) { const d = val(data, `http_req_duration{endpoint:${e}}`); if (d) out.endpoints[e] = dist(d); }
    for (const s of stages || []) {
      const d = val(data, `http_req_duration{stage:${s.name}}`), f = val(data, `http_req_failed{stage:${s.name}}`), r = val(data, `http_reqs{stage:${s.name}}`);
      out.stages.push({ name: s.name, rate: s.rate, seconds: s.seconds, requests: r && r.count, rps: r && +(r.count / s.seconds).toFixed(1), failedRate: f && (f.rate ?? f.value), latency: dist(d) });
    }
    const L = out.overall.latency || {};
    const line = `\n[${test}] ${out.overall.requests} requests, ${out.overall.rps} req/s, p95 ${Math.round(L.p95)} ms, p99 ${Math.round(L.p99)} ms, errors ${(100 * (out.overall.failedRate || 0)).toFixed(2)}%, dropped ${out.overall.dropped}\n`;
    return { [`results/${test}.json`]: JSON.stringify(out, null, 2), stdout: line };
  };
}
