import {
  BadRequestException, ConflictException, NotFoundException,
  Injectable, Logger,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, In } from 'typeorm';
import * as crypto from 'crypto';

import { loadTrialKeyId, loadTrialPrivateKey } from './trial-keys';

import {
  Organization, OrganizationMember, OrganizationSubscription,
  SubscriptionPlan, LicenseHistory, User, Branch,
} from '../../database/entities';

export interface DashboardStats {
  totalOrgs: number;
  activeOrgs: number;
  suspendedOrgs: number;
  disabledOrgs: number;
  totalRevenue: number;
  activeLicenses: number;
  expiringLicenses: number;
  recentActivity: LicenseHistory[];
}

/**
 * Aggregate usage summary for the Owner Portal "Usage" page.
 * - totalUsers:     distinct active users across organizations with an
 *                   active/trialing subscription (real: organization_members).
 * - activeSessions: live refresh-token sessions (real: refresh_tokens where
 *                   revoked_at IS NULL AND expires_at > now()).
 * - apiCalls/storage currently have NO data source in the system (no request
 *   log table, no byte-size tracking). They are explicitly reported as
 *   unavailable instead of a fabricated 0 so the UI renders "غير متاح".
 */
export interface UsageStatsSummary {
  totalUsers: number;
  activeSessions: number;
  apiCalls: { available: boolean; count: number | null };
  storage: { available: boolean; bytes: number | null };
}

export interface OrgDetail {
  organization: Organization;
  subscription: OrganizationSubscription | null;
  plan: SubscriptionPlan | null;
  members: Array<{ userId: number; username: string; displayName: string; role: string; status: string }>;
  branchCount: number;
  userCount: number;
  usage: { branches: number; users: number; products: number };
}

@Injectable()
export class OwnerService {
  private readonly logger = new Logger(OwnerService.name);

  constructor(
    @InjectRepository(Organization)          private orgRepo: Repository<Organization>,
    @InjectRepository(OrganizationMember)    private memberRepo: Repository<OrganizationMember>,
    @InjectRepository(OrganizationSubscription) private subRepo: Repository<OrganizationSubscription>,
    @InjectRepository(SubscriptionPlan)      private planRepo: Repository<SubscriptionPlan>,
    @InjectRepository(LicenseHistory)        private histRepo: Repository<LicenseHistory>,
    @InjectRepository(User)                  private userRepo: Repository<User>,
    @InjectRepository(Branch)                private branchRepo: Repository<Branch>,
  ) {}

  // ── Dashboard ──────────────────────────────────────────────────────

  async getDashboard(): Promise<DashboardStats> {
    const totalOrgs     = await this.orgRepo.count();
    const activeOrgs    = await this.orgRepo.count({ where: { status: 'active' } });
    const suspendedOrgs = await this.orgRepo.count({ where: { status: 'suspended' } });
    const disabledOrgs  = await this.orgRepo.count({ where: { status: 'disabled' } });
    const activeLicenses = await this.subRepo.count({ where: { status: In(['active', 'trialing']) } });

    const now = new Date();
    const thirtyDays = new Date(now.getTime() + 30 * 86400_000);
    const expiringLicenses = await this.subRepo
      .createQueryBuilder('s')
      .where('s.status = :st', { st: 'active' })
      .andWhere('s.current_period_ends_at IS NOT NULL')
      .andWhere('s.current_period_ends_at <= :d', { d: thirtyDays })
      .andWhere('s.current_period_ends_at > :now', { now })
      .getCount();

    const recentActivity = await this.histRepo.find({
      order: { createdAt: 'DESC' },
      take: 20,
    });

    const revRow = await this.subRepo
      .createQueryBuilder('s')
      .innerJoin('subscription_plans', 'p', 'p.id = s.plan_id')
      .select('COALESCE(SUM(p.price_monthly), 0)', 'total')
      .where("s.status IN ('active','trialing')")
      .getRawOne();
    const totalRevenue = Number(revRow?.total ?? 0);

    return { totalOrgs, activeOrgs, suspendedOrgs, disabledOrgs, totalRevenue, activeLicenses, expiringLicenses, recentActivity };
  }

  // ── Organizations ──────────────────────────────────────────────────

  async listOrganizations(): Promise<OrgDetail[]> {
    const orgs = await this.orgRepo.find({ order: { createdAt: 'DESC' } });
    return Promise.all(orgs.map(o => this.getOrgDetail(o.id)));
  }

