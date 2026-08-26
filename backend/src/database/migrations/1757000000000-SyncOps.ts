import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Phase 27: idempotency ledger for offline sync pushes.
 * Every accepted operation id is recorded exactly once; replays of the same
 * op_id are answered from this table (duplicate) and never re-applied.
 */
export class SyncOps1757000000000 implements MigrationInterface {
  public async up(qr: QueryRunner): Promise<void> {
    await qr.query(`
      CREATE TABLE sync_operations (
        id SERIAL PRIMARY KEY,
        op_id TEXT NOT NULL UNIQUE,
        device_id TEXT,
        actor_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
        op_type TEXT NOT NULL,
        payload JSONB NOT NULL DEFAULT '{}'::jsonb,
        result_code TEXT NOT NULL,
        received_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);
    await qr.query(`CREATE INDEX idx_sync_ops_actor ON sync_operations(actor_id)`);
    await qr.query(`CREATE INDEX idx_sync_ops_received ON sync_operations(received_at)`);
  }

  public async down(qr: QueryRunner): Promise<void> {
    await qr.query(`DROP TABLE IF EXISTS sync_operations`);
  }
}
