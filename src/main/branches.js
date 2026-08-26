'use strict';

/*
 * Branch service (Phase 24).
 *
 * Architecture decisions (documented for the whole phase):
 *  D1  branch_inventory is the authoritative per-branch store for
 *      quantity/cost/low_stock_threshold/reorder_qty. Legacy products.*
 *      columns remain as a maintained DEFAULT-BRANCH mirror for backward
 *      compatibility with existing UI/tests; deprecated for future work.
 *  D2  The default branch is guaranteed branches.id = 1: M005 inserts it
 *      first and nothing ever deletes branches (only disable).
 *  D3  Pre-M005 history is factually mapped to the default branch (the
 *      single physical store that became MAIN) — compat migration, not
 *      fabricated history.
 *  D4  owner/admin span all branches implicitly; manager/cashier are
 *      restricted to their user_branches assignments (active branches only).
 *  D5  Current-branch context lives server-side on the window binding;
 *      switchable only through an authorized IPC call, never client-trusted.
 *  D6  Transfers carry source-branch WAC captured at dispatch; destination
 *      blends WAC with the standard weighted-average formula.
 */

const db = require('./db');
const auth = require('./auth');

// Invariant established by M005 (default branch inserted first).
const DEFAULT_BRANCH_ID = 1;

function nowStr() {
  return new Date().toISOString().slice(0, 19).replace('T', ' ');
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

function strictInt(v, name, { min = 0 } = {}) {
  const n = Number(v);
  if (!Number.isInteger(n) || n < min) {
    const e = new Error(`قيمة غير صالحة: ${name}`);
    e.code = 'INVALID_INPUT';
    throw e;
  }
  return n;
}

function cleanStr(v, max = 200) {
  return String(v == null ? '' : v).trim().slice(0, max);
}

/* ---------------- reads ---------------- */

function getBranch(id) {
  return db.getDb().prepare('SELECT * FROM branches WHERE id = ?').get(strictInt(id, 'id'));
}

function branchStats(bid) {
  const d = db.getDb();
  const users = d.prepare(
    'SELECT COUNT(*) AS c FROM user_branches WHERE branch_id = ?'
  ).get(bid).c;
  const inv = d.prepare(
    `SELECT COUNT(*) AS products, COALESCE(SUM(quantity),0) AS qty,
            COALESCE(SUM(quantity * cost),0) AS value
     FROM branch_inventory WHERE branch_id = ?`
  ).get(bid);
  return { users_count: users, products_count: inv.products, stock_qty: inv.qty, stock_value: inv.value };
}

function listBranches({ includeDisabled = true } = {}) {
  const rows = db.getDb().prepare(
    includeDisabled
      ? 'SELECT * FROM branches ORDER BY id'
      : "SELECT * FROM branches WHERE status = 'active' ORDER BY id"
  ).all();
  return rows.map(r => ({ ...r, stats: branchStats(r.id) }));
}

function accessibleBranchIds(user) {
  if (!user || user.status !== 'active') return [];
  if (user.role === 'owner' || user.role === 'admin') {
    return db.getDb().prepare("SELECT id FROM branches").all().map(r => r.id);
  }
  return db.getDb().prepare(
    `SELECT ub.branch_id AS id FROM user_branches ub
     JOIN branches b ON b.id = ub.branch_id
     WHERE ub.user_id = ? AND b.status = 'active'
     ORDER BY b.id`
  ).all(Number(user.id)).map(r => r.id);
}

function canAccessBranch(user, branchId) {
  if (!user || user.status !== 'active') return false;
  const bid = strictInt(branchId, 'branch_id');
  const br = getBranch(bid);
  if (!br) return false;
  if (br.status !== 'active') {
    // Even spanning roles cannot operate on a disabled branch.
    return false;
  }
  if (user.role === 'owner' || user.role === 'admin') return true;
  const row = db.getDb().prepare(
    `SELECT 1 FROM user_branches ub JOIN branches b ON b.id = ub.branch_id
     WHERE ub.user_id = ? AND ub.branch_id = ? AND b.status = 'active'`
  ).get(Number(user.id), bid);
  return !!row;
}

function assertBranchAccess(user, branchId) {
  if (!canAccessBranch(user, branchId)) {
    const e = new Error('ليس لديك صلاحية على هذا الفرع');
    e.code = 'NO_BRANCH_ACCESS';
    throw e;
  }
}

function getUserBranches(userId) {
  return db.getDb().prepare(
    `SELECT b.*, ub.is_primary FROM user_branches ub
     JOIN branches b ON b.id = ub.branch_id
     WHERE ub.user_id = ? ORDER BY ub.is_primary DESC, b.id`
  ).all(strictInt(userId, 'user_id'));
}

function getPrimaryBranchId(userId) {
  const row = db.getDb().prepare(
    `SELECT branch_id FROM user_branches WHERE user_id = ?
     ORDER BY is_primary DESC, branch_id LIMIT 1`
  ).get(strictInt(userId, 'user_id'));
  return row ? row.branch_id : null;
}

/* Resolve the effective branch for a mutation/list:
   explicit (validated upstream) -> session context -> primary -> default. */
function resolveBranchId(user, requestedBranchId, sessionBranchId) {
  let bid = null;
  if (requestedBranchId != null) bid = strictInt(requestedBranchId, 'branch_id');
  else if (sessionBranchId != null) bid = strictInt(sessionBranchId, 'branch_id');
  else bid = user ? getPrimaryBranchId(user.id) : null;
  if (bid == null) bid = DEFAULT_BRANCH_ID;
  if (user) assertBranchAccess(user, bid);
  else if (!getBranch(bid)) {
    const e = new Error('الفرع غير موجود');
    e.code = 'BRANCH_NOT_FOUND';
    throw e;
  }
  return bid;
}

/* ---------------- mutations ---------------- */

function createBranch(actorId, payload = {}) {
  const name = cleanStr(payload.name, 120);
  if (!name) {
    const e = new Error('اسم الفرع مطلوب');
    e.code = 'INVALID_INPUT';
    throw e;
  }
  const code = cleanStr(payload.code, 24) || null;
  const address = cleanStr(payload.address, 300);
  const phone = cleanStr(payload.phone, 40);

  const id = withTx(() => {
    const d = db.getDb();
    if (code) {
      const dup = d.prepare('SELECT id FROM branches WHERE code = ?').get(code);
      if (dup) {
        const e = new Error('رمز الفرع مستخدم مسبقاً');
        e.code = 'DUPLICATE_CODE';
        throw e;
      }
    }
    const info = d.prepare(
      'INSERT INTO branches (name, code, address, phone) VALUES (?, ?, ?, ?)'
    ).run(name, code, address, phone);
    return info.lastInsertRowid;
  });

  auth.audit({
    actorId, action: 'branch.create', entity_type: 'branch', entity_id: Number(id),
    details: JSON.stringify({ name, code })
  });
  return getBranch(id);
}

function updateBranch(actorId, id, patch = {}) {
  const cur = getBranch(id);
  if (!cur) {
    const e = new Error('الفرع غير موجود');
    e.code = 'BRANCH_NOT_FOUND';
    throw e;
  }
  const name = patch.name !== undefined ? cleanStr(patch.name, 120) : cur.name;
  if (!name) {
    const e = new Error('اسم الفرع مطلوب');
    e.code = 'INVALID_INPUT';
    throw e;
  }
  const code = patch.code !== undefined ? (cleanStr(patch.code, 24) || null) : cur.code;
  const address = patch.address !== undefined ? cleanStr(patch.address, 300) : cur.address;
  const phone = patch.phone !== undefined ? cleanStr(patch.phone, 40) : cur.phone;

  withTx(() => {
    const d = db.getDb();
    if (code && code !== cur.code) {
      const dup = d.prepare('SELECT id FROM branches WHERE code = ? AND id != ?').get(code, cur.id);
      if (dup) {
        const e = new Error('رمز الفرع مستخدم مسبقاً');
        e.code = 'DUPLICATE_CODE';
        throw e;
      }
    }
    d.prepare(
      `UPDATE branches SET name = ?, code = ?, address = ?, phone = ?, updated_at = ?
       WHERE id = ?`
    ).run(name, code, address, phone, nowStr(), cur.id);
  });

  auth.audit({
    actorId, action: 'branch.update', entity_type: 'branch', entity_id: cur.id,
    details: JSON.stringify({ name, code })
  });
  return getBranch(cur.id);
}

function setBranchStatus(actorId, id, status) {
  const cur = getBranch(id);
  if (!cur) {
    const e = new Error('الفرع غير موجود');
    e.code = 'BRANCH_NOT_FOUND';
    throw e;
  }
  if (status !== 'active' && status !== 'disabled') {
    const e = new Error('حالة غير صالحة');
    e.code = 'INVALID_INPUT';
    throw e;
  }
  if (status === 'disabled') {
    if (cur.id === DEFAULT_BRANCH_ID) {
      const e = new Error('لا يمكن تعطيل الفرع الافتراضي');
      e.code = 'DEFAULT_BRANCH';
      throw e;
    }
    const open = db.getDb().prepare(
      "SELECT COUNT(*) AS c FROM stock_reconciliations WHERE branch_id = ? AND status = 'open'"
    ).get(cur.id).c;
    if (open > 0) {
      const e = new Error('توجد جلسات جرد مفتوحة في هذا الفرع');
      e.code = 'OPEN_RECONCILIATIONS';
      throw e;
    }
  }

  withTx(() => {
    db.getDb().prepare('UPDATE branches SET status = ?, updated_at = ? WHERE id = ?')
      .run(status, nowStr(), cur.id);
  });
  auth.audit({
    actorId, action: 'branch.status', entity_type: 'branch', entity_id: cur.id,
    details: JSON.stringify({ status })
  });
  return getBranch(cur.id);
}

/* Ensure exactly one primary per user; when is_primary is set,
   demote the previous primary atomically. */
function assignUserBranch(actorId, userId, branchId, isPrimary) {
  const uid = strictInt(userId, 'user_id');
  const bid = strictInt(branchId, 'branch_id');
  if (!auth.getUser(uid)) {
    const e = new Error('المستخدم غير موجود');
    e.code = 'USER_NOT_FOUND';
    throw e;
  }
  if (!getBranch(bid)) {
    const e = new Error('الفرع غير موجود');
    e.code = 'BRANCH_NOT_FOUND';
    throw e;
  }

  withTx(() => {
    const d = db.getDb();
    if (isPrimary) {
      d.prepare('UPDATE user_branches SET is_primary = 0 WHERE user_id = ?').run(uid);
    }
    d.prepare(`
      INSERT INTO user_branches (user_id, branch_id, is_primary) VALUES (?, ?, ?)
      ON CONFLICT(user_id, branch_id) DO UPDATE SET is_primary = excluded.is_primary
    `).run(uid, bid, isPrimary ? 1 : 0);
    // Guarantee at least one primary: promote lowest branch id if none.
    const any = d.prepare(
      'SELECT COUNT(*) AS c FROM user_branches WHERE user_id = ? AND is_primary = 1'
    ).get(uid).c;
    if (!any) {
      d.prepare(`
        UPDATE user_branches SET is_primary = 1
        WHERE user_id = ? AND branch_id = (
          SELECT MIN(branch_id) FROM user_branches WHERE user_id = ?
        )
      `).run(uid, uid);
    }
  });

  auth.audit({
    actorId, action: 'user.branch.assign', entity_type: 'user', entity_id: uid,
    details: JSON.stringify({ branch_id: bid, is_primary: !!isPrimary })
  });
  return getUserBranches(uid);
}

function removeUserBranch(actorId, userId, branchId) {
  const uid = strictInt(userId, 'user_id');
  const bid = strictInt(branchId, 'branch_id');
  const rows = getUserBranches(uid);
  if (!rows.some(r => r.id === bid)) {
    const e = new Error('هذا الإسناد غير موجود');
    e.code = 'ASSIGNMENT_NOT_FOUND';
    throw e;
  }
  if (rows.length <= 1) {
    const e = new Error('يجب أن يبقى للمستخدم فرع واحد على الأقل');
    e.code = 'LAST_BRANCH';
    throw e;
  }

  withTx(() => {
    const d = db.getDb();
    const wasPrimary = rows.find(r => r.id === bid).is_primary;
    d.prepare('DELETE FROM user_branches WHERE user_id = ? AND branch_id = ?').run(uid, bid);
    if (wasPrimary) {
      d.prepare(`
        UPDATE user_branches SET is_primary = 1
        WHERE user_id = ? AND branch_id = (
          SELECT MIN(branch_id) FROM user_branches WHERE user_id = ?
        )
      `).run(uid, uid);
    }
  });

  auth.audit({
    actorId, action: 'user.branch.remove', entity_type: 'user', entity_id: uid,
    details: JSON.stringify({ branch_id: bid })
  });
  return getUserBranches(uid);
}

module.exports = {
  DEFAULT_BRANCH_ID,
  getBranch,
  listBranches,
  branchStats,
  accessibleBranchIds,
  canAccessBranch,
  assertBranchAccess,
  getUserBranches,
  getPrimaryBranchId,
  resolveBranchId,
  createBranch,
  updateBranch,
  setBranchStatus,
  assignUserBranch,
  removeUserBranch
};
