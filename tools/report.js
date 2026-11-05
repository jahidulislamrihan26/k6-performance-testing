// Builds results/REPORT.md and results/report.html from the JSON files k6 wrote.
const fs = require('fs');
const path = require('path');
const R = path.join(__dirname, '..', 'results');
const rd = (n) => { try { return JSON.parse(fs.readFileSync(path.join(R, n), 'utf8')); } catch { return null; } };
const run = rd('run.json');
if (!run) { console.error('No results/run.json'); process.exit(1); }
const SLO = { p95: 300, p99: 800, err: 0.01, endpoints: { list: 150, detail: 150, search: 500, login: 400, order: 500 } };
const MIX = { list: '55%', detail: '22%', search: '12%', login: '4%', order: '7%' };
const exit = Object.fromEntries(run.tests.map((t) => [t.test, t.exitCode]));
const data = Object.fromEntries(run.tests.map((t) => [t.test, rd(`${t.test}.json`)]));
const ms = (v) => (v == null ? 'n/a' : `${Math.round(v)} ms`);
const pct = (v) => (v == null ? 'n/a' : `${(100 * v).toFixed(2)}%`);
const cpu = (r) => (r ? `${r.cpuAvg}% (max ${r.cpuMax}%)` : 'n/a');
const lag = (r) => (r && r.lagP99Max != null ? `${r.lagP99Max} ms` : 'n/a');

// ---------- analysis (declared before verdict(), which uses it)
const s = data.stress;
let knee = null, sustain = null, recovery = null;
if (s) {
  const steps = s.stages.filter((x) => x.name.startsWith('rps_'));
  // A step is "bad" when latency or errors break the SLO. The breaking point is the first bad step whose NEXT step is also bad
  // (or the last step), so one noisy step does not count. Falling short of the offered rate is shown but not used,
  // because the load generator shares the machine and can fall behind on its own.
  const isBad = (st) => st.latency.p95 > SLO.p95 || st.failedRate > SLO.err;
  steps.forEach((st, i) => {
    if (knee) return;
    if (isBad(st) && (i === steps.length - 1 || isBad(steps[i + 1]))) knee = st;
    else if (!isBad(st)) sustain = st;
  });
  const rec = s.stages.find((x) => x.name === 'recovered_100'), dr = s.stages.find((x) => x.name === 'drain_100');
  recovery = rec && { drainP95: dr && dr.latency.p95, p95: rec.latency.p95, err: rec.failedRate, ok: rec.latency.p95 < SLO.p95 && rec.failedRate < SLO.err };
}
const sp = data.spike;
let spike = null;
if (sp) {
  const g = (p) => sp.stages.find((x) => x.name.startsWith(p));
  const b = g('baseline'), k = g('spike'), d = g('drain'), r = g('recovered');
  spike = { b, k, d, r, ok: r && r.latency.p95 < SLO.p95 && r.failedRate < SLO.err };
}
const sk = data.soak;
let soak = null;
if (sk) {
  const t1 = sk.stages[0], t3 = sk.stages[sk.stages.length - 1];
  soak = { t1: t1.latency.p95, t3: t3.latency.p95, drift: +(100 * (t3.latency.p95 - t1.latency.p95) / t1.latency.p95).toFixed(1), heap: sk.heap, rss: sk.memory && sk.memory.rssMaxMb };
}
// What ran out at the breaking point?
const cause = (st) => {
  if (!st || !st.resources) return null;
  const c = st.resources.cpuAvg, l = st.resources.lagP99Max;
  if (c >= 85) return `CPU was the limit: the shop's single Node.js process averaged ${c}% of a core (peak ${st.resources.cpuMax}%) and the event loop was delayed by up to ${l} ms, so requests queued. Memory was not a factor.`;
  if (l >= 200) return `The shop's single-threaded event loop saturated (delay up to ${l} ms) while its CPU averaged only ${c}%. The load generator runs on the same two physical cores and competes for them, so the shop could not use a full core. It is a CPU-bound limit shared with the load generator, and the exact rate is partly a property of this machine. Memory was not a factor.`;
  return `The shop's CPU averaged only ${c}% and event-loop delay stayed under 200 ms at this step, so the shop itself was not the limit; look at the load generator (dropped iterations) and the network.`;
};