  async getOrgDetail(orgId: number): Promise<OrgDetail> {
    const org = await this.orgRepo.findOneBy({ id: orgId });
    if (!org) throw new NotFoundException({ message: 'المؤسسة غير موجودة', code: 'ORG_NOT_FOUND' });

    const sub = await this.subRepo.findOne({ where: { organizationId: orgId } });
    let plan: SubscriptionPlan | null = null;
    if (sub) plan = await this.planRepo.findOneBy({ id: sub.planId }) ?? null;

    const memberRows = await this.memberRepo.find({ where: { organizationId: orgId } });
    const userIds = memberRows.map(m => m.userId);
    const users = userIds.length ? await this.userRepo.find({ where: { id: In(userIds) } }) : [];
    const userMap = new Map(users.map(u => [u.id, u]));

    const members = memberRows.map(m => ({
      userId: m.userId,
      username: userMap.get(m.userId)?.username ?? '?',
      displayName: userMap.get(m.userId)?.display_name ?? '?',
      role: m.role,
      status: m.status,
    }));

    const branchCount = await this.branchRepo.count({ where: { organizationId: orgId } });
    const productCount = await this.subRepo.manager
      .createQueryBuilder()
      .from('products', 'p')
      .where('p.organization_id = :orgId', { orgId })
      .getCount();

    return {
      organization: org,
      subscription: sub,
      plan,
      members,
      branchCount,
      userCount: memberRows.length,
      usage: { branches: branchCount, users: memberRows.length, products: productCount },
    };
  }

  async createOrganization(
    data: { name: string; slug?: string },
    actorId: number,
  ): Promise<Organization> {
    const slug = data.slug || this.slugify(data.name);
    const existing = await this.orgRepo.findOne({ where: { slug } });
    if (existing) {
      throw new ConflictException({ message: 'مؤسسة بهذا الاسم موجودة بالفعل', code: 'ORG_SLUG_EXISTS' });
    }

    const org = this.orgRepo.create({ name: data.name, slug, status: 'active' });
    const saved = await this.orgRepo.save(org);

    // Auto-add the creating user as owner of the new org
    const membership = this.memberRepo.create({
      userId: actorId,
      organizationId: saved.id,
      role: 'owner',
      status: 'active',
    });
    await this.memberRepo.save(membership);

    await this.logHistory(saved.id, null, 'created', actorId, null, null, {
      name: saved.name, slug: saved.slug,
    }, '');

    return saved;
  }

  async updateOrgStatus(orgId: number, status: string, actorId: number, reason = ''): Promise<void> {
    const org = await this.orgRepo.findOneBy({ id: orgId });
    if (!org) throw new NotFoundException({ message: 'المؤسسة غير موجودة', code: 'ORG_NOT_FOUND' });

    const validStatuses = ['active', 'disabled', 'suspended'];
    if (!validStatuses.includes(status)) {
      throw new BadRequestException({ message: 'حالة غير صالحة', code: 'INVALID_STATUS' });
    }

    const prev = { status: org.status };
    org.status = status as any;
    org.updatedAt = new Date();
    await this.orgRepo.save(org);
    await this.logHistory(orgId, null, 'notes_changed', actorId, null, prev, { status }, reason);
  }

  // ── Plans (CRUD) ───────────────────────────────────────────────────

  async listPlans(): Promise<SubscriptionPlan[]> {
    return this.planRepo.find({ order: { sortOrder: 'ASC', id: 'ASC' } });
  }

  async getPlan(id: number): Promise<SubscriptionPlan> {
    const plan = await this.planRepo.findOneBy({ id });
    if (!plan) throw new NotFoundException({ message: 'الخطة غير موجودة', code: 'PLAN_NOT_FOUND' });
    return plan;
  }

  async createPlan(data: Partial<SubscriptionPlan>): Promise<SubscriptionPlan> {
    if (!data.name || !data.slug) {
      throw new BadRequestException({ message: 'الاسم والمعرف مطلوبان', code: 'MISSING_FIELDS' });
    }
    const existing = await this.planRepo.findOne({ where: { slug: data.slug } });
    if (existing) {
      throw new ConflictException({ message: 'خطة بهذا المعرف موجودة بالفعل', code: 'PLAN_SLUG_EXISTS' });
    }
    const plan = this.planRepo.create(data);
    return this.planRepo.save(plan);
  }

