'use strict';

/*
 * Phase 22 — Purchasing & GRN service.
 *
 * COST STRATEGY DECISION (documented):
 * Weighted Average Cost (WAC). On every GRN receipt, product cost is recomputed
 * as (old_cost * stock_before + received_cost * good_units) / new_stock.
 * Rationale: the existing data model keeps a single `products.cost` field, while
 * `sale_items.unit_cost` snapshots the cost of every sold unit. WAC therefore
 * keeps historical profit reporting exact while smoothing cost over stock,
 * without introducing batch/lot tracking. Last-cost would distort margins;
 * FIFO requires lot-level inventory that this domain does not need yet.
 * Historical purchase prices remain fully preserved in grn_items.unit_cost
 * (immutable ledger) and ordered prices in purchase_order_items.unit_cost.
 *
 * PHASE 24 — branches: every PO carries a target branch (default when omitted).
 * Receipts credit that branch's authoritative inventory row and blend its WAC;
 * products.* stays the default-branch mirror (see branches.js D1).
 */

const db = require('./db');

const PO_STATUSES = [
  'draft', 'submitted', 'approved', 'partially_received', 'fully_received', 'cancelled'
];

function nowStr() {
  return new Date().toISOString().slice(0, 19).replace('T', ' ');
}

function round2(n) {
  return Math.round((Number(n) + Number.EPSILON) * 100) / 100;
}

function withTx(fn) {
  const d = db.getDb();
  d.exec('BEGIN IMMEDIATE');
  try {
    const out = fn();
    d.exec('COMMIT');
    return out;
  } catch (err) {
    try { d.exec('ROLLBACK'); } catch (_) { /* noop */ }
    throw err;
  }
}

/* ---------------- validation helpers ---------------- */

function intQty(v, label) {
  const q = Math.trunc(Number(v));
  if (!(q > 0)) throw new Error(label);
  return q;
}

function nonNegInt(v) {
  const q = Math.trunc(Number(v));
  if (!(q >= 0)) return null;
  return q;
}

function validCost(v) {
  const c = round2(Number(v));
  if (!(c >= 0)) throw new Error('سعر التكلفة غير صالح');
  return c;
}

function getPoRow(id) {
  return db.getDb().prepare('SELECT * FROM purchase_orders WHERE id = ?').get(Number(id));
}

function getPoItemRow(itemId) {
  return db.getDb().prepare('SELECT * FROM purchase_order_items WHERE id = ?').get(Number(itemId));
}

function poItems(poId) {
  return db.getDb().prepare(
    `SELECT i.*, p.name AS product_name, p.barcode AS product_barcode
     FROM purchase_order_items i JOIN products p ON p.id = i.product_id
     WHERE i.po_id = ? ORDER BY i.id`
  ).all(Number(poId));
}

function assertDraft(po) {
  if (!po || po.status !== 'draft') {
    throw new Error('التعديل مسموح فقط في حالة المسودة');
  }
}

function pad4(n) {
  return String(n).padStart(4, '0');
}

function validateItemsPayload(items) {
  if (!Array.isArray(items) || items.length === 0) {
    throw new Error('يجب إضافة بند واحد على الأقل لأمر الشراء');
  }
  return items.map(it => ({
    product_id: Number(it.product_id),
    qty: intQty(it.qty, 'الكمية يجب أن تكون أكبر من صفر'),
    unit_cost: validCost(it.unit_cost ?? it.unitCost)
  }));
}

function assertProductsExist(items) {
  const chk = db.getDb().prepare('SELECT id FROM products WHERE id = ?');
  for (const it of items) {
    if (!chk.get(it.product_id)) throw new Error('منتج غير موجود في أمر الشراء');
  }
}

function resolveSupplier(supplierId) {
  const s = db.getDb().prepare('SELECT * FROM suppliers WHERE id = ?').get(Number(supplierId));
  if (!s) throw new Error('المورد غير موجود');
  if (s.status !== 'active') throw new Error('المورد معطل ولا يمكن استخدامه في أوامر شراء جديدة');
  return s;
}

