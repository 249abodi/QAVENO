'use strict';

/*
 * Authentication, sessions, RBAC and audit logging.
 *
 * Security model:
 *  - Passwords: scrypt (N=16384, r=8, p=1), 16-byte salt, 64-byte key,
 *    stored as "scrypt$N$r$p$saltB64$hashB64". Verified with timingSafeEqual.
 *  - Sessions: 32-byte random token; only SHA-256(token) is persisted.
 *    Token itself lives only in the main process memory and is handed to a
 *    window's webContents binding — never persisted client-side.
 *  - Authorization: permission matrix per role; checks happen ONLY here /
 *    in ipc.js (backend authoritative). Renderer checks are cosmetic.
 *  - Lockout: 5 consecutive failures -> 5 minute lock per account.
 *  - Audit log is append-only; no update/delete API exists.
 */

const crypto = require('node:crypto');
const db = require('./db');

let ready = false;

/* ---------------- helpers ---------------- */

function nowStr() {
  return new Date().toISOString().slice(0, 19).replace('T', ' ');
}

function sha256(s) {
  return crypto.createHash('sha256').update(s).digest('hex');
}

const SCRYPT_N = 16384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const KEY_LEN = 64;
const SALT_LEN = 16;

function hashPassword(password) {
  const pw = String(password);
  const salt = crypto.randomBytes(SALT_LEN);
  const key = crypto.scryptSync(pw, salt, KEY_LEN, { N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P });
  return `scrypt$${SCRYPT_N}$${SCRYPT_R}$${SCRYPT_P}$${salt.toString('base64')}$${key.toString('base64')}`;
}

