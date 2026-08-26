'use strict';

/*
 * Phase 23 — Advanced Inventory service.
 *
 * ARCHITECTURE DECISIONS (documented):
 * 1) Ledger: inventory_movements is the single source of truth for stock
 *    history. M004 added actor_id / balance_before / reason_code additively;
 *    legacy rows keep NULLs (never fabricate history).
 * 2) Adjustments are DELTA-based with a mandatory reason_code from a fixed
 *    vocabulary; the movement row itself is the record (no duplicate table).
 *    Negative resulting sellable stock is rejected inside the transaction.
 * 3) Reconciliation uses snapshot sessions (stock_reconciliations). Confirm
 *    re-reads the authoritative quantity under BEGIN IMMEDIATE; if stock
 *    moved since capture the session is marked 'stale' and rejected.
 * 4) Cost history (cost_history) is written forward-only from product
 *    creation, manual cost edits and GRN receipts. Pre-M004 receipts are
 *    intentionally not backfilled — paid prices remain in grn_items.
 * 5) Reorder level = low_stock_threshold (existing semantics kept);
 *    reorder_qty suggests how much to order when at/below level.
 * 6) Valuation is always quantity x weighted-average cost, never selling
 *    price. All money passes through round2 for exactness.
 *
 * PHASE 24 — Multi-branch additions:
 * 7) All stock operations are scoped to a branch via branch_inventory
 *    (authoritative); products.* is the default-branch mirror (D1 in
 *    branches.js). Omitted branch_id means the DEFAULT branch for direct
 *    service calls; IPC callers pass an access-validated branch id.
 * 8) Reconciliation sessions are per (product, branch); stale detection
 *    compares against that branch's authoritative row.
 * 9) Reorder rules are per (product, branch), seeded from defaults.
 * 10) Valuation/overview scope to one branch or aggregate all branches.
 */

const db = require('./db');
const auth = require('./auth');

