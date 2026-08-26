/* QAVENO — Client-side License Manager (Phase 35)
   Server-authoritative 24h trial with HMAC anti-tamper.
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

/* ── HMAC Verification ─────────────────────────────────────────── */

// This secret MUST match QAVENO_TRIAL_HMAC_SECRET on the backend
const HMAC_SECRET = process.env.QAVENO_TRIAL_SECRET || 'qaveno-trial-hmac-secret-change-in-production';

function signToken(payload) {
  const data = typeof payload === 'string' ? payload : JSON.stringify(payload);
  const sig = crypto.createHmac('sha256', HMAC_SECRET).update(data).digest('hex');
  return Buffer.from(JSON.stringify({ p: data, s: sig })).toString('base64url');
}

function verifyToken(token) {
  try {
    const decoded = JSON.parse(Buffer.from(token, 'base64url').toString());
    const expectedSig = crypto.createHmac('sha256', HMAC_SECRET).update(decoded.p).digest('hex');
    if (decoded.s !== expectedSig) return { valid: false };
    return { valid: true, data: JSON.parse(decoded.p) };
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
    trialToken: body.trialToken, // HMAC-signed by server
    lastValidatedAt: new Date().toISOString(),
    status: 'active',
  };

  saveLicense(trialData);
  return getLicenseStatus();
}

function getTrialInfo() {
  const lic = licenseCache || loadLicense();
  if (!lic || lic.type !== 'trial') return null;

  // Step 1: Verify HMAC signature
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
          if (body.expiresAt) licenseCache.expiresAt = body.expiresAt;
          saveLicense(licenseCache);
        }
      }
    } catch { /* offline, grace period handles this */ }
  }, VALIDATION_INTERVAL_MS);
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
  ipcMain.handle('license:clear', () => {
    clearLicense();
    return getLicenseStatus();
  });
  ipcMain.handle('license:start-periodic-validation', (e, { cloudApiBase, organizationId }) => {
    periodicallyValidate(cloudApiBase, organizationId);
  });
}

module.exports = { init, register, getLicenseStatus, getTrialInfo, startTrial, activateLicense, isFeatureAllowed, getDeviceFingerprint, verifyToken };
