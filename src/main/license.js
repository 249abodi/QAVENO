/* QAVENO — Client-side License Manager (Phase 35)
   Server-authoritative 24h trial with Ed25519 anti-tamper.
   Device fingerprint prevents reinstall/reset abuse. */

'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const os = require('os');

let dbRef = null;
let settingsPath = null;
let licenseCache = null;
let validationTimer = null;

const TRIAL_DURATION_MS = 24 * 60 * 60 * 1000; // 24 hours
const OFFLINE_GRACE_MS = 24 * 60 * 60 * 1000; // 24h offline grace after server validation
const VALIDATION_INTERVAL_MS = 60 * 60 * 1000; // re-validate every 1 hour when online

function init(db, appDataPath) {
  dbRef = db;
  settingsPath = path.join(appDataPath, 'license.json');
  licenseCache = loadLicense();
}

/* ── Device Fingerprint ────────────────────────────────────────── */

function getDeviceFingerprint() {
  const raw = [
    os.hostname(),
    os.platform(),
    os.arch(),
    os.cpus()[0]?.model || 'unknown',
    // Try to get a stable machine ID
    getMachineId(),
  ].join('|');
  return crypto.createHash('sha256').update(raw).digest('hex');
}

function getMachineId() {
  try {
    const fs = require('fs');
    // Windows: MachineGuid from registry
    if (process.platform === 'win32') {
      try {
        const { execSync } = require('child_process');
        const result = execSync(
          'reg query "HKLM\\SOFTWARE\\Microsoft\\Cryptography" /v MachineGuid',
          { encoding: 'utf8', timeout: 3000 }
        );
        const match = result.match(/MachineGuid\s+REG_SZ\s+(\S+)/);
        if (match) return match[1];
      } catch { /* fallback */ }
    }
    // Linux: /etc/machine-id
    if (fs.existsSync('/etc/machine-id')) {
      return fs.readFileSync('/etc/machine-id', 'utf8').trim();
    }
  } catch { /* ok */ }
  return 'fallback-' + os.hostname();
}

/* ── Ed25519 Verification ──────────────────────────────────────── */

const { getPublicKeyForKid } = require('./trial-keys');

/**
 * verifyToken — verifies an Ed25519-signed trial token produced by the backend.
 *
 * Token envelope: Base64URL( JSON({ p: <payload-string>, s: <hex-sig-128-chars> }) )
 * Payload must contain a `kid` field matching a known public key.
 * Returns { valid: false } for ANY of: malformed, unknown kid, bad signature.
 */
function verifyToken(token) {
  try {
    const decoded = JSON.parse(Buffer.from(token, 'base64url').toString());
    if (!decoded || typeof decoded.p !== 'string' || typeof decoded.s !== 'string') {
      return { valid: false };
    }
    const payloadObj = JSON.parse(decoded.p);
    const kid = payloadObj && payloadObj.kid;
    if (!kid) return { valid: false };
    const publicKey = getPublicKeyForKid(kid);
    if (!publicKey) return { valid: false };
    const sigBuf = Buffer.from(decoded.s, 'hex');
    if (sigBuf.length !== 64) return { valid: false }; // Ed25519 sig = 64 bytes
    const valid = crypto.verify(
      null,
      Buffer.from(decoded.p, 'utf8'),
      publicKey,
      sigBuf,
    );
    if (!valid) return { valid: false };
    return { valid: true, data: payloadObj };
  } catch {
    return { valid: false };
  }
}

/* ── License file storage ──────────────────────────────────────── */

function loadLicense() {
  try {
    if (fs.existsSync(settingsPath)) {
      return JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    }
  } catch { /* corrupt file */ }
  return null;
}

function saveLicense(data) {
  licenseCache = data;
  fs.writeFileSync(settingsPath, JSON.stringify(data, null, 2), 'utf8');
}

function clearLicense() {
  licenseCache = null;
  try { fs.unlinkSync(settingsPath); } catch { /* ok */ }
  // Also clear legacy SQLite trial marker
  if (dbRef) {
    try {
      dbRef.prepare("DELETE FROM settings WHERE key = 'trial_started_at'").run();
    } catch { /* ok */ }
  }
}

/* ── Trial management (server-authoritative) ──────────────────── */

