// SOAK (endurance): steady, moderate load for a long time to expose leaks and slow degradation.
// Here the run is 4 minutes so it fits a demo; real soak tests usually run 1 to 8 hours (set SCALE=30 for 2 hours).
// Checks: (1) latency in the last third is not worse than in the first third, (2) memory after garbage collection
// does not keep growing (the shop is asked to run a garbage collection before each memory reading).
import { hit, makeSetup, makeSummary, k6Stages, stageFor, thresholds, sloOverall, sloEndpoints, monitorScenario, totalSeconds, durS, STATS } from './lib/common.js';
export { monitor } from './lib/common.js';

const SOAK_RATE = Number(__ENV.SOAK_RATE || 300);
const TOTAL = durS(240);
const third = Math.round(TOTAL / 3);
const STAGES = [
  { name: 't1_early', rate: SOAK_RATE, seconds: third },
  { name: 't2_middle', rate: SOAK_RATE, seconds: third },
  { name: 't3_late', rate: SOAK_RATE, seconds: TOTAL - 2 * third },
];

export const options = {
  scenarios: {
    soak: { executor: 'ramping-arrival-rate', startRate: SOAK_RATE, timeUnit: '1s', preAllocatedVUs: 50, maxVUs: 300, stages: k6Stages(STAGES) },
    monitor: monitorScenario(totalSeconds(STAGES)),
  },
  summaryTrendStats: STATS,
  thresholds: thresholds(STAGES, { ...sloOverall(), ...sloEndpoints() }),
};
export const setup = makeSetup(STAGES);
export default function (d) { hit(stageFor(d.start, STAGES), d.tokens); }
export const handleSummary = makeSummary('soak', STAGES, (data, val) => {
  const h = (s) => val(data, `heap_mb{stage:${s}}`);
  const first = h('t1_early'), last = h('t3_late');
  return { heap: { firstAvgMb: first && +first.avg.toFixed(2), lastAvgMb: last && +last.avg.toFixed(2), growthMb: first && last ? +(last.avg - first.avg).toFixed(2) : null } };
});

