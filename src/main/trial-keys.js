'use strict';

/* QAVENO — Trial token public keys (Electron / Desktop side).
 *
 * Ships ONLY the Ed25519 public key(s) used to VERIFY trial tokens.
 * It NEVER contains a private key, HMAC secret, or any signing material.
 * The private key lives exclusively in the backend deployment (e.g. Railway).
 *
 * Packaged builds resolve ONLY the production key (prod-1).
 * The test key (test-1) is never shipped: it is injected only in non-packaged
 * (dev/test) runtimes, via the QAVENO_TRIAL_PUBLIC_KEY_B64 env variable.
 *
 * Key rotation: add a new entry to TRIAL_PUBLIC_KEYS and update
 * QAVENO_TRIAL_KEY_ID to point to the new kid.  Old kids remain for grace-
 * period tokens that may still be in the field.
 */

/**
 * Default / current production key ID that the backend embeds in the payload.
 * @type {string}
 */
const QAVENO_TRIAL_KEY_ID = 'prod-1';

/**
 * Whether this runtime is a packaged (installed) Electron build.
 * Returns false when the electron module is unavailable (pure-Node tests)
 * or when running unpackaged (dev / Playwright harness).
 * @returns {boolean}
 */
function isPackaged() {
  try {
    const electronModule = require('electron');
    return !!(electronModule && electronModule.app && electronModule.app.isPackaged);
  } catch {
    return false;
  }
}

/**
 * Map of kid → SPKI DER Base64 Ed25519 public key.
 * Public key material is NOT a secret and is intentionally committed here.
 *
 * prod-1 : production key (private half lives only on Railway)
 * @type {Record<string, string>}
 */
const TRIAL_PUBLIC_KEYS = {
  'prod-1': 'MCowBQYDK2VwAyEAZZpME4jhJRFoWGahbG61YruUqfoQFVxAzUiWlzidUPk=',
};

/* Dev/test only — never in packaged builds. */
if (!isPackaged() && process.env.QAVENO_TRIAL_PUBLIC_KEY_B64) {
  TRIAL_PUBLIC_KEYS['test-1'] = process.env.QAVENO_TRIAL_PUBLIC_KEY_B64;
}

/**
 * Resolve the Ed25519 public KeyObject for a given kid.
 * Returns null if the kid is unknown (caller should treat as tampered).
 * @param {string} kid
 * @returns {import('crypto').KeyObject | null}
 */
function getPublicKeyForKid(kid) {
  const crypto = require('crypto');
  const b64 = TRIAL_PUBLIC_KEYS[kid];
  if (!b64) return null;
  return crypto.createPublicKey({
    key: Buffer.from(b64, 'base64'),
    format: 'der',
    type: 'spki',
  });
}

module.exports = { QAVENO_TRIAL_KEY_ID, TRIAL_PUBLIC_KEYS, getPublicKeyForKid };