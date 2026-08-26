'use strict';

/*
 * Phase 24 tests — Stock transfers: lifecycle state machine, partial
 * dispatch/receive, double-receive protection, rollback atomicity,
 * carried-cost policy (source WAC at dispatch, qty-weighted across partial
 * dispatches; destination WAC blend), branch authorization + visibility.
 * Pure Node: no Electron.
 */

const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const db = require('../src/main/db');
const auth = require('../src/main/auth');
const branches = require('../src/main/branches');
const purchases = require('../src/main/purchases');
const transfers = require('../src/main/transfers');

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
      console.error('  FAIL', label, '-> expected', code, 'got', e.code || '-', String(e.message).slice(0, 45));
    } else {
      passed++;
      console.log('  PASS', label, '->', String(e.message).slice(0, 55));
    }
  }
}

function approx(a, b, tol) {
  return Math.abs((Number(a) || 0) - (Number(b) || 0)) <= (tol == null ? 0.005 : tol);
}

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pos-transfers-test-'));
db.init(path.join(tmpDir, 'test.db'));
auth.init();

(async () => {

  /* ---- fixtures ---- */
  const d = db.getDb();
  const ownerRow = auth.setupOwner({ username: 'owner', password: 'OwnerPass1!', display_name: 'المالك' });
  const OWNER = ownerRow.id;
  const sup = db.createSupplier({ name: 'مورد التحويلات' });
  const B = branches.createBranch(OWNER, { name: 'فرع ب', code: 'BR_B' });
  const C = branches.createBranch(OWNER, { name: 'فرع ج', code: 'BR_C' });

  const catId = d.prepare('SELECT id FROM categories LIMIT 1').get().id;
  const X = db.createProduct({ name: 'تحويل س', price: 50, cost: 0, quantity: 0, category_id: catId });
  const Y = db.createProduct({ name: 'تحويل ص', price: 30, cost: 0, quantity: 0, category_id: catId });
  const Z = db.createProduct({ name: 'تحويل ع', price: 20, cost: 0, quantity: 0, category_id: catId });
  const W = db.createProduct({ name: 'تحويل و', price: 15, cost: 0, quantity: 0, category_id: catId });

  function seedStock(productId, qty, unitCost, branchId) {
    const po = purchases.createPurchaseOrder(OWNER, {
      supplier_id: sup.id, branch_id: branchId == null ? 1 : branchId,
      items: [{ product_id: productId, qty, unit_cost: unitCost }]
    });
    purchases.submitPurchaseOrder(po.id);
    purchases.approvePurchaseOrder(OWNER, po.id);
    purchases.receiveGoods(OWNER, {
      po_id: po.id,
      items: [{ po_item_id: po.items[0].id, qty_received: qty }]
    });
  }
  function biQty(branchId, productId) {
    return Number(d.prepare('SELECT quantity FROM branch_inventory WHERE branch_id=? AND product_id=?')
      .get(branchId, productId)?.quantity);
  }
  function biCost(branchId, productId) {
    return Number(d.prepare('SELECT cost FROM branch_inventory WHERE branch_id=? AND product_id=?')
      .get(branchId, productId)?.cost);
  }
  function mvCount(refType, refId) {
    return d.prepare('SELECT COUNT(*) AS c FROM inventory_movements WHERE ref_type=? AND ref_id=?')
      .get(refType, refId).c;
  }

  seedStock(X.id, 20, 10); // dflt X: 20 @ 10
  seedStock(Y.id, 10, 4);  // dflt Y: 10 @ 4
  seedStock(Z.id, 8, 2);   // dflt Z: 8 @ 2

  console.log('\n[A] Transfer creation guards');
  throws(() => transfers.createTransfer(OWNER, {
    source_branch_id: 1, dest_branch_id: 1, items: [{ product_id: X.id, qty: 1 }]
  }), 'same-branch transfer rejected', 'SAME_BRANCH');
  branches.setBranchStatus(OWNER, C.id, 'disabled');
  throws(() => transfers.createTransfer(OWNER, {
    source_branch_id: 1, dest_branch_id: C.id, items: [{ product_id: X.id, qty: 1 }]
  }), 'disabled destination branch rejected');
  branches.setBranchStatus(OWNER, C.id, 'active');
  throws(() => transfers.createTransfer(OWNER, {
    source_branch_id: 1, dest_branch_id: B.id, items: []
  }), 'empty items rejected');
  throws(() => transfers.createTransfer(OWNER, {
    source_branch_id: 1, dest_branch_id: B.id,
    items: [{ product_id: X.id, qty: 1 }, { product_id: X.id, qty: 2 }]
  }), 'duplicate product lines rejected');

  const cashB = auth.createUser(ownerRow, { username: 'cash_t', password: 'Cashier1!', display_name: 'كاشير ب', role: 'cashier' });
  branches.assignUserBranch(OWNER, cashB.id, B.id, true);   // primary -> B
  branches.removeUserBranch(OWNER, cashB.id, 1);            // now B only
  throws(() => transfers.createTransfer(cashB.id, {
    source_branch_id: 1, dest_branch_id: B.id, items: [{ product_id: X.id, qty: 1 }]
  }), 'actor without source access rejected', 'NO_BRANCH_ACCESS');
  throws(() => transfers.createTransfer(999999, {
    source_branch_id: 1, dest_branch_id: B.id, items: [{ product_id: X.id, qty: 1 }]
  }), 'unknown actor rejected', 'UNAUTHORIZED');

  const t1 = transfers.createTransfer(OWNER, {
    source_branch_id: 1, dest_branch_id: B.id,
    notes: 'دفعة أولى',
    items: [{ product_id: X.id, qty: 10 }, { product_id: Y.id, qty: 5 }]
  });
  assert(/^TRF-\d{4}$/.test(t1.ref) && t1.status === 'draft', 'draft created with TRF ref');
  assert(Number(t1.total_qty) === 15 && t1.items.length === 2, 'items persisted');

  console.log('\n[B] Happy-path lifecycle with carried costing');
  throws(() => transfers.dispatchTransfer(OWNER, { id: t1.id, lines: [{ item_id: t1.items[0].id, qty: 1 }] }),
    'dispatch before approval rejected');
  throws(() => transfers.approveTransfer(OWNER, t1.id), 'approve before submit rejected');
  transfers.submitTransfer(OWNER, t1.id);
  assert(transfers.getTransfer(t1.id).status === 'submitted', 'submitted state');
  transfers.approveTransfer(OWNER, t1.id);
  assert(transfers.getTransfer(t1.id).status === 'approved', 'approved state');

  const disp1 = transfers.dispatchTransfer(OWNER, {
    id: t1.id,
    lines: [
      { item_id: t1.items[0].id, qty: 10 },
      { item_id: t1.items[1].id, qty: 5 }
    ]
  });
  assert(disp1.status === 'dispatched', 'full dispatch flips status to dispatched');
  assert(Number(disp1.items[0].unit_cost) === 10 && Number(disp1.items[1].unit_cost) === 4,
    'carried cost snapshots source WAC per item');
  assert(biQty(1, X.id) === 10 && biQty(1, Y.id) === 5, 'source stock deducted exactly');
  assert(mvCount('transfer', t1.id) === 2, 'transfer_out movements written');
  const outMv = d.prepare("SELECT * FROM inventory_movements WHERE reason='transfer_out' AND ref_id=?")
    .get(t1.id);
  assert(outMv && Number(outMv.branch_id) === 1 && outMv.balance_before === 20 && outMv.balance_after === 10,
    'movement stamped with source branch + balances');
  assert(db.getProduct(X.id).quantity === 10, 'default mirror follows source deduction');

  const rec1 = transfers.receiveTransfer(OWNER, {
    id: t1.id,
    lines: [
      { item_id: t1.items[0].id, qty: 10 },
      { item_id: t1.items[1].id, qty: 5 }
    ]
  });
  assert(rec1.status === 'received', 'received status');
  assert(biQty(B.id, X.id) === 10 && biQty(B.id, Y.id) === 5, 'destination credited');
  assert(biCost(B.id, X.id) === 10 && biCost(B.id, Y.id) === 4,
    'first receipt into empty destination adopts carried cost');
  const inMv = d.prepare("SELECT * FROM inventory_movements WHERE reason='transfer_in' AND ref_id=? AND branch_id=?")
    .get(t1.id, B.id);
  assert(inMv && inMv.balance_before === 0 && inMv.balance_after === 10,
    'transfer_in stamped with dest branch + balances');

  console.log('\n[C] Partial dispatch, weighted carried cost, WAC blend');
  seedStock(X.id, 15, 12); // dflt X -> 25 @ 11.2 : (10*10+12*15)/25
  const t2 = transfers.createTransfer(OWNER, {
    source_branch_id: 1, dest_branch_id: B.id,
    items: [{ product_id: X.id, qty: 10 }]
  });
  transfers.submitTransfer(OWNER, t2.id);
  transfers.approveTransfer(OWNER, t2.id);

  const d1 = transfers.dispatchTransfer(OWNER, { id: t2.id, lines: [{ item_id: t2.items[0].id, qty: 5 }] });
  assert(d1.status === 'approved', 'partial dispatch keeps approved status');
  assert(Number(d1.items[0].dispatched_qty) === 5 && biQty(1, X.id) === 20, 'partial deduction applied');
  assert(approx(d1.items[0].unit_cost, 11.2), 'first slice carries current WAC 11.2');

  throws(() => transfers.dispatchTransfer(OWNER, { id: t2.id, lines: [{ item_id: t2.items[0].id, qty: 6 }] }),
    'dispatch beyond remaining blocked');

  seedStock(X.id, 20, 15); // dflt X -> 40 @ 13.1 : (11.2*20+15*20)/40 ; then dispatch rest -> 35
  const d2 = transfers.dispatchTransfer(OWNER, { id: t2.id, lines: [{ item_id: t2.items[0].id, qty: 5 }] });
  assert(d2.status === 'dispatched', 'second slice completes dispatch');
  assert(approx(d2.items[0].unit_cost, 12.15), 'carried cost qty-weighted across slices (11.2&13.1 -> 12.15)');
  assert(biQty(1, X.id) === 35, 'source fully deducted after both slices');

  const rec2 = transfers.receiveTransfer(OWNER, { id: t2.id, lines: [{ item_id: t2.items[0].id, qty: 10 }] });
  assert(rec2.status === 'received', 'single-shot full receive accepted');
  assert(biQty(B.id, X.id) === 20, 'destination qty accumulated (10+10)');
  assert(approx(biCost(B.id, X.id), 11.075, 0.011),
    'destination WAC blended with existing stock (~11.075)');

  // Fresh product: destination pre-seeded with DIFFERENT cost, verify blend arithmetic precisely
  seedStock(W.id, 20, 12.15);          // dflt W: 20 @ 12.15
  seedStock(W.id, 15, 10, B.id);       // B W: 15 @ 10
  const t2b = transfers.createTransfer(OWNER, {
    source_branch_id: 1, dest_branch_id: B.id,
    items: [{ product_id: W.id, qty: 10 }]
  });
  transfers.submitTransfer(OWNER, t2b.id);
  transfers.approveTransfer(OWNER, t2b.id);
  transfers.dispatchTransfer(OWNER, { id: t2b.id, lines: [{ item_id: t2b.items[0].id, qty: 10 }] });
  transfers.receiveTransfer(OWNER, { id: t2b.id, lines: [{ item_id: t2b.items[0].id, qty: 10 }] });
  // (10*15 + 12.15*10)/25 = 10.86
  assert(approx(biCost(B.id, W.id), 10.86), 'blend arithmetic exact ((150+121.5)/25 = 10.86)');
  assert(biQty(B.id, W.id) === 25, 'blend qty 25');

  console.log('\n[D] Partial receive & double-receive protection');
  const t3 = transfers.createTransfer(OWNER, {
    source_branch_id: 1, dest_branch_id: B.id,
    items: [{ product_id: Z.id, qty: 6 }, { product_id: Y.id, qty: 4 }]
  });
  transfers.submitTransfer(OWNER, t3.id);
  transfers.approveTransfer(OWNER, t3.id);
  transfers.dispatchTransfer(OWNER, {
    id: t3.id,
    lines: [
      { item_id: t3.items[0].id, qty: 6 },
      { item_id: t3.items[1].id, qty: 4 }
    ]
  });
  const pr = transfers.receiveTransfer(OWNER, { id: t3.id, lines: [{ item_id: t3.items[0].id, qty: 6 }] });
  assert(pr.status === 'partially_received', 'one-line receipt -> partially_received');
  throws(() => transfers.receiveTransfer(OWNER, { id: t3.id, lines: [{ item_id: t3.items[0].id, qty: 1 }] }),
    'receiving an already-satisfied line blocked', 'DOUBLE_RECEIVE');
  throws(() => transfers.receiveTransfer(OWNER, { id: t3.id, lines: [{ item_id: t3.items[1].id, qty: 5 }] }),
    'over-receive beyond outstanding blocked');
  const fin = transfers.receiveTransfer(OWNER, { id: t3.id, lines: [{ item_id: t3.items[1].id, qty: 4 }] });
  assert(fin.status === 'received', 'final line completes transfer');
  throws(() => transfers.receiveTransfer(OWNER, { id: t3.id, lines: [{ item_id: t3.items[1].id, qty: 1 }] }),
    'receive after completion blocked');
  assert(biQty(B.id, Z.id) === 6 && biQty(B.id, Y.id) === 9, 'dest balances correct (Z 6, Y 5+4)');

  console.log('\n[E] Rollback atomicity & cancel guards');
  const preX = biQty(1, X.id); // 35
  const t4 = transfers.createTransfer(OWNER, {
    source_branch_id: 1, dest_branch_id: C.id,
    items: [{ product_id: X.id, qty: 2 }, { product_id: Y.id, qty: 999 }]
  });
  transfers.submitTransfer(OWNER, t4.id);
  transfers.approveTransfer(OWNER, t4.id);
  throws(() => transfers.dispatchTransfer(OWNER, {
    id: t4.id,
    lines: [
      { item_id: t4.items[0].id, qty: 2 },
      { item_id: t4.items[1].id, qty: 999 }
    ]
  }), 'multi-line dispatch failing on one line rolls back whole tx');
  assert(biQty(1, X.id) === preX, 'source untouched after rolled-back dispatch');
  assert(mvCount('transfer', t4.id) === 0, 'no movements persisted from failed dispatch');
  const t4after = transfers.getTransfer(t4.id);
  assert(t4after.status === 'approved' && Number(t4after.items[0].dispatched_qty) === 0,
    'status/dispatched_qty unchanged after rollback');

  const t5 = transfers.createTransfer(OWNER, {
    source_branch_id: 1, dest_branch_id: B.id,
    items: [{ product_id: Z.id, qty: 2 }]
  });
  transfers.submitTransfer(OWNER, t5.id);
  const cx = transfers.cancelTransfer(OWNER, { id: t5.id, reason: 'لم تعد مطلوبة' });
  assert(cx.status === 'cancelled', 'pre-dispatch cancel allowed');
  assert(biQty(1, Z.id) === 2, 'cancel leaves stock untouched (Z 8-6 from t3)');
  throws(() => transfers.cancelTransfer(OWNER, { id: t5.id }), 'double-cancel rejected');

  const t8 = transfers.createTransfer(OWNER, {
    source_branch_id: 1, dest_branch_id: B.id,
    items: [{ product_id: X.id, qty: 4 }]
  });
  transfers.submitTransfer(OWNER, t8.id);
  transfers.approveTransfer(OWNER, t8.id);
  transfers.dispatchTransfer(OWNER, { id: t8.id, lines: [{ item_id: t8.items[0].id, qty: 2 }] });
  throws(() => transfers.cancelTransfer(OWNER, { id: t8.id }),
    'cancel after any dispatch started rejected', 'DISPATCH_STARTED');
  throws(() => transfers.cancelTransfer(OWNER, { id: t1.id }),
    'cancel after full receipt rejected');

  const t6 = transfers.createTransfer(OWNER, {
    source_branch_id: 1, dest_branch_id: B.id,
    items: [{ product_id: Z.id, qty: 1 }]
  });
  throws(() => transfers.approveTransfer(OWNER, t6.id), 'approve straight from draft rejected');

  console.log('\n[F] Visibility & cross-branch authorization');
  const seenByCash = transfers.listTransfers(cashB).map(t => Number(t.id));
  assert(seenByCash.includes(Number(t1.id)) && seenByCash.includes(Number(t2.id)),
    'cashier sees transfers touching their branch');
  assert(!seenByCash.includes(Number(t4.id)), 'cashier cannot see foreign-branch transfers');
  const seenByOwner = transfers.listTransfers(ownerRow);
  assert(seenByOwner.length >= 6, 'owner sees all transfers');
  const scopedC = transfers.listTransfers(ownerRow, { branch_id: C.id }).map(t => Number(t.id));
  assert(scopedC.length === 1 && scopedC.includes(Number(t4.id)), 'branch filter scopes listing');

  const mgrB = auth.createUser(ownerRow, { username: 'mgr_t', password: 'Manager1!', display_name: 'مدير ب', role: 'manager' });
  branches.assignUserBranch(OWNER, mgrB.id, B.id, false); // {default, B}
  throws(() => transfers.submitTransfer(mgrB.id, t4.id),
    'mutation on foreign-branch transfer denied for restricted manager', 'NO_BRANCH_ACCESS');
  const t7 = transfers.createTransfer(OWNER, {
    source_branch_id: 1, dest_branch_id: B.id,
    items: [{ product_id: Z.id, qty: 1 }]
  });
  transfers.submitTransfer(mgrB.id, t7.id);
  assert(transfers.getTransfer(t7.id).status === 'submitted',
    'restricted manager may mutate transfers touching authorized branch');

  console.log('\n[G] Ledger integrity & audit trail');
  const chainBroken = d.prepare(`
    WITH seq AS (
      SELECT m.*, ROW_NUMBER() OVER (PARTITION BY m.product_id, m.branch_id ORDER BY m.id) rn,
             LAG(m.balance_after) OVER (PARTITION BY m.product_id, m.branch_id ORDER BY m.id) prev_bal
      FROM inventory_movements m WHERE m.branch_id IS NOT NULL AND m.balance_before IS NOT NULL
    )
    SELECT COUNT(*) AS c FROM seq WHERE rn > 1 AND balance_before != prev_bal`).get().c;
  assert(chainBroken === 0, 'per-(product,branch) ledger chains continuous');
  const actions = d.prepare("SELECT DISTINCT action FROM audit_log WHERE action LIKE 'transfer.%'")
    .all().map(r => r.action);
  for (const need of ['transfer.create', 'transfer.approve', 'transfer.dispatch', 'transfer.receive', 'transfer.cancel']) {
    assert(actions.includes(need), `audit action ${need} recorded`);
  }

  console.log(`\n=== transfers.test: ${passed} passed, ${failed} failed ===`);
  process.exit(failed ? 1 : 0);
})().catch(err => { console.error(err); process.exit(1); });
