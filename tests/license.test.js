'use strict';

/* Phase 35/36 gate: server-authoritative 24h trial lifecycle (client side).
   Exercises the real license.js module against a mock backend, including the
   owner-extension path (server re-issues a longer trialEndsAt -> client unlocks). */

const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const http = require('node:http');

const license = require('../src/main/license');

let passed = 0;
let failed = 0;
function assert(cond, label) {
  if (cond) { passed++; console.log('  PASS', label); }
  else { failed++; console.error('  FAIL', label); }
}

// Minimal db stub used by clearLicense() (license.js touches dbRef only in clear).
const dbStub = { prepare: () => ({ run: () => true, get: () => null, all: () => [] }) };

let tmpDir;
let state;

function startMockBackend() {
  return new Promise((resolve) => {
    state = {
      trialEndsAt: new Date(Date.now() + 24 * 3600 * 1000),
      orgId: 1,
      requests: [],
    };
    const server = http.createServer((req, res) => {
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => {
        state.requests.push({ method: req.method, url: req.url });
        const respond = (code, obj) => {
          res.writeHead(code, { 'content-type': 'application/json', connection: 'close' });
          if (obj) res.end(JSON.stringify(obj));
          else res.end();
        };

        if (req.url === '/api/v1/owner/trial/start' && req.method === 'POST') {
          const payload = body ? JSON.parse(body) : {};
          if (!payload.deviceFingerprint) return respond(200, { code: 'FINGERPRINT_REQUIRED' });
          return respond(200, {
            subscription: {
              id: 101, organizationId: payload.organizationId, status: 'trialing',
              trialStartsAt: new Date(Date.now() - 1000).toISOString(),
              trialEndsAt: state.trialEndsAt.toISOString(),
              currentPeriodStartsAt: new Date(Date.now() - 1000).toISOString(),
              currentPeriodEndsAt: state.trialEndsAt.toISOString(),
            },
            trialToken: license.signToken({ org: payload.organizationId, end: state.trialEndsAt.getTime(), device: payload.deviceFingerprint }),
            expiresAt: state.trialEndsAt.toISOString(),
          });
        }

        if (req.url === '/api/v1/owner/trial/validate' && req.method === 'POST') {
          const payload = body ? JSON.parse(body) : {};
          if (!payload.deviceFingerprint) return respond(200, { valid: false });
          // After owner extends, the server reports the new (later) deadline.
          const now = Date.now();
          const valid = state.trialEndsAt.getTime() > now;
          return respond(200, {
            valid,
            status: valid ? 'trialing' : 'expired',
            expiresAt: state.trialEndsAt.toISOString(),
            trialToken: license.signToken({ org: payload.organizationId, end: state.trialEndsAt.getTime(), device: payload.deviceFingerprint }),
          });
        }

        respond(404, { message: 'not found' });
      });
    });
    server.listen(0, () => resolve({ server, port: server.address().port, base: `http://127.0.0.1:${server.address().port}` }));
  });
}

(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'license-test-'));
  license.init(dbStub, tmpDir);

  const { server, base } = await startMockBackend();

  console.log('\n[1] No license on first run');
  assert(license.getLicenseStatus().type === 'none', 'type = none before any trial');

  console.log('\n[2] Start 24h trial');
  let st = await license.startTrial(base, 1);
  assert(st.type === 'trial' && st.status === 'active', 'active trial after start');
  assert(st.trial.expiresAt || st.trial.endsAt, 'trial has expiresAt');

  console.log('\n[3] Offline status is active and HMAC verifies');
  st = license.getLicenseStatus();
  assert(st.status === 'active', 'status active offline');
  assert(st.trial.hoursLeft > 22, `~24h remaining (hoursLeft=${st.trial.hoursLeft})`);

  console.log('\n[4] Expired locally after deadline (still within grace -> active, offlineGrace)');
  // Rewrite the license file with an already-expired before "now" epoch to trigger offline grace path
  const licFile = path.join(tmpDir, 'license.json');
  const lic = JSON.parse(fs.readFileSync(licFile, 'utf8'));
  lic.expiresAt = new Date(Date.now() - 1000).toISOString();
  lic.lastValidatedAt = new Date().toISOString();
  fs.writeFileSync(licFile, JSON.stringify(lic));
  st = license.getLicenseStatus();
  assert(st.status === 'active', 'still active within offline grace despite local expiry');

  console.log('\n[5] Owner extends trial on server -> revalidate unlocks with new deadline');
  state.trialEndsAt = new Date(Date.now() + 7 * 24 * 3600 * 1000); // owner extended to 7 days
  st = await license.revalidateNow(base, 1);
  assert(st.type === 'trial' && st.status === 'active', `active after revalidate (status=${st.status})`);
  assert(new Date(st.trial.endsAt).getTime() > Date.now() + 6 * 24 * 3600 * 1000, 'deadline moved ~7 days out');
  // hardExpired cleared
  const refreshed = JSON.parse(fs.readFileSync(licFile, 'utf8'));
  assert(refreshed.hardExpired === false && refreshed.status === 'active', 'hardExpired cleared + status active saved');

  console.log('\n[6] Server still reports expired -> locks despite offline grace');
  state.trialEndsAt = new Date(Date.now() - 3600 * 1000); // expired on server
  st = await license.revalidateNow(base, 1);
  assert(st.type === 'trial' && st.status === 'expired', `server-expired -> status=${st.status}`);
  const locked = JSON.parse(fs.readFileSync(licFile, 'utf8'));
  assert(locked.hardExpired === true, 'hardExpired persisted to lock the client');

  console.log('\n[7] Tampered token detected');
  // Fresh-require so module cache (in-memory licenseCache) reflects the file we wrote.
  const licFile2 = path.join(tmpDir, 'license.json');
  const tampered = { ...JSON.parse(fs.readFileSync(licFile2, 'utf8')), type: 'trial', trialToken: 'AAAA.invalid', expiresAt: new Date(Date.now() + 3600 * 1000).toISOString(), lastValidatedAt: new Date().toISOString(), hardExpired: false };
  fs.writeFileSync(licFile2, JSON.stringify(tampered));
  delete require.cache[require.resolve('../src/main/license')];
  const lic2 = require('../src/main/license');
  lic2.init(dbStub, tmpDir);
  st = lic2.getLicenseStatus();
  assert(st.status === 'tampered', 'tampered token -> tampered status');

  console.log('\n[8] clear wipes trial (marker + file)');
  lic2.clearLicense();
  assert(lic2.getLicenseStatus().type === 'none', 'none after clear');

  server.close();
  await new Promise(r => setTimeout(r, 50));
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* best-effort */ }
  console.log(`\n========== ${passed} passed, ${failed} failed ==========`);
  process.exit(failed ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