  async updatePlan(id: number, data: Partial<SubscriptionPlan>): Promise<SubscriptionPlan> {
    const plan = await this.planRepo.findOneBy({ id });
    if (!plan) throw new NotFoundException({ message: 'الخطة غير موجودة', code: 'PLAN_NOT_FOUND' });
    Object.assign(plan, data);
    plan.updatedAt = new Date();
    return this.planRepo.save(plan);
  }

  async deletePlan(id: number): Promise<void> {
    const plan = await this.planRepo.findOneBy({ id });
    if (!plan) throw new NotFoundException({ message: 'الخطة غير موجودة', code: 'PLAN_NOT_FOUND' });

    const activeCount = await this.subRepo.count({ where: { planId: id, status: In(['active', 'trialing']) } });
    if (activeCount > 0) {
      throw new ConflictException({ message: 'لا يمكن حذف خطة بها اشتراكات نشطة', code: 'PLAN_HAS_ACTIVE_SUBS' });
    }
    await this.planRepo.delete(id);
  }

  // ── Licenses ───────────────────────────────────────────────────────

  generateLicenseCode(): string {
    // 24 hex chars = 12 bytes of entropy — cryptographically secure, unpredictable
    return crypto.randomBytes(12).toString('hex').toUpperCase();
  }

  async createLicense(
    orgId: number,
    planId: number,
    actorId: number,
    opts: { durationDays?: number; userLimit?: number; branchLimit?: number; features?: Record<string, boolean>; notes?: string } = {},
  ): Promise<OrganizationSubscription> {
    const org = await this.orgRepo.findOneBy({ id: orgId });
    if (!org) throw new NotFoundException({ message: 'المؤسسة غير موجودة', code: 'ORG_NOT_FOUND' });

    const plan = await this.planRepo.findOneBy({ id: planId });
    if (!plan) throw new NotFoundException({ message: 'الخطة غير موجودة', code: 'PLAN_NOT_FOUND' });

    // Check if org already has a non-revoked, non-cancelled license
    const existing = await this.subRepo.findOne({
      where: { organizationId: orgId },
    });
    if (existing && !['revoked', 'cancelled', 'expired'].includes(existing.status)) {
      throw new ConflictException({ message: 'المؤسسة لها ترخيص نشط بالفعل', code: 'ORG_HAS_ACTIVE_LICENSE' });
    }
    // If there's a revoked/cancelled/expired subscription, clean it up first
    if (existing) {
      // Clear FK reference before deleting
      await this.orgRepo.update({ subscriptionId: existing.id }, { subscriptionId: null, updatedAt: new Date() });
      await this.subRepo.delete(existing.id);
    }

    const now = new Date();
    const duration = opts.durationDays ?? 30;
    const periodEnd = new Date(now.getTime() + duration * 86400_000);

    const sub = this.subRepo.create({
      organizationId: orgId,
      planId,
      status: 'pending',
      licenseCode: this.generateLicenseCode(),
      currentPeriodStartsAt: now,
      currentPeriodEndsAt: periodEnd,
      userLimit: opts.userLimit ?? plan.maxUsers,
      branchLimit: opts.branchLimit ?? plan.maxBranches,
      features: opts.features ?? (plan.features as Record<string, boolean>) ?? {},
      notes: opts.notes ?? '',
      createdBy: actorId,
    });
    const saved = await this.subRepo.save(sub);

    // Link org to subscription
    org.subscriptionId = saved.id;
    org.updatedAt = now;
    await this.orgRepo.save(org);

    // Activate the org if it was suspended/disabled
    if (org.status !== 'active') {
      org.status = 'active';
      await this.orgRepo.save(org);
    }

    await this.logHistory(orgId, saved.id, 'created', actorId, saved.licenseCode, null, {
      planId, planName: plan.name, durationDays: duration,
      userLimit: saved.userLimit, branchLimit: saved.branchLimit,
      features: saved.features,
    }, opts.notes ?? '');

    return saved;
  }

