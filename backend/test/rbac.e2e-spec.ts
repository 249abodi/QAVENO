import { login, req, resetDb, startTestBackend, TestCtx } from './bootstrap-pg';

const bcrypt = require('bcryptjs');

async function mkUser(ctx: TestCtx, ownerToken: string, username: string, role: string,
  branches: number[] = [], primary?: number) {
  const res = await ctx.api().post('/api/v1/users')
    .set('Authorization', `Bearer ${ownerToken}`)
    .send({
      username, password: `${username}Pass1!`, role,
      displayName: username,
      branches: branches.map((b) => ({ branchId: b, isPrimary: b === (primary ?? branches[0]) })),
    });
  expect([200, 201]).toContain(res.status);
  return res.body as { id: number };
}

describe('RBAC + branch authorization (real PostgreSQL)', () => {
  let ctx: TestCtx;
  let owner: { token: string };
  let branchB = 0;

  beforeAll(async () => {
    ctx = await startTestBackend();
    await resetDb(ctx.ds);
    owner = await login(ctx, await setupOwnerAndGet(), 'OwnerPass1!');
    async function setupOwnerAndGet(): Promise<string> {
      await ctx.api().post('/api/v1/auth/setup-owner').send({ username: 'owner', password: 'OwnerPass1!' }).expect((r) => {
        if (![200, 201].includes(r.status)) throw new Error(JSON.stringify(r.body));
      });
      return 'owner';
    }
    const b = await ctx.api().post('/api/v1/branches')
      .set('Authorization', `Bearer ${owner.token}`)
      .send({ name: 'الفرع الشمالي', code: 'NORTH' });
    expect(b.status).toBe(201);
    branchB = b.body.id;
  }, 300000);

  afterAll(async () => {
    if (ctx) await ctx.stop();
  }, 120000);

  test('DUPLICATE_CODE rejected on branch create', async () => {
    const res = await ctx.api().post('/api/v1/branches')
      .set('Authorization', `Bearer ${owner.token}`).send({ name: 'آخر', code: 'NORTH' });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('DUPLICATE_CODE');
  });

  test('cashier without assignments gets NO_BRANCH_ACCESS on any request', async () => {
    await mkUser(ctx, owner.token, 'nocash', 'cashier', []);
    const s = await login(ctx, 'nocash', 'nocashPass1!');
    const res = await req(ctx, s, 'get', '/api/v1/products').expect(403);
    expect(res.body.code).toBe('NO_BRANCH_ACCESS');
  });

  test('scoped cashier can use assigned branch only; other branch → NO_BRANCH_ACCESS', async () => {
    await mkUser(ctx, owner.token, 'bcash', 'cashier', [branchB]);
    const s = await login(ctx, 'bcash', 'bcashPass1!');
    // context defaults to primary assignment
    const mine = await req(ctx, s, 'get', '/api/v1/branches/mine').expect(200);
    expect(mine.body.map((b: any) => Number(b.id))).toEqual([branchB]);
    // explicit header for unassigned branch (default=1) is rejected
    const res = await ctx.api().get('/api/v1/products')
      .set('Authorization', `Bearer ${s.token}`).set('X-Branch-Id', '1').expect(403);
    expect(res.body.code).toBe('NO_BRANCH_ACCESS');
    // own branch passes
    await ctx.api().get('/api/v1/products')
      .set('Authorization', `Bearer ${s.token}`).set('X-Branch-Id', String(branchB)).expect(200);
  });

  test('permission matrix: cashier blocked from branches.manage & users.manage', async () => {
    await mkUser(ctx, owner.token, 'plainc', 'cashier', [branchB]);
    const s = await login(ctx, 'plainc', 'plaincPass1!');
    const r1 = await req(ctx, s, 'post', '/api/v1/branches').send({ name: 'x' }).expect(403);
    expect(r1.body.code).toBe('FORBIDDEN');
    await req(ctx, s, 'get', '/api/v1/users').expect(403);
    // manager CAN read branches but NOT approve purchases
    await mkUser(ctx, owner.token, 'mgr1', 'manager', [branchB]);
    const m = await login(ctx, 'mgr1', 'mgr1Pass1!');
    await req(ctx, m, 'get', '/api/v1/branches').expect(200);
    await req(ctx, m, 'get', '/api/v1/users').expect(403);
  });

  test('LAST_OWNER: cannot demote/disable the only active owner', async () => {
    const users = await req(ctx, owner, 'get', '/api/v1/users').expect(200);
    const ownerId = users.body.find((u: any) => u.role === 'owner' && u.username === 'owner').id;
    const res = await req(ctx, owner, 'patch', `/api/v1/users/${ownerId}`)
      .send({ role: 'manager' }).expect(409);
    expect(res.body.code).toBe('LAST_OWNER');
    const res2 = await req(ctx, owner, 'patch', `/api/v1/users/${ownerId}`)
      .send({ status: 'disabled' }).expect(409);
    expect(res2.body.code).toBe('LAST_OWNER');
  });

  test('users.create USERNAME_TAKEN (case-insensitive)', async () => {
    await mkUser(ctx, owner.token, 'dupme', 'manager', [branchB]);
    const res = await ctx.api().post('/api/v1/users')
      .set('Authorization', `Bearer ${owner.token}`)
      .send({ username: 'DUPME', password: 'Whatever1!', role: 'cashier' })
      .expect(409);
    expect(res.body.code).toBe('USERNAME_TAKEN');
  });

  test('scoped user cannot lose last branch (LAST_BRANCH)', async () => {
    const u = await mkUser(ctx, owner.token, 'lastb', 'manager', [branchB]);
    const res = await req(ctx, owner, 'patch', `/api/v1/users/${u.id}`)
      .send({ branches: [] }).expect(409);
    expect(res.body.code).toBe('LAST_BRANCH');
  });

  test('reset-password forces must_change_password and revokes refresh tokens', async () => {
    const u = await mkUser(ctx, owner.token, 'resetpw', 'manager', [branchB]);
    const s = await login(ctx, 'resetpw', 'resetpwPass1!');
    await req(ctx, owner, 'post', `/api/v1/users/${u.id}/reset-password`)
      .send({ newPassword: 'NewSecret99!' }).expect(201);
    // old access token still valid (short TTL by design) but refresh must be revoked
    const r = await ctx.api().post('/api/v1/auth/refresh').send({ refreshToken: s.refreshToken }).expect(401);
    expect(r.body.code).toBe('REFRESH_INVALID');
    // new password works
    const relogin = await login(ctx, 'resetpw', 'NewSecret99!');
    expect(relogin.user.mustChangePassword).toBe(true);
  });

  test('disabled user cannot login (ACCOUNT_DISABLED) even with correct password', async () => {
    const u = await mkUser(ctx, owner.token, 'goneuser', 'manager', [branchB]);
    await req(ctx, owner, 'patch', `/api/v1/users/${u.id}`).send({ status: 'disabled' }).expect(200);
    const res = await ctx.api().post('/api/v1/auth/login').send({ username: 'goneuser', password: 'goneuserPass1!' });
    expect(res.status).toBe(401);
    expect(res.body.code).toBe('ACCOUNT_DISABLED');
  });

  test('audit log records sensitive actions (user.create / branch.create)', async () => {
    const rows = await req(ctx, owner, 'get', '/api/v1/audit?action=user.create').expect(200);
    expect(rows.body.total).toBeGreaterThanOrEqual(1);
  });

  test('bcrypt hash format used for stored passwords', async () => {
    const rows = await ctx.ds.query(`SELECT password_hash FROM users WHERE username='owner'`);
    expect(rows[0].password_hash.startsWith('$2')).toBe(true);
  });

  test('lockout counter resets after successful login', async () => {
    await mkUser(ctx, owner.token, 'counter', 'manager', [branchB]);
    for (let i = 0; i < 4; i++) {
      await ctx.api().post('/api/v1/auth/login').send({ username: 'counter', password: 'wrongwrong' });
    }
    const okLogin = await login(ctx, 'counter', 'counterPass1!'); // 5th attempt succeeds
    expect(okLogin.accessToken).toBeTruthy();
    const row = await ctx.ds.query(`SELECT failed_attempts FROM users WHERE username='counter'`);
    expect(Number(row[0].failed_attempts)).toBe(0);
  });
});
