import { Body, Controller, Get, Param, ParseIntPipe, Patch, Post } from '@nestjs/common';
import { IsIn, IsOptional, IsString, MaxLength } from 'class-validator';
import { BranchesService } from './branches.service';
import { CurrentAuth, AuthContext, RequirePermission } from '../../common/auth-context';
import { DomainError } from '../../common/domain.error';

export class CreateBranchDto {
  @IsString() @MaxLength(120) name!: string;
  @IsOptional() @IsString() @MaxLength(20) code?: string;
  @IsOptional() @IsString() address?: string;
  @IsOptional() @IsString() phone?: string;
}

export class UpdateBranchDto {
  @IsOptional() @IsString() @MaxLength(120) name?: string;
  @IsOptional() @IsString() @MaxLength(20) code?: string | null;
  @IsOptional() @IsString() address?: string;
  @IsOptional() @IsString() phone?: string;
  @IsOptional() @IsString() @IsIn(['active', 'disabled']) status?: string;
}

@Controller('branches')
export class BranchesController {
  constructor(private readonly branches: BranchesService) {}

  @Get()
  @RequirePermission('branches.read')
  list(@CurrentAuth() ctx: AuthContext) {
    return this.branches.listWithStats(ctx);
  }

  @Get('mine')
  mine(@CurrentAuth() ctx: AuthContext) {
    return this.branches.mine(ctx);
  }

  @Post()
  @RequirePermission('branches.manage')
  create(@Body() dto: CreateBranchDto, @CurrentAuth() ctx: AuthContext) {
    return this.branches.create(ctx, { ...dto, actorId: ctx.userId });
  }

  @Patch(':id')
  @RequirePermission('branches.manage')
  update(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: UpdateBranchDto,
    @CurrentAuth() ctx: AuthContext,
  ) {
    return this.branches.update(ctx, id, { ...dto, actorId: ctx.userId });
  }
}