function verifyPassword(stored, password) {
  try {
    const parts = String(stored).split('$');
    if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
    const N = parseInt(parts[1], 10);
    const r = parseInt(parts[2], 10);
    const p = parseInt(parts[3], 10);
    const salt = Buffer.from(parts[4], 'base64');
    const expected = Buffer.from(parts[5], 'base64');
    const actual = crypto.scryptSync(String(password), salt, expected.length, { N, r, p });
    return crypto.timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}

/* ---------------- RBAC policy ---------------- */

const PERMISSIONS = [
  'pos.access',
  'admin.access',
  'products.read',
  'products.create',
  'products.update',
  'products.delete',
  'inventory.read',
  'inventory.adjust',
  'inventory.reconcile',
  'inventory.valuation',
  'inventory.cost.read',
  'inventory.rules.manage',
  'categories.manage',
  'suppliers.read',
  'suppliers.manage',
  'purchases.read',
  'purchases.create',
  'purchases.update',
  'purchases.approve',
  'purchases.receive',
  'purchases.cancel',
  'branches.read',
  'branches.manage',
  'transfers.read',
  'transfers.create',
  'transfers.approve',
  'transfers.dispatch',
  'transfers.receive',
  'transfers.cancel',
  'sales.create',
  'sales.read',
  'sales.refund',
  'reports.read',
  'users.manage',
  'settings.read',
  'settings.prefs',
  'settings.manage',
  'audit.read',
  'ai.read',
  'platform.manage',
  'platform.orgs',
  'platform.licenses',
  'platform.plans',
  'platform.usage',
];

const ROLE_PERMISSIONS = {
  owner: Object.freeze([...PERMISSIONS]),
  admin: Object.freeze([
    'pos.access', 'admin.access',
    'products.read', 'products.create', 'products.update', 'products.delete',
    'inventory.read', 'inventory.adjust',
    'inventory.reconcile', 'inventory.valuation', 'inventory.cost.read', 'inventory.rules.manage',
    'categories.manage',
    'suppliers.read', 'suppliers.manage',
    'purchases.read', 'purchases.create', 'purchases.update',
    'purchases.approve', 'purchases.receive', 'purchases.cancel',
    'branches.read', 'branches.manage',
    'transfers.read', 'transfers.create',
    'transfers.approve', 'transfers.dispatch', 'transfers.receive', 'transfers.cancel',
    'sales.create', 'sales.read', 'sales.refund',
    'reports.read', 'users.manage',
    'settings.read', 'settings.prefs', 'settings.manage',
    'audit.read',
    'ai.read'
  ]),
  manager: Object.freeze([
    'pos.access', 'admin.access',
    'products.read', 'products.create', 'products.update', 'products.delete',
    'inventory.read', 'inventory.adjust',
    'inventory.reconcile', 'inventory.valuation', 'inventory.cost.read', 'inventory.rules.manage',
    'categories.manage',
    'suppliers.read', 'suppliers.manage',
    'purchases.read', 'purchases.create', 'purchases.update', 'purchases.receive',
    'branches.read',
    'transfers.read', 'transfers.create', 'transfers.dispatch', 'transfers.receive',
    'sales.read', 'reports.read',
    'settings.read', 'settings.prefs',
    'ai.read'
  ]),
  cashier: Object.freeze([
    'pos.access',
    'products.read', 'inventory.read',
    'sales.create', 'sales.read',
    'settings.read', 'settings.prefs'
  ])
};

const ROLES = ['owner', 'admin', 'manager', 'cashier'];

function can(user, perm) {
  if (!user || user.status !== 'active') return false;
  const perms = ROLE_PERMISSIONS[user.role];
  return Array.isArray(perms) && perms.includes(perm);
}

function assertCan(user, perm) {
  if (!can(user, perm)) throw new Error('ليس لديك صلاحية لتنفيذ هذا الإجراء');
}

/* ---------------- users ---------------- */

function init() {
  ready = true;
}

function assertReady() {
  if (!ready) throw new Error('خدمة المصادقة غير مهيأة');
}

function countUsers() {
  return db.getDb().prepare('SELECT COUNT(*) AS c FROM users').get().c;
}

function hasUsers() {
  return countUsers() > 0;
}

const USERNAME_RE = /^[a-zA-Z0-9_.-]{3,40}$/;

function validateNewPassword(pw) {
  const s = String(pw || '');
  if (s.length < 8) throw new Error('كلمة المرور يجب أن تكون 8 أحرف على الأقل');
  if (s.length > 200) throw new Error('كلمة المرور طويلة جداً');
  return s;
}

function validateUsername(u) {
  const s = String(u || '').trim();
  if (!USERNAME_RE.test(s)) {
    throw new Error('اسم المستخدم غير صالح (3-40 حرفاً إنجليزياً/أرقام/._- فقط)');
  }
  return s;
}

function validateRole(role) {
  if (!ROLES.includes(role)) throw new Error('الدور غير صالح');
  return role;
}

function getUser(id) {
  return db.getDb().prepare('SELECT * FROM users WHERE id = ?').get(Number(id));
}

function getUserByUsername(username) {
  return db.getDb().prepare('SELECT * FROM users WHERE username = ? COLLATE NOCASE')
    .get(String(username || '').trim());
}

/* Safe public shape — NEVER expose password_hash / failed_attempts / locked_until */
function publicUser(row) {
  if (!row) return null;
  return {
    id: row.id,
    username: row.username,
    display_name: row.display_name,
    role: row.role,
    status: row.status,
    must_change_password: !!row.must_change_password,
    last_login_at: row.last_login_at,
    created_at: row.created_at
  };
}

function permissionsOf(user) {
  return ROLE_PERMISSIONS[user.role] || [];
}

/*
 * Create the first Owner. Only allowed while the users table is empty
 * (first-run setup). Never creates a default password.
 */
function setupOwner({ username, password, display_name }) {
  assertReady();
  if (hasUsers()) throw new Error('تم إنشاء حساب المالك مسبقاً');
  const u = validateUsername(username);
  validateNewPassword(password);
  const ddb = db.getDb();
  const res = ddb.prepare(
    `INSERT INTO users (username, display_name, password_hash, role, status)
     VALUES (?, ?, ?, 'owner', 'active')`
  ).run(u, String(display_name || u).trim(), hashPassword(password));
  const row = getUser(Number(res.lastInsertRowid));
  audit({ action: 'auth.setup_owner', entity_type: 'user', entity_id: row.id });
  return publicUser(row);
}

/*
 * actor: user row performing the action (or null for system).
 * Rules:
 *  - requires users.manage
 *  - admins can never create/modify/delete owners
 */
function assertTargetManageable(actor, targetRow) {
  if (!actor) return; // system context (reserved)
  assertCan(actor, 'users.manage');
  if (actor.role !== 'owner' && targetRow.role === 'owner') {
    throw new Error('لا يمكن تعديل حسابات المالك إلا بواسطة المالك');
  }
}

function createUser(actor, { username, password, display_name, role }) {
  assertReady();
  assertCan(actor, 'users.manage');
  if (role === 'owner' && actor.role !== 'owner') {
    throw new Error('لا يمكن إنشاء حسابات مالك جديدة إلا بواسطة المالك');
  }
  const u = validateUsername(username);
  validateNewPassword(password);
  const r = validateRole(role || 'cashier');
  if (getUserByUsername(u)) throw newErrorDup(u);
  const ddb = db.getDb();
  const res = ddb.prepare(
    `INSERT INTO users (username, display_name, password_hash, role, status)
     VALUES (?, ?, ?, ?, 'active')`
  ).run(u, String(display_name || u).trim(), hashPassword(password), r);
  const newId = Number(res.lastInsertRowid);
  // Every user starts assigned to the default branch (invariant D2: M005 => id 1).
  ddb.prepare(
    'INSERT OR IGNORE INTO user_branches (user_id, branch_id, is_primary) VALUES (?, 1, 1)'
  ).run(newId);
  const row = getUser(newId);
  audit({ actorId: actor.id, action: 'user.create', entity_type: 'user', entity_id: row.id, details: { username: u, role: r } });
  return publicUser(row);
}

function newErrorDup(u) {
  const err = new Error(`اسم المستخدم "${u}" مستخدم بالفعل`);
  err.code = 'DUPLICATE_USERNAME';
  return err;
}

function updateUser(actor, id, patch = {}) {
  assertReady();
  const target = getUser(id);
  if (!target) throw new Error('المستخدم غير موجود');
  assertTargetManageable(actor, target);

  const ddb = db.getDb();
  const sets = [];
  const vals = [];

  if (patch.display_name !== undefined) {
    sets.push('display_name = ?');
    vals.push(String(patch.display_name).trim());
  }
  if (patch.role !== undefined) {
    const r = validateRole(patch.role);
    if (target.role === 'owner' && r !== 'owner') {
      const ownersLeft = ddb.prepare(
        "SELECT COUNT(*) AS c FROM users WHERE role = 'owner' AND status = 'active' AND id != ?"
      ).get(target.id).c;
      if (ownersLeft === 0) throw new Error('يجب أن يبقى مالك نشط واحد على الأقل');
    }
    sets.push('role = ?');
    vals.push(r);
  }
  if (patch.status !== undefined) {
    const st = patch.status === 'disabled' ? 'disabled' : 'active';
    if (target.status === 'active' && st === 'disabled') {
      if (target.role === 'owner') {
        const ownersLeft = ddb.prepare(
          "SELECT COUNT(*) AS c FROM users WHERE role = 'owner' AND status = 'active' AND id != ?"
        ).get(target.id).c;
        if (ownersLeft === 0) throw new Error('لا يمكن تعطيل آخر مالك نشط');
      }
      revokeAllSessions(target.id);
    }
    sets.push('status = ?');
    vals.push(st);
  }

  if (sets.length) {
    sets.push('updated_at = ?');
    vals.push(nowStr(), Number(target.id));
    ddb.prepare(`UPDATE users SET ${sets.join(', ')} WHERE id = ?`).run(...vals);
    audit({ actorId: actor.id, action: 'user.update', entity_type: 'user', entity_id: target.id, details: patch });
  }
  return publicUser(getUser(target.id));
}

function setUserPassword(actor, id, newPassword, currentPassword) {
  assertReady();
  const target = getUser(id);
  if (!target) throw new Error('المستخدم غير موجود');

  let actingSelf = false;
  if (actor && actor.id === target.id) {
    // self-service change: must prove current password
    if (!verifyPassword(target.password_hash, String(currentPassword || ''))) {
      throw new Error('كلمة المرور الحالية غير صحيحة');
    }
    actingSelf = true;
  } else {
    assertTargetManageable(actor, target);
  }
  const hash = hashPassword(validateNewPassword(newPassword));
  const ddb = db.getDb();
  ddb.prepare(
    `UPDATE users SET password_hash = ?, failed_attempts = 0, locked_until = NULL,
     must_change_password = 0, updated_at = ? WHERE id = ?`
  ).run(hash, nowStr(), Number(target.id));
  revokeAllSessions(target.id); // force re-login everywhere
  audit({
    actorId: actor ? actor.id : null,
    action: 'user.password_change',
    entity_type: 'user',
    entity_id: target.id,
    details: { self: actingSelf }
  });
  return publicUser(getUser(target.id));
}

function deleteUser(actor, id) {
  assertReady();
  const target = getUser(id);
  if (!target) throw new Error('المستخدم غير موجود');
  assertTargetManageable(actor, target);
  if (target.role === 'owner') {
    const ownersLeft = db.getDb().prepare(
      "SELECT COUNT(*) AS c FROM users WHERE role = 'owner' AND status = 'active' AND id != ?"
    ).get(target.id).c;
    if (ownersLeft === 0) throw new Error('لا يمكن حذف آخر مالك نشط');
  }
  if (actor && actor.id === target.id) throw new Error('لا يمكن حذف حسابك الحالي');

  db.getDb().prepare('DELETE FROM users WHERE id = ?').run(Number(target.id));
  audit({ actorId: actor.id, action: 'user.delete', entity_type: 'user', entity_id: Number(id), details: { username: target.username } });
  return { ok: true };
}

function listUsers(actor) {
  assertReady();
  assertCan(actor, 'users.manage');
  return db.getDb().prepare(
    `SELECT id, username, display_name, role, status, must_change_password, last_login_at, created_at
     FROM users ORDER BY id ASC`
  ).all().map(publicUser);
}

/* ---------------- authentication & lockout ---------------- */

const MAX_FAILED_ATTEMPTS = 5;
const LOCK_MINUTES = 5;

function lockedNow(row) {
  if (!row.locked_until) return false;
  return new Date(row.locked_until.replace(' ', 'T') + 'Z').getTime() > Date.now();
}

function authenticate(username, password) {
  assertReady();
  const row = getUserByUsername(username);
  if (!row) {
    // constant-ish work whether or not user exists (mitigate enumeration timing)
    verifyPassword(hashPassword('timing-equalizer'), password);
    return { ok: false, reason: 'invalid' };
  }
  if (row.status !== 'active') return { ok: false, reason: 'disabled' };
  if (lockedNow(row)) {
    return { ok: false, reason: 'locked', until: row.locked_until };
  }
  if (!verifyPassword(row.password_hash, String(password || ''))) {
    const attempts = row.failed_attempts + 1;
    const ddb = db.getDb();
    if (attempts >= MAX_FAILED_ATTEMPTS) {
      const until = new Date(Date.now() + LOCK_MINUTES * 60 * 1000)
        .toISOString().slice(0, 19).replace('T', ' ');
      ddb.prepare('UPDATE users SET failed_attempts = ?, locked_until = ? WHERE id = ?')
        .run(attempts, until, row.id);
      audit({ actorId: row.id, action: 'auth.locked', entity_type: 'user', entity_id: row.id, details: { attempts } });
      return { ok: false, reason: 'locked', until };
    }
    ddb.prepare('UPDATE users SET failed_attempts = ? WHERE id = ?').run(attempts, row.id);
    audit({ actorId: row.id, action: 'auth.failed', entity_type: 'user', entity_id: row.id, details: { attempts } });
    return { ok: false, reason: 'invalid' };
  }
  db.getDb().prepare(
    'UPDATE users SET failed_attempts = 0, locked_until = NULL, last_login_at = ? WHERE id = ?'
  ).run(nowStr(), row.id);
  audit({ actorId: row.id, action: 'auth.login', entity_type: 'user', entity_id: row.id });
  return { ok: true, user: publicUser(getUser(row.id)) };
}

/* ---------------- sessions ---------------- */

const SESSION_HOURS = 12;

// webContents.id -> { userId, sessionId, expiresAtMs, branchId }
const windowBindings = new Map();

function createSession(userId) {
  const token = crypto.randomBytes(32).toString('base64url');
  const expiresAt = new Date(Date.now() + SESSION_HOURS * 3600 * 1000)
    .toISOString().slice(0, 19).replace('T', ' ');
  db.getDb().prepare(
    'INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)'
  ).run(sha256(token), Number(userId), expiresAt);

  // opportunistic cleanup of expired sessions
  db.getDb().prepare('DELETE FROM sessions WHERE expires_at < ? AND revoked_at IS NULL')
    .run(nowStr());

  return { token, expiresAt };
}

function resolveToken(token) {
  if (!token) return null;
  const row = db.getDb().prepare(
    `SELECT s.*, u.username, u.display_name, u.role, u.status AS user_status, u.must_change_password
     FROM sessions s JOIN users u ON u.id = s.user_id
     WHERE s.token_hash = ?`
  ).get(sha256(String(token)));
  if (!row) return null;
  if (row.revoked_at || row.invalidated_at) return null;
  if (new Date(row.expires_at.replace(' ', 'T') + 'Z').getTime() < Date.now()) return null;
  if (row.user_status !== 'active') return null;
  return {
    session: { id: row.id, user_id: row.user_id, expires_at: row.expires_at },
    user: {
      id: row.user_id,
      username: row.username,
      display_name: row.display_name,
      role: row.role,
      status: row.user_status,
      must_change_password: !!row.must_change_password
    }
  };
}

function revokeSession(token) {
  if (!token) return;
  db.getDb().prepare(
    'UPDATE sessions SET revoked_at = COALESCE(revoked_at, ?) WHERE token_hash = ? AND revoked_at IS NULL'
  ).run(nowStr(), sha256(String(token)));
}

function revokeAllSessions(userId) {
  db.getDb().prepare(
    'UPDATE sessions SET invalidated_at = COALESCE(invalidated_at, ?) WHERE user_id = ? AND revoked_at IS NULL AND invalidated_at IS NULL'
  ).run(nowStr(), Number(userId));
  for (const [wcId, b] of windowBindings.entries()) {
    if (b.userId === Number(userId)) windowBindings.delete(wcId);
  }
}

function bindWindow(webContentsId, token) {
  const resolved = resolveToken(token);
  if (!resolved) throw new Error('جلسة غير صالحة');
  windowBindings.set(Number(webContentsId), {
    userId: resolved.user.id,
    sessionId: resolved.session.id,
    expiresAtMs: new Date(resolved.session.expires_at.replace(' ', 'T') + 'Z').getTime(),
    branchId: null
  });
  return resolved.user;
}

function unbindWindow(webContentsId) {
  windowBindings.delete(Number(webContentsId));
}

function unbindAllForSession(sessionId) {
  for (const [wcId, b] of windowBindings.entries()) {
    if (b.sessionId === Number(sessionId)) windowBindings.delete(wcId);
  }
}

/* Copy a live session binding onto another webContents
   (used when opening the admin window from an authenticated window). */
function copyBinding(fromWebContentsId, toWebContentsId) {
  const b = windowBindings.get(Number(fromWebContentsId));
  if (!b || Date.now() > b.expiresAtMs) throw new Error('جلسة غير صالحة');
  windowBindings.set(Number(toWebContentsId), { ...b });
}

function getSessionIdFor(webContentsId) {
  const b = windowBindings.get(Number(webContentsId));
  if (!b || Date.now() > b.expiresAtMs) return null;
  return b.sessionId;
}

function revokeSessionById(sessionId) {
  db.getDb().prepare(
    'UPDATE sessions SET revoked_at = COALESCE(revoked_at, ?) WHERE id = ? AND revoked_at IS NULL'
  ).run(nowStr(), Number(sessionId));
  unbindAllForSession(Number(sessionId));
}

/* Resolve the authenticated user for an incoming IPC event.
   Returns null when unknown/expired — callers fail closed. */
function userForWebContents(webContentsId) {
  const b = windowBindings.get(Number(webContentsId));
  if (!b) return null;
  if (Date.now() > b.expiresAtMs) {
    windowBindings.delete(Number(webContentsId));
    return null;
  }
  const resolved = db.getDb().prepare(
    `SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id
     WHERE s.id = ? AND s.revoked_at IS NULL AND s.invalidated_at IS NULL`
  ).get(b.sessionId);
  if (!resolved || resolved.status !== 'active') {
    windowBindings.delete(Number(webContentsId));
    return null;
  }
  return resolved;
}

/* ---------------- audit ---------------- */

function audit({ actorId = null, action, entity_type = null, entity_id = null, details = null }) {
  try {
    db.getDb().prepare(
      'INSERT INTO audit_log (actor_id, action, entity_type, entity_id, details) VALUES (?, ?, ?, ?, ?)'
    ).run(actorId, String(action), entity_type, entity_id,
      details ? JSON.stringify(details) : null);
  } catch {
    /* auditing must never crash business flow */
  }
}

function listAudit(actor, limit = 200) {
  assertReady();
  assertCan(actor, 'audit.read');
  return db.getDb().prepare(
    `SELECT a.id, a.action, a.entity_type, a.entity_id, a.details, a.created_at,
            u.username AS actor_username
     FROM audit_log a LEFT JOIN users u ON u.id = a.actor_id
     ORDER BY a.id DESC LIMIT ?`
  ).all(Math.min(Math.max(1, Math.trunc(Number(limit) || 200)), 1000));
}

/* Server-side current-branch context on the window binding.
   Never supplied by the renderer; switched only through a validated IPC call.
   Falls back to the user's primary assignment when null (e.g. after restart). */
function setCurrentBranch(webContentsId, branchId) {
  const b = windowBindings.get(Number(webContentsId));
  if (!b) throw new Error('جلسة غير صالحة');
  b.branchId = branchId == null ? null : Number(branchId);
}

function getCurrentBranchId(webContentsId) {
  const b = windowBindings.get(Number(webContentsId));
  if (!b || Date.now() > b.expiresAtMs) return null;
  return b.branchId;
}

module.exports = {
  init,
  ROLES,
  PERMISSIONS,
  ROLE_PERMISSIONS,
  can,
  assertCan,
  hashPassword,
  verifyPassword,
  hasUsers,
  countUsers,
  setupOwner,
  createUser,
  updateUser,
  setUserPassword,
  deleteUser,
  listUsers,
  getUser,
  getUserByUsername,
  publicUser,
  permissionsOf,
  authenticate,
  createSession,
  resolveToken,
  revokeSession,
  revokeAllSessions,
  bindWindow,
  unbindWindow,
  unbindAllForSession,
  copyBinding,
  getSessionIdFor,
  revokeSessionById,
  userForWebContents,
  setCurrentBranch,
  getCurrentBranchId,
  audit,
  listAudit
};
