/* eslint-disable @typescript-eslint/no-var-requires */
/**
 * SQLite → PostgreSQL snapshot importer (Phase 25).
 *
 * Usage:
 *   npm run import:snapshot -- --sqlite=path/to/pos.db [--dry]
 *
 * - Reads the source DB read-only with node:sqlite (no extra deps).
 * - Writes business tables via TypeORM in dependency order, inside
 *   transactions, idempotently (ON CONFLICT DO NOTHING).
 * - Preserves ids, branch inventory quantities/costs, sale cost snapshots,
 *   and movement balances verbatim.
 * - Verifies row counts afterwards and exits non-zero on mismatch.
 *
 * Timestamps are interpreted as UTC wall-clock so displayed times match the
 * Electron app exactly ('YYYY-MM-DD HH:MM:SS').
 */
import { createDataSource } from '../database/data-source';

function arg(name: string): string | undefined {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.split('=').slice(1).join('=') : undefined;
}

const SQLITE_PATH = arg('sqlite');
const DRY = process.argv.includes('--dry');

if (!SQLITE_PATH) {
  // eslint-disable-next-line no-console
  console.error('usage: npm run import:snapshot -- --sqlite=path/to/pos.db [--dry]');
  process.exit(2);
}

const { DatabaseSync } = require('node:sqlite');

function ts(v: unknown): Date | null {
  if (v == null || v === '') return null;
  const s = String(v).replace('T', ' ').replace('Z', '');
  const d = new Date(s.includes('.') ? s : `${s}+00:00`);
  return Number.isNaN(d.getTime()) ? null : d;
}

function num(v: unknown): number | null {
  if (v == null || v === '') return null;
  return Number(v);
}

