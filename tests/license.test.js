'use strict';

/* Phase 35/36 gate: server-authoritative 24h trial lifecycle (client side).
   Exercises the real license.js module against a mock backend using Ed25519
   signed tokens (test-only key pair), including the owner-extension path
   (server re-issues a longer trialEndsAt -> client unlocks). */

const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const http = require('node:http');

/* ── Test key injection: point trial-keys.js to the test public key ─── */
// We monkey-patch TRIAL_PUBLIC_KEYS before requiring license.js so that
// verifyToken will accept tokens signed by the test private key.
const trialKeys = require('../src/main/trial-keys');
const signer = require('./helpers/trial-signer');
// Inject test public key into the module's key map
trialKeys.TRIAL_PUBLIC_KEYS[signer.TEST_KEY_ID] = signer.TEST_PUBLIC_KEY_B64;

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

/** Generate a valid Ed25519 trial token for the mock backend responses. */
function makeTrialToken(orgId, deviceFingerprint, endsAt) {
  return signer.signTrialToken({
    org: orgId,
    end: endsAt.getTime(),
    device: deviceFingerprint,
    ts: Date.now(),
  }, { kid: signer.TEST_KEY_ID });
}

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
            trialToken: makeTrialToken(payload.organizationId, payload.deviceFingerprint, state.trialEndsAt),
            expiresAt: state.trialEndsAt.toISOString(),
          });
        }

        if (req.url === '/api/v1/owner/trial/validate' && req.method === 'POST') {
          const payload = body ? JSON.parse(body) : {};
          if (!payload.deviceFingerprint) return respond(200, { valid: false });
          const now = Date.now();
          const valid = state.trialEndsAt.getTime() > now;
          return respond(200, {
            valid,
            status: valid ? 'trialing' : 'expired',
            expiresAt: state.trialEndsAt.toISOString(),
            trialToken: makeTrialToken(payload.organizationId, payload.deviceFingerprint, state.trialEndsAt),
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

  console.log('\n[2] Start 24h trial (Ed25519 token from mock backend)');
  let st = await license.startTrial(base, 1);
  assert(st.type === 'trial' && st.status === 'active', 'active trial after start');
  assert(st.trial.expiresAt || st.trial.endsAt, 'trial has expiresAt');

  console.log('\n[3] Offline status is active and Ed25519 signature verifies');
  st = license.getLicenseStatus();
  assert(st.status === 'active', 'status active offline');
  assert(st.trial.hoursLeft > 22, `~24h remaining (hoursLeft=${st.trial.hoursLeft})`);

  console.log('\n[4] Expired locally after deadline (still within grace -> active, offlineGrace)');
  const licFile = path.join(tmpDir, 'license.json');
  const lic = JSON.parse(fs.readFileSync(licFile, 'utf8'));
  lic.expiresAt = new Date(Date.now() - 1000).toISOString();
  lic.lastValidatedAt = new Date().toISOString();
  fs.writeFileSync(licFile, JSON.stringify(lic));
  st = license.getLicenseStatus();
  assert(st.status === 'active', 'still active within offline grace despite local expiry');

  console.log('\n[5] Owner extends trial on server -> revalidate unlocks with new deadline');
  state.trialEndsAt = new Date(Date.now() + 7 * 24 * 3600 * 1000);
  st = await license.revalidateNow(base, 1);
  assert(st.type === 'trial' && st.status === 'active', `active after revalidate (status=${st.status})`);
  assert(new Date(st.trial.endsAt).getTime() > Date.now() + 6 * 24 * 3600 * 1000, 'deadline moved ~7 days out');
  const refreshed = JSON.parse(fs.readFileSync(licFile, 'utf8'));
  assert(refreshed.hardExpired === false && refreshed.status === 'active', 'hardExpired cleared + status active saved');

  console.log('\n[6] Server still reports expired -> locks despite offline grace');
  state.trialEndsAt = new Date(Date.now() - 3600 * 1000);
  st = await license.revalidateNow(base, 1);
  assert(st.type === 'trial' && st.status === 'expired', `server-expired -> status=${st.status}`);
  const locked = JSON.parse(fs.readFileSync(licFile, 'utf8'));
  assert(locked.hardExpired === true, 'hardExpired persisted to lock the client');

  console.log('\n[7] Tampered token detected');
  const licFile2 = path.join(tmpDir, 'license.json');
  const tampered = { ...JSON.parse(fs.readFileSync(licFile2, 'utf8')), type: 'trial', trialToken: 'AAAA.invalid', expiresAt: new Date(Date.now() + 3600 * 1000).toISOString(), lastValidatedAt: new Date().toISOString(), hardExpired: false };
  fs.writeFileSync(licFile2, JSON.stringify(tampered));
  delete require.cache[require.resolve('../src/main/license')];
  // Re-inject test key after module cache clear
  const trialKeys2 = require('../src/main/trial-keys');
  trialKeys2.TRIAL_PUBLIC_KEYS[signer.TEST_KEY_ID] = signer.TEST_PUBLIC_KEY_B64;
  const lic2 = require('../src/main/license');
  lic2.init(dbStub, tmpDir);
  st = lic2.getLicenseStatus();
  assert(st.status === 'tampered', 'tampered token -> tampered status');

  console.log('\n[8] Forged signature (other Ed25519 key) detected as tampered');
  const fp = license.getDeviceFingerprint ? license.getDeviceFingerprint() : lic2.getDeviceFingerprint();
  const forgedToken = signer.signWithOtherKey({ org: 1, end: Date.now() + 3600_000, device: fp, ts: Date.now() });
  const forgedLic = { type: 'trial', trialToken: forgedToken, expiresAt: new Date(Date.now() + 3600 * 1000).toISOString(), lastValidatedAt: new Date().toISOString(), status: 'active', hardExpired: false, deviceFingerprint: fp, organizationId: 1 };
  fs.writeFileSync(licFile2, JSON.stringify(forgedLic));
  delete require.cache[require.resolve('../src/main/license')];
  const trialKeys3 = require('../src/main/trial-keys');
  trialKeys3.TRIAL_PUBLIC_KEYS[signer.TEST_KEY_ID] = signer.TEST_PUBLIC_KEY_B64;
  const lic3 = require('../src/main/license');
  lic3.init(dbStub, tmpDir);
  st = lic3.getLicenseStatus();
  assert(st.status === 'tampered', 'forged Ed25519 signature -> tampered status');

  console.log('\n[9] Unknown kid rejected as tampered');
  const unknownKidToken = signer.signTrialToken({ org: 1, end: Date.now() + 3600_000, device: fp, ts: Date.now() }, { kid: 'unknown-kid-xyz' });
  const unknownKidLic = { type: 'trial', trialToken: unknownKidToken, expiresAt: new Date(Date.now() + 3600 * 1000).toISOString(), lastValidatedAt: new Date().toISOString(), status: 'active', hardExpired: false, deviceFingerprint: fp, organizationId: 1 };
  fs.writeFileSync(licFile2, JSON.stringify(unknownKidLic));
  delete require.cache[require.resolve('../src/main/license')];
  const trialKeys4 = require('../src/main/trial-keys');
  trialKeys4.TRIAL_PUBLIC_KEYS[signer.TEST_KEY_ID] = signer.TEST_PUBLIC_KEY_B64;
  const lic4 = require('../src/main/license');
  lic4.init(dbStub, tmpDir);
  st = lic4.getLicenseStatus();
  assert(st.status === 'tampered', 'unknown kid -> tampered status');

  console.log('\n[10] Missing kid in payload rejected as tampered');
  const noKidToken = signer.signTrialToken({ org: 1, end: Date.now() + 3600_000, device: fp, ts: Date.now() }, { noKid: true });
  const noKidLic = { type: 'trial', trialToken: noKidToken, expiresAt: new Date(Date.now() + 3600 * 1000).toISOString(), lastValidatedAt: new Date().toISOString(), status: 'active', hardExpired: false, deviceFingerprint: fp, organizationId: 1 };
  fs.writeFileSync(licFile2, JSON.stringify(noKidLic));
  delete require.cache[require.resolve('../src/main/license')];
  const trialKeys5 = require('../src/main/trial-keys');
  trialKeys5.TRIAL_PUBLIC_KEYS[signer.TEST_KEY_ID] = signer.TEST_PUBLIC_KEY_B64;
  const lic5 = require('../src/main/license');
  lic5.init(dbStub, tmpDir);
  st = lic5.getLicenseStatus();
  assert(st.status === 'tampered', 'missing kid -> tampered status');

  console.log('\n[11] Invalid signature encoding (non-hex) rejected as tampered');
  const corruptSigToken = signer.signTrialToken({ org: 1, end: Date.now() + 3600_000, device: fp, ts: Date.now() }, { corruptSig: 'ZZZZ-not-hex-sig!!!!' });
  const corruptLic = { type: 'trial', trialToken: corruptSigToken, expiresAt: new Date(Date.now() + 3600 * 1000).toISOString(), lastValidatedAt: new Date().toISOString(), status: 'active', hardExpired: false, deviceFingerprint: fp, organizationId: 1 };
  fs.writeFileSync(licFile2, JSON.stringify(corruptLic));
  delete require.cache[require.resolve('../src/main/license')];
  const trialKeys6 = require('../src/main/trial-keys');
  trialKeys6.TRIAL_PUBLIC_KEYS[signer.TEST_KEY_ID] = signer.TEST_PUBLIC_KEY_B64;
  const lic6 = require('../src/main/license');
  lic6.init(dbStub, tmpDir);
  st = lic6.getLicenseStatus();
  assert(st.status === 'tampered', 'corrupt sig encoding -> tampered status');

  console.log('\n[12] clear wipes trial (marker + file)');
  lic6.clearLicense();
  assert(lic6.getLicenseStatus().type === 'none', 'none after clear');

  server.close();
  await new Promise(r => setTimeout(r, 50));
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* best-effort */ }
  console.log(`\n========== ${passed} passed, ${failed} failed ==========`);
  process.exit(failed ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