async function startTrial(cloudApiBase, organizationId) {
  if (!cloudApiBase) throw new Error('Cloud server not configured');

  const fingerprint = getDeviceFingerprint();
  const res = await fetch(`${cloudApiBase}/api/v1/owner/trial/start`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ organizationId, deviceFingerprint: fingerprint }),
  });

  const body = await res.json();
  if (!res.ok) {
    throw new Error(body.message || body.code || 'Failed to start trial');
  }

  // Store trial data with server-signed token
  const trialData = {
    type: 'trial',
    organizationId,
    deviceFingerprint: fingerprint,
    startedAt: body.subscription.trialStartsAt,
    expiresAt: body.subscription.trialEndsAt,
    trialToken: body.trialToken, // Ed25519-signed by server
    lastValidatedAt: new Date().toISOString(),
    status: 'active',
    hardExpired: false,
  };

  saveLicense(trialData);
  return getLicenseStatus();
}

function getTrialInfo() {
  const lic = licenseCache || loadLicense();
  if (!lic || lic.type !== 'trial') return null;

  // Step 1: Verify Ed25519 signature
  if (lic.trialToken) {
    const tokenCheck = verifyToken(lic.trialToken);
    if (!tokenCheck.valid) {
      return { active: false, expired: true, tampered: true, message: 'Trial token signature invalid (data tampered)' };
    }
    // Step 2: Check device fingerprint
    const currentFingerprint = getDeviceFingerprint();
    if (tokenCheck.data.device !== currentFingerprint) {
      return { active: false, expired: true, tampered: true, message: 'Device fingerprint mismatch (reinstall detected)' };
    }
  }

  // Step 3: Check expiry
  const now = new Date();
  const endsAt = new Date(lic.expiresAt);
  const isExpired = now >= endsAt;

  // Step 4: Check offline grace period
  const lastValidated = new Date(lic.lastValidatedAt);
  const offlineTime = now.getTime() - lastValidated.getTime();
  const withinGrace = offlineTime < OFFLINE_GRACE_MS;

  if (isExpired && !withinGrace) {
    return { active: false, expired: true, tampered: false, endsAt: lic.expiresAt };
  }

  const remaining = endsAt.getTime() - now.getTime();
  const hoursLeft = Math.max(0, remaining / (1000 * 60 * 60));
  const minutesLeft = Math.max(0, remaining / (1000 * 60));

  return {
    active: !isExpired || withinGrace,
    expired: isExpired && withinGrace,
    endsAt: lic.expiresAt,
    hoursLeft: Math.floor(hoursLeft),
    minutesLeft: Math.floor(minutesLeft),
    offlineGrace: isExpired && withinGrace,
    graceExpiresAt: new Date(lastValidated.getTime() + OFFLINE_GRACE_MS).toISOString(),
  };
}

/* ── License activation ────────────────────────────────────────── */

async function activateLicense(licenseCode, organizationId, cloudApiBase) {
  if (!cloudApiBase) throw new Error('Cloud server not configured');

  const url = `${cloudApiBase}/api/v1/owner/activate`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ licenseCode: licenseCode.toUpperCase(), organizationId }),
  });

  const body = await res.json();
  if (!res.ok) {
    throw new Error(body.message || body.code || 'Activation failed');
  }

  const licData = {
    type: 'activated',
    licenseCode: licenseCode.toUpperCase(),
    organizationId,
    plan: body.subscription?.planId || null,
    status: body.subscription?.status || 'active',
    expiresAt: body.subscription?.currentPeriodEndsAt || null,
    activatedAt: new Date().toISOString(),
    cloudValidated: true,
    lastValidatedAt: new Date().toISOString(),
    deviceFingerprint: getDeviceFingerprint(),
  };

  saveLicense(licData);
  return licData;
}

/* ── License status check ──────────────────────────────────────── */

function getLicenseStatus() {
  const lic = licenseCache || loadLicense();

  if (!lic) return { type: 'none', status: 'none' };

  if (lic.type === 'trial') {
    const trial = getTrialInfo();
    if (!trial) return { type: 'none', status: 'none' };
    if (trial.tampered) {
      return { type: 'trial', status: 'tampered', trial };
    }
    // Server explicitly rejected the trial (revalidate/periodic) — lock even inside offline grace
    if (lic.hardExpired) {
      return { type: 'trial', status: 'expired', trial };
    }
    if (trial.active) {
      return { type: 'trial', status: 'active', trial };
    }
    return { type: 'trial', status: 'expired', trial };
  }

  if (lic.type === 'activated') {
    // Check local expiry
    if (lic.expiresAt && new Date(lic.expiresAt) < new Date()) {
      return { type: 'license', status: 'expired', license: lic };
    }
    return { type: 'license', status: lic.status || 'active', license: lic };
  }

  return { type: 'none', status: 'none' };
}

