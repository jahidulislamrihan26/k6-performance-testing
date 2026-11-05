// PUBLIC BASELINE: a deliberately gentle check of a real public API (5 users, 30 s, about 150 requests).
// Heavier tests (stress, spike, soak) are NOT pointed at third-party servers; they run against the local demo shop.
import http from 'k6/http';
import { check, sleep } from 'k6';
import { makeSummary, STATS } from './lib/common.js';

export const options = {
  scenarios: { baseline: { executor: 'constant-vus', vus: 5, duration: '30s' } },
  summaryTrendStats: STATS,
  thresholds: { http_req_failed: ['rate<0.01'], http_req_duration: ['p(95)<1500'], checks: ['rate>0.99'] },
};
const API = 'https://jsonplaceholder.typicode.com';
export default function () {
  const list = http.get(`${API}/posts`, { tags: { endpoint: 'list' } });
  check(list, { 'list 200': (r) => r.status === 200, 'list has 100 posts': (r) => r.json().length === 100 });
  const one = http.get(`${API}/posts/${1 + Math.floor(Math.random() * 100)}`, { tags: { endpoint: 'detail' } });
  check(one, { 'detail 200': (r) => r.status === 200, 'detail has title': (r) => !!r.json('title') });
  sleep(1);
}
export const handleSummary = makeSummary('public-baseline', []);
