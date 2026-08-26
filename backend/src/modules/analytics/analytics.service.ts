import { Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { AuthContext } from '../../common/auth-context';

export interface DateRange {
  from?: string;
  to?: string;
}

function clampDateRange(dr: DateRange): { from: string; to: string } {
  const now = new Date();
  const to = dr.to ? new Date(dr.to) : now;
  const from = dr.from ? new Date(dr.from) : new Date(now.getTime() - 30 * 86400000);
  // Safety: never exceed 1 year range
  const maxSpan = 366 * 86400000;
  if (to.getTime() - from.getTime() > maxSpan) {
    return { from: new Date(to.getTime() - maxSpan).toISOString(), to: to.toISOString() };
  }
  return { from: from.toISOString(), to: to.toISOString() };
}

function periodLabel(d: Date): string {
  return d.toISOString().slice(0, 10);
}

@Injectable()
export class AnalyticsService {
  constructor(private readonly ds: DataSource) {}

  /** Dashboard KPI summary. */
  async dashboardKpis(ctx: AuthContext, dr: DateRange) {
    const { from, to } = clampDateRange(dr);
    const o = ctx.organizationId;
    const branchFilter = ctx.spansAll ? '' : `AND s.branch_id IN (${ctx.accessibleBranchIds.join(',') || '0'})`;
    const bFilter = ctx.spansAll ? '' : `AND bi.branch_id IN (${ctx.accessibleBranchIds.join(',') || '0'})`;

    const [sales, profit, inventory, lowStock, activeProducts, pendingPOs, activeTransfers] = await Promise.all([
      this.ds.manager.query(
        `SELECT COUNT(*)::int AS "totalSales",
                COALESCE(SUM(total),0)::double precision AS revenue,
                COALESCE(SUM(tax_total),0)::double precision AS taxes,
                COALESCE(SUM(discount),0)::double precision AS discounts
         FROM sales s
         WHERE organization_id=$1 AND created_at BETWEEN $2 AND $3 ${branchFilter}`,
        [o, from, to],
      ),
      this.ds.manager.query(
        `SELECT COALESCE(SUM(si.line_total - si.unit_cost * si.quantity),0)::double precision AS "grossProfit"
         FROM sale_items si
         JOIN sales s ON s.id=si.sale_id
         WHERE s.organization_id=$1 AND s.created_at BETWEEN $2 AND $3 ${branchFilter}`,
        [o, from, to],
      ),
      this.ds.manager.query(
        `SELECT COALESCE(ROUND(SUM(bi.quantity * bi.cost)::numeric,2)::double precision,0) AS "stockValue",
                COUNT(*)::int AS "stockedProducts"
         FROM branch_inventory bi
         JOIN branches b ON b.id=bi.branch_id
         WHERE b.organization_id=$1 AND bi.quantity > 0 ${bFilter}`,
        [o],
      ),
      this.ds.manager.query(
        `SELECT COUNT(*)::int AS "lowStockProducts"
         FROM branch_inventory bi
         JOIN branches b ON b.id=bi.branch_id
         WHERE b.organization_id=$1 AND bi.quantity > 0 AND bi.quantity <= bi.low_stock_threshold ${bFilter}`,
        [o],
      ),
      this.ds.manager.query(
        `SELECT COUNT(DISTINCT p.id)::int AS "activeProducts"
         FROM products p
         WHERE p.organization_id=$1`,
        [o],
      ),
      this.ds.manager.query(
        `SELECT COUNT(*)::int AS "pendingPOs"
         FROM purchase_orders po
         WHERE po.organization_id=$1 AND po.status IN ('draft','submitted','approved')`,
        [o],
      ),
      this.ds.manager.query(
        `SELECT COUNT(*)::int AS "activeTransfers"
         FROM stock_transfers st
         WHERE st.organization_id=$1 AND st.status IN ('draft','submitted','approved','dispatched','partially_received')`,
        [o],
      ),
    ]);

    const s = sales[0] || {};
    const p = profit[0] || {};
    const inv = inventory[0] || {};
    return {
      revenue: Number(s.revenue) || 0,
      totalSales: Number(s.totalSales) || 0,
      grossProfit: Number(p.grossProfit) || 0,
      taxes: Number(s.taxes) || 0,
      discounts: Number(s.discounts) || 0,
      stockValue: Number(inv.stockValue) || 0,
      stockedProducts: Number(inv.stockedProducts) || 0,
      lowStockProducts: Number(lowStock[0]?.lowStockProducts) || 0,
      activeProducts: Number(activeProducts[0]?.activeProducts) || 0,
      pendingPOs: Number(pendingPOs[0]?.pendingPOs) || 0,
      activeTransfers: Number(activeTransfers[0]?.activeTransfers) || 0,
      dateRange: { from, to },
    };
  }

  /** Sales trend — daily aggregation. */
  async salesTrend(ctx: AuthContext, dr: DateRange, branchId?: number) {
    const { from, to } = clampDateRange(dr);
    const o = ctx.organizationId;
    const branchCond = branchId ? `AND s.branch_id=${branchId}` :
      (ctx.spansAll ? '' : `AND s.branch_id IN (${ctx.accessibleBranchIds.join(',') || '0'})`);
    const rows = await this.ds.manager.query(
      `SELECT DATE(s.created_at) AS day,
              COUNT(*)::int AS "salesCount",
              COALESCE(SUM(s.total),0)::double precision AS revenue,
              COALESCE(SUM(s.tax_total),0)::double precision AS taxes,
              COALESCE(SUM(s.discount),0)::double precision AS discounts
       FROM sales s
       WHERE s.organization_id=$1 AND s.created_at BETWEEN $2 AND $3 ${branchCond}
       GROUP BY day ORDER BY day`,
      [o, from, to],
    );
    return rows;
  }

  /** Profit trend — daily aggregation using WAC-based cost. */
  async profitTrend(ctx: AuthContext, dr: DateRange, branchId?: number) {
    const { from, to } = clampDateRange(dr);
    const o = ctx.organizationId;
    const branchCond = branchId ? `AND s.branch_id=${branchId}` :
      (ctx.spansAll ? '' : `AND s.branch_id IN (${ctx.accessibleBranchIds.join(',') || '0'})`);
    const rows = await this.ds.manager.query(
      `SELECT DATE(s.created_at) AS day,
              COALESCE(SUM(si.line_total),0)::double precision AS revenue,
              COALESCE(SUM(si.unit_cost * si.quantity),0)::double precision AS "costOfGoods",
              COALESCE(SUM(si.line_total - si.unit_cost * si.quantity),0)::double precision AS "grossProfit"
       FROM sale_items si
       JOIN sales s ON s.id=si.sale_id
       WHERE s.organization_id=$1 AND s.created_at BETWEEN $2 AND $3 ${branchCond}
       GROUP BY day ORDER BY day`,
      [o, from, to],
    );
    return rows;
  }

  /** Top products by revenue/qty. */
  async topProducts(ctx: AuthContext, dr: DateRange, limit = 10, branchId?: number) {
    const { from, to } = clampDateRange(dr);
    const o = ctx.organizationId;
    const branchCond = branchId ? `AND s.branch_id=${branchId}` :
      (ctx.spansAll ? '' : `AND s.branch_id IN (${ctx.accessibleBranchIds.join(',') || '0'})`);
    const rows = await this.ds.manager.query(
      `SELECT si.product_id AS "productId", si.product_name AS "productName",
              SUM(si.quantity)::int AS "totalQty",
              SUM(si.line_total)::double precision AS "totalRevenue",
              SUM(si.unit_cost * si.quantity)::double precision AS "totalCost",
              SUM(si.line_total - si.unit_cost * si.quantity)::double precision AS "grossProfit",
              COUNT(DISTINCT si.sale_id)::int AS "saleCount"
       FROM sale_items si
       JOIN sales s ON s.id=si.sale_id
       WHERE s.organization_id=$1 AND s.created_at BETWEEN $2 AND $3 ${branchCond}
       GROUP BY si.product_id, si.product_name
       ORDER BY "totalRevenue" DESC
       LIMIT $4`,
      [o, from, to, limit],
    );
    return rows;
  }

  /** Branch performance comparison. */
  async branchPerformance(ctx: AuthContext, dr: DateRange) {
    const { from, to } = clampDateRange(dr);
    const o = ctx.organizationId;
    const branchCond = ctx.spansAll ? '' : `AND s.branch_id IN (${ctx.accessibleBranchIds.join(',') || '0'})`;
    const rows = await this.ds.manager.query(
      `SELECT b.id AS "branchId", b.name AS "branchName",
              COUNT(s.id)::int AS "salesCount",
              COALESCE(SUM(s.total),0)::double precision AS revenue,
              COALESCE(SUM(s.tax_total),0)::double precision AS taxes,
              COALESCE(SUM(s.discount),0)::double precision AS discounts
       FROM branches b
       LEFT JOIN sales s ON s.branch_id=b.id AND s.created_at BETWEEN $2 AND $3 ${branchCond}
       WHERE b.organization_id=$1 AND b.status='active'
       GROUP BY b.id, b.name
       ORDER BY revenue DESC`,
      [o, from, to],
    );
    // Add profit per branch
    for (const row of rows) {
      const profitRows = await this.ds.manager.query(
        `SELECT COALESCE(SUM(si.line_total - si.unit_cost * si.quantity),0)::double precision AS "grossProfit"
         FROM sale_items si JOIN sales s ON s.id=si.sale_id
         WHERE s.branch_id=$1 AND s.organization_id=$2 AND s.created_at BETWEEN $3 AND $4`,
        [row.branchId, o, from, to],
      );
      row.grossProfit = Number(profitRows[0]?.grossProfit) || 0;
    }
    return rows;
  }

  /** Product performance with inventory metrics. */
  async productPerformance(ctx: AuthContext, dr: DateRange, limit = 20, branchId?: number) {
    const { from, to } = clampDateRange(dr);
    const o = ctx.organizationId;
    const branchCond = branchId ? `AND s.branch_id=${branchId}` :
      (ctx.spansAll ? '' : `AND s.branch_id IN (${ctx.accessibleBranchIds.join(',') || '0'})`);
    const branchInvCond = branchId ? `AND bi.branch_id=${branchId}` :
      (ctx.spansAll ? '' : `AND bi.branch_id IN (${ctx.accessibleBranchIds.join(',') || '0'})`);

    const rows = await this.ds.manager.query(
      `SELECT p.id AS "productId", p.name AS "productName", p.barcode, p.cost,
              COALESCE(SUM(si.quantity),0)::int AS "soldQty",
              COALESCE(SUM(si.line_total),0)::double precision AS revenue,
              COALESCE(SUM(si.line_total - si.unit_cost * si.quantity),0)::double precision AS profit,
              COALESCE(SUM(si.unit_cost * si.quantity),0)::double precision AS "costOfGoods",
              COALESCE(inv."totalStock",0)::int AS "totalStock",
               COALESCE(inv."stockValue",0)::double precision AS "stockValue"
       FROM products p
       LEFT JOIN sale_items si ON si.product_id=p.id
         AND si.sale_id IN (SELECT id FROM sales WHERE organization_id=$1 AND created_at BETWEEN $2 AND $3 ${branchCond})
       LEFT JOIN (
         SELECT bi.product_id, SUM(bi.quantity)::int AS "totalStock",
                SUM(bi.quantity * bi.cost)::double precision AS "stockValue"
         FROM branch_inventory bi
         JOIN branches b ON b.id=bi.branch_id
         WHERE b.organization_id=$1 ${branchInvCond}
         GROUP BY bi.product_id
       ) inv ON inv.product_id=p.id
       WHERE p.organization_id=$1
       GROUP BY p.id, p.name, p.barcode, p.cost, inv."totalStock", inv."stockValue"
       ORDER BY revenue DESC
       LIMIT $4`,
      [o, from, to, limit],
    );
    return rows;
  }

  /** Category performance. */
  async categoryPerformance(ctx: AuthContext, dr: DateRange, branchId?: number) {
    const { from, to } = clampDateRange(dr);
    const o = ctx.organizationId;
    const branchCond = branchId ? `AND s.branch_id=${branchId}` :
      (ctx.spansAll ? '' : `AND s.branch_id IN (${ctx.accessibleBranchIds.join(',') || '0'})`);
    const rows = await this.ds.manager.query(
      `SELECT c.id AS "categoryId", c.name AS "categoryName", c.color,
              COUNT(DISTINCT si.product_id)::int AS "productCount",
              COALESCE(SUM(si.quantity),0)::int AS "soldQty",
              COALESCE(SUM(si.line_total),0)::double precision AS revenue,
              COALESCE(SUM(si.line_total - si.unit_cost * si.quantity),0)::double precision AS profit
       FROM categories c
       LEFT JOIN products p ON p.category_id=c.id AND p.organization_id=$1
       LEFT JOIN sale_items si ON si.product_id=p.id
         AND si.sale_id IN (SELECT id FROM sales WHERE organization_id=$1 AND created_at BETWEEN $2 AND $3 ${branchCond})
       WHERE c.organization_id=$1
       GROUP BY c.id, c.name, c.color
       ORDER BY revenue DESC`,
      [o, from, to],
    );
    return rows;
  }

  /** Supplier performance. */
  async supplierPerformance(ctx: AuthContext, dr: DateRange) {
    const { from, to } = clampDateRange(dr);
    const o = ctx.organizationId;
    const rows = await this.ds.manager.query(
      `SELECT sp.id AS "supplierId", sp.name AS "supplierName",
              COUNT(DISTINCT po.id)::int AS "orderCount",
              COALESCE(SUM(poi.qty * poi.unit_cost),0)::double precision AS "totalPurchased",
              COALESCE(SUM(poi.received_qty),0)::int AS "totalReceived",
              COUNT(DISTINCT g.id)::int AS "grnCount"
       FROM suppliers sp
       LEFT JOIN purchase_orders po ON po.supplier_id=sp.id AND po.organization_id=$1
         AND po.created_at BETWEEN $2 AND $3
       LEFT JOIN purchase_order_items poi ON poi.po_id=po.id
       LEFT JOIN grns g ON g.po_id=po.id
       WHERE sp.organization_id=$1 AND sp.status='active'
       GROUP BY sp.id, sp.name
       ORDER BY "totalPurchased" DESC`,
      [o, from, to],
    );
    return rows;
  }

  /** Inventory valuation summary. */
  async inventoryValuation(ctx: AuthContext, branchId?: number) {
    const o = ctx.organizationId;
    const branchCond = branchId ? `AND bi.branch_id=${branchId}` :
      (ctx.spansAll ? '' : `AND bi.branch_id IN (${ctx.accessibleBranchIds.join(',') || '0'})`);
    const rows = await this.ds.manager.query(
      `SELECT p.id AS "productId", p.name AS "productName", p.barcode,
              COALESCE(SUM(bi.quantity),0)::int AS "totalQty",
              COALESCE(SUM(bi.quantity * bi.cost),0)::double precision AS "totalValue",
              MIN(CASE WHEN bi.quantity > 0 THEN bi.cost END)::double precision AS "minCost",
              MAX(CASE WHEN bi.quantity > 0 THEN bi.cost END)::double precision AS "maxCost"
       FROM products p
       LEFT JOIN branch_inventory bi ON bi.product_id=p.id
         AND bi.branch_id IN (SELECT id FROM branches WHERE organization_id=$1 AND status='active')
       WHERE p.organization_id=$1
       GROUP BY p.id, p.name, p.barcode
       HAVING SUM(bi.quantity) > 0
       ORDER BY "totalValue" DESC`,
      [o],
    );
    const summary = await this.ds.manager.query(
      `SELECT COUNT(DISTINCT bi.product_id)::int AS "productCount",
              COALESCE(ROUND(SUM(bi.quantity * bi.cost)::numeric,2)::double precision,0) AS "totalValue",
              COALESCE(SUM(bi.quantity),0)::int AS "totalQty"
       FROM branch_inventory bi
       JOIN branches b ON b.id=bi.branch_id
       WHERE b.organization_id=$1 AND bi.quantity > 0 ${branchCond}`,
      [o],
    );
    return { items: rows, summary: summary[0] || {} };
  }

  /** Low-stock products. */
  async lowStockProducts(ctx: AuthContext, branchId?: number) {
    const o = ctx.organizationId;
    const branchCond = branchId ? `AND bi.branch_id=${branchId}` :
      (ctx.spansAll ? '' : `AND bi.branch_id IN (${ctx.accessibleBranchIds.join(',') || '0'})`);
    const rows = await this.ds.manager.query(
      `SELECT p.id AS "productId", p.name AS "productName", p.barcode,
              bi.quantity AS "currentQty", bi.low_stock_threshold AS "threshold",
              b.name AS "branchName", bi.branch_id AS "branchId"
       FROM branch_inventory bi
       JOIN products p ON p.id=bi.product_id
       JOIN branches b ON b.id=bi.branch_id
       WHERE b.organization_id=$1 AND bi.quantity > 0 AND bi.quantity <= bi.low_stock_threshold ${branchCond}
       ORDER BY bi.quantity ASC`,
      [o],
    );
    return rows;
  }

  /** Payment method breakdown. */
  async paymentMethodBreakdown(ctx: AuthContext, dr: DateRange, branchId?: number) {
    const { from, to } = clampDateRange(dr);
    const o = ctx.organizationId;
    const branchCond = branchId ? `AND s.branch_id=${branchId}` :
      (ctx.spansAll ? '' : `AND s.branch_id IN (${ctx.accessibleBranchIds.join(',') || '0'})`);
    const rows = await this.ds.manager.query(
      `SELECT COALESCE(s.payment_method,'cash') AS "paymentMethod",
              COUNT(*)::int AS "count",
              COALESCE(SUM(s.total),0)::double precision AS revenue
       FROM sales s
       WHERE s.organization_id=$1 AND s.created_at BETWEEN $2 AND $3 ${branchCond}
       GROUP BY s.payment_method
       ORDER BY revenue DESC`,
      [o, from, to],
    );
    return rows;
  }

  /** Purchase analytics. */
  async purchaseAnalytics(ctx: AuthContext, dr: DateRange) {
    const { from, to } = clampDateRange(dr);
    const o = ctx.organizationId;
    const [statusSummary, monthlyPurchases, damagedUnits] = await Promise.all([
      this.ds.manager.query(
        `SELECT po.status, COUNT(*)::int AS "count",
                COALESCE(SUM(poi.qty * poi.unit_cost),0)::double precision AS "totalCost"
         FROM purchase_orders po
         LEFT JOIN purchase_order_items poi ON poi.po_id=po.id
         WHERE po.organization_id=$1 AND po.created_at BETWEEN $2 AND $3
         GROUP BY po.status`,
        [o, from, to],
      ),
      this.ds.manager.query(
        `SELECT DATE_TRUNC('month', po.created_at) AS month,
                COUNT(*)::int AS "orderCount",
                COALESCE(SUM(poi.qty * poi.unit_cost),0)::double precision AS "totalCost"
         FROM purchase_orders po
         LEFT JOIN purchase_order_items poi ON poi.po_id=po.id
         WHERE po.organization_id=$1 AND po.created_at BETWEEN $2 AND $3 AND po.status != 'cancelled'
         GROUP BY month ORDER BY month`,
        [o, from, to],
      ),
      this.ds.manager.query(
        `SELECT COALESCE(SUM(gi.qty_damaged),0)::int AS "damagedUnits",
                COALESCE(SUM(gi.qty_damaged * gi.unit_cost),0)::double precision AS "damagedValue"
         FROM grn_items gi
         JOIN grns g ON g.id=gi.grn_id
         WHERE g.organization_id=$1 AND g.created_at BETWEEN $2 AND $3`,
        [o, from, to],
      ),
    ]);
    return { statusSummary, monthlyPurchases, damagedUnits: damagedUnits[0] || {} };
  }

  /** Transfer analytics. */
  async transferAnalytics(ctx: AuthContext, dr: DateRange) {
    const { from, to } = clampDateRange(dr);
    const o = ctx.organizationId;
    const rows = await this.ds.manager.query(
      `SELECT st.status, COUNT(*)::int AS "count"
       FROM stock_transfers st
       WHERE st.organization_id=$1 AND st.created_at BETWEEN $2 AND $3
       GROUP BY st.status`,
      [o, from, to],
    );
    const summary = await this.ds.manager.query(
      `SELECT COUNT(*)::int AS "totalTransfers",
              COUNT(*) FILTER (WHERE status='received')::int AS "completed",
              COUNT(*) FILTER (WHERE status='cancelled')::int AS "cancelled",
              COUNT(*) FILTER (WHERE status IN ('draft','submitted'))::int AS "pending"
       FROM stock_transfers
       WHERE organization_id=$1 AND created_at BETWEEN $2 AND $3`,
      [o, from, to],
    );
    return { byStatus: rows, summary: summary[0] || {} };
  }

  /** Discount analytics — daily discount totals. */
  async discountAnalytics(ctx: AuthContext, dr: DateRange, branchId?: number) {
    const { from, to } = clampDateRange(dr);
    const o = ctx.organizationId;
    const branchCond = branchId ? `AND s.branch_id=${branchId}` :
      (ctx.spansAll ? '' : `AND s.branch_id IN (${ctx.accessibleBranchIds.join(',') || '0'})`);
    const rows = await this.ds.manager.query(
      `SELECT DATE(s.created_at) AS day,
              COUNT(*)::int AS "discountedSales",
              COALESCE(SUM(s.discount),0)::double precision AS "totalDiscount"
       FROM sales s
       WHERE s.organization_id=$1 AND s.created_at BETWEEN $2 AND $3 AND s.discount > 0 ${branchCond}
       GROUP BY day ORDER BY day`,
      [o, from, to],
    );
    return rows;
  }

  /** Tax analytics — daily tax totals. */
  async taxAnalytics(ctx: AuthContext, dr: DateRange, branchId?: number) {
    const { from, to } = clampDateRange(dr);
    const o = ctx.organizationId;
    const branchCond = branchId ? `AND s.branch_id=${branchId}` :
      (ctx.spansAll ? '' : `AND s.branch_id IN (${ctx.accessibleBranchIds.join(',') || '0'})`);
    const rows = await this.ds.manager.query(
      `SELECT DATE(s.created_at) AS day,
              COALESCE(SUM(s.tax_total),0)::double precision AS "totalTax",
              COALESCE(SUM(s.subtotal),0)::double precision AS "totalSubtotal"
       FROM sales s
       WHERE s.organization_id=$1 AND s.created_at BETWEEN $2 AND $3 ${branchCond}
       GROUP BY day ORDER BY day`,
      [o, from, to],
    );
    return rows;
  }

  /** Stock movement analytics — by reason, by day. */
  async stockMovementAnalytics(ctx: AuthContext, dr: DateRange, branchId?: number) {
    const { from, to } = clampDateRange(dr);
    const o = ctx.organizationId;
    const branchCond = branchId ? `AND im.branch_id=${branchId}` :
      (ctx.spansAll ? '' : `AND im.branch_id IN (${ctx.accessibleBranchIds.join(',') || '0'})`);
    const byReason = await this.ds.manager.query(
      `SELECT im.reason, COUNT(*)::int AS "count",
              SUM(CASE WHEN im.change > 0 THEN im.change ELSE 0 END)::int AS "inbound",
              SUM(CASE WHEN im.change < 0 THEN ABS(im.change) ELSE 0 END)::int AS "outbound"
       FROM inventory_movements im
       JOIN branches b ON b.id=im.branch_id
       WHERE b.organization_id=$1 AND im.created_at BETWEEN $2 AND $3 ${branchCond}
       GROUP BY im.reason ORDER BY "count" DESC`,
      [o, from, to],
    );
    const byDay = await this.ds.manager.query(
      `SELECT DATE(im.created_at) AS day,
              COUNT(*)::int AS "count",
              SUM(CASE WHEN im.change > 0 THEN im.change ELSE 0 END)::int AS "inbound",
              SUM(CASE WHEN im.change < 0 THEN ABS(im.change) ELSE 0 END)::int AS "outbound"
       FROM inventory_movements im
       JOIN branches b ON b.id=im.branch_id
       WHERE b.organization_id=$1 AND im.created_at BETWEEN $2 AND $3 ${branchCond}
       GROUP BY day ORDER BY day`,
      [o, from, to],
    );
    return { byReason, byDay };
  }

  /** Report: Sales report with totals. */
  async reportSales(ctx: AuthContext, dr: DateRange, branchId?: number, page = 1, pageSize = 50) {
    const { from, to } = clampDateRange(dr);
    const o = ctx.organizationId;
    const branchCond = branchId ? `AND s.branch_id=${branchId}` :
      (ctx.spansAll ? '' : `AND s.branch_id IN (${ctx.accessibleBranchIds.join(',') || '0'})`);
    const offset = (page - 1) * pageSize;
    const [rows, countRows] = await Promise.all([
      this.ds.manager.query(
        `SELECT s.id, s.invoice_no AS "invoiceNo", s.subtotal, s.tax_total AS "taxTotal",
                s.discount, s.total, s.paid, s.change_amount AS "changeAmount",
                s.payment_method AS "paymentMethod", s.created_at AS "createdAt",
                b.name AS "branchName"
         FROM sales s
         LEFT JOIN branches b ON b.id=s.branch_id
         WHERE s.organization_id=$1 AND s.created_at BETWEEN $2 AND $3 ${branchCond}
         ORDER BY s.created_at DESC
         LIMIT $4 OFFSET $5`,
        [o, from, to, pageSize, offset],
      ),
      this.ds.manager.query(
        `SELECT COUNT(*)::int AS c FROM sales s
         WHERE s.organization_id=$1 AND s.created_at BETWEEN $2 AND $3 ${branchCond}`,
        [o, from, to],
      ),
    ]);
    return { items: rows, total: Number(countRows[0]?.c) || 0, page, pageSize };
  }

  /** Report: Profit report with line items. */
  async reportProfit(ctx: AuthContext, dr: DateRange, branchId?: number, page = 1, pageSize = 50) {
    const { from, to } = clampDateRange(dr);
    const o = ctx.organizationId;
    const branchCond = branchId ? `AND s.branch_id=${branchId}` :
      (ctx.spansAll ? '' : `AND s.branch_id IN (${ctx.accessibleBranchIds.join(',') || '0'})`);
    const offset = (page - 1) * pageSize;
    const [rows, countRows] = await Promise.all([
      this.ds.manager.query(
        `SELECT si.product_id AS "productId", si.product_name AS "productName",
                SUM(si.quantity)::int AS "totalQty",
                SUM(si.line_total)::double precision AS revenue,
                SUM(si.unit_cost * si.quantity)::double precision AS "costOfGoods",
                SUM(si.line_total - si.unit_cost * si.quantity)::double precision AS profit
         FROM sale_items si
         JOIN sales s ON s.id=si.sale_id
         WHERE s.organization_id=$1 AND s.created_at BETWEEN $2 AND $3 ${branchCond}
         GROUP BY si.product_id, si.product_name
         ORDER BY profit DESC
         LIMIT $4 OFFSET $5`,
        [o, from, to, pageSize, offset],
      ),
      this.ds.manager.query(
        `SELECT COUNT(DISTINCT si.product_id)::int AS c
         FROM sale_items si
         JOIN sales s ON s.id=si.sale_id
         WHERE s.organization_id=$1 AND s.created_at BETWEEN $2 AND $3 ${branchCond}`,
        [o, from, to],
      ),
    ]);
    return { items: rows, total: Number(countRows[0]?.c) || 0, page, pageSize };
  }

  /** Report: Purchasing report. */
  async reportPurchasing(ctx: AuthContext, dr: DateRange, page = 1, pageSize = 50) {
    const { from, to } = clampDateRange(dr);
    const o = ctx.organizationId;
    const offset = (page - 1) * pageSize;
    const [rows, countRows] = await Promise.all([
      this.ds.manager.query(
        `SELECT po.id, po.ref, po.status, po.created_at AS "createdAt",
                sp.name AS "supplierName",
                COALESCE(SUM(poi.qty * poi.unit_cost),0)::double precision AS "totalCost",
                SUM(poi.qty)::int AS "totalQty",
                SUM(poi.received_qty)::int AS "receivedQty"
         FROM purchase_orders po
         JOIN suppliers sp ON sp.id=po.supplier_id
         LEFT JOIN purchase_order_items poi ON poi.po_id=po.id
         WHERE po.organization_id=$1 AND po.created_at BETWEEN $2 AND $3
         GROUP BY po.id, po.ref, po.status, po.created_at, sp.name
         ORDER BY po.created_at DESC
         LIMIT $4 OFFSET $5`,
        [o, from, to, pageSize, offset],
      ),
      this.ds.manager.query(
        `SELECT COUNT(*)::int AS c FROM purchase_orders po
         WHERE po.organization_id=$1 AND po.created_at BETWEEN $2 AND $3`,
        [o, from, to],
      ),
    ]);
    return { items: rows, total: Number(countRows[0]?.c) || 0, page, pageSize };
  }

  /** Report: Branch comparison report. */
  async reportBranches(ctx: AuthContext, dr: DateRange) {
    const { from, to } = clampDateRange(dr);
    const o = ctx.organizationId;
    const rows = await this.ds.manager.query(
      `SELECT b.id AS "branchId", b.name AS "branchName", b.status,
              (SELECT COUNT(*)::int FROM branch_inventory bi WHERE bi.branch_id=b.id AND bi.quantity > 0) AS "activeProducts",
              (SELECT COALESCE(ROUND(SUM(bi.quantity * bi.cost)::numeric,2)::double precision,0)
               FROM branch_inventory bi WHERE bi.branch_id=b.id) AS "stockValue",
              (SELECT COUNT(*)::int FROM sales s WHERE s.branch_id=b.id AND s.created_at BETWEEN $2 AND $3) AS "salesCount",
              (SELECT COALESCE(SUM(s.total),0)::double precision FROM sales s WHERE s.branch_id=b.id AND s.created_at BETWEEN $2 AND $3) AS revenue
       FROM branches b
       WHERE b.organization_id=$1 AND b.status='active'
       ORDER BY revenue DESC`,
      [o, from, to],
    );
    return rows;
  }

  /** Report: Inventory movements report. */
  async reportMovements(ctx: AuthContext, dr: DateRange, branchId?: number, page = 1, pageSize = 50) {
    const { from, to } = clampDateRange(dr);
    const o = ctx.organizationId;
    const branchCond = branchId ? `AND im.branch_id=${branchId}` :
      (ctx.spansAll ? '' : `AND im.branch_id IN (${ctx.accessibleBranchIds.join(',') || '0'})`);
    const offset = (page - 1) * pageSize;
    const [rows, countRows] = await Promise.all([
      this.ds.manager.query(
        `SELECT im.id, im.product_id AS "productId", p.name AS "productName",
                im.change, im.reason, im.balance_before AS "balanceBefore",
                im.balance_after AS "balanceAfter", im.created_at AS "createdAt",
                b.name AS "branchName", u.username AS "actorName"
         FROM inventory_movements im
         JOIN products p ON p.id=im.product_id
         LEFT JOIN branches b ON b.id=im.branch_id
         LEFT JOIN users u ON u.id=im.actor_id
         WHERE p.organization_id=$1 AND im.created_at BETWEEN $2 AND $3 ${branchCond}
         ORDER BY im.created_at DESC
         LIMIT $4 OFFSET $5`,
        [o, from, to, pageSize, offset],
      ),
      this.ds.manager.query(
        `SELECT COUNT(*)::int AS c
         FROM inventory_movements im
         JOIN products p ON p.id=im.product_id
         WHERE p.organization_id=$1 AND im.created_at BETWEEN $2 AND $3 ${branchCond}`,
        [o, from, to],
      ),
    ]);
    return { items: rows, total: Number(countRows[0]?.c) || 0, page, pageSize };
  }

  /** Export to CSV (returns CSV string). */
  exportCsv(rows: Record<string, unknown>[], columns: { key: string; label: string }[]): string {
    if (!rows.length) return columns.map(c => c.label).join(',') + '\n';
    const header = columns.map(c => c.label).join(',');
    const lines = rows.map(r =>
      columns.map(c => {
        const v = r[c.key];
        if (v == null) return '';
        const s = String(v);
        return s.includes(',') || s.includes('"') || s.includes('\n')
          ? '"' + s.replace(/"/g, '""') + '"' : s;
      }).join(','),
    );
    return header + '\n' + lines.join('\n');
  }
}
