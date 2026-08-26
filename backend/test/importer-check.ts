/* Temporary gate: verify the SQLite importer against a real throwaway PG. */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawnSync } from 'child_process';
import { startTestBackend, resetDb } from './bootstrap-pg';

async function main(): Promise<void> {
  const ctx = await startTestBackend();
  try {
    await resetDb(ctx.ds);
    const copy = path.join(os.tmpdir(), `qaveno-import-copy-${process.pid}.db`);
    fs.copyFileSync(
      path.resolve(__dirname, '..', '..', 'data', 'pos.db'),
      copy,
    );
    const opts: any = (ctx.ds as any).options;
    const env = {
      ...process.env,
      POSTGRES_HOST: String(opts.host),
      POSTGRES_PORT: String(opts.port),
      POSTGRES_USER: String(opts.username),
      POSTGRES_PASSWORD: String(opts.password ?? 'postgres'),
      POSTGRES_DB: String(opts.database),
      JWT_SECRET: 'test-secret-test-secret-test-secret-123',
    };
    const r = spawnSync('npx', ['ts-node', '--transpile-only',
      'src/tools/import-sqlite.ts', `--sqlite=${copy}`],
      { encoding: 'utf8', env, shell: true, cwd: path.resolve(__dirname, '..') });
    // eslint-disable-next-line no-console
    console.log(r.stdout);
    if (r.status !== 0) {
      // eslint-disable-next-line no-console
      console.error(r.stderr);
      throw new Error(`importer exited ${r.status}`);
    }
    if (!r.stdout.includes('all tables verified')) {
      throw new Error('verification line missing');
    }
    // idempotency: second run must also succeed with identical counts
    const r2 = spawnSync('npx', ['ts-node', '--transpile-only',
      'src/tools/import-sqlite.ts', `--sqlite=${copy}`],
      { encoding: 'utf8', env, shell: true, cwd: path.resolve(__dirname, '..') });
    if (r2.status !== 0 || !r2.stdout.includes('all tables verified')) {
      // eslint-disable-next-line no-console
      console.error(r2.stdout, r2.stderr);
      throw new Error('second import run failed (idempotency)');
    }
    // spot-check semantic integrity inside PG
    const chk = await ctx.ds.query(
      `SELECT
         (SELECT COUNT(*)::int FROM sale_items si JOIN sales s ON s.id=si.sale_id) AS items_with_sale,
         (SELECT COUNT(*)::int FROM inventory_movements m WHERE m.balance_after IS NULL) AS mv_null_balance,
         (SELECT COUNT(*)::int FROM branch_inventory WHERE quantity < 0) AS neg_qty`,
    );
    if (chk[0].mv_null_balance !== 0 || chk[0].neg_qty !== 0) {
      throw new Error(`semantic check failed: ${JSON.stringify(chk[0])}`);
    }
    // eslint-disable-next-line no-console
    console.log(`IMPORTER GATE OK (sale_items=${chk[0].items_with_sale})`);
    fs.unlinkSync(copy);
  } finally {
    await ctx.stop();
  }
}

main().catch((e) => { /* eslint-disable-next-line no-console */ console.error(e); process.exit(1); });
