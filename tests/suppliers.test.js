'use strict';

/*
 * Phase 21 tests — Suppliers (M002).
 * Pure Node: no Electron. Exercises migration + supplier CRUD + RBAC gating.
 */

const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const db = require('../src/main/db');
const auth = require('../src/main/auth');

let passed = 0;
let failed = 0;

function assert(cond, label) {
  if (cond) { passed++; console.log('  PASS', label); }
  else { failed++; console.error('  FAIL', label); }
}

async function expectError(promise, label) {
  try {
    await promise;
    failed++;
    console.error('  FAIL', label, '(no error thrown)');
  } catch (e) {
    passed++;
    console.log('  PASS', label, '->', e.message);
  }
}

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pos-suppliers-test-'));
db.init(path.join(tmpDir, 'test.db'));
auth.init();

(async () => {

  console.log('\n[A] Migration M002');
  const tables = db.getDb().prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(r => r.name);
  assert(tables.includes('suppliers'), 'suppliers table created');
  const mig = db.getDb().prepare("SELECT version FROM schema_migrations WHERE name = 'suppliers'").get();
  assert(mig && Number(mig.version) === 2, 'M002 recorded in schema_migrations');
  const cols = db.getDb().prepare('PRAGMA table_info(suppliers)').all().map(c => c.name);
  for (const c of ['id', 'name', 'phone', 'email', 'address', 'notes', 'status', 'created_at', 'updated_at']) {
    assert(cols.includes(c), `column ${c} present`);
  }

  console.log('\n[B] Supplier CRUD & validation');
  await expectError(Promise.resolve().then(() => db.createSupplier({ name: '   ' })), 'blank name rejected');
  await expectError(Promise.resolve().then(() => db.createSupplier(null)), 'null payload rejected');

  const s1 = db.createSupplier({ name: 'الشركة الوطنية', phone: '0501234567', email: 'nat@ex.com' });
  assert(s1.id > 0 && s1.status === 'active', 'supplier created with defaults (active)');
  assert(s1.phone === '0501234567' && s1.email === 'nat@ex.com' && s1.address === '' && s1.notes === '', 'optional fields default to empty strings');

  await expectError(Promise.resolve().then(() => db.createSupplier({ name: 'الشركة الوطنية' })), 'duplicate name rejected');
  const s3 = db.createSupplier({ name: 'الوطنية للتجارة' });
  assert(s3.id > 0, 'distinct name accepted');
  await expectError(Promise.resolve().then(() => db.createSupplier({ name: 'الوطنية للتجارة ' })), 'duplicate check trims whitespace');

  const u1 = db.updateSupplier(s1.id, { phone: '0599999999', notes: 'توريد أسبوعي' });
  assert(u1.phone === '0599999999' && u1.notes === 'توريد أسبوعي', 'partial update keeps other fields');
  assert(u1.name === 'الشركة الوطنية', 'name unchanged when not patched');
  await expectError(Promise.resolve().then(() => db.updateSupplier(99999, { name: 'x' })), 'updating missing supplier rejected');
  // ensure the dup guard actually triggers with a real second supplier
  const s2 = db.createSupplier({ name: 'مستودع الرياض' });
  await expectError(Promise.resolve().then(() => db.updateSupplier(s2.id, { name: 'الشركة الوطنية' })), 'update to duplicate name rejected');
  await expectError(Promise.resolve().then(() => db.setSupplierStatus(s2.id, 'bogus')), 'invalid status rejected');
  const dis = db.setSupplierStatus(s2.id, 'disabled');
  assert(dis.status === 'disabled' && dis.updated_at, 'status toggle persists + updated_at stamped');
  const list = db.listSuppliers();
  assert(list.length >= 2 && list[0].status === 'active', 'active suppliers listed before disabled');
  await expectError(Promise.resolve().then(() => db.deleteSupplier(424242)), 'deleting missing supplier rejected');
  const del = db.deleteSupplier(s2.id);
  assert(del.ok === true && !db.getSupplier(s2.id), 'supplier deleted');

  console.log('\n[C] Business data untouched by M002');
  const prodCount = db.getDb().prepare('SELECT COUNT(*) AS c FROM products').get().c;
  assert(prodCount >= 0, 'products table still queryable after migration');

  console.log('\n[D] RBAC gating');
  const ownerU = { role: 'owner', status: 'active' };
  const adminU = auth.createUser(ownerU, { username: 'supadmin', password: 'AdminPass1!', role: 'admin' });
  const mgrU = auth.createUser(adminU, { username: 'supmgr', password: 'ManagerPass1!', role: 'manager' });
  const cashU = auth.createUser(adminU, { username: 'supcash', password: 'CashierPass1!', role: 'cashier' });
  assert(!auth.can(mgrU, 'users.manage'), 'manager cannot manage users (policy intact)');

  assert(auth.can(ownerU, 'suppliers.read') && auth.can(ownerU, 'suppliers.manage'), 'owner has supplier permissions');
  assert(auth.can(adminU, 'suppliers.read') && auth.can(adminU, 'suppliers.manage'), 'admin has supplier permissions');
  assert(auth.can(mgrU, 'suppliers.read') && auth.can(mgrU, 'suppliers.manage'), 'manager has supplier permissions');
  assert(!auth.can(cashU, 'suppliers.read') && !auth.can(cashU, 'suppliers.manage'), 'cashier has no supplier permissions');
  let threw = false;
  try { auth.assertCan(cashU, 'suppliers.manage'); } catch { threw = true; }
  assert(threw, 'assertCan throws for cashier on suppliers.manage');

  console.log('\n[E] Checkout regression (business logic intact post-migration)');
  const cats = db.listCategories();
  const catId = cats.length ? cats[0].id : db.createCategory({ name: 'اختبار' }).id;
  const p = db.createProduct({ name: 'منتج مورد', price: 10, cost: 5, quantity: 5, category_id: catId });
  const sale = db.checkout({ items: [{ product_id: p.id, quantity: 2 }], paid: 100 });
  assert(sale && sale.id > 0, 'checkout works after suppliers migration');
  assert(db.getProduct(p.id).quantity === 3, 'stock decremented correctly');

  console.log(`\n========== ${passed} passed, ${failed} failed ==========`);
  process.exit(failed ? 1 : 0);

})().catch((err) => {
  console.error('HARNESS ERROR:', err);
  process.exit(1);
});
