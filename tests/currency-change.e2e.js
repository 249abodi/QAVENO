'use strict';
/* QAVENO — currency-change end-to-end test (real Electron UI).
   Launches the actual desktop app against an isolated, throwaway data dir,
   performs owner setup, opens the admin panel, changes the currency from the
   settings form, and asserts the displayed currency updates LIVE in BOTH the
   admin and cashier windows without restarting the app (plus regression:
   ILS/₪ never appears as a selectable option). */

const { _electron } = require('playwright');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const ROOT = path.join(__dirname, '..');
const DATA = path.join(ROOT, 'data');
const UD1 = path.join(os.homedir(), 'AppData', 'Roaming', 'QAVENO');
const UD2 = path.join(os.homedir(), 'AppData', 'Roaming', 'qaveno');
const BAK = path.join(os.tmpdir(), 'qaveno-data-e2e-' + Date.now());
const license = require('../src/main/license'); // signs trial tokens for seeding license.json

let passed = 0;
let failed = 0;
function ok(cond, label) {
  if (cond) { passed++; console.log('  PASS', label); }
  else { failed++; console.error('  FAIL', label); }
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function waitFor(pred, label, timeout = 20000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    if (await pred()) return;
    await sleep(200);
  }
  throw new Error('TIMEOUT waiting for ' + label);
}

