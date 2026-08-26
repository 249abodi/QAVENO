import { Body, Controller, Get, Param, ParseIntPipe, Patch, Post } from '@nestjs/common';
import { IsArray, IsIn, IsInt, IsOptional, IsString, MinLength, ValidateNested } from 'class-validator';
import { Type } from 'class-transformer';
import { UsersService } from './users.service';
import { CurrentAuth, AuthContext, RequirePermission } from '../../common/auth-context';

class BranchLinkDto {
  @IsInt() branchId!: number;
  @IsOptional() isPrimary?: boolean;
}

class CreateUserDto {
  @IsString() username!: string;
  @IsString() @MinLength(8) password!: string;
  @IsString() role!: string;
  @IsOptional() @IsString() displayName?: string;
  @IsOptional() @IsArray() @ValidateNested({ each: true }) @Type(() => BranchLinkDto)
  branches?: BranchLinkDto[];
}

class UpdateUserDto {
  @IsOptional() @IsString() displayName?: string;
  @IsOptional() @IsString() @IsIn(['owner', 'admin', 'manager', 'cashier']) role?: string;
  @IsOptional() @IsString() @IsIn(['active', 'disabled']) status?: string;
  @IsOptional() @IsArray() @ValidateNested({ each: true }) @Type(() => BranchLinkDto)
  branches?: BranchLinkDto[];
}

class ResetPasswordDto {
  @IsString() @MinLength(8) newPassword!: string;
}

@Controller('users')
export class UsersController {
  constructor(private readonly users: UsersService) {}

  @Get()
  @RequirePermission('users.manage')
  list(@CurrentAuth() ctx: AuthContext) {
    return this.users.list(ctx);
  }

  @Post()
  @RequirePermission('users.manage')
  create(@Body() dto: CreateUserDto, @CurrentAuth() ctx: AuthContext) {
    return this.users.create(ctx, { ...dto, actorId: ctx.userId });
  }

  @Patch(':id')
  @RequirePermission('users.manage')
  update(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: UpdateUserDto,
    @CurrentAuth() ctx: AuthContext,
  ) {
    return this.users.update(ctx, id, { ...dto, actorId: ctx.userId });
  }

  @Post(':id/reset-password')
  @RequirePermission('users.manage')
  resetPassword(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: ResetPasswordDto,
    @CurrentAuth() ctx: AuthContext,
  ) {
    return this.users.resetPassword(id, dto.newPassword, ctx.userId);
  }

  @Post(':id/unlock')
  @RequirePermission('users.manage')
  unlock(@Param('id', ParseIntPipe) id: number, @CurrentAuth() ctx: AuthContext) {
    return this.users.unlock(id, ctx.userId);
  }
}
