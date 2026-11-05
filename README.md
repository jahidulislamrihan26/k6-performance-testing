# Performance Testing Project: k6 on a Real Demo Shop

Smoke, load, shopper-journey, stress, spike and soak tests with clear pass/fail targets, resource telemetry that explains *why* the shop slows down, a generated report, and findings with recommendations.

## Result in one look
| Question | Answer (measured) |
|---|---|
| Fast enough at normal traffic? | **Yes.** 400 req/s: p95 17 ms (target 300 ms), 0% errors, every endpoint within its own target |
| Do real shopper journeys work? | **Yes.** 5,110 journeys (browse, search, login, order, read back), 100% successful, order totals correct, up to 400 shoppers |
| How much can it take? | **At least 900 req/s** in every run; up to about 2,300 in the best runs. Plan with the low end |
| How does it fail? | Latency first, then **refused connections**. Recovers fully within seconds |
| What runs out? | **CPU of one Node.js process** (event loop delayed up to about 1 s); memory is not a factor |
| Is the capacity number stable? | **No: it varied about 2x between runs** (shop and load generator share two cores, laptop throttles). The report says so and gives a range |
| Healthy over time? | **Yes** in a 4-minute soak: flat latency, flat memory |

Full write-up: [docs/test-summary-report.md](docs/test-summary-report.md). Interactive report: [open it live](https://jahidulislamrihan26.github.io/sqa-portfolio/performance/) (also saved as [results/report.html](results/report.html)).

## What is inside
| Path | Purpose |
|---|---|
| [docs/performance-test-plan.md](docs/performance-test-plan.md) | Objectives, targets (SLOs), test types, method, risks |
| [docs/test-summary-report.md](docs/test-summary-report.md) | Findings, resource analysis, three stress runs compared, recommendations, limitations |
| `k6/smoke.js, load.js, journey.js, stress.js, spike.js, soak.js` | The six test types |
| `k6/public-baseline.js` | Very gentle check of the real JSONPlaceholder API |
| `k6/lib/common.js` | Traffic mix, test shoppers, tokens, resource sampling, thresholds, per-step tagging, JSON summaries |
| `sut/server.js` | The demo shop: Node.js with a real SQLite database (no simulation, no dependencies) |
| `data/users.json` | 100 test shoppers shared by all virtual users (`npm run data` regenerates it) |
| `tools/run-all.js`, `tools/report.js` | Runner and report generator |
| `results/` | JSON per test, `REPORT.md`, `report.html` |

## Why these choices
- **A real application as the target.** Earlier versions simulated delays with timers, so the numbers described a model. Now the shop runs real queries on a real database (an indexed list, a primary-key lookup, an un-indexed text search), real password hashing and real order transactions. Stress, spike and soak tests deliberately push a system to failure, which is why they run against a local shop and not against someone else's free public service.
- **Open model (arrival rate) for load, stress, spike and soak.** Requests keep arriving even when the system slows, like real traffic. Fixed-user tests hide overload because slow replies reduce the load.
- **Closed model for journeys.** "How many shoppers can be online at once?" is a closed-model question, with think time and correlated data: the order contains products from the search, and its total is checked against the prices the shopper saw.
- **Resource telemetry.** The shop reports its own CPU, event-loop delay and memory; every test samples them and tags them by step, so the report can prove a cause.
- **Percentiles (p95, p99), not averages**, with an overall target and a target per endpoint, turned into pass/fail thresholds.
- **Named steps** so each load level has its own numbers, and a separate "drain" period so recovery is judged fairly.
- **Variance is reported, not hidden.** The same stress test gave breaking points a factor of two apart; the report states this and recommends the lower figure.

## Run it
Needs [k6](https://k6.io/docs/get-started/installation/) and Node 22.13 or newer.
```bash
npm test          # full suite, about 20 minutes, writes results/
npm run test:ci   # short profile (smoke, load, journey, spike) used in GitHub Actions
node tools/run-all.js --only load,journey
SCALE=30 node tools/run-all.js --only soak     # a 2-hour soak
```
k6 exits with code 99 when a threshold is crossed, so a missed target fails the run and the CI job. With `--only`, results of the tests that were not re-run are kept in the report.

## Limits
- Load generator and shop share one small laptop (2 physical cores): capacity is unstable between runs and the top stress steps are partly generator-limited (k6 dropped about 29,700 iterations).
- A small single-process app; the method transfers, the exact numbers belong to this code and machine.
- Short soak (4 minutes). The public-API test is intentionally tiny (5 users, 30 s).