// Stress and spike are characterisation tests: "PASS" would be misleading next to 12% errors or 1.5 s latency.
const verdict = (t) => {
  if (exit[t] === undefined) return 'not run';
  if (exit[t] !== 0) return 'FAIL';
  if (t === 'stress' && knee) return `LIMIT FOUND: ~${sustain ? sustain.rate : '?'} req/s`;
  if (t === 'spike' && spike) return spike.ok ? 'RECOVERED' : 'NOT RECOVERED';
  return 'PASS';
};
const verdictClass = (t) => (/^(PASS|RECOVERED)$/.test(verdict(t)) ? 'pass' : /LIMIT FOUND/.test(verdict(t)) ? 'info' : 'fail');

// ---------- markdown
const L = [];
L.push('# Performance Test Report', '');
L.push(`Run: ${run.env.date}  |  Profile: **${run.env.profile}** (duration scale ${run.env.scale})`, '');
L.push(`Load generator and system under test ran on the same machine: ${run.env.cpu}, ${run.env.cores} logical cores, ${run.env.memGb} GB RAM, ${run.env.os}, Node ${run.env.node}, k6 ${run.env.k6}. The system under test is a small real shop (Node.js with a SQLite database of 30,000 products); nothing is simulated.`, '');
const fin = (t) => { const d = data[t] && data[t].finishedAt; return d ? d.slice(0, 16).replace('T', ' ') + ' UTC' : 'n/a'; };
L.push('## Verdicts', '', '| Test | Purpose | Result | Requests | Avg rate | p95 | p99 | Errors | Finished |', '|---|---|---|---|---|---|---|---|---|');
const purpose = { smoke: 'System and script work', load: 'Meets SLOs at expected traffic', journey: 'Real shopper journeys work under load', stress: 'Find breaking point and its cause', spike: 'Survive and recover from a sudden surge', soak: 'No leak or slow degradation over time', 'public-baseline': 'Gentle check of a real public API' };
for (const t of run.tests) {
  const d = data[t.test]; const o = d && d.overall;
  L.push(`| ${t.test} | ${purpose[t.test] || ''} | **${verdict(t.test)}** | ${o ? o.requests : 'n/a'} | ${o ? o.rps + ' req/s' : 'n/a'} | ${o ? ms(o.latency.p95) : 'n/a'} | ${o ? ms(o.latency.p99) : 'n/a'} | ${o ? pct(o.failedRate) : 'n/a'} | ${fin(t.test)} |`);
}
L.push('', `SLOs: p95 under ${SLO.p95} ms, p99 under ${SLO.p99} ms, error rate under ${SLO.err * 100}%, plus a target per endpoint. Stress is a characterisation test: only its first and recovery steps carry pass/fail thresholds.`, '');