function assertActiveBranch(branchId) {
  const bid = branchId != null ? Number(branchId) : db.DEFAULT_BRANCH_ID;
  const b = db.getDb().prepare('SELECT * FROM branches WHERE id = ?').get(bid);
  if (!b) throw new Error('الفرع غير موجود');
  if (b.status !== 'active') throw new Error('الفرع معطل ولا يمكن استخدامه في أوامر شراء جديدة');
  return bid;
}

/* ---------------- read side ---------------- */

function getPurchaseOrder(id) {
  const po = db.getDb().prepare(
    `SELECT po.*, s.name AS supplier_name, b.name AS branch_name
     FROM purchase_orders po
     LEFT JOIN suppliers s ON s.id = po.supplier_id
     LEFT JOIN branches b ON b.id = po.branch_id
     WHERE po.id = ?`
  ).get(Number(id));
  if (!po) return null;
  const items = poItems(po.id);
  let ordered = 0;
  let received = 0;
  let total = 0;
  for (const it of items) {
    ordered += it.qty;
    received += it.received_qty;
    total += it.qty * it.unit_cost;
  }
  return { ...po, items, ordered_qty: ordered, received_qty: received, total_cost: round2(total) };
}

function listPurchaseOrders({ status, supplier_id, branch_id } = {}) {
  const st = status && PO_STATUSES.includes(status) ? status : null;
  const sid = supplier_id ? Number(supplier_id) : null;
  const bid = branch_id ? Number(branch_id) : null;
  return db.getDb().prepare(
    `SELECT po.*, s.name AS supplier_name, b.name AS branch_name,
       (SELECT COUNT(*) FROM purchase_order_items i WHERE i.po_id = po.id) AS line_count,
       (SELECT COALESCE(SUM(i.qty), 0) FROM purchase_order_items i WHERE i.po_id = po.id) AS ordered_qty,
       (SELECT COALESCE(SUM(i.received_qty), 0) FROM purchase_order_items i WHERE i.po_id = po.id) AS received_qty,
       (SELECT COALESCE(SUM(i.qty * i.unit_cost), 0) FROM purchase_order_items i WHERE i.po_id = po.id) AS total_cost
     FROM purchase_orders po
     LEFT JOIN suppliers s ON s.id = po.supplier_id
     LEFT JOIN branches b ON b.id = po.branch_id
     WHERE (? IS NULL OR po.status = ?) AND (? IS NULL OR po.supplier_id = ?)
       AND (? IS NULL OR po.branch_id = ?)
     ORDER BY po.id DESC LIMIT 500`
  ).all(st, st, sid, sid, bid, bid);
}

function listGrns({ po_id, branch_id } = {}) {
  const pid = po_id ? Number(po_id) : null;
  const bid = branch_id ? Number(branch_id) : null;
  return db.getDb().prepare(
    `SELECT g.*, po.ref AS po_ref, s.name AS supplier_name, b.name AS branch_name,
       (SELECT COUNT(*) FROM grn_items gi WHERE gi.grn_id = g.id) AS line_count,
       (SELECT COALESCE(SUM(gi.qty_received), 0) FROM grn_items gi WHERE gi.grn_id = g.id) AS total_received,
       (SELECT COALESCE(SUM(gi.qty_damaged), 0) FROM grn_items gi WHERE gi.grn_id = g.id) AS total_damaged
     FROM grns g
     LEFT JOIN purchase_orders po ON po.id = g.po_id
     LEFT JOIN suppliers s ON s.id = g.supplier_id
     LEFT JOIN branches b ON b.id = g.branch_id
     WHERE (? IS NULL OR g.po_id = ?) AND (? IS NULL OR g.branch_id = ?)
     ORDER BY g.id DESC LIMIT 500`
  ).all(pid, pid, bid, bid);
}

