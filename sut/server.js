// Demo shop API used as the system under test (SUT) for the performance suite.
// A real, small application: plain Node with a REAL SQLite database (node:sqlite, built in, no dependencies).
//  - products table (30,000 rows by default) with a primary key and a category index
//  - search is an un-indexed text scan (LIKE) like many first-version search features: a real bottleneck
//  - login verifies a password with PBKDF2 (real CPU cost, like any password check)
//  - orders are priced from the database and stored in a transaction
//  - a simple overload guard: above MAX_INFLIGHT concurrent requests it answers 503 immediately
// Nothing is simulated with timers: all latency comes from real work on this machine.
// Needs Node 22.13 or newer.
const http = require('http');
const crypto = require('crypto');
const { URL } = require('url');
const { DatabaseSync } = require('node:sqlite');
const { monitorEventLoopDelay } = require('perf_hooks');

const PORT = Number(process.env.PORT || 3111);
const ROWS = Number(process.env.SEED_ROWS || 30000);
const USERS = Number(process.env.SEED_USERS || 100);
const MAX_INFLIGHT = Number(process.env.MAX_INFLIGHT || 256);
const PBKDF2_ITER = 10000;

// ---------------------------------------------------------------- database
const db = new DatabaseSync(':memory:');
db.exec(`
  CREATE TABLE products (id INTEGER PRIMARY KEY, name TEXT NOT NULL, category TEXT NOT NULL, price REAL NOT NULL, description TEXT NOT NULL, stock INTEGER NOT NULL);
  CREATE INDEX idx_products_category ON products(category);
  CREATE TABLE users (id INTEGER PRIMARY KEY, email TEXT NOT NULL UNIQUE, salt TEXT NOT NULL, hash TEXT NOT NULL);
  CREATE TABLE orders (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL, total REAL NOT NULL, created_at TEXT NOT NULL);
  CREATE TABLE order_items (order_id INTEGER NOT NULL, product_id INTEGER NOT NULL, quantity INTEGER NOT NULL, unit_price REAL NOT NULL);
`);

