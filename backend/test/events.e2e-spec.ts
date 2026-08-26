import { io, Socket } from 'socket.io-client';
import { startTestBackend, resetDb, seedOwner, login, req, TestCtx, Session } from './bootstrap-pg';

jest.setTimeout(300000);

/** Phase 26 gate: real-time delivery over authenticated, branch-aware rooms. */

function connect(port: number, token: string | null): Promise<{ socket: Socket; ack?: Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    const socket = io(`http://127.0.0.1:${port}`, {
      path: '/ws',
      transports: ['websocket'],
      auth: { token: token ?? undefined },
      reconnection: false,
      timeout: 6000,
    });
    const to = setTimeout(() => reject(new Error('connect timeout')), 8000);
    socket.on('connected', (info) => { clearTimeout(to); resolve({ socket, ack: info }); });
    socket.on('auth_error', () => { clearTimeout(to); resolve({ socket }); });
  });
}

function waitFor(socket: Socket, event: string, ms = 6000): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`timeout waiting for ${event}`)), ms);
    socket.once(event, (p) => { clearTimeout(t); resolve(p as Record<string, unknown>); });
  });
}

function expectSilence(socket: Socket, event: string, ms = 1200): Promise<void> {
  return new Promise((resolve) => {
    const h = () => {};
    socket.once(event, h);
    setTimeout(() => { socket.off(event, h); resolve(); }, ms);
  });
}

