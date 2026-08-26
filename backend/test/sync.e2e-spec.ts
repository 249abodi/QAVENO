import { randomUUID } from 'crypto';
import { startTestBackend, resetDb, seedOwner, login, req, TestCtx, Session } from './bootstrap-pg';

jest.setTimeout(300000);

/** Phase 27 gate: idempotent offline sync push endpoint. */

describe('offline sync push (real PostgreSQL)', () => {
  let ctx: TestCtx;
  let owner: Session;
  let cashier: Session;

  beforeAll(async () => {
    ctx = await startTestBackend();
    await resetDb(ctx.ds);
    owner = await seedOwner(ctx);
    await req(ctx, owner, 'post', '/api/v1/users').send({
      username: 'sync_cashier',
      password: 'UserPass1!',
      displayName: 'sync cashier',
      role: 'cashier',
      branches: [{ branchId: 1, isPrimary: true }],
    }).expect(201);
    cashier = await login(ctx, 'sync_cashier', 'UserPass1!');
  }, 300000);

  afterAll(async () => {
    if (ctx) await ctx.stop();
  }, 120000);

  test('rejects empty batches and oversized batches', async () => {
    await req(ctx, owner, 'post', '/api/v1/sync/push')
      .send({ ops: [] }).expect(400);
    const tooMany = Array.from({ length: 101 }, (_, i) => ({
      opId: randomUUID(),
      type: 'product.update',
      payload: { productId: 1, name: `x${i}` },
    }));
    const res = await req(ctx, owner, 'post', '/api/v1/sync/push')
      .send({ ops: tooMany }).expect(400);
    expect(res.body.code).toBe('VALIDATION_ERROR');
  });

  test('applies a product metadata update and records the ledger row', async () => {
    const p = await req(ctx, owner, 'post', '/api/v1/products')
      .send({ name: 'قبل المزامنة', price: 10, cost: 5 }).expect(201);
    const opId = randomUUID();
    const res = await req(ctx, owner, 'post', '/api/v1/sync/push').send({
      deviceId: 'dev-A',
      ops: [{
        opId,
        type: 'product.update',
        payload: { productId: p.body.id, baseVersion: 1, name: 'بعد المزامنة', price: 12 },
      }],
    }).expect(201);
    expect(res.body.results[0].status).toBe('applied');

    const row = await req(ctx, owner, 'get', `/api/v1/products/${p.body.id}`).expect((r) => r.status === 200 || r.status === 404);
    if (row.status === 200) {
      expect(row.body.name).toBe('بعد المزامنة');
      expect(Number(row.body.price)).toBe(12);
    } else {
      // fallback: verify via direct SQL through list
      const list = await req(ctx, owner, 'get', '/api/v1/products').expect(200);
      const found = (list.body as any[]).find((x) => Number(x.id) === Number(p.body.id));
      expect(found.name).toBe('بعد المزامنة');
    }

    const ledger = await ctx.ds.query(
      `SELECT result_code FROM sync_operations WHERE op_id=$1`, [opId],
    );
    expect(ledger[0].result_code).toBe('applied');
  });

  test('replaying the same opId returns duplicate and never re-applies', async () => {
    const p = await req(ctx, owner, 'post', '/api/v1/products')
      .send({ name: 'تكرار-أ', price: 8, cost: 4 }).expect(201);
    const op = { opId: randomUUID(), type: 'product.update', payload: { productId: p.body.id, baseVersion: 1, price: 9 } };
    await req(ctx, owner, 'post', '/api/v1/sync/push').send({ deviceId: 'dev-A', ops: [op] }).expect(201);

    // tamper: change the product behind the cloud's back, then replay
    await req(ctx, owner, 'patch', `/api/v1/products/${p.body.id}`)
      .send({ name: 'تكرار-أ', price: 77 }).expect(200);

    const replay = await req(ctx, owner, 'post', '/api/v1/sync/push')
      .send({ deviceId: 'dev-A', ops: [op] }).expect(201);
    expect(replay.body.results[0].status).toBe('duplicate');

    // price must remain the manually-set value; the replayed op did NOT reapply
    const one = await req(ctx, owner, 'get', `/api/v1/products/${p.body.id}`).expect(200);
    expect(Number(one.body.price)).toBe(77);
  });

  test('rejected operations are reported with codes and still leave a ledger trail', async () => {
    const opBadProduct = { opId: randomUUID(), type: 'product.update', payload: { productId: 999999, name: 'شبح' } };
    const res = await req(ctx, owner, 'post', '/api/v1/sync/push')
      .send({ deviceId: 'dev-B', ops: [opBadProduct] }).expect(201);
    expect(res.body.results[0]).toEqual(expect.objectContaining({ status: 'rejected', code: 'NOT_FOUND' }));

    // same opId again → duplicate (ledger decided), not another rejection attempt
    const again = await req(ctx, owner, 'post', '/api/v1/sync/push')
      .send({ deviceId: 'dev-B', ops: [opBadProduct] }).expect(201);
    expect(again.body.results[0].status).toBe('duplicate');

    const badPayload = { opId: randomUUID(), type: 'product.update', payload: { productId: 1, price: -5 } };
    const res2 = await req(ctx, owner, 'post', '/api/v1/sync/push')
      .send({ deviceId: 'dev-B', ops: [badPayload] }).expect(201);
    expect(res2.body.results[0].code).toBe('BAD_PRICE');
  });

  test('operation types beyond actor permission are refused wholesale', async () => {
    const res = await req(ctx, cashier, 'post', '/api/v1/sync/push').send({
      deviceId: 'dev-C',
      ops: [{ opId: randomUUID(), type: 'product.update', payload: { productId: 1, name: 'ممنوع' } }],
    }).expect(409);
    expect(res.body.code).toBe('FORBIDDEN_OP_TYPE');
    const ledger = await ctx.ds.query(`SELECT COUNT(*)::int AS c FROM sync_operations WHERE device_id='dev-C'`);
    expect(Number(ledger[0].c)).toBe(0); // nothing was recorded for a wholesale refusal
  });

  test('mixed batch is processed atomically per-op with a single audit entry', async () => {
    const p = await req(ctx, owner, 'post', '/api/v1/products')
      .send({ name: 'دفعات مختلطة', price: 3, cost: 1 }).expect(201);
    const good = { opId: randomUUID(), type: 'product.update', payload: { productId: p.body.id, lowStockThreshold: 7 } };
    const dup = { opId: good.opId, type: 'product.update', payload: { productId: p.body.id, price: 99 } };
    const bad = { opId: randomUUID(), type: 'product.update', payload: { productId: p.body.id, reorderQty: -2 } };

    const auditBefore = await ctx.ds.query(
      `SELECT COUNT(*)::int AS c FROM audit_log WHERE action='sync.push'`,
    );
    const res = await req(ctx, owner, 'post', '/api/v1/sync/push')
      .send({ deviceId: 'dev-D', ops: [good, dup, bad] }).expect(201);
    const byOp = new Map(res.body.results.map((r: any) => [r.opId + r.status, r]));
    expect(byOp.get(good.opId + 'applied')).toBeTruthy();
    expect(byOp.get(dup.opId + 'duplicate')).toBeTruthy();
    expect(byOp.get(bad.opId + 'rejected')).toBeTruthy();

    const auditAfter = await ctx.ds.query(
      `SELECT COUNT(*)::int AS c FROM audit_log WHERE action='sync.push'`,
    );
    expect(Number(auditAfter[0].c)).toBe(Number(auditBefore[0].c) + 1);
  });
});
