import { INestApplication, ValidationPipe } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { startTestBackend, seedOwner, TestCtx, req, Session, resetDb } from './bootstrap-pg';
import { AllExceptionsFilter } from '../src/common/all-exceptions.filter';
import { OrganizationSubscription } from '../src/database/entities';

let ctx: TestCtx;
let app: INestApplication;
let ds: DataSource;
let owner: Session;

beforeAll(async () => {
  ctx = await startTestBackend();
  app = ctx.app;
  ds = ctx.ds;
  await resetDb(ds);
  owner = await seedOwner(ctx);
}, 60_000);

afterAll(async () => { await ctx.stop(); }, 30_000);

// ── Helpers ──────────────────────────────────────────────────────────

async function createOrg(name: string) {
  const res = await req(ctx, owner, 'post', '/api/v1/owner/organizations')
    .send({ name });
  expect(res.status).toBe(201);
  return res.body;
}

async function createPlan(slug: string, overrides: Record<string, unknown> = {}) {
  const res = await req(ctx, owner, 'post', '/api/v1/owner/plans')
    .send({
      name: `Plan ${slug}`, slug, description: `Test plan ${slug}`,
      priceMonthly: 49.99, priceYearly: 499.99, currency: 'USD',
      trialDays: 0, maxUsers: 10, maxBranches: 5, maxProducts: 1000,
      features: { products: true, inventory: true, sales: true, purchases: true, transfers: true, reports: true, pos: true },
      sortOrder: 10,
      ...overrides,
    });
  expect(res.status).toBe(201);
  return res.body;
}

// ── 1. Owner Authentication & Authorization ──────────────────────────

describe('Owner Authentication', () => {
  it('dashboard requires platform.manage permission', async () => {
    const res = await req(ctx, owner, 'get', '/api/v1/owner/dashboard');
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('totalOrgs');
  });

  it('returns 401 without token', async () => {
    const res = await ctx.api().get('/api/v1/owner/dashboard');
    expect(res.status).toBe(401);
  });
});

describe('Owner Authorization - Normal users cannot access owner panel', () => {
  let admin: Session;

  beforeAll(async () => {
    // Create an admin user via the users API
    const createRes = await req(ctx, owner, 'post', '/api/v1/users')
      .send({ username: 'admintest', password: 'AdminPass1!', displayName: 'Admin Test', role: 'admin' });
    if (createRes.status === 201 || createRes.status === 200) {
      admin = await (await import('./bootstrap-pg')).login(ctx, 'admintest', 'AdminPass1!');
    } else {
      // Fallback: try to login in case user already exists
      admin = await (await import('./bootstrap-pg')).login(ctx, 'admintest', 'AdminPass1!');
    }
  });

  it('admin cannot access owner dashboard', async () => {
    const res = await req(ctx, admin, 'get', '/api/v1/owner/dashboard');
    expect(res.status).toBe(403);
  });

  it('admin cannot list organizations', async () => {
    const res = await req(ctx, admin, 'get', '/api/v1/owner/organizations');
    expect(res.status).toBe(403);
  });

  it('admin cannot create plans', async () => {
    const res = await req(ctx, admin, 'post', '/api/v1/owner/plans')
      .send({ name: 'Test', slug: 'test-forbidden' });
    expect(res.status).toBe(403);
  });

  it('admin cannot create licenses', async () => {
    const res = await req(ctx, admin, 'post', '/api/v1/owner/licenses/create')
      .send({ organizationId: 1, planId: 1 });
    expect(res.status).toBe(403);
  });

  it('admin cannot access usage stats', async () => {
    const res = await req(ctx, admin, 'get', '/api/v1/owner/usage');
    expect(res.status).toBe(403);
  });

  it('admin cannot access usage stats summary', async () => {
    const res = await req(ctx, admin, 'get', '/api/v1/owner/usage/stats');
    expect(res.status).toBe(403);
  });
});