describe('real-time events (real PostgreSQL + socket.io)', () => {
  let ctx: TestCtx;
  let owner: Session;
  let port = 0;
  let wsProductId = 0;

  beforeAll(async () => {
    ctx = await startTestBackend();
    await resetDb(ctx.ds);
    owner = await seedOwner(ctx);
    // second branch for scoping tests
    await req(ctx, owner, 'post', '/api/v1/branches')
      .send({ name: 'فرع الشبكة', code: 'NET' }).expect(201);
    // real listener required for websockets (supertest alone cannot carry WS)
    await ctx.app.listen(0);
    port = (ctx.app.getHttpServer().address() as { port: number }).port;
  }, 300000);

  afterAll(async () => {
    if (ctx) await ctx.stop();
  }, 120000);

  async function mkUser(role: string, branchIds: number[], username: string): Promise<Session> {
    const res = await req(ctx, owner, 'post', '/api/v1/users').send({
      username,
      password: 'UserPass1!',
      displayName: username,
      role,
      branches: branchIds.map((b) => ({ branchId: b, isPrimary: b === branchIds[0] })),
    }).expect(201);
    return login(ctx, username, 'UserPass1!');
  }

  test('rejects connection without a token', async () => {
    const { socket, ack } = await connect(port, null);
    expect(ack).toBeUndefined();
    socket.close();
  });

  test('rejects connection with an invalid token', async () => {
    const { socket, ack } = await connect(port, 'garbage.token.here');
    expect(ack).toBeUndefined();
    socket.close();
  });

  test('owner connects and is assigned all active branch rooms', async () => {
    const { socket, ack } = await connect(port, owner.token!);
    expect(ack).toBeTruthy();
    expect(Number(ack!.userId)).toBe(owner.user.id);
    expect(ack!.role).toBe('owner');
    expect([...(ack!.branches as number[])].sort()).toEqual([1, 2]);
    socket.close();
  });

  test('owner receives sale.created emitted by another checkout', async () => {
    const p = await req(ctx, owner, 'post', '/api/v1/products')
      .send({ name: 'صدمة بث', price: 15, cost: 7 }).expect(201);
    wsProductId = Number(p.body.id);
    await req(ctx, owner, 'post', '/api/v1/inventory/adjust')
      .send({ productId: p.body.id, delta: 50, reasonCode: 'OPENING' }).expect(201);

    const { socket } = await connect(port, owner.token!);
    const listening = waitFor(socket, 'sale.created');
    await req(ctx, owner, 'post', '/api/v1/sales/checkout')
      .send({ items: [{ productId: p.body.id, quantity: 1 }], paid: 100 }).expect(201);
    const payload = await listening;
    expect(String(payload.invoiceNo)).toMatch(/^INV-\d{4}$/);
    expect(Number(payload.branchId)).toBe(1);
    expect(Number(payload.total)).toBeCloseTo(17.25, 2); // 15 + 15% tax
    socket.close();
  });

  test('scoped cashier receives own-branch sale but NOT other branches', async () => {
    const cashierA = await mkUser('cashier', [2], 'ws_cashier_a');
    const { socket } = await connect(port, cashierA.token!);

    // branch 1 checkout → silence
    const silence = expectSilence(socket, 'sale.created');
    await req(ctx, owner, 'post', '/api/v1/sales/checkout')
      .send({ items: [{ productId: wsProductId, quantity: 1 }], paid: 500 }).expect(201);
    await silence;

    // stock the product at branch 2, then checkout there → delivered
    await req(ctx, owner, 'post', '/api/v1/inventory/adjust')
      .set('X-Branch-Id', '2')
      .send({ productId: wsProductId, delta: 5, reasonCode: 'OPENING' }).expect(201);
    const listening = waitFor(socket, 'sale.created');
    await req(ctx, owner, 'post', '/api/v1/sales/checkout')
      .set('X-Branch-Id', '2')
      .send({ items: [{ productId: wsProductId, quantity: 1 }], paid: 500 }).expect(201);
    const payload = await listening;
    expect(Number(payload.branchId)).toBe(2);
    socket.close();
  });

  test('client-emitted events are dropped by the server (no trust)', async () => {
    const cashierB = await mkUser('cashier', [1], 'ws_cashier_b');
    const { socket: emitter } = await connect(port, cashierB.token!);
    const { socket: observer } = await connect(port, owner.token!);

    const silence = Promise.all([
      expectSilence(observer, 'sale.created'),
      expectSilence(observer, 'inventory.updated'),
      expectSilence(observer, 'transfer.received'),
    ]);
    emitter.emit('sale.created', { fake: true });
    emitter.emit('inventory.updated', { fake: true });
    emitter.emit('transfer.received', { fake: true });
    emitter.emit('arbitrary:event', { fake: true });
    await silence;
    emitter.close();
    observer.close();
  });

  test('purchase.received reaches the receiving branch listeners', async () => {
    const sup = await req(ctx, owner, 'post', '/api/v1/suppliers')
      .send({ name: 'مورد البث' }).expect(201);
    const p = await req(ctx, owner, 'post', '/api/v1/products')
      .send({ name: 'منتج استلام', price: 30, cost: 0 }).expect(201);
    const po = await req(ctx, owner, 'post', '/api/v1/purchases').send({
      supplierId: sup.body.id,
      items: [{ productId: p.body.id, qty: 5, unitCost: 8 }],
    }).expect(201);
    await req(ctx, owner, 'post', `/api/v1/purchases/${po.body.id}/submit`).expect(201);
    await req(ctx, owner, 'post', `/api/v1/purchases/${po.body.id}/approve`).expect(201);
    const head = await req(ctx, owner, 'get', `/api/v1/purchases/${po.body.id}`).expect(200);

    const { socket } = await connect(port, owner.token!);
    const listening = waitFor(socket, 'purchase.received');
    await req(ctx, owner, 'post', `/api/v1/purchases/${po.body.id}/receive`).send({
      lines: [{ poItemId: head.body.items[0].id, receiveQty: 5 }],
    }).expect(201);
    const payload = await listening;
    expect(payload.ref).toMatch(/^GRN-\d{4}$/);
    expect(Number(payload.branchId)).toBe(1);
    expect(String(payload.poRef)).toMatch(/^PO-\d{4}$/);
    socket.close();
  });

  test('inventory.updated fires on adjustment and on reconciliation confirm', async () => {
    const p = await req(ctx, owner, 'post', '/api/v1/products')
      .send({ name: 'جرد مباشر', price: 5, cost: 2 }).expect(201);

    const { socket } = await connect(port, owner.token!);
    const first = waitFor(socket, 'inventory.updated');
    await req(ctx, owner, 'post', '/api/v1/inventory/adjust')
      .send({ productId: p.body.id, delta: 4, reasonCode: 'OPENING' }).expect(201);
    const ev1 = await first;
    expect(ev1.source).toBe('adjust');
    expect(Number(ev1.quantity)).toBe(4);

    const open = await req(ctx, owner, 'post', '/api/v1/inventory/reconciliations')
      .send({ productId: p.body.id, countedQty: 9, reasonCode: 'COUNT' }).expect(201);
    const second = waitFor(socket, 'inventory.updated');
    await req(ctx, owner, 'post', `/api/v1/inventory/reconciliations/${open.body.id}/confirm`).expect(201);
    const ev2 = await second;
    expect(ev2.source).toBe('reconciliation');
    expect(Number(ev2.quantity)).toBe(9);
    socket.close();
  });

  test('transfer.dispatched reaches destination-scoped manager; transfer.received reaches source-scoped cashier', async () => {
    const managerDst = await mkUser('manager', [2], 'ws_mgr_dst');
    const cashierSrc = await mkUser('cashier', [1], 'ws_cash_src');

    const p = await req(ctx, owner, 'post', '/api/v1/products')
      .send({ name: 'تحويل بث', price: 12, cost: 6 }).expect(201);
    await req(ctx, owner, 'post', '/api/v1/inventory/adjust')
      .send({ productId: p.body.id, delta: 6, reasonCode: 'OPENING' }).expect(201);
    const tr = await req(ctx, owner, 'post', '/api/v1/transfers').send({
      sourceBranchId: 1, destBranchId: 2,
      items: [{ productId: p.body.id, qty: 3 }],
    }).expect(201);
    const trId = Number(tr.body.id);
    await req(ctx, owner, 'post', `/api/v1/transfers/${trId}/submit`).expect(201);
    await req(ctx, owner, 'post', `/api/v1/transfers/${trId}/approve`).expect(201);
    const detail = await req(ctx, owner, 'get', `/api/v1/transfers/${trId}`).expect(200);
    const item = detail.body.items[0];

    const mConn = await connect(port, managerDst.token!);
    const cConn = await connect(port, cashierSrc.token!);
    const dispatched = waitFor(mConn.socket, 'transfer.dispatched');
    await req(ctx, owner, 'post', `/api/v1/transfers/${trId}/dispatch`)
      .send({ lines: [{ itemId: item.id, qty: 3 }] }).expect(201);
    const dPayload = await dispatched;
    expect(Number(dPayload.from)).toBe(1);
    expect(Number(dPayload.to)).toBe(2);

    const received = waitFor(cConn.socket, 'transfer.received');
    await req(ctx, owner, 'post', `/api/v1/transfers/${trId}/receive`)
      .send({ lines: [{ itemId: item.id, qty: 3 }] }).expect(201);
    const rPayload = await received;
    expect(rPayload.status).toBe('received');
    expect(Number(rPayload.to)).toBe(2);
    mConn.socket.close();
    cConn.socket.close();
  });

  test('disabled user token stops working for new connections immediately', async () => {
    const u = await mkUser('cashier', [1], 'ws_disable_me');
    const first = await connect(port, u.token!);
    expect(first.ack).toBeTruthy();
    first.socket.close();

    await req(ctx, owner, 'patch', `/api/v1/users/${u.user.id}`)
      .send({ status: 'disabled' }).expect(200);

    const second = await connect(port, u.token!);
    expect(second.ack).toBeUndefined();
    second.socket.close();
  });
});
