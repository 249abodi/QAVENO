import { CanActivate, ExecutionContext, Injectable, ForbiddenException, Logger } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { DataSource } from 'typeorm';
import { AUTH_CTX_KEY, AuthContext } from './auth-context';

export const REQUIRE_SUBSCRIPTION_KEY = 'storaga.requireSubscription';
export const REQUIRE_FEATURE_KEY = 'storaga.requireFeature';

/**
 * Subscription enforcement guard.
 * Checks that the organization has an active subscription and
 * has not exceeded limits. Applied globally or per-route.
 */
@Injectable()
export class SubscriptionGuard implements CanActivate {
  private readonly logger = new Logger(SubscriptionGuard.name);

  constructor(
    private readonly ds: DataSource,
    private readonly reflector: Reflector,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    // Check if route bypasses subscription check
    const skipSubscription = this.reflector.getAllAndOverride<boolean | undefined>(
      'storaga.skipSubscription',
      [context.getHandler(), context.getClass()],
    );
    if (skipSubscription) return true;

    const req = context.switchToHttp().getRequest();
    const ctx: AuthContext | undefined = req[AUTH_CTX_KEY];
    if (!ctx) return true; // Unauthenticated — JWT guard will handle

    const orgId = ctx.organizationId;
    if (!orgId) return true;

    // Check organization status
    const orgRows = await this.ds.manager.query(
      `SELECT status FROM organizations WHERE id=$1`,
      [orgId],
    );
    if (orgRows[0]?.status === 'suspended') {
      throw new ForbiddenException({
        message: 'تم تعليق الاشتراك — يرجى تجديد أو ترقية الخطة',
        code: 'SUBSCRIPTION_SUSPENDED',
      });
    }
    if (orgRows[0]?.status === 'disabled') {
      throw new ForbiddenException({
        message: 'تم تعطيل المؤسسة — يرجى التواصل مع الدعم',
        code: 'ORG_DISABLED',
      });
    }

    // Check subscription status and trial expiration
    const subRows = await this.ds.manager.query(
      `SELECT os.status, os.trial_ends_at AS "trialEndsAt", os.current_period_ends_at AS "periodEnd"
       FROM organization_subscriptions os
       WHERE os.organization_id=$1`,
      [orgId],
    );
    const sub = subRows[0];
    if (sub) {
      if (sub.status === 'trialing' && sub.trialEndsAt) {
        if (new Date(sub.trialEndsAt).getTime() <= Date.now()) {
          throw new ForbiddenException({
            message: 'انتهت فترة التجربة — يرجى الاشتراك في خطة مدفوعة',
            code: 'TRIAL_EXPIRED',
          });
        }
      }
      if (sub.status === 'cancelled') {
        throw new ForbiddenException({
          message: 'تم إلغاء الاشتراك — يرجى الاشتراك في خطة جديدة',
          code: 'SUBSCRIPTION_CANCELLED',
        });
      }
      if (sub.status === 'suspended') {
        throw new ForbiddenException({
          message: 'تم تعليق الترخيص — يرجى التواصل مع مالك المنصة',
          code: 'LICENSE_SUSPENDED',
        });
      }
      if (sub.status === 'revoked') {
        throw new ForbiddenException({
          message: 'تم إلغاء الترخيص — يرجى التواصل مع مالك المنصة',
          code: 'LICENSE_REVOKED',
        });
      }
      if (sub.status === 'active' && sub.periodEnd) {
        if (new Date(sub.periodEnd).getTime() < Date.now()) {
          throw new ForbiddenException({
            message: 'انتهت صلاحية الترخيص — يرجى تمديد الترخيص',
            code: 'LICENSE_EXPIRED',
          });
        }
      }
    }

    // Check feature requirements
    const requiredFeature = this.reflector.getAllAndOverride<string | undefined>(
      REQUIRE_FEATURE_KEY,
      [context.getHandler(), context.getClass()],
    );
    if (requiredFeature) {
      const limitsRows = await this.ds.manager.query(
        `SELECT sp.features
         FROM organization_subscriptions os
         JOIN subscription_plans sp ON sp.id=os.plan_id
         WHERE os.organization_id=$1`,
        [orgId],
      );
      const features = limitsRows[0]?.features || {};
      if (features && !features[requiredFeature] && features[requiredFeature] !== undefined) {
        throw new ForbiddenException({
          message: `هذه الميزة غير متاحة في خطتك الحالية — يرجى الترقية`,
          code: `FEATURE_NOT_AVAILABLE`,
        });
      }
    }

    return true;
  }
}
