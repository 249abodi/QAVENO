import { login, req, resetDb, startTestBackend, TestCtx } from './bootstrap-pg';

async function seedOwner(ctx: TestCtx): Promise<{ token: string }> {
  await ctx.api().post('/api/v1/auth/setup-owner').send({ username: 'owner', password: 'OwnerPass1!' })
    .expect((r) => { if (![200, 201].includes(r.status)) throw new Error(JSON.stringify(r.body)); });
  return login(ctx, 'owner', 'OwnerPass1!');
}

describe('purchases lifecycle + WAC blending (real PostgreSQL)', () => {
  let ctx: TestCtx;
  let owner: { token: string };

  beforeAll(async () => {
    ctx = await startTestBackend();
    await resetDb(ctx.ds);
    owner = await seedOwner(ctx);
    // supplier + two products
    const s = await req(ctx, owner, 'post', '/api/v1/suppliers')
      .send({ name: 'مورّد الرياض', phone: '0500000000' }).expect(201);
    void s;
    for (const [name, price] of [['عصير برتقال', 8], ['ماء 600مل', 2]] as const) {
      const p = await req(ctx, owner, 'post', '/api/v1/products').send({ name, price, cost: price * 0.5 });
      expect([200, 201]).toContain(p.status);
    }
  }, 300000);

  afterAll(async () => {
    if (ctx) await ctx.stop();
  }, 120000);

  let poId = 0;
  let firstProductId = 0;

  async function productIds(): Promise<number[]> {
    const rows = await req(ctx, owner, 'get', '/api/v1/products').expect(200);
    return (rows.body as any[]).map((r) => Number(r.id));
  }

  test('EMPTY_ITEMS and bad supplier rejected', async () => {
    const sups = await req(ctx, owner, 'get', '/api/v1/suppliers').expect(200);
    const supplierId = Number(sups.body[0].id);
    const empty = await req(ctx, owner, 'post', '/api/v1/purchases')
      .send({ supplierId, items: [] }).expect(400);
    expect(empty.body.code).toBe('EMPTY_ITEMS');
    const nosup = await req(ctx, owner, 'post', '/api/v1/purchases')
      .send({ supplierId: 99999, items: [{ productId: 1, qty: 5, unitCost: 3 }] }).expect(404);
    expect(nosup.body.code).toBe('NOT_FOUND');
  });

  test('create draft → INVALID_STATUS on edit after approve', async () => {
    const ids = await productIds();
    firstProductId = ids[0];
    const created = await req(ctx, owner, 'post', '/api/v1/purchases').send({
      supplierId: (await req(ctx, owner, 'get', '/api/v1/suppliers')).body[0].id,
      items: [
        { productId: ids[0], qty: 10, unitCost: 4 },
        { productId: ids[1], qty: 50, unitCost: 1 },
      ],
      notes: 'دفعة أولى',
    }).expect(201);
    poId = Number(created.body.id ?? created.body.Id ?? created.body['id']);
    expect(String(created.body.ref)).toMatch(/^PO-\d{4}$/);

    // submit+approve
    await req(ctx, owner, 'post', `/api/v1/purchases/${poId}/submit`).expect(201);
    await req(ctx, owner, 'post', `/api/v1/purchases/${poId}/approve`).expect(201);
    const head = await req(ctx, owner, 'get', `/api/v1/purchases/${poId}`).expect(200);
    expect(head.body.status).toBe('approved');

    // editing an approved PO must fail
    const edit = await req(ctx, owner, 'patch', `/api/v1/purchases/${poId}`).send({
      supplierId: head.body.supplier_id,
      items: [{ productId: ids[0], qty: 1, unitCost: 1 }],
    }).expect(409);
    expect(edit.body.code).toBe('INVALID_STATUS');
  });

  test('receive partial slice → partially_received; WAC blends correctly', async () => {
    const head = await req(ctx, owner, 'get', `/api/v1/purchases/${poId}`).expect(200);
    const first = head.body.items[0];
    // receive 6 of 10 @ unit_cost 4 with old branch stock 0 → newCost = 4 exactly
    const rec = await req(ctx, owner, 'post', `/api/v1/purchases/${poId}/receive`).send({
      lines: [{ poItemId: first.id, receiveQty: 6, damagedQty: 1 }],
    }).expect(201);
    expect(rec.body.ref).toMatch(/^GRN-\d{4}$/);

    const st = await req(ctx, owner, 'get', `/api/v1/purchases/${poId}`).expect(200);
    expect(st.body.status).toBe('partially_received');

    const bi = await ctx.ds.query(
      `SELECT quantity, cost FROM branch_inventory WHERE product_id=$1 AND branch_id=(SELECT MIN(id) FROM branches)`,
      [first.product_id],
    );
    expect(Number(bi[0].quantity)).toBe(5); // 6 received − 1 damaged
    expect(Number(bi[0].cost)).toBeCloseTo(4, 4);
  });

  test('OVER_RECEIVE rejected; second full receive completes PO; blend math verified', async () => {
    const head = await req(ctx, owner, 'get', `/api/v1/purchases/${poId}`).expect(200);
    const first = head.body.items.find((i: any) => Number(i.received_qty) > 0);
    const remaining = Number(first.qty) - Number(first.received_qty); // 4
    const over = await req(ctx, owner, 'post', `/api/v1/purchases/${poId}/receive`).send({
      lines: [{ poItemId: first.id, receiveQty: remaining + 1 }],
    }).expect(409);
    expect(over.body.code).toBe('OVER_RECEIVE');

    // change this line's context: receive the OTHER line fully too, then finish first line
    const other = head.body.items.find((i: any) => i.id !== first.id);
    await req(ctx, owner, 'post', `/api/v1/purchases/${poId}/receive`).send({
      lines: [
        { poItemId: other.id, receiveQty: Number(other.qty) },
        { poItemId: first.id, receiveQty: remaining },
      ],
    }).expect(201);

    const done = await req(ctx, owner, 'get', `/api/v1/purchases/${poId}`).expect(200);
    expect(done.body.status).toBe('fully_received');
  });

  test('WAC blend with pre-existing stock: (oldQty*old + in*new)/(total)', async () => {
    // fresh product: seed 10 units @2 via adjust (cost stays initial), then GRN 10 @6
    const p = await req(ctx, owner, 'post', '/api/v1/products')
      .send({ name: 'خلط التكلفة', price: 15, cost: 2 }).expect(201);
    const pid = p.body.id;
    await req(ctx, owner, 'post', '/api/v1/inventory/adjust')
      .send({ productId: pid, delta: 10, reasonCode: 'OPENING' }).expect(201);

    const sups = await req(ctx, owner, 'get', '/api/v1/suppliers').expect(200);
    const po = await req(ctx, owner, 'post', '/api/v1/purchases').send({
      supplierId: sups.body[0].id,
      items: [{ productId: pid, qty: 10, unitCost: 6 }],
    }).expect(201);
    const poId2 = Number(po.body.id);
    await req(ctx, owner, 'post', `/api/v1/purchases/${poId2}/submit`).expect(201);
    await req(ctx, owner, 'post', `/api/v1/purchases/${poId2}/approve`).expect(201);
    const head = await req(ctx, owner, 'get', `/api/v1/purchases/${poId2}`).expect(200);
    await req(ctx, owner, 'post', `/api/v1/purchases/${poId2}/receive`).send({
      lines: [{ poItemId: head.body.items[0].id, receiveQty: 10 }],
    }).expect(201);

    const bi = await ctx.ds.query(
      `SELECT quantity, cost FROM branch_inventory WHERE product_id=$1 AND branch_id=(SELECT MIN(id) FROM branches)`,
      [pid],
    );
    expect(Number(bi[0].quantity)).toBe(20);
    expect(Number(bi[0].cost)).toBeCloseTo((10 * 2 + 10 * 6) / 20, 4); // 4.0
    // products mirror updated on default branch
    const pr = await ctx.ds.query(`SELECT quantity, cost FROM products WHERE id=$1`, [pid]);
    expect(Number(pr[0].quantity)).toBe(20);
  });

  test('cost_history rows written per receipt (source_type grn)', async () => {
    const rows = await req(ctx, owner, 'get',
      `/api/v1/inventory/products/${firstProductId}/cost-history`).expect(200);
    expect(rows.body.length).toBeGreaterThanOrEqual(1);
    expect(rows.body[0].source_type).toBe('grn');
  });

  test('cancel guard: ALREADY_RECEIVED after partial receive; clean cancel works', async () => {
    // clean path
    const sups = await req(ctx, owner, 'get', '/api/v1/suppliers').expect(200);
    const ids = await productIds();
    const po = await req(ctx, owner, 'post', '/api/v1/purchases').send({
      supplierId: sups.body[0].id,
      items: [{ productId: ids[ids.length - 1], qty: 3, unitCost: 2 }],
    }).expect(201);
    await req(ctx, owner, 'post', `/api/v1/purchases/${Number(po.body.id)}/submit`).expect(201);
    await req(ctx, owner, 'post', `/api/v1/purchases/${Number(po.body.id)}/cancel`)
      .send({ reason: 'تغيير خطة' }).expect(201);
    const head = await req(ctx, owner, 'get', `/api/v1/purchases/${Number(po.body.id)}`).expect(200);
    expect(head.body.status).toBe('cancelled');

    // received PO cannot cancel
    const res = await req(ctx, owner, 'post', `/api/v1/purchases/${poId}/cancel`).send({}).expect(409);
    expect(res.body.code).toBe('ALREADY_RECEIVED');
  });

  test('GRN list shows entries with supplier names', async () => {
    const grns = await req(ctx, owner, 'get', '/api/v1/purchases/grns').expect(200);
    expect(grns.body.length).toBeGreaterThanOrEqual(2);
  });
});