  /** Customer-facing: activate by license code. Validates org membership server-side. */
  async activateLicenseByCode(
    licenseCode: string,
    orgId: number,
  ): Promise<{ subscription: OrganizationSubscription; message: string }> {
    if (!licenseCode || typeof licenseCode !== 'string') {
      throw new BadRequestException({ message: 'رمز الترخيص مطلوب', code: 'LICENSE_CODE_REQUIRED' });
    }

    const sub = await this.subRepo.findOne({ where: { licenseCode: licenseCode.toUpperCase() } });
    if (!sub) {
      throw new NotFoundException({ message: 'رمز الترخيص غير صالح', code: 'INVALID_LICENSE_CODE' });
    }

    if (sub.status === 'active') {
      throw new ConflictException({ message: 'الترخيص نشط بالفعل', code: 'LICENSE_ALREADY_ACTIVE' });
    }

    // Only pending licenses can be activated via public endpoint
    if (sub.status !== 'pending') {
      throw new ConflictException({ message: 'لا يمكن تفعيل ترخيص بحالة ' + sub.status, code: 'LICENSE_NOT_ACTIVATABLE' });
    }

    // Verify the organization matches
    if (sub.organizationId !== orgId) {
      throw new ConflictException({ message: 'الترخيص لا ينتمي لهذه المؤسسة', code: 'LICENSE_ORG_MISMATCH' });
    }

    // Check expiration
    if (sub.currentPeriodEndsAt && sub.currentPeriodEndsAt.getTime() < Date.now()) {
      throw new ConflictException({ message: 'انتهت صلاحية الترخيص', code: 'LICENSE_EXPIRED' });
    }

    const now = new Date();
    const prev = { status: sub.status };
    sub.status = 'active';
    if (!sub.currentPeriodStartsAt) sub.currentPeriodStartsAt = now;
    if (!sub.currentPeriodEndsAt) {
      // Default 30 days if no period set
      sub.currentPeriodEndsAt = new Date(now.getTime() + 30 * 86400_000);
    }
    sub.updatedAt = now;
    await this.subRepo.save(sub);

    // Reactivate the org
    await this.orgRepo.update(orgId, { status: 'active', updatedAt: now });

    await this.logHistory(orgId, sub.id, 'activated', null, licenseCode, prev, { status: 'active' }, '');

    return { subscription: sub, message: 'تم تفعيل الترخيص بنجاح' };
  }

  async extendLicense(
    subId: number, days: number, actorId: number, opts?: { force?: boolean },
  ): Promise<OrganizationSubscription> {
    const sub = await this.subRepo.findOneBy({ id: subId });
    if (!sub) throw new NotFoundException({ message: 'الترخيص غير موجود', code: 'LICENSE_NOT_FOUND' });

    // Owner actions: active licenses, and trial subscriptions (trialing / expired /
    // past_due / suspended) can be extended directly. Revoked / cancelled need force.
    const extendable = ['active', 'trialing', 'past_due', 'suspended', 'expired'];
    if (!opts?.force && !extendable.includes(sub.status)) {
      throw new ConflictException({
        message: sub.status === 'revoked'
          ? 'لا يمكن تمديد ترخيص ملغى'
          : 'لا يمكن تمديد ترخيص بحالة ' + sub.status + '. استخدم force=true للإعادة.',
        code: sub.status === 'revoked' ? 'LICENSE_REVOKED' : 'LICENSE_NOT_ACTIVE',
      });
    }

    const prev = { periodEnd: sub.currentPeriodEndsAt?.toISOString(), status: sub.status };

    // Extend from current end or now, whichever is later
    const base = sub.currentPeriodEndsAt && sub.currentPeriodEndsAt.getTime() > Date.now()
      ? sub.currentPeriodEndsAt
      : new Date();
    sub.currentPeriodEndsAt = new Date(base.getTime() + days * 86400_000);

    // Trial subscriptions keep trial_end_at authoritative (trial/validate reads it).
    // Extend from the trial end or now, whichever is later.
    if (sub.status === 'trialing' || sub.trialEndsAt) {
      const trialBase = sub.trialEndsAt && sub.trialEndsAt.getTime() > Date.now()
        ? sub.trialEndsAt
        : new Date();
      sub.trialEndsAt = new Date(trialBase.getTime() + days * 86400_000);
    }

    // If extending an expired license, reactivate it (a trial returns to trialing)
    if (sub.status === 'expired' || sub.status === 'cancelled') {
      sub.status = sub.trialEndsAt ? 'trialing' : 'active';
      await this.orgRepo.update(sub.organizationId, { status: 'active', updatedAt: new Date() });
    }

    sub.extendedAt = new Date();
    sub.updatedAt = new Date();
    await this.subRepo.save(sub);

    await this.logHistory(sub.organizationId, sub.id, 'extended', actorId, sub.licenseCode, prev,
      { addedDays: days, newPeriodEnd: sub.currentPeriodEndsAt?.toISOString(), newStatus: sub.status }, '');

    return sub;
  }

