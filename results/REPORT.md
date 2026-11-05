# Performance Test Report

Run: 2026-11-05T08:55:14.994Z  |  Profile: **full** (duration scale 1)

Load generator and system under test ran on the same machine: Intel(R) Core(TM) i7-7500U CPU @ 2.70GHz, 4 logical cores, 3.9 GB RAM, Windows_NT 10.0.19045, Node v26.13.0, k6 v2.3.0. The system under test is a small real shop (Node.js with a SQLite database of 30,000 products); nothing is simulated.

## Verdicts

| Test | Purpose | Result | Requests | Avg rate | p95 | p99 | Errors | Finished |
|---|---|---|---|---|---|---|---|---|
| smoke | System and script work | **PASS** | 86 | 4.3 req/s | 11 ms | 14 ms | 0.00% | 2026-11-05 08:40 UTC |
| load | Meets SLOs at expected traffic | **PASS** | 29570 | 295 req/s | 17 ms | 29 ms | 0.00% | 2026-11-05 08:42 UTC |
| journey | Real shopper journeys work under load | **PASS** | 35875 | 200.9 req/s | 125 ms | 243 ms | 0.00% | 2026-11-05 08:45 UTC |
| stress | Find breaking point and its cause | **LIMIT FOUND: ~2300 req/s** | 235821 | 1160.9 req/s | 832 ms | 2215 ms | 4.07% | 2026-11-05 09:14 UTC |
| spike | Survive and recover from a sudden surge | **RECOVERED** | 60625 | 672.5 req/s | 2536 ms | 4534 ms | 23.50% | 2026-11-05 09:15 UTC |
| soak | No leak or slow degradation over time | **PASS** | 72140 | 300.4 req/s | 21 ms | 34 ms | 0.00% | 2026-11-05 09:02 UTC |
| public-baseline | Gentle check of a real public API | **PASS** | 262 | 8.5 req/s | 354 ms | 468 ms | 0.00% | 2026-11-05 08:55 UTC |

SLOs: p95 under 300 ms, p99 under 800 ms, error rate under 1%, plus a target per endpoint. Stress is a characterisation test: only its first and recovery steps carry pass/fail thresholds.

## Load test: 400 requests per second, latency by endpoint

| Endpoint | Share of traffic | p50 | p95 | Target (p95) | p99 | max | Result |
|---|---|---|---|---|---|---|---|
| list | 55% | 1 ms | 15 ms | 150 ms | 28 ms | 60 ms | ok |
| detail | 22% | 1 ms | 15 ms | 150 ms | 27 ms | 55 ms | ok |
| search | 12% | 1 ms | 15 ms | 500 ms | 25 ms | 63 ms | ok |
| login | 4% | 14 ms | 30 ms | 400 ms | 46 ms | 65 ms | ok |
| order | 7% | 1 ms | 14 ms | 500 ms | 24 ms | 52 ms | ok |

Resources at steady load: CPU 44.3% (max 56.2%), event-loop delay up to 39.7 ms.

## Shopper journeys

Each virtual shopper browses a category (2 pages), searches, opens a product, logs in, buys 1 to 3 of the products found, and reads the order back, with 0.5 to 2 s of think time between steps. The test checks that the order total equals the prices the shopper saw.

**5110 journeys completed, 100.00% fully successful.** Journey time (including think time): median 7758 ms, p95 9511 ms.

| Step | p50 | p95 | Target (p95) | Result |
|---|---|---|---|---|
| home | 7 ms | 111 ms | 150 ms | ok |
| browse | 12 ms | 120 ms | 150 ms | ok |
| search | 13 ms | 127 ms | 500 ms | ok |
| product | 12 ms | 124 ms | 150 ms | ok |
| login | 27 ms | 141 ms | 400 ms | ok |
| checkout | 13 ms | 126 ms | 500 ms | ok |
| confirm | 13 ms | 124 ms | 150 ms | ok |

| Phase | Shoppers | Requests/s | p95 | Errors | CPU avg (max) |
|---|---|---|---|---|---|
| hold_100 | 100 | 92.2 | 32 ms | 0.00% | 36.2% (max 43.8%) |
| hold_400 | 400 | 358.9 | 143 ms | 0.00% | 81.8% (max 93.6%) |