const ADJUST_REASONS = [
  'damaged', 'lost', 'found', 'counting_error', 'opening_balance', 'correction', 'other'
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

function intVal(v, label, { min = null } = {}) {
  const n = Math.trunc(Number(v));
  if (!Number.isFinite(n)) throw new Error(label);
  if (min !== null && !(n >= min)) throw new Error(label);
  return n;
}

/* Strict variant: rejects fractional input instead of silently truncating.
   Used wherever the value is a stock quantity or configuration number. */
function strictInt(v, label) {
  const n = Number(v);
  if (!Number.isFinite(n) || !Number.isInteger(n)) throw new Error(label);
  return n;
}

function assertReason(code) {
  const c = String(code || '').trim();
  if (!ADJUST_REASONS.includes(c)) {
    throw new Error('سبب التعديل مطلوب ويجب أن يكون من القائمة المعتمدة');
  }
  return c;
}

function getProductRow(id) {
  return db.getDb().prepare('SELECT * FROM products WHERE id = ?').get(Number(id));
}

/* ---------------- Stock adjustments ---------------- */

/**
 * Delta-based controlled adjustment.
 * payload: { product_id, delta (+/- int, non-zero), reason_code, note?, branch_id? }
 */
function adjustStock(actorId, { product_id, delta, reason_code, note, branch_id }) {
  const pid = intVal(product_id, 'المنتج غير صالح') ;
  const d = strictInt(delta, 'قيمة التعديل يجب أن تكون عدداً صحيحاً غير صفري');
  if (d === 0) throw new Error('قيمة التعديل يجب أن تكون عدداً غير صفري');
  const reason = assertReason(reason_code);
  const cleanNote = note ? String(note).trim().slice(0, 500) : '';
  const branchId = branch_id != null ? intVal(branch_id, 'الفرع غير صالح') : db.DEFAULT_BRANCH_ID;

  let out;
  withTx(() => {
    const p = getProductRow(pid);
    if (!p) throw new Error('المنتج غير موجود');
    db.ensureBranchRow(pid, branchId);
    const before = Number(db.getBranchRow(pid, branchId).quantity);
    const after = before + d;
    if (after < 0) {
      throw new Error(`لا يمكن أن يصبح المخزون سالباً (الحالي ${before}، التعديل ${d})`);
    }
    db.getDb().prepare(
      'UPDATE branch_inventory SET quantity = ?, updated_at = ? WHERE branch_id = ? AND product_id = ?'
    ).run(after, nowStr(), branchId, pid);
    if (branchId === db.DEFAULT_BRANCH_ID) db.syncDefaultMirror(pid);

    const mv = db.getDb().prepare(
      `INSERT INTO inventory_movements
         (product_id, change, reason, note, ref_type, balance_before, balance_after, reason_code, actor_id, branch_id, created_at)
       VALUES (?, ?, 'adjustment', ?, 'adjustment', ?, ?, ?, ?, ?, ?)`
    ).run(pid, d, cleanNote || null, before, after, reason,
      actorId != null ? Number(actorId) : null, branchId, nowStr());
    const movementId = Number(mv.lastInsertRowid);

    auth.audit({
      actorId,
      action: 'inventory.adjust',
      entity_type: 'product',
      entity_id: pid,
      details: { delta: d, before, after, reason_code: reason, note: cleanNote, movement_id: movementId, branch_id: branchId }
    });

    out = { product: getProductRow(pid), movement_id: movementId };
  });
  return out;
}

/* ---------------- Stock reconciliation ---------------- */

/**
 * Open a reconciliation session: snapshots current authoritative qty.
 * payload: { product_id, counted_qty (int >= 0), reason_code, note?, branch_id? }
 */
function openReconciliation(actorId, { product_id, counted_qty, reason_code, note, branch_id }) {
  const pid = intVal(product_id, 'المنتج غير صالح');
  const countedRaw = strictInt(counted_qty, 'الكمية المجرودة يجب أن تكون صفراً أو أكثر');
  if (!(countedRaw >= 0)) throw new Error('الكمية المجرودة يجب أن تكون صفراً أو أكثر');
  const counted = countedRaw;
  const reason = assertReason(reason_code);
  const cleanNote = note ? String(note).trim().slice(0, 500) : '';
  const branchId = branch_id != null ? intVal(branch_id, 'الفرع غير صالح') : db.DEFAULT_BRANCH_ID;

  let row;
  withTx(() => {
    const p = getProductRow(pid);
    if (!p) throw new Error('المنتج غير موجود');
    db.ensureBranchRow(pid, branchId);

    const openExists = db.getDb().prepare(
      "SELECT COUNT(*) AS c FROM stock_reconciliations WHERE product_id = ? AND branch_id = ? AND status = 'open'"
    ).get(pid, branchId).c;
    if (openExists > 0) {
      throw new Error('يوجد جرد مفتوح لهذا المنتج بالفعل؛ أنهِ الجلسة الحالية أولاً');
    }

    const systemQty = Number(db.getBranchRow(pid, branchId).quantity);
    const res = db.getDb().prepare(
      `INSERT INTO stock_reconciliations
         (product_id, system_qty, counted_qty, diff_qty, status, reason_code, note, created_by, branch_id)
       VALUES (?, ?, ?, ?, 'open', ?, ?, ?, ?)`
    ).run(pid, systemQty, counted, counted - systemQty, reason, cleanNote,
      actorId != null ? Number(actorId) : null, branchId);
    row = getReconRow(Number(res.lastInsertRowid));

    auth.audit({
      actorId,
      action: 'inventory.reconcile.open',
      entity_type: 'stock_reconciliation',
      entity_id: row.id,
      details: { product_id: pid, system_qty: systemQty, counted_qty: counted, branch_id: branchId }
    });
  });
  return row;
}

function getReconRow(id) {
  return db.getDb().prepare(
    `SELECT r.*, p.name AS product_name, b.name AS branch_name,
            cu.username AS created_by_name, au.username AS applied_by_name
     FROM stock_reconciliations r
     JOIN products p ON p.id = r.product_id
     LEFT JOIN branches b ON b.id = r.branch_id
     LEFT JOIN users cu ON cu.id = r.created_by
     LEFT JOIN users au ON au.id = r.applied_by
     WHERE r.id = ?`
  ).get(Number(id));
}

/**
 * Confirm reconciliation against AUTHORITATIVE current stock.
 * Stale-safety: if stock moved between open and confirm, mark 'stale' and reject.
 * The stale marker is committed in its own transaction AFTER the rolled-back
 * attempt, so sessions flagged for review persist.
 */
function confirmReconciliation(actorId, reconId) {
  let out;
  try {
    out = withTx(() => {
      const r = db.getDb().prepare('SELECT * FROM stock_reconciliations WHERE id = ?').get(Number(reconId));
      if (!r) throw new Error('جلسة الجرد غير موجودة');
      if (r.status !== 'open') throw new Error('لا يمكن تأكيد جلسة جرد غير مفتوحة');

      const branchId = r.branch_id != null ? Number(r.branch_id) : db.DEFAULT_BRANCH_ID;
      const p = getProductRow(r.product_id);
      if (!p) throw new Error('المنتج غير موجود');
      const current = Number(db.getBranchRow(r.product_id, branchId).quantity);

      if (current !== r.system_qty) {
        const err = new Error(
          `انتهت صلاحية الجرد: تغير مخزون النظام أثناء الجرد (${r.system_qty} ← ${current}). أعد الجرد من جديد`
        );
        err.code = 'STALE_RECONCILIATION';
        err.staleInfo = { snapshot: r.system_qty, current };
        throw err;
      }

      const diff = r.counted_qty - current;

      if (diff !== 0) {
        // Resulting stock equals counted_qty >= 0 by construction — never negative.
        db.getDb().prepare(
          'UPDATE branch_inventory SET quantity = ?, updated_at = ? WHERE branch_id = ? AND product_id = ?'
        ).run(current + diff, nowStr(), branchId, r.product_id);
        if (branchId === db.DEFAULT_BRANCH_ID) db.syncDefaultMirror(r.product_id);

        const mv = db.getDb().prepare(
          `INSERT INTO inventory_movements
             (product_id, change, reason, note, ref_type, ref_id, balance_before, balance_after, reason_code, actor_id, branch_id, created_at)
           VALUES (?, ?, 'reconciliation', ?, 'reconciliation', ?, ?, ?, ?, ?, ?, ?)`
        ).run(
          r.product_id, diff, r.note || null, r.id,
          current, current + diff, r.reason_code,
          actorId != null ? Number(actorId) : null, branchId, nowStr()
        );
        db.getDb().prepare(
          "UPDATE stock_reconciliations SET status='applied', diff_qty=?, applied_by=?, applied_at=?, movement_id=? WHERE id=?"
        ).run(diff, actorId != null ? Number(actorId) : null, nowStr(), Number(mv.lastInsertRowid), r.id);
      } else {
        db.getDb().prepare(
          "UPDATE stock_reconciliations SET status='applied', applied_by=?, applied_at=? WHERE id=?"
        ).run(actorId != null ? Number(actorId) : null, nowStr(), r.id);
      }

      auth.audit({
        actorId,
        action: 'inventory.reconcile.confirm',
        entity_type: 'stock_reconciliation',
        entity_id: r.id,
        details: { product_id: r.product_id, diff, counted: r.counted_qty, system: current, branch_id: branchId }
      });

      return { reconciliation: getReconRow(r.id), product: getProductRow(r.product_id) };
    });
  } catch (err) {
    if (err && err.code === 'STALE_RECONCILIATION') {
      // Persist the review flag outside the rolled-back attempt.
      withTx(() => {
        db.getDb().prepare(
          "UPDATE stock_reconciliations SET status = 'stale' WHERE id = ? AND status = 'open'"
        ).run(Number(reconId));
        auth.audit({
          actorId,
          action: 'inventory.reconcile.stale',
          entity_type: 'stock_reconciliation',
          entity_id: Number(reconId),
          details: err.staleInfo || {}
        });
      });
    }
    throw err;
  }
  return out;
}

/** Cancel an open session (no stock effect). */
function cancelReconciliation(actorId, reconId) {
  let row;
  withTx(() => {
    const r = db.getDb().prepare('SELECT * FROM stock_reconciliations WHERE id = ?').get(Number(reconId));
    if (!r) throw new Error('جلسة الجرد غير موجودة');
    if (r.status !== 'open') throw new Error('لا يمكن إلغاء جلسة جرد غير مفتوحة');
    db.getDb().prepare("UPDATE stock_reconciliations SET status = 'cancelled' WHERE id = ?").run(r.id);
    auth.audit({
      actorId,
      action: 'inventory.reconcile.cancel',
      entity_type: 'stock_reconciliation',
      entity_id: r.id,
      details: { product_id: r.product_id }
    });
    row = getReconRow(r.id);
  });
  return row;
}

function listReconciliations({ status, product_id, branch_id, limit = 50 } = {}) {
  const where = [];
  const args = [];
  if (status && ['open', 'applied', 'cancelled', 'stale'].includes(String(status))) {
    where.push('r.status = ?'); args.push(String(status));
  }
  if (product_id != null && product_id !== '') {
    where.push('r.product_id = ?'); args.push(intVal(product_id, 'المنتج غير صالح'));
  }
  if (branch_id != null && branch_id !== '') {
    where.push('r.branch_id = ?'); args.push(intVal(branch_id, 'الفرع غير صالح'));
  }
  const lim = Math.min(Math.max(1, Math.trunc(Number(limit) || 50)), 200);
  const sql =
    `SELECT r.*, p.name AS product_name, b.name AS branch_name,
            cu.username AS created_by_name, au.username AS applied_by_name
     FROM stock_reconciliations r
     JOIN products p ON p.id = r.product_id
     LEFT JOIN branches b ON b.id = r.branch_id
     LEFT JOIN users cu ON cu.id = r.created_by
     LEFT JOIN users au ON au.id = r.applied_by
     ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
     ORDER BY r.id DESC LIMIT ?`;
  return db.getDb().prepare(sql).all(...args, lim);
}

/* ---------------- Reorder rules ---------------- */

/**
 * Set reorder config for one product (per branch; default when omitted).
 * reorder LEVEL stays low_stock_threshold; reorder_qty is the suggested order size.
 */
function setReorderRules(actorId, productId, { low_stock_threshold, reorder_qty, branch_id } = {}) {
  if (low_stock_threshold === undefined && reorder_qty === undefined) {
    throw new Error('لا توجد قيم لتحديثها');
  }
  const branchId = branch_id != null ? intVal(branch_id, 'الفرع غير صالح') : db.DEFAULT_BRANCH_ID;
  let out;
  withTx(() => {
    const p = getProductRow(productId);
    if (!p) throw new Error('المنتج غير موجود');
    db.ensureBranchRow(productId, branchId);
    const row = db.getBranchRow(productId, branchId);

    const level = low_stock_threshold !== undefined
      ? strictInt(low_stock_threshold, 'مستوى إعادة الطلب يجب أن يكون رقماً صحيحاً غير سالب')
      : Number(row.low_stock_threshold);
    if (!(level >= 0)) throw new Error('مستوى إعادة الطلب يجب أن يكون رقماً صحيحاً غير سالب');
    const rq = reorder_qty !== undefined
      ? strictInt(reorder_qty, 'كمية إعادة الطلب يجب أن تكون رقماً صحيحاً غير سالبة')
      : Number(row.reorder_qty ?? 0);
    if (!(rq >= 0)) throw new Error('كمية إعادة الطلب يجب أن تكون رقماً صحيحاً غير سالبة');

    db.getDb().prepare(
      'UPDATE branch_inventory SET low_stock_threshold = ?, reorder_qty = ?, updated_at = ? WHERE branch_id = ? AND product_id = ?'
    ).run(level, rq, nowStr(), branchId, Number(productId));
    if (branchId === db.DEFAULT_BRANCH_ID) db.syncDefaultMirror(Number(productId));

    auth.audit({
      actorId,
      action: 'inventory.rules.set',
      entity_type: 'product',
      entity_id: Number(productId),
      details: {
        low_stock_threshold: level, reorder_qty: rq, branch_id: branchId,
        prev: { low_stock_threshold: row.low_stock_threshold, reorder_qty: row.reorder_qty ?? 0 }
      }
    });

    out = { ...getProductRow(Number(productId)), low_stock_threshold: level, reorder_qty: rq };
  });
  return out;
}

/* ---------------- Valuation & overview ---------------- */

function stockStatus(quantity, level) {
  const q = Number(quantity);
  if (q <= 0) return 'out';
  if (q <= Number(level)) return 'low';
  return 'ok';
}

/**
 * Inventory valuation report — value = sellable stock x WAC (branch cost).
 * Never uses selling price. Scoped to one branch, or aggregated across all
 * branches when branch_id is omitted (one row per product-branch pair).
 */
function valuation({ category_id, q, low_stock_only, branch_id } = {}) {
  const where = [];
  const args = [];
  if (category_id != null && category_id !== '') {
    where.push('p.category_id = ?');
    args.push(intVal(category_id, 'التصنيف غير صالح'));
  }
  if (q) {
    const like = `%${String(q).trim()}%`;
    where.push('(p.name LIKE ? OR p.barcode LIKE ?)');
    args.push(like, like);
  }
  if (branch_id != null && branch_id !== '') {
    where.push('bi.branch_id = ?');
    args.push(intVal(branch_id, 'الفرع غير صالح'));
  }
  const rowsRaw = db.getDb().prepare(
    `SELECT p.id, p.name, p.barcode, bi.quantity, bi.cost,
            bi.low_stock_threshold, bi.reorder_qty,
            bi.branch_id, b.name AS branch_name, c.name AS category_name
     FROM branch_inventory bi
     JOIN products p ON p.id = bi.product_id
     LEFT JOIN branches b ON b.id = bi.branch_id
     LEFT JOIN categories c ON c.id = p.category_id
     ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
     ORDER BY p.name COLLATE NOCASE, bi.branch_id`
  ).all(...args);

  let totalValue = 0;
  let lowCount = 0;
  let outCount = 0;
  const rows = rowsRaw.map(p => {
    const value = round2(Number(p.quantity) * Number(p.cost));
    totalValue += value;
    const status = stockStatus(p.quantity, p.low_stock_threshold);
    if (status === 'low') lowCount += 1;
    if (status === 'out') outCount += 1;
    const needsOrder = status !== 'ok';
    if (low_stock_only && !needsOrder) return null;
    return {
      ...p,
      value,
      stock_status: status,
      suggested_order: needsOrder && Number(p.reorder_qty) > 0 ? Number(p.reorder_qty) : null
    };
  }).filter(Boolean);

  return {
    rows,
    totals: {
      total_value: round2(totalValue),
      products_count: rows.length,
      filtered_total_products: rowsRaw.length,
      low_count: lowCount,
      out_count: outCount
    }
  };
}

function overview({ branch_id } = {}) {
  const v = valuation({ branch_id });
  const openRecons = db.getDb().prepare(
    "SELECT COUNT(*) AS c FROM stock_reconciliations WHERE status = 'open'"
  ).get().c;
  return { ...v.totals, open_reconciliations: openRecons };
}

/* ---------------- Movement ledger queries ---------------- */

/**
 * Filterable, paginated ledger view. Keeps legacy listMovements untouched.
 * filters: { product_id?, reason?, ref_type?, actor_id?, date_from?, date_to?, q?, limit?, offset? }
 */
function listMovementsPaged(filters = {}) {
  const where = [];
  const args = [];

  if (filters.product_id != null && filters.product_id !== '') {
    where.push('m.product_id = ?');
    args.push(intVal(filters.product_id, 'المنتج غير صالح'));
  }
  if (filters.reason && String(filters.reason).trim()) {
    where.push('m.reason = ?');
    args.push(String(filters.reason).trim());
  }
  if (filters.ref_type && String(filters.ref_type).trim()) {
    where.push('m.ref_type = ?');
    args.push(String(filters.ref_type).trim());
  }
  if (filters.actor_id != null && filters.actor_id !== '') {
    where.push('m.actor_id = ?');
    args.push(intVal(filters.actor_id, 'المستخدم غير صالح'));
  }
  if (filters.branch_id != null && filters.branch_id !== '') {
    where.push('m.branch_id = ?');
    args.push(intVal(filters.branch_id, 'الفرع غير صالح'));
  }
  if (filters.date_from && String(filters.date_from).trim()) {
    where.push("date(m.created_at) >= date(?)");
    args.push(String(filters.date_from).trim());
  }
  if (filters.date_to && String(filters.date_to).trim()) {
    where.push("date(m.created_at) <= date(?)");
    args.push(String(filters.date_to).trim());
  }
  if (filters.q && String(filters.q).trim()) {
    const like = `%${String(filters.q).trim()}%`;
    where.push('(p.name LIKE ? OR p.barcode LIKE ?)');
    args.push(like, like);
  }

  const whereSql = where.length ? 'WHERE ' + where.join(' AND ') : '';
  const limit = Math.min(Math.max(1, Math.trunc(Number(filters.limit) || 50)), 500);
  const offset = Math.max(0, Math.trunc(Number(filters.offset) || 0));

  const total = db.getDb().prepare(
    `SELECT COUNT(*) AS c
     FROM inventory_movements m JOIN products p ON p.id = m.product_id
     ${whereSql}`
  ).get(...args).c;

  const rows = db.getDb().prepare(
    `SELECT m.*, p.name AS product_name, p.barcode AS product_barcode,
            u.username AS actor_username, u.display_name AS actor_display_name,
            b.name AS branch_name
     FROM inventory_movements m
     JOIN products p ON p.id = m.product_id
     LEFT JOIN users u ON u.id = m.actor_id
     LEFT JOIN branches b ON b.id = m.branch_id
     ${whereSql}
     ORDER BY m.id DESC LIMIT ? OFFSET ?`
  ).all(...args, limit, offset);

  return { rows, total, limit, offset };
}

/* ---------------- Cost history ---------------- */

function costHistory({ product_id, branch_id, limit = 100 } = {}) {
  const where = [];
  const args = [];
  if (product_id != null && product_id !== '') {
    where.push('ch.product_id = ?');
    args.push(intVal(product_id, 'المنتج غير صالح'));
  }
  if (branch_id != null && branch_id !== '') {
    where.push('ch.branch_id = ?');
    args.push(intVal(branch_id, 'الفرع غير صالح'));
  }
  const lim = Math.min(Math.max(1, Math.trunc(Number(limit) || 100)), 500);
  return db.getDb().prepare(
    `SELECT ch.*, p.name AS product_name, b.name AS branch_name,
            g.ref AS grn_ref, s.name AS supplier_name, u.username AS actor_username
     FROM cost_history ch
     JOIN products p ON p.id = ch.product_id
     LEFT JOIN branches b ON b.id = ch.branch_id
     LEFT JOIN grns g ON g.id = ch.grn_id
     LEFT JOIN suppliers s ON s.id = ch.supplier_id
     LEFT JOIN users u ON u.id = ch.actor_id
     ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
     ORDER BY ch.id DESC LIMIT ?`
  ).all(...args, lim);
}

module.exports = {
  ADJUST_REASONS,
  adjustStock,
  openReconciliation,
  confirmReconciliation,
  cancelReconciliation,
  listReconciliations,
  setReorderRules,
  valuation,
  overview,
  listMovementsPaged,
  costHistory
};