// ── 2. Dashboard ─────────────────────────────────────────────────────

describe('Owner Dashboard', () => {
  it('returns dashboard stats', async () => {
    const res = await req(ctx, owner, 'get', '/api/v1/owner/dashboard');
    expect(res.status).toBe(200);
    expect(typeof res.body.totalOrgs).toBe('number');
    expect(typeof res.body.activeOrgs).toBe('number');
    expect(typeof res.body.suspendedOrgs).toBe('number');
    expect(Array.isArray(res.body.recentActivity)).toBe(true);
  });
});

// ── 3. Organization Management ───────────────────────────────────────

describe('Organization Management', () => {
  let org: any;

  it('creates an organization', async () => {
    org = await createOrg('Test Organization');
    expect(org).toHaveProperty('id');
    expect(org.name).toBe('Test Organization');
    expect(org.status).toBe('active');
  });

  it('lists organizations', async () => {
    const res = await req(ctx, owner, 'get', '/api/v1/owner/organizations');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body.length).toBeGreaterThanOrEqual(1);
  });

  it('gets organization detail', async () => {
    const res = await req(ctx, owner, 'get', `/api/v1/owner/organizations/${org.id}`);
    expect(res.status).toBe(200);
    expect(res.body.organization.id).toBe(org.id);
    expect(res.body).toHaveProperty('subscription');
    expect(res.body).toHaveProperty('plan');
    expect(res.body).toHaveProperty('usage');
  });

  it('updates organization status', async () => {
    const res = await req(ctx, owner, 'patch', `/api/v1/owner/organizations/${org.id}/status`)
      .send({ status: 'suspended', reason: 'Test suspension' });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });

  it('returns 404 for non-existent org', async () => {
    const res = await req(ctx, owner, 'get', '/api/v1/owner/organizations/99999');
    expect(res.status).toBe(404);
  });

  it('rejects invalid status', async () => {
    const res = await req(ctx, owner, 'patch', `/api/v1/owner/organizations/${org.id}/status`)
      .send({ status: 'invalid_status' });
    expect(res.status).toBe(400);
  });

  // Restore org for further tests
  afterAll(async () => {
    await req(ctx, owner, 'patch', `/api/v1/owner/organizations/${org.id}/status`)
      .send({ status: 'active' });
  });
});

// ── 4. Plan Management ───────────────────────────────────────────────

describe('Plan Management', () => {
  let plan: any;

  it('creates a plan', async () => {
    plan = await createPlan('e2e-test');
    expect(plan).toHaveProperty('id');
    expect(plan.name).toBe('Plan e2e-test');
    expect(plan.slug).toBe('e2e-test');
  });

  it('lists plans', async () => {
    const res = await req(ctx, owner, 'get', '/api/v1/owner/plans');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body.length).toBeGreaterThanOrEqual(1);
  });

  it('gets a plan by id', async () => {
    const res = await req(ctx, owner, 'get', `/api/v1/owner/plans/${plan.id}`);
    expect(res.status).toBe(200);
    expect(res.body.id).toBe(plan.id);
  });

  it('updates a plan', async () => {
    const res = await req(ctx, owner, 'patch', `/api/v1/owner/plans/${plan.id}`)
      .send({ description: 'Updated description', priceMonthly: 99.99 });
    expect(res.status).toBe(200);
    expect(res.body.description).toBe('Updated description');
    expect(res.body.priceMonthly).toBe(99.99);
  });

  it('rejects duplicate slug', async () => {
    const res = await req(ctx, owner, 'post', '/api/v1/owner/plans')
      .send({ name: 'Duplicate', slug: 'e2e-test' });
    expect(res.status).toBe(409);
  });

  it('deletes a plan with no active subscriptions', async () => {
    const res = await req(ctx, owner, 'post', `/api/v1/owner/plans/${plan.id}/delete`);
    expect([200, 201]).toContain(res.status);
    expect(res.body.ok).toBe(true);
  });

  it('returns 404 for non-existent plan', async () => {
    const res = await req(ctx, owner, 'get', '/api/v1/owner/plans/99999');
    expect(res.status).toBe(404);
  });
});

