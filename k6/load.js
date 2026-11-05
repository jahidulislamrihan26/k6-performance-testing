// LOAD: expected everyday traffic. Pass = the service meets its SLOs: overall p95 < 300 ms, p99 < 800 ms, errors < 1%,
// plus a target per endpoint (list/detail 150 ms, search 500 ms, login 400 ms, order 500 ms at p95).
// Uses an open workload model (fixed arrival rate): new users keep arriving even if the system slows down,
// so slowdowns show up as latency instead of being hidden by users who politely wait.
import { hit, makeSetup, makeSummary, k6Stages, stageFor, thresholds, sloOverall, sloEndpoints, monitorScenario, totalSeconds, durS, STATS } from './lib/common.js';
export { monitor } from './lib/common.js';

const LOAD = Number(__ENV.LOAD_RATE || 400);
const STAGES = [
  { name: 'warmup', rate: 50, seconds: durS(20) },
  { name: `steady_${LOAD}`, rate: LOAD, seconds: durS(70) },
  { name: 'cooldown', rate: 50, seconds: durS(10) },
];

export const options = {
  scenarios: {
    load: { executor: 'ramping-arrival-rate', startRate: 50, timeUnit: '1s', preAllocatedVUs: 60, maxVUs: 400, stages: k6Stages(STAGES) },
    monitor: monitorScenario(totalSeconds(STAGES)),
  },
  summaryTrendStats: STATS,
  thresholds: thresholds(STAGES, { ...sloOverall(), ...sloEndpoints() }),
};
export const setup = makeSetup(STAGES);
export default function (d) { hit(stageFor(d.start, STAGES), d.tokens); }
export const handleSummary = makeSummary('load', STAGES);

