// SPIKE: sudden jump in traffic (a flash sale or a viral link), then back to normal.
// Questions: does it survive the jump, how bad is it during the spike, and does it RECOVER afterwards?
// Baseline and recovery carry pass/fail thresholds; the spike itself is measured and reported.
import { hit, makeSummary, k6Stages, stageFor, thresholds, sloStage, durS, STATS } from './lib/common.js';

const SPIKE = Number(__ENV.SPIKE_RATE || 800);
const STAGES = [
  { name: 'baseline_50', rate: 50, seconds: durS(25) },
  { name: `spike_${SPIKE}`, rate: SPIKE, seconds: durS(30) },
  { name: 'drain_50', rate: 50, seconds: 8 },      // backlog from the spike is cleared here
  { name: 'recovered_50', rate: 50, seconds: durS(27) }, // must be back to normal here
];

export const options = {
  scenarios: { spike: { executor: 'ramping-arrival-rate', startRate: 50, timeUnit: '1s', preAllocatedVUs: 800, maxVUs: 2500, stages: k6Stages(STAGES) } },
  summaryTrendStats: STATS,
  thresholds: thresholds(STAGES, { ...sloStage('baseline_50'), ...sloStage('recovered_50') }),
};
export function setup() { return { start: Date.now() }; }
export default function (d) { hit(stageFor(d.start, STAGES)); }
export const handleSummary = makeSummary('spike', STAGES);