function getGrn(id) {
  const g = db.getDb().prepare(
    `SELECT g.*, po.ref AS po_ref, s.name AS supplier_name, b.name AS branch_name
     FROM grns g
     LEFT JOIN purchase_orders po ON po.id = g.po_id
     LEFT JOIN suppliers s ON s.id = g.supplier_id
     LEFT JOIN branches b ON b.id = g.branch_id
     WHERE g.id = ?`
  ).get(Number(id));
  if (!g) return null;
  g.items = db.getDb().prepare(
    `SELECT gi.*, p.name AS product_name
     FROM grn_items gi JOIN products p ON p.id = gi.product_id
     WHERE gi.grn_id = ? ORDER BY gi.id`
  ).all(Number(id));
  return g;
}

function supplierPurchaseHistory(supplierId, limit = 100) {
  return db.getDb().prepare(
    `SELECT po.*, 
       (SELECT COUNT(*) FROM purchase_order_items i WHERE i.po_id = po.id) AS line_count,
       (SELECT COALESCE(SUM(i.qty), 0) FROM purchase_order_items i WHERE i.po_id = po.id) AS ordered_qty,
       (SELECT COALESCE(SUM(i.received_qty), 0) FROM purchase_order_items i WHERE i.po_id = po.id) AS received_qty,
       (SELECT COALESCE(SUM(i.qty * i.unit_cost), 0) FROM purchase_order_items i WHERE i.po_id = po.id) AS total_cost,
       (SELECT COUNT(*) FROM grns g WHERE g.po_id = po.id) AS grn_count
     FROM purchase_orders po
     WHERE po.supplier_id = ?
     ORDER BY po.id DESC LIMIT ?`
  ).all(Number(supplierId), Math.max(1, Math.min(500, Number(limit) || 100)));
}

/* ---------------- write side: PO lifecycle ---------------- */

function createPurchaseOrder(actorId, { supplier_id, notes, expected_at, items, branch_id } = {}) {
  resolveSupplier(supplier_id);
  const branchId = assertActiveBranch(branch_id);
  const lines = validateItemsPayload(items);
  assertProductsExist(lines);

  return withTx(() => {
    const res = db.getDb().prepare(
      `INSERT INTO purchase_orders (supplier_id, notes, expected_at, created_by, branch_id)
       VALUES (?, ?, ?, ?, ?)`
    ).run(Number(supplier_id), String(notes || ''), expected_at ? String(expected_at) : null,
      actorId == null ? null : Number(actorId), branchId);
    const poId = Number(res.lastInsertRowid);
    db.getDb().prepare('UPDATE purchase_orders SET ref = ?, updated_at = ? WHERE id = ?')
      .run('PO-' + pad4(poId), nowStr(), poId);
    const ins = db.getDb().prepare(
      'INSERT INTO purchase_order_items (po_id, product_id, qty, unit_cost) VALUES (?, ?, ?, ?)'
    );
    for (const it of lines) ins.run(poId, it.product_id, it.qty, it.unit_cost);
    return getPurchaseOrder(poId);
  });
}

function updatePurchaseOrder(actorId, id, { supplier_id, notes, expected_at, items } = {}) {
  const po = getPoRow(id);
  if (!po) throw new Error('أمر الشراء غير موجود');
  assertDraft(po);
  if (supplier_id !== undefined) resolveSupplier(supplier_id);

  return withTx(() => {
    if (supplier_id !== undefined || notes !== undefined || expected_at !== undefined) {
      db.getDb().prepare(
        'UPDATE purchase_orders SET supplier_id = ?, notes = ?, expected_at = ?, updated_at = ? WHERE id = ?'
      ).run(
        supplier_id !== undefined ? Number(supplier_id) : po.supplier_id,
        notes !== undefined ? String(notes || '') : po.notes,
        expected_at !== undefined ? (expected_at ? String(expected_at) : null) : po.expected_at,
        nowStr(), Number(id)
      );
    }
    if (items !== undefined) {
      const lines = validateItemsPayload(items);
      assertProductsExist(lines);
      db.getDb().prepare('DELETE FROM purchase_order_items WHERE po_id = ?').run(Number(id));
      const ins = db.getDb().prepare(
        'INSERT INTO purchase_order_items (po_id, product_id, qty, unit_cost) VALUES (?, ?, ?, ?)'
      );
      for (const it of lines) ins.run(Number(id), it.product_id, it.qty, it.unit_cost);
    }
    void actorId;
    return getPurchaseOrder(Number(id));
  });
}

