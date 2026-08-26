import { Controller, Get, Param, Query, Body, Post } from '@nestjs/common';
import { IsIn, IsInt, IsOptional, IsString, Min } from 'class-validator';
import { Type } from 'class-transformer';
import { AiService } from './ai.service';
import { CurrentAuth, AuthContext, RequirePermission } from '../../common/auth-context';

class InsightsQueryDto {
  @IsOptional() @IsString() type?: string;
  @IsOptional() @IsString() status?: string;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) limit?: number;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) page?: number;
}

@Controller('ai')
export class AiController {
  constructor(private readonly ai: AiService) {}

  @Get('forecast')
  @RequirePermission('ai.read')
  forecast(@CurrentAuth() ctx: AuthContext) {
    return this.ai.demandForecast(ctx);
  }

  @Get('anomalies')
  @RequirePermission('ai.read')
  anomalies(@CurrentAuth() ctx: AuthContext) {
    return this.ai.anomalyDetection(ctx);
  }

  @Get('reorder')
  @RequirePermission('ai.read')
  reorder(@CurrentAuth() ctx: AuthContext) {
    return this.ai.reorderRecommendations(ctx);
  }

  @Get('slow-moving')
  @RequirePermission('ai.read')
  slowMoving(@CurrentAuth() ctx: AuthContext) {
    return this.ai.slowMovingInventory(ctx);
  }

  @Get('summary')
  @RequirePermission('ai.read')
  summary(@CurrentAuth() ctx: AuthContext) {
    return this.ai.businessSummary(ctx);
  }

  @Get('cost-trend')
  @RequirePermission('ai.read')
  costTrend(@CurrentAuth() ctx: AuthContext) {
    return this.ai.costTrend(ctx);
  }

  @Get('profit-alert')
  @RequirePermission('ai.read')
  profitAlert(@CurrentAuth() ctx: AuthContext) {
    return this.ai.profitAlert(ctx);
  }

  @Get('insights')
  @RequirePermission('ai.read')
  insights(@CurrentAuth() ctx: AuthContext, @Query() q: InsightsQueryDto) {
    return this.ai.getInsights(ctx, q);
  }

  @Post('insights/:id/dismiss')
  @RequirePermission('ai.read')
  dismiss(@CurrentAuth() ctx: AuthContext, @Param('id') id: string) {
    return this.ai.dismissInsight(ctx, Number(id));
  }

  @Get('refresh')
  @RequirePermission('ai.read')
  refresh(@CurrentAuth() ctx: AuthContext) {
    return this.ai.refreshAll(ctx);
  }
}
