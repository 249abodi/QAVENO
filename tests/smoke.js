'use strict';

const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const db = require('../src/main/db');

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

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pos-test-'));
db.init(path.join(tmpDir, 'test.db'));

(async () => {

console.log('\n[1] Seed data');
const seeded = db.listProducts();
assert(seeded.length === 10, `seeded products count = ${seeded.length}`);

console.log('\n[2] Settings defaults');
let s = db.getSettings();
assert(s.tax_rate === '15' && s.currency === 'ر.س' && s.store_name === 'متجري', 'default settings exist');
assert(db.getTaxRate() === 15, 'tax rate parses to 15');
assert(s.lang === 'ar' && s.theme === 'light', 'lang/theme defaults exist');

console.log('\n[2b] Preference persistence');
db.setSetting('lang', 'en');
db.setSetting('theme', 'dark');
s = db.getSettings();
assert(s.lang === 'en' && s.theme === 'dark', 'lang/theme persist after set');

console.log('\n[3] Product CRUD');
const p = db.createProduct({ name: 'منتج اختبار', barcode: '9999', price: 100, cost: 60, quantity: 20, low_stock_threshold: 5 });
assert(p.id > 0 && p.quantity === 20, 'create product');
const p2 = db.updateProduct(p.id, { price: 120 });
assert(p2.price === 120 && p2.quantity === 20, 'update keeps quantity when not provided');
assert(db.listProducts('اختبار').some(x => x.id === p.id), 'search finds product');

console.log('\n[4] Restock & adjust');
const r1 = db.restock(p.id, 10, 'فاتورة توريد #12');
assert(r1.quantity === 30, 'restock adds quantity');
const r2 = db.adjustQuantity(p.id, 25);
assert(r2.quantity === 25, 'adjust sets exact quantity');

console.log('\n[5] Checkout — happy path');
const sale = db.checkout({
  items: [
    { product_id: p.id, quantity: 3 },
    { product_id: seeded[0].id, quantity: 1 }
  ],
  discount: 10,
  paid: 10000,
  payment_method: 'cash'
});
// line1: 3*120=360 ; line2: 45*1=45 ; subtotal=405 ; tax=405*.15=60.75 ; total=405+60.75-10=455.75
assert(sale.invoice_no === 'INV-000001', `invoice number = ${sale.invoice_no}`);
assert(sale.subtotal === 405, `subtotal = ${sale.subtotal}`);
assert(sale.tax_total === 60.75, `tax total = ${sale.tax_total}`);
assert(sale.total === 455.75, `total after discount = ${sale.total}`);
assert(sale.change_amount === 10000 - 455.75, 'change computed');
assert(sale.items.length === 2, 'sale items saved');
assert(db.getProduct(p.id).quantity === 22, 'stock decremented atomically');
assert(seeded[0].name.startsWith('أرز'), 'seed lookup ok');

console.log('\n[6] Checkout — conflict guards');
await expectError(
  Promise.resolve().then(() => db.checkout({ items: [{ product_id: seeded[6].id, quantity: 999 }], paid: 999999 })),
  'overselling rejected'
);
await expectError(
  Promise.resolve().then(() => db.checkout({ items: [{ product_id: p.id, quantity: 1 }], paid: 0.01 })),
  'insufficient payment rejected'
);
await expectError(
  Promise.resolve().then(() => db.checkout({ items: [], paid: 100 })),
  'empty cart rejected'
);

console.log('\n[7] Low stock alerts');
const alerts = db.lowStockAlerts();
// seeded low/out: شاي(4), معكرونة(3), بطاريات(0) + threshold defaults
assert(alerts.some(a => a.name.includes('بطاريات') && a.severity === 'out'), 'out-of-stock detected');
assert(alerts.some(a => a.name.includes('شاي')), 'low-stock detected');

console.log('\n[8] Movements log');
const movs = db.listMovements(500);
const prodMoves = movs.filter(m => m.product_id === p.id).map(m => m.reason);
assert(prodMoves.includes('initial'), 'initial movement logged');
assert(prodMoves.filter(r => r === 'restock').length === 1, 'restock movement logged');
assert(prodMoves.filter(r => r === 'adjustment').length === 1, 'adjustment movement logged');
assert(prodMoves.filter(r => r === 'sale').length === 1, 'sale movement logged');

console.log('\n[9] Today stats');
const stats = db.todayStats();
assert(stats.sales_count >= 1, `sales counted today = ${stats.sales_count}`);
assert(stats.revenue >= sale.total, `revenue includes sale = ${stats.revenue}`);
assert(stats.profit < stats.revenue, 'profit less than revenue (has COGS+tax)');

console.log('\n[10] Delete guards');
await expectError(Promise.resolve().then(() => db.deleteProduct(p.id)), 'cannot delete sold product');
db.deleteProduct(seeded[9].id); // بطاريات has no sales
assert(!db.getProduct(seeded[9].id), 'unsold product deleted');

console.log('\n[11] Categories');
const cats = db.listCategories();
assert(cats.length === 6, `backfilled legacy categories = ${cats.length}`);
assert(cats.every(c => c.product_count > 0), 'product counts joined correctly');
const newCat = db.createCategory({ name: 'فئة اختبار', color: '#123456' });
assert(newCat.id > 0 && newCat.color === '#123456', 'create category with color');
await expectError(Promise.resolve().then(() => db.createCategory({ name: 'فئة اختبار' })), 'duplicate category name rejected');
const updCat = db.updateCategory(newCat.id, { color: '#654321' });
assert(updCat.color === '#654321' && updCat.name === 'فئة اختبار', 'update category keeps unspecified fields');
const movedProd = db.createProduct({ name: 'منتج منقول', price: 5, quantity: 1, category_id: newCat.id });
assert(db.listCategories().find(c => c.id === newCat.id).product_count === 1, 'product_count reflects assignment');
db.deleteCategory(newCat.id, null);
assert(!db.getCategory(newCat.id), 'category deleted');
assert(db.getProduct(movedProd.id).category_id === null, 'products detached when no moveTo');
const catB = db.createCategory({ name: 'هدف النقل' });
db.updateProduct(movedProd.id, { category_id: catB.id });
db.deleteCategory(catB.id, seeded[0].id);
assert(db.getProduct(movedProd.id).category_id === seeded[0].id, 'moveTo reassigns products to target');
const catStats = db.categoryStats();
assert(Number.isInteger(catStats.total) && Number.isInteger(catStats.products_total)
  && Number.isInteger(catStats.empty_categories), 'category stats shape ok');
const joined = db.getProduct(movedProd.id);
assert(joined.category_name !== undefined && joined.category_color !== undefined, 'products join category info');

db.close();
try {
  fs.rmSync(tmpDir, { recursive: true, force: true });
} catch { /* temp dir cleanup is best-effort on Windows */ }
console.log(`\n========== ${passed} passed, ${failed} failed ==========`);
process.exit(failed ? 1 : 0);

})().catch(e => { console.error(e); process.exit(1); });
