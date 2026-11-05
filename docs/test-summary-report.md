# Performance Test Summary: Demo Shop

| | |
|---|---|
| System under test | A small real shop: Node.js, one process, SQLite database with 30,000 products and 100 shoppers. Nothing is simulated |
| Run date | 2026-11-05 |
| Tool | k6 2.3.0 (open model for load, stress, spike and soak; closed model for shopper journeys) |
| Machine | Intel Core i7-7500U, 2 physical cores (4 logical), 3.9 GB RAM, Windows 10. **The load generator and the shop share this machine** |
| Full numbers | [live HTML report](https://jahidulislamrihan26.github.io/sqa-portfolio/performance/), [results/REPORT.md](../results/REPORT.md), raw JSON per test in `results/` |

## 1. Executive summary
At normal traffic the shop is very fast: **400 requests per second give p95 17 ms and no errors**, against a target of 300 ms, and every endpoint meets its own target. **Real shopper journeys work**: 5,110 complete journeys (browse, search, product page, login, order, read back) at up to 400 shoppers at once all succeeded and every order total was correct.

The shop can carry **at least 900 requests per second** within its targets in every run, and up to about 2,300 in the best runs. Beyond its limit it degrades in a clear order: **latency first, then refused connections**, and it **recovers fully** a few seconds after traffic falls. The limit is **CPU**: the shop is a single Node.js process, and at the breaking point its event loop was delayed by up to a second.

**Important:** the breaking point was **not stable between runs**. The same stress test broke at about 1,100 requests per second in one run and about 2,700 in another (section 4). The most likely reasons are that the shop and the load generator compete for the same two CPU cores and that the laptop throttles under sustained load. So this report gives a range and recommends planning with the low end (about 900 requests per second).

**Verdict:** meets its targets at expected traffic and over a long period; has little headroom beyond about 400 concurrent shoppers; needs more than one process (or more cores) before a big sale.

## 2. Results
| Test | Result | Key numbers |
|---|---|---|
| Smoke | PASS | 86 requests, p95 11 ms, 0 errors |
| Load (400 req/s) | PASS | 29,570 requests, p95 17 ms, p99 29 ms, 0 errors, shop CPU 44% |
| Shopper journeys (up to 400 shoppers) | PASS | 5,110 journeys, 100% successful, order totals correct, step p95 under 145 ms |
| Stress | Limit found | Healthy to 1,900 to 2,300 req/s in the final run, broke at 2,700 (see section 4 for all runs) |
| Spike (50 to 2,500 req/s) | RECOVERED | During the spike p95 2.5 s and 24.6% errors; back to p95 6 ms afterwards |
| Soak (4 min, 300 req/s) | PASS | p95 21 ms early, 20 ms late (-1.8%); memory flat |
| Public baseline (JSONPlaceholder, 5 users) | PASS | 262 requests, p95 354 ms, 0 errors |

### Load: every endpoint meets its target (400 req/s)
| Endpoint | Share | p95 | Target |
|---|---|---|---|
| Category page | 55% | 15 ms | 150 ms |
| Product page | 22% | 15 ms | 150 ms |
| Search | 12% | 15 ms | 500 ms |
| Login | 4% | 30 ms | 400 ms |
| Order | 7% | 14 ms | 500 ms |

### Shopper journeys
| Phase | Shoppers | Requests/s | p95 | Errors | Shop CPU |
|---|---|---|---|---|---|
| Hold 100 | 100 | 92 | 32 ms | 0% | 36% |
| Hold 400 | 400 | 359 | 143 ms | 0% | 82% |

400 shoppers use 82% of the CPU for only 359 requests per second, while the plain mixed load used 44% for 400. The reason is the shape of a journey: **one request in seven is a login**, against one in twenty-five in the mixed load, and a login checks a password hash that costs **4.9 ms of CPU** (measured separately), many times more than a product page. At 400 shoppers there is little headroom left.

## 3. Resources: what runs out
The shop reports its own CPU and event-loop delay every 2 seconds, so the cause of a slowdown is measured, not guessed:

| Offered (final stress run) | p95 | Errors | Shop CPU (average) | Event-loop delay (worst p99) |
|---|---|---|---|---|
| 300 | 21 ms | 0% | 36% | 36 ms |
| 1,100 | 10 ms | 0% | 59% | 23 ms |
| 1,900 | 21 ms | 0% | 67% | 39 ms |
| 2,300 | 145 ms | 0% | 89% | 694 ms |
| 2,700 | 2,224 ms | 21.7% | 81% | 1,083 ms |

Memory was never a factor (about 60 MB for the whole process). The limit is a single thread running out of CPU, and the load generator competes with it for the same cores.

## 4. Stress: three runs, three answers
| Run | Healthy up to | First step to break the target | Shop CPU at the break | Errors in the worst step |
|---|---|---|---|---|
| A: first full suite (stress after load and journey tests) | 900 req/s | 1,100 (p95 322 ms); 1,500 had p95 1.8 s | 99.5% | 13.9%, refused connections |
| B: stress alone, fresh shop, steps 500 to 2,700 | 1,900 (p95 70 ms, p99 739 ms) | 2,300 (p95 354 ms) | 80% (event-loop delay 991 ms) | 19.4% at 2,700 |
| C: final committed run, steps 300 to 2,700 | 2,300 (p95 145 ms, p99 655 ms) | 2,700 (p95 2.2 s) | 81% (event-loop delay 1,083 ms) | 21.7% |

Run A's raw file was overwritten by later runs; its figures are recorded here from the run output. The spread is about **2x** from the same code on the same machine. Everything below the lowest healthy step (900 req/s) held in all three runs.

**How it fails:** when the shop saturates, latency rises first (p99 before p95), and above that the operating system starts **refusing new connections** ("connection actively refused"). The shop's own 503 overload guard never triggered (it reported 0 rejected): its single thread saturates long before 256 requests are in flight.

**Recovery:** after the overload, the first 8 seconds still show the backlog draining (p95 up to 0.9 s, errors while refused connections clear). In the following 20 seconds the shop was fully normal (p95 19 ms, 0 errors) in every run.

## 5. Spike
| Phase | Offered | Achieved | p95 | Errors |
|---|---|---|---|---|
| Baseline | 50/s | 50/s | 7 ms | 0% |
| Spike | 2,500/s | 1,881/s | 2,554 ms | 24.6% |
| First 8 s after | 50/s | 191/s | 1,857 ms | 23.8% |
| Recovered | 50/s | 50/s | 6 ms | 0% |

A jump to a rate above every capacity measured makes about a quarter of requests fail for the length of the spike and for a few seconds after it. There is no lasting damage.

## 6. Soak
Over 4 minutes at 300 req/s (72,140 requests): p95 21 ms in the first third and 20 ms in the last; heap after garbage collection 6.3 MB early and 6.5 MB late; peak process memory 59 MB. **No leak or slow degradation in this window.** A real soak run lasts hours (`SCALE=30` gives 2 hours).

## 7. Recommendations (for this system)
1. **Use more than one core.** The limit is one single-threaded process. Run several worker processes (Node cluster or several instances behind a balancer) or move heavy work to worker threads.
2. **Treat login as the expensive request.** It is the costliest operation per request (4.9 ms of CPU). Cache sessions, rate-limit logins, and move hashing off the main thread so a login surge cannot slow product pages.
3. **Shed load before the cliff.** The 503 guard never fired because it counts concurrent requests; use event-loop delay or CPU as the signal and answer 503 early, instead of letting the operating system refuse connections.
4. **Autoscale or alert at about 60 to 65% CPU.** Latency stayed flat up to that level in every run.
5. **Plan with about 900 req/s per instance and about 400 concurrent shoppers** until the measurements are repeated on a machine where the load generator has its own cores.

## 8. Limitations (please read)
- **Shared machine, unstable capacity.** The load generator and the shop share two cores, and the laptop throttles. This is why the breaking point moved by about 2x between runs. For a firm capacity number, run the generator on a separate machine and repeat the stress test several times.
- **Load generator limits.** At the highest steps k6 dropped about 29,700 iterations because it could not start requests fast enough, so the top rows slightly understate the offered load.
- **A small app.** Real code and a real database, but small and single-process. The method and the pattern (flat, then a cliff, latency before errors, full recovery) transfer; the exact numbers belong to this code and machine.
- **Short soak** (4 min), so slow leaks could be missed.
- **Public test is tiny** (5 users, 30 s) so as not to burden a free third-party service.
- Tests were not all run at the same moment: stress, spike and soak were re-run after smoke, load and journey (finish times are in the report).

