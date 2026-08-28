import 'reflect-metadata';
import { DataSource } from 'typeorm';
import { entitiesArray } from './entities';

const WEAK_DB_PASSWORDS = new Set([
  'postgres',
  'qaveno',
  'CHANGE_ME_TO_A_STRONG_PASSWORD',
]);

/**
 * Fail clearly in production instead of silently falling back to local
 * defaults (mirrors backend/src/config/configuration.ts).
 */
function requireDatabaseConfig(): void {
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

  if (missing.length) {
    throw new Error(`Production database configuration is incomplete. Set: ${missing.join(', ')}`);
  }
}

/**
 * Shared DataSource factory. Used by:
 *  - the app (via TypeOrmModule.forRootAsync)
 *  - the typeorm CLI (migration:run / migration:revert)
 *  - the SQLite importer tool
 */
export function createDataSource(overrides: Partial<Record<string, unknown>> = {}): DataSource {
  requireDatabaseConfig();
  return new DataSource({
    type: 'postgres',
    host: process.env.POSTGRES_HOST || '127.0.0.1',
    port: parseInt(process.env.POSTGRES_PORT || '5432', 10),
    username: process.env.POSTGRES_USER || 'postgres',
    password: process.env.POSTGRES_PASSWORD || 'postgres',
    database: process.env.POSTGRES_DB || 'qaveno',
    ssl:
      process.env.NODE_ENV === 'production' && process.env.POSTGRES_SSL !== 'false'
        ? { rejectUnauthorized: true }
        : false,
    entities: entitiesArray,
    migrations: [__dirname + '/migrations/*{.ts,.js}'],
    synchronize: false,
    logging: false,
    ...overrides,
  } as never);
}

const isCli = process.argv.some((a) => a.includes('migration'));
export default isCli ? createDataSource() : createDataSource();
