import http from 'k6/http';
import { check, sleep } from 'k6';

// Load test: ramp to 10 virtual users, hold, ramp down.
export const options = {
  stages: [
    { duration: '10s', target: 10 },
    { duration: '20s', target: 10 },
    { duration: '10s', target: 0 },
  ],
  thresholds: {
    http_req_failed: ['rate<0.01'],     // under 1% errors
    http_req_duration: ['p(95)<1500'],  // 95% of requests under 1.5s
  },
};

const BASE = 'https://jsonplaceholder.typicode.com';

export default function () {
  const list = http.get(`${BASE}/posts`);
  check(list, {
    'list status 200': (r) => r.status === 200,
    'list has 100 posts': (r) => r.json().length === 100,
  });

  const one = http.get(`${BASE}/posts/1`);
  check(one, { 'single status 200': (r) => r.status === 200 });

  sleep(1);
}
