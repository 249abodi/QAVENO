import { login, req, resetDb, seedOwner, startTestBackend, TestCtx } from './bootstrap-pg';

describe('smoke: boot + auth basics (real PostgreSQL)', () => {
  let ctx: TestCtx;
  let owner: { token: string };

  beforeAll(async () => {
    ctx = await startTestBackend();
    await resetDb(ctx.ds);
  }, 300000);

  afterAll(async () => {
    if (ctx) await ctx.stop();
  }, 120000);

  test('health is public and reports db up', async () => {
    const res = await ctx.api().get('/api/v1/health');
    expect(res.status).toBe(200);
    expect(res.body.db).toBe('up');
    expect(res.body.status).toBe('ok');
  });

  test('setup-owner works once then 409', async () => {
    const first = await ctx.api().post('/api/v1/auth/setup-owner')
      .send({ username: 'owner', password: 'OwnerPass1!', displayName: 'المالك' });
    expect([200, 201]).toContain(first.status);
    const second = await ctx.api().post('/api/v1/auth/setup-owner')
      .send({ username: 'other', password: 'OtherPass1!' });
    expect(second.status).toBe(409);
    expect(second.body.code).toBe('SETUP_ALREADY_DONE');
  });

  test('login returns tokens; bad credentials 401 INVALID_CREDENTIALS', async () => {
    const ok = await login(ctx, 'OWNER', 'OwnerPass1!'); // case-insensitive username
    expect(ok.accessToken).toBeTruthy();
    expect(ok.refreshToken).toBeTruthy();
    const bad = await ctx.api().post('/api/v1/auth/login').send({ username: 'owner', password: 'wrong' });
    expect(bad.status).toBe(401);
    expect(bad.body.code).toBe('INVALID_CREDENTIALS');
    owner = { token: ok.accessToken };
  });

  test('/auth/me returns owner permissions incl. branches.manage', async () => {
    const res = await ctx.api().get('/api/v1/auth/me').set('Authorization', `Bearer ${owner.token}`);
    expect(res.status).toBe(200);
    expect(res.body.user.role).toBe('owner');
    expect(res.body.permissions).toContain('branches.manage');
    expect(res.body.branches.length).toBe(1);
    expect(res.body.branches[0].name).toBe('الفرع الرئيسي');
  });

  test('protected route without token → 401 envelope', async () => {
    const res = await ctx.api().get('/api/v1/products');
    expect(res.status).toBe(401);
    expect(res.body.code).toBe('UNAUTHORIZED');
  });

  test('refresh rotates tokens; old refresh becomes invalid', async () => {
    const s = await login(ctx, 'owner', 'OwnerPass1!');
    const r1 = await ctx.api().post('/api/v1/auth/refresh').send({ refreshToken: s.refreshToken });
    expect(r1.status).toBe(200);
    const r2 = await ctx.api().post('/api/v1/auth/refresh').send({ refreshToken: s.refreshToken });
    expect(r2.status).toBe(401);
    // new pair still valid for API access
    const me = await req(ctx, { token: r1.body.accessToken } as never, 'get', '/api/v1/auth/me').expect(200);
    expect(me.body.user.username).toBe('owner');
  });

  test('account lockout after 5 failures (ACCOUNT_LOCKED)', async () => {
    await resetDb(ctx.ds);
    await seedOwner(ctx);
    await ctx.api().post('/api/v1/auth/setup-owner').send({});
    const u = await ctx.ds.query(
      `INSERT INTO users (username, display_name, password_hash, role)
       VALUES ('cashier1','كاشير','$2a$10$abcdefghijklmnopqrstuvABCDEFGHIJKLMNOP0123456789012345678','cashier')
       RETURNING id`,
    );
    void u;
    // hash of CashierPass1!
    const hash = require('bcryptjs').hashSync('CashierPass1!', 10);
    await ctx.ds.query(`UPDATE users SET password_hash=$1 WHERE username='cashier1'`, [hash]);
    for (let i = 0; i < 5; i++) {
      const res = await ctx.api().post('/api/v1/auth/login').send({ username: 'cashier1', password: 'nope-nope' });
      expect(res.status).toBe(401);
    }
    const locked = await ctx.api().post('/api/v1/auth/login').send({ username: 'cashier1', password: 'CashierPass1!' });
    expect(locked.status).toBe(401);
    expect(locked.body.code).toBe('ACCOUNT_LOCKED');
  });
});
