'use strict';

/*
 * Phase 24 tests — Multi-Branch (M005): branches, user_branches,
 * branch_inventory migration exactness, branch-scoped inventory/sales/
 * purchasing, per-branch rules & reconciliation, authorization matrix.
 * Pure Node: no Electron.
 */

const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const db = require('../src/main/db');
const auth = require('../src/main/auth');
const branches = require('../src/main/branches');
const purchases = require('../src/main/purchases');
const inventory = require('../src/main/inventory');

let passed = 0;
let failed = 0;

function assert(cond, label) {
  if (cond) { passed++; console.log('  PASS', label); }
  else { failed++; console.error('  FAIL', label); }
}

function throws(fn, label, code) {
  try {
    fn();
    failed++;
    console.error('  FAIL', label, '(no error thrown)');
  } catch (e) {
    if (code && e.code !== code) {
      failed++;
      console.error('  FAIL', label, '-> expected code', code, 'got', e.code, String(e.message).slice(0, 50));
    } else {
      passed++;
      console.log('  PASS', label, '->', String(e.message).slice(0, 55));
    }
  }
}

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pos-branches-test-'));
db.init(path.join(tmpDir, 'test.db'));
auth.init();

(async () => {

  /* ---- shared fixtures ---- */
  const d = db.getDb();
  const ownerRow = auth.setupOwner({ username: 'owner', password: 'OwnerPass1!', display_name: 'المالك' });
  const OWNER = ownerRow.id;

  console.log('\n[A] Migration M005 schema & defaults');
  const tables = d.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(r => r.name);
  for (const t of ['branches', 'user_branches', 'branch_inventory', 'stock_transfers', 'stock_transfer_items']) {
    assert(tables.includes(t), `table ${t} created`);
  }
  const mig = d.prepare("SELECT version FROM schema_migrations WHERE name = 'multi-branch'").get();
  assert(mig && Number(mig.version) === 5, 'M005 recorded as version 5');

  const def = d.prepare('SELECT * FROM branches WHERE id = 1').get();
  assert(def && def.name === 'الفرع الرئيسي' && def.code === 'MAIN' && def.status === 'active',
    'default branch id=1 MAIN active');
  const salesCols = d.prepare('PRAGMA table_info(sales)').all().map(c => c.name);
  const poCols = d.prepare('PRAGMA table_info(purchase_orders)').all().map(c => c.name);
  const grnCols = d.prepare('PRAGMA table_info(grns)').all().map(c => c.name);
  const mvCols = d.prepare('PRAGMA table_info(inventory_movements)').all().map(c => c.name);
  const chCols = d.prepare('PRAGMA table_info(cost_history)').all().map(c => c.name);
  assert(salesCols.includes('branch_id'), 'sales.branch_id added');
  assert(poCols.includes('branch_id'), 'purchase_orders.branch_id added');
  assert(grnCols.includes('branch_id'), 'grns.branch_id added');
  assert(mvCols.includes('branch_id'), 'inventory_movements.branch_id added');
  assert(chCols.includes('branch_id'), 'cost_history.branch_id added');

  // Backfill exactness against live products (seeded ones included)
  const mism = d.prepare(`
    SELECT COUNT(*) AS c FROM products p
    LEFT JOIN branch_inventory bi ON bi.product_id = p.id AND bi.branch_id = 1
    WHERE bi.product_id IS NULL OR bi.quantity != p.quantity
       OR ABS(bi.cost - p.cost) > 0.001 OR bi.low_stock_threshold != p.low_stock_threshold
       OR bi.reorder_qty != p.reorder_qty`).get().c;
  assert(mism === 0, 'branch_inventory backfilled exactly from products');
  const legacyMapped = d.prepare(
    'SELECT COUNT(*) AS c FROM inventory_movements WHERE branch_id IS DISTINCT FROM 1').get().c;
  assert(legacyMapped === 0, 'legacy movements mapped to default branch');

  console.log('\n[B] Branch CRUD & guards');
  const north = branches.createBranch(OWNER, { name: 'فرع الشمال', code: 'NORTH', phone: '0500000000' });
  const south = branches.createBranch(OWNER, { name: 'فرع الجنوب', code: 'SOUTH' });
  assert(Number(north.id) === 2 && Number(south.id) === 3, 'new branches get sequential ids');
  const listed = branches.listBranches().find(b => Number(b.id) === Number(north.id));
  assert(listed && listed.stats && typeof listed.stats.stock_value === 'number', 'list stats attached');
  throws(() => branches.createBranch(OWNER, { name: '   ' }), 'empty name rejected', 'INVALID_INPUT');
  throws(() => branches.createBranch(OWNER, { name: 'X', code: 'NORTH' }), 'duplicate code rejected', 'DUPLICATE_CODE');
  const upd = branches.updateBranch(OWNER, north.id, { address: 'شارع 1' });
  assert(upd.address === 'شارع 1' && upd.name === 'فرع الشمال', 'update preserves unspecified fields');
  throws(() => branches.updateBranch(OWNER, north.id, { code: 'SOUTH' }), 'update to duplicate code rejected', 'DUPLICATE_CODE');
  throws(() => branches.setBranchStatus(OWNER, 1, 'disabled'), 'cannot disable default branch', 'DEFAULT_BRANCH');
  const dis = branches.setBranchStatus(OWNER, south.id, 'disabled');
  assert(dis.status === 'disabled', 'non-default branch can be disabled');
  branches.setBranchStatus(OWNER, south.id, 'active');

  console.log('\n[C] User-branch assignments & authorization matrix');
  const mgr = auth.createUser(ownerRow, { username: 'mgr_b', password: 'Manager1!', display_name: 'مدير', role: 'manager' });
  const cash = auth.createUser(ownerRow, { username: 'cash_b', password: 'Cashier1!', display_name: 'كاشير', role: 'cashier' });
  const mgrBranches = branches.getUserBranches(mgr.id);
  assert(mgrBranches.length === 1 && mgrBranches[0].id === 1 && mgrBranches[0].is_primary === 1,
    'new users auto-assigned default branch as primary');
  assert(branches.canAccessBranch(ownerRow, 1) && branches.canAccessBranch(ownerRow, north.id),
    'owner spans all branches');
  assert(branches.canAccessBranch(mgr, 1) && !branches.canAccessBranch(mgr, north.id),
    'manager restricted to assignment');
  branches.assignUserBranch(OWNER, mgr.id, north.id, false);
  assert(branches.canAccessBranch(mgr, north.id), 'after assignment access granted');
  branches.setBranchStatus(OWNER, south.id, 'disabled');
  assert(!branches.canAccessBranch(mgr, south.id) && !branches.canAccessBranch(ownerRow, south.id),
    'disabled branch denies even spanning roles');
  branches.setBranchStatus(OWNER, south.id, 'active');
  branches.assignUserBranch(OWNER, cash.id, north.id, true);
  let cb = branches.getUserBranches(cash.id);
  assert(cb.find(b => b.id === 1).is_primary === 0 && cb.find(b => b.id === north.id).is_primary === 1,
    'primary switch demotes previous primary');
  branches.removeUserBranch(OWNER, cash.id, north.id);
  cb = branches.getUserBranches(cash.id);
  assert(cb.length === 1 && cb[0].id === 1 && cb[0].is_primary === 1,
    'removing primary promotes remaining assignment');
  throws(() => branches.removeUserBranch(OWNER, cash.id, 1), 'last assignment protected', 'LAST_BRANCH');
  throws(() => branches.assignUserBranch(OWNER, 999999, 1, true), 'assign unknown user rejected', 'USER_NOT_FOUND');
  throws(() => branches.assignUserBranch(OWNER, cash.id, 999999, true), 'assign unknown branch rejected', 'BRANCH_NOT_FOUND');
  throws(() => branches.assertBranchAccess(cash, south.id), 'assert throws NO_BRANCH_ACCESS', 'NO_BRANCH_ACCESS');
  const audAssign = d.prepare("SELECT COUNT(*) AS c FROM audit_log WHERE action LIKE 'user.branch.%'").get().c;
  assert(audAssign >= 3, 'assignment mutations audited');

  console.log('\n[D] Branch-aware inventory operations');
  const catId = d.prepare('SELECT id FROM categories LIMIT 1').get().id;
  const P = db.createProduct({ name: 'منتج فروع أ', price: 30, cost: 12, quantity: 100, category_id: catId });
  const Q = db.createProduct({ name: 'منتج فروع ب', price: 20, cost: 8, quantity: 50, category_id: catId });

  db.restock(P.id, 10, 'توريد شمال', { actorId: OWNER, branchId: north.id });
  const biNorth = d.prepare('SELECT quantity FROM branch_inventory WHERE branch_id=? AND product_id=?')
    .get(north.id, P.id).quantity;
  assert(biNorth === 10, 'restock lands in target branch row');
  assert(db.getProduct(P.id).quantity === 100, 'default mirror untouched by other-branch restock');
  const mvRestock = d.prepare(
    'SELECT * FROM inventory_movements WHERE product_id=? ORDER BY id DESC LIMIT 1').get(P.id);
  assert(mvRestock.reason === 'restock' && Number(mvRestock.branch_id) === Number(north.id)
    && mvRestock.balance_before === 0 && mvRestock.balance_after === 10,
    'other-branch movement stamped with branch + balances');
  db.adjustQuantity(Q.id, 7, { actorId: OWNER, branchId: north.id });
  assert(d.prepare('SELECT quantity FROM branch_inventory WHERE branch_id=? AND product_id=?')
    .get(north.id, Q.id).quantity === 7, 'absolute adjust scoped to branch');
  throws(() => inventory.adjustStock(OWNER, { product_id: Q.id, delta: -8, reason_code: 'damaged', branch_id: north.id }),
    'delta adjust cannot go below zero in branch');

  // Sale isolation: north lacks stock of P beyond 10
  throws(() => db.checkout({ items: [{ product_id: P.id, quantity: 11 }], paid: 9999 }, { branchId: north.id }),
    'oversell blocked per branch despite default having stock');
  const sN = db.checkout({ items: [{ product_id: P.id, quantity: 4 }], paid: 500 }, { branchId: north.id });
  assert(Number(sN.branch_id) === Number(north.id) && sN.branch_name === 'فرع الشمال',
    'sale stamped with branch id + name');
  const sItem = sN.items.find(i => i.product_id === P.id);
  assert(roundEq(sItem.unit_cost, 12), 'sale_items snapshot BRANCH cost (12)');
  assert(d.prepare('SELECT quantity FROM branch_inventory WHERE branch_id=? AND product_id=?')
    .get(north.id, P.id).quantity === 6, 'north stock decremented by sale');
  assert(db.getProduct(P.id).quantity === 100, 'default still isolated');

  // Per-branch reorder rules
  inventory.setReorderRules(OWNER, P.id, { low_stock_threshold: 3, branch_id: north.id });
  const biP = d.prepare('SELECT * FROM branch_inventory WHERE branch_id=? AND product_id=?').get(north.id, P.id);
  assert(biP.low_stock_threshold === 3, 'rules applied to branch row');
  assert(d.prepare('SELECT low_stock_threshold FROM products WHERE id=?').get(P.id).low_stock_threshold !== 3,
    'default threshold independent');
  inventory.setReorderRules(OWNER, P.id, { low_stock_threshold: 9 }); // default branch
  assert(d.prepare('SELECT low_stock_threshold FROM branch_inventory WHERE branch_id=1 AND product_id=?')
    .get(P.id).low_stock_threshold === 9, 'default rules hit default row');

  // Per-branch reconciliation independence + stale per branch
  const recN = inventory.openReconciliation(OWNER, { product_id: Q.id, counted_qty: 7, reason_code: 'damaged', branch_id: north.id });
  assert(Number(recN.branch_id) === Number(north.id), 'recon session carries branch');
  const recD = inventory.openReconciliation(OWNER, { product_id: Q.id, counted_qty: 50, reason_code: 'damaged' });
  assert(recD && Number(recD.branch_id) === 1, 'same product can have open recons in different branches');
  throws(() => inventory.openReconciliation(OWNER, { product_id: Q.id, counted_qty: 7, reason_code: 'damaged', branch_id: north.id }),
    'second open recon same branch blocked');
  // Make north move so recN goes stale
  db.checkout({ items: [{ product_id: Q.id, quantity: 2 }], paid: 500 }, { branchId: north.id });
  let staleCode = null;
  try { inventory.confirmReconciliation(OWNER, recN.id); }
  catch (e) { staleCode = e.code; }
  assert(staleCode === 'STALE_RECONCILIATION', 'stale detection branch-scoped');
  const conf = inventory.confirmReconciliation(OWNER, recD.id);
  assert(conf.reconciliation.status === 'applied', 'default recon confirms independently');

  // Valuation scoping
  const valAll = inventory.valuation({});
  const valN = inventory.valuation({ branch_id: north.id });
  assert(valAll.rows.some(r => Number(r.branch_id) === Number(north.id)), 'unscoped valuation covers all branches');
  assert(valN.rows.every(r => Number(r.branch_id) === Number(north.id)) && valN.rows.length >= 2,
    'scoped valuation returns only that branch');

  console.log('\n[E] Branch-aware purchasing');
  const sup = db.createSupplier({ name: 'مورد الفروع' });
  const po = purchases.createPurchaseOrder(OWNER, {
    supplier_id: sup.id, branch_id: north.id,
    items: [{ product_id: P.id, qty: 20, unit_cost: 14 }]
  });
  assert(Number(po.branch_id) === Number(north.id) && po.branch_name === 'فرع الشمال',
    'PO carries target branch');
  purchases.submitPurchaseOrder(po.id);
  purchases.approvePurchaseOrder(OWNER, po.id);
  const rec = purchases.receiveGoods(OWNER, { po_id: po.id, items: [{ po_item_id: po.items[0].id, qty_received: 20 }] });
  assert(Number(rec.grn.branch_id) === Number(north.id), 'GRN inherits PO branch');
  const biAfterGrn = d.prepare('SELECT quantity, cost FROM branch_inventory WHERE branch_id=? AND product_id=?')
    .get(north.id, P.id).cost !== undefined
    ? d.prepare('SELECT quantity, cost FROM branch_inventory WHERE branch_id=? AND product_id=?').get(north.id, P.id)
    : null;
  assert(biAfterGrn.quantity === 26, 'GRN credited north row (6+20)');
  // North WAC blend: was 12 with qty6; +20 @14 -> (72+280)/26 = 13.538 -> 13.54
  assert(roundEq(biAfterGrn.cost, 13.54), 'WAC blended in NORTH branch row only');
  assert(roundEq(db.getProduct(P.id).cost, 12), 'default catalog cost untouched');
  const chB = d.prepare('SELECT branch_id, new_cost FROM cost_history ORDER BY id DESC LIMIT 1').get();
  assert(Number(chB.branch_id) === Number(north.id) && roundEq(chB.new_cost, 13.54),
    'cost_history stamped with branch');

  console.log('\n[F] Mirror/ledger global invariants');
  const chainBroken = d.prepare(`
    WITH seq AS (
      SELECT m.*, ROW_NUMBER() OVER (PARTITION BY product_id, branch_id ORDER BY id) rn,
             LAG(balance_after) OVER (PARTITION BY product_id, branch_id ORDER BY id) prev_bal
      FROM inventory_movements m WHERE m.branch_id IS NOT NULL AND m.balance_before IS NOT NULL
    )
    SELECT COUNT(*) AS c FROM seq WHERE rn > 1 AND balance_before != prev_bal`).get().c;
  assert(chainBroken === 0, 'per-(product,branch) ledger chains continuous');
  const mirrorDrift = d.prepare(`
    SELECT COUNT(*) AS c FROM products p JOIN branch_inventory bi
      ON bi.product_id=p.id AND bi.branch_id=1
    WHERE p.quantity != bi.quantity`).get().c;
  assert(mirrorDrift === 0, 'default mirror consistent with authoritative row');

  function roundEq(a, b) {
    return Math.abs((Number(a) || 0) - (Number(b) || 0)) < 0.005;
  }

  console.log(`\n=== branches.test: ${passed} passed, ${failed} failed ===`);
  process.exit(failed ? 1 : 0);
})().catch(err => { console.error(err); process.exit(1); });
