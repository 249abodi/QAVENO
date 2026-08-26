import { Body, Controller, Get, Param, Post, Req } from '@nestjs/common';
import { IsOptional, IsString } from 'class-validator';
import { SubscriptionService } from './subscription.service';
import { WebhookProcessor } from './webhook.processor';
import { CurrentAuth, AuthContext, RequirePermission, Public } from '../../common/auth-context';

class SubscribeDto {
  @IsString() planSlug!: string;
}

class CancelDto {
  @IsOptional() @IsString() reason?: string;
}

@Controller('billing')
export class BillingController {
  constructor(
    private readonly subscriptions: SubscriptionService,
    private readonly webhooks: WebhookProcessor,
  ) {}

  /** List all available plans (public for signup pages). */
  @Get('plans')
  @Public()
  listPlans() {
    return this.subscriptions.listPlans();
  }

  /** Get a plan by slug. */
  @Get('plans/:slug')
  @Public()
  getPlan(@Param('slug') slug: string) {
    return this.subscriptions.getPlan(slug);
  }

  /** Get current organization's subscription. */
  @Get('subscription')
  @RequirePermission('settings.manage')
  getSubscription(@CurrentAuth() ctx: AuthContext) {
    return this.subscriptions.getOrganizationSubscription(ctx.organizationId);
  }

  /** Get current plan limits. */
  @Get('limits')
  @RequirePermission('settings.read')
  async getLimits(@CurrentAuth() ctx: AuthContext) {
    const limits = await this.subscriptions.getLimits(ctx.organizationId);
    const usage = {
      users: await this.subscriptions.checkLimits(ctx.organizationId, 'users'),
      branches: await this.subscriptions.checkLimits(ctx.organizationId, 'branches'),
      products: await this.subscriptions.checkLimits(ctx.organizationId, 'products'),
    };
    return { limits, usage };
  }

  /** Subscribe to a plan (create or upgrade). */
  @Post('subscribe')
  @RequirePermission('settings.manage')
  subscribe(@Body() dto: SubscribeDto, @CurrentAuth() ctx: AuthContext) {
    return this.subscriptions.subscribe(ctx, dto.planSlug);
  }

  /** Cancel subscription. */
  @Post('cancel')
  @RequirePermission('settings.manage')
  cancel(@Body() dto: CancelDto, @CurrentAuth() ctx: AuthContext) {
    return this.subscriptions.cancel(ctx, dto.reason);
  }

  /** Renew/extend subscription. */
  @Post('renew')
  @RequirePermission('settings.manage')
  renew(@CurrentAuth() ctx: AuthContext) {
    return this.subscriptions.renew(ctx);
  }

  /** Get billing history. */
  @Get('history')
  @RequirePermission('settings.read')
  getHistory(@CurrentAuth() ctx: AuthContext) {
    return this.subscriptions.getBillingHistory(ctx.organizationId);
  }

  /** Get invoices. */
  @Get('invoices')
  @RequirePermission('settings.read')
  getInvoices(@CurrentAuth() ctx: AuthContext) {
    return this.subscriptions.getInvoices(ctx.organizationId);
  }

  /** Webhook endpoint for payment providers. */
  @Post('webhook/:provider')
  @Public()
  async handleWebhook(
    @Param('provider') provider: string,
    @Req() req: any,
  ) {
    const headers: Record<string, string> = {};
    for (const key of Object.keys(req.headers || {})) {
      if (typeof req.headers[key] === 'string') {
        headers[key] = req.headers[key];
      }
    }
    return this.webhooks.processWebhook(provider, headers, req.body);
  }
}