// ── 5. License Lifecycle ─────────────────────────────────────────────

describe('License Lifecycle', () => {
  let org: any;
  let plan: any;
  let license: any;
  let licenseCode: string;

  beforeAll(async () => {
    org = await createOrg('License Test Org');
    plan = await createPlan('lic-test', { slug: 'lic-test' });
  });

  it('creates a license', async () => {
    const res = await req(ctx, owner, 'post', '/api/v1/owner/licenses/create')
      .send({
        organizationId: org.id, planId: plan.id,
        durationDays: 30, userLimit: 10, branchLimit: 5,
        notes: 'Test license',
      });
    expect(res.status).toBe(201);
    license = res.body;
    licenseCode = license.licenseCode;
    expect(licenseCode).toBeTruthy();
    expect(licenseCode.length).toBe(24);
    expect(license.status).toBe('pending');
    expect(license.userLimit).toBe(10);
    expect(license.branchLimit).toBe(5);

    // Activate it for subsequent tests
    await req(ctx, owner, 'post', `/api/v1/owner/licenses/${license.id}/reactivate`);
  });

  it('rejects duplicate license for same org', async () => {
    const res = await req(ctx, owner, 'post', '/api/v1/owner/licenses/create')
      .send({ organizationId: org.id, planId: plan.id });
    expect(res.status).toBe(409);
  });

  it('looks up license by code', async () => {
    const res = await req(ctx, owner, 'get', `/api/v1/owner/licenses/lookup/${licenseCode}`);
    expect(res.status).toBe(200);
    expect(res.body.licenseCode).toBe(licenseCode);
  });

  it('lists all licenses', async () => {
    const res = await req(ctx, owner, 'get', '/api/v1/owner/licenses');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body.length).toBeGreaterThanOrEqual(1);
  });

  it('extends a license', async () => {
    const prevEnd = license.currentPeriodEndsAt;
    const res = await req(ctx, owner, 'post', `/api/v1/owner/licenses/${license.id}/extend`)
      .send({ days: 30 });
    expect(res.status).toBe(200);
    expect(new Date(res.body.currentPeriodEndsAt).getTime()).toBeGreaterThan(new Date(prevEnd).getTime());
  });

  it('suspends a license', async () => {
    const res = await req(ctx, owner, 'post', `/api/v1/owner/licenses/${license.id}/suspend`)
      .send({ reason: 'Test suspension' });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('suspended');
  });

  it('reactivates a suspended license', async () => {
    const res = await req(ctx, owner, 'post', `/api/v1/owner/licenses/${license.id}/reactivate`);
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('active');
  });

  it('changes plan on a license', async () => {
    const newPlan = await createPlan('lic-new-plan', { slug: 'lic-new-plan' });
    const res = await req(ctx, owner, 'post', `/api/v1/owner/licenses/${license.id}/change-plan`)
      .send({ planId: newPlan.id });
    expect(res.status).toBe(200);
    expect(res.body.planId).toBe(newPlan.id);
  });

  it('updates license limits', async () => {
    const res = await req(ctx, owner, 'patch', `/api/v1/owner/licenses/${license.id}/limits`)
      .send({ userLimit: 20, branchLimit: 10 });
    expect(res.status).toBe(200);
    expect(res.body.userLimit).toBe(20);
    expect(res.body.branchLimit).toBe(10);
  });

  it('revokes a license', async () => {
    const res = await req(ctx, owner, 'post', `/api/v1/owner/licenses/${license.id}/revoke`)
      .send({ reason: 'Test revocation' });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('revoked');
  });

  it('cannot reactivate a revoked license', async () => {
    const res = await req(ctx, owner, 'post', `/api/v1/owner/licenses/${license.id}/reactivate`);
    expect(res.status).toBe(409);
  });

  it('returns license history', async () => {
    const res = await req(ctx, owner, 'get', `/api/v1/owner/licenses/history/${org.id}`);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body.length).toBeGreaterThanOrEqual(4); // created, extended, suspended, reactivated, plan_changed, limits_changed, revoked
  });
});

