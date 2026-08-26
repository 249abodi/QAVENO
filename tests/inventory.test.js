'use strict';

/*
 * Phase 23 tests — Advanced Inventory (M004).
 * Pure Node: no Electron. Covers ledger integrity, controlled adjustments
 * (incl. mid-transaction rollback), reconciliation with stale-snapshot
 * safety, cost/WAC history, exact valuation arithmetic, reorder rules,
 * filtered/paged movement queries, and legacy-path regression.
 */

const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const db = require('../src/main/db');
const auth = require('../src/main/auth');
const purchases = require('../src/main/purchases');
const inventory = require('../src/main/inventory');

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

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pos-inventory-test-'));
db.init(path.join(tmpDir, 'test.db'));
auth.init();

(async () => {

  /* ---- shared fixtures ---- */
  const owner = auth.setupOwner({ username: 'owner', password: 'OwnerPass1!', display_name: 'المالك' });
  const ACTOR = owner.id;
  const supplier = db.createSupplier({ name: 'مورد الجرد' });
  const catId = db.listCategories()[0].id;
  const P = db.createProduct({ name: 'منتج جرد أ', price: 30, cost: 12, quantity: 150, category_id: catId });
  const Q = db.createProduct({ name: 'منتج جرد ب', price: 20, cost: 5, quantity: 40, category_id: catId });
  const R = db.createProduct({ name: 'منتج جرد ج', price: 10, cost: 2, quantity: 3, low_stock_threshold: 10, category_id: catId });

  function movementsFor(productId, reason) {
    const where = reason ? 'AND reason = ?' : '';
    return db.getDb().prepare(
      `SELECT * FROM inventory_movements WHERE product_id = ? ${where} ORDER BY id`
    ).all(Number(productId), ...(reason ? [reason] : []));
  }
  function auditCount(action) {
    return db.getDb().prepare('SELECT COUNT(*) AS c FROM audit_log WHERE action = ?').get(action).c;
  }

  console.log('\n[A] Migration M004');
  const mvCols = db.getDb().prepare('PRAGMA table_info(inventory_movements)').all().map(c => c.name);
  for (const col of ['actor_id', 'balance_before', 'reason_code']) {
    assert(mvCols.includes(col), `inventory_movements.${col} added`);
  }
  const prodCols = db.getDb().prepare('PRAGMA table_info(products)').all().map(c => c.name);
  assert(prodCols.includes('reorder_qty'), 'products.reorder_qty added');
  const tables = db.getDb().prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(r => r.name);
  assert(tables.includes('stock_reconciliations'), 'table stock_reconciliations created');
  assert(tables.includes('cost_history'), 'table cost_history created');
  const mig = db.getDb().prepare("SELECT version FROM schema_migrations WHERE name = 'advanced-inventory'").get();
  assert(mig && Number(mig.version) === 4, 'M004 recorded in schema_migrations');

  console.log('\n[B] Ledger integrity on creation & sale');
  const pInit = movementsFor(P.id, 'initial')[0];
  assert(pInit && pInit.balance_before === 0 && pInit.balance_after === 150,
    'initial movement stamped balance_before=0 / after=150');
  const initCost = db.getDb().prepare(
    "SELECT * FROM cost_history WHERE product_id = ? AND source_type = 'initial'"
  ).get(P.id);
  assert(initCost && Number(initCost.new_cost) === 12 && initCost.prev_cost === null,
    'cost_history initial row recorded (new_cost=12)');
  const sale = db.checkout({ items: [{ product_id: P.id, quantity: 5 }], paid: 1000 }, { actorId: ACTOR });
  const saleMv = movementsFor(P.id, 'sale').at(-1);
  assert(saleMv && saleMv.ref_type === 'sale' && Number(saleMv.ref_id) === sale.id,
    'sale movement linked to sale document');
  assert(Number(saleMv.balance_before) === 150 && Number(saleMv.balance_after) === 145,
    'sale movement stamped before=150 after=145');
  assert(Number(saleMv.actor_id) === ACTOR, 'sale movement stamped actor');
  // Chain invariant: latest movement balance equals authoritative stock.
  const chainOk = db.getDb().prepare(
    `SELECT COUNT(*) AS c FROM products pr WHERE pr.quantity != (
       SELECT m.balance_after FROM inventory_movements m
       WHERE m.product_id = pr.id ORDER BY m.id DESC LIMIT 1)`
  ).get().c;
  assert(chainOk === 0, 'ledger chain invariant holds (last balance_after == product quantity)');

  console.log('\n[C] Controlled adjustments');
  const inc = inventory.adjustStock(ACTOR, { product_id: P.id, delta: 7, reason_code: 'found', note: 'وجدت بكرات' });
  assert(inc.product.quantity === 152 && inc.movement_id > 0, 'increase applied (+7 → 152)');
  const incMv = db.getDb().prepare('SELECT * FROM inventory_movements WHERE id = ?').get(inc.movement_id);
  assert(incMv.reason === 'adjustment' && incMv.reason_code === 'found',
    'adjustment movement carries reason_code');
  assert(Number(incMv.balance_before) === 145 && Number(incMv.balance_after) === 152, 'before/after stamped');
  assert(Number(incMv.actor_id) === ACTOR && incMv.ref_type === 'adjustment', 'actor + ref_type stamped');
  const dec = inventory.adjustStock(ACTOR, { product_id: P.id, delta: -2, reason_code: 'damaged', note: 'تلف بالنقل' });
  assert(dec.product.quantity === 150, 'decrease applied (-2 → 150)');
  assert(auditCount('inventory.adjust') >= 2, 'audit rows written inside transaction');
  await expectError(Promise.resolve().then(() =>
    inventory.adjustStock(ACTOR, { product_id: P.id, delta: 0, reason_code: 'other' })), 'zero delta rejected');
  await expectError(Promise.resolve().then(() =>
    inventory.adjustStock(ACTOR, { product_id: P.id, delta: 1, reason_code: 'made_up_reason' })), 'unknown reason rejected');
  await expectError(Promise.resolve().then(() =>
    inventory.adjustStock(ACTOR, { product_id: 987654, delta: 1, reason_code: 'other' })), 'unknown product rejected');
  await expectError(Promise.resolve().then(() =>
    inventory.adjustStock(ACTOR, { product_id: R.id, delta: -99, reason_code: 'lost' })), 'negative resulting stock rejected');

  // Rollback: valid payload but actor FK fails AFTER the stock UPDATE ran.
  const stockBeforeFk = db.getProduct(P.id).quantity;
  const mvBeforeFk = movementsFor(P.id).length;
  const auditBeforeFk = auditCount('inventory.adjust');
  await expectError(Promise.resolve().then(() =>
    inventory.adjustStock(987654, { product_id: P.id, delta: -50, reason_code: 'correction' })),
    'mid-tx failure via bad actor FK rejected');
  assert(db.getProduct(P.id).quantity === stockBeforeFk, 'rollback: stock unchanged after mid-tx failure');
  assert(movementsFor(P.id).length === mvBeforeFk, 'rollback: no orphan movement');
  assert(auditCount('inventory.adjust') === auditBeforeFk, 'rollback: no orphan audit row');

  console.log('\n[D] Reconciliation with stale-snapshot safety');
  // Fresh flow: count matches reality minus drift.
  db.restock(Q.id, 6, null); // system now 46; snapshot will capture it
  const rec1 = inventory.openReconciliation(ACTOR, {
    product_id: Q.id, counted_qty: 44, reason_code: 'counting_error', note: 'جرد شهري'
  });
  assert(rec1.status === 'open' && rec1.system_qty === 46 && rec1.diff_qty === -2,
    'open session snapshots system_qty=46 diff=-2');
  const recApplied = inventory.confirmReconciliation(ACTOR, rec1.id);
  assert(recApplied.product.quantity === 44 && recApplied.reconciliation.status === 'applied',
    'confirm applies diff against authoritative stock (→44)');
  const recMv = movementsFor(Q.id, 'reconciliation')[0];
  assert(recMv && Number(recMv.change) === -2 && Number(recMv.ref_id) === rec1.id &&
    Number(recMv.balance_before) === 46 && Number(recMv.balance_after) === 44,
    'reconciliation movement linked to session with before/after');

  // Stale scenario: snapshot then concurrent sale, confirm must reject.
  const rec2 = inventory.openReconciliation(ACTOR, { product_id: Q.id, counted_qty: 44, reason_code: 'other' });
  db.checkout({ items: [{ product_id: Q.id, quantity: 3 }], paid: 500 }); // stock moves under the count
  const staleAuditBefore = auditCount('inventory.reconcile.stale');
  let staleMsg = '';
  try {
    inventory.confirmReconciliation(ACTOR, rec2.id);
    assert(false, 'stale confirmation should have been rejected');
  } catch (e) { staleMsg = String(e.message); }
  assert(staleMsg.includes('انتهت صلاحية الجرد'), `stale confirm rejected (${staleMsg.slice(0, 40)})`);
  const rec2Row = db.getDb().prepare('SELECT * FROM stock_reconciliations WHERE id = ?').get(rec2.id);
  assert(rec2Row.status === 'stale', 'session marked stale for review');
  assert(auditCount('inventory.reconcile.stale') === staleAuditBefore + 1, 'stale detection audited');
  assert(db.getProduct(Q.id).quantity === 41, 'stale rejection left authoritative stock untouched');

  // Zero-difference confirm: applied without any movement.
  const rec3 = inventory.openReconciliation(ACTOR, { product_id: R.id, counted_qty: 3, reason_code: 'opening_balance' });
  const zeroRes = inventory.confirmReconciliation(ACTOR, rec3.id);
  assert(zeroRes.reconciliation.status === 'applied' && zeroRes.product.quantity === 3,
    'zero-diff session applied');
  assert(movementsFor(R.id, 'reconciliation').length === 0, 'zero-diff produced no movement');

  // Negative diff reduces stock.
  const rec4 = inventory.openReconciliation(ACTOR, { product_id: R.id, counted_qty: 1, reason_code: 'damaged' });
  const negRes = inventory.confirmReconciliation(ACTOR, rec4.id);
  assert(negRes.product.quantity === 1, 'negative diff applied (3 → 1)');

  await expectError(Promise.resolve().then(() =>
    inventory.confirmReconciliation(ACTOR, rec1.id)), 'double-confirm rejected');
  await expectError(Promise.resolve().then(() =>
    inventory.cancelReconciliation(ACTOR, rec1.id)), 'cancelling applied session rejected');
  const rec5 = inventory.openReconciliation(ACTOR, { product_id: R.id, counted_qty: 9, reason_code: 'correction' });
  const cancelled = inventory.cancelReconciliation(ACTOR, rec5.id);
  assert(cancelled.status === 'cancelled' && db.getProduct(R.id).quantity === 1,
    'cancel closes open session with no stock effect');
  await expectError(Promise.resolve().then(() =>
    inventory.openReconciliation(ACTOR, { product_id: Q.id, counted_qty: 1, reason_code: 'other' }) &&
    inventory.openReconciliation(ACTOR, { product_id: Q.id, counted_qty: 2, reason_code: 'other' })),
    'second open session for same product rejected');
  await expectError(Promise.resolve().then(() =>
    inventory.openReconciliation(ACTOR, { product_id: R.id, counted_qty: -1, reason_code: 'other' })),
    'negative counted_qty rejected');

  console.log('\n[E] Cost history & WAC trail');
  const po = purchases.createPurchaseOrder(null, {
    supplier_id: supplier.id,
    items: [{ product_id: P.id, qty: 50, unit_cost: 16 }]
  });
  purchases.submitPurchaseOrder(po.id);
  purchases.approvePurchaseOrder(null, po.id);
  const grn = purchases.receiveGoods(ACTOR, {
    po_id: po.id,
    items: [{ po_item_id: po.items[0].id, qty_received: 50, qty_damaged: 0 }]
  });
  // Exact WAC: stock at receive = 150 @ 12, receipt 50 @ 16 → (12*150 + 16*50)/200 = 13
  const pNow = db.getProduct(P.id);
  const chGrn = db.getDb().prepare(
    "SELECT * FROM cost_history WHERE product_id = ? AND source_type = 'grn'"
  ).get(P.id);
  assert(chGrn && chGrn.grn_id !== null && chGrn.supplier_id === supplier.id,
    'GRN cost-history row linked to GRN + supplier');
  assert(Number(chGrn.qty_received) === 50 && Number(chGrn.unit_cost) === 16, 'received qty/unit_cost recorded');
  // Exact WAC: stock at receive = 150 @ 12, receipt 50 @ 16 → (12*150 + 16*50)/200 = 13
  assert(Number(pNow.cost) === 13, 'products.cost recomputed to exact WAC (13)');
  assert(Number(chGrn.prev_cost) === 12 && Number(chGrn.new_cost) === 13,
    'cost transition recorded prev=12 new=13');
  // Damaged-only receipt must not create a cost row.
  const poDmg = purchases.createPurchaseOrder(null, {
    supplier_id: supplier.id,
    items: [{ product_id: Q.id, qty: 10, unit_cost: 8 }]
  });
  purchases.submitPurchaseOrder(poDmg.id);
  purchases.approvePurchaseOrder(null, poDmg.id);
  const grnCountBefore = db.getDb().prepare(
    "SELECT COUNT(*) AS c FROM cost_history WHERE source_type = 'grn'"
  ).get().c;
  purchases.receiveGoods(null, {
    po_id: poDmg.id,
    items: [{ po_item_id: poDmg.items[0].id, qty_received: 2, qty_damaged: 2 }]
  });
  const grnCountAfter = db.getDb().prepare(
    "SELECT COUNT(*) AS c FROM cost_history WHERE source_type = 'grn'"
  ).get().c;
  assert(grnCountAfter === grnCountBefore, 'damaged-only receipt adds no cost-history row');
  // Manual cost edit writes a manual transition.
  const manualRowsBefore = db.getDb().prepare(
    "SELECT COUNT(*) AS c FROM cost_history WHERE source_type = 'manual'"
  ).get().c;
  db.updateProduct(R.id, { cost: 3 }, ACTOR);
  const manual = db.getDb().prepare(
    "SELECT * FROM cost_history WHERE product_id = ? AND source_type = 'manual' ORDER BY id DESC"
  ).get(R.id);
  assert(db.getDb().prepare(
    "SELECT COUNT(*) AS c FROM cost_history WHERE source_type = 'manual'"
  ).get().c === manualRowsBefore + 1, 'manual cost change recorded');
  assert(manual && Number(manual.prev_cost) === 2 && Number(manual.new_cost) === 3 &&
    Number(manual.actor_id) === ACTOR, 'manual transition keeps prev/new/actor');
  // Sale cost snapshot untouched by later WAC changes.
  const soldItem = db.getDb().prepare(
    'SELECT unit_cost FROM sale_items WHERE sale_id = ? AND product_id = ?'
  ).get(sale.id, P.id);
  assert(Number(soldItem.unit_cost) === 12, 'historical sale kept original cost snapshot (12)');

  console.log('\n[F] Valuation — exact arithmetic');
  // P: qty 200 (150-5+7-2+50) x cost WAC; craft deterministic check with fresh products:
  const V1 = db.createProduct({ name: 'تقييم دقيق ١', price: 99, cost: 12, quantity: 150, category_id: catId });
  const V2 = db.createProduct({ name: 'تقييم دقيق ٢', price: 88, cost: 5.55, quantity: 3, low_stock_threshold: 5, category_id: catId });
  const vres = inventory.valuation({});
  const rowV1 = vres.rows.find(r => r.id === V1.id);
  const rowV2 = vres.rows.find(r => r.id === V2.id);
  assert(rowV1 && rowV1.value === 1800, `exact integer valuation (150 x 12 = 1800, got ${rowV1 && rowV1.value})`);
  assert(rowV2 && rowV2.value === 16.65, `rounded fractional valuation (3 x 5.55 = 16.65, got ${rowV2 && rowV2.value})`);
  assert(rowV1.stock_status === 'ok' && rowV2.stock_status === 'low', 'stock status classified (ok/low)');
  const sumCheck = vres.rows.reduce((a, r) => a + r.value, 0);
  assert(vres.totals.total_value === Math.round((sumCheck + Number.EPSILON) * 100) / 100,
    'totals equal sum of rows');
  const vFiltered = inventory.valuation({ q: 'تقييم دقيق' });
  assert(vFiltered.rows.length === 2 && vFiltered.totals.filtered_total_products === 2,
    'search filter narrows valuation');
  const vLowOnly = inventory.valuation({ low_stock_only: true });
  assert(vLowOnly.rows.every(r => r.stock_status !== 'ok') && vLowOnly.rows.length > 0,
    'low_stock_only excludes healthy rows');
  assert(rowV1.value !== 150 * 99, 'valuation never uses selling price');
  const ov = inventory.overview();
  assert(typeof ov.total_value === 'number' && ov.products_count > 0 &&
    typeof ov.out_count === 'number' && typeof ov.low_count === 'number',
    'overview aggregates exposed');

  console.log('\n[G] Reorder rules');
  const ruled = inventory.setReorderRules(ACTOR, V1.id, { low_stock_threshold: 25, reorder_qty: 60 });
  assert(Number(ruled.low_stock_threshold) === 25 && Number(ruled.reorder_qty) === 60,
    'rules persisted (level 25, qty 60)');
  assert(auditCount('inventory.rules.set') >= 1, 'rules change audited');
  // R is low (5 <= threshold 10): valuation should surface its suggested order qty.
  inventory.setReorderRules(ACTOR, R.id, { low_stock_threshold: 10, reorder_qty: 20 });
  const vR = inventory.valuation({ q: 'جرد ج' });
  assert(vR.rows.length === 1 && vR.rows[0].stock_status === 'low' &&
    vR.rows[0].suggested_order === 20, 'suggested_order exposed for low stock with rules');
  const vHealthy = inventory.valuation({ q: 'تقييم دقيق ١' });
  assert(vHealthy.rows[0].suggested_order === null || vHealthy.rows[0].stock_status === 'ok',
    'healthy product has no forced suggestion');
  await expectError(Promise.resolve().then(() =>
    inventory.setReorderRules(ACTOR, V1.id, { low_stock_threshold: -1 })), 'negative level rejected');
  await expectError(Promise.resolve().then(() =>
    inventory.setReorderRules(ACTOR, V1.id, { reorder_qty: 1.5 })), 'fractional reorder_qty rejected');
  await expectError(Promise.resolve().then(() =>
    inventory.setReorderRules(ACTOR, 987654, { reorder_qty: 5 })), 'rules for unknown product rejected');

  console.log('\n[H] Movement filters & pagination');
  const pgAll = inventory.listMovementsPaged({ limit: 5, offset: 0 });
  assert(pgAll.rows.length === 5 && pgAll.total > 5, `paging returns page + total (${pgAll.total})`);
  const pg2 = inventory.listMovementsPaged({ limit: 5, offset: 5 });
  if (pg2.rows.length > 0) {
    assert(pg2.rows[0].id < pgAll.rows.at(-1).id, 'second page continues descending order');
  }
  const byReason = inventory.listMovementsPaged({ reason: 'reconciliation' });
  assert(byReason.rows.length === byReason.total && byReason.rows.every(m => m.reason === 'reconciliation'),
    'filter by reason works');
  const byRef = inventory.listMovementsPaged({ ref_type: 'grn' });
  assert(byRef.rows.every(m => m.ref_type === 'grn') && byRef.rows.length > 0, 'filter by ref_type works');
  const byActor = inventory.listMovementsPaged({ actor_id: ACTOR, limit: 500 });
  assert(byActor.rows.length > 0 && byActor.rows.every(m => Number(m.actor_id) === ACTOR),
    'filter by actor works');
  const today = new Date().toISOString().slice(0, 10);
  const byDate = inventory.listMovementsPaged({ date_from: today, date_to: today, limit: 500 });
  assert(byDate.total === inventory.listMovementsPaged({ limit: 500 }).total,
    'date range covering today captures fresh ledger');
  const emptyRange = inventory.listMovementsPaged({ date_from: '2001-01-01', date_to: '2001-01-02' });
  assert(emptyRange.total === 0 && emptyRange.rows.length === 0, 'empty date range yields nothing');
  const byQ = inventory.listMovementsPaged({ q: 'جرد أ' });
  assert(byQ.rows.length > 0 && byQ.rows.every(m => m.product_name === 'منتج جرد أ'),
    'search by product name works');
  const joined = byRef.rows[0];
  assert(joined.actor_username !== undefined && joined.product_barcode !== undefined,
    'rows enriched with actor + barcode columns');

  console.log('\n[I] Legacy regression');
  const legRestock = db.restock(R.id, 4, 'إضافة قديمة'); // old signature still valid
  assert(legRestock.quantity === 5, 'legacy restock works');
  const legAdj = db.adjustQuantity(V1.id, 100); // absolute-set semantics preserved
  assert(legAdj.quantity === 100, 'legacy adjustQuantity works');
  const legMv = movementsFor(V1.id, 'adjustment').at(-1);
  assert(Number(legMv.balance_before) === 150 && Number(legMv.balance_after) === 100 &&
    legMv.reason_code === 'correction', 'legacy adjust stamped enriched ledger fields');
  const legacyList = db.listMovements(10);
  assert(Array.isArray(legacyList) && legacyList.length === 10 &&
    legacyList[0].product_name !== undefined, 'legacy listMovements intact');
  const legacySale = db.checkout({ items: [{ product_id: V2.id, quantity: 1 }], paid: 1000 }); // no opts
  assert(legacySale && typeof legacySale.id === 'number', 'checkout without opts still works');
  assert(db.getProduct(V2.id).quantity === 2, 'legacy sale decremented stock');
  const reconList = inventory.listReconciliations({ status: 'applied' });
  assert(reconList.length >= 2 && reconList[0].product_name !== undefined,
    'listReconciliations filters + joins');
  const costList = inventory.costHistory({ product_id: P.id });
  assert(costList.length >= 2 &&
    costList.some(r => r.source_type === 'initial' && r.prev_cost === null) &&
    costList.some(r => r.source_type === 'grn' && r.grn_ref === grn.grn.ref),
    'cost history lists initial + GRN entries with joined refs');
  assert(costList[0].actor_username === owner.username || costList.some(r => r.actor_username === owner.username),
    'cost history exposes actor username');

  console.log(`\n=== inventory tests: ${passed} passed, ${failed} failed ===`);
  process.exitCode = failed === 0 ? 0 : 1;

})().catch((e) => {
  console.error('HARNESS ERROR:', e);
  process.exitCode = 1;
});