function addPoItem(actorId, poId, { product_id, qty, unit_cost } = {}) {
  const po = getPoRow(poId);
  if (!po) throw new Error('أمر الشراء غير موجود');
  assertDraft(po);
  const line = validateItemsPayload([{ product_id, qty, unit_cost }])[0];
  if (!db.getDb().prepare('SELECT id FROM products WHERE id = ?').get(line.product_id)) {
    throw new Error('منتج غير موجود في أمر الشراء');
  }

  return withTx(() => {
    const existing = db.getDb().prepare(
      'SELECT * FROM purchase_order_items WHERE po_id = ? AND product_id = ?'
    ).get(Number(poId), line.product_id);
    if (existing) {
      // merge: sum quantities, take newest cost
      db.getDb().prepare(
        'UPDATE purchase_order_items SET qty = qty + ?, unit_cost = ? WHERE id = ?'
      ).run(line.qty, line.unit_cost, existing.id);
    } else {
      db.getDb().prepare(
        'INSERT INTO purchase_order_items (po_id, product_id, qty, unit_cost) VALUES (?, ?, ?, ?)'
      ).run(Number(poId), line.product_id, line.qty, line.unit_cost);
    }
    db.getDb().prepare('UPDATE purchase_orders SET updated_at = ? WHERE id = ?').run(nowStr(), Number(poId));
    void actorId;
    return getPurchaseOrder(Number(poId));
  });
}

function setPoItem(actorId, itemId, { qty, unit_cost } = {}) {
  const item = getPoItemRow(itemId);
  if (!item) throw new Error('بند أمر الشراء غير موجود');
  const po = getPoRow(item.po_id);
  assertDraft(po);

  const nextQty = qty !== undefined ? intQty(qty, 'الكمية يجب أن تكون أكبر من صفر') : item.qty;
  const nextCost = unit_cost !== undefined ? validCost(unit_cost) : item.unit_cost;
  db.getDb().prepare(
    'UPDATE purchase_order_items SET qty = ?, unit_cost = ? WHERE id = ?'
  ).run(nextQty, nextCost, Number(itemId));
  db.getDb().prepare('UPDATE purchase_orders SET updated_at = ? WHERE id = ?').run(nowStr(), item.po_id);
  void actorId;
  return getPurchaseOrder(item.po_id);
}

function removePoItem(actorId, itemId) {
  const item = getPoItemRow(itemId);
  if (!item) throw new Error('بند أمر الشراء غير موجود');
  const po = getPoRow(item.po_id);
  assertDraft(po);
  const remaining = db.getDb().prepare(
    'SELECT COUNT(*) AS c FROM purchase_order_items WHERE po_id = ?'
  ).get(item.po_id).c;
  if (remaining <= 1) throw new Error('لا يمكن حذف البند الأخير من أمر الشراء');
  db.getDb().prepare('DELETE FROM purchase_order_items WHERE id = ?').run(Number(itemId));
  db.getDb().prepare('UPDATE purchase_orders SET updated_at = ? WHERE id = ?').run(nowStr(), item.po_id);
  void actorId;
  return getPurchaseOrder(item.po_id);
}

function submitPurchaseOrder(id) {
  const po = getPoRow(id);
  if (!po) throw new Error('أمر الشراء غير موجود');
  if (po.status !== 'draft') throw new Error('يمكن إرسال أوامر الشراء من حالة المسودة فقط');
  const lines = db.getDb().prepare('SELECT COUNT(*) AS c FROM purchase_order_items WHERE po_id = ?').get(Number(id)).c;
  if (!lines) throw new Error('لا يمكن إرسال أمر شراء فارغ');
  db.getDb().prepare("UPDATE purchase_orders SET status = 'submitted', updated_at = ? WHERE id = ?")
    .run(nowStr(), Number(id));
  return getPurchaseOrder(Number(id));
}

