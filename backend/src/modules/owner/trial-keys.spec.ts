import * as crypto from 'crypto';
import {
  loadTrialKeyId,
  loadTrialPrivateKey,
  DEFAULT_TRIAL_KEY_ID,
  TEST_TRIAL_PRIVATE_KEY_B64,
  TEST_TRIAL_PUBLIC_KEY_B64,
} from './trial-keys';
import { OwnerService } from './owner.service';
import { requireProductionConfig, configuration } from '../../config/configuration';

describe('Trial Ed25519 Keys & Signing (Unit Tests)', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  describe('trial-keys loading', () => {
    it('loads fallback test private key when QAVENO_TRIAL_PRIVATE_KEY is unset', () => {
      delete process.env.QAVENO_TRIAL_PRIVATE_KEY;
      const key = loadTrialPrivateKey();
      expect(key).toBeDefined();
      expect(key.type).toBe('private');
      expect(key.asymmetricKeyType).toBe('ed25519');

      // Derived public key should match TEST_TRIAL_PUBLIC_KEY_B64
      const pub = crypto.createPublicKey(key);
      const pubB64 = pub.export({ format: 'der', type: 'spki' }).toString('base64');
      expect(pubB64).toBe(TEST_TRIAL_PUBLIC_KEY_B64);
    });

    it('loads custom private key from environment variable when set', () => {
      const { privateKey } = crypto.generateKeyPairSync('ed25519');
      const privB64 = privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64');
      process.env.QAVENO_TRIAL_PRIVATE_KEY = privB64;

      const loaded = loadTrialPrivateKey();
      expect(loaded.asymmetricKeyType).toBe('ed25519');
      const loadedPub = crypto.createPublicKey(loaded).export({ format: 'der', type: 'spki' }).toString('base64');
      const expectedPub = crypto.createPublicKey(privateKey).export({ format: 'der', type: 'spki' }).toString('base64');
      expect(loadedPub).toBe(expectedPub);
    });

    it('supports PEM format for QAVENO_TRIAL_PRIVATE_KEY', () => {
      const { privateKey } = crypto.generateKeyPairSync('ed25519');
      const pem = privateKey.export({ format: 'pem', type: 'pkcs8' }).toString();
      process.env.QAVENO_TRIAL_PRIVATE_KEY = pem;

      const loaded = loadTrialPrivateKey();
      expect(loaded.asymmetricKeyType).toBe('ed25519');
    });

    it('returns default key id prod-1 when QAVENO_TRIAL_KEY_ID is unset', () => {
      delete process.env.QAVENO_TRIAL_KEY_ID;
      expect(loadTrialKeyId()).toBe(DEFAULT_TRIAL_KEY_ID);
      expect(loadTrialKeyId()).toBe('prod-1');
    });

    it('returns custom key id when QAVENO_TRIAL_KEY_ID is set', () => {
      process.env.QAVENO_TRIAL_KEY_ID = 'test-key-2026';
      expect(loadTrialKeyId()).toBe('test-key-2026');
    });
  });

  describe('OwnerService Ed25519 token signing & verification', () => {
    let service: OwnerService;

    beforeEach(() => {
      service = new OwnerService(
        null as any,
        null as any,
        null as any,
        null as any,
        null as any,
        null as any,
        null as any,
      );
    });

    it('signs and verifies a valid trial token including kid in payload', () => {
      const now = new Date();
      const ends = new Date(now.getTime() + 24 * 3600_000);
      const token = service.signTrialToken(42, now, ends, 'hw-device-12345');

      expect(typeof token).toBe('string');
      const result = service.verifyTrialToken(token);
      expect(result.valid).toBe(true);
      expect(result.data).toBeDefined();
      expect(result.data?.org).toBe(42);
      expect(result.data?.device).toBe('hw-device-12345');
      expect(result.data?.kid).toBe('prod-1');
      expect(result.data?.start).toBe(now.getTime());
      expect(result.data?.end).toBe(ends.getTime());
    });

    it('preserves { p, s } envelope and Base64URL encoding', () => {
      const now = new Date();
      const ends = new Date(now.getTime() + 24 * 3600_000);
      const token = service.signTrialToken(10, now, ends, 'fp-abc');

      const raw = Buffer.from(token, 'base64url').toString('utf8');
      const envelope = JSON.parse(raw);
      expect(envelope).toHaveProperty('p');
      expect(envelope).toHaveProperty('s');
      expect(typeof envelope.p).toBe('string');
      expect(typeof envelope.s).toBe('string');

      // Signature should be hex-encoded Ed25519 signature (64 bytes = 128 hex characters)
      expect(envelope.s).toMatch(/^[0-9a-f]{128}$/);
    });

    it('rejects tampered trial token payload', () => {
      const now = new Date();
      const ends = new Date(now.getTime() + 24 * 3600_000);
      const token = service.signTrialToken(42, now, ends, 'hw-device-12345');

      const decoded = JSON.parse(Buffer.from(token, 'base64url').toString('utf8'));
      const tamperedPayload = JSON.parse(decoded.p);
      tamperedPayload.end += 1000000; // extend trial
      decoded.p = JSON.stringify(tamperedPayload);
      const tamperedToken = Buffer.from(JSON.stringify(decoded)).toString('base64url');

      const result = service.verifyTrialToken(tamperedToken);
      expect(result.valid).toBe(false);
    });

    it('rejects a token signed by a different Ed25519 private key', () => {
      const { privateKey: otherKey } = crypto.generateKeyPairSync('ed25519');
      const payload = JSON.stringify({
        org: 99,
        start: Date.now(),
        end: Date.now() + 24 * 3600_000,
        device: 'fake-device',
        ts: Date.now(),
        kid: 'prod-1',
      });
      const sig = crypto.sign(null, Buffer.from(payload, 'utf8'), otherKey).toString('hex');
      const forgedToken = Buffer.from(JSON.stringify({ p: payload, s: sig })).toString('base64url');

      const result = service.verifyTrialToken(forgedToken);
      expect(result.valid).toBe(false);
    });

    it('rejects invalid or corrupted tokens gracefully', () => {
      expect(service.verifyTrialToken('invalid-base64!@#$%').valid).toBe(false);
      expect(service.verifyTrialToken(Buffer.from('not-json').toString('base64url')).valid).toBe(false);
      expect(service.verifyTrialToken(Buffer.from(JSON.stringify({ p: 'only-p' })).toString('base64url')).valid).toBe(false);
    });
  });

  describe('configuration requirements', () => {
    it('requireProductionConfig checks for QAVENO_TRIAL_PRIVATE_KEY in production', () => {
      process.env.NODE_ENV = 'production';
      process.env.POSTGRES_PASSWORD = 'strong_password_123!';
      process.env.POSTGRES_HOST = '127.0.0.1';
      process.env.POSTGRES_PORT = '5432';
      process.env.POSTGRES_USER = 'qaveno';
      process.env.POSTGRES_DB = 'qaveno';
      process.env.JWT_SECRET = 'super-secret-jwt-key-with-over-32-characters';
      process.env.CORS_ORIGINS = 'https://example.com';
      delete process.env.QAVENO_TRIAL_PRIVATE_KEY;

      expect(() => requireProductionConfig()).toThrow(/QAVENO_TRIAL_PRIVATE_KEY/);

      process.env.QAVENO_TRIAL_PRIVATE_KEY = TEST_TRIAL_PRIVATE_KEY_B64;
      expect(() => requireProductionConfig()).not.toThrow();
    });

    it('configuration provides trial config with default prod-1 keyId', () => {
      process.env.NODE_ENV = 'development';
      delete process.env.QAVENO_TRIAL_KEY_ID;
      const cfg = configuration();
      expect(cfg.trial).toBeDefined();
      expect(cfg.trial.keyId).toBe('prod-1');
      expect((cfg as any).trialHmacSecret).toBeUndefined();
    });
  });
});
