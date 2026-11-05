// SHOPPER JOURNEY: realistic users, not isolated requests. Each virtual user browses a category, searches, opens a
// product, logs in, buys 1 to 3 products and checks the order, with think time between steps.
// It uses a CLOSED model (a fixed number of users who wait for each reply), which is right for "how many shoppers
// can we serve at once?". The data is correlated like a real user: the order contains products found by the search,
// and the test checks the order total against the prices the user saw.
import http from 'k6/http';
import { check, group, sleep } from 'k6';
import { Rate, Trend } from 'k6/metrics';
import { BASE, SLO, STATS, users, makeSetup, makeSummary, stageFor, thresholds, monitorScenario, totalSeconds, durS } from './lib/common.js';
export { monitor } from './lib/common.js';

const CATEGORIES = ['shirts', 'mugs', 'bags', 'lamps', 'books', 'shoes', 'hats', 'toys', 'games', 'tools', 'plants', 'music'];
const TERMS = ['alpine', 'urban', 'classic', 'modern', 'compact', 'deluxe', 'vintage', 'solar', 'smart', 'rustic'];
const JSON_HEADERS = { 'Content-Type': 'application/json' };
const rint = (a, b) => a + Math.floor(Math.random() * (b - a + 1));
const oneOf = (a) => a[rint(0, a.length - 1)];
const think = () => sleep(0.5 + Math.random() * 1.5); // 0.5 to 2 s between steps

// Phases, in users (rate = number of virtual users)
const STAGES = [
  { name: 'ramp_to_100', rate: 100, seconds: durS(20) },
  { name: 'hold_100', rate: 100, seconds: durS(60) },
  { name: 'ramp_to_400', rate: 400, seconds: durS(20) },
  { name: 'hold_400', rate: 400, seconds: durS(60) },
  { name: 'ramp_down', rate: 0, seconds: durS(10) },
];
const STEPS = { home: 150, browse: 150, search: 500, product: 150, login: 400, checkout: 500, confirm: 150 };

const journeySuccess = new Rate('journey_success');
const journeyMs = new Trend('journey_ms', true);

const stepThresholds = Object.fromEntries(Object.entries(STEPS).map(([s, ms]) => [`http_req_duration{step:${s}}`, ['max>=0', `p(95)<${ms}`]]));

export const options = {
  scenarios: {
    shoppers: { executor: 'ramping-vus', startVUs: 0, gracefulRampDown: '10s', gracefulStop: '15s', stages: STAGES.map((s) => ({ target: s.rate, duration: `${s.seconds}s` })), exec: 'shopper' },
    monitor: monitorScenario(totalSeconds(STAGES)),
  },
  summaryTrendStats: STATS,
  thresholds: thresholds(STAGES, {
    ...stepThresholds,
    journey_success: ['rate>0.99'],
    journey_ms: ['p(95)<20000'],
    http_req_failed: [`rate<${SLO.errorRate}`],
    checks: ['rate>0.99'],
  }),
};
export const setup = makeSetup(STAGES);

export function shopper(d) {
  const stage = stageFor(d.start, STAGES);
  const t0 = Date.now();
  let ok = true;
  const get = (url, step, name) => http.get(`${BASE}${url}`, { tags: { step, stage, name } });
  const category = oneOf(CATEGORIES);

  group('1 home and browse', () => {
    const home = get(`/api/products?category=${category}&page=1`, 'home', 'GET /api/products');
    ok = check(home, { 'home 200 with items': (r) => r.status === 200 && r.json('items').length > 0 }) && ok;
    think();
    const more = get(`/api/products?category=${category}&page=2`, 'browse', 'GET /api/products');
    ok = check(more, { 'browse page 2 ok': (r) => r.status === 200 }) && ok;
    think();
  });

  let found = [];
  group('2 search and product page', () => {
    const s = get(`/api/search?q=${oneOf(TERMS)}`, 'search', 'GET /api/search');
    ok = check(s, { 'search 200 with results': (r) => r.status === 200 && r.json('results').length > 0 }) && ok;
    if (s.status === 200) found = s.json('results');
    think();
    if (found.length) {
      const pick = oneOf(found);
      const p = get(`/api/products/${pick.id}`, 'product', 'GET /api/products/:id');
      ok = check(p, { 'product page matches the search hit': (r) => r.status === 200 && r.json('id') === pick.id && r.json('price') === pick.price }) && ok;
      think();
    }
  });

  let token = null;
  group('3 login', () => {
    const l = http.post(`${BASE}/api/login`, JSON.stringify(oneOf(users)), { headers: JSON_HEADERS, tags: { step: 'login', stage, name: 'POST /api/login' } });
    ok = check(l, { 'login 200 with token': (r) => r.status === 200 && !!r.json('token') }) && ok;
    if (l.status === 200) token = l.json('token');
    think();
  });

  if (token && found.length) {
    group('4 checkout', () => {
      const chosen = Array.from({ length: rint(1, 3) }, () => ({ hit: oneOf(found), quantity: rint(1, 3) }));
      const expected = Math.round(chosen.reduce((sum, c) => sum + c.hit.price * c.quantity, 0) * 100) / 100;
      const o = http.post(`${BASE}/api/orders`, JSON.stringify({ items: chosen.map((c) => ({ productId: c.hit.id, quantity: c.quantity })) }), { headers: { ...JSON_HEADERS, Authorization: `Bearer ${token}` }, tags: { step: 'checkout', stage, name: 'POST /api/orders' } });
      ok = check(o, { 'order created (201)': (r) => r.status === 201, 'order total equals the prices the user saw': (r) => r.status === 201 && Math.abs(r.json('total') - expected) < 0.01 }) && ok;
      think();
      if (o.status === 201) {
        const c = http.get(`${BASE}/api/orders/${o.json('id')}`, { headers: { Authorization: `Bearer ${token}` }, tags: { step: 'confirm', stage, name: 'GET /api/orders/:id' } });
        ok = check(c, { 'order can be read back': (r) => r.status === 200 && r.json('items').length === chosen.length }) && ok;
      } else ok = false;
    });
  } else ok = false;

  journeySuccess.add(ok, { stage });
  journeyMs.add(Date.now() - t0, { stage });
}

export const handleSummary = makeSummary('journey', STAGES, (data, val) => {
  const steps = {};
  for (const s of Object.keys(STEPS)) {
    const v = val(data, `http_req_duration{step:${s}}`);
    if (v) steps[s] = { p50: v.med, p95: v['p(95)'], p99: v['p(99)'], max: v.max, target: STEPS[s] };
  }
  const js = val(data, 'journey_success'), jm = val(data, 'journey_ms');
  return { journey: { success: js && (js.rate ?? js.value), completed: js && (js.passes + js.fails), durationMs: jm && { avg: jm.avg, p50: jm.med, p95: jm['p(95)'], max: jm.max }, steps } };
});

