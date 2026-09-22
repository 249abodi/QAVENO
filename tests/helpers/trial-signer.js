'use strict';

/* QAVENO — Test-only Ed25519 signer for desktop trial token tests.
 *
 * THIS FILE IS NEVER IMPORTED BY PRODUCTION ELECTRON CODE.
 * It lives under tests/ and is used only by Node test scripts.
 *
 * The private key below is the test-only key whose PUBLIC half is exposed as
 * TEST_TRIAL_PUBLIC_KEY_B64 in the backend's trial-keys.ts.  It MUST NEVER be
 * used as the production signing key.
 */

const crypto = require('crypto');

/* ── Test-only key pair (committed for CI / dev) ─────────────────── */

/** PKCS#8 DER Base64 — test private key, non-production */
const TEST_PRIVATE_KEY_B64 =
  'MC4CAQAwBQYDK2VwBCIEIL7JxeREuJrPNn79e8rJqNZjP58EuBfC51YGY2r2WNuE';

/** SPKI DER Base64 — public half of the test key */
const TEST_PUBLIC_KEY_B64 =
  'MCowBQYDK2VwAyEAJVtRhmTYUoLMjfIkJJmSGBBEv2NVC7oK6fSmP46/HlE=';

/** Key ID used by the test key */
const TEST_KEY_ID = 'test-1';

function _loadTestPrivateKey() {
  return crypto.createPrivateKey({
    key: Buffer.from(TEST_PRIVATE_KEY_B64, 'base64'),
    format: 'der',
    type: 'pkcs8',
  });
}

/**
 * Sign a trial token payload with the test Ed25519 private key.
 * Produces the same { p, s } Base64URL envelope that the backend emits.
 *
 * @param {object|string} payload  - JS object or pre-serialised JSON string
 * @param {object}        [opts]
 * @param {string}        [opts.kid]       - override the kid (default: TEST_KEY_ID)
 * @param {boolean}       [opts.noKid]     - omit kid from payload (for unknown-kid tests)
 * @param {string}        [opts.corruptSig]- replace signature with this string before encoding
 * @returns {string} Base64URL token
 */
function signTrialToken(payload, opts = {}) {
  const kid = opts.kid !== undefined ? opts.kid : TEST_KEY_ID;
  let obj = typeof payload === 'string' ? JSON.parse(payload) : { ...payload };
  if (!opts.noKid) obj.kid = kid;
  const p = JSON.stringify(obj);
  const privKey = _loadTestPrivateKey();
  let sig = crypto.sign(null, Buffer.from(p, 'utf8'), privKey).toString('hex');
  if (opts.corruptSig !== undefined) sig = opts.corruptSig;
  return Buffer.from(JSON.stringify({ p, s: sig })).toString('base64url');
}

/**
 * Sign with an unrelated, freshly-generated Ed25519 key (forged signature test).
 * @param {object} payload
 * @returns {string} Base64URL token whose signature will fail verification
 */
function signWithOtherKey(payload) {
  const { privateKey } = crypto.generateKeyPairSync('ed25519');
  const obj = { ...payload, kid: TEST_KEY_ID };
  const p = JSON.stringify(obj);
  const sig = crypto.sign(null, Buffer.from(p, 'utf8'), privateKey).toString('hex');
  return Buffer.from(JSON.stringify({ p, s: sig })).toString('base64url');
}

/**
 * Return the SPKI DER Base64 public key of the test key-pair.
 * Useful for injecting into trial-keys maps during tests.
 */
function getTestPublicKeyB64() {
  return TEST_PUBLIC_KEY_B64;
}

module.exports = {
  TEST_KEY_ID,
  TEST_PUBLIC_KEY_B64,
  signTrialToken,
  signWithOtherKey,
  getTestPublicKeyB64,
};
