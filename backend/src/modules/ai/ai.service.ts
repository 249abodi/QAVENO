import { Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { AuthContext } from '../../common/auth-context';

@Injectable()
export class AiService {
  constructor(private readonly ds: DataSource) {}

  private bf(ctx: AuthContext, alias: string): string {
    return ctx.spansAll ? '' : `AND ${alias}.branch_id IN (${ctx.accessibleBranchIds.join(',') || '0'})`;
  }

  // ─── 1. Demand Forecast (30-day rolling → 7-day projection) ───
  async demandForecast(ctx: AuthContext) {
    const o = ctx.organizationId;
    const sBf = this.bf(ctx, 's');
    const rows = await this.ds.manager.query(
      `SELECT p.id AS "productId", p.name AS "productName",
              COALESCE(AVG(daily.qty), 0) AS "avgDaily",
              COALESCE(SUM(daily.qty), 0) AS "total30d"
       FROM products p
       LEFT JOIN LATERAL (
         SELECT si.product_id, SUM(si.quantity) AS qty
         FROM sale_items si
         JOIN sales s ON s.id = si.sale_id
         WHERE si.product_id = p.id AND s.created_at >= now() - interval '30 days'
           AND s.organization_id = $1 ${sBf}
         GROUP BY si.product_id
       ) daily ON true
       WHERE p.organization_id = $1
       GROUP BY p.id, p.name
       HAVING COALESCE(SUM(daily.qty), 0) > 0
       ORDER BY "total30d" DESC
       LIMIT 50`,
      [o],
    );

    const forecasts = rows.map((r: Record<string, unknown>) => {
      const avgDaily = Number(r.avgDaily);
      const total30d = Number(r.total30d);
      return {
        productId: r.productId,
        productName: r.productName,
        avgDailyDemand: Math.round(avgDaily * 100) / 100,
        totalSold30d: total30d,
        forecastNext7d: Math.round(avgDaily * 7),
        confidence: total30d >= 7 ? 'high' : total30d >= 3 ? 'medium' : 'low',
      };
    });
    return { forecasts, generatedAt: new Date().toISOString() };
  }

  // ─── 2. Anomaly Detection ─────────────────────────────────────
  async anomalyDetection(ctx: AuthContext) {
    const o = ctx.organizationId;
    const sBf = this.bf(ctx, 's');
    const anomalies: Array<Record<string, unknown>> = [];

    // 2a. Large sales (> 2σ)
    const [stats] = await this.ds.manager.query(
      `SELECT AVG(total) AS mean, COALESCE(STDDEV(total), 0) AS stddev
       FROM sales WHERE organization_id = $1 AND created_at >= now() - interval '30 days'`, [o]);
    const mean = Number(stats?.mean) || 0;
    const stddev = Number(stats?.stddev) || 0;
    const thresh = mean + 2 * stddev;

    if (thresh > 0) {
      const big = await this.ds.manager.query(
        `SELECT id, invoice_no AS "invoiceNo", total, branch_id AS "branchId", created_at AS "createdAt"
         FROM sales WHERE organization_id = $1 AND total > $2
           AND created_at >= now() - interval '30 days' ${sBf}
         ORDER BY total DESC LIMIT 20`, [o, thresh]);
      for (const s of big) {
        anomalies.push({
          type: 'large_sale', entityType: 'sale', entityId: s.id, severity: 'info',
          title: `Unusually large sale: ${s.invoiceNo}`,
          message: `Total $${Number(s.total).toFixed(2)} exceeds 2σ threshold ($${thresh.toFixed(2)}).`,
          data: s,
        });
      }
    }

    // 2b. Negative margins
    const neg = await this.ds.manager.query(
      `SELECT si.product_id AS "productId", p.name AS "productName",
              SUM(si.line_total - si.unit_cost * si.quantity) AS profit,
              COUNT(*)::int AS "saleCount"
       FROM sale_items si
       JOIN products p ON p.id = si.product_id
       JOIN sales s ON s.id = si.sale_id
       WHERE s.organization_id = $1 AND s.created_at >= now() - interval '30 days'
         AND si.unit_cost > 0 AND si.unit_price < si.unit_cost ${sBf}
       GROUP BY si.product_id, p.name
       HAVING SUM(si.line_total - si.unit_cost * si.quantity) < 0
       ORDER BY profit ASC LIMIT 20`, [o]);
    for (const r of neg) {
      anomalies.push({
        type: 'negative_margin', entityType: 'product', entityId: r.productId, severity: 'warning',
        title: `Negative margin: ${r.productName}`,
        message: `Sold below cost in ${r.saleCount} txns. Loss: $${Math.abs(Number(r.profit)).toFixed(2)}.`,
        data: r,
      });
    }

    // 2c. Inventory shrinkage (negative stock)
    const sh = await this.ds.manager.query(
      `SELECT bi.product_id AS "productId", p.name AS "productName", bi.quantity
       FROM branch_inventory bi
       JOIN products p ON p.id = bi.product_id
       JOIN branches b ON b.id = bi.branch_id
       WHERE b.organization_id = $1 AND bi.quantity < 0`, [o]);
    for (const r of sh) {
      anomalies.push({
        type: 'inventory_shrinkage', entityType: 'product', entityId: r.productId, severity: 'critical',
        title: `Negative inventory: ${r.productName}`,
        message: `Stock is ${r.quantity} units. Immediate reconciliation required.`,
        data: r,
      });
    }

    return { anomalies, total: anomalies.length, generatedAt: new Date().toISOString() };
  }

  // ─── 3. Reorder Recommendations ───────────────────────────────
  async reorderRecommendations(ctx: AuthContext) {
    const o = ctx.organizationId;
    const biBf = this.bf(ctx, 'bi');
    const rows = await this.ds.manager.query(
      `SELECT bi.branch_id AS "branchId", b.name AS "branchName",
              bi.product_id AS "productId", p.name AS "productName", p.barcode,
              bi.quantity AS "currentStock", bi.low_stock_threshold AS "threshold",
              bi.reorder_qty AS "reorderQty", bi.cost AS "unitCost",
              GREATEST(bi.reorder_qty, bi.low_stock_threshold - bi.quantity + bi.reorder_qty) AS "suggestedQty"
       FROM branch_inventory bi
       JOIN products p ON p.id = bi.product_id
       JOIN branches b ON b.id = bi.branch_id
       WHERE b.organization_id = $1 AND bi.quantity <= bi.low_stock_threshold
         AND bi.reorder_qty > 0 ${biBf}
       ORDER BY bi.quantity ASC LIMIT 50`, [o]);

    const recommendations = rows.map((r: Record<string, unknown>) => ({
      branchId: r.branchId, branchName: r.branchName,
      productId: r.productId, productName: r.productName, barcode: r.barcode,
      currentStock: r.currentStock, threshold: r.threshold,
      reorderQty: r.reorderQty, suggestedQty: r.suggestedQty,
      estimatedCost: Number(r.unitCost) * Number(r.suggestedQty),
      urgency: Number(r.currentStock) === 0 ? 'critical' : Number(r.currentStock) <= Math.floor(Number(r.threshold) / 2) ? 'high' : 'medium',
    }));
    return { recommendations, total: recommendations.length, generatedAt: new Date().toISOString() };
  }

  // ─── 4. Slow-Moving Inventory ─────────────────────────────────
  async slowMovingInventory(ctx: AuthContext) {
    const o = ctx.organizationId;
    const biBf = this.bf(ctx, 'bi');
    const rows = await this.ds.manager.query(
      `SELECT bi.branch_id AS "branchId", b.name AS "branchName",
              bi.product_id AS "productId", p.name AS "productName",
              bi.quantity AS "currentStock", bi.cost AS "unitCost",
              COALESCE(sold.total30d, 0) AS "sold30d",
              bi.quantity * bi.cost AS "inventoryValue"
       FROM branch_inventory bi
       JOIN products p ON p.id = bi.product_id
       JOIN branches b ON b.id = bi.branch_id
       LEFT JOIN LATERAL (
         SELECT SUM(si.quantity) AS "total30d"
         FROM sale_items si
         JOIN sales s ON s.id = si.sale_id
         WHERE si.product_id = bi.product_id
           AND s.created_at >= now() - interval '30 days'
           AND s.organization_id = $1
       ) sold ON true
       WHERE b.organization_id = $1 AND bi.quantity > 0
         AND COALESCE(sold.total30d, 0) = 0 ${biBf}
       ORDER BY bi.quantity * bi.cost DESC LIMIT 50`, [o]);

    const items = rows.map((r: Record<string, unknown>) => ({
      branchId: r.branchId, branchName: r.branchName,
      productId: r.productId, productName: r.productName,
      currentStock: r.currentStock, inventoryValue: Number(r.inventoryValue),
      daysSinceLastSale: '30+',
      recommendation: Number(r.inventoryValue) > 500 ? 'Consider markdown or promotion' : 'Monitor',
    }));
    return { items, total: items.length, totalValue: items.reduce((s: number, i: Record<string, unknown>) => s + Number(i.inventoryValue), 0), generatedAt: new Date().toISOString() };
  }

  // ─── 5. Business Summary (period-over-period) ─────────────────
  async businessSummary(ctx: AuthContext) {
    const o = ctx.organizationId;
    const [cur] = await this.ds.manager.query(
      `SELECT COUNT(*)::int AS "totalSales",
              COALESCE(SUM(total),0)::double precision AS revenue,
              COALESCE(SUM(tax_total),0)::double precision AS taxes,
              COALESCE(SUM(discount),0)::double precision AS discounts
       FROM sales WHERE organization_id = $1 AND created_at >= now() - interval '30 days'`, [o]);
    const [prev] = await this.ds.manager.query(
      `SELECT COUNT(*)::int AS "totalSales",
              COALESCE(SUM(total),0)::double precision AS revenue,
              COALESCE(SUM(tax_total),0)::double precision AS taxes,
              COALESCE(SUM(discount),0)::double precision AS discounts
       FROM sales WHERE organization_id = $1
         AND created_at >= now() - interval '60 days' AND created_at < now() - interval '30 days'`, [o]);

    const revChg = Number(prev?.revenue) > 0
      ? ((Number(cur?.revenue) - Number(prev?.revenue)) / Number(prev?.revenue)) * 100 : 0;

    return {
      period: { from: new Date(Date.now() - 30 * 86400000).toISOString(), to: new Date().toISOString() },
      currentPeriod: { sales: cur?.totalSales ?? 0, revenue: Number(cur?.revenue ?? 0), taxes: Number(cur?.taxes ?? 0), discounts: Number(cur?.discounts ?? 0) },
      previousPeriod: { sales: prev?.totalSales ?? 0, revenue: Number(prev?.revenue ?? 0), taxes: Number(prev?.taxes ?? 0), discounts: Number(prev?.discounts ?? 0) },
      changes: { revenueChangePct: Math.round(revChg * 100) / 100 },
      generatedAt: new Date().toISOString(),
    };
  }

  // ─── 6. Cost Trend ────────────────────────────────────────────
  async costTrend(ctx: AuthContext) {
    const rows = await this.ds.manager.query(
      `SELECT ch.product_id AS "productId", p.name AS "productName",
              ch.unit_cost AS "unitCost", ch.prev_cost AS "prevCost",
              ch.created_at AS "createdAt"
       FROM cost_history ch
       JOIN products p ON p.id = ch.product_id
       JOIN branches b ON b.id = ch.branch_id
       WHERE b.organization_id = $1 AND ch.created_at >= now() - interval '30 days'
       ORDER BY ch.created_at DESC LIMIT 100`, [ctx.organizationId]);

    const trend = rows.map((r: Record<string, unknown>) => ({
      productId: r.productId, productName: r.productName,
      currentCost: r.unitCost, previousCost: r.prevCost,
      changePct: Number(r.prevCost) > 0 ? Math.round(((Number(r.unitCost) - Number(r.prevCost)) / Number(r.prevCost)) * 10000) / 100 : 0,
      createdAt: r.createdAt,
    }));
    return { trend, generatedAt: new Date().toISOString() };
  }

  // ─── 7. Profit Alert (low margin products) ────────────────────
  async profitAlert(ctx: AuthContext) {
    const o = ctx.organizationId;
    const rows = await this.ds.manager.query(
      `SELECT si.product_id AS "productId", p.name AS "productName",
              SUM(si.line_total) AS revenue,
              SUM(si.unit_cost * si.quantity) AS cost,
              CASE WHEN SUM(si.line_total) > 0
                THEN (SUM(si.line_total) - SUM(si.unit_cost * si.quantity)) / SUM(si.line_total) * 100
                ELSE 0 END AS "marginPct"
       FROM sale_items si
       JOIN products p ON p.id = si.product_id
       JOIN sales s ON s.id = si.sale_id
       WHERE s.organization_id = $1 AND s.created_at >= now() - interval '30 days'
       GROUP BY si.product_id, p.name
       HAVING SUM(si.line_total) > 100 AND
              (SUM(si.line_total) - SUM(si.unit_cost * si.quantity)) / SUM(si.line_total) * 100 < 10
       ORDER BY "marginPct" ASC LIMIT 20`, [o]);

    const alerts = rows.map((r: Record<string, unknown>) => ({
      productId: r.productId, productName: r.productName,
      revenue: Number(r.revenue), cost: Number(r.cost),
      marginPct: Math.round(Number(r.marginPct) * 100) / 100,
      severity: Number(r.marginPct) < 0 ? 'critical' : 'warning',
    }));
    return { alerts, generatedAt: new Date().toISOString() };
  }

  // ─── Store insight ────────────────────────────────────────────
  async storeInsight(ctx: AuthContext, insight: {
    insightType: string; entityType?: string; entityId?: number;
    branchId?: number; severity: string; title: string; message: string;
    data: Record<string, unknown>;
  }) {
    const result = await this.ds.manager.query(
      `INSERT INTO ai_insights (organization_id, branch_id, insight_type, entity_type, entity_id, severity, title, message, data)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb) RETURNING id`,
      [ctx.organizationId, insight.branchId || null, insight.insightType, insight.entityType || null,
       insight.entityId || null, insight.severity, insight.title, insight.message, JSON.stringify(insight.data)]);
    return result[0]?.id;
  }

  // ─── Get stored insights ──────────────────────────────────────
  async getInsights(ctx: AuthContext, opts: { type?: string; status?: string; limit?: number; page?: number }) {
    const conditions = [`ai.organization_id = $1`];
    const params: unknown[] = [ctx.organizationId];
    let idx = 2;

    if (opts.type) { conditions.push(`ai.insight_type = $${idx}`); params.push(opts.type); idx++; }
    if (opts.status) { conditions.push(`ai.status = $${idx}`); params.push(opts.status); idx++; }
    if (!ctx.spansAll) {
      conditions.push(`(ai.branch_id IS NULL OR ai.branch_id IN (${ctx.accessibleBranchIds.join(',') || '0'}))`);
    }

    const where = conditions.join(' AND ');
    const limit = opts.limit || 50;
    const page = opts.page || 1;
    const offset = (page - 1) * limit;

    const [items, tot] = await Promise.all([
      this.ds.manager.query(
        `SELECT ai.* FROM ai_insights ai WHERE ${where} ORDER BY ai.created_at DESC LIMIT ${limit} OFFSET ${offset}`, params),
      this.ds.manager.query(
        `SELECT COUNT(*)::int AS "total" FROM ai_insights ai WHERE ${where}`, params),
    ]);
    return { items, total: tot[0]?.total || 0, page, limit };
  }

  // ─── Dismiss insight ──────────────────────────────────────────
  async dismissInsight(ctx: AuthContext, id: number) {
    await this.ds.manager.query(
      `UPDATE ai_insights SET status = 'dismissed', dismissed_at = now() WHERE id = $1 AND organization_id = $2`,
      [id, ctx.organizationId]);
    return { success: true };
  }

  // ─── Full refresh ─────────────────────────────────────────────
  async refreshAll(ctx: AuthContext) {
    const [forecast, anomalies, reorder, slowMoving, summary, costTrend, profitAlert] = await Promise.all([
      this.demandForecast(ctx), this.anomalyDetection(ctx), this.reorderRecommendations(ctx),
      this.slowMovingInventory(ctx), this.businessSummary(ctx), this.costTrend(ctx), this.profitAlert(ctx),
    ]);

    for (const a of anomalies.anomalies) {
      if (a.severity === 'critical' || a.severity === 'warning') {
        await this.storeInsight(ctx, {
          insightType: 'anomaly',
          entityType: String(a.entityType || ''),
          entityId: a.entityId ? Number(a.entityId) : undefined,
          severity: String(a.severity),
          title: String(a.title),
          message: String(a.message),
          data: (a.data || {}) as Record<string, unknown>,
        });
      }
    }
    for (const r of reorder.recommendations) {
      if (r.urgency === 'critical' || r.urgency === 'high') {
        await this.storeInsight(ctx, {
          insightType: 'reorder_recommendation',
          entityType: 'product',
          entityId: Number(r.productId),
          branchId: Number(r.branchId),
          severity: r.urgency === 'critical' ? 'critical' : 'warning',
          title: `Reorder: ${r.productName}`,
          message: `Stock: ${r.currentStock} at ${r.branchName}. Order ${r.suggestedQty} units.`,
          data: r as unknown as Record<string, unknown>,
        });
      }
    }

    return { forecast, anomalies, reorder, slowMoving, summary, costTrend, profitAlert, generatedAt: new Date().toISOString() };
  }
}