  async suspendLicense(subId: number, actorId: number, reason: string): Promise<OrganizationSubscription> {
    const sub = await this.subRepo.findOneBy({ id: subId });
    if (!sub) throw new NotFoundException({ message: 'الترخيص غير موجود', code: 'LICENSE_NOT_FOUND' });

    if (sub.status === 'revoked') {
      throw new ConflictException({ message: 'لا يمكن تعليق ترخيص ملغى', code: 'LICENSE_REVOKED' });
    }

    const prev = { status: sub.status };
    sub.status = 'suspended';
    sub.updatedAt = new Date();
    await this.subRepo.save(sub);

    await this.orgRepo.update(sub.organizationId, { status: 'suspended', updatedAt: new Date() });

    await this.logHistory(sub.organizationId, sub.id, 'suspended', actorId, sub.licenseCode, prev,
      { status: 'suspended' }, reason);

    return sub;
  }

  async revokeLicense(subId: number, actorId: number, reason: string): Promise<OrganizationSubscription> {
    const sub = await this.subRepo.findOneBy({ id: subId });
    if (!sub) throw new NotFoundException({ message: 'الترخيص غير موجود', code: 'LICENSE_NOT_FOUND' });

    const prev = { status: sub.status };
    sub.status = 'revoked';
    sub.updatedAt = new Date();
    await this.subRepo.save(sub);

    // Disable org but preserve data
    await this.orgRepo.update(sub.organizationId, { status: 'disabled', updatedAt: new Date() });

    await this.logHistory(sub.organizationId, sub.id, 'revoked', actorId, sub.licenseCode, prev,
      { status: 'revoked' }, reason);

    return sub;
  }

  async reactivateLicense(subId: number, actorId: number): Promise<OrganizationSubscription> {
    const sub = await this.subRepo.findOneBy({ id: subId });
    if (!sub) throw new NotFoundException({ message: 'الترخيص غير موجود', code: 'LICENSE_NOT_FOUND' });

    if (sub.status === 'revoked') {
      throw new ConflictException({ message: 'لا يمكن إعادة تنشيط ترخيص ملغى', code: 'LICENSE_REVOKED' });
    }

    const prev = { status: sub.status };
    sub.status = 'active';
    if (!sub.currentPeriodStartsAt) sub.currentPeriodStartsAt = new Date();
    // If expired, extend by 30 days
    if (!sub.currentPeriodEndsAt || sub.currentPeriodEndsAt.getTime() < Date.now()) {
      sub.currentPeriodEndsAt = new Date(Date.now() + 30 * 86400_000);
    }
    sub.updatedAt = new Date();
    await this.subRepo.save(sub);

    await this.orgRepo.update(sub.organizationId, { status: 'active', updatedAt: new Date() });

    await this.logHistory(sub.organizationId, sub.id, 'reactivated', actorId, sub.licenseCode, prev,
      { status: 'active' }, '');

    return sub;
  }

  async changePlan(subId: number, newPlanId: number, actorId: number): Promise<OrganizationSubscription> {
    const sub = await this.subRepo.findOneBy({ id: subId });
    if (!sub) throw new NotFoundException({ message: 'الترخيص غير موجود', code: 'LICENSE_NOT_FOUND' });

    const plan = await this.planRepo.findOneBy({ id: newPlanId });
    if (!plan) throw new NotFoundException({ message: 'الخطة غير موجودة', code: 'PLAN_NOT_FOUND' });

    const prevPlan = await this.planRepo.findOneBy({ id: sub.planId });
    const prev = { planId: sub.planId, planName: prevPlan?.name };

    sub.planId = newPlanId;
    sub.userLimit = plan.maxUsers;
    sub.branchLimit = plan.maxBranches;
    sub.features = (plan.features as Record<string, boolean>) ?? {};
    sub.updatedAt = new Date();
    await this.subRepo.save(sub);

    await this.logHistory(sub.organizationId, sub.id, 'plan_changed', actorId, sub.licenseCode, prev,
      { planId: newPlanId, planName: plan.name }, '');

    return sub;
  }

