/* eslint-disable @typescript-eslint/no-var-requires */
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { spawnSync, spawn, ChildProcess } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { DataSource } from 'typeorm';
import { AppModule } from '../src/app.module';
import { createDataSource } from '../src/database/data-source';

const PORT = Number(process.env.TEST_PG_PORT || 55432);
const BIN = path.join(
  __dirname, '..', 'node_modules', '@embedded-postgres', 'windows-x64', 'native', 'bin',
);

let postgresProc: ChildProcess | null = null;
let dsRef: DataSource | null = null;
let appRef: INestApplication | null = null;
let starting: Promise<TestCtx> | null = null;
const DATA_DIR = path.join(os.tmpdir(), `qaveno-pgtest-${process.pid}`);
const DB_NAME = `qaveno_test_${process.pid}`;

export interface TestCtx {
  app: INestApplication;
  api: () => ReturnType<typeof import('supertest')>;
  ds: DataSource;
  stop: () => Promise<void>;
}

function sh(cmd: string, args: string[]): void {
  const r = spawnSync(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8' });
  if (r.status !== 0) {
    throw new Error(`${path.basename(cmd)} failed (${r.status}): ${r.stderr || r.stdout}`);
  }
}

async function waitForPg(timeoutMs = 30000): Promise<void> {
  const start = Date.now();
  const probe = new DataSource({
    type: 'postgres',
    host: '127.0.0.1',
    port: PORT,
    username: 'postgres',
    password: 'x',
    database: 'postgres',
    connectTimeoutMS: 2000,
  });
  while (Date.now() - start < timeoutMs) {
    try {
      await probe.initialize();
      await probe.destroy();
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 400));
    }
  }
  try {
    await probe.initialize().then(() => probe.destroy());
  } catch {
    /* final failure surfaces below */
  }
  throw new Error('PostgreSQL did not become ready in time');
}

async function ensurePg(): Promise<void> {
  if (postgresProc) return;
  // kill stray test postgres instances from previous crashed runs (targeted)
  spawnSync('powershell', ['-NoProfile', '-Command',
    "Get-CimInstance Win32_Process -Filter \"Name='postgres.exe'\" | Where-Object { $_.CommandLine -like '*qaveno-pgtest*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }"], { stdio: 'ignore' });
  fs.rmSync(DATA_DIR, { recursive: true, force: true });
  // trust auth locally; tests only
  sh(path.join(BIN, 'initdb.exe'), ['-D', DATA_DIR, '-U', 'postgres', '-A', 'trust', '-E', 'UTF8', '--no-locale']);
  postgresProc = spawn(path.join(BIN, 'postgres.exe'), ['-D', DATA_DIR, '-p', String(PORT), '-F', '-c', 'fsync=off'], {
    stdio: 'ignore',
  });
  process.on('exit', () => {
    if (postgresProc && postgresProc.pid) {
      spawnSync('taskkill', ['/F', '/T', '/PID', String(postgresProc.pid)], { stdio: 'ignore' });
    }
  });
  await waitForPg();
  const createdb = new DataSource({
    type: 'postgres', host: '127.0.0.1', port: PORT,
    username: 'postgres', password: 'x', database: 'postgres',
  });
  await createdb.initialize();
  await createdb.query(`CREATE DATABASE "${DB_NAME}"`);
  await createdb.destroy();
  process.env.POSTGRES_HOST = '127.0.0.1';
  process.env.POSTGRES_PORT = String(PORT);
  process.env.POSTGRES_USER = 'postgres';
  process.env.POSTGRES_PASSWORD = 'x';
  process.env.POSTGRES_DB = DB_NAME;
  process.env.JWT_SECRET = 'test-secret-test-secret-test-secret-123';
}

