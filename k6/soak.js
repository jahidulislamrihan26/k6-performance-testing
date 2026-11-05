// SOAK (endurance): steady, moderate load for a long time to expose leaks and slow degradation.
// Here the run is 4 minutes so it fits a demo; real soak tests usually run 1 to 8 hours (set SCALE=30 for 2 hours).
// Checks: (1) latency in the last third is not worse than in the first third, (2) heap after GC does not keep growing.
import http from 'k6/http';
import { Gauge } from 'k6/metrics';
import { hit, makeSummary, k6Stages, stageFor, thresholds, sloOverall, durS, STATS, BASE } from './lib/common.js';

const TOTAL = durS(240);
const third = Math.round(TOTAL / 3);
const STAGES = [
  { name: 't1_early', rate: 100, seconds: third },
  { name: 't2_middle', rate: 100, seconds: third },
  { name: 't3_late', rate: 100, seconds: TOTAL - 2 * third },
];
const heapFirst = new Gauge('heap_first_mb');
const heapLast = new Gauge('heap_last_mb');

export const options = {
  scenarios: {
    soak: { executor: 'ramping-arrival-rate', startRate: 100, timeUnit: '1s', preAllocatedVUs: 50, maxVUs: 300, stages: k6Stages(STAGES), exec: 'traffic' },
    monitor: { executor: 'constant-arrival-rate', rate: 1, timeUnit: '15s', duration: `${TOTAL}s`, preAllocatedVUs: 1, exec: 'monitor' },
  },
  summaryTrendStats: STATS,
  thresholds: thresholds(STAGES, sloOverall()),
};
let first = true;
export function setup() { return { start: Date.now() }; }
export function traffic(d) { hit(stageFor(d.start, STAGES)); }
export function monitor() {
  const r = http.get(`${BASE}/metrics?gc=1`, { tags: { name: 'metrics', endpoint: 'monitor' } });
  const h = r.json('heapUsedMb');
  if (first) { heapFirst.add(h); first = false; }
  heapLast.add(h);
}
export const handleSummary = makeSummary('soak', STAGES, (data, val) => {
  const f = val(data, 'heap_first_mb'), l = val(data, 'heap_last_mb');
  return { heap: { firstMb: f && f.value, lastMb: l && l.value, growthMb: f && l ? +(l.value - f.value).toFixed(2) : null } };
});
