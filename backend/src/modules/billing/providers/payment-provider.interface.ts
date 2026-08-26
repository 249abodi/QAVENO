/**
 * Payment provider abstraction layer.
 * Each provider implements this interface for checkout, subscription management,
 * and webhook verification. The system is NOT hard-coded to any single provider.
 */
export interface CheckoutResult {
  checkoutUrl?: string;
  sessionId?: string;
  error?: string;
}

export interface SubscriptionResult {
  externalSubscriptionId?: string;
  status?: string;
  error?: string;
}

export interface PaymentStatus {
  status: 'pending' | 'active' | 'past_due' | 'cancelled' | 'suspended' | 'trialing';
  currentPeriodEnd?: Date;
  cancelAt?: Date;
  canceledAt?: Date;
}

export interface WebhookEvent {
  id: string;
  type: string;
  payload: unknown;
  timestamp: Date;
}

export interface WebhookVerifyResult {
  valid: boolean;
  event?: WebhookEvent;
  error?: string;
}

export interface PaymentProvider {
  readonly name: string;

  /** Create a checkout session for subscribing to a plan. */
  createCheckoutSession(input: {
    organizationId: number;
    planSlug: string;
    email: string;
    successUrl: string;
    cancelUrl: string;
  }): Promise<CheckoutResult>;

  /** Create or update a subscription (called after successful checkout). */
  createSubscription(input: {
    organizationId: number;
    planSlug: string;
    externalSubscriptionId?: string;
  }): Promise<SubscriptionResult>;

  /** Cancel a subscription. */
  cancelSubscription(input: {
    externalSubscriptionId: string;
    reason?: string;
  }): Promise<SubscriptionResult>;

  /** Renew/extend a subscription period. */
  renewSubscription(input: {
    externalSubscriptionId: string;
    periodEnd: Date;
  }): Promise<SubscriptionResult>;

  /** Get current payment status from the provider. */
  getPaymentStatus(input: {
    externalSubscriptionId: string;
  }): Promise<PaymentStatus>;

  /** Verify and parse a webhook event from the provider. */
  verifyWebhook(input: {
    headers: Record<string, string>;
    body: unknown;
  }): Promise<WebhookVerifyResult>;
}
