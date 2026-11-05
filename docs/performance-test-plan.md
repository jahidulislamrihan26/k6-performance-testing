# Performance Test Plan: Demo Shop

Version 2.0, 2026-11-05.

## 1. Objective
Answer five business questions with measured evidence:
1. Does the shop meet its speed targets at expected traffic? (load)
2. Do real shopper journeys work, with correct data, when many shoppers are online? (journey)
3. How much traffic can it take, how does it fail beyond that, and **which resource runs out**? (stress)
4. Can it survive a sudden surge and return to normal? (spike)
5. Does it stay healthy over a long period? (soak)

## 2. System under test
A small but **real** web shop (`sut/server.js`): plain Node.js with a real SQLite database (`node:sqlite`, built into Node, no dependencies). **Nothing is simulated with timers**; every millisecond of latency comes from real work done on the test machine.

| Part | What it really does |
|---|---|
| Database | 30,000 products (primary key, category index), 100 shoppers, orders and order lines |
| `GET /api/products?category=&page=` | Indexed query, 20 rows per page |
| `GET /api/products/{id}` | Primary-key lookup |
| `GET /api/search?q=` | Un-indexed text scan over name and description (a real, common bottleneck) |
| `POST /api/login` | Password check with PBKDF2 (real CPU cost, like any password hash) |
| `POST /api/orders` | Token required; prices each line from the database, stores the order in a transaction, returns the total |
| `GET /api/orders/{id}` | Token required; only the owner can read it |
| `GET /metrics` | The shop reports its own CPU, event-loop delay and memory (used by the tests, see section 5) |

An overload guard would reject requests with 503 above 256 concurrent requests. In the stress runs it never triggered (the shop reported 0 rejected): the single thread saturates long before 256 requests are in flight, so the real failure mode is different (see the stress results: latency rises first, then the saturated shop refuses new connections).

**Why a local target?** Stress, spike and soak tests deliberately push a system to failure. Doing that to someone else's free public service is abusive and unrepeatable. A local, real application gives repeatable conditions and lets the tests read the shop's own CPU and event-loop figures to **prove** the cause of a slowdown. One very gentle test (5 users, 30 s) does run against the public JSONPlaceholder API as a baseline.

**What it is not:** a production system. It is small, single-process and runs on the same laptop as the load generator. The *method* and the *behaviour pattern* transfer; the exact capacity figure belongs to this code on this machine.

## 3. Service level objectives (pass/fail)
| Measure | Target |
|---|---|
| p95 response time, all requests | under 300 ms |
| p99 response time, all requests | under 800 ms |
| Error rate (non-2xx) | under 1% |
| Functional checks inside load (status, body fields, correct order total) | over 99% pass |

Per-endpoint targets at p95, because endpoints are not equally expensive: list 150 ms, detail 150 ms, search 500 ms, login 400 ms, order 500 ms.

## 4. Test types
| Test | Load shape | Duration | Pass rule |
|---|---|---|---|
| Smoke | 1 user | 20 s | p95 < 200 ms, no errors |
| Load | 400 requests per second (about a third of the lowest capacity measured) after a 50 req/s warm-up | 100 s | All SLOs and all endpoint targets |
| Journey | Closed model: ramp to 100 shoppers, hold, ramp to 400, hold; 0.5 to 2 s think time | about 170 s | Over 99% of journeys succeed, order totals correct, step targets met |
| Stress | Steps of 300, 700, 1100, 1500, 1900, 2300 and 2700 req/s (25 s each), then 8 s drain and 20 s recovery at 100 | about 4 min | Baseline and recovered steps meet SLOs; middle steps are measured to find the breaking point and its cause. The breaking point is the first step that breaks the SLO and is followed by another that does too |
| Spike | 50 req/s, jump to 2500 for 30 s (above every capacity measured), back to 50 | 90 s | Baseline and recovered phases meet SLOs |
| Soak | 300 req/s steady | 4 min (hours in real life) | All SLOs and endpoint targets, late-third p95 within 20% of early third, heap growth under 10 MB |
| Public baseline | 5 users on JSONPlaceholder | 30 s | p95 < 1.5 s, errors < 1% |

Traffic mix for load, stress, spike and soak: 55% category pages, 22% product pages, 12% searches, 4% logins, 7% orders.

## 5. Method decisions
- **Open model for load, stress, spike and soak** (`ramping-arrival-rate`): requests arrive at a set rate whether or not the system keeps up. A closed model hides overload because slow replies reduce the load.
- **Closed model for the journey test** (`ramping-vus`): "how many shoppers can be online at once?" is a closed-model question, with realistic think time.
- **Correlated, realistic data.** In the journey test the order contains products found by the search, and the total is checked against the prices the shopper saw. Test shoppers come from a shared data file (`data/users.json`); logins to get order tokens happen once in setup.
- **Resource telemetry.** Every test samples the shop's own CPU, event-loop delay and memory every 2 seconds, tagged by test step. The report can then state *why* a step degraded (for example "CPU averaged 98% of a core") instead of guessing.
- **Percentiles, not averages**: p95 and p99 show what slow users experience.
- **Named steps** are tagged on every request, so each load level has its own latency, error and resource numbers.
- **Drain vs recovered**: after an overload the first 8 seconds show the backlog clearing (a fixed length, not shortened in the CI profile); recovery is judged on the period after that.
- **Thresholds are the pass/fail contract**: k6 exits with code 99 when one is crossed, which fails CI.

## 6. Environment
Load generator (k6) and the shop run on the same machine. This is a limitation: at the highest request rates the generator competes with the shop for CPU, so numbers near the breaking point are partly limited by the machine (k6 reports "dropped iterations" when it cannot start requests fast enough). The report records the exact hardware and versions of each run. Needs Node 22.13 or newer and k6.

## 7. Risks and limitations
| Risk | Effect | Handling |
|---|---|---|
| Shared CPU between generator and shop | Pessimistic results at very high rates | Documented; dropped iterations reported |
| Small single-process app | Capacity figure is specific to this code and machine | Stated clearly; method and pattern transfer |
| Short soak | Slow leaks may not show in 4 minutes | `SCALE` setting extends duration (SCALE=30 gives 2 hours) |
| Machine noise, shared cores and CPU throttling | **Measured capacity differed by about 2x between runs of the same stress test** (breaking point near 1,100 req/s in one run, near 2,300 in another) | Report shows environment and says so; run the stress test several times, quote a range and plan with the lower end; the lower end of the range is also what the load level was set from |

## 8. How to run
```bash
npm test                   # full suite (about 15 min) and report
npm run test:ci            # short profile used in GitHub Actions
node tools/run-all.js --only load,journey
```
Results are written to `results/`: one JSON per test, `REPORT.md` and `report.html`.

