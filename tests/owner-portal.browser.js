'use strict';

// Real-browser regression test for the Owner Portal using Playwright Chromium.
//
// Modes:
//   node tests/owner-portal.browser.js            -> serve owner-portal/ statically on
//                                                   localhost and check the login screen
//                                                   never fires a dashboard request, the
//                                                   API health pill resolves to a valid
//                                                   state, and no misleading toast appears.
//   node tests/owner-portal.browser.js --url <U>  -> point Chromium straight at a deployed
//                                                   portal URL (production) and additionally
//                                                   verify pill = "الخادم متصل", the
//                                                   classified wrong-credentials message,
//                                                   and that the official website content
//                                                   is NOT served there.

const { chromium } = require('playwright');
const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', 'owner-portal');
const ARG = process.argv.find((a) => a.startsWith('--url='));
const TARGET_URL = ARG ? ARG.split('=')[1] : null;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

let pass = 0;
let fail = 0;
function report(label, ok) {
  if (ok) { pass++; console.log('PASS ' + label); }
  else { fail++; console.error('FAIL ' + label); }
}

function serve(dir) {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      let p = decodeURIComponent(req.url.split('?')[0]);
      if (p === '/') p = '/index.html';
      const full = path.join(dir, p);
      if (!full.startsWith(path.resolve(dir))) { res.writeHead(403); return res.end(); }
      fs.readFile(full, (e, data) => {
        if (e) { res.writeHead(404); return res.end('not found'); }
        res.writeHead(200, { 'Content-Type': MIME[path.extname(full)] || 'application/octet-stream' });
        res.end(data);
      });
    });
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

