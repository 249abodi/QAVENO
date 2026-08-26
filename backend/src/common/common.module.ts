import { Global, Module } from '@nestjs/common';
import { BranchAccessService } from './branch-access.service';
import { AuditService } from './audit.service';
import { DomainSupport } from './domain-support';

/** Global infra services shared by all feature modules. */
@Global()
@Module({
  providers: [BranchAccessService, AuditService, DomainSupport],
  exports: [BranchAccessService, AuditService, DomainSupport],
})
export class CommonModule {}