function approvePurchaseOrder(actorId, id) {
  const po = getPoRow(id);
  if (!po) throw new Error('أمر الشراء غير موجود');
  if (po.status !== 'submitted') throw new Error('يمكن اعتماد الأوامر المرسلة فقط');
  db.getDb().prepare(
    "UPDATE purchase_orders SET status = 'approved', approved_by = ?, approved_at = ?, updated_at = ? WHERE id = ?"
  ).run(actorId == null ? null : Number(actorId), nowStr(), nowStr(), Number(id));
  return getPurchaseOrder(Number(id));
}

function cancelPurchaseOrder(id, reason) {
  const po = getPoRow(id);
  if (!po) throw new Error('أمر الشراء غير موجود');
  if (po.status === 'fully_received') throw new Error('لا يمكن إلغاء أمر تم استلامه بالكامل');
  if (po.status === 'cancelled') throw new Error('أمر الشراء ملغى بالفعل');
  db.getDb().prepare(
    "UPDATE purchase_orders SET status = 'cancelled', cancelled_at = ?, cancel_reason = ?, updated_at = ? WHERE id = ?"
  ).run(nowStr(), String(reason || ''), nowStr(), Number(id));
  return getPurchaseOrder(Number(id));
}

/* ---------------- write side: GRN receiving ---------------- */

