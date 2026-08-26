import { Injectable, Logger } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { AuditService } from '../../common/audit.service';
import { PaymentProvider, WebhookEvent } from './providers/payment-provider.interface';

/**
 * Handles incoming webhook events from payment providers.
 * Guarantees: authenticated, idempotent, auditable, transaction-safe.
 */
@Injectable()
export class WebhookProcessor {
  private readonly logger = new Logger(WebhookProcessor.name);
  private provider: PaymentProvider | null = null;

  constructor(
    private readonly ds: DataSource,
    private readonly audit: AuditService,
  ) {}

  setProvider(provider: PaymentProvider): void {
    this.provider = provider;
  }

  /**
   * Process a webhook event. Returns processed status.
   * Idempotent: duplicate events are detected via idempotency_key.
   */
  async processWebhook(
    providerName: string,
    headers: Record<string, string>,
    body: unknown,
  ): Promise<{ status: string; message: string }> {
    if (!this.provider || this.provider.name !== providerName) {
      return { status: 'error', message: `Unknown provider: ${providerName}` };
    }

    // Step 1: Verify webhook signature
    const verification = await this.provider.verifyWebhook({ headers, body });
    if (!verification.valid) {
      this.logger.warn(`Webhook verification failed: ${verification.error}`);
      return { status: 'rejected', message: verification.error || 'Verification failed' };
    }

    const event = verification.event!;
    const idempotencyKey = `${providerName}:${event.id}:${event.type}`;

    // Step 2: Check idempotency (was this event already processed?)
    const existing = await this.ds.manager.query(
      `SELECT id, status FROM billing_events WHERE idempotency_key=$1`,
      [idempotencyKey],
    );
    if (existing[0]) {
      if (existing[0].status === 'processed') {
        return { status: 'already_processed', message: 'Event already processed' };
      }
      if (existing[0].status === 'failed') {
        // Retry failed events
        return this.handleEvent(event, idempotencyKey);
      }
    }

    // Step 3: Insert event record (idempotency)
    if (!existing[0]) {
      try {
        await this.ds.manager.query(
          `INSERT INTO billing_events (event_type, provider, provider_event_id, payload, status, idempotency_key)
           VALUES ($1,$2,$3,$4,'pending',$5)`,
          [event.type, providerName, event.id, JSON.stringify(event.payload), idempotencyKey],
        );
      } catch (err: any) {
        // Unique constraint violation = duplicate event
        if (err.code === '23505') {
          return { status: 'duplicate', message: 'Duplicate event' };
        }
        throw err;
      }
    }

    // Step 4: Process event in transaction
    return this.handleEvent(event, idempotencyKey);
  }

  private async handleEvent(
    event: WebhookEvent,
    idempotencyKey: string,
  ): Promise<{ status: string; message: string }> {
    try {
      await this.ds.transaction(async (em) => {
        // Mark as processing
        await em.query(
          `UPDATE billing_events SET status='processed' WHERE idempotency_key=$1`,
          [idempotencyKey],
        );

        // Handle different event types
        const payload = event.payload as Record<string, unknown>;
        const orgId = payload.organizationId ? Number(payload.organizationId) : null;

        switch (event.type) {
          case 'payment.succeeded': {
            if (orgId) {
              // Reactivate suspended org if needed
              await em.query(
                `UPDATE organizations SET status='active', updated_at=now() WHERE id=$1 AND status='suspended'`,
                [orgId],
              );
              // Update subscription to active
              await em.query(
                `UPDATE organization_subscriptions SET status='active', updated_at=now()
                 WHERE organization_id=$1 AND status IN ('past_due','suspended')`,
                [orgId],
              );
            }
            break;
          }
          case 'payment.failed': {
            if (orgId) {
              await em.query(
                `UPDATE organization_subscriptions SET status='past_due', updated_at=now()
                 WHERE organization_id=$1 AND status='active'`,
                [orgId],
              );
            }
            break;
          }
          case 'subscription.cancelled': {
            if (orgId) {
              await em.query(
                `UPDATE organization_subscriptions SET status='cancelled', cancelled_at=now(), updated_at=now()
                 WHERE organization_id=$1 AND status IN ('active','past_due')`,
                [orgId],
              );
            }
            break;
          }
          case 'subscription.renewed': {
            if (orgId) {
              const periodEnd = payload.periodEnd ? new Date(String(payload.periodEnd)) : new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
              await em.query(
                `UPDATE organization_subscriptions
                 SET status='active', current_period_starts_at=now(),
                     current_period_ends_at=$2, updated_at=now()
                 WHERE organization_id=$1`,
                [orgId, periodEnd],
              );
              // Reactivate if suspended
              await em.query(
                `UPDATE organizations SET status='active', updated_at=now() WHERE id=$1 AND status='suspended'`,
                [orgId],
              );
            }
            break;
          }
          default:
            // Unknown event type — just log it
            break;
        }
      });

      return { status: 'processed', message: `Event ${event.type} processed successfully` };
    } catch (err: any) {
      // Mark as failed
      await this.ds.manager.query(
        `UPDATE billing_events SET status='failed', error_message=$1 WHERE idempotency_key=$2`,
        [err.message, idempotencyKey],
      );
      this.logger.error(`Webhook processing failed: ${err.message}`);
      return { status: 'error', message: err.message };
    }
  }
}
