import { Inject, Module } from '@nestjs/common';
import { BillingController } from './billing.controller';
import { SubscriptionService } from './subscription.service';
import { WebhookProcessor } from './webhook.processor';
import { ManualPaymentProvider } from './providers/manual.provider';
import { CommonModule } from '../../common/common.module';

@Module({
  imports: [CommonModule],
  controllers: [BillingController],
  providers: [
    SubscriptionService,
    WebhookProcessor,
    {
      provide: 'PAYMENT_PROVIDER',
      useFactory: () => new ManualPaymentProvider(),
    },
  ],
  exports: [SubscriptionService, WebhookProcessor],
})
export class BillingModule {
  constructor(
    private readonly webhookProcessor: WebhookProcessor,
    @Inject('PAYMENT_PROVIDER') private readonly paymentProvider: ManualPaymentProvider,
  ) {
    this.webhookProcessor.setProvider(this.paymentProvider);
  }
}