  async updateLicenseLimits(
    subId: number, actorId: number,
    limits: { userLimit?: number; branchLimit?: number; features?: Record<string, boolean> },
  ): Promise<OrganizationSubscription> {
    const sub = await this.subRepo.findOneBy({ id: subId });
    if (!sub) throw new NotFoundException({ message: 'الترخيص غير موجود', code: 'LICENSE_NOT_FOUND' });

    const prev = { userLimit: sub.userLimit, branchLimit: sub.branchLimit, features: sub.features };
    if (limits.userLimit !== undefined) sub.userLimit = limits.userLimit;
    if (limits.branchLimit !== undefined) sub.branchLimit = limits.branchLimit;
    if (limits.features !== undefined) sub.features = limits.features;
    sub.updatedAt = new Date();
    await this.subRepo.save(sub);

    await this.logHistory(sub.organizationId, sub.id, 'limits_changed', actorId, sub.licenseCode, prev,
      { userLimit: sub.userLimit, branchLimit: sub.branchLimit, features: sub.features }, '');

    return sub;
  }

  async getLicenseHistory(orgId: number): Promise<LicenseHistory[]> {
    return this.histRepo.find({ where: { organizationId: orgId }, order: { createdAt: 'DESC' }, take: 100 });
  }

  async getLicenseByCode(code: string): Promise<OrganizationSubscription | null> {
    return this.subRepo.findOne({ where: { licenseCode: code.toUpperCase() } });
  }

  async getAllLicenses(): Promise<Array<OrganizationSubscription & {
    organizationName: string | null;
    planName: string | null;
    trialStatus: string;
    trialExpiresAt: string | null;
    trialRemainingMs: number | null;
    expiresAt: string | null;
  }>> {
    const subs = await this.subRepo.find({ order: { createdAt: 'DESC' } });

    const orgIds = [...new Set(subs.map(s => s.organizationId))];
    const planIds = [...new Set(subs.map(s => s.planId))];
    const orgs = orgIds.length ? await this.orgRepo.find({ where: { id: In(orgIds) } }) : [];
    const plans = planIds.length ? await this.planRepo.find({ where: { id: In(planIds) } }) : [];
    const orgMap = new Map(orgs.map(o => [o.id, o]));
    const planMap = new Map(plans.map(p => [p.id, p]));

    const now = Date.now();
    return subs.map(s => {
      const isTrial = s.status === 'trialing' || !!s.trialEndsAt;
      const trialEnds = s.trialEndsAt ? s.trialEndsAt.getTime() : null;
      const trialStatus = isTrial
        ? (s.status === 'active'
            ? 'active'
            : trialEnds && trialEnds <= now ? 'expired' : (s.status === 'trialing' ? 'trialing' : s.status))
        : s.status;

      return {
        ...s,
        organizationName: orgMap.get(s.organizationId)?.name ?? null,
        planName: planMap.get(s.planId)?.name ?? null,
        trialStatus,
        trialExpiresAt: trialEnds ? new Date(trialEnds).toISOString() : null,
        trialRemainingMs: trialEnds ? Math.max(0, trialEnds - now) : null,
        expiresAt: s.currentPeriodEndsAt ? s.currentPeriodEndsAt.toISOString() : null,
      };
    });
  }

  // ── Usage stats ────────────────────────────────────────────────────

  async getUsageStatsSummary(): Promise<UsageStatsSummary> {
    const em = this.subRepo.manager;

    const [userRows, sessionRows] = await Promise.all([
      em.query(
        `SELECT COUNT(DISTINCT om.user_id)::int AS c
         FROM organization_members om
         JOIN organization_subscriptions s ON s.organization_id = om.organization_id
         WHERE om.status = 'active' AND s.status IN ('active', 'trialing')`,
      ),
      em.query(
        `SELECT COUNT(*)::int AS c
         FROM refresh_tokens
         WHERE revoked_at IS NULL AND expires_at > now()`,
      ),
    ]);

    return {
      totalUsers: Number(userRows[0]?.c ?? 0),
      activeSessions: Number(sessionRows[0]?.c ?? 0),
      apiCalls: { available: false, count: null },
      storage: { available: false, bytes: null },
    };
  }

