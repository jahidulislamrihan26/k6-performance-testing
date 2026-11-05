# Performance Test Report

Run: 2026-11-05T04:28:55.349Z  |  Profile: **full** (duration scale 1)

Load generator and system under test ran on the same machine: Intel(R) Core(TM) i7-7500U CPU @ 2.70GHz, 4 logical cores, 3.9 GB RAM, Windows_NT 10.0.19045, Node v26.13.0, k6 v2.3.0.

## Verdicts

| Test | Purpose | Result | Requests | Avg rate | p95 | p99 | Errors |
|---|---|---|---|---|---|---|---|
| smoke | System and script work | **PASS** | 63 | 3.1 req/s | 33 ms | 44 ms | 0.00% |
| load | Meets SLOs at expected traffic | **PASS** | 11999 | 120 req/s | 21 ms | 34 ms | 0.00% |
| stress | Find breaking point | **PASS** | 74748 | 368.2 req/s | 1510 ms | 1520 ms | 11.79% |
| spike | Survive and recover from a sudden surge | **PASS** | 26420 | 293.5 req/s | 1515 ms | 1525 ms | 29.56% |
| soak | No leak or slow degradation over time | **PASS** | 24017 | 100.1 req/s | 21 ms | 32 ms | 0.00% |
| public-baseline | Gentle check of a real public API | **PASS** | 250 | 8.1 req/s | 361 ms | 487 ms | 0.00% |

SLOs: p95 under 300 ms, p99 under 800 ms, error rate under 1%. Stress is a characterisation test: only its first and recovery steps carry pass/fail thresholds.

## Load test: latency by endpoint

| Endpoint | Share of traffic | p50 | p95 | p99 | max |
|---|---|---|---|---|---|
| list | 70% | 9 ms | 18 ms | 21 ms | 31 ms |
| detail | 20% | 8 ms | 18 ms | 21 ms | 22 ms |
| search | 8% | 21 ms | 27 ms | 34 ms | 41 ms |
| order | 2% | 34 ms | 41 ms | 43 ms | 48 ms |

## Stress test: where does it break?

| Step | Offered | Achieved | p50 | p95 | p99 | Errors | Status |
|---|---|---|---|---|---|---|---|
| rps_100 | 100/s | 99.9/s | 11 ms | 21 ms | 38 ms | 0.00% | ok |
| rps_200 | 200/s | 197.9/s | 10 ms | 21 ms | 31 ms | 0.00% | ok |
| rps_300 | 300/s | 297.9/s | 8 ms | 21 ms | 33 ms | 0.00% | ok |
| rps_400 | 400/s | 397.9/s | 8 ms | 22 ms | 38 ms | 0.00% | ok |
| rps_500 | 500/s | 497.9/s | 21 ms | 56 ms | 67 ms | 0.00% | ok |
| rps_600 | 600/s | 591.8/s | 1502 ms | 1512 ms | 1523 ms | 9.66% | degraded |
| rps_800 | 800/s | 779.8/s | 1505 ms | 1517 ms | 1533 ms | 37.04% | degraded |
| drain_100 | 100/s | 146.1/s | 551 ms | 1512 ms | 1521 ms | 13.86% | degraded |
| recovered_100 | 100/s | 100/s | 11 ms | 21 ms | 34 ms | 0.00% | ok |

**Maximum load within SLO: about 500 req/s.** First degradation at 600 req/s offered (p95 1512 ms, errors 9.66%, achieved 591.8/s).

**Recovery:** first 8 s after the overload p95 was 1512 ms (backlog draining); afterwards p95 21 ms, errors 0.00%. The system recovered fully.

Note: k6 dropped 550 iterations because it could not start requests fast enough. Numbers at the highest steps are partly limited by the load generator sharing a small machine with the system under test.

## Spike test

| Phase | Offered | Achieved | p95 | p99 | Errors |
|---|---|---|---|---|---|
| Baseline | 50/s | 49.9/s | 21 ms | 37 ms | 0.00% |
| Spike | 800/s | 767.2/s | 1516 ms | 1525 ms | 32.86% |
| Drain (first 8 s after) | 50/s | 100.8/s | 1521 ms | 1533 ms | 30.77% |
| Recovered | 50/s | 50/s | 21 ms | 38 ms | 0.00% |

**Recovered to normal after the spike.** p95 was 21 ms at baseline and 1516 ms during the spike, with 32.86% errors during the spike.

## Soak test

| Measure | Value |
|---|---|
| p95 early third | 21 ms |
| p95 late third | 21 ms |
| Latency drift | -0.2% |
| Heap after GC, start to end | 5.56 MB to 5.53 MB (-0.03 MB) |

Run length: 240 s. No leak or degradation detected in this window. A real soak run is hours long.

