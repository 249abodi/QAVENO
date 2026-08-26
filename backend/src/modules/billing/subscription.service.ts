import { ConflictException, ForbiddenException, Injectable, Logger } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { AuditService } from '../../common/audit.service';
import { AuthContext } from '../../common/auth-context';
import { PaymentProvider } from './providers/payment-provider.interface';

const TRIAL_PLAN_SLUG = 'trial';

export interface PlanLimits {
  maxUsers: number;
  maxBranches: number;
  maxProducts: number;
  features: Record<string, boolean>;
}

@Injectable()
export class SubscriptionService {
  private readonly logger = new Logger(SubscriptionService.name);
  private provider: PaymentProvider | null = null;

  constructor(
    private readonly ds: DataSource,
    private readonly audit: AuditService,
  ) {}

  /** Set the active payment provider (called at module init or via config). */
  setProvider(provider: PaymentProvider): void {
    this.provider = provider;
  }

  /** Get all active plans. */
  async listPlans(): Promise<Record<string, unknown>[]> {
    return this.ds.manager.query(
      `SELECT id, name, slug, description, price_monthly AS "priceMonthly",
              price_yearly AS "priceYearly", currency, trial_days AS "trialDays",
              max_users AS "maxUsers", max_branches AS "maxBranches",
              max_products AS "maxProducts", features, is_active AS "isActive",
              sort_order AS "sortOrder"
       FROM subscription_plans WHERE is_active=true ORDER BY sort_order, id`,
    );
  }

  /** Get a plan by slug. */
  async getPlan(slug: string): Promise<Record<string, unknown> | null> {
    const rows = await this.ds.manager.query(
      `SELECT id, name, slug, description, price_monthly AS "priceMonthly",
              price_yearly AS "priceYearly", currency, trial_days AS "trialDays",
              max_users AS "maxUsers", max_branches AS "maxBranches",
              max_products AS "maxProducts", features, is_active AS "isActive",
              sort_order AS "sortOrder"
       FROM subscription_plans WHERE slug=$1`,
      [slug],
    );
    return rows[0] || null;
  }

  /** Get the current subscription + plan for an organization. */
  async getOrganizationSubscription(organizationId: number): Promise<Record<string, unknown> | null> {
    const rows = await this.ds.manager.query(
      `SELECT os.id, os.organization_id AS "organizationId", os.plan_id AS "planId",
              os.status, os.trial_starts_at AS "trialStartsAt",
              os.trial_ends_at AS "trialEndsAt",
              os.current_period_starts_at AS "currentPeriodStartsAt",
              os.current_period_ends_at AS "currentPeriodEndsAt",
              os.cancelled_at AS "cancelledAt", os.cancel_reason AS "cancelReason",
              os.external_subscription_id AS "externalSubscriptionId",
              os.metadata, os.created_at AS "createdAt", os.updated_at AS "updatedAt",
              sp.name AS "planName", sp.slug AS "planSlug",
              sp.price_monthly AS "priceMonthly", sp.price_yearly AS "priceYearly",
              sp.currency, sp.trial_days AS "trialDays",
              sp.max_users AS "maxUsers", sp.max_branches AS "maxBranches",
              sp.max_products AS "maxProducts", sp.features AS "planFeatures"
       FROM organization_subscriptions os
       JOIN subscription_plans sp ON sp.id = os.plan_id
       WHERE os.organization_id=$1`,
      [organizationId],
    );
    return rows[0] || null;
  }

  /** Get subscription ID for an org (returns null if none). */
  async getSubscriptionId(organizationId: number): Promise<number | null> {
    const rows = await this.ds.manager.query(
      `SELECT id FROM organization_subscriptions WHERE organization_id=$1`,
      [organizationId],
    );
    return rows[0] ? Number(rows[0].id) : null;
  }

  /** Ensure an org has a subscription — creates trial if missing. */
  async ensureSubscription(organizationId: number): Promise<number> {
    const existing = await this.getSubscriptionId(organizationId);
    if (existing) return existing;
    return this.createTrialSubscription(organizationId);
  }

