// SQL data-integrity tests for the demo shop's database.
// The shop runs with a database file; orders are placed through the HTTP API, then the data is checked with SQL
// (opened read-only, so the tests cannot change what they verify).
// Tests marked `todo` are known weaknesses: they state the correct behaviour, fail today, and do not fail the run.
// Run: npm run test:sql      (Node 22.13 or newer, no other dependencies)
const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { DatabaseSync } = require('node:sqlite');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const PORT = 3190;
const BASE = `http://127.0.0.1:${PORT}`;
const SEED_ROWS = 300, SEED_USERS = 5;
const DB_FILE = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'shopdb-')), 'shop.db');
let server, db;
const placed = []; // orders created through the API: { id, userId, items }

const api = async (method, url, body, token) => {
  const r = await fetch(BASE + url, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, body: await r.json().catch(() => null) };
};
const login = async (n) => (await api('POST', '/api/login', { email: `user${n}@shop.test`, password: `Passw0rd!${n}` })).body.token;
const count = (sql, ...p) => db.prepare(sql).get(...p).n;

test.before(async () => {
  server = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], { env: { ...process.env, PORT: String(PORT), SEED_ROWS: String(SEED_ROWS), SEED_USERS: String(SEED_USERS), DB_FILE }, stdio: 'ignore' });
  for (let i = 0; i < 100; i++) { try { if ((await fetch(BASE + '/health')).ok) break; } catch { /* not up yet */ } await new Promise((r) => setTimeout(r, 100)); }
  // place 25 orders for 5 different users with varying contents
  for (let n = 1; n <= SEED_USERS; n++) {
    const token = await login(n);
    for (let k = 0; k < 5; k++) {
      const items = Array.from({ length: 1 + ((n + k) % 4) }, (_, j) => ({ productId: 1 + ((n * 37 + k * 11 + j * 7) % SEED_ROWS), quantity: 1 + ((n + k + j) % 5) }));
      const r = await api('POST', '/api/orders', { items }, token);
      assert.equal(r.status, 201);
      placed.push({ id: r.body.id, userId: n, items });
    }
  }
  db = new DatabaseSync(DB_FILE, { readOnly: true });
});
test.after(() => { db?.close(); server?.kill(); });

test('seed data: the expected number of products and users exist', () => {
  assert.equal(count('SELECT COUNT(*) AS n FROM products'), SEED_ROWS);
  assert.equal(count('SELECT COUNT(*) AS n FROM users'), SEED_USERS);
});
test('seed data: no product has a non-positive price, negative stock or an empty name', () => {
  assert.equal(count("SELECT COUNT(*) AS n FROM products WHERE price <= 0 OR stock < 0 OR TRIM(name) = ''"), 0);
});
test('seed data: product names are unique', () => {
  assert.equal(count('SELECT COUNT(*) AS n FROM (SELECT name FROM products GROUP BY name HAVING COUNT(*) > 1)'), 0);
});
test('users: emails are unique', () => {
  assert.equal(count('SELECT COUNT(*) AS n FROM (SELECT email FROM users GROUP BY email HAVING COUNT(*) > 1)'), 0);
});
test('users: passwords are stored as salted hashes, never as text', () => {
  const rows = db.prepare('SELECT salt, hash FROM users').all();
  for (const r of rows) assert.match(r.hash, /^[0-9a-f]{64}$/);
  assert.equal(new Set(rows.map((r) => r.salt)).size, rows.length, 'every user has their own salt');
  assert.equal(count("SELECT COUNT(*) AS n FROM users WHERE hash LIKE '%Passw0rd%'"), 0);
});