  async getUsageStats(): Promise<Array<{
    orgId: number; orgName: string;
    users: number; branches: number; products: number;
    plan: string; status: string; periodEnd: Date | null;
    userLimit: number; branchLimit: number; features: Record<string, boolean>;
  }>> {
    const subs = await this.subRepo.find({ where: { status: In(['active', 'trialing']) } });
    const orgIds = subs.map(s => s.organizationId);
    if (!orgIds.length) return [];

    const orgs = await this.orgRepo.find({ where: { id: In(orgIds) } });
    const orgMap = new Map(orgs.map(o => [o.id, o]));

    const plans = await this.planRepo.find();
    const planMap = new Map(plans.map(p => [p.id, p]));

    const results = [];
    for (const sub of subs) {
      const org = orgMap.get(sub.organizationId);
      if (!org) continue;
      const userCount = await this.memberRepo.count({ where: { organizationId: sub.organizationId, status: 'active' } });
      const branchCount = await this.branchRepo.count({ where: { organizationId: sub.organizationId } });
      const productCount = await this.subRepo.manager.createQueryBuilder()
        .from('products', 'p').where('p.organization_id = :oid', { oid: sub.organizationId }).getCount();

      results.push({
        orgId: sub.organizationId,
        orgName: org.name,
        users: userCount,
        branches: branchCount,
        products: productCount,
        plan: planMap.get(sub.planId)?.name ?? '?',
        status: sub.status,
        periodEnd: sub.currentPeriodEndsAt,
        userLimit: sub.userLimit,
        branchLimit: sub.branchLimit,
        features: (sub.features as Record<string, boolean>) ?? {},
      });
    }
    return results;
  }

  // ── Server-Authoritative Trial (Phase 35) ────────────────────────

  private static readonly TRIAL_DURATION_MS = 24 * 60 * 60 * 1000; // 24 hours

  /** Start a 24-hour trial for an organization. Server-authoritative. */
  async startTrial(
    organizationId: number,
    deviceFingerprint: string,
  ): Promise<{ subscription: OrganizationSubscription; trialToken: string; expiresAt: string }> {
    // Check if org already has an active trial or license
    const existing = await this.subRepo.findOne({
      where: { organizationId, status: In(['trialing', 'active']) },
    });

    if (existing) {
      // If there's an active trial, check if it's still valid
      if (existing.status === 'trialing' && existing.trialEndsAt && existing.trialEndsAt.getTime() > Date.now()) {
        const trialToken = this.signTrialToken(organizationId, existing.trialStartsAt!, existing.trialEndsAt!, deviceFingerprint);
        return { subscription: existing, trialToken, expiresAt: existing.trialEndsAt.toISOString() };
      }
      // If there's an active license, reject
      if (existing.status === 'active') {
        throw new ConflictException({ message: 'المؤسسة لديها ترخيص نشط بالفعل', code: 'ORG_HAS_ACTIVE_LICENSE' });
      }
    }

    const now = new Date();
    const endsAt = new Date(now.getTime() + OwnerService.TRIAL_DURATION_MS);

    // Find or create trial plan
    let trialPlan = await this.planRepo.findOne({ where: { slug: 'trial' } });
    if (!trialPlan) {
      trialPlan = this.planRepo.create({
        name: 'Free Trial',
        slug: 'trial',
        description: '24-hour free trial',
        priceMonthly: 0,
        priceYearly: 0,
        currency: 'USD',
        trialDays: 1,
        maxUsers: 5,
        maxBranches: 2,
        maxProducts: 100,
        features: { products: true, inventory: true, sales: true, purchases: true, transfers: true, reports: true, pos: true },
        isActive: true,
        sortOrder: 0,
      });
      await this.planRepo.save(trialPlan);
    }

    // Create or update subscription
    let sub: OrganizationSubscription;
    if (existing) {
      existing.status = 'trialing';
      existing.planId = trialPlan.id;
      existing.trialStartsAt = now;
      existing.trialEndsAt = endsAt;
      existing.currentPeriodStartsAt = now;
      existing.currentPeriodEndsAt = endsAt;
      existing.updatedAt = now;
      sub = await this.subRepo.save(existing);
    } else {
      sub = this.subRepo.create({
        organizationId,
        planId: trialPlan.id,
        status: 'trialing',
        trialStartsAt: now,
        trialEndsAt: endsAt,
        currentPeriodStartsAt: now,
        currentPeriodEndsAt: endsAt,
      });
      sub = await this.subRepo.save(sub);
    }

    // Ensure org has subscription_id set
    await this.orgRepo.update(organizationId, { subscriptionId: sub.id, updatedAt: now });

    await this.logHistory(organizationId, sub.id, 'created', null, null, null, {
      status: 'trialing',
      trialEndsAt: endsAt.toISOString(),
      deviceFingerprint: deviceFingerprint.slice(0, 16) + '...',
    }, '24h trial started');

    const trialToken = this.signTrialToken(organizationId, now, endsAt, deviceFingerprint);
    return { subscription: sub, trialToken, expiresAt: endsAt.toISOString() };
  }

