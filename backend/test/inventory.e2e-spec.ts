import { login, req, resetDb, startTestBackend, TestCtx } from './bootstrap-pg';

async function seedOwner(ctx: TestCtx): Promise<{ token: string }> {
  await ctx.api().post('/api/v1/auth/setup-owner').send({ username: 'owner', password: 'OwnerPass1!' })
    .expect((r) => { if (![200, 201].includes(r.status)) throw new Error(JSON.stringify(r.body)); });
  return login(ctx, 'owner', 'OwnerPass1!');
}

describe('inventory domain (real PostgreSQL)', () => {
  let ctx: TestCtx;
  let owner: { token: string };

  beforeAll(async () => {
    ctx = await startTestBackend();
    await resetDb(ctx.ds);
    owner = await seedOwner(ctx);
  }, 300000);

  afterAll(async () => {
    if (ctx) await ctx.stop();
  }, 120000);

  let productId = 0;
  let catId = 0;

  test('category create + DUPLICATE_NAME', async () => {
    const ok = await req(ctx, owner, 'post', '/api/v1/categories')
      .send({ name: 'مشروبات', color: '#0ea5e9' }).expect(201);
    catId = ok.body.id;
    const dup = await req(ctx, owner, 'post', '/api/v1/categories')
      .send({ name: 'مشروبات' }).expect(409);
    expect(dup.body.code).toBe('DUPLICATE_NAME');
  });

  test('product create with category; barcode uniqueness enforced', async () => {
    const ok = await req(ctx, owner, 'post', '/api/v1/products').send({
      name: 'شاي 100غ', barcode: 'BC-TEA-1', price: 10.5, cost: 6,
      lowStockThreshold: 4, reorderQty: 12, categoryId: catId,
    }).expect(201);
    productId = ok.body.id;
    expect(ok.body.quantity).toBe(0);
    const dup = await req(ctx, owner, 'post', '/api/v1/products').send({
      name: 'مقلد', barcode: 'BC-TEA-1', price: 5, cost: 2,
    }).expect(409);
    expect(dup.body.code).toBe('DUPLICATE_BARCODE');
  });

  test('adjust +delta; INSUFFICIENT_STOCK on negative beyond zero', async () => {
    const ok = await req(ctx, owner, 'post', '/api/v1/inventory/adjust')
      .send({ productId, delta: 20, reasonCode: 'OPENING', note: 'افتتاحي' }).expect(201);
    expect(ok.body.quantity).toBe(20);
    const bad = await req(ctx, owner, 'post', '/api/v1/inventory/adjust')
      .send({ productId, delta: -21, reasonCode: 'DAMAGE' }).expect(409);
    expect(bad.body.code).toBe('INSUFFICIENT_STOCK');
  });

  test('default branch adjust mirrors products table', async () => {
    const row = await ctx.ds.query(`SELECT quantity FROM products WHERE id=$1`, [productId]);
    expect(Number(row[0].quantity)).toBe(20);
  });

  test('movement recorded with balance_after chain', async () => {
    const list = await req(ctx, owner, 'get', `/api/v1/inventory/movements?productId=${productId}`).expect(200);
    expect(list.body.rows.length).toBeGreaterThanOrEqual(1);
    expect(list.body.rows[0].balance_after ?? list.body.rows[0].balanceAfter).toBeDefined();
  });

  test('reconciliation flow: open → confirm applies diff + movement', async () => {
    const open = await req(ctx, owner, 'post', '/api/v1/inventory/reconciliations')
      .send({ productId, countedQty: 17, reasonCode: 'COUNT_ERROR' }).expect(201);
    expect(Number(open.body.diff_qty ?? open.body.diffQty)).toBe(-3);
    const conf = await req(ctx, owner, 'post',
      `/api/v1/inventory/reconciliations/${open.body.id}/confirm`).expect(201);
    expect(conf.body.quantity).toBe(17);
    // products mirror updated
    const row = await ctx.ds.query(`SELECT quantity FROM products WHERE id=$1`, [productId]);
    expect(Number(row[0].quantity)).toBe(17);
  });

  test('STALE_RECONCILIATION when stock moved between open and confirm', async () => {
    const open = await req(ctx, owner, 'post', '/api/v1/inventory/reconciliations')
      .send({ productId, countedQty: 17, reasonCode: 'COUNT' }).expect(201);
    await req(ctx, owner, 'post', '/api/v1/inventory/adjust')
      .send({ productId, delta: -2, reasonCode: 'DAMAGE' }).expect(201);
    const res = await req(ctx, owner, 'post',
      `/api/v1/inventory/reconciliations/${open.body.id}/confirm`).expect(409);
    expect(res.body.code).toBe('STALE_RECONCILIATION');
    // stale recon is terminal: cancel rejected
    await req(ctx, owner, 'post',
      `/api/v1/inventory/reconciliations/${open.body.id}/cancel`).expect(409);
    // since it is no longer 'open', a fresh reconciliation may be opened
    const reopen = await req(ctx, owner, 'post', '/api/v1/inventory/reconciliations')
      .send({ productId, countedQty: 17, reasonCode: 'COUNT' }).expect(201);
    // clean up for subsequent tests
    await req(ctx, owner, 'post',
      `/api/v1/inventory/reconciliations/${reopen.body.id}/cancel`).expect(201);
  });

  test('OPEN_RECONCILIATIONS guard blocks duplicate open recon for same product', async () => {
    await req(ctx, owner, 'post', '/api/v1/inventory/reconciliations')
      .send({ productId, countedQty: 15, reasonCode: 'COUNT' }).expect(201);
    const dup = await req(ctx, owner, 'post', '/api/v1/inventory/reconciliations')
      .send({ productId, countedQty: 16, reasonCode: 'COUNT' }).expect(409);
    expect(dup.body.code).toBe('OPEN_RECONCILIATIONS');
  });

  test('rules update branch row (and default mirrors product defaults)', async () => {
    await req(ctx, owner, 'post', `/api/v1/inventory/products/${productId}/rules`)
      .send({ lowStockThreshold: 3, reorderQty: 30 }).expect(201);
    const p = await ctx.ds.query(`SELECT low_stock_threshold, reorder_qty FROM products WHERE id=$1`, [productId]);
    expect(Number(p[0].low_stock_threshold)).toBe(3);
    expect(Number(p[0].reorder_qty)).toBe(30);
  });

  test('valuation sums quantity*cost for the branch context', async () => {
    const v = await req(ctx, owner, 'get', '/api/v1/inventory/valuation').expect(200);
    expect(v.body.totalUnits).toBeGreaterThanOrEqual(15);
    expect(v.body.totalValue).toBeGreaterThan(0);
    expect(Array.isArray(v.body.byCategory)).toBe(true);
  });

  test('product delete IN_USE once movements exist', async () => {
    const res = await req(ctx, owner, 'delete', `/api/v1/products/${productId}`).expect(409);
    expect(res.body.code).toBe('IN_USE');
  });

  test('fresh product with no history deletes cleanly', async () => {
    const fresh = await req(ctx, owner, 'post', '/api/v1/products')
      .send({ name: 'زائد', price: 3, cost: 1 }).expect(201);
    await req(ctx, owner, 'delete', `/api/v1/products/${fresh.body.id}`).expect(200);
  });

  test('cost-history empty for non-purchase product', async () => {
    const rows = await req(ctx, owner, 'get', `/api/v1/inventory/products/${productId}/cost-history`).expect(200);
    expect(rows.body).toEqual([]);
  });
});