  /** Create a trial subscription for an organization. */
  async createTrialSubscription(organizationId: number): Promise<number> {
    const now = new Date();
    return this.ds.transaction(async (em) => {
      // Find trial plan
      const planRows = await em.query(
        `SELECT id, trial_days FROM subscription_plans WHERE slug=$1 AND is_active=true`,
        [TRIAL_PLAN_SLUG],
      );
      const plan = planRows[0];
      if (!plan) throw new ConflictException({ message: 'خطة التجربة غير متوفرة', code: 'TRIAL_PLAN_MISSING' });

      // Check if org already has a subscription
      const existing = await em.query(
        `SELECT id FROM organization_subscriptions WHERE organization_id=$1`,
        [organizationId],
      );
      if (existing[0]) return Number(existing[0].id);

      const trialDays = Number(plan.trial_days) || 14;
      const trialEnd = new Date(now.getTime() + trialDays * 24 * 60 * 60 * 1000);

      const subRows = await em.query(
        `INSERT INTO organization_subscriptions
           (organization_id, plan_id, status, trial_starts_at, trial_ends_at,
            current_period_starts_at, current_period_ends_at)
         VALUES ($1,$2,'trialing',$3,$4,$3,$4)
         RETURNING id`,
        [organizationId, plan.id, now, trialEnd],
      );
      const subId = Number(subRows[0].id);

      // Link org to subscription
      await em.query(
        `UPDATE organizations SET subscription_id=$1, updated_at=now() WHERE id=$2 AND subscription_id IS NULL`,
        [subId, organizationId],
      );

      // Log event
      await em.query(
        `INSERT INTO billing_events (organization_id, subscription_id, event_type, provider, payload, status, idempotency_key)
         VALUES ($1,$2,'subscription.trial_started','system',$3,'processed',$4)`,
        [organizationId, subId, JSON.stringify({ planId: plan.id, trialEndsAt: trialEnd.toISOString() }),
         `trial-create-${organizationId}-${Date.now()}`],
      );

      return subId;
    });
  }

  /** Subscribe to a plan (upgrade from trial or change plan). */
  async subscribe(
    ctx: AuthContext,
    planSlug: string,
  ): Promise<Record<string, unknown>> {
    const plan = await this.getPlan(planSlug);
    if (!plan) throw new ConflictException({ message: 'الخطة غير موجودة', code: 'PLAN_NOT_FOUND' });
    if (!plan.isActive) throw new ConflictException({ message: 'الخطة غير متاحة حالياً', code: 'PLAN_INACTIVE' });

    const now = new Date();
    const periodEnd = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000); // 30 days