const CATEGORIES = ['shirts', 'mugs', 'bags', 'lamps', 'books', 'shoes', 'hats', 'toys', 'games', 'tools', 'plants', 'music'];
const WORDS = ['alpine', 'urban', 'classic', 'modern', 'compact', 'deluxe', 'vintage', 'solar', 'smart', 'rustic', 'bright', 'quiet', 'swift', 'sturdy', 'gentle', 'bold', 'ocean', 'forest', 'desert', 'arctic'];
let seed = 42;
const rnd = () => ((seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296);
const pick = (a) => a[Math.floor(rnd() * a.length)];

(function seedDb() {
  const ins = db.prepare('INSERT INTO products (name, category, price, description, stock) VALUES (?, ?, ?, ?, ?)');
  db.exec('BEGIN');
  for (let i = 1; i <= ROWS; i++) {
    const cat = CATEGORIES[i % CATEGORIES.length];
    const name = `${pick(WORDS)} ${pick(WORDS)} ${cat.slice(0, -1)} ${i}`;
    const desc = Array.from({ length: 18 }, () => pick(WORDS)).join(' ');
    ins.run(name, cat, Math.round((5 + rnd() * 195) * 100) / 100, desc, 50 + Math.floor(rnd() * 500));
  }
  db.exec('COMMIT');
  const insU = db.prepare('INSERT INTO users (email, salt, hash) VALUES (?, ?, ?)');
  for (let n = 1; n <= USERS; n++) {
    const salt = crypto.randomBytes(8).toString('hex');
    insU.run(`user${n}@shop.test`, salt, crypto.pbkdf2Sync(`Passw0rd!${n}`, salt, PBKDF2_ITER, 32, 'sha256').toString('hex'));
  }
})();

const q = {
  list: db.prepare('SELECT id, name, category, price FROM products WHERE category = ? ORDER BY id LIMIT 20 OFFSET ?'),
  detail: db.prepare('SELECT id, name, category, price, description, stock FROM products WHERE id = ?'),
  search: db.prepare('SELECT id, name, price FROM products WHERE name LIKE ? OR description LIKE ? LIMIT 20'),
  user: db.prepare('SELECT id, salt, hash FROM users WHERE email = ?'),
  price: db.prepare('SELECT price FROM products WHERE id = ?'),
  insOrder: db.prepare('INSERT INTO orders (user_id, total, created_at) VALUES (?, ?, ?)'),
  insItem: db.prepare('INSERT INTO order_items (order_id, product_id, quantity, unit_price) VALUES (?, ?, ?, ?)'),
  order: db.prepare('SELECT id, user_id, total, created_at FROM orders WHERE id = ?'),
  items: db.prepare('SELECT product_id, quantity, unit_price FROM order_items WHERE order_id = ?'),
};
const tokens = new Map();

// ---------------------------------------------------------------- telemetry
const loop = monitorEventLoopDelay({ resolution: 10 });
loop.enable();
const stats = { requests: 0, rejected: 0, errors: 0, inflight: 0 };
let lastCpu = process.cpuUsage(), lastT = process.hrtime.bigint();

function send(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) });
  res.end(body);
}
const readBody = (req) => new Promise((resolve) => { let d = ''; req.on('data', (c) => (d += c)); req.on('end', () => resolve(d)); });
const userFrom = (req) => tokens.get((req.headers.authorization || '').replace(/^Bearer /, ''));

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://x');
  if (req.method === 'GET' && u.pathname === '/health') return send(res, 200, { status: 'ok' });
  if (req.method === 'GET' && u.pathname === '/metrics') {
    if (u.searchParams.get('gc') && global.gc) global.gc();
    const cpu = process.cpuUsage(), t = process.hrtime.bigint();
    const cpuPct = (100 * ((cpu.user - lastCpu.user) + (cpu.system - lastCpu.system))) / (Number(t - lastT) / 1000);
    lastCpu = cpu; lastT = t;
    const m = process.memoryUsage();
    const out = { cpuPct: +cpuPct.toFixed(1), eventLoopLagMs: { p50: +(loop.percentile(50) / 1e6).toFixed(2), p99: +(loop.percentile(99) / 1e6).toFixed(2), max: +(loop.max / 1e6).toFixed(2) }, heapUsedMb: +(m.heapUsed / 1048576).toFixed(2), rssMb: +(m.rss / 1048576).toFixed(1), inflight: stats.inflight, requests: stats.requests, rejected: stats.rejected, errors: stats.errors };
    loop.reset();
    return send(res, 200, out);
  }

  stats.requests++;
  if (stats.inflight >= MAX_INFLIGHT) { stats.rejected++; return send(res, 503, { error: 'server busy' }); }
  stats.inflight++;
  res.on('close', () => stats.inflight--);
  try {
    if (req.method === 'GET' && u.pathname === '/api/products') {
      const cat = u.searchParams.get('category') || CATEGORIES[0];
      const page = Math.max(1, Number(u.searchParams.get('page') || 1));
      return send(res, 200, { category: cat, page, items: q.list.all(cat, (page - 1) * 20) });
    }
    const m = u.pathname.match(/^\/api\/products\/(\d+)$/);
    if (req.method === 'GET' && m) {
      const row = q.detail.get(Number(m[1]));
      return row ? send(res, 200, row) : send(res, 404, { error: 'not found' });
    }
    if (req.method === 'GET' && u.pathname === '/api/search') {
      const term = `%${(u.searchParams.get('q') || '').toLowerCase()}%`;
      return send(res, 200, { query: u.searchParams.get('q'), results: q.search.all(term, term) });
    }
    if (req.method === 'POST' && u.pathname === '/api/login') {
      let b; try { b = JSON.parse(await readBody(req)); } catch { return send(res, 400, { error: 'invalid json' }); }
      const row = b && typeof b.email === 'string' ? q.user.get(b.email) : null;
      const ok = row && crypto.timingSafeEqual(crypto.pbkdf2Sync(String(b.password), row.salt, PBKDF2_ITER, 32, 'sha256'), Buffer.from(row.hash, 'hex'));
      if (!ok) return send(res, 401, { error: 'bad credentials' });
      const token = crypto.randomBytes(16).toString('hex');
      tokens.set(token, row.id);
      return send(res, 200, { token });
    }
    if (req.method === 'POST' && u.pathname === '/api/orders') {
      const userId = userFrom(req);
      if (!userId) return send(res, 401, { error: 'login required' });
      let b; try { b = JSON.parse(await readBody(req)); } catch { return send(res, 400, { error: 'invalid json' }); }
      const items = b && Array.isArray(b.items) ? b.items : null;
      if (!items || items.length < 1 || items.length > 10 || items.some((i) => !Number.isInteger(i.productId) || !Number.isInteger(i.quantity) || i.quantity < 1 || i.quantity > 10)) return send(res, 400, { error: 'items: 1 to 10 of {productId, quantity 1 to 10}' });
      let total = 0; const lines = [];
      for (const i of items) {
        const p = q.price.get(i.productId);
        if (!p) return send(res, 400, { error: `unknown product ${i.productId}` });
        lines.push({ productId: i.productId, quantity: i.quantity, unitPrice: p.price });
        total += p.price * i.quantity;
      }
      total = Math.round(total * 100) / 100;
      db.exec('BEGIN');
      const orderId = Number(q.insOrder.run(userId, total, new Date().toISOString()).lastInsertRowid);
      for (const l of lines) q.insItem.run(orderId, l.productId, l.quantity, l.unitPrice);
      db.exec('COMMIT');
      return send(res, 201, { id: orderId, total, items: lines });
    }
    const om = u.pathname.match(/^\/api\/orders\/(\d+)$/);
    if (req.method === 'GET' && om) {
      const userId = userFrom(req);
      if (!userId) return send(res, 401, { error: 'login required' });
      const o = q.order.get(Number(om[1]));
      if (!o) return send(res, 404, { error: 'not found' });
      if (o.user_id !== userId) return send(res, 403, { error: 'not your order' });
      return send(res, 200, { id: o.id, total: o.total, createdAt: o.created_at, items: q.items.all(o.id) });
    }
    return send(res, 404, { error: 'not found' });
  } catch (e) { stats.errors++; try { send(res, 500, { error: 'internal error' }); } catch { /* connection gone */ } }
});
server.keepAliveTimeout = 30000;
server.listen(PORT, () => console.log(`SUT listening on :${PORT} products=${ROWS} users=${USERS} maxInflight=${MAX_INFLIGHT}`));
