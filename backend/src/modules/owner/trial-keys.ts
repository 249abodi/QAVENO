import * as crypto from 'crypto';

/**
 * QAVENO — Trial token signing keys (asymmetric Ed25519).
 *
 * PRODUCTION: the signing private key MUST come from the
 * `QAVENO_TRIAL_PRIVATE_KEY` environment variable, enforced by
 * `requireProductionConfig()` in configuration.ts. It is only ever held by the
 * deployment (e.g. Railway). Clients hold only the public half and can verify,
 * never sign.
 *
 * The material below is a TEST-ONLY key pair, committed so dev and e2e can run
 * without secrets. It MUST NEVER be used as the production signing key.
 */
export const TEST_TRIAL_PRIVATE_KEY_B64 =
  'MC4CAQAwBQYDK2VwBCIEIL7JxeREuJrPNn79e8rJqNZjP58EuBfC51YGY2r2WNuE';

/** Public half of the TEST pair (useful for desktop/e2e mocks that verify). */
export const TEST_TRIAL_PUBLIC_KEY_B64 =
  'MCowBQYDK2VwAyEAJVtRhmTYUoLMjfIkJJmSGBBEv2NVC7oK6fSmP46/HlE=';

/** Key id embedded inside every signed trial payload (rotation support). */
export const DEFAULT_TRIAL_KEY_ID = 'prod-1';

/** Load the Ed25519 private key used to sign trial tokens. */
export function loadTrialPrivateKey(): crypto.KeyObject {
  const privB64 =
    process.env.QAVENO_TRIAL_PRIVATE_KEY?.trim() || TEST_TRIAL_PRIVATE_KEY_B64;
  if (privB64.includes('-----BEGIN')) {
    return crypto.createPrivateKey(privB64);
  }
  return crypto.createPrivateKey({
    key: Buffer.from(privB64, 'base64'),
    format: 'der',
    type: 'pkcs8',
  });
}

/** Which key id the server signs trial tokens with. */
export function loadTrialKeyId(): string {
  return process.env.QAVENO_TRIAL_KEY_ID?.trim() || DEFAULT_TRIAL_KEY_ID;
}