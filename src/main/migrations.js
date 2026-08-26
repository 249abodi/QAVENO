'use strict';

/*
 * Versioned schema migrations.
 * Additive-only philosophy: never ALTER/DROP existing business columns;
 * new features add new tables/columns in forward-only steps.
 * Each migration runs once, inside a transaction, tracked in schema_migrations.
 */

const MIGRATIONS = [
  {
    version: 1,
    name: 'users-sessions-audit',
    up: (db) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS users (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          username TEXT NOT NULL UNIQUE COLLATE NOCASE,
          display_name TEXT NOT NULL DEFAULT '',
          password_hash TEXT NOT NULL,
          role TEXT NOT NULL DEFAULT 'cashier'
            CHECK (role IN ('owner','admin','manager','cashier')),
          status TEXT NOT NULL DEFAULT 'active'
            CHECK (status IN ('active','disabled')),
          must_change_password INTEGER NOT NULL DEFAULT 0,
          failed_attempts INTEGER NOT NULL DEFAULT 0,
          locked_until TEXT,
          last_login_at TEXT,
          created_at TEXT NOT NULL DEFAULT (datetime('now')),
          updated_at TEXT
        );

        CREATE TABLE IF NOT EXISTS sessions (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          token_hash TEXT NOT NULL UNIQUE,
          user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          created_at TEXT NOT NULL DEFAULT (datetime('now')),
          expires_at TEXT NOT NULL,
          revoked_at TEXT,
          invalidated_at TEXT
        );

        CREATE TABLE IF NOT EXISTS audit_log (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          actor_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
          action TEXT NOT NULL,
          entity_type TEXT,
          entity_id INTEGER,
          details TEXT,
          created_at TEXT NOT NULL DEFAULT (datetime('now'))
        );

        CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
        CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires_at);
        CREATE INDEX IF NOT EXISTS idx_audit_created ON audit_log(created_at);
        CREATE INDEX IF NOT EXISTS idx_audit_actor ON audit_log(actor_id);
      `);
    }
  },
  {
    version: 2,
    name: 'suppliers',
    up: (db) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS suppliers (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          name TEXT NOT NULL,
          phone TEXT NOT NULL DEFAULT '',
          email TEXT NOT NULL DEFAULT '',
          address TEXT NOT NULL DEFAULT '',
          notes TEXT NOT NULL DEFAULT '',
          status TEXT NOT NULL DEFAULT 'active'
            CHECK (status IN ('active','disabled')),
          created_at TEXT NOT NULL DEFAULT (datetime('now')),
          updated_at TEXT
        );

        CREATE INDEX IF NOT EXISTS idx_suppliers_name ON suppliers(name COLLATE NOCASE);
        CREATE INDEX IF NOT EXISTS idx_suppliers_status ON suppliers(status);
      `);
    }
  },
  {
    version: 3,
    name: 'purchasing-grn',
    up: (db) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS purchase_orders (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          ref TEXT UNIQUE,
          supplier_id INTEGER NOT NULL REFERENCES suppliers(id),
          status TEXT NOT NULL DEFAULT 'draft'
            CHECK (status IN ('draft','submitted','approved','partially_received','fully_received','cancelled')),
          expected_at TEXT,
          notes TEXT NOT NULL DEFAULT '',
          created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
          approved_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
          approved_at TEXT,
          cancelled_at TEXT,
          cancel_reason TEXT NOT NULL DEFAULT '',
          created_at TEXT NOT NULL DEFAULT (datetime('now')),
          updated_at TEXT
        );

        CREATE TABLE IF NOT EXISTS purchase_order_items (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          po_id INTEGER NOT NULL REFERENCES purchase_orders(id) ON DELETE CASCADE,
          product_id INTEGER NOT NULL REFERENCES products(id),
          qty INTEGER NOT NULL CHECK (qty > 0),
          received_qty INTEGER NOT NULL DEFAULT 0 CHECK (received_qty >= 0),
          unit_cost REAL NOT NULL CHECK (unit_cost >= 0),
          created_at TEXT NOT NULL DEFAULT (datetime('now'))
        );

        CREATE TABLE IF NOT EXISTS grns (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          ref TEXT UNIQUE,
          po_id INTEGER NOT NULL REFERENCES purchase_orders(id),
          supplier_id INTEGER REFERENCES suppliers(id) ON DELETE SET NULL,
          received_at TEXT NOT NULL,
          notes TEXT NOT NULL DEFAULT '',
          received_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
          created_at TEXT NOT NULL DEFAULT (datetime('now'))
        );

        CREATE TABLE IF NOT EXISTS grn_items (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          grn_id INTEGER NOT NULL REFERENCES grns(id) ON DELETE CASCADE,
          po_item_id INTEGER NOT NULL REFERENCES purchase_order_items(id),
          product_id INTEGER NOT NULL REFERENCES products(id),
          qty_received INTEGER NOT NULL CHECK (qty_received > 0),
          qty_damaged INTEGER NOT NULL DEFAULT 0 CHECK (qty_damaged >= 0),
          unit_cost REAL NOT NULL CHECK (unit_cost >= 0)
        );

        CREATE INDEX IF NOT EXISTS idx_po_supplier ON purchase_orders(supplier_id);
        CREATE INDEX IF NOT EXISTS idx_po_status ON purchase_orders(status);
        CREATE INDEX IF NOT EXISTS idx_po_items_po ON purchase_order_items(po_id);
        CREATE INDEX IF NOT EXISTS idx_po_items_product ON purchase_order_items(product_id);
        CREATE INDEX IF NOT EXISTS idx_grns_po ON grns(po_id);
        CREATE INDEX IF NOT EXISTS idx_grns_supplier ON grns(supplier_id);
        CREATE INDEX IF NOT EXISTS idx_grn_items_grn ON grn_items(grn_id);
        CREATE INDEX IF NOT EXISTS idx_grn_items_product ON grn_items(product_id);
        CREATE INDEX IF NOT EXISTS idx_movements_ref ON inventory_movements(ref_type, ref_id);
      `);
    }
  },
  {
    version: 4,
    name: 'advanced-inventory',
    up: (db) => {
      db.exec(`
        /* Ledger enrichment: who did it, what the balance was before, structured reason.
           Legacy rows keep NULLs (never fabricate history). */
        ALTER TABLE inventory_movements ADD COLUMN actor_id INTEGER REFERENCES users(id) ON DELETE SET NULL;
        ALTER TABLE inventory_movements ADD COLUMN balance_before INTEGER;
        ALTER TABLE inventory_movements ADD COLUMN reason_code TEXT;

        CREATE INDEX IF NOT EXISTS idx_movements_actor ON inventory_movements(actor_id);
        CREATE INDEX IF NOT EXISTS idx_movements_created ON inventory_movements(created_at);

        /* Stock reconciliation sessions (per product).
           Snapshot semantics: system_qty captured at open; confirm re-checks
           authoritative stock and marks stale when it moved in between. */
        CREATE TABLE IF NOT EXISTS stock_reconciliations (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
          system_qty INTEGER NOT NULL CHECK (system_qty >= 0),
          counted_qty INTEGER NOT NULL CHECK (counted_qty >= 0),
          diff_qty INTEGER NOT NULL,
          status TEXT NOT NULL DEFAULT 'open'
            CHECK (status IN ('open','applied','cancelled','stale')),
          reason_code TEXT NOT NULL,
          note TEXT NOT NULL DEFAULT '',
          created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
          applied_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
          applied_at TEXT,
          movement_id INTEGER REFERENCES inventory_movements(id),
          created_at TEXT NOT NULL DEFAULT (datetime('now'))
        );

        CREATE INDEX IF NOT EXISTS idx_recon_product ON stock_reconciliations(product_id);
        CREATE INDEX IF NOT EXISTS idx_recon_status ON stock_reconciliations(status);

        /* Weighted-average cost transitions, written forward-only.
           unit_cost = purchase unit cost for GRN rows; new WAC recorded in new_cost.
           Pre-M004 receipts are intentionally not backfilled. */
        CREATE TABLE IF NOT EXISTS cost_history (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
          source_type TEXT NOT NULL CHECK (source_type IN ('initial','grn','manual')),
          grn_id INTEGER REFERENCES grns(id) ON DELETE SET NULL,
          supplier_id INTEGER REFERENCES suppliers(id) ON DELETE SET NULL,
          qty_received INTEGER CHECK (qty_received IS NULL OR qty_received >= 0),
          unit_cost REAL NOT NULL CHECK (unit_cost >= 0),
          prev_cost REAL,
          new_cost REAL,
          actor_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
          created_at TEXT NOT NULL DEFAULT (datetime('now'))
        );

        CREATE INDEX IF NOT EXISTS idx_cost_history_product ON cost_history(product_id);

        /* Reorder suggestion quantity; reorder level itself stays low_stock_threshold. */
        ALTER TABLE products ADD COLUMN reorder_qty INTEGER NOT NULL DEFAULT 0
          CHECK (reorder_qty >= 0);
      `);
    }
  },
  {
    version: 5,
    name: 'multi-branch',
    up: (db) => {
      /*
       * Multi-branch evolution (additive, deterministic, data-preserving).
       *
       * Invariants established here:
       *  - The default branch is inserted FIRST => branches.id = 1 forever.
       *  - Legacy single-store history (sales, POs, GRNs, ledger rows) belonged
       *    to the one physical store that becomes the default branch; mapping
       *    those rows to branch 1 is a factual compat migration, not fabrication.
       *  - products.stock columns stay as the DEFAULT-BRANCH mirror (kept in
       *    sync by the services); branch_inventory is authoritative per branch.
       *  - No org/tenant dimension yet (deliberately out of scope).
       */
      db.exec(`
        CREATE TABLE IF NOT EXISTS branches (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          name TEXT NOT NULL,
          code TEXT UNIQUE,
          address TEXT NOT NULL DEFAULT '',
          phone TEXT NOT NULL DEFAULT '',
          status TEXT NOT NULL DEFAULT 'active'
            CHECK (status IN ('active','disabled')),
          created_at TEXT NOT NULL DEFAULT (datetime('now')),
          updated_at TEXT
        );

        CREATE TABLE IF NOT EXISTS user_branches (
          user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          branch_id INTEGER NOT NULL REFERENCES branches(id) ON DELETE CASCADE,
          is_primary INTEGER NOT NULL DEFAULT 0 CHECK (is_primary IN (0,1)),
          created_at TEXT NOT NULL DEFAULT (datetime('now')),
          PRIMARY KEY (user_id, branch_id)
        );

        CREATE INDEX IF NOT EXISTS idx_user_branches_branch ON user_branches(branch_id);

        /* Authoritative per-branch stock. One row per (branch, product). */
        CREATE TABLE IF NOT EXISTS branch_inventory (
          branch_id INTEGER NOT NULL REFERENCES branches(id) ON DELETE CASCADE,
          product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
          quantity INTEGER NOT NULL DEFAULT 0 CHECK (quantity >= 0),
          cost REAL NOT NULL DEFAULT 0 CHECK (cost >= 0),
          low_stock_threshold INTEGER NOT NULL DEFAULT 5 CHECK (low_stock_threshold >= 0),
          reorder_qty INTEGER NOT NULL DEFAULT 0 CHECK (reorder_qty >= 0),
          updated_at TEXT,
          PRIMARY KEY (branch_id, product_id)
        );

        CREATE INDEX IF NOT EXISTS idx_branch_inventory_product ON branch_inventory(product_id);

        CREATE TABLE IF NOT EXISTS stock_transfers (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          ref TEXT UNIQUE,
          source_branch_id INTEGER NOT NULL REFERENCES branches(id),
          dest_branch_id INTEGER NOT NULL REFERENCES branches(id),
          status TEXT NOT NULL DEFAULT 'draft'
            CHECK (status IN ('draft','submitted','approved','dispatched','partially_received','received','cancelled')),
          notes TEXT NOT NULL DEFAULT '',
          created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
          approved_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
          approved_at TEXT,
          last_dispatched_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
          last_dispatched_at TEXT,
          last_received_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
          last_received_at TEXT,
          cancelled_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
          cancelled_at TEXT,
          cancel_reason TEXT NOT NULL DEFAULT '',
          created_at TEXT NOT NULL DEFAULT (datetime('now')),
          updated_at TEXT
        );

        CREATE TABLE IF NOT EXISTS stock_transfer_items (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          transfer_id INTEGER NOT NULL REFERENCES stock_transfers(id) ON DELETE CASCADE,
          product_id INTEGER NOT NULL REFERENCES products(id),
          qty INTEGER NOT NULL CHECK (qty > 0),
          dispatched_qty INTEGER NOT NULL DEFAULT 0 CHECK (dispatched_qty >= 0),
          received_qty INTEGER NOT NULL DEFAULT 0 CHECK (received_qty >= 0),
          /* Carried cost: source-branch WAC snapshotted at dispatch
             (qty-weighted average across partial dispatches). */
          unit_cost REAL CHECK (unit_cost IS NULL OR unit_cost >= 0)
        );

        CREATE INDEX IF NOT EXISTS idx_transfers_source ON stock_transfers(source_branch_id);
        CREATE INDEX IF NOT EXISTS idx_transfers_dest ON stock_transfers(dest_branch_id);
        CREATE INDEX IF NOT EXISTS idx_transfers_status ON stock_transfers(status);
        CREATE INDEX IF NOT EXISTS idx_transfer_items_transfer ON stock_transfer_items(transfer_id);
        CREATE INDEX IF NOT EXISTS idx_transfer_items_product ON stock_transfer_items(product_id);

        /* Branch dimensions on existing entities (nullable during transition;
           every writer sets them from M005 onward, legacy rows backfilled below). */
        ALTER TABLE sales ADD COLUMN branch_id INTEGER REFERENCES branches(id);
        ALTER TABLE purchase_orders ADD COLUMN branch_id INTEGER REFERENCES branches(id);
        ALTER TABLE grns ADD COLUMN branch_id INTEGER REFERENCES branches(id);
        ALTER TABLE inventory_movements ADD COLUMN branch_id INTEGER REFERENCES branches(id);
        ALTER TABLE stock_reconciliations ADD COLUMN branch_id INTEGER REFERENCES branches(id);
        ALTER TABLE cost_history ADD COLUMN branch_id INTEGER REFERENCES branches(id);

        CREATE INDEX IF NOT EXISTS idx_sales_branch ON sales(branch_id);
        CREATE INDEX IF NOT EXISTS idx_po_branch ON purchase_orders(branch_id);
        CREATE INDEX IF NOT EXISTS idx_grns_branch ON grns(branch_id);
        CREATE INDEX IF NOT EXISTS idx_movements_branch ON inventory_movements(branch_id);
        CREATE INDEX IF NOT EXISTS idx_recon_branch ON stock_reconciliations(branch_id);
        CREATE INDEX IF NOT EXISTS idx_cost_branch ON cost_history(branch_id);
      `);

      /* Default branch: first insert ever => id 1 (invariant relied upon by services). */
      db.prepare(
        "INSERT INTO branches (name, code, status) VALUES (?, 'MAIN', 'active')"
      ).run('الفرع الرئيسي');

      const bid = db.prepare('SELECT id FROM branches WHERE code = \'MAIN\'').get().id;

      /* Factual compat mapping: the single pre-branch store became the default branch. */
      db.prepare('UPDATE sales SET branch_id = ?').run(bid);
      db.prepare('UPDATE purchase_orders SET branch_id = ?').run(bid);
      db.prepare('UPDATE grns SET branch_id = ?').run(bid);
      db.prepare('UPDATE inventory_movements SET branch_id = ?').run(bid);
      db.prepare('UPDATE stock_reconciliations SET branch_id = ?').run(bid);
      db.prepare('UPDATE cost_history SET branch_id = ?').run(bid);

      /* Exact preservation: every existing user starts on the default branch;
         every product's live stock/cost/rules migrate verbatim. */
      db.prepare(
        'INSERT INTO user_branches (user_id, branch_id, is_primary) SELECT id, ?, 1 FROM users'
      ).run(bid);
      db.prepare(`
        INSERT INTO branch_inventory (branch_id, product_id, quantity, cost, low_stock_threshold, reorder_qty)
        SELECT ?, id, quantity, cost, low_stock_threshold, reorder_qty FROM products
      `).run(bid);
    }
  },
  {
    version: 6,
    name: 'offline-sync',
    up: (db) => {
      /*
       * Phase 27: offline-first outbox + sync bookkeeping (additive).
       * Local operations remain the source of truth; when Cloud Mode is on,
       * replicated metadata changes are queued here and pushed by the sync
       * engine with idempotent operation ids. Financial documents are NOT
       * queued in this phase.
       */
      db.exec(`
        CREATE TABLE IF NOT EXISTS outbox (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          op_id TEXT NOT NULL UNIQUE,
          op_type TEXT NOT NULL,
          payload TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'pending'
            CHECK (status IN ('pending','sent','failed')),
          attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
          last_error TEXT,
          available_at TEXT,
          created_at TEXT NOT NULL DEFAULT (datetime('now')),
          updated_at TEXT
        );

        CREATE INDEX IF NOT EXISTS idx_outbox_status ON outbox(status);

        CREATE TABLE IF NOT EXISTS sync_state (
          key TEXT PRIMARY KEY,
          value TEXT
        );
      `);
    }
  },
  {
    version: 7,
    name: 'conflict-tracking',
    up: (db) => {
      /*
       * Phase 28: conflict visibility on the client.
       * - outbox gains the 'blocked' state + a server conflict reference so a
         * conflicted op stops retrying but is never lost.
       * - cloud_conflicts mirrors server-side conflicts for the admin UI;
         * refresh() reconciles statuses/resolutions from the cloud.
       */
      db.exec(`
        CREATE TABLE outbox_conflict_v7 (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          op_id TEXT NOT NULL UNIQUE,
          op_type TEXT NOT NULL,
          payload TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'pending'
            CHECK (status IN ('pending','sent','failed','blocked')),
          attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
          last_error TEXT,
          conflict_ref TEXT,
          available_at TEXT,
          created_at TEXT NOT NULL DEFAULT (datetime('now')),
          updated_at TEXT
        );
        INSERT INTO outbox_conflict_v7
          (id, op_id, op_type, payload, status, attempts, last_error, available_at, created_at, updated_at)
        SELECT id, op_id, op_type, payload, status, attempts, last_error, available_at, created_at, updated_at FROM outbox;
        DROP TABLE outbox;
        ALTER TABLE outbox_conflict_v7 RENAME TO outbox;
        CREATE INDEX IF NOT EXISTS idx_outbox_status ON outbox(status);

        CREATE TABLE IF NOT EXISTS cloud_conflicts (
          conflict_id TEXT PRIMARY KEY,
          op_id TEXT NOT NULL,
          entity_type TEXT NOT NULL,
          entity_id INTEGER,
          conflict_type TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'open',
          resolution TEXT,
          reason TEXT,
          local_payload TEXT,
          created_at TEXT,
          updated_at TEXT NOT NULL DEFAULT (datetime('now'))
        );
      `);
    }
  }
];

function run(db, appliedAt) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      applied_at TEXT NOT NULL
    );
  `);

  const appliedRows = db.prepare('SELECT version FROM schema_migrations').all();
  const applied = new Set(appliedRows.map(r => Number(r.version)));

  for (const m of MIGRATIONS) {
    if (applied.has(m.version)) continue;
    const apply = () => {
      m.up(db);
      db.prepare('INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)')
        .run(m.version, m.name, appliedAt);
    };
    try {
      db.exec('BEGIN IMMEDIATE');
      apply();
      db.exec('COMMIT');
    } catch (err) {
      try { db.exec('ROLLBACK'); } catch (_) { /* noop */ }
      throw new Error(`Migration ${m.version} (${m.name}) failed: ${err.message}`);
    }
  }
}

module.exports = { run, MIGRATIONS };
