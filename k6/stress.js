// STRESS: raise the arrival rate step by step beyond normal until the system degrades, then drop back.
// Goal is to FIND the breaking point, see how it fails (slow? errors?), see which resource runs out (CPU,
// event loop, memory) and check that it recovers. Only the first (baseline) step and the final recovered
// step carry pass/fail thresholds.
import { hit, makeSetup, makeSummary, k6Stages, stageFor, thresholds, sloStage, monitorScenario, totalSeconds, durS, STATS } from './lib/common.js';
export { monitor } from './lib/common.js';

const RATES = (__ENV.STRESS_RATES || '300,700,1100,1500,1900,2300,2700').split(',').map(Number);
const STAGES = [
  ...RATES.map((r) => ({ name: `rps_${r}`, rate: r, seconds: durS(25) })),
  { name: 'drain_100', rate: 100, seconds: 8 },      // backlog from the overload is cleared here
  { name: 'recovered_100', rate: 100, seconds: durS(20) }, // must be back to normal here
];

export const options = {
  scenarios: {
    stress: { executor: 'ramping-arrival-rate', startRate: RATES[0], timeUnit: '1s', preAllocatedVUs: 400, maxVUs: 2500, stages: k6Stages(STAGES) },
    monitor: monitorScenario(totalSeconds(STAGES)),
  },
  summaryTrendStats: STATS,
  thresholds: thresholds(STAGES, { ...sloStage(`rps_${RATES[0]}`), ...sloStage('recovered_100') }),
};
export const setup = makeSetup(STAGES);
export default function (d) { hit(stageFor(d.start, STAGES), d.tokens); }
export const handleSummary = makeSummary('stress', STAGES);