if (data.load) {
  const steady = data.load.stages.find((x) => x.name.startsWith('steady'));
  L.push(`## Load test: ${steady ? steady.rate : ''} requests per second, latency by endpoint`, '', '| Endpoint | Share of traffic | p50 | p95 | Target (p95) | p99 | max | Result |', '|---|---|---|---|---|---|---|---|');
  for (const [e, d] of Object.entries(data.load.endpoints)) L.push(`| ${e} | ${MIX[e] || ''} | ${ms(d.med)} | ${ms(d.p95)} | ${SLO.endpoints[e]} ms | ${ms(d.p99)} | ${ms(d.max)} | ${d.p95 < SLO.endpoints[e] ? 'ok' : 'MISSED'} |`);
  if (steady && steady.resources) L.push('', `Resources at steady load: CPU ${cpu(steady.resources)}, event-loop delay up to ${lag(steady.resources)}.`);
  L.push('');
}
const jn = data.journey;
if (jn && jn.journey) {
  const J = jn.journey;
  L.push('## Shopper journeys', '', `Each virtual shopper browses a category (2 pages), searches, opens a product, logs in, buys 1 to 3 of the products found, and reads the order back, with 0.5 to 2 s of think time between steps. The test checks that the order total equals the prices the shopper saw.`, '', `**${J.completed} journeys completed, ${pct(J.success)} fully successful.** Journey time (including think time): median ${ms(J.durationMs.p50)}, p95 ${ms(J.durationMs.p95)}.`, '', '| Step | p50 | p95 | Target (p95) | Result |', '|---|---|---|---|---|');
  for (const [k, d] of Object.entries(J.steps)) L.push(`| ${k} | ${ms(d.p50)} | ${ms(d.p95)} | ${d.target} ms | ${d.p95 < d.target ? 'ok' : 'MISSED'} |`);
  L.push('', '| Phase | Shoppers | Requests/s | p95 | Errors | CPU avg (max) |', '|---|---|---|---|---|---|');
  for (const st of jn.stages) if (!st.name.startsWith('ramp')) L.push(`| ${st.name} | ${st.rate} | ${st.rps} | ${ms(st.latency.p95)} | ${pct(st.failedRate)} | ${cpu(st.resources)} |`);
  L.push('');
}
if (s) {
  L.push('## Stress test: where does it break, and why?', '', '| Step | Offered | Achieved | p50 | p95 | p99 | Errors | CPU avg (max) | Event-loop delay (max p99) | Status |', '|---|---|---|---|---|---|---|---|---|---|');
  for (const st of s.stages) {
    const bad = st.latency.p95 > SLO.p95 || st.failedRate > SLO.err;
    const behind = !bad && st.name.startsWith('rps_') && st.rps < 0.95 * st.rate;
    L.push(`| ${st.name} | ${st.rate}/s | ${st.rps}/s | ${ms(st.latency.med)} | ${ms(st.latency.p95)} | ${ms(st.latency.p99)} | ${pct(st.failedRate)} | ${cpu(st.resources)} | ${lag(st.resources)} | ${bad ? 'degraded' : behind ? 'ok (generator behind)' : 'ok'} |`);
  }
  L.push('', `**Maximum load within SLO: about ${sustain ? sustain.rate : 'n/a'} req/s.** ${knee ? `First degradation at ${knee.rate} req/s offered (p95 ${ms(knee.latency.p95)}, errors ${pct(knee.failedRate)}, achieved ${knee.rps}/s).` : 'No degradation seen at the highest step.'}`);
  const why = cause(knee || s.stages.filter((x) => x.name.startsWith('rps_')).pop());
  if (why) L.push('', `**Cause:** ${why}`);
  if (recovery) L.push('', `**Recovery:** first 8 s after the overload p95 was ${ms(recovery.drainP95)} (backlog draining); afterwards p95 ${ms(recovery.p95)}, errors ${pct(recovery.err)}. ${recovery.ok ? 'The system recovered fully.' : 'The system did NOT return to normal.'}`);
  L.push('', '**Repeatability:** capacity on this machine differs between runs of the same test, because the shop and the load generator share two physical cores and the laptop throttles under sustained load. Treat the figure above as one measurement, use the lower end of the range for planning, and see the summary report for the other recorded runs.');
  if (s.overall.dropped) L.push('', `Note: k6 dropped ${s.overall.dropped} iterations because it could not start requests fast enough. Numbers at the highest steps are partly limited by the load generator sharing a small machine with the system under test.`);
  L.push('');
}
if (spike) {
  const row = (n, x) => `| ${n} | ${x.rate}/s | ${x.rps}/s | ${ms(x.latency.p95)} | ${ms(x.latency.p99)} | ${pct(x.failedRate)} | ${cpu(x.resources)} |`;
  L.push('## Spike test', '', '| Phase | Offered | Achieved | p95 | p99 | Errors | CPU avg (max) |', '|---|---|---|---|---|---|---|', row('Baseline', spike.b), row('Spike', spike.k), row('Drain (first 8 s after)', spike.d), row('Recovered', spike.r), '', `**${spike.ok ? 'Recovered to normal after the spike.' : 'Did NOT recover to normal after the spike.'}** p95 was ${ms(spike.b.latency.p95)} at baseline and ${ms(spike.k.latency.p95)} during the spike, with ${pct(spike.k.failedRate)} errors during the spike.`, '');
}
if (soak) {
  const h = soak.heap || {};
  L.push('## Soak test', '', '| Measure | Value |', '|---|---|', `| p95 early third | ${ms(soak.t1)} |`, `| p95 late third | ${ms(soak.t3)} |`, `| Latency drift | ${soak.drift}% |`, `| Heap after garbage collection, early vs late third (average) | ${h.firstAvgMb} MB vs ${h.lastAvgMb} MB (${h.growthMb >= 0 ? '+' : ''}${h.growthMb} MB) |`, `| Peak process memory (RSS) | ${soak.rss} MB |`, '', `Run length: ${sk.durationSec} s. ${Math.abs(soak.drift) < 20 && h.growthMb < 10 ? 'No leak or degradation detected in this window.' : 'Possible degradation: investigate.'} A real soak run is hours long.`, '');
}
fs.writeFileSync(path.join(R, 'REPORT.md'), L.join('\n') + '\n');

