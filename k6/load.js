// LOAD: expected everyday traffic. Pass = the service meets its SLOs (p95 < 300 ms, p99 < 800 ms, errors < 1%).
// Uses an open workload model (fixed arrival rate): new users keep arriving even if the system slows down,
// so slowdowns show up as latency instead of being hidden by users who politely wait.
import { hit, makeSummary, k6Stages, stageFor, thresholds, sloOverall, durS, STATS } from './lib/common.js';

const STAGES = [
  { name: 'warmup', rate: 50, seconds: durS(20) },
  { name: 'steady_150', rate: 150, seconds: durS(70) },
  { name: 'cooldown', rate: 50, seconds: durS(10) },
];

export const options = {
  scenarios: { load: { executor: 'ramping-arrival-rate', startRate: 50, timeUnit: '1s', preAllocatedVUs: 60, maxVUs: 400, stages: k6Stages(STAGES) } },
  summaryTrendStats: STATS,
  thresholds: thresholds(STAGES, sloOverall()),
};
export function setup() { return { start: Date.now() }; }
export default function (d) { hit(stageFor(d.start, STAGES)); }
export const handleSummary = makeSummary('load', STAGES);
