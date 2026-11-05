# Performance Testing Project: k6 on a Demo Shop API

Smoke, load, stress, spike and soak tests with clear pass/fail targets, a generated report, and findings with recommendations.

## Result in one look
| Question | Answer (measured) |
|---|---|
| Fast enough at normal traffic? | **Yes.** 150 req/s: p95 21 ms (target 300 ms), 0% errors |
| How much can it take? | **About 500 req/s** within targets, about 3.3x planned load. Safe limit nearer 400 to 450 |
| How does it fail? | **A cliff:** p95 56 ms at 500 req/s, 1,512 ms and 9.7% errors at 600 req/s. Fails fast with 503, stays up |
| Recovers after a surge? | **Yes**, fully, within seconds of load dropping |
| Healthy over time? | **Yes** in a 4-minute soak: flat latency, flat memory |
| Root cause | The 4-connection database pool is the bottleneck |

Full write-up: [docs/test-summary-report.md](docs/test-summary-report.md). Interactive report: [open it live](https://jahidulislamrihan26.github.io/sqa-portfolio/performance/) (also saved as [results/report.html](results/report.html)).

## What is inside
| Path | Purpose |
|---|---|
| [docs/performance-test-plan.md](docs/performance-test-plan.md) | Objectives, targets (SLOs), test types, method, risks |
| [docs/test-summary-report.md](docs/test-summary-report.md) | Findings, stress table, recommendations, limitations |
| `k6/smoke.js, load.js, stress.js, spike.js, soak.js` | The five test types |
| `k6/public-baseline.js` | Very gentle check of the real JSONPlaceholder API |
| `k6/lib/common.js` | Traffic mix, thresholds, per-step tagging, JSON summaries |
| `sut/server.js` | Demo shop API used as the target (no dependencies) |
| `tools/run-all.js`, `tools/report.js` | Runner and report generator |
| `results/` | JSON per test, `REPORT.md`, `report.html`, run log from the last run |

## Why these choices
- **Open workload model (arrival rate).** Requests keep arriving even when the system slows, like real traffic. Fixed-user tests hide overload because slow replies reduce the load.
- **Realistic mix:** 70% browse, 20% product page, 8% search, 2% orders, with functional checks on every response.
- **Percentiles (p95, p99), not averages**, plus error rate, all against explicit targets that turn into pass/fail thresholds.
- **Named steps** so each load level has its own numbers, and a separate "drain" period so recovery is judged fairly.
- **A local target for the heavy tests.** Stress, spike and soak deliberately push a system until it fails; doing that to someone else's free public service would be abusive and unrepeatable. The target is a model (simulated latencies, a small DB pool), so exact numbers describe it, not real production; the method and the behaviour pattern are what matter. See the limitations in the summary report.

## Run it
Needs [k6](https://k6.io/docs/get-started/installation/) and Node 20+.
```bash
npm test          # full suite, about 12 minutes, writes results/
npm run test:ci   # short profile (smoke, load, spike) used in GitHub Actions
node tools/run-all.js --only load,stress
SCALE=30 node tools/run-all.js --only soak     # a 2-hour soak
```
k6 exits with code 99 when a threshold is crossed, so a missed target fails the run and the CI job.
