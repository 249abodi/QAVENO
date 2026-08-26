'use strict';

/*
 * Phase 24 — Stock transfer service (branch -> branch).
 *
 * Lifecycle: draft -> submitted -> approved -> dispatched ->
 *            (partially_received) -> received
 * Cancel: allowed ONLY while nothing has been dispatched (no stock moved).
 *
 * POLICY DECISIONS (documented):
 *  T1 Transfer costing: each dispatched line carries the SOURCE branch's
 *     weighted-average cost at dispatch time. Multiple partial dispatches of
 *     one item carry the qty-weighted average of their source costs.
 *  T2 Destination blends its own WAC with the carried cost using the standard
 *     formula; a first receipt into an empty destination adopts the carried
 *     cost as-is.
 *  T3 cost_history stays purchase/manual-scoped (its CHECK vocabulary is
 *     frozen from M004); transfer cost events remain traceable through
 *     stock_transfer_items.unit_cost + the movements ledger.
 *  T4 Visibility: restricted roles see transfers touching any of their
 *     authorized branches; MUTATING requires authorization on BOTH branches.
 *  T5 Every dispatch/receive writes ledger movements (transfer_out /
 *     transfer_in) against the respective branch under BEGIN IMMEDIATE, so
 *     concurrent steps serialize and can never oversell source stock.
 */

const db = require('./db');
const auth = require('./auth');
const branches = require('./branches');