  /** Validate trial status server-side. Returns signed token for offline cache. */
  async validateTrial(
    organizationId: number,
    deviceFingerprint: string,
  ): Promise<{ valid: boolean; status: string; expiresAt: string | null; trialToken: string }> {
    const sub = await this.subRepo.findOne({
      where: { organizationId },
      order: { id: 'DESC' },
    });

    if (!sub) {
      return { valid: false, status: 'none', expiresAt: null, trialToken: '' };
    }

    if (sub.status === 'active') {
      // Active paid license
      const expiresAt = sub.currentPeriodEndsAt?.toISOString() || null;
      const trialToken = this.signTrialToken(organizationId, sub.currentPeriodStartsAt || new Date(), sub.currentPeriodEndsAt || new Date(), deviceFingerprint);
      return { valid: true, status: 'active', expiresAt, trialToken };
    }

    if (sub.status === 'trialing' && sub.trialEndsAt) {
      const now = new Date();
      if (sub.trialEndsAt.getTime() > now.getTime()) {
        const trialToken = this.signTrialToken(organizationId, sub.trialStartsAt!, sub.trialEndsAt, deviceFingerprint);
        return { valid: true, status: 'trialing', expiresAt: sub.trialEndsAt.toISOString(), trialToken };
      }
      return { valid: false, status: 'expired', expiresAt: sub.trialEndsAt.toISOString(), trialToken: '' };
    }

    if (sub.status === 'suspended') {
      return { valid: false, status: 'suspended', expiresAt: null, trialToken: '' };
    }

    if (sub.status === 'revoked') {
      return { valid: false, status: 'revoked', expiresAt: null, trialToken: '' };
    }

    return { valid: false, status: sub.status, expiresAt: null, trialToken: '' };
  }

  /** Sign trial data with Ed25519 (asymmetric — clients hold only the public key). */
  signTrialToken(
    organizationId: number,
    startsAt: Date,
    endsAt: Date,
    deviceFingerprint: string,
  ): string {
    const payload = JSON.stringify({
      org: organizationId,
      start: startsAt.getTime(),
      end: endsAt.getTime(),
      device: deviceFingerprint,
      ts: Date.now(),
      kid: loadTrialKeyId(),
    });
    const sig = crypto
      .sign(null, Buffer.from(payload, 'utf8'), loadTrialPrivateKey())
      .toString('hex');
    return Buffer.from(JSON.stringify({ p: payload, s: sig })).toString('base64url');
  }

  /** Verify a trial token's Ed25519 signature using the public half of the signing key. */
  verifyTrialToken(token: string): { valid: boolean; data?: Record<string, unknown> } {
    try {
      const decoded = JSON.parse(Buffer.from(token, 'base64url').toString());
      const publicKey = crypto.createPublicKey(loadTrialPrivateKey());
      const valid = crypto.verify(
        null,
        Buffer.from(decoded.p, 'utf8'),
        publicKey,
        Buffer.from(decoded.s, 'hex'),
      );
      if (!valid) return { valid: false };
      const data = JSON.parse(decoded.p);
      return { valid: true, data };
    } catch {
      return { valid: false };
    }
  }

  // ── Helpers ────────────────────────────────────────────────────────

  private slugify(text: string): string {
    return text
      .toLowerCase()
      .replace(/[^\w\s-]/g, '')
      .replace(/[\s_]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 50) || `org-${Date.now()}`;
  }

  private async logHistory(
    orgId: number, subId: number | null, action: string, actorId: number | null,
    licenseCode: string | null, prev: Record<string, unknown> | null,
    next: Record<string, unknown>, reason: string,
  ): Promise<void> {
    const entry = this.histRepo.create({
      organizationId: orgId, subscriptionId: subId, action,
      actorId, licenseCode, previousValue: prev, newValue: next, reason,
    });
    await this.histRepo.save(entry);
  }
}