// ---------- HTML
const css = 'body{font:15px/1.5 system-ui,Segoe UI,Arial;margin:0;background:#f5f6f8;color:#1b2430}main{max-width:1000px;margin:auto;padding:24px}h1{margin:0 0 4px}h2{margin-top:32px}.card{background:#fff;border-radius:8px;padding:16px;box-shadow:0 1px 3px #0002;margin:12px 0;overflow-x:auto}table{border-collapse:collapse;width:100%}th,td{padding:6px 10px;border-bottom:1px solid #e3e6ea;text-align:left;white-space:nowrap}th{background:#1f3864;color:#fff}.pass{color:#0a7d33;font-weight:700}.fail{color:#c0212a;font-weight:700}.info{color:#1f6feb;font-weight:700}.deg{background:#fff3cd}small{color:#5a6573}.kpi{display:flex;gap:12px;flex-wrap:wrap}.kpi div{background:#fff;border-radius:8px;padding:12px 18px;box-shadow:0 1px 3px #0002}.kpi b{display:block;font-size:18px}';
function chart(title, xs, series, opts = {}) {
  const W = 620, H = 260, P = { l: 56, r: 16, t: 28, b: 40 };
  const max = opts.max || Math.max(...series.flatMap((x) => x.values), opts.line || 0) * 1.1 || 1;
  const X = (i) => P.l + (i * (W - P.l - P.r)) / Math.max(1, xs.length - 1), Y = (v) => P.t + (H - P.t - P.b) * (1 - Math.min(v, max) / max);
  let g = `<text x="${P.l}" y="16" font-size="13" font-weight="600">${title}</text>`;
  for (let i = 0; i <= 4; i++) { const v = (max * i) / 4; g += `<line x1="${P.l}" x2="${W - P.r}" y1="${Y(v)}" y2="${Y(v)}" stroke="#e3e6ea"/><text x="${P.l - 6}" y="${Y(v) + 4}" font-size="11" text-anchor="end">${Math.round(v)}</text>`; }
  xs.forEach((x, i) => (g += `<text x="${X(i)}" y="${H - 18}" font-size="11" text-anchor="middle">${x}</text>`));
  if (opts.line) g += `<line x1="${P.l}" x2="${W - P.r}" y1="${Y(opts.line)}" y2="${Y(opts.line)}" stroke="#c0212a" stroke-dasharray="5 4"/><text x="${W - P.r}" y="${Y(opts.line) - 4}" font-size="11" text-anchor="end" fill="#c0212a">${opts.lineLabel}</text>`;
  series.forEach((sr) => { g += `<polyline fill="none" stroke="${sr.color}" stroke-width="2.5" points="${sr.values.map((v, i) => `${X(i)},${Y(v)}`).join(' ')}"/>` + sr.values.map((v, i) => `<circle cx="${X(i)}" cy="${Y(v)}" r="3.5" fill="${sr.color}"/>`).join(''); });
  g += `<text x="${(W + P.l) / 2}" y="${H - 2}" font-size="11" text-anchor="middle">${opts.xLabel || ''}</text>`;
  return `<svg viewBox="0 0 ${W} ${H}" width="100%" role="img" aria-label="${title}">${g}</svg>`;
}
const table = (head, rows) => `<table><tr>${head.map((h) => `<th>${h}</th>`).join('')}</tr>${rows.map((r) => `<tr class="${r.cls || ''}">${r.cells.map((c) => `<td>${c}</td>`).join('')}</tr>`).join('')}</table>`;
let H = `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Performance test report</title><style>${css}</style><main><h1>Performance Test Report</h1><small>${run.env.date} | profile ${run.env.profile} | ${run.env.cpu}, ${run.env.cores} cores, ${run.env.memGb} GB | k6 ${run.env.k6} | load generator and the shop (Node.js + SQLite, nothing simulated) share this machine</small>`;
H += '<div class="kpi">' + run.tests.map((t) => `<div><small>${t.test}</small><b class="${verdictClass(t.test)}">${verdict(t.test)}</b></div>`).join('') + '</div>';
H += '<h2>Summary</h2><div class="card">' + table(['Test', 'Purpose', 'Result', 'Requests', 'Avg rate', 'p95', 'p99', 'Errors'], run.tests.map((t) => { const o = data[t.test] && data[t.test].overall; return { cells: [t.test, purpose[t.test] || '', `<span class="${verdictClass(t.test)}">${verdict(t.test)}</span>`, o ? o.requests : 'n/a', o ? o.rps + '/s' : 'n/a', o ? ms(o.latency.p95) : 'n/a', o ? ms(o.latency.p99) : 'n/a', o ? pct(o.failedRate) : 'n/a'] }; })) + `</div><small>SLOs: p95 &lt; ${SLO.p95} ms, p99 &lt; ${SLO.p99} ms, errors &lt; ${SLO.err * 100}%, plus a target per endpoint.</small>`;
if (data.load) H += '<h2>Load: latency by endpoint</h2><div class="card">' + table(['Endpoint', 'Share', 'p50', 'p95', 'Target', 'p99', 'max', 'Result'], Object.entries(data.load.endpoints).map(([e, d]) => ({ cls: d.p95 < SLO.endpoints[e] ? '' : 'deg', cells: [e, MIX[e] || '', ms(d.med), ms(d.p95), SLO.endpoints[e] + ' ms', ms(d.p99), ms(d.max), d.p95 < SLO.endpoints[e] ? 'ok' : 'MISSED'] }))) + '</div>';
if (jn && jn.journey) {
  const J = jn.journey;
  H += `<h2>Shopper journeys</h2><p>Browse, search, open a product, log in, buy 1 to 3 products found, read the order back, with think time. <b>${J.completed} journeys, ${pct(J.success)} fully successful</b>; the order total was checked against the prices the shopper saw. Journey time (with think time): median ${ms(J.durationMs.p50)}, p95 ${ms(J.durationMs.p95)}.</p>`;
  H += '<div class="card">' + table(['Step', 'p50', 'p95', 'Target', 'Result'], Object.entries(J.steps).map(([k, d]) => ({ cls: d.p95 < d.target ? '' : 'deg', cells: [k, ms(d.med == null ? d.p50 : d.med), ms(d.p95), d.target + ' ms', d.p95 < d.target ? 'ok' : 'MISSED'] }))) + '</div>';
  H += '<div class="card">' + table(['Phase', 'Shoppers', 'Requests/s', 'p95', 'Errors', 'CPU avg (max)'], jn.stages.filter((st) => !st.name.startsWith('ramp')).map((st) => ({ cells: [st.name, st.rate, st.rps, ms(st.latency.p95), pct(st.failedRate), cpu(st.resources)] }))) + '</div>';
}
if (s) {
  const steps = s.stages.filter((x) => x.name.startsWith('rps_'));
  H += '<h2>Stress: where does it break, and why?</h2>';
  H += `<div class="card">${chart('p95 and p99 latency (ms) vs offered load', steps.map((x) => x.rate), [{ values: steps.map((x) => x.latency.p95), color: '#1f6feb' }, { values: steps.map((x) => x.latency.p99), color: '#d97706' }], { line: SLO.p95, lineLabel: 'p95 SLO 300 ms', xLabel: 'offered requests per second (blue p95, orange p99)', max: 1600 })}</div>`;
  H += `<div class="card">${chart('Shop CPU (% of one core) vs offered load', steps.map((x) => x.rate), [{ values: steps.map((x) => (x.resources ? x.resources.cpuAvg : 0)), color: '#0a7d33' }, { values: steps.map((x) => (x.resources ? x.resources.cpuMax : 0)), color: '#9aa4b2' }], { max: 120, line: 100, lineLabel: 'one core fully used', xLabel: 'offered requests per second (green average, grey peak sample)' })}</div>`;
  H += `<div class="card">${chart('Achieved vs offered throughput (req/s)', steps.map((x) => x.rate), [{ values: steps.map((x) => x.rate), color: '#9aa4b2' }, { values: steps.map((x) => x.rps), color: '#0a7d33' }], { xLabel: 'offered requests per second (grey offered, green achieved)' })}</div>`;
  H += '<div class="card">' + table(['Step', 'Offered', 'Achieved', 'p50', 'p95', 'p99', 'Errors', 'CPU avg (max)', 'Loop delay'], s.stages.map((st) => ({ cls: st.latency.p95 > SLO.p95 || st.failedRate > SLO.err ? 'deg' : '', cells: [st.name, st.rate + '/s', st.rps + '/s', ms(st.latency.med), ms(st.latency.p95), ms(st.latency.p99), pct(st.failedRate), cpu(st.resources), lag(st.resources)] }))) + '</div>';
  H += `<p><b>Maximum load within SLO: about ${sustain ? sustain.rate : 'n/a'} req/s.</b> ${knee ? `First degradation at ${knee.rate} req/s.` : ''} ${recovery ? (recovery.ok ? 'The system recovered fully afterwards.' : 'The system did not return to normal.') : ''}</p>`;
  const why = cause(knee || steps[steps.length - 1]);
  if (why) H += `<p><b>Cause:</b> ${why}</p>`;
}
if (spike) H += '<h2>Spike</h2><div class="card">' + table(['Phase', 'Offered', 'Achieved', 'p95', 'p99', 'Errors', 'CPU avg (max)'], [['Baseline', spike.b], ['Spike', spike.k], ['Drain', spike.d], ['Recovered', spike.r]].map(([n, x]) => ({ cells: [n, x.rate + '/s', x.rps + '/s', ms(x.latency.p95), ms(x.latency.p99), pct(x.failedRate), cpu(x.resources)] }))) + `</div><p><b>${spike.ok ? 'Recovered to normal.' : 'Did not recover.'}</b></p>`;
if (soak) H += `<h2>Soak</h2><div class="card">${table(['p95 early', 'p95 late', 'Drift', 'Heap early vs late (after GC)', 'Peak RSS'], [{ cells: [ms(soak.t1), ms(soak.t3), soak.drift + '%', `${soak.heap.firstAvgMb} vs ${soak.heap.lastAvgMb} MB (${soak.heap.growthMb} MB)`, soak.rss + ' MB'] }])}</div>`;
H += '</main></html>';
fs.writeFileSync(path.join(R, 'report.html'), H);
console.log('Wrote results/REPORT.md and results/report.html');