export async function resetDb(ds?: DataSource): Promise<void> {
  const d = ds ?? dsRef!;
  // Truncate in FK-safe order; include new multi-tenancy + subscription tables.
  await d.query(`
    TRUNCATE TABLE
      license_history,
      ai_insights,
      billing_invoices, billing_events, organization_subscriptions, subscription_plans,
      org_settings, organization_members, organizations,
      stock_transfer_items, stock_transfers, branch_inventory, user_branches,
      cost_history, stock_reconciliations, grn_items, grns, purchase_order_items,
      purchase_orders, sale_items, sales, inventory_movements, products, categories,
      suppliers, audit_log, refresh_tokens, users, branches, sync_conflicts, sync_operations
    RESTART IDENTITY CASCADE`);
  // Reset platform settings; remove per-org keys that no longer exist.
  await d.query(`DELETE FROM settings WHERE key NOT IN ('tax_rate','invoice_seq','po_seq','grn_seq','transfer_seq','store_name','currency','lang','theme')`);
  // Seed default org + branch for tests.
  await d.query(`INSERT INTO organizations (id, name, slug, status) VALUES (1,'المؤسسة الافتراضية','default','active')`);
  await d.query(`SELECT setval('organizations_id_seq', GREATEST((SELECT MAX(id) FROM organizations),1))`);
  await d.query(`INSERT INTO branches (id, name, code, status, organization_id) VALUES (1,'الفرع الرئيسي','MAIN','active',1)`);
  await d.query(`SELECT setval('branches_id_seq', GREATEST((SELECT MAX(id) FROM branches),1))`);
  await d.query(`UPDATE settings SET value='0' WHERE key='invoice_seq' OR key='po_seq' OR key='grn_seq' OR key='transfer_seq'`);
  // Seed default subscription plans for tests.
  await d.query(`INSERT INTO subscription_plans (name, slug, description, price_monthly, price_yearly, currency, trial_days, max_users, max_branches, max_products, features, is_active, sort_order) VALUES ('Free Trial','trial','1-day free trial',0,0,'USD',1,5,2,100,'{"products":true,"inventory":true,"sales":true,"purchases":true,"transfers":true,"reports":true,"pos":true}',true,0) ON CONFLICT (slug) DO NOTHING`);
  await d.query(`INSERT INTO subscription_plans (name, slug, description, price_monthly, price_yearly, currency, trial_days, max_users, max_branches, max_products, features, is_active, sort_order) VALUES ('Basic','basic','Small businesses',29.99,299.99,'USD',0,5,3,500,'{"products":true,"inventory":true,"sales":true,"purchases":false,"transfers":false,"reports":true,"pos":true}',true,1) ON CONFLICT (slug) DO NOTHING`);
  await d.query(`INSERT INTO subscription_plans (name, slug, description, price_monthly, price_yearly, currency, trial_days, max_users, max_branches, max_products, features, is_active, sort_order) VALUES ('Pro','pro','Growing businesses',79.99,799.99,'USD',0,20,10,5000,'{"products":true,"inventory":true,"sales":true,"purchases":true,"transfers":true,"reports":true,"pos":true}',true,2) ON CONFLICT (slug) DO NOTHING`);
  await d.query(`INSERT INTO subscription_plans (name, slug, description, price_monthly, price_yearly, currency, trial_days, max_users, max_branches, max_products, features, is_active, sort_order) VALUES ('Enterprise','enterprise','Large organizations',199.99,1999.99,'USD',0,0,0,0,'{"products":true,"inventory":true,"sales":true,"purchases":true,"transfers":true,"reports":true,"pos":true}',true,3) ON CONFLICT (slug) DO NOTHING`);
  // Create default trial subscription for org #1.
  await d.query(`INSERT INTO organization_subscriptions (organization_id, plan_id, status, trial_starts_at, trial_ends_at, current_period_starts_at, current_period_ends_at) SELECT 1, sp.id, 'trialing', now(), now() + interval '1 day', now(), now() + interval '1 day' FROM subscription_plans sp WHERE sp.slug='trial' AND NOT EXISTS (SELECT 1 FROM organization_subscriptions WHERE organization_id=1)`);
  await d.query(`UPDATE organizations SET subscription_id=(SELECT id FROM organization_subscriptions WHERE organization_id=1 LIMIT 1) WHERE id=1 AND subscription_id IS NULL`);
  // Seed initial trial billing event for org #1.
  await d.query(`INSERT INTO billing_events (organization_id, subscription_id, event_type, provider, payload, status, idempotency_key) SELECT os.organization_id, os.id, 'subscription.trial_started', 'system', jsonb_build_object('plan_id', os.plan_id), 'processed', 'trial-seed-' || os.organization_id FROM organization_subscriptions os WHERE os.organization_id=1 AND NOT EXISTS (SELECT 1 FROM billing_events WHERE organization_id=1 AND event_type='subscription.trial_started')`);
}