function isFeatureAllowed(feature) {
  const st = getLicenseStatus();
  if (st.status === 'expired' || st.status === 'suspended' || st.status === 'revoked' || st.status === 'tampered') return false;
  if (st.status === 'none') return false;
  return st.status === 'active';
}

/* ── Periodic server re-validation ─────────────────────────────── */

async function periodicallyValidate(cloudApiBase, organizationId) {
  if (validationTimer) clearInterval(validationTimer);
  if (!cloudApiBase || !organizationId) return;

  validationTimer = setInterval(async () => {
    try {
      const fingerprint = getDeviceFingerprint();
      const res = await fetch(`${cloudApiBase}/api/v1/owner/trial/validate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ organizationId, deviceFingerprint: fingerprint }),
      });
      if (res.ok) {
        const body = await res.json();
        // Update local cache with server-signed token
        if (licenseCache && licenseCache.type === 'trial') {
          licenseCache.trialToken = body.trialToken;
          licenseCache.lastValidatedAt = new Date().toISOString();
          licenseCache.status = body.valid ? 'active' : body.status;
          licenseCache.hardExpired = !body.valid;
          if (body.expiresAt) licenseCache.expiresAt = body.expiresAt;
          saveLicense(licenseCache);
        }
      }
    } catch { /* offline, grace period handles this */ }
  }, VALIDATION_INTERVAL_MS);
}

/* ── Re-validate immediately (lock screen "Try again") ────────────── */

async function revalidateNow(cloudApiBase, organizationId) {
  if (!cloudApiBase) throw new Error('Cloud server not configured');

  const fingerprint = getDeviceFingerprint();
  const res = await fetch(`${cloudApiBase}/api/v1/owner/trial/validate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ organizationId, deviceFingerprint: fingerprint }),
  });

  const body = res.ok ? await res.json() : null;
  const lic = loadLicense();
  if (lic && body) {
    const nowIso = new Date().toISOString();
    if (lic.type === 'trial') {
      if (body.valid) {
        lic.trialToken = body.trialToken;
        lic.status = 'active';
        lic.hardExpired = false;
        if (body.expiresAt) lic.expiresAt = body.expiresAt;
      } else {
        // Server explicitly rejected — lock now regardless of offline grace
        lic.status = body.status || 'expired';
        lic.hardExpired = true;
        if (body.expiresAt) lic.expiresAt = body.expiresAt;
      }
      lic.lastValidatedAt = nowIso;
    } else if (lic.type === 'activated' && body.valid) {
      // Owner extended a paid license too — trial/validate returns the new period
      lic.expiresAt = body.expiresAt || lic.expiresAt;
      lic.status = body.status || 'active';
      lic.cloudValidated = true;
      lic.lastValidatedAt = nowIso;
    }
    saveLicense(lic);
  }

  return getLicenseStatus();
}

/* ── IPC handlers ──────────────────────────────────────────────── */

function register(licenseMainWindow) {
  const { ipcMain } = require('electron');

  ipcMain.handle('license:status', () => getLicenseStatus());
  ipcMain.handle('license:activate', async (e, { licenseCode, organizationId, cloudApiBase }) => {
    return activateLicense(licenseCode, organizationId, cloudApiBase);
  });
  ipcMain.handle('license:start-trial', async (e, { cloudApiBase, organizationId }) => {
    return startTrial(cloudApiBase, organizationId);
  });
  ipcMain.handle('license:revalidate', async (e, { cloudApiBase, organizationId }) => {
    return revalidateNow(cloudApiBase, organizationId);
  });
  ipcMain.handle('license:clear', () => {
    clearLicense();
    return getLicenseStatus();
  });
  ipcMain.handle('license:start-periodic-validation', (e, { cloudApiBase, organizationId }) => {
    periodicallyValidate(cloudApiBase, organizationId);
  });
}

module.exports = { init, register, getLicenseStatus, getTrialInfo, startTrial, activateLicense, isFeatureAllowed, getDeviceFingerprint, verifyToken, revalidateNow, clearLicense };
