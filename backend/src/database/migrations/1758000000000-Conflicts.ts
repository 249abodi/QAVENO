import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Phase 28: conflict detection & resolution.
 *
 * - products.version: monotonic entity version bumped on every server-side
 *   mutation; offline ops carry the baseVersion they were made against so the
 *   server can detect stale writes instead of silently overwriting.
 * - sync_conflicts: durable audit of every detected conflict (what conflicted,
 *   from which device/op, local vs server versions, payload kept for review,
 *   and the eventual resolution). Nothing here is destructive: resolving
 *   re-runs a guarded apply or dismisses explicitly.
 */
export class Conflicts1758000000000 implements MigrationInterface {
  public async up(qr: QueryRunner): Promise<void> {
    await qr.query(
      `ALTER TABLE products ADD COLUMN version integer NOT NULL DEFAULT 1`,
    );
    await qr.query(`
      CREATE TABLE sync_conflicts (
        id SERIAL PRIMARY KEY,
        conflict_id TEXT NOT NULL UNIQUE,
        op_id TEXT NOT NULL,
        device_id TEXT,
        actor_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
        entity_type TEXT NOT NULL,
        entity_id INTEGER,
        local_version INTEGER,
        server_version INTEGER,
        local_payload JSONB NOT NULL DEFAULT '{}'::jsonb,
        server_snapshot JSONB,
        conflict_type TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'open'
          CONSTRAINT conflicts_status_chk CHECK (status IN ('open','resolved')),
        resolution TEXT,
        resolved_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
        resolved_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);
    await qr.query(`CREATE INDEX idx_conflicts_status ON sync_conflicts(status)`);
    await qr.query(`CREATE INDEX idx_conflicts_entity ON sync_conflicts(entity_type, entity_id)`);
    await qr.query(`CREATE INDEX idx_conflicts_op ON sync_conflicts(op_id)`);

    // backfill initial versions from update recency ordering
    await qr.query(`
      WITH ordered AS (
        SELECT id, ROW_NUMBER() OVER (ORDER BY COALESCE(updated_at, created_at), id) AS rn
        FROM products
      )
      UPDATE products SET version = o.rn FROM ordered o WHERE products.id = o.id
    `);
  }

  public async down(qr: QueryRunner): Promise<void> {
    await qr.query(`DROP TABLE IF EXISTS sync_conflicts`);
    await qr.query(`ALTER TABLE products DROP COLUMN IF EXISTS version`);
  }
}
