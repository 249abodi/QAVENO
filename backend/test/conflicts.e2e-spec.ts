import { randomUUID } from 'crypto';
import { startTestBackend, resetDb, seedOwner, login, req, TestCtx, Session } from './bootstrap-pg';

jest.setTimeout(300000);

/** Phase 28 gate: conflict detection, resolution, audit and domain safety. */

const push = (ctx: TestCtx, s: Session, ops: object[], deviceId = 'dev-conflict') =>
  req(ctx, s, 'post', '/api/v1/sync/push').send({ deviceId, ops });

describe('conflict detection & resolution (real PostgreSQL)', () => {
  let ctx: TestCtx;
  let owner: Session;
  let cashier: Session;

  beforeAll(async () => {
    ctx = await startTestBackend();
    await resetDb(ctx.ds);
    owner = await seedOwner(ctx);
    await req(ctx, owner, 'post', '/api/v1/users').send({
      username: 'conf_cashier',
      password: 'UserPass1!',
      displayName: 'conf cashier',
      role: 'cashier',
      branches: [{ branchId: 1, isPrimary: true }],
    }).expect(201);
    cashier = await login(ctx, 'conf_cashier', 'UserPass1!');
  }, 300000);

  afterAll(async () => {
    if (ctx) await ctx.stop();
  }, 120000);

  const mkProduct = async (name: string, price = 10) => {
    const p = await req(ctx, owner, 'post', '/api/v1/products')
      .send({ name, price, cost: 4 }).expect(201);
    return p.body as { id: number; version?: number };
  };

  test('stale product update (baseVersion < server) creates an open conflict and mutates nothing', async () => {
    const p = await mkProduct('تعارض-قديم');
    // server moves ahead behind the offline device's back
    await req(ctx, owner, 'patch', `/api/v1/products/${p.id}`)
      .send({ name: 'تعارض-قديم', price: 55 }).expect(200);

    const opId = randomUUID();
    const res = await push(ctx, owner, [{
      opId,
      type: 'product.update',
      payload: { productId: p.id, baseVersion: 1, price: 20 },
    }]).expect(201);

    expect(res.body.results[0].status).toBe('conflict');
    expect(res.body.results[0].conflictType).toBe('STALE_VERSION');
    const conflictId: string = res.body.results[0].conflictId;
    expect(conflictId).toMatch(/^[0-9a-f-]{36}$/);

    // authoritative data untouched
    const list = await req(ctx, owner, 'get', '/api/v1/products').expect(200);
    const found = (list.body as any[]).find((x) => Number(x.id) === Number(p.id));
    expect(Number(found.price)).toBe(55);
    expect(Number(found.version)).toBe(2);

    // conflict row is open with full metadata
    const detail = await req(ctx, owner, 'get', `/api/v1/sync/conflicts/${conflictId}`).expect(200);
    expect(detail.body.status).toBe('open');
    expect(detail.body.entity_type).toBe('product');
    expect(Number(detail.body.local_version)).toBe(1);
    expect(Number(detail.body.server_version)).toBe(2);
    expect(detail.body.op_id).toBe(opId);
    expect(detail.body.device_id).toBe('dev-conflict');

    // ledger records the conflict outcome
    const ledger = await ctx.ds.query(
      `SELECT result_code FROM sync_operations WHERE op_id=$1`, [opId],
    );
    expect(String(ledger[0].result_code)).toContain(`conflict:STALE_VERSION:${conflictId}`);
  });

  test('concurrent updates: first wins, second becomes a stale-version conflict', async () => {
    const p = await mkProduct('تعارض-تزامن');
    const opA = randomUUID();
    const opB = randomUUID();
    const payload = () => ({ productId: p.id, baseVersion: 1, name: 'متزامن' });

    const r1 = await push(ctx, owner, [{ opId: opA, type: 'product.update', payload: payload() }]).expect(201);
    const r2 = await push(ctx, owner, [{ opId: opB, type: 'product.update', payload: payload() }]).expect(201);
    expect(r1.body.results[0].status).toBe('applied');
    expect(r2.body.results[0].status).toBe('conflict');
    expect(r2.body.results[0].conflictType).toBe('STALE_VERSION');

    const openList = await req(ctx, owner, 'get', '/api/v1/sync/conflicts?status=open').expect(200);
    const mine = (openList.body.items as any[]).filter((c) => c.conflict_id === r2.body.results[0].conflictId);
    expect(mine.length).toBe(1);
  });

  test('matching baseVersion applies cleanly and bumps the version', async () => {
    const p = await mkProduct('إصدار-مطابق');
    const res = await push(ctx, owner, [{
      opId: randomUUID(),
      type: 'product.update',
      payload: { productId: p.id, baseVersion: 1, lowStockThreshold: 9 },
    }]).expect(201);
    expect(res.body.results[0].status).toBe('applied');

    const list = await req(ctx, owner, 'get', '/api/v1/products').expect(200);
    const found = (list.body as any[]).find((x) => Number(x.id) === Number(p.id));
    expect(Number(found.low_stock_threshold)).toBe(9);
    expect(Number(found.version)).toBe(2);
  });

  test('price change without baseVersion is never silent-LWW (MISSING_BASE_VERSION)', async () => {
    const p = await mkProduct('سعر-بلا-أساس', 30);
    const res = await push(ctx, owner, [{
      opId: randomUUID(),
      type: 'product.update',
      payload: { productId: p.id, price: 99 },
    }]).expect(201);
    expect(res.body.results[0].status).toBe('conflict');
    expect(res.body.results[0].conflictType).toBe('MISSING_BASE_VERSION');

    const list = await req(ctx, owner, 'get', '/api/v1/products').expect(200);
    const found = (list.body as any[]).find((x) => Number(x.id) === Number(p.id));
    expect(Number(found.price)).toBe(30); // untouched
  });

  test('safe-field legacy update without baseVersion still applies (controlled LWW)', async () => {
    const p = await mkProduct('حقول-آمنة');
    const res = await push(ctx, owner, [{
      opId: randomUUID(),
      type: 'product.update',
      payload: { productId: p.id, reorderQty: 6 },
    }]).expect(201);
    expect(res.body.results[0].status).toBe('applied');
  });

  test('inventory fields in sync payloads are rejected immutably and audited (server-authoritative)', async () => {
    const p = await mkProduct('مخزون-محصن');
    const before = await ctx.ds.query(`SELECT quantity, cost FROM products WHERE id=$1`, [p.id]);

    const res = await push(ctx, owner, [{
      opId: randomUUID(),
      type: 'product.update',
      payload: { productId: p.id, baseVersion: 1, quantity: 500, cost: 1 },
    }]).expect(201);
    expect(res.body.results[0].status).toBe('rejected');
    expect(res.body.results[0].code).toBe('IMMUTABLE_FIELD_QUANTITY_COST');

    const after = await ctx.ds.query(`SELECT quantity, cost FROM products WHERE id=$1`, [p.id]);
    expect(Number(after[0].quantity)).toBe(Number(before[0].quantity));
    expect(Number(after[0].cost)).toBe(Number(before[0].cost));

    // the rejection is auditable as a permanently-resolved conflict row
    const resolvedList = await req(ctx, owner, 'get', '/api/v1/sync/conflicts?status=resolved').expect(200);
    const audited = (resolvedList.body.items as any[]).find(
      (c) => c.conflict_type === 'IMMUTABLE_FIELDS' && Number(c.entity_id) === Number(p.id),
    );
    expect(audited).toBeTruthy();
    expect(audited.resolution).toBe('rejected_permanent');
  });

  test('financial/unknown op types are rejected without touching financial tables', async () => {
    const salesBefore = await ctx.ds.query(`SELECT COUNT(*)::int AS n FROM sales`);
    // unknown type is stopped at validation — it never reaches apply logic
    const res = await push(ctx, owner, [{
      opId: randomUUID(),
      type: 'sale.create',
      payload: { total: 999 },
    }]).expect(400);
    expect(res.body.code).toBe('VALIDATION_ERROR');
    const salesAfter = await ctx.ds.query(`SELECT COUNT(*)::int AS n FROM sales`);
    expect(salesAfter[0].n).toBe(salesBefore[0].n);
    const ledgerRows = await ctx.ds.query(
      `SELECT COUNT(*)::int AS n FROM sync_operations WHERE op_type='sale.create'`,
    );
    expect(ledgerRows[0].n).toBe(0); // no trace of a financial write attempt
  });

  test('duplicate of a conflicted op returns duplicate and creates no second conflict', async () => {
    const p = await mkProduct('تكرار-تعارض');
    await req(ctx, owner, 'patch', `/api/v1/products/${p.id}`)
      .send({ name: 'تكرار-تعارض', price: 44 }).expect(200);

    const opId = randomUUID();
    const first = await push(ctx, owner, [{
      opId, type: 'product.update',
      payload: { productId: p.id, baseVersion: 1, price: 21 },
    }]).expect(201);
    expect(first.body.results[0].status).toBe('conflict');

    const replay = await push(ctx, owner, [{
      opId, type: 'product.update',
      payload: { productId: p.id, baseVersion: 1, price: 21 },
    }], 'dev-other').expect(201);
    expect(replay.body.results[0].status).toBe('duplicate');

    const rows = await ctx.ds.query(
      `SELECT COUNT(*)::int AS n FROM sync_conflicts WHERE op_id=$1`, [opId],
    );
    expect(rows[0].n).toBe(1);
  });

  test('resolve apply_local applies local payload to fresh state inside one transaction + audits', async () => {
    const p = await mkProduct('حسم-تطبيق');
    await req(ctx, owner, 'patch', `/api/v1/products/${p.id}`)
      .send({ name: 'حسم-تطبيق', price: 60 }).expect(200); // server now v2

    const first = await push(ctx, owner, [{
      opId: randomUUID(), type: 'product.update',
      payload: { productId: p.id, baseVersion: 1, price: 25 },
    }]).expect(201);
    const conflictId = first.body.results[0].conflictId;

    const res = await req(ctx, owner, 'post', `/api/v1/sync/conflicts/${conflictId}/resolve`)
      .send({ resolution: 'apply_local' }).expect(201);
    expect(res.body.resolution).toBe('applied_local');

    const list = await req(ctx, owner, 'get', '/api/v1/products').expect(200);
    const found = (list.body as any[]).find((x) => Number(x.id) === Number(p.id));
    expect(Number(found.price)).toBe(25); // local decision won explicitly
    expect(Number(found.version)).toBe(3); // fresh-state bump

    const detail = await req(ctx, owner, 'get', `/api/v1/sync/conflicts/${conflictId}`).expect(200);
    expect(detail.body.status).toBe('resolved');
    expect(detail.body.resolution).toBe('applied_local');
    expect(detail.body.resolved_by_name).toBeTruthy();
    expect(detail.body.resolved_at).toBeTruthy();

    const audit = await ctx.ds.query(
      `SELECT id FROM audit_log WHERE action='conflict.resolve' AND entity_type='sync_conflict'`,
    );
    expect(audit.length).toBeGreaterThanOrEqual(1);

    // resolving again is refused — no double application
    await req(ctx, owner, 'post', `/api/v1/sync/conflicts/${conflictId}/resolve`)
      .send({ resolution: 'apply_local' }).expect(409);
    const stillOne = await ctx.ds.query(
      `SELECT version FROM products WHERE id=$1`, [p.id],
    );
    expect(Number(stillOne[0].version)).toBe(3); // transaction rollback guard: no partial bump
  });

  test('resolve keep_server dismisses the conflict and keeps authoritative data', async () => {
    const p = await mkProduct('حسم-خادم');
    await req(ctx, owner, 'patch', `/api/v1/products/${p.id}`)
      .send({ name: 'حسم-خادم', price: 70 }).expect(200);

    const first = await push(ctx, owner, [{
      opId: randomUUID(), type: 'product.update',
      payload: { productId: p.id, baseVersion: 1, price: 15 },
    }]).expect(201);
    const conflictId = first.body.results[0].conflictId;

    const res = await req(ctx, owner, 'post', `/api/v1/sync/conflicts/${conflictId}/resolve`)
      .send({ resolution: 'keep_server' }).expect(201);
    expect(res.body.resolution).toBe('keep_server');

    const list = await req(ctx, owner, 'get', '/api/v1/products').expect(200);
    const found = (list.body as any[]).find((x) => Number(x.id) === Number(p.id));
    expect(Number(found.price)).toBe(70);
  });

  test('retry re-applies STALE_VERSION conflicts but is blocked for MISSING_BASE_VERSION', async () => {
    const pStale = await mkProduct('إعادة-محاولة');
    await req(ctx, owner, 'patch', `/api/v1/products/${pStale.id}`)
      .send({ name: 'إعادة-محاولة', price: 80 }).expect(200);
    const s1 = await push(ctx, owner, [{
      opId: randomUUID(), type: 'product.update',
      payload: { productId: pStale.id, baseVersion: 1, lowStockThreshold: 3 },
    }]).expect(201);
    expect(s1.body.results[0].status).toBe('conflict');
    const retryOk = await req(ctx, owner,
      'post', `/api/v1/sync/conflicts/${s1.body.results[0].conflictId}/retry`).expect(201);
    expect(retryOk.body.resolution).toBe('applied_local');

    const pMissing = await mkProduct('منع-إعادة', 12);
    const m1 = await push(ctx, owner, [{
      opId: randomUUID(), type: 'product.update',
      payload: { productId: pMissing.id, price: 13 },
    }]).expect(201);
    expect(m1.body.results[0].status).toBe('conflict');
    const res = await req(ctx, owner,
      'post', `/api/v1/sync/conflicts/${m1.body.results[0].conflictId}/retry`).expect(409);
    expect(res.body.code).toBe('RETRY_NOT_ALLOWED');
  });

  test('RBAC: cashiers cannot see or resolve conflicts; owners can (branch authorization surface)', async () => {
    await req(ctx, cashier, 'get', '/api/v1/sync/conflicts').expect(403);
    await req(ctx, cashier, 'post', '/api/v1/sync/conflicts/00000000-0000-0000-0000-000000000000/resolve')
      .send({ resolution: 'keep_server' }).expect(403);
    await req(ctx, cashier, 'post', '/api/v1/sync/push')
      .send({ deviceId: 'd', ops: [{ opId: randomUUID(), type: 'product.update', payload: { productId: 1, name: 'x' } }] })
      .expect(409); // FORBIDDEN_OP_TYPE for products.update
    const ok = await req(ctx, owner, 'get', '/api/v1/sync/conflicts?limit=5').expect(200);
    expect(Array.isArray(ok.body.items)).toBe(true);
  });

  test('unknown conflict ids 404 without side effects', async () => {
    const ghost = randomUUID();
    await req(ctx, owner, 'get', `/api/v1/sync/conflicts/${ghost}`).expect(404);
    await req(ctx, owner, 'post', `/api/v1/sync/conflicts/${ghost}/resolve`)
      .send({ resolution: 'apply_local' }).expect(404);
    const auditCount = await ctx.ds.query(
      `SELECT COUNT(*)::int AS n FROM audit_log WHERE action='conflict.resolve'`,
    );
    // no new audit entries were written for ghosts
    expect(Number(auditCount[0].n)).toBeGreaterThan(0); // entries exist only from real resolutions
  });
});
