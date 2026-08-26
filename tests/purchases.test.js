'use strict';

/*
 * Phase 22 tests — Purchasing & GRN (M003).
 * Pure Node: no Electron. Exercises migration + purchasing service +
 * transactional inventory integration + RBAC gating.
 */

const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const db = require('../src/main/db');
const auth = require('../src/main/auth');
const purchases = require('../src/main/purchases');

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
    console.log('  PASS', label, '->', String(e.message).slice(0, 60));
  }
}

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pos-purchases-test-'));
db.init(path.join(tmpDir, 'test.db'));
auth.init();

(async () => {

  /* ---- shared fixtures ---- */
  const owner = auth.setupOwner({ username: 'owner', password: 'OwnerPass1!', display_name: 'المالك' });
  const ACTOR = owner.id;
  const supplier = db.createSupplier({ name: 'مورد الاختبار', phone: '0500000000' });
  const catId = db.listCategories()[0].id;
  const P = db.createProduct({ name: 'منتج WAC', price: 20, cost: 10, quantity: 100, category_id: catId });
  const Q = db.createProduct({ name: 'منتج جزئي', price: 15, cost: 5, quantity: 0, category_id: catId });
  const R = db.createProduct({ name: 'منتج تالف', price: 8, cost: 3, quantity: 7, category_id: catId });
  const D1 = db.createProduct({ name: 'تراجع ١', price: 9, cost: 4, quantity: 30, category_id: catId });
  const D2 = db.createProduct({ name: 'تراجع ٢', price: 11, cost: 6, quantity: 12, category_id: catId });

  function movementsFor(productId) {
    return db.getDb().prepare(
      "SELECT * FROM inventory_movements WHERE product_id = ? AND reason LIKE 'grn%' ORDER BY id"
    ).all(Number(productId));
  }

  console.log('\n[A] Migration M003');
  const tables = db.getDb().prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(r => r.name);
  for (const t of ['purchase_orders', 'purchase_order_items', 'grns', 'grn_items']) {
    assert(tables.includes(t), `table ${t} created`);
  }
  const mig = db.getDb().prepare("SELECT version FROM schema_migrations WHERE name = 'purchasing-grn'").get();
  assert(mig && Number(mig.version) === 3, 'M003 recorded in schema_migrations');

  console.log('\n[B] Purchase order creation & validation');
  await expectError(Promise.resolve().then(() =>
    purchases.createPurchaseOrder(null, { supplier_id: supplier.id, items: [] })), 'empty items rejected');
  await expectError(Promise.resolve().then(() =>
    purchases.createPurchaseOrder(null, { supplier_id: supplier.id, items: [{ product_id: P.id, qty: 0, unit_cost: 5 }] })), 'zero qty rejected');
  await expectError(Promise.resolve().then(() =>
    purchases.createPurchaseOrder(null, { supplier_id: supplier.id, items: [{ product_id: P.id, qty: 5, unit_cost: -1 }] })), 'negative cost rejected');
  await expectError(Promise.resolve().then(() =>
    purchases.createPurchaseOrder(null, { supplier_id: supplier.id, items: [{ product_id: 987654, qty: 5, unit_cost: 1 }] })), 'unknown product rejected');
  await expectError(Promise.resolve().then(() =>
    purchases.createPurchaseOrder(null, { supplier_id: 987654, items: [{ product_id: P.id, qty: 5, unit_cost: 1 }] })), 'unknown supplier rejected');
  const disabledSup = db.createSupplier({ name: 'مورد معطل' });
  db.setSupplierStatus(disabledSup.id, 'disabled');
  await expectError(Promise.resolve().then(() =>
    purchases.createPurchaseOrder(null, { supplier_id: disabledSup.id, items: [{ product_id: P.id, qty: 5, unit_cost: 1 }] })), 'disabled supplier rejected');

  const po1 = purchases.createPurchaseOrder(null, {
    supplier_id: supplier.id,
    notes: 'توريد شهري',
    expected_at: '2026-09-01',
    items: [{ product_id: P.id, qty: 50, unit_cost: 16 }]
  });
  assert(po1.status === 'draft' && po1.ref === 'PO-0001', `draft PO created with ref (${po1.ref})`);
  assert(po1.total_cost === 800 && po1.ordered_qty === 50, 'totals computed (50 x 16 = 800)');
  assert(po1.items[0].product_name === 'منتج WAC', 'item joined with product name');
  assert(po1.items[0].received_qty === 0, 'new PO has zero received');

  console.log('\n[C] Draft editing');
  const po2 = purchases.createPurchaseOrder(null, {
    supplier_id: supplier.id,
    items: [
      { product_id: Q.id, qty: 20, unit_cost: 8 },
      { product_id: D1.id, qty: 10, unit_cost: 4 }
    ]
  });
  const merged = purchases.addPoItem(null, po2.id, { product_id: Q.id, qty: 5, unit_cost: 8.5 });
  assert(merged.items.length === 2, 'add-item merges duplicate product into one line');
  const qLine = merged.items.find(i => i.product_id === Q.id);
  assert(qLine.qty === 25 && qLine.unit_cost === 8.5, 'merge sums qty and takes newest cost');
  const setLine = purchases.setPoItem(null, qLine.id, { qty: 22 });
  assert(setLine.items.find(i => i.id === qLine.id).qty === 22, 'set-item updates quantity');
  const afterRm = purchases.removePoItem(null, setLine.items.find(i => i.product_id === D1.id).id);
  assert(afterRm.items.length === 1, 'remove-item deletes line');
  await expectError(Promise.resolve().then(() =>
    purchases.removePoItem(null, afterRm.items[0].id)), 'removing last remaining line rejected');
  const updMeta = purchases.updatePurchaseOrder(null, po2.id, { expected_at: '2026-10-15', items: [{ product_id: Q.id, qty: 20, unit_cost: 8 }] });
  assert(updMeta.expected_at === '2026-10-15' && updMeta.items.length === 1, 'update replaces meta and items');
  await expectError(Promise.resolve().then(() =>
    purchases.updatePurchaseOrder(null, 424242, { notes: 'x' })), 'updating missing PO rejected');

  console.log('\n[D] Lifecycle transitions');
  await expectError(Promise.resolve().then(() =>
    purchases.approvePurchaseOrder(null, po2.id)), 'approving a draft rejected');
  await expectError(Promise.resolve().then(() =>
    purchases.receiveGoods(null, { po_id: po2.id, items: [] })), 'receiving a non-approved PO rejected');
  const sub2 = purchases.submitPurchaseOrder(po2.id);
  assert(sub2.status === 'submitted', 'submit: draft -> submitted');
  await expectError(Promise.resolve().then(() =>
    purchases.addPoItem(null, po2.id, { product_id: P.id, qty: 1, unit_cost: 1 })), 'editing locked after submit');
  const app2 = purchases.approvePurchaseOrder(ACTOR, po2.id);
  assert(app2.status === 'approved' && app2.approved_by === ACTOR && app2.approved_at, 'approve stamps actor + time');
  await expectError(Promise.resolve().then(() =>
    purchases.submitPurchaseOrder(po2.id)), 're-submitting an approved PO rejected');

  const poC = purchases.createPurchaseOrder(null, { supplier_id: supplier.id, items: [{ product_id: P.id, qty: 3, unit_cost: 2 }] });
  const cancelled = purchases.cancelPurchaseOrder(poC.id, 'تغيير الخطة');
  assert(cancelled.status === 'cancelled' && cancelled.cancel_reason === 'تغيير الخطة', 'cancel from draft works with reason');
  await expectError(Promise.resolve().then(() =>
    purchases.cancelPurchaseOrder(poC.id, '')), 'double cancel rejected');
  await expectError(Promise.resolve().then(() =>
    purchases.submitPurchaseOrder(poC.id)), 'submitting a cancelled PO rejected');

  console.log('\n[E] Full receive + weighted average cost');
  purchases.submitPurchaseOrder(po1.id);
  purchases.approvePurchaseOrder(ACTOR, po1.id);
  // receive requires explicit lines; empty array must fail
  await expectError(Promise.resolve().then(() =>
    purchases.receiveGoods(ACTOR, { po_id: po1.id, items: [] })), 'receive with no lines rejected');

  const grn1 = purchases.receiveGoods(ACTOR, {
    po_id: po1.id,
    items: [{ po_item_id: po1.items[0].id, qty_received: 50 }],
    notes: 'استلام كامل'
  });
  assert(grn1.grn.ref.startsWith('GRN-'), `GRN ref assigned (${grn1.grn.ref})`);
  assert(grn1.po.status === 'fully_received', 'PO fully received');
  assert(db.getProduct(P.id).quantity === 150, 'stock increased by 50 (100 -> 150)');
  const wac = db.getProduct(P.id).cost;
  assert(Math.abs(wac - 12) < 1e-9, `WAC exact: (10x100 + 16x50)/150 = ${wac}`);
  const mv1 = movementsFor(P.id);
  assert(mv1.length === 1 && mv1[0].change === 50 && mv1[0].reason === 'grn', 'movement recorded with reason grn');
  assert(mv1[0].ref_type === 'grn' && mv1[0].ref_id === grn1.grn.id && mv1[0].balance_after === 150,
    'movement references the GRN document');
  await expectError(Promise.resolve().then(() =>
    purchases.receiveGoods(ACTOR, { po_id: po1.id, items: [{ po_item_id: po1.items[0].id, qty_received: 1 }] })),
    'receiving against fully-received PO rejected');

  console.log('\n[F] Partial receiving, damaged units, over-receive guard');
  const poP = purchases.createPurchaseOrder(null, {
    supplier_id: supplier.id,
    items: [{ product_id: Q.id, qty: 20, unit_cost: 8 }]
  });
  purchases.submitPurchaseOrder(poP.id);
  purchases.approvePurchaseOrder(null, poP.id);
  const gPart = purchases.receiveGoods(null, {
    po_id: poP.id,
    items: [{ po_item_id: poP.items[0].id, qty_received: 12, qty_damaged: 2 }]
  });
  assert(gPart.po.status === 'partially_received', 'partial receipt -> partially_received');
  assert(db.getProduct(Q.id).quantity === 10, 'damaged units excluded from sellable stock (12-2=10 added)');
  const poiAfter = purchases.getPurchaseOrder(poP.id).items[0];
  assert(poiAfter.received_qty === 12, 'damaged units still count against ordered qty');
  assert(gPart.grn.items[0].qty_damaged === 2, 'damaged qty persisted on GRN line');
  await expectError(Promise.resolve().then(() =>
    purchases.receiveGoods(null, {
      po_id: poP.id,
      items: [{ po_item_id: poP.items[0].id, qty_received: 9 }]
    })), 'over-receive beyond ordered qty rejected (12+9 > 20)');
  const gRest = purchases.receiveGoods(null, {
    po_id: poP.id,
    items: [{ po_item_id: poP.items[0].id, qty_received: 8 }]
  });
  assert(gRest.po.status === 'fully_received', 'second receipt completes the PO');
  assert(db.getProduct(Q.id).quantity === 18, 'stock correct across two receipts (10+8)');
  assert(purchases.listGrns({ po_id: poP.id }).length === 2, 'both GRNs listed per PO');

  const poD = purchases.createPurchaseOrder(null, {
    supplier_id: supplier.id,
    items: [{ product_id: R.id, qty: 5, unit_cost: 3 }]
  });
  purchases.submitPurchaseOrder(poD.id);
  purchases.approvePurchaseOrder(null, poD.id);
  const gDam = purchases.receiveGoods(null, {
    po_id: poD.id,
    items: [{ po_item_id: poD.items[0].id, qty_received: 5, qty_damaged: 5 }]
  });
  assert(gDam.po.status === 'fully_received', 'damaged-only receipt completes PO');
  assert(db.getProduct(R.id).quantity === 7, 'no stock change for all-damaged line');
  const mvD = movementsFor(R.id);
  assert(mvD.length === 1 && mvD[0].reason === 'grn_damaged' && mvD[0].change === 0,
    'damaged-only line leaves zero-qty ledger entry');

  console.log('\n[G] Rollback atomicity');
  const stockD1 = db.getProduct(D1.id);
  const stockD2 = db.getProduct(D2.id);
  const poR = purchases.createPurchaseOrder(null, {
    supplier_id: supplier.id,
    items: [
      { product_id: D1.id, qty: 6, unit_cost: 5 },
      { product_id: D2.id, qty: 4, unit_cost: 7 }
    ]
  });
  purchases.submitPurchaseOrder(poR.id);
  purchases.approvePurchaseOrder(null, poR.id);
  const grnCountBefore = db.getDb().prepare('SELECT COUNT(*) AS c FROM grns').get().c;
  const movCountBefore = db.getDb().prepare("SELECT COUNT(*) AS c FROM inventory_movements WHERE reason LIKE 'grn%'").get().c;
  await expectError(Promise.resolve().then(() =>
    purchases.receiveGoods(null, {
      po_id: poR.id,
      items: [
        { po_item_id: poR.items[0].id, qty_received: 6 },
        { po_item_id: 999999, qty_received: 4 }
      ]
    })), 'bogus second line throws mid-transaction');
  assert(db.getProduct(D1.id).quantity === stockD1.quantity, 'rollback restored stock of first line');
  assert(db.getProduct(D1.id).cost === stockD1.cost, 'rollback restored cost of first line');
  assert(purchases.getPurchaseOrder(poR.id).items[0].received_qty === 0, 'rollback restored received_qty');
  assert(db.getDb().prepare('SELECT COUNT(*) AS c FROM grns').get().c === grnCountBefore, 'rollback removed GRN header');
  assert(db.getDb().prepare("SELECT COUNT(*) AS c FROM inventory_movements WHERE reason LIKE 'grn%'").get().c === movCountBefore,
    'rollback removed inventory movements');
  const poStill = purchases.getPurchaseOrder(poR.id);
  assert(poStill.status === 'approved', 'PO status unchanged after failed receive');

  console.log('\n[H] Supplier purchase history & read models');
  const hist = purchases.supplierPurchaseHistory(supplier.id);
  assert(hist.length >= 4 && hist.every(h => h.supplier_id === supplier.id), 'history filtered by supplier');
  const byRef = hist.find(h => h.ref === 'PO-0001');
  assert(byRef && Number(byRef.total_cost) === 800 && byRef.grn_count === 1, 'history includes totals + GRN count');
  const fullPo = purchases.getPurchaseOrder(po1.id);
  assert(fullPo.items.every(i => i.product_name), 'getPurchaseOrder joins product names');

  console.log('\n[I] Permission matrix');
  const ownerU = { role: 'owner', status: 'active' };
  const adminU = { role: 'admin', status: 'active' };
  const mgrU = { role: 'manager', status: 'active' };
  const cashU = { role: 'cashier', status: 'active' };
  for (const perm of ['purchases.read', 'purchases.create', 'purchases.update', 'purchases.approve', 'purchases.receive', 'purchases.cancel']) {
    assert(auth.can(ownerU, perm) && auth.can(adminU, perm), `${perm}: owner+admin granted`);
  }
  assert(auth.can(mgrU, 'purchases.read') && auth.can(mgrU, 'purchases.create') &&
    auth.can(mgrU, 'purchases.update') && auth.can(mgrU, 'purchases.receive'),
    'manager: read/create/update/receive granted');
  assert(!auth.can(mgrU, 'purchases.approve') && !auth.can(mgrU, 'purchases.cancel'),
    'manager: approve/cancel denied (separation of duties)');
  for (const perm of ['purchases.read', 'purchases.create', 'purchases.update', 'purchases.approve', 'purchases.receive', 'purchases.cancel']) {
    assert(!auth.can(cashU, perm), `cashier denied: ${perm}`);
  }

  console.log('\n[J] Regression — checkout untouched');
  const sale = db.checkout({ items: [{ product_id: P.id, quantity: 1 }], paid: 100 });
  assert(sale && sale.id > 0, 'checkout still works alongside purchasing tables');
  assert(db.getProduct(P.id).quantity === 149, 'sale decremented stock normally (150 -> 149)');

  console.log(`\n========== ${passed} passed, ${failed} failed ==========`);
  process.exit(failed ? 1 : 0);

})().catch((err) => {
  console.error('HARNESS ERROR:', err);
  process.exit(1);
});
