// SMOKE: one user, 20 seconds. Confirms the system works and the script is correct before any real load.
import { sleep } from 'k6';
import { hit, makeSetup, makeSummary, STATS } from './lib/common.js';

export const options = {
  scenarios: { smoke: { executor: 'constant-vus', vus: 1, duration: '20s' } },
  summaryTrendStats: STATS,
  thresholds: {
    http_req_duration: ['p(95)<200'],
    http_req_failed: ['rate<0.001'],
    checks: ['rate>0.999'],
  },
};
export const setup = makeSetup([]);
export default function (d) { hit('smoke', d.tokens); sleep(0.3); }
export const handleSummary = makeSummary('smoke', []);
