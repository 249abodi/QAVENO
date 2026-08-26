import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import {
  Organization, OrganizationMember, OrganizationSubscription,
  SubscriptionPlan, LicenseHistory, User, Branch,
} from '../../database/entities';
import { CommonModule } from '../../common/common.module';
import { OwnerService } from './owner.service';
import { OwnerController } from './owner.controller';

@Module({
  imports: [
    CommonModule,
    TypeOrmModule.forFeature([
      Organization, OrganizationMember, OrganizationSubscription,
      SubscriptionPlan, LicenseHistory, User, Branch,
    ]),
  ],
  controllers: [OwnerController],
  providers: [OwnerService],
  exports: [OwnerService],
})
export class OwnerModule {}
