import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  Get,
  Injectable,
  Module,
  NotFoundException,
  Param,
  ParseIntPipe,
  Post,
  Query,
} from '@nestjs/common';
import { IsInt, IsOptional, IsString, MaxLength, Min } from 'class-validator';
import { CurrentAuth, AuthContext, RequirePermission } from '../../common/auth-context';
import { DomainSupport } from '../../common/domain-support';
import { EVENTS, EventsGateway } from '../../events/events.module';

@Injectable()
export class InventoryService {
  constructor(private readonly support: DomainSupport, private readonly events: EventsGateway) {}

  async adjust(
    ctx: AuthContext,
    input: { productId: number; delta: number; reasonCode: string; note?: string },
  ) {
    const branchId = ctx.branchId;
    const res = await this.support.ds.transaction(async (tx) => {
      const row = await this.support.ensureBranchRowTx(tx, branchId, input.productId, ctx.organizationId);
      const newQty = row.quantity + Math.trunc(input.delta);
      if (newQty < 0) {
        throw new ConflictException({
          message: `الكمية غير كافية (المتاح ${row.quantity})`,
          code: 'INSUFFICIENT_STOCK',
        });
      }
      await tx.query(
        `UPDATE branch_inventory SET quantity=$3, updated_at=now() WHERE branch_id=$1 AND product_id=$2`,
        [branchId, input.productId, newQty],
      );
      const isDefault = await this.support.isDefaultBranchTx(tx, branchId);
      if (isDefault) {
        await tx.query(`UPDATE products SET quantity=$2, updated_at=now() WHERE id=$1`, [input.productId, newQty]);
      }
      const mvId = await this.support.insMovement(tx, {
        productId: input.productId,
        change: Math.trunc(input.delta),
        reason: input.reasonCode,
        reasonCode: input.reasonCode,
        balanceAfter: newQty,
        actorId: ctx.userId,
        note: input.note || null,
        branchId,
        organizationId: ctx.organizationId,
      });
      await tx.query(
        `INSERT INTO audit_log (actor_id, action, entity_type, entity_id, details, organization_id)
         VALUES ($1,'inventory.adjust','product',$2,$3,$4)`,
        [ctx.userId, input.productId, JSON.stringify({ delta: Math.trunc(input.delta), reasonCode: input.reasonCode }), ctx.organizationId],
      );
      return { movementId: mvId, quantity: newQty };
    });
    this.events.emitBranch(branchId, EVENTS.INVENTORY_UPDATED, {
      productId: input.productId,
      branchId,
      quantity: res.quantity,
      source: 'adjust',
    });
    return res;
  }