const TRANSFER_STATUSES = [
  'draft', 'submitted', 'approved', 'dispatched',
  'partially_received', 'received', 'cancelled'
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

function pad4(n) {
  return String(n).padStart(4, '0');
}

/* ---------------- validation helpers ---------------- */

function strictPosInt(v, label) {
  const n = Number(v);
  if (!Number.isInteger(n) || n <= 0) throw new Error(label);
  return n;
}

function productName(pid) {
  const r = db.getDb().prepare('SELECT name FROM products WHERE id = ?').get(Number(pid));
  return r ? r.name : String(pid);
}

function requireActor(actorId) {
  const u = actorId != null ? auth.getUser(actorId) : null;
  if (!u || u.status !== 'active') {
    const e = new Error('مستخدم غير مصرح به');
    e.code = 'UNAUTHORIZED';
    throw e;
  }
  return u;
}

/* Loads the transfer and enforces authorization on BOTH ends (T4). */
function loadTransferForMutation(actorId, transferId) {
  const user = requireActor(actorId);
  const t = getTransfer(transferId);
  if (!t) throw new Error('أمر التحويل غير موجود');
  branches.assertBranchAccess(user, t.source_branch_id);
  branches.assertBranchAccess(user, t.dest_branch_id);
  return { user, t };
}

function validateItems(items) {
  if (!Array.isArray(items) || items.length === 0) {
    throw new Error('يجب إضافة بند واحد على الأقل للتحويل');
  }
  const seen = new Set();
  return items.map(it => {
    const pid = strictPosInt(it.product_id, 'منتج غير صالح في بنود التحويل');
    if (seen.has(pid)) throw new Error('لا يمكن تكرار المنتج في بنود التحويل');
    seen.add(pid);
    const qty = strictPosInt(it.qty, 'الكمية يجب أن تكون أكبر من صفر');
    return { product_id: pid, qty };
  });
}

function assertDistinctActiveBranches(sourceId, destId) {
  if (Number(sourceId) === Number(destId)) {
    const e = new Error('لا يمكن التحويل إلى نفس الفرع');
    e.code = 'SAME_BRANCH';
    throw e;
  }
  for (const bid of [sourceId, destId]) {
    const b = branches.getBranch(bid);
    if (!b) throw new Error('الفرع غير موجود');
    if (b.status !== 'active') throw new Error(`الفرع "${b.name}" معطل`);
  }
}

/* ---------------- read side ---------------- */

function getTransfer(id) {
  const d = db.getDb();
  const t = d.prepare(
    `SELECT t.*,
            sb.name AS source_branch_name, dbt.name AS dest_branch_name,
            cu.username AS created_by_name,
            au.username AS approved_by_name,
            du.username AS last_dispatched_by_name,
            ru.username AS last_received_by_name,
            xu.username AS cancelled_by_name
     FROM stock_transfers t
     JOIN branches sb ON sb.id = t.source_branch_id
     JOIN branches dbt ON dbt.id = t.dest_branch_id
     LEFT JOIN users cu ON cu.id = t.created_by
     LEFT JOIN users au ON au.id = t.approved_by
     LEFT JOIN users du ON du.id = t.last_dispatched_by
     LEFT JOIN users ru ON ru.id = t.last_received_by
     LEFT JOIN users xu ON xu.id = t.cancelled_by
     WHERE t.id = ?`
  ).get(Number(id));
  if (!t) return null;
  t.items = d.prepare(
    `SELECT i.*, p.name AS product_name, p.barcode AS product_barcode
     FROM stock_transfer_items i JOIN products p ON p.id = i.product_id
     WHERE i.transfer_id = ? ORDER BY i.id`
  ).all(Number(id));
  let totalQty = 0;
  let totalDispatched = 0;
  let totalReceived = 0;
  let totalValue = 0;
  for (const it of t.items) {
    totalQty += it.qty;
    totalDispatched += it.dispatched_qty;
    totalReceived += it.received_qty;
    if (it.unit_cost != null) totalValue += it.unit_cost * it.received_qty;
  }
  t.total_qty = totalQty;
  t.total_dispatched_qty = totalDispatched;
  t.total_received_qty = totalReceived;
  t.total_received_value = round2(totalValue);
  return t;
}

function listTransfers(user, { status, branch_id } = {}) {
  const where = [];
  const args = [];
  if (status && TRANSFER_STATUSES.includes(String(status))) {
    where.push('t.status = ?');
    args.push(String(status));
  }
  // Visibility scope (T4).
  const accessible = branches.accessibleBranchIds(user);
  if (accessible.length === 0) return [];
  const spanning = !!(user && (user.role === 'owner' || user.role === 'admin'));
  if (branch_id != null && branch_id !== '') {
    const bid = Number(branch_id);
    if (!spanning && !accessible.includes(bid)) return [];
    where.push('(t.source_branch_id = ? OR t.dest_branch_id = ?)');
    args.push(bid, bid);
  } else if (!spanning) {
    where.push(
      `(t.source_branch_id IN (${accessible.map(() => '?').join(',')})
        OR t.dest_branch_id IN (${accessible.map(() => '?').join(',')}))`
    );
    args.push(...accessible, ...accessible);
  }
  return db.getDb().prepare(
    `SELECT t.*, sb.name AS source_branch_name, dbt.name AS dest_branch_name,
       (SELECT COUNT(*) FROM stock_transfer_items i WHERE i.transfer_id = t.id) AS line_count,
       (SELECT COALESCE(SUM(i.qty), 0) FROM stock_transfer_items i WHERE i.transfer_id = t.id) AS total_qty,
       (SELECT COALESCE(SUM(i.dispatched_qty), 0) FROM stock_transfer_items i WHERE i.transfer_id = t.id) AS total_dispatched_qty,
       (SELECT COALESCE(SUM(i.received_qty), 0) FROM stock_transfer_items i WHERE i.transfer_id = t.id) AS total_received_qty
     FROM stock_transfers t
     JOIN branches sb ON sb.id = t.source_branch_id
     JOIN branches dbt ON dbt.id = t.dest_branch_id
     ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
     ORDER BY t.id DESC LIMIT 500`
  ).all(...args);
}

/* ---------------- write side ---------------- */

function createTransfer(actorId, { source_branch_id, dest_branch_id, notes, items } = {}) {
  const user = requireActor(actorId);
  const src = Number(source_branch_id);
  const dst = Number(dest_branch_id);
  assertDistinctActiveBranches(src, dst);
  branches.assertBranchAccess(user, src);
  branches.assertBranchAccess(user, dst);
  const lines = validateItems(items);
  const chkProduct = db.getDb().prepare('SELECT id FROM products WHERE id = ?');
  for (const l of lines) {
    if (!chkProduct.get(l.product_id)) throw new Error('منتج غير موجود في بنود التحويل');
  }

  let id;
  withTx(() => {
    const res = db.getDb().prepare(
      `INSERT INTO stock_transfers (source_branch_id, dest_branch_id, notes, created_by)
       VALUES (?, ?, ?, ?)`
    ).run(src, dst, String(notes || ''), user.id);
    id = Number(res.lastInsertRowid);
    db.getDb().prepare('UPDATE stock_transfers SET ref = ?, updated_at = ? WHERE id = ?')
      .run('TRF-' + pad4(id), nowStr(), id);
    const ins = db.getDb().prepare(
      'INSERT INTO stock_transfer_items (transfer_id, product_id, qty) VALUES (?, ?, ?)'
    );
    for (const l of lines) ins.run(id, l.product_id, l.qty);
  });

  auth.audit({
    actorId, action: 'transfer.create', entity_type: 'stock_transfer', entity_id: id,
    details: JSON.stringify({ source_branch_id: src, dest_branch_id: dst, lines: lines.length })
  });
  return getTransfer(id);
}

function submitTransfer(actorId, id) {
  const { t } = loadTransferForMutation(actorId, id);
  if (t.status !== 'draft') throw new Error('يمكن إرسال أوامر التحويل من حالة المسودة فقط');
  if (!t.items.length) throw new Error('لا يمكن إرسال تحويل فارغ');
  db.getDb().prepare("UPDATE stock_transfers SET status = 'submitted', updated_at = ? WHERE id = ?")
    .run(nowStr(), t.id);
  auth.audit({
    actorId, action: 'transfer.submit', entity_type: 'stock_transfer', entity_id: t.id, details: {}
  });
  return getTransfer(t.id);
}

function approveTransfer(actorId, id) {
  const { t } = loadTransferForMutation(actorId, id);
  if (t.status !== 'submitted') throw new Error('يمكن اعتماد أوامر التحويل المرسلة فقط');
  db.getDb().prepare(
    "UPDATE stock_transfers SET status = 'approved', approved_by = ?, approved_at = ?, updated_at = ? WHERE id = ?"
  ).run(actorId == null ? null : Number(actorId), nowStr(), nowStr(), t.id);
  auth.audit({
    actorId, action: 'transfer.approve', entity_type: 'stock_transfer', entity_id: t.id, details: {}
  });
  return getTransfer(t.id);
}

/** Dispatch (possibly partial) approved transfers: deduct source branch stock. */
function dispatchTransfer(actorId, { id, lines } = {}) {
  const tid = Number(id);
  if (!Array.isArray(lines) || lines.length === 0) {
    throw new Error('يجب تحديد بنود للتسليم');
  }
  const prepared = lines.map(l => ({
    itemId: strictPosInt(l.item_id ?? l.itemId, 'بند غير صالح'),
    qty: strictPosInt(l.qty, 'الكمية يجب أن تكون أكبر من صفر')
  }));

  const { t } = loadTransferForMutation(actorId, tid);
  if (t.status !== 'approved') throw new Error('يمكن تسليم الأوامر المعتمدة فقط');

  const out = withTx(() => {
    const d = db.getDb();
    const updItem = d.prepare(
      'UPDATE stock_transfer_items SET dispatched_qty = dispatched_qty + ?, unit_cost = ? WHERE id = ?'
    );

    for (const { itemId, qty } of prepared) {
      const item = d.prepare('SELECT * FROM stock_transfer_items WHERE id = ?').get(itemId);
      if (!item || item.transfer_id !== t.id) throw new Error('بند أمر التحويل غير موجود');
      const remaining = item.qty - item.dispatched_qty;
      if (qty > remaining) {
        throw new Error(`الكمية تتجاوز المتبقي للتسليم (${remaining}) للمنتج "${productName(item.product_id)}"`);
      }

      db.ensureBranchRow(item.product_id, t.source_branch_id);
      const src = db.getBranchRow(item.product_id, t.source_branch_id);
      const before = Number(src.quantity);
      if (before < qty) {
        throw new Error(`المخزون غير كافٍ في فرع المصدر للمنتج "${productName(item.product_id)}" (المتوفر ${before})`);
      }
      const after = before - qty;
      d.prepare(
        'UPDATE branch_inventory SET quantity = ?, updated_at = ? WHERE branch_id = ? AND product_id = ?'
      ).run(after, nowStr(), t.source_branch_id, item.product_id);
      if (t.source_branch_id === db.DEFAULT_BRANCH_ID) db.syncDefaultMirror(item.product_id);

      // Carried cost: qty-weighted source WAC across partial dispatches (T1).
      const prevQty = Number(item.dispatched_qty);
      const prevUnit = item.unit_cost != null ? Number(item.unit_cost) : null;
      let carried;
      if (prevUnit == null || prevQty === 0) {
        carried = round2(Number(src.cost));
      } else {
        carried = round2(((prevUnit * prevQty) + (Number(src.cost) * qty)) / (prevQty + qty));
      }
      updItem.run(qty, carried, item.id);

      d.prepare(
        `INSERT INTO inventory_movements
           (product_id, change, reason, ref_type, ref_id, balance_before, balance_after, actor_id, branch_id)
         VALUES (?, ?, 'transfer_out', 'transfer', ?, ?, ?, ?, ?)`
      ).run(item.product_id, -qty, t.id, before, after,
        actorId == null ? null : Number(actorId), t.source_branch_id);
    }

    // Status: stay 'approved' until every line is fully dispatched.
    const agg = d.prepare(
      `SELECT COALESCE(SUM(qty),0) AS q, COALESCE(SUM(dispatched_qty),0) AS dd
       FROM stock_transfer_items WHERE transfer_id = ?`
    ).get(t.id);
    const nextStatus = agg.dd >= agg.q ? 'dispatched' : 'approved';
    d.prepare(
      "UPDATE stock_transfers SET status = ?, last_dispatched_by = ?, last_dispatched_at = ?, updated_at = ? WHERE id = ?"
    ).run(nextStatus, actorId == null ? null : Number(actorId), nowStr(), nowStr(), t.id);

    return getTransfer(t.id);
  });

  auth.audit({
    actorId, action: 'transfer.dispatch', entity_type: 'stock_transfer', entity_id: tid,
    details: JSON.stringify({ lines: prepared.length })
  });
  return out;
}

/** Receive (possibly partial) dispatched transfers: credit destination branch. */
function receiveTransfer(actorId, { id, lines } = {}) {
  const tid = Number(id);
  if (!Array.isArray(lines) || lines.length === 0) {
    throw new Error('يجب تحديد بنود للاستلام');
  }
  const prepared = lines.map(l => ({
    itemId: strictPosInt(l.item_id ?? l.itemId, 'بند غير صالح'),
    qty: strictPosInt(l.qty, 'الكمية يجب أن تكون أكبر من صفر')
  }));

  const { t } = loadTransferForMutation(actorId, tid);
  if (t.status !== 'dispatched' && t.status !== 'partially_received') {
    throw new Error('يمكن الاستلام للأوامر المسلّمة فقط');
  }

  const out = withTx(() => {
    const d = db.getDb();

    for (const { itemId, qty } of prepared) {
      const item = d.prepare('SELECT * FROM stock_transfer_items WHERE id = ?').get(itemId);
      if (!item || item.transfer_id !== t.id) throw new Error('بند أمر التحويل غير موجود');
      if (item.unit_cost == null) throw new Error('لم يتم تسليم هذا البند بعد');
      const outstanding = item.dispatched_qty - item.received_qty;
      if (outstanding <= 0) {
        // Double-receive guard.
        const e = new Error(`تم استلام هذا البند بالكامل ("${productName(item.product_id)}")`);
        e.code = 'DOUBLE_RECEIVE';
        throw e;
      }
      if (qty > outstanding) {
        throw new Error(`الكمية تتجاوز المتبقي للاستلام (${outstanding}) للمنتج "${productName(item.product_id)}"`);
      }

      db.ensureBranchRow(item.product_id, t.dest_branch_id);
      const dst = db.getBranchRow(item.product_id, t.dest_branch_id);
      const before = Number(dst.quantity);
      const after = before + qty;

      // Destination WAC blend with the carried cost (T2).
      const carried = Number(item.unit_cost);
      const newCost = before > 0
        ? round2(((Number(dst.cost) || 0) * before + carried * qty) / after)
        : round2(carried);

      d.prepare(
        'UPDATE branch_inventory SET quantity = ?, cost = ?, updated_at = ? WHERE branch_id = ? AND product_id = ?'
      ).run(after, newCost, nowStr(), t.dest_branch_id, item.product_id);
      if (t.dest_branch_id === db.DEFAULT_BRANCH_ID) db.syncDefaultMirror(item.product_id);

      d.prepare(
        'UPDATE stock_transfer_items SET received_qty = received_qty + ? WHERE id = ?'
      ).run(qty, item.id);

      d.prepare(
        `INSERT INTO inventory_movements
           (product_id, change, reason, ref_type, ref_id, balance_before, balance_after, actor_id, branch_id)
         VALUES (?, ?, 'transfer_in', 'transfer', ?, ?, ?, ?, ?)`
      ).run(item.product_id, qty, t.id, before, after,
        actorId == null ? null : Number(actorId), t.dest_branch_id);
    }

    const agg = d.prepare(
      `SELECT COALESCE(SUM(qty),0) AS q, COALESCE(SUM(received_qty),0) AS rr
       FROM stock_transfer_items WHERE transfer_id = ?`
    ).get(t.id);
    const nextStatus = agg.rr >= agg.q ? 'received' : 'partially_received';
    d.prepare(
      "UPDATE stock_transfers SET status = ?, last_received_by = ?, last_received_at = ?, updated_at = ? WHERE id = ?"
    ).run(nextStatus, actorId == null ? null : Number(actorId), nowStr(), nowStr(), t.id);

    return getTransfer(t.id);
  });

  auth.audit({
    actorId, action: 'transfer.receive', entity_type: 'stock_transfer', entity_id: tid,
    details: JSON.stringify({ lines: prepared.length })
  });
  return out;
}

function cancelTransfer(actorId, { id, reason } = {}) {
  const { t } = loadTransferForMutation(actorId, id);
  if (t.status === 'cancelled') throw new Error('أمر التحويل ملغى بالفعل');
  if (t.status === 'received') throw new Error('لا يمكن إلغاء تحويل تم استلامه');
  const moved = t.items.some(i => i.dispatched_qty > 0);
  if (moved) {
    const e = new Error('لا يمكن الإلغاء بعد بدء التسليم');
    e.code = 'DISPATCH_STARTED';
    throw e;
  }

  db.getDb().prepare(
    "UPDATE stock_transfers SET status = 'cancelled', cancelled_by = ?, cancelled_at = ?, cancel_reason = ?, updated_at = ? WHERE id = ?"
  ).run(actorId == null ? null : Number(actorId), nowStr(), String(reason || ''), nowStr(), t.id);
  auth.audit({
    actorId, action: 'transfer.cancel', entity_type: 'stock_transfer', entity_id: t.id,
    details: JSON.stringify({ reason: String(reason || '') })
  });
  return getTransfer(t.id);
}

module.exports = {
  TRANSFER_STATUSES,
  getTransfer,
  listTransfers,
  createTransfer,
  submitTransfer,
  approveTransfer,
  dispatchTransfer,
  receiveTransfer,
  cancelTransfer
};
