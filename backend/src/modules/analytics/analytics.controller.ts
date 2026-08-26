import { Controller, Get, Query, Res } from '@nestjs/common';
import { IsIn, IsInt, IsOptional, IsString, Min } from 'class-validator';
import { Type } from 'class-transformer';
import { Response } from 'express';
import { AnalyticsService } from './analytics.service';
import { CurrentAuth, AuthContext, RequirePermission } from '../../common/auth-context';

class DateRangeDto {
  @IsOptional() @IsString() from?: string;
  @IsOptional() @IsString() to?: string;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) branchId?: number;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) limit?: number;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) page?: number;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) pageSize?: number;
}

@Controller('analytics')
export class AnalyticsController {
  constructor(private readonly analytics: AnalyticsService) {}

  @Get('dashboard')
  @RequirePermission('analytics.read')
  dashboard(@CurrentAuth() ctx: AuthContext, @Query() q: DateRangeDto) {
    return this.analytics.dashboardKpis(ctx, q);
  }

  @Get('sales-trend')
  @RequirePermission('analytics.read')
  salesTrend(@CurrentAuth() ctx: AuthContext, @Query() q: DateRangeDto) {
    return this.analytics.salesTrend(ctx, q, q.branchId);
  }

  @Get('profit-trend')
  @RequirePermission('analytics.read')
  profitTrend(@CurrentAuth() ctx: AuthContext, @Query() q: DateRangeDto) {
    return this.analytics.profitTrend(ctx, q, q.branchId);
  }

  @Get('top-products')
  @RequirePermission('analytics.read')
  topProducts(@CurrentAuth() ctx: AuthContext, @Query() q: DateRangeDto) {
    return this.analytics.topProducts(ctx, q, q.limit || 10, q.branchId);
  }

  @Get('branch-performance')
  @RequirePermission('analytics.read')
  branchPerformance(@CurrentAuth() ctx: AuthContext, @Query() q: DateRangeDto) {
    return this.analytics.branchPerformance(ctx, q);
  }

  @Get('product-performance')
  @RequirePermission('analytics.read')
  productPerformance(@CurrentAuth() ctx: AuthContext, @Query() q: DateRangeDto) {
    return this.analytics.productPerformance(ctx, q, q.limit || 20, q.branchId);
  }

  @Get('category-performance')
  @RequirePermission('analytics.read')
  categoryPerformance(@CurrentAuth() ctx: AuthContext, @Query() q: DateRangeDto) {
    return this.analytics.categoryPerformance(ctx, q, q.branchId);
  }

  @Get('supplier-performance')
  @RequirePermission('analytics.read')
  supplierPerformance(@CurrentAuth() ctx: AuthContext, @Query() q: DateRangeDto) {
    return this.analytics.supplierPerformance(ctx, q);
  }

  @Get('inventory-valuation')
  @RequirePermission('analytics.read')
  inventoryValuation(@CurrentAuth() ctx: AuthContext, @Query() q: DateRangeDto) {
    return this.analytics.inventoryValuation(ctx, q.branchId);
  }

  @Get('low-stock')
  @RequirePermission('analytics.read')
  lowStock(@CurrentAuth() ctx: AuthContext, @Query() q: DateRangeDto) {
    return this.analytics.lowStockProducts(ctx, q.branchId);
  }

  @Get('payment-methods')
  @RequirePermission('analytics.read')
  paymentMethods(@CurrentAuth() ctx: AuthContext, @Query() q: DateRangeDto) {
    return this.analytics.paymentMethodBreakdown(ctx, q, q.branchId);
  }

  @Get('purchases')
  @RequirePermission('analytics.read')
  purchases(@CurrentAuth() ctx: AuthContext, @Query() q: DateRangeDto) {
    return this.analytics.purchaseAnalytics(ctx, q);
  }

  @Get('transfers')
  @RequirePermission('analytics.read')
  transfers(@CurrentAuth() ctx: AuthContext, @Query() q: DateRangeDto) {
    return this.analytics.transferAnalytics(ctx, q);
  }

  @Get('discounts')
  @RequirePermission('analytics.read')
  discounts(@CurrentAuth() ctx: AuthContext, @Query() q: DateRangeDto) {
    return this.analytics.discountAnalytics(ctx, q, q.branchId);
  }