function receiveGoods(actorId, { po_id, items, notes, received_at } = {}) {
  const po = getPoRow(po_id);
  if (!po) throw new Error('أمر الشراء غير موجود');
  if (po.status !== 'approved' && po.status !== 'partially_received') {
    throw new Error('يمكن الاستلام لأوامر الشراء المعتمدة فقط');
  }
  if (!Array.isArray(items) || items.length === 0) {
    throw new Error('يجب تحديد بنود للاستلام');
  }

  // Shape-only validation here; authoritative relational/quantity checks run
  // inside the transaction below so any failure rolls back EVERYTHING.
  const prepared = items.map((raw) => {
    const qtyReceived = intQty(raw.qty_received ?? raw.qtyReceived, 'الكمية المستلمة يجب أن تكون أكبر من صفر');
    const qtyDamaged = nonNegInt(raw.qty_damaged ?? raw.qtyDamaged ?? 0);
    if (qtyDamaged === null) throw new Error('الكمية التالفة غير صالحة');
    if (qtyDamaged > qtyReceived) throw new Error('الكمية التالفة تتجاوز الكمية المستلمة');
    const hasCost = raw.unit_cost !== undefined && raw.unit_cost !== null;
    return {
      poItemId: Number(raw.po_item_id),
      qtyReceived,
      qtyDamaged,
      effCost: hasCost ? validCost(raw.unit_cost) : null
    };
  });

  const d = db.getDb();
  const targetBranch = po.branch_id != null ? Number(po.branch_id) : db.DEFAULT_BRANCH_ID;
  return withTx(() => {
    const gres = d.prepare(
      'INSERT INTO grns (po_id, supplier_id, received_at, notes, received_by, branch_id) VALUES (?, ?, ?, ?, ?, ?)'
    ).run(po.id, po.supplier_id, received_at ? String(received_at) : nowStr(),
      String(notes || ''), actorId == null ? null : Number(actorId), targetBranch);
    const grnId = Number(gres.lastInsertRowid);
    d.prepare('UPDATE grns SET ref = ? WHERE id = ?').run('GRN-' + pad4(grnId), grnId);

    const insGi = d.prepare(
      'INSERT INTO grn_items (grn_id, po_item_id, product_id, qty_received, qty_damaged, unit_cost) VALUES (?, ?, ?, ?, ?, ?)'
    );
    const updPoi = d.prepare(
      'UPDATE purchase_order_items SET received_qty = received_qty + ? WHERE id = ?'
    );

    for (const { poItemId, qtyReceived, qtyDamaged, effCost } of prepared) {
      const poi = d.prepare(
        `SELECT i.*, p.name AS product_name FROM purchase_order_items i
         JOIN products p ON p.id = i.product_id WHERE i.id = ?`
      ).get(poItemId);
      if (!poi || poi.po_id !== po.id) {
        throw new Error('بند أمر الشراء غير موجود');
      }
      if (poi.received_qty + qtyReceived > poi.qty) {
        throw new Error(`الكمية المستلمة تتجاوز الكمية المطلوبة للمنتج "${poi.product_name}"`);
      }
      const lineCost = effCost === null ? Number(poi.unit_cost) : effCost;

      insGi.run(grnId, poi.id, poi.product_id, qtyReceived, qtyDamaged, lineCost);
      updPoi.run(qtyReceived, poi.id);

      const good = qtyReceived - qtyDamaged;
      if (good > 0) {
        // Per-item work happens inline so any failure rolls back everything.
        // Stock lands in the PO's target branch; its row is authoritative.
        db.ensureBranchRow(poi.product_id, targetBranch);
        const bi = db.getBranchRow(poi.product_id, targetBranch);
        const before = Number(bi.quantity);
        const after = before + good;

        let newCost = Number(bi.cost);
        if (after > 0) {
          newCost = round2(((Number(bi.cost) || 0) * before + lineCost * good) / after);
        }
        d.prepare(
          'UPDATE branch_inventory SET quantity = ?, cost = ?, updated_at = ? WHERE branch_id = ? AND product_id = ?'
        ).run(after, newCost, nowStr(), targetBranch, poi.product_id);
        if (targetBranch === db.DEFAULT_BRANCH_ID) db.syncDefaultMirror(poi.product_id);

        d.prepare(
          'INSERT INTO inventory_movements (product_id, change, reason, ref_type, ref_id, balance_before, balance_after, actor_id, branch_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
        ).run(poi.product_id, good, 'grn', 'grn', grnId, before, after,
          actorId == null ? null : Number(actorId), targetBranch);
        // WAC transition audit trail (forward-only from M004; per-branch from M005).
        d.prepare(
          `INSERT INTO cost_history
             (product_id, source_type, grn_id, supplier_id, qty_received, unit_cost, prev_cost, new_cost, actor_id, branch_id)
           VALUES (?, 'grn', ?, ?, ?, ?, ?, ?, ?, ?)`
        ).run(
          poi.product_id, grnId, po.supplier_id, good,
          lineCost, Number(bi.cost) || 0, newCost,
          actorId == null ? null : Number(actorId), targetBranch
        );
      } else if (qtyDamaged > 0) {
        // Damaged-only line still gets an explanatory zero-qty ledger entry.
        db.ensureBranchRow(poi.product_id, targetBranch);
        const bi = db.getBranchRow(poi.product_id, targetBranch);
        d.prepare(
          'INSERT INTO inventory_movements (product_id, change, reason, note, ref_type, ref_id, balance_before, balance_after, actor_id, branch_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
        ).run(poi.product_id, 0, 'grn_damaged', `${qtyDamaged} وحدة تالفة`, 'grn', grnId,
          Number(bi.quantity), Number(bi.quantity),
          actorId == null ? null : Number(actorId), targetBranch);
      }
    }

    // Recompute PO state after applying all lines.
    const agg = d.prepare(
      'SELECT COALESCE(SUM(qty),0) AS ordered, COALESCE(SUM(received_qty),0) AS received FROM purchase_order_items WHERE po_id = ?'
    ).get(po.id);
    const nextStatus = agg.received >= agg.ordered ? 'fully_received' : 'partially_received';
    d.prepare('UPDATE purchase_orders SET status = ?, updated_at = ? WHERE id = ?')
      .run(nextStatus, nowStr(), po.id);

    return { grn: getGrn(grnId), po: getPurchaseOrder(po.id) };
  });
}

module.exports = {
  PO_STATUSES,
  listPurchaseOrders,
  getPurchaseOrder,
  listGrns,
  getGrn,
  supplierPurchaseHistory,
  createPurchaseOrder,
  updatePurchaseOrder,
  addPoItem,
  setPoItem,
  removePoItem,
  submitPurchaseOrder,
  approvePurchaseOrder,
  cancelPurchaseOrder,
  receiveGoods
};
