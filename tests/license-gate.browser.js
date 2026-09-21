'use strict';

/* QAVENO — License gate UI test (real Electron, real Playwright).
   Drives the ACTUAL login page end-to-end:
       Login UI  ->  window.pos.license.status()  ->  gate  ->  auth.login()
   Unlike tests/license.test.js (which exercises license.js module directly),
   this launches the desktop app against isolated DATA + %APPDATA%\QAVENO and
   verifies each license state decides login access correctly (fail-closed).

   Scenarios:
     A  type none                         -> blocked (license/activation screen)
     B  valid trial                       -> allowed
     C  expired trial (past grace/offline) -> blocked (lock screen)
     D  valid activated                   -> allowed
     E  expired activated                 -> blocked (lock screen)
     F  corrupt/unreadable license state  -> blocked (no fail-open)
     G  expired trial within offline grace -> allowed (offline-compatible)
     H  expired trial past offline grace  -> blocked
   Bypass verifications:
     - deleting pos.db does NOT reset the trial (license.json lives outside the DB)
     - deleting SQLite data does NOT delete license.json
     - restarting the app does NOT bypass the gate
     - wiping DB but keeping license (reinstall-like) honors the kept license
*/

const { _electron } = require('playwright');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const ROOT = path.join(__dirname, '..');
const DATA = path.join(ROOT, 'data');
const UD1 = path.join(os.homedir(), 'AppData', 'Roaming', 'QAVENO');
const UD2 = path.join(os.homedir(), 'AppData', 'Roaming', 'qaveno');
const BAK = path.join(os.tmpdir(), 'qaveno-license-ui-' + Date.now());

const license = require('../src/main/license');