  @Get('taxes')
  @RequirePermission('analytics.read')
  taxes(@CurrentAuth() ctx: AuthContext, @Query() q: DateRangeDto) {
    return this.analytics.taxAnalytics(ctx, q, q.branchId);
  }

  @Get('stock-movements')
  @RequirePermission('analytics.read')
  stockMovements(@CurrentAuth() ctx: AuthContext, @Query() q: DateRangeDto) {
    return this.analytics.stockMovementAnalytics(ctx, q, q.branchId);
  }

  // ========== REPORTS ==========

  @Get('report/sales')
  @RequirePermission('reports.read')
  reportSales(@CurrentAuth() ctx: AuthContext, @Query() q: DateRangeDto) {
    return this.analytics.reportSales(ctx, q, q.branchId, q.page, q.pageSize);
  }

  @Get('report/profit')
  @RequirePermission('reports.read')
  reportProfit(@CurrentAuth() ctx: AuthContext, @Query() q: DateRangeDto) {
    return this.analytics.reportProfit(ctx, q, q.branchId, q.page, q.pageSize);
  }

  @Get('report/purchasing')
  @RequirePermission('reports.read')
  reportPurchasing(@CurrentAuth() ctx: AuthContext, @Query() q: DateRangeDto) {
    return this.analytics.reportPurchasing(ctx, q, q.page, q.pageSize);
  }

  @Get('report/branches')
  @RequirePermission('reports.read')
  reportBranches(@CurrentAuth() ctx: AuthContext, @Query() q: DateRangeDto) {
    return this.analytics.reportBranches(ctx, q);
  }

  @Get('report/movements')
  @RequirePermission('reports.read')
  reportMovements(@CurrentAuth() ctx: AuthContext, @Query() q: DateRangeDto) {
    return this.analytics.reportMovements(ctx, q, q.branchId, q.page, q.pageSize);
  }

  // ========== EXPORTS ==========

  @Get('export/sales')
  @RequirePermission('reports.export')
  async exportSales(@CurrentAuth() ctx: AuthContext, @Query() q: DateRangeDto, @Res() res: Response) {
    const result = await this.analytics.reportSales(ctx, q, q.branchId, 1, 10000);
    const csv = this.analytics.exportCsv(result.items, [
      { key: 'invoiceNo', label: 'Invoice #' },
      { key: 'branchName', label: 'Branch' },
      { key: 'createdAt', label: 'Date' },
      { key: 'subtotal', label: 'Subtotal' },
      { key: 'taxTotal', label: 'Tax' },
      { key: 'discount', label: 'Discount' },
      { key: 'total', label: 'Total' },
      { key: 'paymentMethod', label: 'Payment' },
    ]);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="sales-report.csv"');
    res.send(csv);
  }

  @Get('export/profit')
  @RequirePermission('reports.export')
  async exportProfit(@CurrentAuth() ctx: AuthContext, @Query() q: DateRangeDto, @Res() res: Response) {
    const result = await this.analytics.reportProfit(ctx, q, q.branchId, 1, 10000);
    const csv = this.analytics.exportCsv(result.items, [
      { key: 'productName', label: 'Product' },
      { key: 'totalQty', label: 'Qty Sold' },
      { key: 'revenue', label: 'Revenue' },
      { key: 'costOfGoods', label: 'Cost (WAC)' },
      { key: 'profit', label: 'Gross Profit' },
    ]);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="profit-report.csv"');
    res.send(csv);
  }

  @Get('export/inventory')
  @RequirePermission('reports.export')
  async exportInventory(@CurrentAuth() ctx: AuthContext, @Query() q: DateRangeDto, @Res() res: Response) {
    const result = await this.analytics.inventoryValuation(ctx, q.branchId);
    const csv = this.analytics.exportCsv(result.items, [
      { key: 'productName', label: 'Product' },
      { key: 'barcode', label: 'Barcode' },
      { key: 'totalQty', label: 'Quantity' },
      { key: 'totalValue', label: 'Value' },
      { key: 'minCost', label: 'Min Cost' },
      { key: 'maxCost', label: 'Max Cost' },
    ]);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="inventory-valuation.csv"');
    res.send(csv);
  }
}