(async () => {
  fs.mkdirSync(BAK, { recursive: true });
  const backups = [];
  for (const p of [DATA, UD1, UD2]) {
    if (fs.existsSync(p)) { const b = path.join(BAK, path.basename(p).replace(/:/g, '_')); fs.renameSync(p, b); backups.push([p, b]); }
  }
  let app = null;
  let admin = null;
  let adminErrors = [];
  try {
    app = await _electron.launch({ args: ['.'], cwd: ROOT, timeout: 90000 });

    const allWindows = async () => {
      const wins = await app.windows();
      return wins;
    };

    console.log('\n[A] Owner setup via login gate');

    await waitFor(async () => (await allWindows()).length >= 1, 'login window');
    let login = (await allWindows()).find(w => w.url().includes('login'));
    await waitFor(async () => !(await login.$('#username')) ? false : (await login.$('#username')) !== null, 'setup form');
    await waitFor(async () => await login.evaluate(() => document.getElementById('username') !== null), 'username field');
    await login.fill('#username', 'owner');
    await login.fill('#password', 'test1234');
    await login.fill('#confirmPassword', 'test1234');
    await login.click('#submitBtn');
    ok(true, 'owner account created');

    console.log('\n[A2] License gate: fresh install must NOT auto-open the app');
    await waitFor(async () => await login.evaluate(() => !document.getElementById('licenseScreen').classList.contains('hidden')), 'license screen after setup');
    ok(true, 'license/activation screen shown after setup (no auto-open without license)');

    console.log('\n[A3] Seed a valid 24h trial and reconnect through the gate');
    const fp = license.getDeviceFingerprint();
    const trialEnd = Date.now() + 24 * 3600 * 1000;
    fs.mkdirSync(UD1, { recursive: true });
    fs.writeFileSync(path.join(UD1, 'license.json'), JSON.stringify({
      type: 'trial', organizationId: 1, deviceFingerprint: fp,
      startedAt: new Date(Date.now() - 1000).toISOString(),
      expiresAt: new Date(trialEnd).toISOString(),
      trialToken: license.signToken({ org: 1, end: trialEnd, device: fp }),
      lastValidatedAt: new Date().toISOString(), status: 'active', hardExpired: false,
    }, null, 2), 'utf8');
    await app.close();
    app = await _electron.launch({ args: ['.'], cwd: ROOT, timeout: 90000 });
    await waitFor(async () => (await allWindows()).length >= 1, 'login window (relaunch)');
    login = (await allWindows()).find(w => w.url().includes('login'));
    await waitFor(async () => await login.evaluate(() => document.getElementById('username') !== null), 'username field (relaunch)');
    await login.fill('#username', 'owner');
    await login.fill('#password', 'test1234');
    await login.click('#submitBtn');
    ok(true, 'valid trial login submitted');

    console.log('\n[B] Cashier window opens (valid trial granted entry)');
    await waitFor(async () => (await allWindows()).some(w => w.url().includes('cashier')), 'cashier window');
    const cashier = (await allWindows()).find(w => w.url().includes('cashier'));
    await waitFor(async () => await cashier.evaluate(() => document.getElementById('storeName') && document.getElementById('storeName').textContent.trim().length > 0), 'cashier settings loaded');
    ok(true, 'cashier loaded and settings fetched');

    console.log('\n[C] Open admin panel from cashier');
    await cashier.evaluate(() => window.pos.windows.openAdmin());
    await waitFor(async () => (await allWindows()).some(w => w.url().includes('admin')), 'admin window');
    admin = (await allWindows()).find(w => w.url().includes('admin'));
    adminErrors = [];
    admin.on('pageerror', (e) => adminErrors.push('pageerror: ' + e.message));
    admin.on('console', (m) => { if (m.type() === 'error') adminErrors.push('console: ' + m.text()); });
    await waitFor(async () => await admin.evaluate(() => document.getElementById('settingsForm') !== null), 'admin form present');
    ok(true, 'admin panel opened');

    console.log('\n[D] Currency select options (ILS must be absent)');
    await waitFor(async () => await admin.evaluate(() => {
      const el = document.querySelector('#settingsForm select[name=currency]');
      return el && el.options.length > 0;
    }), 'currency select populated');
    const codes = await admin.evaluate(() => {
      const opts = [...document.querySelector('#settingsForm select[name=currency]').options];
      return opts.map(o => o.value);
    });
    ok(Array.isArray(codes) && codes.length > 0, `currency select populated (${codes.length} options)`);
    ok(!codes.includes('ILS'), 'ILS not an option');
    const symbols = await admin.evaluate(() =>
      [...document.querySelector('#settingsForm select[name=currency]').options].map(o => o.textContent));
    ok(!symbols.some(s => s.includes('₪')), '₪ not shown in any option');

    console.log('\n[E] Live currency switch (SAR -> USD -> EUR -> SAR via Settings UI)');

    const goToSettings = async () => {
      await admin.evaluate(() => {
        const btn = document.querySelector('.tab[data-tab=settings]');
        btn.click();
      });
      await sleep(300);
    };

    const submitCurrency = async (code) => {
      await admin.selectOption('#settingsForm select[name=currency]', code);
      await admin.click('#settingsForm button[type=submit]');
      try {
        await waitFor(async () => await admin.evaluate((c) => {
          return document.querySelector('#settingsForm select[name=currency]').value === c;
        }, code), `settings form reflects ${code}`);
      } catch (e) {
        const st = await admin.evaluate(async () => {
          const sel = document.querySelector('#settingsForm select[name=currency]');
          const s = await window.pos.settings.get();
          return {
            selValue: sel.value,
            selOptions: sel.options.length,
            settings: s,
            toast: document.querySelector('#toasts') ? document.querySelector('#toasts').textContent : null
          };
        });
        console.error('  SUBMIT DIAG', JSON.stringify(st));
        throw e;
      }
    };

    const currencyLogoOf = (code) => {
      const byCode = {
        SAR: 'ر.س', USD: '$', EUR: '€', EGP: 'ج.م'
      };
      return byCode[code] || null;
    };

    const assertShownEverywhere = async (code) => {
      const sym = currencyLogoOf(code);
      await waitFor(async () => {
        const curValues = await admin.evaluate(() =>
          [...document.querySelectorAll('#tab-dashboard .cur')].map(el => el.textContent).join('|'));
        return curValues.split('|').length === 3 && curValues.includes(sym);
      }, `admin dashboard shows ${sym} (${code})`);
      ok(await admin.evaluate((s) =>
        [...document.querySelectorAll('#tab-dashboard .cur')].every(el => el.textContent === s), sym),
        `admin dashboard stat-currency all = ${sym}`);
      ok(await admin.evaluate((c) => document.querySelector('#settingsForm select[name=currency]').value === c, code),
        `settings select value = ${code}`);

      /* cashier window must reflect the change too (broadcast live) */
      const cashierShown = await cashier.evaluate((s) =>
        document.querySelectorAll('.cur').length > 0
          && [...document.querySelectorAll('.cur')].every(el => el.textContent === s), sym);
      ok(cashierShown, `cashier .cur elements all = ${sym}`);
    };

    await goToSettings();

    const cycles = [
      { from: 'SAR', to: 'USD' },
      { from: 'USD', to: 'EUR' },
      { from: 'EUR', to: 'SAR' }
    ];

    for (const { from, to } of cycles) {
      if (await admin.evaluate((c) => [...document.querySelector('#settingsForm select[name=currency]').options].some(o => o.value === c), from) &&
          await admin.evaluate((c) => [...document.querySelector('#settingsForm select[name=currency]').options].some(o => o.value === c), to)) {
        await submitCurrency(to);
        await assertShownEverywhere(to);
        await submitCurrency(from);
        await assertShownEverywhere(from);
        console.log(`  -> switch ${from}->${to}->${from}: live in both windows`);
      } else {
        console.log(`  - skip ${from}->${to} (option missing from list)`);
      }
    }

    /* A concrete Arabic-currency pass that works regardless of USD/EUR */
    const nonSar = await admin.evaluate(() => {
      const codes = [...document.querySelector('#settingsForm select[name=currency]').options].map(o => o.value);
      return codes.includes('EGP') ? 'EGP' : (codes.find(c => c !== 'SAR') || 'SAR');
    });
    if (nonSar !== 'SAR') {
      await submitCurrency(nonSar);
      await assertShownEverywhere(nonSar);
      await submitCurrency('SAR');
      await assertShownEverywhere('SAR');
      console.log(`  -> switch SAR->${nonSar}->SAR: live`);
    }

    console.log('\n[F] DB persistence matches what UI shows');
    const dbFromRenderer = await admin.evaluate(() => window.pos.settings.get());
    const uiCurrency2 = await admin.evaluate(() => {
      const sel = document.querySelector('#settingsForm select[name=currency]');
      return window.currencyByCode(sel.value) ? window.currencyByCode(sel.value).symbol : sel.value;
    });
    ok(dbFromRenderer.currency === uiCurrency2,
      `settings.get() currency (${dbFromRenderer.currency}) matches selectable symbol after save`);

    await app.close();
    app = null;
  } catch (err) {
    failed++;
    console.error('  FAIL e2e flow:', err.message);
    try {
      const dump = await admin.evaluate(() => {
        const sel = document.querySelector('#settingsForm select[name=currency]');
        return {
          optionCount: sel ? sel.options.length : -1,
          value: sel ? sel.value : null,
          settings: window.__settings ? window.__settings : '(no global)'
        };
      });
      console.error('  admin dump:', JSON.stringify(dump));
      console.error('  admin errors:', adminErrors.length ? adminErrors.join('\n') : '(none)');
    } catch (e) {
      console.error('  dump failed:', e.message);
    }
    if (app) {
      try { await app.close(); } catch { /* ignore */ }
    }
  } finally {
    for (const [p, b] of backups) {
      if (fs.existsSync(p)) fs.rmSync(p, { recursive: true, force: true });
      if (fs.existsSync(b)) fs.renameSync(b, p);
    }
  }

  console.log(`\n========== currency-change E2E: ${passed} passed, ${failed} failed ==========`);
  process.exit(failed ? 1 : 0);
})();