async function main(): Promise<void> {
  const src = new DatabaseSync(SQLITE_PATH!, { readOnly: true });
  const ds = createDataSource();
  await ds.initialize();

  const q = async (sql: string): Promise<Record<string, unknown>[]> =>
    src.prepare(sql).all() as never;

  const counts: [string, number, number][] = [];

  if (!DRY) {
    await ds.transaction(async (em) => {
      // settings first (defaults exist; import overwrites real keys)
      for (const r of await q('SELECT key,value FROM settings')) {
        await em.query(
          `INSERT INTO settings (key,value) VALUES ($1,$2)
           ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value`,
          [r.key, r.value],
        );
      }
      // branches
      for (const r of await q('SELECT id,name,code,address,phone,status,created_at,updated_at FROM branches ORDER BY id')) {
        await em.query(
          `INSERT INTO branches (id,name,code,address,phone,status,created_at,updated_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT (id) DO NOTHING`,
          [num(r.id), r.name, r.code ?? null, r.address ?? '', r.phone ?? '', r.status,
           ts(r.created_at), ts(r.updated_at)],
        );
      }
      // users (sessions are NOT migrated; JWT replaces them)
      for (const r of await q('SELECT id,username,display_name,password_hash,role,status,must_change_password,failed_attempts,locked_until,last_login_at,created_at FROM users ORDER BY id')) {
        await em.query(
          `INSERT INTO users (id,username,display_name,password_hash,role,status,must_change_password,failed_attempts,locked_until,last_login_at,created_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) ON CONFLICT (id) DO NOTHING`,
          [num(r.id), r.username, r.display_name ?? '', r.password_hash, r.role, r.status,
           num(r.must_change_password) ?? 0, num(r.failed_attempts) ?? 0,
           ts(r.locked_until), ts(r.last_login_at), ts(r.created_at)],
        );
      }
      for (const r of await q('SELECT user_id,branch_id,is_primary FROM user_branches')) {
        await em.query(
          `INSERT INTO user_branches (user_id,branch_id,is_primary) VALUES ($1,$2,$3)
           ON CONFLICT (user_id, branch_id) DO NOTHING`,
          [num(r.user_id), num(r.branch_id), num(r.is_primary) ?? 0],
        );
      }
      // categories / products
      for (const r of await q('SELECT id,name,color,created_at FROM categories ORDER BY id')) {
        await em.query(
          `INSERT INTO categories (id,name,color,created_at) VALUES ($1,$2,$3,$4) ON CONFLICT (id) DO NOTHING`,
          [num(r.id), r.name, r.color ?? '#2563eb', ts(r.created_at)],
        );
      }
      for (const r of await q('SELECT id,name,barcode,price,cost,quantity,low_stock_threshold,category,category_id,reorder_qty,created_at,updated_at FROM products ORDER BY id')) {
        await em.query(
          `INSERT INTO products (id,name,barcode,price,cost,quantity,low_stock_threshold,category,category_id,reorder_qty,created_at,updated_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) ON CONFLICT (id) DO NOTHING`,
          [num(r.id), r.name, r.barcode ?? null, num(r.price), num(r.cost) ?? 0, num(r.quantity) ?? 0,
           num(r.low_stock_threshold) ?? 5, r.category ?? '', r.category_id ? num(r.category_id) : null,
           num(r.reorder_qty) ?? 0, ts(r.created_at), ts(r.updated_at)],
        );
      }
      // suppliers
      for (const r of await q('SELECT id,name,phone,email,address,notes,status,created_at,updated_at FROM suppliers ORDER BY id')) {
        await em.query(
          `INSERT INTO suppliers (id,name,phone,email,address,notes,status,created_at,updated_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT (id) DO NOTHING`,
          [num(r.id), r.name, r.phone ?? '', r.email ?? '', r.address ?? '', r.notes ?? '',
           r.status, ts(r.created_at), ts(r.updated_at)],
        );
      }
      // purchases chain
      // note: legacy SQLite may predate purchase_orders.cancelled_by → imported as NULL
      const poHasCancelledBy = src.prepare(
        `SELECT COUNT(*) AS c FROM pragma_table_info('purchase_orders') WHERE name='cancelled_by'`,
      ).get().c > 0;
      const poSelect = poHasCancelledBy
        ? 'SELECT id,ref,supplier_id,status,expected_at,notes,branch_id,created_by,approved_by,approved_at,cancelled_by,cancelled_at,cancel_reason,created_at,updated_at FROM purchase_orders ORDER BY id'
        : 'SELECT id,ref,supplier_id,status,expected_at,notes,branch_id,created_by,approved_by,approved_at,NULL AS cancelled_by,cancelled_at,cancel_reason,created_at,updated_at FROM purchase_orders ORDER BY id';
      for (const r of await q(poSelect)) {
        await em.query(
          `INSERT INTO purchase_orders (id,ref,supplier_id,status,expected_at,notes,branch_id,created_by,approved_by,approved_at,cancelled_by,cancelled_at,cancel_reason,created_at,updated_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) ON CONFLICT (id) DO NOTHING`,
          [num(r.id), r.ref ?? null, num(r.supplier_id), r.status, r.expected_at ?? null, r.notes ?? '',
           r.branch_id ? num(r.branch_id) : null, r.created_by ? num(r.created_by) : null,
           r.approved_by ? num(r.approved_by) : null, ts(r.approved_at),
           r.cancelled_by ? num(r.cancelled_by) : null, ts(r.cancelled_at),
           r.cancel_reason ?? '', ts(r.created_at), ts(r.updated_at)],
        );
      }
      for (const r of await q('SELECT id,po_id,product_id,qty,received_qty,unit_cost,created_at FROM purchase_order_items ORDER BY id')) {
        await em.query(
          `INSERT INTO purchase_order_items (id,po_id,product_id,qty,received_qty,unit_cost,created_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT (id) DO NOTHING`,
          [num(r.id), num(r.po_id), num(r.product_id), num(r.qty), num(r.received_qty) ?? 0,
           num(r.unit_cost), ts(r.created_at)],
        );
      }
      for (const r of await q('SELECT id,ref,po_id,supplier_id,branch_id,received_at,notes,received_by,created_at FROM grns ORDER BY id')) {
        await em.query(
          `INSERT INTO grns (id,ref,po_id,supplier_id,branch_id,received_at,notes,received_by,created_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT (id) DO NOTHING`,
          [num(r.id), r.ref ?? null, num(r.po_id), r.supplier_id ? num(r.supplier_id) : null,
           r.branch_id ? num(r.branch_id) : null, ts(r.received_at), r.notes ?? '',
           r.received_by ? num(r.received_by) : null, ts(r.created_at)],
        );
      }
      for (const r of await q('SELECT id,grn_id,po_item_id,product_id,qty_received,qty_damaged,unit_cost FROM grn_items ORDER BY id')) {
        await em.query(
          `INSERT INTO grn_items (id,grn_id,po_item_id,product_id,qty_received,qty_damaged,unit_cost)
           VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT (id) DO NOTHING`,
          [num(r.id), num(r.grn_id), num(r.po_item_id), num(r.product_id),
           num(r.qty_received), num(r.qty_damaged) ?? 0, num(r.unit_cost)],
        );
      }
      // sales
      for (const r of await q('SELECT id,invoice_no,subtotal,tax_total,discount,total,paid,change_amount,payment_method,branch_id,created_at FROM sales ORDER BY id')) {
        await em.query(
          `INSERT INTO sales (id,invoice_no,subtotal,tax_total,discount,total,paid,change_amount,payment_method,branch_id,created_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) ON CONFLICT (id) DO NOTHING`,
          [num(r.id), r.invoice_no, num(r.subtotal), num(r.tax_total) ?? 0, num(r.discount) ?? 0,
           num(r.total), num(r.paid), num(r.change_amount) ?? 0,
           r.payment_method ?? 'cash', r.branch_id ? num(r.branch_id) : null, ts(r.created_at)],
        );
      }
      for (const r of await q('SELECT id,sale_id,product_id,product_name,quantity,unit_price,unit_cost,tax_rate,line_subtotal,line_tax,line_total FROM sale_items ORDER BY id')) {
        await em.query(
          `INSERT INTO sale_items (id,sale_id,product_id,product_name,quantity,unit_price,unit_cost,tax_rate,line_subtotal,line_tax,line_total)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) ON CONFLICT (id) DO NOTHING`,
          [num(r.id), num(r.sale_id), num(r.product_id), r.product_name, num(r.quantity),
           num(r.unit_price), num(r.unit_cost) ?? 0, num(r.tax_rate) ?? 0,
           num(r.line_subtotal), num(r.line_tax), num(r.line_total)],
        );
      }
      // movements & inventory
      for (const r of await q('SELECT id,product_id,change,reason,note,ref_type,ref_id,balance_after,actor_id,balance_before,reason_code,branch_id,created_at FROM inventory_movements ORDER BY id')) {
        await em.query(
          `INSERT INTO inventory_movements (id,product_id,change,reason,note,ref_type,ref_id,balance_after,actor_id,balance_before,reason_code,branch_id,created_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) ON CONFLICT (id) DO NOTHING`,
          [num(r.id), num(r.product_id), num(r.change), r.reason, r.note ?? null,
           r.ref_type ?? null, r.ref_id != null ? num(r.ref_id) : null, num(r.balance_after),
           r.actor_id ? num(r.actor_id) : null, r.balance_before != null ? num(r.balance_before) : null,
           r.reason_code ?? null, r.branch_id ? num(r.branch_id) : null, ts(r.created_at)],
        );
      }
      for (const r of await q('SELECT branch_id,product_id,quantity,cost,low_stock_threshold,reorder_qty,updated_at FROM branch_inventory')) {
        await em.query(
          `INSERT INTO branch_inventory (branch_id,product_id,quantity,cost,low_stock_threshold,reorder_qty,updated_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT (branch_id, product_id) DO NOTHING`,
          [num(r.branch_id), num(r.product_id), num(r.quantity) ?? 0, num(r.cost) ?? 0,
           num(r.low_stock_threshold) ?? 5, num(r.reorder_qty) ?? 0, ts(r.updated_at)],
        );
      }
      for (const r of await q('SELECT id,product_id,system_qty,counted_qty,diff_qty,status,reason_code,note,branch_id,created_by,applied_by,applied_at,movement_id,created_at FROM stock_reconciliations ORDER BY id')) {
        await em.query(
          `INSERT INTO stock_reconciliations (id,product_id,system_qty,counted_qty,diff_qty,status,reason_code,note,branch_id,created_by,applied_by,applied_at,movement_id,created_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) ON CONFLICT (id) DO NOTHING`,
          [num(r.id), num(r.product_id), num(r.system_qty), num(r.counted_qty), num(r.diff_qty),
           r.status, r.reason_code, r.note ?? '', r.branch_id ? num(r.branch_id) : null,
           r.created_by ? num(r.created_by) : null, r.applied_by ? num(r.applied_by) : null,
           ts(r.applied_at), r.movement_id ? num(r.movement_id) : null, ts(r.created_at)],
        );
      }
      for (const r of await q('SELECT id,product_id,source_type,grn_id,supplier_id,branch_id,qty_received,unit_cost,prev_cost,new_cost,actor_id,created_at FROM cost_history ORDER BY id')) {
        await em.query(
          `INSERT INTO cost_history (id,product_id,source_type,grn_id,supplier_id,branch_id,qty_received,unit_cost,prev_cost,new_cost,actor_id,created_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) ON CONFLICT (id) DO NOTHING`,
          [num(r.id), num(r.product_id), r.source_type, r.grn_id ? num(r.grn_id) : null,
           r.supplier_id ? num(r.supplier_id) : null, r.branch_id ? num(r.branch_id) : null,
           r.qty_received != null ? num(r.qty_received) : null, num(r.unit_cost),
           r.prev_cost != null ? num(r.prev_cost) : null, r.new_cost != null ? num(r.new_cost) : null,
           r.actor_id ? num(r.actor_id) : null, ts(r.created_at)],
        );
      }
      // transfers
      for (const r of await q('SELECT id,ref,source_branch_id,dest_branch_id,status,notes,created_by,approved_by,approved_at,last_dispatched_by,last_dispatched_at,last_received_by,last_received_at,cancelled_by,cancelled_at,cancel_reason,created_at,updated_at FROM stock_transfers ORDER BY id')) {
        await em.query(
          `INSERT INTO stock_transfers (id,ref,source_branch_id,dest_branch_id,status,notes,created_by,approved_by,approved_at,last_dispatched_by,last_dispatched_at,last_received_by,last_received_at,cancelled_by,cancelled_at,cancel_reason,created_at,updated_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18) ON CONFLICT (id) DO NOTHING`,
          [num(r.id), r.ref ?? null, num(r.source_branch_id), num(r.dest_branch_id), r.status,
           r.notes ?? '', r.created_by ? num(r.created_by) : null,
           r.approved_by ? num(r.approved_by) : null, ts(r.approved_at),
           r.last_dispatched_by ? num(r.last_dispatched_by) : null, ts(r.last_dispatched_at),
           r.last_received_by ? num(r.last_received_by) : null, ts(r.last_received_at),
           r.cancelled_by ? num(r.cancelled_by) : null, ts(r.cancelled_at),
           r.cancel_reason ?? '', ts(r.created_at), ts(r.updated_at)],
        );
      }
      for (const r of await q('SELECT id,transfer_id,product_id,qty,dispatched_qty,received_qty,unit_cost FROM stock_transfer_items ORDER BY id')) {
        await em.query(
          `INSERT INTO stock_transfer_items (id,transfer_id,product_id,qty,dispatched_qty,received_qty,unit_cost)
           VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT (id) DO NOTHING`,
          [num(r.id), num(r.transfer_id), num(r.product_id), num(r.qty),
           num(r.dispatched_qty) ?? 0, num(r.received_qty) ?? 0,
           r.unit_cost != null ? num(r.unit_cost) : null],
        );
      }

      // sync sequences past imported ids
      const seqTables = [
        'branches', 'users', 'categories', 'products', 'suppliers', 'purchase_orders',
        'purchase_order_items', 'grns', 'grn_items', 'sales', 'sale_items',
        'inventory_movements', 'stock_reconciliations', 'cost_history',
        'stock_transfers', 'stock_transfer_items',
      ];
      for (const t of seqTables) {
        await em.query(
          `SELECT setval(pg_get_serial_sequence('${t}','id'),
             GREATEST((SELECT COALESCE(MAX(id),0) FROM ${t}), 1))`,
        );
      }
    });
  }

  // verification pass
  const verify = async (table: string, srcSql?: string) => {
    const sRows = await q(srcSql || `SELECT COUNT(*) AS c FROM ${table}`);
    const tRows = await ds.query(`SELECT COUNT(*)::int AS c FROM ${table}`);
    const s = Number(Object.values(sRows[0])[0]);
    const t = Number(tRows[0].c);
    counts.push([table, s, t]);
  };

  const tableChecks: [string, string?][] = [
    ['settings'], ['branches'], ['users'],
    ['user_branches', 'SELECT COUNT(*) AS c FROM user_branches'],
    ['categories'], ['products'], ['suppliers'],
    ['purchase_orders'], ['purchase_order_items'], ['grns'], ['grn_items'],
    ['sales'], ['sale_items'], ['inventory_movements'], ['branch_inventory'],
    ['stock_reconciliations'], ['cost_history'],
    ['stock_transfers'], ['stock_transfer_items'],
  ];
  for (const [t, sql] of tableChecks) await verify(t, sql);

  let mismatches = 0;
  // eslint-disable-next-line no-console
  console.log('\n== import verification ==');
  for (const [table, s, t] of counts) {
    const ok = s === t;
    if (!ok) mismatches++;
    // eslint-disable-next-line no-console
    console.log(`${ok ? 'OK ' : 'MISMATCH'} ${table.padEnd(24)} sqlite=${s} postgres=${t}`);
  }
  // eslint-disable-next-line no-console
  console.log(mismatches === 0 ? '\nRESULT: all tables verified ✔' : `\nRESULT: ${mismatches} table(s) MISMATCHED ✘`);

  await ds.destroy();
  src.close();
  if (mismatches > 0) process.exit(1);
}

main().catch((e) => {
  // eslint-disable-next-line no-console
  console.error('import failed:', e?.message || e);
  process.exit(1);
});