// ── 6. License Activation (Public) ───────────────────────────────────

describe('License Activation (Public)', () => {
  let org: any;
  let plan: any;
  let sub: any;

  beforeAll(async () => {
    org = await createOrg('Activation Test Org');
    plan = await createPlan('act-test', { slug: 'act-test' });
    // Create a license — starts as 'pending'
    const licRes = await req(ctx, owner, 'post', '/api/v1/owner/licenses/create')
      .send({ organizationId: org.id, planId: plan.id, durationDays: 30 });
    sub = licRes.body;
  });

  it('public endpoint can be accessed without auth', async () => {
    const res = await ctx.api()
      .post('/api/v1/owner/activate')
      .send({ licenseCode: sub.licenseCode, organizationId: org.id });
    expect([200, 201]).toContain(res.status);
    expect(res.body.message).toBeTruthy();
  });

  it('rejects invalid license code', async () => {
    const res = await ctx.api()
      .post('/api/v1/owner/activate')
      .send({ licenseCode: 'INVALIDCODE1234567890', organizationId: org.id });
    expect(res.status).toBe(404);
  });

  it('rejects already-active license', async () => {
    const res = await ctx.api()
      .post('/api/v1/owner/activate')
      .send({ licenseCode: sub.licenseCode, organizationId: org.id });
    expect(res.status).toBe(409);
  });

  it('rejects revoked license', async () => {
    // Create and revoke a license
    const org2 = await createOrg('Revoke Test Org');
    const licRes = await req(ctx, owner, 'post', '/api/v1/owner/licenses/create')
      .send({ organizationId: org2.id, planId: plan.id, durationDays: 30 });
    await req(ctx, owner, 'post', `/api/v1/owner/licenses/${licRes.body.id}/revoke`)
      .send({ reason: 'test' });

    const res = await ctx.api()
      .post('/api/v1/owner/activate')
      .send({ licenseCode: licRes.body.licenseCode, organizationId: org2.id });
    expect(res.status).toBe(409);
  });

  it('rejects org mismatch', async () => {
    const org3 = await createOrg('Mismatch Test Org');
    const res = await ctx.api()
      .post('/api/v1/owner/activate')
      .send({ licenseCode: sub.licenseCode, organizationId: org3.id });
    expect(res.status).toBe(409);
  });
});

// ── 7. Usage & Limits ────────────────────────────────────────────────

describe('Usage Stats', () => {
  it('returns usage statistics', async () => {
    const res = await req(ctx, owner, 'get', '/api/v1/owner/usage');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
  });

  it('returns real aggregate usage summary', async () => {
    // Set up an active, licensed org so the aggregate counts come from real
    // rows (seedOwner's login also leaves a live refresh token behind).
    const org = await createOrg('Usage Stats Org');
    const plan = await createPlan('stats-plan');
    const lic = await req(ctx, owner, 'post', '/api/v1/owner/licenses/create')
      .send({ organizationId: org.id, planId: plan.id, notes: 'usage stats test' });
    expect(lic.status).toBe(201);
    const activate = await ctx.api().post('/api/v1/owner/activate')
      .send({ licenseCode: lic.body.licenseCode, organizationId: org.id });
    expect(activate.status).toBe(200);

    const res = await req(ctx, owner, 'get', '/api/v1/owner/usage/stats');
    expect(res.status).toBe(200);
    expect(typeof res.body.totalUsers).toBe('number');
    expect(res.body.totalUsers).toBeGreaterThanOrEqual(1);
    expect(typeof res.body.activeSessions).toBe('number');
    expect(res.body.activeSessions).toBeGreaterThanOrEqual(1);
    expect(res.body.apiCalls).toEqual({ available: false, count: null });
    expect(res.body.storage).toEqual({ available: false, bytes: null });
  });
});

