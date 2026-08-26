export const configuration = () => {
  const isProd = process.env.NODE_ENV === 'production';

  // Production validation: no hardcoded defaults for secrets
  const dbPassword = process.env.POSTGRES_PASSWORD;
  if (isProd && (!dbPassword || dbPassword === 'postgres' || dbPassword === 'qaveno')) {
    throw new Error('POSTGRES_PASSWORD must be set to a strong value in production');
  }

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
