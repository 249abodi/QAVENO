const WEAK_DB_PASSWORDS = new Set([
  'postgres',
  'qaveno',
  'CHANGE_ME_TO_A_STRONG_PASSWORD',
]);

/** Fail fast in production when required configuration is missing. Never validates secret values, only their presence/strength. */
export function requireProductionConfig(): void {
  if (process.env.NODE_ENV !== 'production') return;

  const missing: string[] = [];
  const dbPassword = process.env.POSTGRES_PASSWORD;

  if (!dbPassword || !dbPassword.trim()) {
    missing.push('POSTGRES_PASSWORD');
  } else if (WEAK_DB_PASSWORDS.has(dbPassword.trim())) {
    missing.push('POSTGRES_PASSWORD (weak default)');
  }
  if (!process.env.POSTGRES_HOST || !process.env.POSTGRES_HOST.trim()) missing.push('POSTGRES_HOST');
  if (!process.env.POSTGRES_PORT || !process.env.POSTGRES_PORT.trim()) missing.push('POSTGRES_PORT');
  if (!process.env.POSTGRES_USER || !process.env.POSTGRES_USER.trim()) missing.push('POSTGRES_USER');
  if (!process.env.POSTGRES_DB || !process.env.POSTGRES_DB.trim()) missing.push('POSTGRES_DB');

  const jwtSecret = process.env.JWT_SECRET || '';
  if (!jwtSecret || jwtSecret.length < 32) missing.push('JWT_SECRET (>=32 chars)');
  if (!process.env.QAVENO_TRIAL_SECRET || !process.env.QAVENO_TRIAL_SECRET.trim()) missing.push('QAVENO_TRIAL_SECRET');
  if (!process.env.CORS_ORIGINS || !process.env.CORS_ORIGINS.trim()) missing.push('CORS_ORIGINS');

  if (missing.length) {
    throw new Error(`Production configuration is incomplete. Set: ${missing.join(', ')}`);
  }
}

export const configuration = () => {
  const isProd = process.env.NODE_ENV === 'production';

  // Production validation: no hardcoded defaults for secrets.
  requireProductionConfig();

  const dbPassword = process.env.POSTGRES_PASSWORD;

  return {
    port: parseInt(process.env.PORT || '3000', 10),
    database: {
      host: process.env.POSTGRES_HOST || '127.0.0.1',
      port: parseInt(process.env.POSTGRES_PORT || '5432', 10),
      user: process.env.POSTGRES_USER || 'qaveno',
      password: dbPassword || 'qaveno',
      name: process.env.POSTGRES_DB || 'qaveno',
    },
    jwt: {
      secret: process.env.JWT_SECRET || '',
      accessTtlSec: parseInt(process.env.ACCESS_TTL_SEC || process.env.JWT_ACCESS_TTL_SEC || '900', 10),
      refreshTtlSec: parseInt(process.env.REFRESH_TTL_SEC || process.env.JWT_REFRESH_TTL_SEC || String(7 * 24 * 3600), 10),
      issuer: process.env.JWT_ISSUER || 'qaveno-backend',
    },
    swaggerEnabled: process.env.SWAGGER_ENABLED === 'true' || process.env.NODE_ENV !== 'production',
    trialHmacSecret: process.env.QAVENO_TRIAL_SECRET || '',
  };
};