/** Boots the full backend once against a real (locally spawned) PostgreSQL. */
export async function startTestBackend(): Promise<TestCtx> {
  if (starting) return starting;
  starting = (async () => {
    await ensurePg();

    const migrator = createDataSource();
    await migrator.initialize();
    await migrator.runMigrations();
    dsRef = migrator;

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    const app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api/v1');
    // mirror production main.ts: global DTO validation + uniform error envelope
    const { ValidationPipe } = require('@nestjs/common');
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
    const { AllExceptionsFilter } = require('../src/common/all-exceptions.filter');
    app.useGlobalFilters(new AllExceptionsFilter());
    await app.init();
    appRef = app;

    const supertest = require('supertest');
    const server = app.getHttpServer();
    return {
      app,
      ds: migrator,
      api: () => supertest(server),
      stop: async () => {
        try {
          if (appRef) await appRef.close();
          if (dsRef && dsRef.isInitialized) await dsRef.destroy();
        } finally {
          starting = null;
          if (postgresProc && postgresProc.pid) {
            // Windows: SIGTERM is unreliable; hard-kill the tree
            spawnSync('taskkill', ['/F', '/T', '/PID', String(postgresProc.pid)], { stdio: 'ignore' });
            postgresProc = null;
          }
          fs.rmSync(DATA_DIR, { recursive: true, force: true });
        }
      },
    };
  })();
  starting.catch(() => { /* allow retry after a failed boot */ starting = null; });
  return starting;
}

export interface Session {
  token: string;
  accessToken: string;
  refreshToken: string;
  user: Record<string, unknown>;
}

/** setup-owner + login convenience for tests. */
export async function seedOwner(ctx: TestCtx, username = 'owner', password = 'OwnerPass1!'): Promise<Session> {
  await ctx.api().post('/api/v1/auth/setup-owner').send({ username, password, displayName: 'المالك' }).expect((r) => {
    if (![200, 201].includes(r.status)) throw new Error(`setup-owner failed: ${JSON.stringify(r.body)}`);
  });
  return login(ctx, username, password);
}

export async function login(ctx: TestCtx, username: string, password: string): Promise<Session> {
  const res = await ctx.api().post('/api/v1/auth/login').send({ username, password });
  if (res.status !== 200 && res.status !== 201) {
    throw new Error(`login failed (${res.status}): ${JSON.stringify(res.body)}`);
  }
  const body = res.body as { accessToken?: string; refreshToken?: string; user?: unknown };
  return {
    token: String(body.accessToken ?? ''),
    accessToken: String(body.accessToken ?? ''),
    refreshToken: String(body.refreshToken ?? ''),
    user: body.user as Record<string, unknown>,
  } as Session;
}

type Method = 'get' | 'post' | 'patch' | 'delete';

/** Authenticated request builder. */
export function req(
  ctx: TestCtx,
  session: Session,
  method: Method,
  url: string,
  branchId?: number,
  orgId?: number,
) {
  let r = (ctx.api() as any)[method](url)
    .set('Authorization', `Bearer ${session.token}`);
  if (branchId != null) r = r.set('X-Branch-Id', String(branchId));
  if (orgId != null) r = r.set('X-Org-Id', String(orgId));
  return r;
}