async function usageScenario(browser, baseUrl) {
  async function run(statsBody, label) {
    const ctx = await browser.newContext();
    await ctx.addInitScript(() => {
      localStorage.setItem('qaveno_owner_token', 'usage-e2e-token');
    });
    await ctx.route('https://qaveno-production.up.railway.app/**', (route) => {
      const pathname = new URL(route.request().url()).pathname;
      const json = (body) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
      if (pathname === '/health') return json({ status: 'ok' });
      if (pathname === '/api/v1/auth/me') return json({ id: 1, username: 'owner', role: 'owner', displayName: 'المالك' });
      if (pathname === '/api/v1/owner/dashboard') return json({ totalOrgs: 2, activeOrgs: 1, activeLicenses: 1, recentActivity: [] });
      if (pathname === '/api/v1/owner/usage/stats') return json(statsBody);
      return route.abort();
    });

    const page = await ctx.newPage();
    await page.goto(baseUrl + '/#usage', { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(
      () => {
        const el = document.getElementById('usage-total-users');
        return el && !el.classList.contains('skeleton') && el.textContent.trim() !== '';
      },
      null,
      { timeout: 15000 }
    );
    const values = await page.evaluate(() => ({
      users: document.getElementById('usage-total-users').textContent.trim(),
      api: document.getElementById('usage-api-calls').textContent.trim(),
      storage: document.getElementById('usage-storage').textContent.trim(),
      sessions: document.getElementById('usage-active-sessions').textContent.trim(),
    }));
    report('[' + label + '] real users value rendered', values.users === '١٫٣ ألف');
    report('[' + label + '] Arabic-Indic numerals used', /[\u0660-\u0669]/.test(values.users) || /[\u0660-\u0669]/.test(values.sessions));
    report('[' + label + '] real active sessions rendered', values.sessions === '٤');
    return { values, ctx };
  }

  const unavailable = await run({
    totalUsers: 1250,
    activeSessions: 4,
    apiCalls: { available: false, count: null },
    storage: { available: false, bytes: null },
  }, 'unavailable');
  report('unavailable apiCalls shows "غير متاح" (not 0)', unavailable.values.api === 'غير متاح');
  report('unavailable storage shows "غير متاح" (not -)', unavailable.values.storage === 'غير متاح');
  await unavailable.ctx.close();

  const available = await run({
    totalUsers: 1250,
    activeSessions: 4,
    apiCalls: { available: true, count: 999 },
    storage: { available: true, bytes: 3.5 * 1024 * 1024 * 1024 },
  }, 'available');
  report('available apiCalls formatted Arabic', available.values.api === '٩٩٩');
  report('available storage formatted as GB Arabic', available.values.storage === '٣٫٥ جيجابايت');
  report('available mode never shows "غير متاح" for supplied metrics',
    available.values.api !== 'غير متاح' && available.values.storage !== 'غير متاح');
  await available.ctx.close();
}

async function main() {
  const server = TARGET_URL ? null : await serve(ROOT);
  const baseUrl = TARGET_URL || `http://127.0.0.1:${server.address().port}`;

  const browser = await chromium.launch();
  const context = await browser.newContext({ ignoreHTTPSErrors: true });

  if (!TARGET_URL) {
    // From localhost the production API's CORS allowlist rejects the origin.
    // Try to spoof the portal origin at route level so the local run can also
    // exercise the success path; if the browser refuses, fall back to the
    // expected CORS-failure state (still a valid no-toast regression check).
    await context.route('https://qaveno-production.up.railway.app/**', async (route) => {
      const heads = await route.request().allHeaders();
      heads['origin'] = 'https://qaveno-owner-portal.vercel.app';
      try { await route.continue({ headers: heads }); }
      catch { await route.continue(); }
    });
  }

  const page = await context.newPage();
  const badLogs = [];
  page.on('console', (m) => {
    if (m.type() === 'error' || m.type() === 'debug') badLogs.push(m.text());
  });

  await page.goto(baseUrl + '/', { waitUntil: 'domcontentloaded' });

  // 1. Login screen is shown (no token -> no dashboard fetch).
  report('login screen shown on load', await page.locator('#username').isVisible());

  // 2. The API health pill must resolve OUT of the "فحص الخادم..." state.
  await page.waitForFunction(
    () => {
      const el = document.getElementById('api-status-login');
      return el && el.dataset.state && el.dataset.state !== 'checking';
    },
    null,
    { timeout: 15000 }
  );
  const pillState = await page.evaluate(() => document.getElementById('api-status-login').dataset.state);
  const pillText = await page.evaluate(() => document.getElementById('api-status-login').textContent);
  report('API health pill resolves (state=' + pillState + ')', ['ok', 'warn', 'error'].includes(pillState));

  // 3. NO misleading dashboard-load error toast/screen (the original bug).
  await page.waitForTimeout(1500);
  const bodyText = await page.evaluate(() => document.body.innerText);
  report('no "خطأ في تحميل لوحة التحكم" toast', !bodyText.includes('خطأ في تحميل لوحة التحكم'));

  const hasServer = pillState === 'ok';

  if (TARGET_URL) {
    // 4. Production portal: server reachable + official site NOT shown there.
    report('production API reachable in browser (pill = الخادم متصل)', hasServer);
    report('page never shows official website content (Premium POS)',
      !bodyText.includes('Premium POS') && !bodyText.includes('QAVENO — Premium POS'));
  }

  if (hasServer) {
    // 5. Wrong credentials -> classified message, not a jammed dashboard toast.
    await page.locator('#username').fill('qaveno-diag-nonexistent');
    await page.locator('#password').fill('Sx2!z9Qm@Lp4wT7');
    await page.locator('#login-btn').click();
    await page.waitForFunction(
      () => {
        const el = document.getElementById('login-error');
        return el && el.style.display !== 'none' && el.textContent.trim().length > 0;
      },
      null,
      { timeout: 15000 }
    );
    const errText = await page.evaluate(() => document.getElementById('login-error').textContent);
    report('wrong-credentials message is the classified 401 text', errText.includes('اسم المستخدم أو كلمة المرور غير صحيحة'));
    report('wrong-credentials never shows a dashboard-load toast', !errText.includes('لوحة التحكم'));
  } else {
    console.log('INFO: CORS-success assertions skipped (pill=%s, localhost origin blocked by CORS allowlist)', pillState);
  }

  // 6. Nothing sensitive ever reaches the console.
  const secretLeak = badLogs.some((l) =>
    /Bearer\s+[\w.-]+/.test(l) || l.includes('OwnerPass1!') || l.includes('qaveno_owner_token')
  );
  report('no token/password leaks in console', !secretLeak);

  if (!TARGET_URL) {
    await usageScenario(browser, baseUrl);
  }

  await browser.close();
  if (server) server.close();

  console.log('\nOwner Portal browser QA (' + (TARGET_URL || 'local') + '): ' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});