    return this.ds.transaction(async (em) => {
      // Get or create subscription
      let subRows = await em.query(
        `SELECT os.id, os.status, os.plan_id AS "planId", sp.slug AS "planSlug"
         FROM organization_subscriptions os
         JOIN subscription_plans sp ON sp.id=os.plan_id
         WHERE os.organization_id=$1 FOR UPDATE`,
        [ctx.organizationId],
      );

      let subId: number;
      if (subRows[0]) {
        subId = Number(subRows[0].id);
        const currentStatus = subRows[0].status;
        const currentPlanSlug = subRows[0].planSlug;

        // Cancelled subscriptions: reactivate the existing row
        if (currentStatus === 'cancelled') {
          await em.query(
            `UPDATE organization_subscriptions
             SET plan_id=$1, status='active',
                 current_period_starts_at=$2, current_period_ends_at=$3,
                 cancelled_at=NULL, updated_at=now()
             WHERE id=$4`,
            [plan.id, now, periodEnd, subId],
          );
        } else {
          // Cannot change to same plan (only for non-cancelled)
          if (currentPlanSlug === planSlug) {
            throw new ConflictException({ message: 'أنت مشترك في هذه الخطة بالفعل', code: 'ALREADY_SUBSCRIBED' });
          }
          // Update to new plan (active / past_due / trialing)
          await em.query(
            `UPDATE organization_subscriptions
             SET plan_id=$1, status='active',
                 current_period_starts_at=$2, current_period_ends_at=$3,
                 updated_at=now()
             WHERE id=$4`,
            [plan.id, now, periodEnd, subId],
          );
        }

        // If upgrading from trial, also update org status if suspended
        if (currentStatus === 'trialing' || currentStatus === 'suspended') {
          await em.query(
            `UPDATE organizations SET status='active', updated_at=now() WHERE id=$1`,
            [ctx.organizationId],
          );
        }
      } else {
        // Create new subscription
        const newSubRows = await em.query(
          `INSERT INTO organization_subscriptions
             (organization_id, plan_id, status, current_period_starts_at, current_period_ends_at)
           VALUES ($1,$2,'active',$3,$4)
           RETURNING id`,
          [ctx.organizationId, plan.id, now, periodEnd],
        );
        subId = Number(newSubRows[0].id);
        await em.query(
          `UPDATE organizations SET subscription_id=$1, updated_at=now() WHERE id=$2`,
          [subId, ctx.organizationId],
        );
      }

      // Try payment via provider
      let externalId: string | null = null;
      if (this.provider) {
        try {
          const result = await this.provider.createSubscription({
            organizationId: ctx.organizationId,
            planSlug,
          });
          if (result.externalSubscriptionId) {
            externalId = result.externalSubscriptionId;
            await em.query(
              `UPDATE organization_subscriptions SET external_subscription_id=$1 WHERE id=$2`,
              [externalId, subId],
            );
          }
        } catch (err: any) {
          this.logger.warn(`Payment provider error: ${err.message}`);
        }
      }

      // Log event
      await em.query(
        `INSERT INTO billing_events (organization_id, subscription_id, event_type, provider, payload, status, idempotency_key)
         VALUES ($1,$2,'subscription.created','manual',$3,'processed',$4)`,
        [ctx.organizationId, subId, JSON.stringify({ planSlug, externalId }),
         `sub-create-${ctx.organizationId}-${Date.now()}`],
      );

      await this.audit.log(em, {
        actorId: ctx.userId,
        action: 'subscription.subscribe',
        entityType: 'organization',
        entityId: ctx.organizationId,
        details: { planSlug, subId },
        organizationId: ctx.organizationId,
      });

      return { id: subId, planSlug, status: 'active' };
    });
  }

  /** Cancel a subscription. */
  async cancel(ctx: AuthContext, reason?: string): Promise<{ ok: true }> {
    return this.ds.transaction(async (em) => {
      const subRows = await em.query(
        `SELECT os.id, os.status, os.external_subscription_id AS "externalId"
         FROM organization_subscriptions os
         WHERE os.organization_id=$1 FOR UPDATE`,
        [ctx.organizationId],
      );
      const sub = subRows[0];
      if (!sub) throw new ConflictException({ message: 'لا يوجد اشتراك', code: 'NO_SUBSCRIPTION' });
      if (sub.status === 'cancelled') {
        throw new ConflictException({ message: 'الاشتراك ملغى بالفعل', code: 'ALREADY_CANCELLED' });
      }

      const now = new Date();

      // Cancel via provider if available
      if (this.provider && sub.externalId) {
        try {
          await this.provider.cancelSubscription({
            externalSubscriptionId: sub.externalId,
            reason,
          });
        } catch (err: any) {
          this.logger.warn(`Payment provider cancel error: ${err.message}`);
        }
      }

      await em.query(
        `UPDATE organization_subscriptions
         SET status='cancelled', cancelled_at=$1, cancel_reason=$2, updated_at=now()
         WHERE id=$3`,
        [now, reason || '', sub.id],
      );

      await em.query(
        `INSERT INTO billing_events (organization_id, subscription_id, event_type, provider, payload, status, idempotency_key)
         VALUES ($1,$2,'subscription.cancelled','manual',$3,'processed',$4)`,
        [ctx.organizationId, sub.id, JSON.stringify({ reason }),
         `sub-cancel-${ctx.organizationId}-${Date.now()}`],
      );

      await this.audit.log(em, {
        actorId: ctx.userId,
        action: 'subscription.cancel',
        entityType: 'organization',
        entityId: ctx.organizationId,
        details: { reason },
        organizationId: ctx.organizationId,
      });

      return { ok: true as const };
    });
  }

  /** Renew/extend a subscription period. */
  async renew(ctx: AuthContext): Promise<{ ok: true }> {
    return this.ds.transaction(async (em) => {
      const subRows = await em.query(
        `SELECT os.id, os.status, os.current_period_ends_at AS "periodEnd",
                os.external_subscription_id AS "externalId"
         FROM organization_subscriptions os
         WHERE os.organization_id=$1 FOR UPDATE`,
        [ctx.organizationId],
      );
      const sub = subRows[0];
      if (!sub) throw new ConflictException({ message: 'لا يوجد اشتراك', code: 'NO_SUBSCRIPTION' });

      const now = new Date();
      // Extend from current period end or now, whichever is later
      const base = sub.periodEnd && new Date(sub.periodEnd).getTime() > now.getTime()
        ? new Date(sub.periodEnd) : now;
      const newEnd = new Date(base.getTime() + 30 * 24 * 60 * 60 * 1000);

      await em.query(
        `UPDATE organization_subscriptions
         SET status='active', current_period_starts_at=$1, current_period_ends_at=$2, updated_at=now()
         WHERE id=$3`,
        [now, newEnd, sub.id],
      );

      // Renew via provider if available
      if (this.provider && sub.externalId) {
        try {
          await this.provider.renewSubscription({
            externalSubscriptionId: sub.externalId,
            periodEnd: newEnd,
          });
        } catch (err: any) {
          this.logger.warn(`Payment provider renew error: ${err.message}`);
        }
      }

      // If org was suspended, reactivate
      await em.query(
        `UPDATE organizations SET status='active', updated_at=now() WHERE id=$1 AND status='suspended'`,
        [ctx.organizationId],
      );

      await em.query(
        `INSERT INTO billing_events (organization_id, subscription_id, event_type, provider, payload, status, idempotency_key)
         VALUES ($1,$2,'subscription.renewed','manual',$3,'processed',$4)`,
        [ctx.organizationId, sub.id, JSON.stringify({ newPeriodEnd: newEnd.toISOString() }),
         `sub-renew-${ctx.organizationId}-${Date.now()}`],
      );

      await this.audit.log(em, {
        actorId: ctx.userId,
        action: 'subscription.renew',
        entityType: 'organization',
        entityId: ctx.organizationId,
        organizationId: ctx.organizationId,
      });

      return { ok: true as const };
    });
  }

  /** Get current subscription limits for an organization. */
  async getLimits(organizationId: number): Promise<PlanLimits> {
    const rows = await this.ds.manager.query(
      `SELECT sp.max_users AS "maxUsers", sp.max_branches AS "maxBranches",
              sp.max_products AS "maxProducts", sp.features
       FROM organization_subscriptions os
       JOIN subscription_plans sp ON sp.id=os.plan_id
       WHERE os.organization_id=$1`,
      [organizationId],
    );
    if (!rows[0]) {
      // No subscription — use most permissive defaults (trial-like)
      return { maxUsers: 5, maxBranches: 2, maxProducts: 100, features: { products: true, inventory: true, sales: true, purchases: true, transfers: true, reports: true, pos: true } };
    }
    return {
      maxUsers: Number(rows[0].maxUsers) || 0,
      maxBranches: Number(rows[0].maxBranches) || 0,
      maxProducts: Number(rows[0].maxProducts) || 0,
      features: rows[0].features || {},
    };
  }

  /** Check if an organization can perform an action based on current subscription. */
  async checkAccess(organizationId: number, feature: string): Promise<{ allowed: boolean; reason?: string }> {
    // Check if org is suspended
    const orgRows = await this.ds.manager.query(
      `SELECT id, status FROM organizations WHERE id=$1`,
      [organizationId],
    );
    if (orgRows[0]?.status === 'suspended') {
      return { allowed: false, reason: 'SUBSCRIPTION_SUSPENDED' };
    }

    // Check subscription status
    const subRows = await this.ds.manager.query(
      `SELECT os.id, os.status, os.trial_ends_at AS "trialEndsAt"
       FROM organization_subscriptions os
       WHERE os.organization_id=$1`,
      [organizationId],
    );
    const sub = subRows[0];
    if (sub) {
      // Check if trial has expired
      if (sub.status === 'trialing' && sub.trialEndsAt) {
        if (new Date(sub.trialEndsAt).getTime() <= Date.now()) {
          return { allowed: false, reason: 'TRIAL_EXPIRED' };
        }
      }
      // Cancelled subscriptions: allow read-only, block writes after grace period
      if (sub.status === 'cancelled') {
        return { allowed: false, reason: 'SUBSCRIPTION_CANCELLED' };
      }
    }

    // Check feature access
    const limits = await this.getLimits(organizationId);
    if (limits.features && !limits.features[feature] && limits.features[feature] !== undefined) {
      return { allowed: false, reason: `FEATURE_NOT_AVAILABLE: ${feature}` };
    }

    return { allowed: true };
  }

  /** Check if an organization is within its usage limits. */
  async checkLimits(organizationId: number, resource: 'users' | 'branches' | 'products'): Promise<{ allowed: boolean; current: number; max: number; reason?: string }> {
    const limits = await this.getLimits(organizationId);

    let current = 0;
    let max = 0;

    switch (resource) {
      case 'users': {
        const rows = await this.ds.manager.query(
          `SELECT COUNT(*)::int AS c FROM organization_members WHERE organization_id=$1 AND status='active'`,
          [organizationId],
        );
        current = Number(rows[0]?.c || 0);
        max = limits.maxUsers;
        break;
      }
      case 'branches': {
        const rows = await this.ds.manager.query(
          `SELECT COUNT(*)::int AS c FROM branches WHERE organization_id=$1 AND status='active'`,
          [organizationId],
        );
        current = Number(rows[0]?.c || 0);
        max = limits.maxBranches;
        break;
      }
      case 'products': {
        const rows = await this.ds.manager.query(
          `SELECT COUNT(*)::int AS c FROM products WHERE organization_id=$1`,
          [organizationId],
        );
        current = Number(rows[0]?.c || 0);
        max = limits.maxProducts;
        break;
      }
    }

    // 0 means unlimited
    if (max === 0) return { allowed: true, current, max: 0 };

    if (current >= max) {
      return { allowed: false, current, max, reason: `LIMIT_EXCEEDED_${resource.toUpperCase()}` };
    }

    return { allowed: true, current, max };
  }

  /** Check trial expiration and suspend if needed (called periodically). */
  async checkTrialExpiration(): Promise<number> {
    const now = new Date();
    const expired = await this.ds.manager.query(
      `UPDATE organizations o SET status='suspended', updated_at=now()
       FROM organization_subscriptions os
       WHERE os.organization_id=o.id
         AND os.status='trialing'
         AND os.trial_ends_at IS NOT NULL
         AND os.trial_ends_at < $1
         AND o.status='active'
       RETURNING o.id`,
      [now],
    );

    // Update subscription statuses too
    if (expired.length > 0) {
      await this.ds.manager.query(
        `UPDATE organization_subscriptions os SET status='suspended', updated_at=now()
         WHERE os.status='trialing'
         AND os.trial_ends_at IS NOT NULL
         AND os.trial_ends_at < $1`,
        [now],
      );

      // Log events
      for (const row of expired) {
        await this.ds.manager.query(
          `INSERT INTO billing_events (organization_id, event_type, provider, payload, status, idempotency_key)
           VALUES ($1,'subscription.trial_expired','system',$2,'processed',$3)`,
          [row.id, JSON.stringify({ suspendedAt: now.toISOString() }),
           `trial-expire-${row.id}-${now.getTime()}`],
        );
      }
    }

    return expired.length;
  }

  /** Get billing history for an organization. */
  async getBillingHistory(organizationId: number, limit = 50): Promise<Record<string, unknown>[]> {
    return this.ds.manager.query(
      `SELECT id, event_type AS "eventType", provider, payload, status, error_message AS "errorMessage",
              created_at AS "createdAt"
       FROM billing_events
       WHERE organization_id=$1
       ORDER BY created_at DESC
       LIMIT $2`,
      [organizationId, limit],
    );
  }

  /** Get invoices for an organization. */
  async getInvoices(organizationId: number, limit = 50): Promise<Record<string, unknown>[]> {
    return this.ds.manager.query(
      `SELECT id, invoice_number AS "invoiceNumber", amount, currency, status,
              period_starts_at AS "periodStartsAt", period_ends_at AS "periodEndsAt",
              paid_at AS "paidAt", created_at AS "createdAt"
       FROM billing_invoices
       WHERE organization_id=$1
       ORDER BY created_at DESC
       LIMIT $2`,
      [organizationId, limit],
    );
  }
}
