// Demo shop API used as the system under test (SUT) for the performance suite.
// Plain Node, no dependencies. It behaves like a typical web app with a small database connection pool:
//  - every request needs a DB connection (pool of POOL_SIZE); when all are busy, requests queue
//  - a request that waits longer than QUEUE_TIMEOUT_MS is rejected with 503
//  - /api/search also burns CPU (blocks the event loop), like an un-indexed text search
// Latencies are simulated with timers so results are repeatable. This is a model, not a real production system.
const http = require('http');
const { URL } = require('url');

const PORT = Number(process.env.PORT || 3111);
const POOL_SIZE = Number(process.env.POOL_SIZE || 4);
const QUEUE_TIMEOUT_MS = Number(process.env.QUEUE_TIMEOUT_MS || 1500);

const products = Array.from({ length: 20 }, (_, i) => ({ id: i + 1, name: ['Shirt', 'Mug', 'Bag', 'Lamp', 'Book'][i % 5] + ' ' + (i + 1), price: 5 + i * 2.5, stock: 100 }));
const orders = []; // ring buffer, capped so a long soak is not a memory test of the test data
const stats = { requests: 0, rejected: 0, inflight: 0, busy: 0 };
const waiters = [];

const rnd = (a, b) => a + Math.random() * (b - a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function acquire() {
  if (stats.busy < POOL_SIZE) { stats.busy++; return Promise.resolve(true); }
  return new Promise((resolve) => {
    const w = { resolve };
    w.timer = setTimeout(() => { const i = waiters.indexOf(w); if (i >= 0) waiters.splice(i, 1); resolve(false); }, QUEUE_TIMEOUT_MS);
    waiters.push(w);
  });
}
function release() {
  const w = waiters.shift();
  if (w) { clearTimeout(w.timer); w.resolve(true); } else stats.busy--;
}
function burn(ms) { const end = process.hrtime.bigint() + BigInt(Math.round(ms * 1e6)); while (process.hrtime.bigint() < end); }

function send(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) });
  res.end(body);
}
function readBody(req) {
  return new Promise((resolve) => { let d = ''; req.on('data', (c) => (d += c)); req.on('end', () => resolve(d)); });
}

async function withDb(res, holdMs, work) {
  if (!(await acquire())) { stats.rejected++; return send(res, 503, { error: 'database pool exhausted' }); }
  try { await sleep(holdMs); work(); } finally { release(); }
}

const server = http.createServer(async (req, res) => {
  stats.requests++; stats.inflight++;
  res.on('close', () => stats.inflight--);
  const u = new URL(req.url, 'http://x');
  try {
    if (req.method === 'GET' && u.pathname === '/health') return send(res, 200, { status: 'ok' });
    if (req.method === 'GET' && u.pathname === '/metrics') {
      if (u.searchParams.get('gc') && global.gc) global.gc();
      const m = process.memoryUsage();
      return send(res, 200, { heapUsedMb: +(m.heapUsed / 1048576).toFixed(2), rssMb: +(m.rss / 1048576).toFixed(1), inflight: stats.inflight, queueDepth: waiters.length, poolBusy: stats.busy, requests: stats.requests, rejected: stats.rejected });
    }
    if (req.method === 'GET' && u.pathname === '/api/products') {
      const page = Math.max(1, Number(u.searchParams.get('page') || 1));
      return withDb(res, rnd(4, 10), () => send(res, 200, { page, items: products.slice((page - 1) * 10, page * 10) }));
    }
    const m = u.pathname.match(/^\/api\/products\/(\d+)$/);
    if (req.method === 'GET' && m) {
      return withDb(res, rnd(3, 6), () => { const p = products.find((x) => x.id === Number(m[1])); p ? send(res, 200, p) : send(res, 404, { error: 'not found' }); });
    }
    if (req.method === 'GET' && u.pathname === '/api/search') {
      const q = (u.searchParams.get('q') || '').toLowerCase();
      burn(2);
      return withDb(res, rnd(10, 20), () => send(res, 200, { query: q, results: products.filter((p) => p.name.toLowerCase().includes(q)) }));
    }
    if (req.method === 'POST' && u.pathname === '/api/orders') {
      let b; try { b = JSON.parse(await readBody(req)); } catch { return send(res, 400, { error: 'invalid json' }); }
      if (!b || !Number.isInteger(b.productId) || !Number.isInteger(b.quantity) || b.quantity < 1) return send(res, 400, { error: 'productId and quantity required' });
      return withDb(res, rnd(20, 40), () => {
        const order = { id: stats.requests, productId: b.productId, quantity: b.quantity, status: 'created' };
        orders.push(order); if (orders.length > 1000) orders.shift();
        send(res, 201, order);
      });
    }
    return send(res, 404, { error: 'not found' });
  } catch (e) { send(res, 500, { error: 'internal error' }); }
});
server.keepAliveTimeout = 30000;
server.listen(PORT, () => console.log(`SUT listening on :${PORT} pool=${POOL_SIZE} queueTimeout=${QUEUE_TIMEOUT_MS}ms`));
