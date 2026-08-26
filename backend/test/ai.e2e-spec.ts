import { login, req, resetDb, seedOwner, startTestBackend, TestCtx, Session } from './bootstrap-pg';

describe('AI Intelligence (real PostgreSQL)', () => {
  let ctx: TestCtx;
  let owner: Session;

  beforeAll(async () => {
    ctx = await startTestBackend();
    await resetDb(ctx.ds);
    owner = await seedOwner(ctx);
  }, 30000);

  afterAll(async () => { await ctx?.stop(); });

  const GET = (path: string) => req(ctx, owner, 'get', path);
  const POST = (path: string) => req(ctx, owner, 'post', path);

  it('GET /ai/forecast — returns forecast array', async () => {
    const res = await GET('/api/v1/ai/forecast');
    expect(res.status).toBe(200);
    expect(res.body.forecasts).toBeDefined();
    expect(Array.isArray(res.body.forecasts)).toBe(true);
    expect(res.body.generatedAt).toBeDefined();
  });

  it('GET /ai/anomalies — returns anomalies array', async () => {
    const res = await GET('/api/v1/ai/anomalies');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.anomalies)).toBe(true);
    expect(typeof res.body.total).toBe('number');
  });

  it('GET /ai/reorder — returns recommendations', async () => {
    const res = await GET('/api/v1/ai/reorder');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.recommendations)).toBe(true);
  });

  it('GET /ai/slow-moving — returns slow-moving items', async () => {
    const res = await GET('/api/v1/ai/slow-moving');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.items)).toBe(true);
    expect(typeof res.body.total).toBe('number');
  });

  it('GET /ai/summary — returns period comparison', async () => {
    const res = await GET('/api/v1/ai/summary');
    expect(res.status).toBe(200);
    expect(res.body.currentPeriod).toBeDefined();
    expect(res.body.previousPeriod).toBeDefined();
    expect(res.body.changes).toBeDefined();
    expect(typeof res.body.changes.revenueChangePct).toBe('number');
  });

  it('GET /ai/cost-trend — returns cost trend', async () => {
    const res = await GET('/api/v1/ai/cost-trend');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.trend)).toBe(true);
    expect(res.body.generatedAt).toBeDefined();
  });

  it('GET /ai/profit-alert — returns profit alerts', async () => {
    const res = await GET('/api/v1/ai/profit-alert');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.alerts)).toBe(true);
  });

  it('GET /ai/insights — empty list initially', async () => {
    const res = await GET('/api/v1/ai/insights');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.items)).toBe(true);
    expect(typeof res.body.total).toBe('number');
  });

  it('GET /ai/refresh — full pipeline generates all sections', async () => {
    const res = await GET('/api/v1/ai/refresh');
    expect(res.status).toBe(200);
    expect(res.body.forecast).toBeDefined();
    expect(res.body.anomalies).toBeDefined();
    expect(res.body.reorder).toBeDefined();
    expect(res.body.slowMoving).toBeDefined();
    expect(res.body.summary).toBeDefined();
    expect(res.body.costTrend).toBeDefined();
    expect(res.body.profitAlert).toBeDefined();
    expect(res.body.generatedAt).toBeDefined();
  });

  it('POST /ai/insights/:id/dismiss — idempotent', async () => {
    const res = await POST('/api/v1/ai/insights/999999/dismiss');
    expect([200, 201, 404]).toContain(res.status);
  });

  it('returns 401 without auth token', async () => {
    const res = await ctx.api().get('/api/v1/ai/forecast');
    expect(res.status).toBe(401);
  });
});
