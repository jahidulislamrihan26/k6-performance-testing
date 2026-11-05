# Performance Test Plan: Demo Shop API

Version 1.0, 2026-11-05.

## 1. Objective
Answer four business questions with measured evidence:
1. Does the shop meet its speed targets at expected traffic? (load)
2. How much traffic can it take, and how does it fail beyond that? (stress)
3. Can it survive a sudden surge and return to normal? (spike)
4. Does it stay healthy over a long period? (soak)

## 2. System under test
A demo shop API (`sut/server.js`, plain Node, no dependencies) that models a typical web application with a small database connection pool.

| Endpoint | Behaviour | Share of traffic |
|---|---|---|
| `GET /api/products?page=` | Product list, one DB call (4 to 10 ms) | 70% |
| `GET /api/products/{id}` | Product detail, one DB call (3 to 6 ms) | 20% |
| `GET /api/search?q=` | Text search: 2 ms CPU on the event loop plus a DB call (10 to 20 ms) | 8% |
| `POST /api/orders` | Create order, validates input, DB call (20 to 40 ms) | 2% |
| `GET /health`, `GET /metrics` | Health and memory/pool statistics | n/a |

Rules built into the model: a pool of **4 database connections** (on purpose small, so the breaking point sits well inside what one laptop can generate; change with `POOL_SIZE`); a request that waits more than **1.5 s** for a connection gets **503**.

**Why a local target and not a public site?** Stress, spike and soak tests deliberately push a system to failure. Doing that to someone else's free public service is abusive and unrepeatable. A local target gives the same reproducible conditions for everyone, and the answers (knee point, recovery, leaks) are real measurements of that system. The latencies are simulated, so the absolute numbers describe this model and this machine, not a real production system; the *method* and the *findings* are what transfer. One very gentle test (5 users, 30 s) does run against the public JSONPlaceholder API as a baseline.

## 3. Service level objectives (pass/fail)
| Measure | Target |
|---|---|
| p95 response time | under 300 ms |
| p99 response time | under 800 ms |
| Error rate (non-2xx) | under 1% |
| Functional checks inside load (status, body fields) | over 99% pass |

## 4. Test types
| Test | Load shape | Duration | Pass rule |
|---|---|---|---|
| Smoke | 1 user | 20 s | p95 < 200 ms, no errors |
| Load | 50 to 150 req/s, hold 150 | 100 s | All SLOs |
| Stress | Steps of 100, 200, 300, 400, 500, 600, 800 req/s (25 s each), then 8 s drain and 20 s recovery at 100 | about 3.5 min | Baseline step and final recovered step meet SLOs. The middle steps are measured to find the breaking point |
| Spike | 50 req/s, jump to 800 for 30 s, back to 50 | 90 s | Baseline and recovered phases meet SLOs |
| Soak | 100 req/s steady | 4 min (hours in real life) | All SLOs, late-third p95 within 20% of early third, heap growth under 10 MB |
| Public baseline | 5 users on JSONPlaceholder | 30 s | p95 < 1.5 s, errors < 1% |

## 5. Method decisions
- **Open workload model** (`ramping-arrival-rate`): requests arrive at a set rate whether or not the system keeps up. A closed model (fixed users who wait for each reply) hides overload because slow responses reduce the load.
- **Realistic traffic mix** with weighted endpoints instead of hammering one URL.
- **Named steps** are tagged on every request, so each load level has its own latency and error numbers.
- **Percentiles, not averages**: p95 and p99 show what slow users experience.
- **Drain vs recovered**: after an overload the first seconds show backlog clearing; recovery is judged on the period after that.
- **Thresholds are the pass/fail contract**: k6 exits with code 99 when one is crossed, which fails CI.

## 6. Environment
Load generator (k6) and the system under test run on the same machine. This is a limitation: at the highest request rates the generator competes with the system for CPU, so numbers near the breaking point are partly limited by the machine. The report records the exact hardware and versions of each run.

## 7. Risks and limitations
| Risk | Effect | Handling |
|---|---|---|
| Shared CPU between generator and target | Pessimistic results at very high rates | Documented; dropped iterations reported |
| Simulated latencies | Not a real system | Stated clearly; findings are about the method and the behaviour pattern |
| Short soak | Slow leaks may not show in 4 minutes | `SCALE` setting extends duration (SCALE=30 gives 2 hours) |
| Machine noise (other programs) | Run-to-run variation | Report shows environment; repeat runs before trusting small differences |

## 8. How to run
```bash
npm test                   # full suite (about 12 min) and report
npm run test:ci            # short profile used in GitHub Actions
node tools/run-all.js --only load,spike
```
Results are written to `results/`: one JSON per test, `REPORT.md` and `report.html`.