// ── 8. Edge Cases ────────────────────────────────────────────────────

describe('Edge Cases', () => {
  it('returns 404 for non-existent subscription on extend', async () => {
    const res = await req(ctx, owner, 'post', '/api/v1/owner/licenses/99999/extend')
      .send({ days: 30 });
    expect(res.status).toBe(404);
  });

  it('returns 404 for non-existent subscription on suspend', async () => {
    const res = await req(ctx, owner, 'post', '/api/v1/owner/licenses/99999/suspend')
      .send({ reason: 'test' });
    expect(res.status).toBe(404);
  });

  it('returns 404 for non-existent subscription on revoke', async () => {
    const res = await req(ctx, owner, 'post', '/api/v1/owner/licenses/99999/revoke')
      .send({ reason: 'test' });
    expect(res.status).toBe(404);
  });
});

// ── Phase 35: Server-Authoritative Trial ──────────────────────────────

describe('Phase 35 — Server-Authoritative Trial', () => {
  let trialOrg: any;

  beforeAll(async () => {
    trialOrg = await createOrg('Trial Test Org');
  });

  it('POST /owner/trial/start creates a 24h trial', async () => {
    const res = await (ctx.api() as any).post('/api/v1/owner/trial/start')
      .send({ organizationId: trialOrg.id, deviceFingerprint: 'test-fingerprint-abc123' });
    expect(res.status).toBe(200);
    expect(res.body.subscription.status).toBe('trialing');
    expect(res.body.trialToken).toBeTruthy();
    expect(res.body.expiresAt).toBeTruthy();
    const endsAt = new Date(res.body.expiresAt).getTime();
    const now = Date.now();
    const diff = endsAt - now;
    expect(diff).toBeGreaterThan(23 * 3600 * 1000);
    expect(diff).toBeLessThanOrEqual(24 * 3600 * 1000 + 5000);
  });

  it('returns existing trial if still valid (idempotent)', async () => {
    const res1 = await (ctx.api() as any).post('/api/v1/owner/trial/start')
      .send({ organizationId: trialOrg.id, deviceFingerprint: 'test-fingerprint-abc123' });
    const res2 = await (ctx.api() as any).post('/api/v1/owner/trial/start')
      .send({ organizationId: trialOrg.id, deviceFingerprint: 'test-fingerprint-abc123' });
    expect(res2.status).toBe(200);
    expect(res2.body.subscription.id).toBe(res1.body.subscription.id);
  });

  it('POST /owner/trial/validate confirms valid trial', async () => {
    const res = await (ctx.api() as any).post('/api/v1/owner/trial/validate')
      .send({ organizationId: trialOrg.id, deviceFingerprint: 'test-fingerprint-abc123' });
    expect(res.status).toBe(200);
    expect(res.body.valid).toBe(true);
    expect(res.body.status).toBe('trialing');
    expect(res.body.trialToken).toBeTruthy();
  });

  it('HMAC token is valid and verifiable', async () => {
    const trialRes = await (ctx.api() as any).post('/api/v1/owner/trial/start')
      .send({ organizationId: trialOrg.id, deviceFingerprint: 'test-fingerprint-abc123' });
    const token = trialRes.body.trialToken;

    const verifyRes = await (ctx.api() as any).post('/api/v1/owner/trial/verify-token')
      .send({ token });
    expect(verifyRes.status).toBe(200);
    expect(verifyRes.body.valid).toBe(true);
    expect(verifyRes.body.data.org).toBe(trialOrg.id);
    expect(verifyRes.body.data.device).toBe('test-fingerprint-abc123');
  });

  it('rejects tampered HMAC token', async () => {
    const trialRes = await (ctx.api() as any).post('/api/v1/owner/trial/start')
      .send({ organizationId: trialOrg.id, deviceFingerprint: 'test-fingerprint-abc123' });
    const token = trialRes.body.trialToken;
    const tampered = token.slice(0, -5) + 'XXXXX';
    const verifyRes = await (ctx.api() as any).post('/api/v1/owner/trial/verify-token')
      .send({ token: tampered });
    expect(verifyRes.status).toBe(200);
    expect(verifyRes.body.valid).toBe(false);
  });

  it('rejects trial start without deviceFingerprint', async () => {
    const res = await (ctx.api() as any).post('/api/v1/owner/trial/start')
      .send({ organizationId: trialOrg.id });
    expect(res.status).toBe(200);
    expect(res.body.code).toBe('FINGERPRINT_REQUIRED');
  });

  it('rejects trial validation without deviceFingerprint', async () => {
    const res = await (ctx.api() as any).post('/api/v1/owner/trial/validate')
      .send({ organizationId: trialOrg.id });
    expect(res.status).toBe(200);
    expect(res.body.valid).toBe(false);
  });

  it('org with active license cannot start trial', async () => {
    const licOrg = await createOrg('License Blocks Trial Org');
    const plan = await createPlan('block-trial-plan', { trialDays: 0 });
    const licRes = await req(ctx, owner, 'post', '/api/v1/owner/licenses/create')
      .send({ organizationId: licOrg.id, planId: plan.id, durationDays: 30 });
    expect(licRes.status).toBe(201);
    const activateRes = await (ctx.api() as any).post('/api/v1/owner/activate')
      .send({ licenseCode: licRes.body.licenseCode, organizationId: licOrg.id });
    expect(activateRes.status).toBe(200);
    const trialRes = await (ctx.api() as any).post('/api/v1/owner/trial/start')
      .send({ organizationId: licOrg.id, deviceFingerprint: 'any-fingerprint' });
    expect(trialRes.status).toBe(409);
    expect(trialRes.body.code).toBe('ORG_HAS_ACTIVE_LICENSE');
  });

  it('validates trial for non-existent org returns none', async () => {
    const res = await (ctx.api() as any).post('/api/v1/owner/trial/validate')
      .send({ organizationId: 99999, deviceFingerprint: 'any' });
    expect(res.status).toBe(200);
    expect(res.body.valid).toBe(false);
    expect(res.body.status).toBe('none');
  });

  it('rejects empty deviceFingerprint', async () => {
    const res = await (ctx.api() as any).post('/api/v1/owner/trial/start')
      .send({ organizationId: trialOrg.id, deviceFingerprint: '' });
    expect(res.status).toBe(200);
    expect(res.body.code).toBe('FINGERPRINT_REQUIRED');
  });

  it('verify-token rejects invalid base64url token', async () => {
    const res = await (ctx.api() as any).post('/api/v1/owner/trial/verify-token')
      .send({ token: 'not-a-valid-token!!!' });
    expect(res.status).toBe(200);
    expect(res.body.valid).toBe(false);
  });
});

