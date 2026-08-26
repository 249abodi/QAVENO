'use strict';

const { DatabaseSync } = require('node:sqlite');
const path = require('node:path');
const fs = require('node:fs');
const migrations = require('./migrations');

let db = null;

function round2(n) {
  return Math.round((Number(n) + Number.EPSILON) * 100) / 100;
}

function nowStr() {
  return new Date().toISOString().slice(0, 19).replace('T', ' ');
}

function withTransaction(fn) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    try { db.exec('ROLLBACK'); } catch (_) { /* already rolled back */ }
    throw err;
  }
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS categories (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  color TEXT NOT NULL DEFAULT '#2563eb',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS products (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  barcode TEXT UNIQUE,
  price REAL NOT NULL CHECK (price >= 0),
  cost REAL NOT NULL DEFAULT 0 CHECK (cost >= 0),
  quantity INTEGER NOT NULL DEFAULT 0 CHECK (quantity >= 0),
  low_stock_threshold INTEGER NOT NULL DEFAULT 5 CHECK (low_stock_threshold >= 0),
  category TEXT DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT
);

CREATE TABLE IF NOT EXISTS sales (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  invoice_no TEXT UNIQUE NOT NULL,
  subtotal REAL NOT NULL,
  tax_total REAL NOT NULL DEFAULT 0,
  discount REAL NOT NULL DEFAULT 0,
  total REAL NOT NULL,
  paid REAL NOT NULL,
  change_amount REAL NOT NULL DEFAULT 0,
  payment_method TEXT NOT NULL DEFAULT 'cash',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS sale_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  sale_id INTEGER NOT NULL REFERENCES sales(id) ON DELETE CASCADE,
  product_id INTEGER NOT NULL REFERENCES products(id),
  product_name TEXT NOT NULL,
  quantity INTEGER NOT NULL CHECK (quantity > 0),
  unit_price REAL NOT NULL,
  unit_cost REAL NOT NULL DEFAULT 0,
  tax_rate REAL NOT NULL DEFAULT 0,
  line_subtotal REAL NOT NULL,
  line_tax REAL NOT NULL,
  line_total REAL NOT NULL
);

CREATE TABLE IF NOT EXISTS inventory_movements (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  change INTEGER NOT NULL,
  reason TEXT NOT NULL,
  note TEXT,
  ref_type TEXT,
  ref_id INTEGER,
  balance_after INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_products_barcode ON products(barcode);
CREATE INDEX IF NOT EXISTS idx_products_quantity ON products(quantity);
CREATE INDEX IF NOT EXISTS idx_sales_created ON sales(created_at);
CREATE INDEX IF NOT EXISTS idx_sale_items_sale ON sale_items(sale_id);
CREATE INDEX IF NOT EXISTS idx_movements_product ON inventory_movements(product_id);
`;

const SEED_PRODUCTS = [
  ['أرز بسمتي 5كجم', '1000000001', 45.00, 38.00, 40, 10, 'مواد غذائية'],
  ['زيت دوار الشمس 1.5ل', '1000000002', 22.50, 18.00, 35, 8, 'مواد غذائية'],
  ['سكر أبيض 1كجم', '1000000003', 6.75, 5.20, 60, 12, 'مواد غذائية'],
  ['شاي أحمر علبة', '1000000004', 12.00, 9.00, 4, 6, 'مشروبات'],
  ['مياه معدنية 600مل', '1000000005', 1.00, 0.60, 120, 24, 'مشروبات'],
  ['حليب طويل الأجل 1ل', '1000000006', 7.50, 6.00, 25, 10, 'ألبان'],
  ['معكرونة إيطالية', '1000000007', 4.25, 3.00, 3, 15, 'مواد غذائية'],
  ['منظف أرضيات 2ل', '1000000008', 15.00, 11.00, 18, 5, 'منظفات'],
  ['شامبو عائلي 750مل', '1000000009', 19.90, 14.50, 12, 4, 'عناية شخصية'],
  ['بطاريات AA (4 حبات)', '1000000010', 10.50, 7.00, 0, 5, 'إلكترونيات']
];

function seed(dbRef) {
  const count = dbRef.prepare('SELECT COUNT(*) AS c FROM products').get().c;
  if (count === 0) {
    const ins = dbRef.prepare(
      'INSERT INTO products (name, barcode, price, cost, quantity, low_stock_threshold, category) VALUES (?, ?, ?, ?, ?, ?, ?)'
    );
    for (const p of SEED_PRODUCTS) {
      const res = ins.run(...p);
      dbRef.prepare(
        'INSERT INTO inventory_movements (product_id, change, reason, balance_after) VALUES (?, ?, ?, ?)'
      ).run(Number(res.lastInsertRowid), p[4], 'initial', p[4]);
    }
  }

  const defaults = [
    ['store_name', 'متجري'],
    ['tax_rate', '15'],
    ['currency', 'ر.س'],
    ['invoice_seq', '0'],
    ['lang', 'ar'],
    ['theme', 'light']
  ];
  const insSet = dbRef.prepare('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)');
  for (const [k, v] of defaults) insSet.run(k, v);
}

const CATEGORY_PALETTE = [
  '#2563eb', '#16a34a', '#eab308', '#ea580c',
  '#ec4899', '#8b5cf6', '#0d9488', '#dc2626'
];

function migrate(dbRef) {
  const cols = dbRef.prepare('PRAGMA table_info(products)').all().map(c => c.name);
  if (!cols.includes('category_id')) {
    dbRef.exec('ALTER TABLE products ADD COLUMN category_id INTEGER REFERENCES categories(id)');
  }

  // Backfill: promote legacy free-text categories into real category rows
  const legacy = dbRef.prepare(
    `SELECT DISTINCT TRIM(category) AS name FROM products
     WHERE category IS NOT NULL AND TRIM(category) <> ''`
  ).all();
  const insCat = dbRef.prepare('INSERT INTO categories (name, color) VALUES (?, ?)');
  const findCat = dbRef.prepare('SELECT id FROM categories WHERE name = ?');
  let i = 0;
  for (const row of legacy) {
    let cat = findCat.get(row.name);
    if (!cat) {
      const r = insCat.run(row.name, CATEGORY_PALETTE[i++ % CATEGORY_PALETTE.length]);
      cat = { id: Number(r.lastInsertRowid) };
    }
    dbRef.prepare('UPDATE products SET category_id = ? WHERE TRIM(category) = ?').run(cat.id, row.name);
  }
  dbRef.exec('CREATE INDEX IF NOT EXISTS idx_products_category ON products(category_id)');
}

function init(dbPath) {
  if (db) return db;
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });

  db = new DatabaseSync(dbPath);
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA foreign_keys = ON;');
  db.exec('PRAGMA busy_timeout = 5000;');
  db.exec('PRAGMA synchronous = NORMAL;');
  db.exec(SCHEMA);
  seed(db);
  withTransaction(() => migrate(db));
  migrations.run(db, nowStr());
  return db;
}

/* Internal handle for sibling modules (auth, future services).
   Call only after init(); throws if DB is not open. */
function getDb() {
  if (!db) throw new Error('قاعدة البيانات غير مهيأة');
  return db;
}

/* ---------------- Settings ---------------- */

function getSettings() {
  const rows = db.prepare('SELECT key, value FROM settings').all();
  const out = {};
  for (const r of rows) out[r.key] = r.value;
  return out;
}

function setSetting(key, value) {
  db.prepare(
    'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
  ).run(String(key), String(value));
}

function getTaxRate() {
  const row = db.prepare("SELECT value FROM settings WHERE key = 'tax_rate'").get();
  const rate = Number(row ? row.value : 15);
  return Number.isFinite(rate) && rate >= 0 ? rate : 0;
}

/* ---------------- Products ---------------- */

function listProducts(search = '') {
  const s = String(search || '').trim();
  const base = `SELECT p.*, c.name AS category_name, c.color AS category_color
                FROM products p LEFT JOIN categories c ON c.id = p.category_id`;
  if (!s) {
    return db.prepare(`${base} ORDER BY p.name COLLATE NOCASE`).all();
  }
  const like = `%${s}%`;
  return db.prepare(
    `${base}
     WHERE p.name LIKE ? OR p.barcode LIKE ? OR c.name LIKE ?
     ORDER BY p.name COLLATE NOCASE`
  ).all(like, like, like);
}

function getProduct(id) {
  return db.prepare(
    `SELECT p.*, c.name AS category_name, c.color AS category_color
     FROM products p LEFT JOIN categories c ON c.id = p.category_id
     WHERE p.id = ?`
  ).get(Number(id));
}

function resolveCategoryId(categoryId) {
  if (categoryId === undefined || categoryId === null || categoryId === '') return null;
  const id = Number(categoryId);
  if (!Number.isInteger(id)) return null;
  const exists = db.prepare('SELECT id FROM categories WHERE id = ?').get(id);
  return exists ? id : null;
}

/* ---------------- Branch-aware stock core (Phase 24) ----------------
 * branch_inventory is authoritative per branch; products.* stays as the
 * maintained DEFAULT-BRANCH mirror (see branches.js decision D1).
 * Every mutation writes the branch row and, for the default branch,
 * mirrors the result onto products.* in the same transaction. */
const DEFAULT_BRANCH_ID = 1;

function getBranchRow(productId, branchId) {
  return db.prepare(
    'SELECT * FROM branch_inventory WHERE branch_id = ? AND product_id = ?'
  ).get(Number(branchId), Number(productId));
}

/* Lazily materialize a zero-stock branch row for a product that has never
   been stocked in this branch (cost/rules seeded from the default branch,
   or from the catalog for brand-new products). Quantity ALWAYS starts at 0:
   physical stock only enters through movements. */
function ensureBranchRow(productId, branchId) {
  const cur = getBranchRow(productId, branchId);
  if (cur) return cur;
  const p = getProduct(productId);
  if (!p) throw new Error('المنتج غير موجود');
  const seedRow = Number(branchId) === DEFAULT_BRANCH_ID
    ? null
    : getBranchRow(productId, DEFAULT_BRANCH_ID);
  db.prepare(`
    INSERT INTO branch_inventory (branch_id, product_id, quantity, cost, low_stock_threshold, reorder_qty)
    VALUES (?, ?, 0, ?, ?, ?)
  `).run(
    Number(branchId), Number(productId),
    round2(seedRow ? seedRow.cost : p.cost),
    seedRow ? seedRow.low_stock_threshold : p.low_stock_threshold,
    seedRow ? seedRow.reorder_qty : (p.reorder_qty || 0)
  );
  return getBranchRow(productId, branchId);
}

function syncDefaultMirror(productId) {
  const r = getBranchRow(productId, DEFAULT_BRANCH_ID);
  if (!r) return;
  db.prepare(
    'UPDATE products SET quantity = ?, cost = ?, low_stock_threshold = ?, reorder_qty = ?, updated_at = ? WHERE id = ?'
  ).run(r.quantity, round2(r.cost), r.low_stock_threshold, r.reorder_qty, nowStr(), Number(productId));
}

function insMovement({ productId, change, reason, note = null, refType = null, refId = null, before, after, actorId = null, branchId, reasonCode = null }) {
  db.prepare(`
    INSERT INTO inventory_movements
      (product_id, change, reason, note, ref_type, ref_id, balance_before, balance_after, actor_id, branch_id, reason_code, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    Number(productId), change, reason, note, refType, refId,
    before, after,
    actorId != null ? Number(actorId) : null,
    branchId != null ? Number(branchId) : null,
    reasonCode,
    nowStr()
  );
}

function createProduct(p) {
  const name = String(p.name || '').trim();
  if (!name) throw new Error('اسم المنتج مطلوب');
  const price = round2(p.price);
  if (!(price >= 0)) throw new Error('السعر غير صالح');
  const qty = Math.trunc(Number(p.quantity ?? 0));
  if (!(qty >= 0)) throw new Error('الكمية غير صالحة');
  const cost = round2(p.cost ?? 0);
  const threshold = Math.max(0, Math.trunc(Number(p.low_stock_threshold ?? 5)));
  const reorderQty = p.reorder_qty !== undefined ? Math.max(0, Math.trunc(Number(p.reorder_qty))) : 0;

  let created;
  withTransaction(() => {
    const res = db.prepare(
      `INSERT INTO products (name, barcode, price, cost, quantity, low_stock_threshold, category, category_id, reorder_qty, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      name,
      p.barcode ? String(p.barcode).trim() : null,
      price,
      cost,
      qty,
      threshold,
      String(p.category || '').trim(),
      resolveCategoryId(p.category_id),
      reorderQty,
      nowStr()
    );
    const id = Number(res.lastInsertRowid);
    if (qty > 0) {
      insMovement({ productId: id, change: qty, reason: 'initial', before: 0, after: qty, branchId: DEFAULT_BRANCH_ID });
    }
    db.prepare(
      `INSERT INTO cost_history (product_id, source_type, qty_received, unit_cost, new_cost, branch_id, created_at)
       VALUES (?, 'initial', ?, ?, ?, ?, ?)`
    ).run(id, qty, cost, cost, DEFAULT_BRANCH_ID, nowStr());
    // Authoritative default-branch row (mirror = the products columns themselves).
    db.prepare(`
      INSERT INTO branch_inventory (branch_id, product_id, quantity, cost, low_stock_threshold, reorder_qty)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(DEFAULT_BRANCH_ID, id, qty, cost, threshold, reorderQty);
    created = getProduct(id);
  });
  return created;
}

function updateProduct(id, p, actorId = null) {
  const existing = getProduct(id);
  if (!existing) throw new Error('المنتج غير موجود');
  const name = String(p.name ?? existing.name).trim() || existing.name;
  const price = p.price !== undefined ? round2(p.price) : existing.price;
  if (!(price >= 0)) throw new Error('السعر غير صالح');
  const newCost = p.cost !== undefined ? round2(p.cost) : existing.cost;
  const newThreshold = p.low_stock_threshold !== undefined
    ? Math.max(0, Math.trunc(Number(p.low_stock_threshold)))
    : existing.low_stock_threshold;

  withTransaction(() => {
    db.prepare(
      `UPDATE products SET name=?, barcode=?, price=?, cost=?, low_stock_threshold=?, category_id=?, updated_at=?
       WHERE id=?`
    ).run(
      name,
      p.barcode !== undefined ? (p.barcode ? String(p.barcode).trim() : null) : existing.barcode,
      price,
      newCost,
      newThreshold,
      p.category_id !== undefined ? resolveCategoryId(p.category_id) : existing.category_id,
      nowStr(),
      Number(id)
    );
    // Keep the authoritative default-branch row in step (D1).
    db.prepare(`
      UPDATE branch_inventory SET cost = ?, low_stock_threshold = ?, updated_at = ?
      WHERE branch_id = ? AND product_id = ?
    `).run(newCost, newThreshold, nowStr(), DEFAULT_BRANCH_ID, Number(id));
    if (newCost !== round2(existing.cost)) {
      db.prepare(
        `INSERT INTO cost_history (product_id, source_type, unit_cost, prev_cost, new_cost, actor_id, branch_id, created_at)
         VALUES (?, 'manual', ?, ?, ?, ?, ?, ?)`
      ).run(Number(id), newCost, round2(existing.cost), newCost,
        actorId != null ? Number(actorId) : null, DEFAULT_BRANCH_ID, nowStr());
    }
  });
  return getProduct(id);
}

function deleteProduct(id) {
  const sold = db.prepare('SELECT COUNT(*) AS c FROM sale_items WHERE product_id = ?').get(Number(id)).c;
  if (sold > 0) {
    throw new Error('لا يمكن حذف منتج له سجل مبيعات. يمكنك ضبط كميته إلى صفر بدلاً من ذلك.');
  }
  db.prepare('DELETE FROM products WHERE id = ?').run(Number(id));
  return { ok: true };
}

function restock(id, addQty, note, opts = {}) {
  const q = Math.trunc(Number(addQty));
  if (!(q > 0)) throw new Error('الكمية المضافة يجب أن تكون أكبر من صفر');
  const branchId = opts.branchId != null ? Number(opts.branchId) : DEFAULT_BRANCH_ID;
  let updated;
  withTransaction(() => {
    const row = ensureBranchRow(id, branchId);
    if (!getProduct(id)) throw new Error('المنتج غير موجود');
    const before = Number(row.quantity);
    const newQty = before + q;
    db.prepare(
      'UPDATE branch_inventory SET quantity = ?, updated_at = ? WHERE branch_id = ? AND product_id = ?'
    ).run(newQty, nowStr(), branchId, Number(id));
    insMovement({
      productId: id, change: q, reason: 'restock',
      note: note ? String(note) : null,
      before, after: newQty,
      actorId: opts.actorId, branchId
    });
    if (branchId === DEFAULT_BRANCH_ID) syncDefaultMirror(id);
    updated = getProduct(id);
    updated.quantity = newQty; // caller sees the affected branch's quantity
  });
  return updated;
}

function adjustQuantity(id, newQty, opts = {}) {
  const n = Math.trunc(Number(newQty));
  if (!(n >= 0)) throw new Error('الكمية يجب أن تكون صفراً أو أكثر');
  const branchId = opts.branchId != null ? Number(opts.branchId) : DEFAULT_BRANCH_ID;
  let updated;
  withTransaction(() => {
    const row = ensureBranchRow(id, branchId);
    if (!getProduct(id)) throw new Error('المنتج غير موجود');
    const before = Number(row.quantity);
    const diff = n - before;
    db.prepare(
      'UPDATE branch_inventory SET quantity = ?, updated_at = ? WHERE branch_id = ? AND product_id = ?'
    ).run(n, nowStr(), branchId, Number(id));
    if (diff !== 0) {
      insMovement({
        productId: id, change: diff, reason: 'adjustment',
        before, after: n, actorId: opts.actorId,
        refType: 'adjustment', branchId, reasonCode: 'correction'
      });
    }
    if (branchId === DEFAULT_BRANCH_ID) syncDefaultMirror(id);
    updated = getProduct(id);
    updated.quantity = n;
  });
  return updated;
}

/* ---------------- Categories ---------------- */

function getCategory(id) {
  return db.prepare('SELECT * FROM categories WHERE id = ?').get(Number(id));
}

function listCategories() {
  return db.prepare(
    `SELECT c.*, COUNT(p.id) AS product_count
     FROM categories c LEFT JOIN products p ON p.category_id = c.id
     GROUP BY c.id
     ORDER BY product_count DESC, c.name COLLATE NOCASE`
  ).all();
}

function createCategory({ name, color }) {
  const n = String(name || '').trim();
  if (!n) throw new Error('اسم الفئة مطلوب');
  const exists = db.prepare('SELECT id FROM categories WHERE name = ?').get(n);
  if (exists) throw new Error(`الفئة "${n}" موجودة بالفعل`);
  const c = String(color || CATEGORY_PALETTE[0]);
  const res = db.prepare('INSERT INTO categories (name, color) VALUES (?, ?)').run(n, c);
  return getCategory(Number(res.lastInsertRowid));
}

function updateCategory(id, { name, color }) {
  const existing = getCategory(id);
  if (!existing) throw new Error('الفئة غير موجودة');
  const n = String(name ?? existing.name).trim() || existing.name;
  const dup = db.prepare('SELECT id FROM categories WHERE name = ? AND id != ?').get(n, Number(id));
  if (dup) throw new Error(`الفئة "${n}" موجودة بالفعل`);
  db.prepare('UPDATE categories SET name = ?, color = ? WHERE id = ?')
    .run(n, String(color || existing.color), Number(id));
  return getCategory(Number(id));
}

function deleteCategory(id, moveTo) {
  return withTransaction(() => {
    const cat = getCategory(id);
    if (!cat) throw new Error('الفئة غير موجودة');
    const targetId = resolveCategoryId(moveTo);
    if (targetId && targetId !== Number(id)) {
      db.prepare('UPDATE products SET category_id = ? WHERE category_id = ?').run(targetId, Number(id));
    } else {
      db.prepare('UPDATE products SET category_id = NULL WHERE category_id = ?').run(Number(id));
    }
    db.prepare('DELETE FROM categories WHERE id = ?').run(Number(id));
    return { ok: true };
  });
}

function categoryStats() {
  const total = db.prepare('SELECT COUNT(*) AS c FROM categories').get().c;
  const productsTotal = db.prepare('SELECT COUNT(*) AS c FROM products').get().c;
  const top = db.prepare(
    `SELECT c.name, COUNT(p.id) AS n
     FROM categories c JOIN products p ON p.category_id = c.id
     GROUP BY c.id ORDER BY n DESC LIMIT 1`
  ).get();
  const empty = db.prepare(
    'SELECT COUNT(*) AS c FROM categories c WHERE NOT EXISTS (SELECT 1 FROM products p WHERE p.category_id = c.id)'
  ).get().c;
  return {
    total,
    products_total: productsTotal,
    top_category: top ? top.name : null,
    top_count: top ? top.n : 0,
    empty_categories: empty
  };
}

/* ---------------- Suppliers ---------------- */

function getSupplier(id) {
  return db.prepare('SELECT * FROM suppliers WHERE id = ?').get(Number(id));
}

function listSuppliers() {
  return db.prepare(
    `SELECT * FROM suppliers
     ORDER BY CASE WHEN status = 'active' THEN 0 ELSE 1 END, name COLLATE NOCASE`
  ).all();
}

function createSupplier({ name, phone, email, address, notes } = {}) {
  const n = String(name || '').trim();
  if (!n) throw new Error('اسم المورد مطلوب');
  const dup = db.prepare('SELECT id FROM suppliers WHERE name = ? COLLATE NOCASE').get(n);
  if (dup) throw new Error(`المورد "${n}" موجود بالفعل`);
  const res = db.prepare(
    'INSERT INTO suppliers (name, phone, email, address, notes) VALUES (?, ?, ?, ?, ?)'
  ).run(n, String(phone || ''), String(email || ''), String(address || ''), String(notes || ''));
  return getSupplier(Number(res.lastInsertRowid));
}

function updateSupplier(id, patch = {}) {
  const existing = getSupplier(id);
  if (!existing) throw new Error('المورد غير موجود');
  const next = {
    name: String(patch.name ?? existing.name).trim() || existing.name,
    phone: String(patch.phone ?? existing.phone),
    email: String(patch.email ?? existing.email),
    address: String(patch.address ?? existing.address),
    notes: String(patch.notes ?? existing.notes)
  };
  const dup = db.prepare('SELECT id FROM suppliers WHERE name = ? COLLATE NOCASE AND id != ?')
    .get(next.name, Number(id));
  if (dup) throw new Error(`المورد "${next.name}" موجود بالفعل`);
  db.prepare(
    'UPDATE suppliers SET name = ?, phone = ?, email = ?, address = ?, notes = ?, updated_at = ? WHERE id = ?'
  ).run(next.name, next.phone, next.email, next.address, next.notes, nowStr(), Number(id));
  return getSupplier(Number(id));
}

function setSupplierStatus(id, status) {
  const existing = getSupplier(id);
  if (!existing) throw new Error('المورد غير موجود');
  if (!['active', 'disabled'].includes(status)) throw new Error('حالة غير صالحة');
  db.prepare('UPDATE suppliers SET status = ?, updated_at = ? WHERE id = ?')
    .run(status, nowStr(), Number(id));
  return getSupplier(Number(id));
}

function deleteSupplier(id) {
  const existing = getSupplier(id);
  if (!existing) throw new Error('المورد غير موجود');
  // Purchasing records will reference suppliers in Phase 22; the guard lands there.
  db.prepare('DELETE FROM suppliers WHERE id = ?').run(Number(id));
  return { ok: true };
}

/* ---------------- Alerts ---------------- */

function lowStockAlerts() {
  return db.prepare(
    `SELECT id, name, quantity, low_stock_threshold,
            CASE WHEN quantity = 0 THEN 'out' ELSE 'low' END AS severity
     FROM products
     WHERE quantity <= low_stock_threshold
     ORDER BY quantity ASC, name COLLATE NOCASE`
  ).all();
}

/* ---------------- Checkout (atomic sale) ---------------- */

function checkout({ items, discount = 0, paid, payment_method = 'cash' }, opts = {}) {
  if (!Array.isArray(items) || items.length === 0) throw new Error('السلة فارغة');
  const branchId = opts.branchId != null ? Number(opts.branchId) : DEFAULT_BRANCH_ID;

  const result = withTransaction(() => {
    const taxRatePct = getTaxRate();

    // Validate all stock levels first (inside the transaction)
    const lines = [];
    for (const it of items) {
      const qty = Math.trunc(Number(it.quantity));
      if (!(qty > 0)) throw new Error('كمية غير صالحة في السلة');
      const p = db.prepare('SELECT * FROM products WHERE id = ?').get(Number(it.product_id));
      if (!p) throw new Error('منتج غير موجود في قاعدة البيانات');
      ensureBranchRow(p.id, branchId);
      // Re-read after possible materialization; branch row is authoritative.
      const bi = getBranchRow(p.id, branchId);
      if (bi.quantity < qty) {
        throw new Error(`الكمية غير كافية للمنتج "${p.name}" (المتوفر: ${bi.quantity}، المطلوب: ${qty})`);
      }
      lines.push({ p, qty, bQty: Number(bi.quantity), bCost: round2(bi.cost) });
    }

    let subtotal = 0;
    let taxTotal = 0;
    const computed = lines.map(({ p, qty, bQty, bCost }) => {
      const lineSubtotal = round2(p.price * qty);
      const lineTax = round2(lineSubtotal * (taxRatePct / 100));
      subtotal += lineSubtotal;
      taxTotal += lineTax;
      return { p, qty, bQty, bCost, lineSubtotal, lineTax };
    });

    subtotal = round2(subtotal);
    taxTotal = round2(taxTotal);
    const disc = Math.max(0, round2(discount));
    const total = round2(Math.max(0, subtotal + taxTotal - disc));
    const paidNum = round2(paid);
    if (!(paidNum >= total)) {
      throw new Error(`المبلغ المدفوع (${paidNum.toFixed(2)}) أقل من الإجمالي (${total.toFixed(2)})`);
    }

    const seq = Number(db.prepare("SELECT value FROM settings WHERE key='invoice_seq'").get()?.value || 0) + 1;
    setSetting('invoice_seq', String(seq));
    const invoiceNo = 'INV-' + String(seq).padStart(6, '0');

    const saleRes = db.prepare(
      `INSERT INTO sales (invoice_no, subtotal, tax_total, discount, total, paid, change_amount, payment_method, branch_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(invoiceNo, subtotal, taxTotal, disc, total, paidNum, round2(paidNum - total), String(payment_method), branchId);
    const saleId = Number(saleRes.lastInsertRowid);

    const insItem = db.prepare(
      `INSERT INTO sale_items
       (sale_id, product_id, product_name, quantity, unit_price, unit_cost, tax_rate, line_subtotal, line_tax, line_total)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );
    const decBi = db.prepare(
      'UPDATE branch_inventory SET quantity = quantity - ?, updated_at = ? WHERE branch_id = ? AND product_id = ?'
    );

    for (const c of computed) {
      insItem.run(
        saleId, c.p.id, c.p.name, c.qty, c.p.price, c.bCost,
        taxRatePct, c.lineSubtotal, c.lineTax, round2(c.lineSubtotal + c.lineTax)
      );
      decBi.run(c.qty, nowStr(), branchId, c.p.id);
      const balanceAfter = c.bQty - c.qty;
      insMovement({
        productId: c.p.id, change: -c.qty, reason: 'sale',
        refType: 'sale', refId: saleId,
        before: c.bQty, after: balanceAfter,
        actorId: opts.actorId, branchId
      });
      if (branchId === DEFAULT_BRANCH_ID) syncDefaultMirror(c.p.id);
    }

    return getSale(saleId);
  });

  return result;
}

/* ---------------- Sales history ---------------- */

function listSales(limit = 100) {
  return db.prepare(
    `SELECT s.*, b.name AS branch_name
     FROM sales s LEFT JOIN branches b ON b.id = s.branch_id
     ORDER BY s.id DESC LIMIT ?`
  ).all(Math.min(Math.max(1, Math.trunc(Number(limit) || 100)), 500));
}

function getSale(id) {
  const sale = db.prepare(
    `SELECT s.*, b.name AS branch_name
     FROM sales s LEFT JOIN branches b ON b.id = s.branch_id
     WHERE s.id = ?`
  ).get(Number(id));
  if (!sale) return null;
  sale.items = db.prepare('SELECT * FROM sale_items WHERE sale_id = ?').all(Number(id));
  return sale;
}

function todayStats() {
  const s = db.prepare(
    `SELECT COALESCE(COUNT(*), 0) AS sales_count,
            COALESCE(SUM(total), 0) AS revenue,
            COALESCE(SUM(tax_total), 0) AS tax,
            COALESCE(SUM(discount), 0) AS discount
     FROM sales WHERE date(created_at) = date('now')`
  ).get();
  const cogsRow = db.prepare(
    `SELECT COALESCE(SUM(si.unit_cost * si.quantity), 0) AS cogs
     FROM sale_items si JOIN sales s ON s.id = si.sale_id
     WHERE date(s.created_at) = date('now')`
  ).get();
  const revenue = round2(s.revenue);
  const profit = round2(revenue - s.tax - cogsRow.cogs);
  return {
    sales_count: s.sales_count,
    revenue,
    tax: round2(s.tax),
    discount: round2(s.discount),
    profit
  };
}

/* ---------------- Movements log ---------------- */

function listMovements(limit = 200) {
  return db.prepare(
    `SELECT m.*, p.name AS product_name, b.name AS branch_name
     FROM inventory_movements m
     JOIN products p ON p.id = m.product_id
     LEFT JOIN branches b ON b.id = m.branch_id
     ORDER BY m.id DESC LIMIT ?`
  ).all(Math.min(Math.max(1, Math.trunc(Number(limit) || 200)), 1000));
}

function close() {
  if (db) {
    try { db.close(); } finally { db = null; }
  }
}

module.exports = {
  init,
  close,
  getDb,
  round2,
  getSettings,
  setSetting,
  getTaxRate,
  listProducts,
  getProduct,
  createProduct,
  updateProduct,
  deleteProduct,
  restock,
  adjustQuantity,
  getCategory,
  listCategories,
  createCategory,
  updateCategory,
  deleteCategory,
  categoryStats,
  getSupplier,
  listSuppliers,
  createSupplier,
  updateSupplier,
  setSupplierStatus,
  deleteSupplier,
  lowStockAlerts,
  checkout,
  listSales,
  getSale,
  todayStats,
  listMovements,
  DEFAULT_BRANCH_ID,
  getBranchRow,
  ensureBranchRow,
  syncDefaultMirror
};
