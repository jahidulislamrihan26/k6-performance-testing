// STRESS: raise the arrival rate step by step beyond normal until the system degrades, then drop back.
// Goal is to FIND the breaking point and see how it fails (slow? errors?) and whether it recovers.
// Only the first (baseline) step and the final recovery step carry pass/fail thresholds.
import { hit, makeSummary, k6Stages, stageFor, thresholds, sloStage, durS, STATS } from './lib/common.js';

const RATES = (__ENV.STRESS_RATES || '100,200,300,400,500,600,800').split(',').map(Number);
const STAGES = [
  ...RATES.map((r) => ({ name: `rps_${r}`, rate: r, seconds: durS(25) })),
  { name: 'drain_100', rate: 100, seconds: 8 },      // backlog from the overload is cleared here
  { name: 'recovered_100', rate: 100, seconds: durS(20) }, // must be back to normal here
];

export const options = {
  scenarios: { stress: { executor: 'ramping-arrival-rate', startRate: RATES[0], timeUnit: '1s', preAllocatedVUs: 800, maxVUs: 2500, stages: k6Stages(STAGES) } },
  summaryTrendStats: STATS,
  thresholds: thresholds(STAGES, { ...sloStage(`rps_${RATES[0]}`), ...sloStage('recovered_100') }),
};
export function setup() { return { start: Date.now() }; }
export default function (d) { hit(stageFor(d.start, STAGES)); }
export const handleSummary = makeSummary('stress', STAGES);
