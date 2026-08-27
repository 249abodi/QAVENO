'use strict';

/*
 * Phase 20 tests — Users, Authentication & RBAC.
 * Pure Node: no Electron. Exercises migrations + auth service directly.
 * Existing smoke.js remains the business-logic regression gate.
 */

const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const db = require('../src/main/db');
const auth = require('../src/main/auth');

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

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pos-auth-test-'));
db.init(path.join(tmpDir, 'test.db'));
auth.init();

(async () => {

  console.log('\n[A] Password hashing');
  const h1 = auth.hashPassword('S3cret-Pass!');
  const h2 = auth.hashPassword('S3cret-Pass!');
  assert(h1 !== h2, 'same password yields different hashes (unique salts)');
  assert(h1.startsWith('scrypt$16384$8$1$'), 'scrypt parameters encoded in hash');
  assert(!h1.includes('S3cret'), 'plaintext absent from stored format');
  assert(auth.verifyPassword(h1, 'S3cret-Pass!') === true, 'verify accepts correct password');
  assert(auth.verifyPassword(h1, 'wrong') === false, 'verify rejects wrong password');
  assert(auth.verifyPassword('garbage', 'x') === false, 'malformed stored hash rejected safely');

  console.log('\n[B] Migration idempotency');
  const { run, MIGRATIONS } = require('../src/main/migrations');
  const before = JSON.stringify(db.getDb().prepare('SELECT version FROM schema_migrations ORDER BY version').all());
  run(db.getDb(), '2026-01-01 00:00:00'); // second run must be a no-op
  const after = JSON.stringify(db.getDb().prepare('SELECT version FROM schema_migrations ORDER BY version').all());
  assert(before === after && db.getDb().prepare('SELECT COUNT(*) AS c FROM schema_migrations').get().c === MIGRATIONS.length,
    'migrations run exactly once (one row per migration)');

  console.log('\n[C] First-run owner setup');
  assert(auth.hasUsers() === false, 'fresh DB has no users');
  await expectError(Promise.resolve().then(() =>
    auth.setupOwner({ username: 'ab', password: 'longenough1' })), 'short username rejected');
  await expectError(Promise.resolve().then(() =>
    auth.setupOwner({ username: 'owner', password: 'short' })), 'short password rejected');
  await expectError(Promise.resolve().then(() =>
    auth.setupOwner({ username: 'bad name!', password: 'longenough1' })), 'invalid username characters rejected');
  const owner = auth.setupOwner({ username: 'owner', password: 'OwnerPass1!', display_name: 'المالك' });
  assert(owner.role === 'owner' && owner.status === 'active', 'owner created');
  assert(owner.password_hash === undefined, 'password hash never exposed');
  await expectError(Promise.resolve().then(() =>
    auth.setupOwner({ username: 'owner2', password: 'OwnerPass1!' })), 'second setup call blocked');

  console.log('\n[D] Authentication');
  let bad = auth.authenticate('nobody', 'whatever');
  assert(bad.ok === false && bad.reason === 'invalid', 'unknown user -> invalid (no enumeration leak)');
  bad = auth.authenticate('owner', 'WrongPass9');
  assert(bad.ok === false && bad.reason === 'invalid', 'wrong password rejected');
  const okAuth = auth.authenticate('owner', 'OwnerPass1!');
  assert(okAuth.ok === true && okAuth.user.id === owner.id, 'correct credentials accepted');

  console.log('\n[E] Repeated failures stay allowed (no lockout)');
  for (let i = 0; i < 6; i++) auth.authenticate('owner', 'nope');
  bad = auth.authenticate('owner', 'OwnerPass1!');
  assert(bad.ok === true, 'correct password accepted even after many failures');

  console.log('\n[F] RBAC permission matrix');
  assert(auth.can(okAuth.user, 'users.manage'), 'owner can manage users');
  assert(auth.can(okAuth.user, 'settings.manage'), 'owner manages settings');
  assert(!auth.can(null, 'products.read'), 'unauthenticated user denied');
  const disabledUser = { ...okAuth.user, status: 'disabled' };
  assert(!auth.can(disabledUser, 'products.read'), 'disabled user denied everything');

  console.log('\n[G] User management rules');
  const admin = auth.createUser(okAuth.user, { username: 'admin1', password: 'AdminPass1!', role: 'admin', display_name: 'مدير النظام' });
  assert(admin.role === 'admin', 'admin created by owner');
  const manager = auth.createUser(okAuth.user, { username: 'manager1', password: 'ManagerPass1!', role: 'manager' });
  const cashier = auth.createUser(okAuth.user, { username: 'cashier1', password: 'CashierPass1!', role: 'cashier' });
  assert(cashier.role === 'cashier', 'cashier created');

  await expectError(Promise.resolve().then(() => auth.createUser(manager, { username: 'x1', password: 'Whatever123', role: 'cashier' })),
    'manager cannot create users (no users.manage)');
  await expectError(Promise.resolve().then(() => auth.createUser(admin, { username: 'x2', password: 'Whatever123', role: 'owner' })),
    'admin cannot create owner accounts');
  await expectError(Promise.resolve().then(() => auth.createUser(okAuth.user, { username: 'OWNER', password: 'Whatever123', role: 'cashier' })),
    'duplicate username (case-insensitive) rejected');

  // permission shape per role
  assert(!auth.can(cashier, 'admin.access'), 'cashier cannot access admin panel');
  assert(auth.can(cashier, 'sales.create') && auth.can(cashier, 'products.read'), 'cashier POS permissions present');
  assert(!auth.can(cashier, 'products.delete'), 'cashier cannot delete products');
  assert(auth.can(manager, 'products.create') && auth.can(manager, 'inventory.adjust'), 'manager inventory permissions present');
  assert(!auth.can(manager, 'users.manage'), 'manager cannot manage users');
  assert(auth.can(admin, 'users.manage') && auth.can(admin, 'audit.read'), 'admin has user+audit rights');

  console.log('\n[H] Owner protection rules');
  await expectError(Promise.resolve().then(() => auth.updateUser(admin, owner.id, { role: 'cashier' })),
    'admin cannot demote owner');
  await expectError(Promise.resolve().then(() => auth.updateUser(admin, owner.id, { status: 'disabled' })),
    'admin cannot disable owner');
  await expectError(Promise.resolve().then(() => auth.deleteUser(admin, owner.id)),
    'admin cannot delete owner');
  const owner2 = auth.createUser(okAuth.user, { username: 'owner2', password: 'OwnerPass2!', role: 'owner' });
  auth.updateUser(okAuth.user, okAuth.user.id, { role: 'admin' });
  assert(auth.getUser(owner.id).role === 'admin', 'owner self-demotes once second owner exists');
  await expectError(Promise.resolve().then(() => auth.updateUser({ ...okAuth.user, role: 'admin', id: owner.id }, owner2.id, { status: 'disabled' })),
    'demoted-to-admin account loses power over owners');

  console.log('\n[I] Sessions');
  const sess = auth.createSession(owner.id);
  assert(!!sess.token && sess.token.length >= 40, 'session token issued');
  const resolved = auth.resolveToken(sess.token);
  assert(resolved && resolved.user.id === owner.id, 'token resolves to user');
  assert(auth.resolveToken('forged-token') === null, 'forged token rejected');
  auth.revokeSession(sess.token);
  assert(auth.resolveToken(sess.token) === null, 'revoked token rejected');

  const live = auth.createSession(cashier.id);
  auth.bindWindow(999, live.token);
  assert(auth.userForWebContents(999).id === cashier.id, 'window binding resolves user');
  auth.revokeAllSessions(cashier.id);
  assert(auth.userForWebContents(999) === null, 'revoking all sessions unbinds windows');

  console.log('\n[J] Password change semantics');
  await expectError(Promise.resolve().then(() => auth.setUserPassword(cashier, cashier.id, 'NewCashierPass1')),
    'self change without current password rejected');
  const upd = auth.setUserPassword(cashier, cashier.id, 'NewCashierPass1!', 'CashierPass1!');
  assert(upd.id === cashier.id, 'self change with correct current password works');
  assert(auth.authenticate('cashier1', 'NewCashierPass1!').ok === true, 'new password authenticates');
  await expectError(Promise.resolve().then(() => auth.setUserPassword(manager, cashier.id, 'HackedPass99')),
    'manager cannot reset others passwords (no users.manage)');
  const mgrSess = auth.createSession(manager.id);
  assert(auth.resolveToken(mgrSess.token) !== null, 'manager session live before reset');
  auth.setUserPassword(admin, manager.id, 'ResetPass99!', null);
  assert(auth.resolveToken(mgrSess.token) === null, 'password reset revokes existing sessions');

  console.log('\n[K] Disable & delete guards');
  auth.updateUser(okAuth.user, cashier.id, { status: 'disabled' });
  assert(auth.userForWebContents(999) === null, 'disabled user loses session access');
  assert(auth.authenticate('cashier1', 'NewCashierPass1!').reason === 'disabled', 'disabled user cannot log in');
  auth.updateUser(okAuth.user, cashier.id, { status: 'active' });

  await expectError(Promise.resolve().then(() => auth.deleteUser(admin, admin.id)),
    'user cannot delete own account');
  await expectError(Promise.resolve().then(() => auth.deleteUser(admin, owner2.id)),
    'last active owner cannot be deleted');
  const tmp = auth.createUser(okAuth.user, { username: 'temp1', password: 'TempPass99!', role: 'cashier' });
  assert(auth.deleteUser(okAuth.user, tmp.id).ok === true, 'normal delete works');
  assert(!auth.getUser(tmp.id), 'deleted user gone');

  console.log('\n[L] Audit trail');
  const events = auth.listAudit(okAuth.user, 500);
  const actions = new Set(events.map(e => e.action));
  assert(actions.has('auth.login'), 'login audited');
  assert(actions.has('auth.failed'), 'failed login audited');
  assert(actions.has('user.create'), 'user creation audited');
  assert(actions.has('user.password_change'), 'password change audited');
  assert(actions.has('user.delete'), 'user deletion audited');
  await expectError(Promise.resolve().then(() => auth.listAudit(manager, 10)),
    'manager cannot read audit log');

  console.log('\n[M] Business regression on migrated schema');
  const prods = db.listProducts();
  assert(prods.length === 10, `seed products intact (${prods.length})`);
  const sale = db.checkout({
    items: [{ product_id: prods[0].id, quantity: 1 }],
    paid: 100,
    payment_method: 'cash'
  });
  assert(sale.invoice_no === 'INV-000001' && sale.total > 0, 'checkout works post-migration');
  assert(db.getSale(sale.id).items.length === 1, 'sale items intact');

  db.close();
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* best effort */ }

  console.log(`\n========== ${passed} passed, ${failed} failed ==========`);
  process.exit(failed ? 1 : 0);

})().catch(e => { console.error(e); process.exit(1); });