## Stress test: where does it break, and why?

| Step | Offered | Achieved | p50 | p95 | p99 | Errors | CPU avg (max) | Event-loop delay (max p99) | Status |
|---|---|---|---|---|---|---|---|---|---|
| rps_300 | 300/s | 299.8/s | 1 ms | 21 ms | 35 ms | 0.00% | 36.5% (max 54.4%) | 35.7 ms | ok |
| rps_700 | 700/s | 691.8/s | 1 ms | 14 ms | 27 ms | 0.00% | 50.1% (max 60.3%) | 39.9 ms | ok |
| rps_1100 | 1100/s | 1091.8/s | 1 ms | 10 ms | 21 ms | 0.00% | 58.8% (max 67.9%) | 23.3 ms | ok |
| rps_1500 | 1500/s | 1491.8/s | 1 ms | 13 ms | 25 ms | 0.00% | 62.2% (max 67.1%) | 32.5 ms | ok |
| rps_1900 | 1900/s | 1891.8/s | 3 ms | 21 ms | 36 ms | 0.00% | 67.4% (max 82.1%) | 38.5 ms | ok |
| rps_2300 | 2300/s | 2169.6/s | 29 ms | 145 ms | 655 ms | 0.00% | 88.9% (max 96.9%) | 694.2 ms | ok (generator behind) |
| rps_2700 | 2700/s | 1612/s | 390 ms | 2224 ms | 3336 ms | 21.69% | 81.2% (max 98.5%) | 1083.2 ms | degraded |
| drain_100 | 100/s | 311/s | 2 ms | 901 ms | 1367 ms | 34.61% | 45.6% (max 67.6%) | 1259.3 ms | degraded |
| recovered_100 | 100/s | 100/s | 2 ms | 19 ms | 26 ms | 0.00% | 25.1% (max 29.2%) | 41.2 ms | ok |

**Maximum load within SLO: about 2300 req/s.** First degradation at 2700 req/s offered (p95 2224 ms, errors 21.69%, achieved 1612/s).

**Cause:** The shop's single-threaded event loop saturated (delay up to 1083.2 ms) while its CPU averaged only 81.2%. The load generator runs on the same two physical cores and competes for them, so the shop could not use a full core. It is a CPU-bound limit shared with the load generator, and the exact rate is partly a property of this machine. Memory was not a factor.

**Recovery:** first 8 s after the overload p95 was 901 ms (backlog draining); afterwards p95 19 ms, errors 0.00%. The system recovered fully.

**Repeatability:** capacity on this machine differs between runs of the same test, because the shop and the load generator share two physical cores and the laptop throttles under sustained load. Treat the figure above as one measurement, use the lower end of the range for planning, and see the summary report for the other recorded runs.

Note: k6 dropped 29699 iterations because it could not start requests fast enough. Numbers at the highest steps are partly limited by the load generator sharing a small machine with the system under test.

## Spike test

| Phase | Offered | Achieved | p95 | p99 | Errors | CPU avg (max) |
|---|---|---|---|---|---|---|
| Baseline | 50/s | 49.9/s | 7 ms | 25 ms | 0.00% | 13.2% (max 21%) |
| Spike | 2500/s | 1881.2/s | 2554 ms | 4714 ms | 24.60% | 75.7% (max 96.3%) |
| Drain (first 8 s after) | 50/s | 190.9/s | 1857 ms | 2060 ms | 23.84% | 34.2% (max 70.9%) |
| Recovered | 50/s | 50/s | 6 ms | 24 ms | 0.00% | 10% (max 15.7%) |

**Recovered to normal after the spike.** p95 was 7 ms at baseline and 2554 ms during the spike, with 24.60% errors during the spike.

## Soak test

| Measure | Value |
|---|---|
| p95 early third | 21 ms |
| p95 late third | 20 ms |
| Latency drift | -1.8% |
| Heap after garbage collection, early vs late third (average) | 6.27 MB vs 6.54 MB (+0.27 MB) |
| Peak process memory (RSS) | 59.1 MB |

Run length: 240 s. No leak or degradation detected in this window. A real soak run is hours long.

