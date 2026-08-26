import 'reflect-metadata';
import { DataSource } from 'typeorm';
import { entitiesArray } from './entities';

/**
 * Shared DataSource factory. Used by:
 *  - the app (via TypeOrmModule.forRootAsync)
 *  - the typeorm CLI (migration:run / migration:revert)
 *  - the SQLite importer tool
 */
export function createDataSource(overrides: Partial<Record<string, unknown>> = {}): DataSource {
  return new DataSource({
    type: 'postgres',
    host: process.env.POSTGRES_HOST || '127.0.0.1',
    port: parseInt(process.env.POSTGRES_PORT || '5432', 10),
    username: process.env.POSTGRES_USER || 'postgres',
    password: process.env.POSTGRES_PASSWORD || 'postgres',
    database: process.env.POSTGRES_DB || 'qaveno',
    entities: entitiesArray,
    migrations: [__dirname + '/migrations/*{.ts,.js}'],
    synchronize: false,
    logging: false,
    ...overrides,
  } as never);
}

const isCli = process.argv.some((a) => a.includes('migration'));
export default isCli ? createDataSource() : createDataSource();