// ── Phase 36: Trial Extension via Owner Portal ───────────────────────

describe('Phase 36 — Owner extends trial (24h / 7d / 30d)', () => {
  let trialOrg: any;

  beforeAll(async () => {
    trialOrg = await createOrg('Trial Extend Test Org');
  });

  it('owner can extend an ACTIVE trial without force (trialing stays trialing)', async () => {
    const start = await (ctx.api() as any).post('/api/v1/owner/trial/start')
      .send({ organizationId: trialOrg.id, deviceFingerprint: 'extend-fp-1' });
    expect(start.status).toBe(200);
    const subId = start.body.subscription.id;
    const origEnd = new Date(start.body.expiresAt).getTime();

    // Extend by 7 days (as the owner portal does)
    const res = await req(ctx, owner, 'post', `/api/v1/owner/licenses/${subId}/extend`)
      .send({ days: 7 });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('trialing');
    expect(new Date(res.body.trialEndsAt).getTime()).toBeGreaterThan(origEnd);

    // Server-authoritative validation now reports the extended deadline
    const val = await (ctx.api() as any).post('/api/v1/owner/trial/validate')
      .send({ organizationId: trialOrg.id, deviceFingerprint: 'extend-fp-1' });
    expect(val.status).toBe(200);
    expect(val.body.valid).toBe(true);
    expect(val.body.status).toBe('trialing');
    const gained = new Date(val.body.expiresAt).getTime() - origEnd;
    expect(gained).toBeGreaterThan(6 * 24 * 3600 * 1000); // ~7 days gained
  });

  it('owner can extend an EXPIRED trial — returns to trialing with future end', async () => {
    const org = await createOrg('Trial Expired Extend Org');
    const start = await (ctx.api() as any).post('/api/v1/owner/trial/start')
      .send({ organizationId: org.id, deviceFingerprint: 'extend-fp-2' });
    expect(start.status).toBe(200);
    const subId = start.body.subscription.id;

    // Simulate the trial having lapsed
    const past = new Date(Date.now() - 3600_000);
    await ds.getRepository(OrganizationSubscription).update(subId, {
      trialStartsAt: new Date(Date.now() - 26 * 3600_000),
      trialEndsAt: past,
      currentPeriodStartsAt: new Date(Date.now() - 26 * 3600_000),
      currentPeriodEndsAt: past,
    });

    // Trial reports expired server-side before extension
    const before = await (ctx.api() as any).post('/api/v1/owner/trial/validate')
      .send({ organizationId: org.id, deviceFingerprint: 'extend-fp-2' });
    expect(before.body.valid).toBe(false);
    expect(before.body.status).toBe('expired');

    // Owner extends 24 hours
    const res = await req(ctx, owner, 'post', `/api/v1/owner/licenses/${subId}/extend`)
      .send({ days: 1 });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('trialing');
    expect(new Date(res.body.trialEndsAt).getTime()).toBeGreaterThan(Date.now());

    const after = await (ctx.api() as any).post('/api/v1/owner/trial/validate')
      .send({ organizationId: org.id, deviceFingerprint: 'extend-fp-2' });
    expect(after.status).toBe(200);
    expect(after.body.valid).toBe(true);

    // Extension is audited
    const hist = await req(ctx, owner, 'get', `/api/v1/owner/licenses/history/${org.id}`);
    expect(hist.status).toBe(200);
    expect(hist.body.some(h => h.action === 'extended')).toBe(true);
  });

  it('GET /owner/licenses enriches rows with org/plan names and trial info', async () => {
    const res = await req(ctx, owner, 'get', '/api/v1/owner/licenses');
    expect(res.status).toBe(200);
    const rows = res.body;
    expect(Array.isArray(rows)).toBe(true);

    const row = rows.find(r => r.organizationId === trialOrg.id);
    expect(row).toBeTruthy();
    expect(row.organizationName).toBe('Trial Extend Test Org');
    expect(row.planName).toBe('Free Trial');
    expect(row.trialStatus).toBe('trialing');
    expect(row.trialExpiresAt).toBeTruthy();
    expect(typeof row.trialRemainingMs).toBe('number');
  });

  it('cannot extend a revoked license (even via owner)', async () => {
    const org = await createOrg('Revoked Extend Org');
    const plan = await createPlan('rev-extend-plan', { slug: 'rev-extend-plan' });
    const lic = await req(ctx, owner, 'post', '/api/v1/owner/licenses/create')
      .send({ organizationId: org.id, planId: plan.id, durationDays: 30 });
    await req(ctx, owner, 'post', `/api/v1/owner/licenses/${lic.body.id}/revoke`)
      .send({ reason: 'test' });

    const res = await req(ctx, owner, 'post', `/api/v1/owner/licenses/${lic.body.id}/extend`)
      .send({ days: 7 });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('LICENSE_REVOKED');
  });
});