let passed = 0;
let failed = 0;
let skipped = 0;
function ok(cond, label) {
  if (cond) { passed++; console.log('  PASS', label); }
  else { failed++; console.error('  FAIL', label); }
}
function skip(label) { skipped++; console.log('  SKIP', label); }

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const kind = (w) => {
  const u = w.url();
  if (/\/cashier\//.test(u)) return 'cashier';
  if (/\/admin\//.test(u)) return 'admin';
  if (/\/owner\//.test(u)) return 'owner';
  if (/\/login\//.test(u)) return 'login';
  return 'other';
};
const kinds = async (app) => {
  try { return (await app.windows()).map(kind); } catch { return ['(win err)']; }
};

/* ---- helpers for crafting states ---- */

function trialLicense(expiresInMs, lastValidatedAgoMs) {
  const fp = license.getDeviceFingerprint();
  const end = Date.now() + expiresInMs;
  return {
    type: 'trial',
    organizationId: 1,
    deviceFingerprint: fp,
    startedAt: new Date(Date.now() - 60000).toISOString(),
    expiresAt: new Date(end).toISOString(),
    trialToken: license.signToken({ org: 1, end, device: fp }),
    lastValidatedAt: new Date(Date.now() - (lastValidatedAgoMs || 0)).toISOString(),
    status: 'active',
    hardExpired: false,
  };
}

function activatedLicense(expiresInMs) {
  return {
    type: 'activated',
    licenseCode: 'TEST-LIC-0001',
    organizationId: 1,
    plan: 'pro',
    status: 'active',
    expiresAt: new Date(Date.now() + expiresInMs).toISOString(),
    activatedAt: new Date().toISOString(),
    cloudValidated: true,
    lastValidatedAt: new Date().toISOString(),
    deviceFingerprint: license.getDeviceFingerprint(),
  };
}

const writeLicenseFile = (data) => {
  fs.mkdirSync(UD1, { recursive: true });
  fs.writeFileSync(
    path.join(UD1, 'license.json'),
    typeof data === 'string' ? data : JSON.stringify(data, null, 2),
    'utf8'
  );
};

/* ---- app lifecycle helpers ---- */

async function boot() {
  const app = await _electron.launch({ args: ['.'], cwd: ROOT, timeout: 90000 });
  const t0 = Date.now();
  while ((await kinds(app)).length < 1 && Date.now() - t0 < 30000) await sleep(200);
  return app;
}

async function waitLogin(app) {
  const t0 = Date.now();
  while (Date.now() - t0 < 30000) {
    const login = (await app.windows()).find((w) => kind(w) === 'login');
    if (login) {
      try {
        const ready = await login.evaluate(() =>
          !!window.pos && !!window.pos.auth && !!document.getElementById('username')
            && !!document.getElementById('formTitle')
            && document.getElementById('formTitle').textContent.trim().length > 0);
        if (ready) return login;
      } catch { /* window not ready yet */ }
    }
    await sleep(200);
  }
  throw new Error('login window not ready');
}

async function submitLogin(login, user, pass) {
  await login.fill('#username', user);
  await login.fill('#password', pass);
  await login.evaluate(() => document.getElementById('loginForm').requestSubmit());
}

/** Wait until either a cashier opened or the login window showed a terminal
    state (license/lock/error line). Returns a descriptor. */
async function settle(app) {
  const t0 = Date.now();
  while (Date.now() - t0 < 10000) {
    const ks = await kinds(app);
    if (ks.includes('cashier')) return { entered: true, screen: 'cashier', ks };
    const login = (await app.windows()).find((w) => kind(w) === 'login');
    if (login) {
      try {
        const st = await login.evaluate(() => ({
          lic: !document.getElementById('licenseScreen').classList.contains('hidden'),
          lock: !document.getElementById('lockScreen').classList.contains('hidden'),
          err: (document.getElementById('errLine') || {}).textContent || '',
        }));
        if (st.lic || st.lock || st.err) return { entered: false, screen: st.lock ? 'lock' : (st.lic ? 'license' : 'error'), ...st, ks };
      } catch { /* racing window teardown */ }
    }
    await sleep(150);
  }
  return { entered: false, screen: 'timeout', ks: await kinds(app) };
}

(async () => {
  fs.mkdirSync(BAK, { recursive: true });
  const backups = [];
  for (const p of [DATA, UD1, UD2]) {
    if (fs.existsSync(p)) {
      const b = path.join(BAK, path.basename(p).replace(/:/g, '_'));
      fs.renameSync(p, b);
      backups.push([p, b]);
    }
  }

  let app = null;
  try {
    const LOGIN = { user: 'owner', pass: 'test1234' };

    /* ── A (part 1): fresh install — owner setup must NOT auto-open the app ── */
    console.log('\n[A1] Fresh install: setup creates owner, license screen shown (no auto-open)');
    app = await boot();
    let login = await waitLogin(app);
    await login.fill('#username', LOGIN.user);
    await login.fill('#password', LOGIN.pass);
    await login.fill('#confirmPassword', LOGIN.pass);
    await login.click('#submitBtn');
    let s = await settle(app);
    ok(!s.entered, 'cashier did NOT auto-open after setup');
    ok(s.screen === 'license', `license screen shown after setup (screen=${s.screen})`);
    await app.close(); app = null;

    /* ── A (part 2): existing owner + NO license -> blocked ── */
    console.log('\n[A2] Existing user with NO license cannot log in');
    app = await boot();
    login = await waitLogin(app);
    await submitLogin(login, LOGIN.user, LOGIN.pass);
    s = await settle(app);
    ok(!s.entered, 'no-license login is blocked (no cashier)');
    ok(s.screen === 'license', `landed on license/activation screen (screen=${s.screen})`);
    await app.close(); app = null;

    /* ── B: valid trial -> allowed ── */
    console.log('\n[B] Valid active trial can log in');
    writeLicenseFile(trialLicense(24 * 3600 * 1000, 0));
    app = await boot();
    login = await waitLogin(app);
    await submitLogin(login, LOGIN.user, LOGIN.pass);
    s = await settle(app);
    ok(s.entered, 'active trial allowed in (cashier opened)');
    await app.close(); app = null;

    /* ── G: trial locally expired but within 24h offline grace -> allowed (offline) ── */
    console.log('\n[G] Trial past deadline but inside offline grace -> usable offline');
    writeLicenseFile(trialLicense(-3600 * 1000, 0)); // expired locally, validated just now
    app = await boot();
    login = await waitLogin(app);
    await submitLogin(login, LOGIN.user, LOGIN.pass);
    s = await settle(app);
    ok(s.entered, 'within-grace trial allowed (offline-compatible, cashier opened)');
    await app.close(); app = null;

    /* ── C/H: trial expired AND past offline grace (offline) -> blocked ── */
    console.log('\n[C/H] Trial expired and past offline grace -> blocked');
    writeLicenseFile(trialLicense(-3600 * 1000, 30 * 3600 * 1000)); // 30h since last validation
    app = await boot();
    login = await waitLogin(app);
    await submitLogin(login, LOGIN.user, LOGIN.pass);
    s = await settle(app);
    ok(!s.entered, 'expired trial blocked (no cashier)');
    ok(s.screen === 'lock', `lock screen shown (screen=${s.screen})`);
    await app.close(); app = null;

    /* ── D: valid activated license -> allowed ── */
    console.log('\n[D] Valid activated license can log in');
    writeLicenseFile(activatedLicense(30 * 24 * 3600 * 1000));
    app = await boot();
    login = await waitLogin(app);
    await submitLogin(login, LOGIN.user, LOGIN.pass);
    s = await settle(app);
    ok(s.entered, 'active license allowed in (cashier opened)');
    await app.close(); app = null;

    /* ── E: expired activated license -> blocked ── */
    console.log('\n[E] Expired activated license -> blocked');
    writeLicenseFile(activatedLicense(-24 * 3600 * 1000));
    app = await boot();
    login = await waitLogin(app);
    await submitLogin(login, LOGIN.user, LOGIN.pass);
    s = await settle(app);
    ok(!s.entered, 'expired license blocked (no cashier)');
    ok(s.screen === 'lock', `lock screen shown (screen=${s.screen})`);
    await app.close(); app = null;

    /* ── F: corrupt / unreadable license state -> fail-closed (no login) ── */
    console.log('\n[F] Corrupt license state cannot fail-open into the app');
    writeLicenseFile('{ this is not valid json ][');
    app = await boot();
    login = await waitLogin(app);
    await submitLogin(login, LOGIN.user, LOGIN.pass);
    s = await settle(app);
    ok(!s.entered, 'corrupt license state blocked (no cashier)');
    await app.close(); app = null;

    /* ── Bypass 1: deleting pos.db must not reset the trial / delete license.json ── */
    console.log('\n[BYPASS-1] Deleting pos.db does not reset the trial nor delete license.json');
    writeLicenseFile(trialLicense(24 * 3600 * 1000, 0));
    const licPath = path.join(UD1, 'license.json');
    ok(fs.existsSync(licPath), 'license.json exists before DB deletion');
    fs.rmSync(DATA, { recursive: true, force: true }); // simulate wiping the SQLite DB
    app = await boot();
    login = await waitLogin(app); // fresh DB -> setup form appears
    const status = await login.evaluate(() => window.pos.license.status());
    ok(status.type === 'trial' && status.status === 'active',
      `license still active after DB deletion (status=${status.type}/${status.status})`);
    ok(fs.existsSync(licPath), 'license.json still on disk after SQLite wipe');
    await app.close(); app = null;

    /* ── Bypass 2: reinstall-like (DB wiped, license kept) -> continued access ── */
    console.log('\n[BYPASS-2] Reinstall-like boot honors the kept license (no new trial needed)');
    app = await boot();
    login = await waitLogin(app);
    await login.fill('#username', LOGIN.user);
    await login.fill('#password', LOGIN.pass);
    await login.fill('#confirmPassword', LOGIN.pass);
    await login.click('#submitBtn');
    s = await settle(app);
    ok(s.entered, 'kept license honored after DB wipe (cashier opened)');
    await app.close(); app = null;

    /* ── Bypass 3: expired state blocks across restarts (already verified) ── */
    console.log('\n[BYPASS-3] Expired state still blocks on a fresh restart (gate is persistent)');
    writeLicenseFile(activatedLicense(-24 * 3600 * 1000));
    app = await boot();
    login = await waitLogin(app);
    await submitLogin(login, LOGIN.user, LOGIN.pass);
    s = await settle(app);
    ok(!s.entered && s.screen === 'lock', 'expired license still blocks after restart');
    await app.close(); app = null;

  } catch (err) {
    failed++;
    console.error('  FAIL harness:', err.message);
  } finally {
    try {
      if (app) { try { await app.close(); } catch { /* already closed */ } }
      for (const [p, b] of backups) {
        if (fs.existsSync(p)) fs.rmSync(p, { recursive: true, force: true });
        if (fs.existsSync(b)) fs.renameSync(b, p);
      }
      if (fs.existsSync(BAK) && fs.readdirSync(BAK).length === 0) fs.rmdirSync(BAK);
    } catch (e) { console.error('restore issue:', e.message); }
  }

  console.log(`\n========== License gate UI: ${passed} passed, ${failed} failed, ${skipped} skipped ==========`);
  process.exit(failed ? 1 : 0);
})();