  async openReconciliation(
    ctx: AuthContext,
    input: { productId: number; countedQty: number; reasonCode: string; note?: string },
  ) {
    const branchId = ctx.branchId;
    return this.support.ds.transaction(async (tx) => {
      const row = await this.support.ensureBranchRowTx(tx, branchId, input.productId, ctx.organizationId);
      const open = await tx.query(
        `SELECT id FROM stock_reconciliations WHERE product_id=$1 AND branch_id=$2 AND status='open'`,
        [input.productId, branchId],
      );
      if (open[0]) {
        throw new ConflictException({ message: 'يوجد جرد مفتوح لهذا المنتج', code: 'OPEN_RECONCILIATIONS' });
      }
      const rows = await tx.query(
        `INSERT INTO stock_reconciliations
           (product_id, system_qty, counted_qty, diff_qty, reason_code, note, branch_id, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
        [
          input.productId,
          row.quantity,
          Math.trunc(input.countedQty),
          Math.trunc(input.countedQty) - row.quantity,
          input.reasonCode,
          input.note || '',
          branchId,
          ctx.userId,
        ],
      );
      return rows[0];
    });
  }

  private static STALE_MARKER = 'STALE_MARKER';

  async confirmReconciliation(ctx: AuthContext, reconId: number) {
    let res: { ok: true; quantity: number; reconId: number; branchId: number; productId: number };
    try {
      res = await this.support.ds.transaction(async (tx) => {
        const recs = await tx.query(`SELECT * FROM stock_reconciliations WHERE id=$1 FOR UPDATE`, [reconId]);
        const rec = recs[0];
        if (!rec) throw new NotFoundException({ message: 'الجرد غير موجود', code: 'NOT_FOUND' });
        if (rec.status !== 'open') {
          throw new ConflictException({ message: 'الجرد ليس في حالة مفتوح', code: 'INVALID_STATUS' });
        }
        const current = await this.support.ensureBranchRowTx(tx, Number(rec.branch_id), Number(rec.product_id), ctx.organizationId);
        if (current.quantity !== Number(rec.system_qty)) {
          throw new Error(InventoryService.STALE_MARKER);
        }
        const diff = Number(rec.diff_qty);
        const newQty = current.quantity + diff;
        await tx.query(
          `UPDATE branch_inventory SET quantity=$3, updated_at=now()
           WHERE branch_id=$1 AND product_id=$2`,
          [rec.branch_id, rec.product_id, newQty],
        );
        const isDefault = await this.support.isDefaultBranchTx(tx, Number(rec.branch_id));
        if (isDefault) {
          await tx.query(`UPDATE products SET quantity=$2, updated_at=now() WHERE id=$1`, [rec.product_id, newQty]);
        }
        const mvId = await this.support.insMovement(tx, {
          productId: Number(rec.product_id),
          change: diff,
          reason: 'reconciliation',
          reasonCode: String(rec.reason_code),
          refType: 'stock_reconciliation',
          refId: reconId,
          balanceAfter: newQty,
          actorId: ctx.userId,
          note: rec.note,
          branchId: Number(rec.branch_id),
          organizationId: ctx.organizationId,
        });
        await tx.query(
          `UPDATE stock_reconciliations SET status='applied', applied_by=$2, applied_at=now(), movement_id=$3
           WHERE id=$1`,
          [reconId, ctx.userId, mvId],
        );
        await tx.query(
          `INSERT INTO audit_log (actor_id, action, entity_type, entity_id, details, organization_id)
           VALUES ($1,'inventory.reconcile','stock_reconciliation',$2,$3,$4)`,
          [ctx.userId, reconId, JSON.stringify({ diff }), ctx.organizationId],
        );
        return { ok: true as const, quantity: newQty, reconId, branchId: Number(rec.branch_id), productId: Number(rec.product_id) };
      });
    } catch (e) {
      if (e instanceof Error && e.message === InventoryService.STALE_MARKER) {
        await this.support.ds.manager.query(
          `UPDATE stock_reconciliations SET status='stale' WHERE id=$1`, [reconId],
        );
        throw new ConflictException({
          message: 'الجرد قديم: تغيرت الكمية النظامية بعد فتحه',
          code: 'STALE_RECONCILIATION',
        });
      }
      throw e;
    }
    this.events.emitBranch(res.branchId, EVENTS.INVENTORY_UPDATED, {
      productId: res.productId,
      branchId: res.branchId,
      quantity: res.quantity,
      source: 'reconciliation',
      reconId: res.reconId,
    });
    return { ok: true as const, quantity: res.quantity };
  }

  cancelReconciliation(ctx: AuthContext, reconId: number) {
    return this.support.ds.transaction(async (tx) => {
      const recs = await tx.query(`SELECT * FROM stock_reconciliations WHERE id=$1 FOR UPDATE`, [reconId]);
      const rec = recs[0];
      if (!rec) throw new NotFoundException({ message: 'الجرد غير موجود', code: 'NOT_FOUND' });
      if (rec.status !== 'open') {
        throw new ConflictException({ message: 'يمكن إلغاء الجرد المفتوح فقط', code: 'INVALID_STATUS' });
      }
      await tx.query(`UPDATE stock_reconciliations SET status='cancelled' WHERE id=$1`, [reconId]);
      await tx.query(
        `INSERT INTO audit_log (actor_id, action, entity_type, entity_id, organization_id)
         VALUES ($1,'inventory.recon_cancel','stock_reconciliation',$2,$3)`,
        [ctx.userId, reconId, ctx.organizationId],
      );
      return { ok: true as const };
    });
  }

  async listReconciliations(ctx: AuthContext, opts: { status?: string }) {
    const params: unknown[] = [];
    let where = `WHERE 1=1`;
    params.push(ctx.organizationId);
    where += ` AND p.organization_id=$${params.length}`;
    if (!ctx.spansAll) {
      params.push(ctx.accessibleBranchIds);
      where += ` AND (r.branch_id IS NULL OR r.branch_id = ANY($${params.length}))`;
    }
    if (opts.status) {
      params.push(opts.status);
      where += ` AND r.status=$${params.length}`;
    }
    return this.support.ds.manager.query(
      `SELECT r.*, p.name AS "productName", b.name AS "branchName",
              u.username AS "createdByName"
       FROM stock_reconciliations r
       JOIN products p ON p.id=r.product_id
       LEFT JOIN branches b ON b.id=r.branch_id
       LEFT JOIN users u ON u.id=r.created_by
       ${where} ORDER BY r.id DESC LIMIT 300`,
      params.slice(),
    );
  }

  async setRules(
    ctx: AuthContext,
    productId: number,
    input: { lowStockThreshold: number; reorderQty: number },
  ) {
    const lst = Math.max(0, Math.trunc(input.lowStockThreshold));
    const rq = Math.max(0, Math.trunc(input.reorderQty));
    return this.support.ds.transaction(async (tx) => {
      const branchId = ctx.branchId;
      await this.support.ensureBranchRowTx(tx, branchId, productId, ctx.organizationId);
      await tx.query(
        `UPDATE branch_inventory SET low_stock_threshold=$3, reorder_qty=$4, updated_at=now()
         WHERE branch_id=$1 AND product_id=$2`,
        [branchId, productId, lst, rq],
      );
      if (await this.support.isDefaultBranchTx(tx, branchId)) {
        await tx.query(
          `UPDATE products SET low_stock_threshold=$2, reorder_qty=$3, updated_at=now() WHERE id=$1`,
          [productId, lst, rq],
        );
      }
      await tx.query(
        `INSERT INTO audit_log (actor_id, action, entity_type, entity_id, details, organization_id)
         VALUES ($1,'inventory.rules','product',$2,$3,$4)`,
        [ctx.userId, productId, JSON.stringify({ lst, rq, branchId }), ctx.organizationId],
      );
      return { ok: true as const };
    });
  }

  async valuation(ctx: AuthContext) {
    const em = this.support.ds.manager;
    const branchId = ctx.branchId;
    const totalRows = await em.query(
      `SELECT COALESCE(ROUND(SUM(quantity*cost)::numeric,2)::double precision,0) AS v,
              COALESCE(SUM(quantity),0)::int AS units
       FROM branch_inventory WHERE branch_id=$1`,
      [branchId],
    );
    const byCategory = await em.query(
      `SELECT COALESCE(c.name,'غير مصنف') AS category,
              COALESCE(ROUND(SUM(bi.quantity*bi.cost)::numeric,2)::double precision,0) AS value
       FROM branch_inventory bi
       JOIN products p ON p.id=bi.product_id
       LEFT JOIN categories c ON c.id=p.category_id
       WHERE bi.branch_id=$1 AND bi.quantity>0
       GROUP BY 1 ORDER BY value DESC`,
      [branchId],
    );
    const counts = await em.query(
      `SELECT
         COUNT(*) FILTER (WHERE quantity > low_stock_threshold)::int AS healthy,
         COUNT(*) FILTER (WHERE quantity <= low_stock_threshold AND quantity > 0)::int AS lowStock,
         COUNT(*) FILTER (WHERE quantity = 0)::int AS outOfStock
       FROM branch_inventory WHERE branch_id=$1`,
      [branchId],
    );
    return {
      totalValue: Number(totalRows[0].v),
      totalUnits: Number(totalRows[0].units),
      byCategory,
      ...counts[0],
    };
  }

  async movementsPaged(
    ctx: AuthContext,
    q: { productId?: number; from?: string; to?: string; page?: number; pageSize?: number; allBranches?: boolean },
  ) {
    const em = this.support.ds.manager;
    const page = Math.max(1, Number(q.page || 1));
    const size = Math.min(200, Math.max(1, Number(q.pageSize || 50)));
    const params: unknown[] = [];
    let where = `WHERE 1=1`;
    if (!ctx.spansAll) {
      params.push(ctx.accessibleBranchIds);
      where += ` AND (m.branch_id = ANY($${params.length}))`;
    } else if (q.from === undefined && ctx.branchId && !q.allBranches) {
      params.push(ctx.branchId);
      where += ` AND (m.branch_id = $${params.length})`;
    }
    if (q.productId != null) {
      params.push(Number(q.productId));
      where += ` AND m.product_id=$${params.length}`;
    }
    if (q.from) {
      params.push(q.from);
      where += ` AND m.created_at >= ($${params.length})::timestamptz`;
    }
    if (q.to) {
      params.push(q.to);
      where += ` AND m.created_at <= ($${params.length})::timestamptz`;
    }
    const total = await em.query(
      `SELECT COUNT(*)::int AS c FROM inventory_movements m ${where}`,
      params,
    );
    params.push(size, (page - 1) * size);
    const rows = await em.query(
      `SELECT m.id, m.product_id AS "productId", p.name AS "productName",
              m.change, m.reason, m.reason_code AS "reasonCode", m.note,
              m.ref_type AS "refType", m.ref_id AS "refId",
              m.balance_before AS "balanceBefore", m.balance_after AS "balanceAfter",
              m.branch_id AS "branchId", b.name AS "branchName",
              u.username AS "actorName", m.created_at AS "createdAt"
       FROM inventory_movements m
       JOIN products p ON p.id=m.product_id
       LEFT JOIN branches b ON b.id=m.branch_id
       LEFT JOIN users u ON u.id=m.actor_id
       ${where}
       ORDER BY m.id DESC
       LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params,
    );
    return { rows, total: Number(total[0].c), page, pageSize: size };
  }

  async costHistory(ctx: AuthContext, productId: number) {
    void ctx;
    return this.support.ds.manager.query(
      `SELECT ch.*, s.name AS "supplierName", b.name AS "branchName", g.ref AS "grnRef",
              u.username AS "actorName"
       FROM cost_history ch
       LEFT JOIN suppliers s ON s.id=ch.supplier_id
       LEFT JOIN branches b ON b.id=ch.branch_id
       LEFT JOIN grns g ON g.id=ch.grn_id
       LEFT JOIN users u ON u.id=ch.actor_id
       WHERE ch.product_id=$1 ORDER BY ch.id DESC LIMIT 200`,
      [productId],
    );
  }
}

export class AdjustDto {
  @IsInt() productId!: number;
  @IsInt() delta!: number;
  @IsString() @MaxLength(40) reasonCode!: string;
  @IsOptional() @IsString() @MaxLength(300) note?: string;
}

export class OpenReconDto {
  @IsInt() productId!: number;
  @IsInt() @Min(0) countedQty!: number;
  @IsString() @MaxLength(40) reasonCode!: string;
  @IsOptional() @IsString() @MaxLength(300) note?: string;
}

export class RulesDto {
  @IsInt() @Min(0) lowStockThreshold!: number;
  @IsInt() @Min(0) reorderQty!: number;
}

@Controller('inventory')
export class InventoryController {
  constructor(private readonly svc: InventoryService) {}

  @Post('adjust')
  @RequirePermission('inventory.adjust')
  adjust(@Body() dto: AdjustDto, @CurrentAuth() ctx: AuthContext) {
    return this.svc.adjust(ctx, dto);
  }

  @Post('reconciliations')
  @RequirePermission('inventory.reconcile')
  openReconciliation(@Body() dto: OpenReconDto, @CurrentAuth() ctx: AuthContext) {
    return this.svc.openReconciliation(ctx, dto);
  }

  @Get('reconciliations')
  @RequirePermission('inventory.read')
  listReconciliations(@CurrentAuth() ctx: AuthContext, @Query('status') status?: string) {
    return this.svc.listReconciliations(ctx, { status });
  }

  @Post('reconciliations/:id/confirm')
  @RequirePermission('inventory.reconcile')
  confirm(@Param('id', ParseIntPipe) id: number, @CurrentAuth() ctx: AuthContext) {
    return this.svc.confirmReconciliation(ctx, id);
  }

  @Post('reconciliations/:id/cancel')
  @RequirePermission('inventory.reconcile')
  cancelRecon(@Param('id', ParseIntPipe) id: number, @CurrentAuth() ctx: AuthContext) {
    return this.svc.cancelReconciliation(ctx, id);
  }

  @Post('products/:id/rules')
  @RequirePermission('inventory.rules.manage')
  setRules(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: RulesDto,
    @CurrentAuth() ctx: AuthContext,
  ) {
    return this.svc.setRules(ctx, id, dto);
  }

  @Get('valuation')
  @RequirePermission('inventory.valuation')
  valuation(@CurrentAuth() ctx: AuthContext) {
    return this.svc.valuation(ctx);
  }

  @Get('movements')
  @RequirePermission('inventory.read')
  movements(
    @CurrentAuth() ctx: AuthContext,
    @Query('productId') productId?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
    @Query('allBranches') allBranches?: string,
  ) {
    return this.svc.movementsPaged(ctx, {
      productId: productId ? Number(productId) : undefined,
      from, to,
      page: page ? Number(page) : undefined,
      pageSize: pageSize ? Number(pageSize) : undefined,
      allBranches: allBranches === '1',
    });
  }

  @Get('products/:id/cost-history')
  @RequirePermission('inventory.cost.read')
  costHistory(@Param('id', ParseIntPipe) id: number, @CurrentAuth() ctx: AuthContext) {
    return this.svc.costHistory(ctx, id);
  }
}

@Module({
  controllers: [InventoryController],
  providers: [InventoryService],
})
export class InventoryModule {}
