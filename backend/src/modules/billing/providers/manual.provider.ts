import {
  PaymentProvider,
  CheckoutResult,
  SubscriptionResult,
  PaymentStatus,
  WebhookVerifyResult,
} from './payment-provider.interface';

/**
 * Manual/self-hosted payment provider.
 * Used for free trials, self-hosted deployments, or when no external
 * payment provider is configured. Generates local IDs, no external API calls.
 */
export class ManualPaymentProvider implements PaymentProvider {
  readonly name = 'manual';

  async createCheckoutSession(input: {
    organizationId: number;
    planSlug: string;
    email: string;
    successUrl: string;
    cancelUrl: string;
  }): Promise<CheckoutResult> {
    // Manual provider: no external checkout needed — subscription is activated directly.
    return {
      sessionId: `manual_${input.organizationId}_${Date.now()}`,
    };
  }

  async createSubscription(input: {
    organizationId: number;
    planSlug: string;
    externalSubscriptionId?: string;
  }): Promise<SubscriptionResult> {
    return {
      externalSubscriptionId: input.externalSubscriptionId || `manual_sub_${input.organizationId}_${Date.now()}`,
      status: 'active',
    };
  }

  async cancelSubscription(input: {
    externalSubscriptionId: string;
    reason?: string;
  }): Promise<SubscriptionResult> {
    return {
      externalSubscriptionId: input.externalSubscriptionId,
      status: 'cancelled',
    };
  }

  async renewSubscription(input: {
    externalSubscriptionId: string;
    periodEnd: Date;
  }): Promise<SubscriptionResult> {
    return {
      externalSubscriptionId: input.externalSubscriptionId,
      status: 'active',
    };
  }

  async getPaymentStatus(input: {
    externalSubscriptionId: string;
  }): Promise<PaymentStatus> {
    return { status: 'active' };
  }

  async verifyWebhook(input: {
    headers: Record<string, string>;
    body: unknown;
  }): Promise<WebhookVerifyResult> {
    // Manual provider has no webhooks — always reject.
    return { valid: false, error: 'Manual provider does not support webhooks' };
  }
}