test('orders: all 25 orders placed through the API are stored', () => {
  assert.equal(count('SELECT COUNT(*) AS n FROM orders'), placed.length);
});
test('orders: the total equals the sum of quantity x unit price of its lines (to the cent)', () => {
  const bad = db.prepare(`SELECT o.id FROM orders o JOIN order_items i ON i.order_id = o.id GROUP BY o.id HAVING ABS(o.total - ROUND(SUM(i.quantity * i.unit_price), 2)) > 0.005`).all();
  assert.equal(bad.length, 0);
});
test('orders: every order has between 1 and 10 lines, each with a quantity from 1 to 10', () => {
  assert.equal(count('SELECT COUNT(*) AS n FROM orders o WHERE (SELECT COUNT(*) FROM order_items i WHERE i.order_id = o.id) NOT BETWEEN 1 AND 10'), 0);
  assert.equal(count('SELECT COUNT(*) AS n FROM order_items WHERE quantity NOT BETWEEN 1 AND 10'), 0);
});
test('orders: no order line points to a missing order or product (no orphans)', () => {
  assert.equal(count('SELECT COUNT(*) AS n FROM order_items i LEFT JOIN orders o ON o.id = i.order_id WHERE o.id IS NULL'), 0);
  assert.equal(count('SELECT COUNT(*) AS n FROM order_items i LEFT JOIN products p ON p.id = i.product_id WHERE p.id IS NULL'), 0);
  assert.equal(count('SELECT COUNT(*) AS n FROM orders o LEFT JOIN users u ON u.id = o.user_id WHERE u.id IS NULL'), 0);
});
test('orders: the stored unit price is the product price at purchase time', () => {
  assert.equal(count('SELECT COUNT(*) AS n FROM order_items i JOIN products p ON p.id = i.product_id WHERE ABS(i.unit_price - p.price) > 0.000001'), 0);
});
test('orders: each order belongs to the user who placed it', () => {
  for (const o of placed) assert.equal(db.prepare('SELECT user_id FROM orders WHERE id = ?').get(o.id).user_id, o.userId);
});
test('orders: each order stores exactly the lines that were sent', () => {
  for (const o of placed) {
    const stored = db.prepare('SELECT product_id AS productId, quantity FROM order_items WHERE order_id = ? ORDER BY rowid').all(o.id).map((r) => ({ productId: r.productId, quantity: r.quantity }));
    assert.deepEqual(stored, o.items.map(({ productId, quantity }) => ({ productId, quantity })));
  }
});

test('atomicity: a rejected order writes nothing to the database', async () => {
  const token = await login(1);
  const before = [count('SELECT COUNT(*) AS n FROM orders'), count('SELECT COUNT(*) AS n FROM order_items')];
  for (const items of [[{ productId: 1, quantity: 0 }], [{ productId: 999999, quantity: 1 }], [{ productId: 1, quantity: 11 }], [{ productId: 1, quantity: 1 }, { productId: 999999, quantity: 1 }], []]) {
    const r = await api('POST', '/api/orders', { items }, token);
    assert.equal(r.status, 400, JSON.stringify(items));
  }
  assert.deepEqual([count('SELECT COUNT(*) AS n FROM orders'), count('SELECT COUNT(*) AS n FROM order_items')], before);
});
test('atomicity: an order without login writes nothing', async () => {
  const before = count('SELECT COUNT(*) AS n FROM orders');
  assert.equal((await api('POST', '/api/orders', { items: [{ productId: 1, quantity: 1 }] })).status, 401);
  assert.equal(count('SELECT COUNT(*) AS n FROM orders'), before);
});
test('security: a SQL injection attempt in search or login changes nothing', async () => {
  const before = [count('SELECT COUNT(*) AS n FROM products'), count('SELECT COUNT(*) AS n FROM users')];
  await api('GET', `/api/search?q=${encodeURIComponent("'; DROP TABLE products; --")}`);
  const r = await api('POST', '/api/login', { email: "' OR '1'='1", password: "' OR '1'='1" });
  assert.equal(r.status, 401);
  assert.deepEqual([count('SELECT COUNT(*) AS n FROM products'), count('SELECT COUNT(*) AS n FROM users')], before);
});

test('performance: listing a category uses the category index, not a full table scan', () => {
  const plan = db.prepare("EXPLAIN QUERY PLAN SELECT id, name, category, price FROM products WHERE category = 'mugs' ORDER BY id LIMIT 20").all().map((r) => r.detail).join(' ');
  assert.match(plan, /idx_products_category/);
});
test('performance: looking up a product by id uses the primary key', () => {
  const plan = db.prepare('EXPLAIN QUERY PLAN SELECT * FROM products WHERE id = 5').all().map((r) => r.detail).join(' ');
  assert.match(plan, /PRIMARY KEY|INTEGER PRIMARY KEY/i);
});

// ---- known weaknesses (todo): correct behaviour is asserted; these fail today and are reported, not hidden
test('SCHEMA-01 order lines are protected by a foreign key to orders and products', { todo: 'no foreign keys are declared' }, () => {
  assert.ok(db.prepare("PRAGMA foreign_key_list('order_items')").all().length >= 2);
});
test('SCHEMA-02 the database rejects an order line with a quantity of 0 or less (CHECK constraint)', { todo: 'no CHECK constraints; only the API validates' }, () => {
  const sql = db.prepare("SELECT sql FROM sqlite_master WHERE name = 'order_items'").get().sql;
  assert.match(sql, /CHECK/i);
});
test('STOCK-01 placing an order reduces the stock of the product', { todo: 'stock is never decremented, so the shop can oversell' }, async () => {
  const id = 250;
  const before = db.prepare('SELECT stock FROM products WHERE id = ?').get(id).stock;
  const r = await api('POST', '/api/orders', { items: [{ productId: id, quantity: 3 }] }, await login(2));
  assert.equal(r.status, 201);
  assert.equal(db.prepare('SELECT stock FROM products WHERE id = ?').get(id).stock, before - 3);
});
