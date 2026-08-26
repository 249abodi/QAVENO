import { Module } from '@nestjs/common';
import { BranchesController } from './branches.controller';
import { BranchesService } from './branches.service';
import { DomainSupport } from '../../common/domain-support';
import { AuditService } from '../../common/audit.service';

@Module({
  controllers: [BranchesController],
  providers: [BranchesService],
})
export class BranchesModule {}
