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
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { IsArray, IsInt, IsNumber, IsOptional, IsString, Min, ValidateNested } from 'class-validator';
import { Type } from 'class-transformer';
import { CurrentAuth, AuthContext, RequirePermission } from '../../common/auth-context';
import { DomainSupport } from '../../common/domain-support';
import { EVENTS, EventsGateway } from '../../events/events.module';

interface ReceiveLinePlan {
  poItemId: number;
  productId: number;
  receive: number;
  damaged: number;
  good: number;
  unitCost: number;
}

@Injectable()
export class PurchasesService {
  constructor(private readonly support: DomainSupport, private readonly events: EventsGateway) {}

  private get em() {
    return this.support.ds.manager;
  }

  async nextRefTx(tx, prefix: string, key: string, organizationId: number): Promise<string> {
    const orgRows = await tx.query(
      `SELECT value FROM org_settings WHERE organization_id=$1 AND key=$2 FOR UPDATE`,
      [organizationId, key],
    );
    let n: number;
    if (orgRows[0]) {
      n = Number(orgRows[0].value) + 1;
    } else {
      const globalRows = await tx.query(
        `SELECT value FROM settings WHERE key=$1 FOR UPDATE`,
        [key],
      );
      n = Number(globalRows[0]?.value || 0) + 1;
    }
    await tx.query(
      `INSERT INTO org_settings (organization_id, key, value) VALUES ($1,$2,$3)
       ON CONFLICT (organization_id, key) DO UPDATE SET value=$3`,
      [organizationId, key, String(n)],
    );
    return `${prefix}-${String(n).padStart(4, '0')}`;
  }

  async list(ctx: AuthContext, opts: { status?: string }) {
    const params: unknown[] = [ctx.organizationId];
    let where = `WHERE po.organization_id=$1`;
    if (!ctx.spansAll) {
      params.push(ctx.accessibleBranchIds);
      where += ` AND (po.branch_id IS NULL OR po.branch_id = ANY($${params.length}))`;
    }
    if (opts.status) {
      params.push(opts.status);
      where += ` AND po.status=$${params.length}`;
    }
    return this.em.query(
      `SELECT po.*, s.name AS "supplierName", b.name AS "branchName",
         COALESCE((SELECT ROUND(SUM(poi.qty*poi.unit_cost)::numeric,2)::double precision
           FROM purchase_order_items poi WHERE poi.po_id=po.id),0) AS "totalCost",
         (SELECT COUNT(*)::int FROM grns g WHERE g.po_id=po.id) AS "grnCount"
       FROM purchase_orders po
       LEFT JOIN suppliers s ON s.id=po.supplier_id
       LEFT JOIN branches b ON b.id=po.branch_id
       ${where} ORDER BY po.id DESC LIMIT 500`,
      params,
    );
  }

  async getOne(id: number, organizationId: number) {
    const head = await this.em.query(
      `SELECT po.*, s.name AS "supplierName", b.name AS "branchName" FROM purchase_orders po
       LEFT JOIN suppliers s ON s.id=po.supplier_id
       LEFT JOIN branches b ON b.id=po.branch_id
       WHERE po.id=$1 AND po.organization_id=$2`,
      [id, organizationId],
    );
    if (!head[0]) throw new NotFoundException({ message: 'أمر الشراء غير موجود', code: 'NOT_FOUND' });
    const items = await this.em.query(
      `SELECT poi.*, p.name AS "productName" FROM purchase_order_items poi
       JOIN products p ON p.id=poi.product_id WHERE poi.po_id=$1 ORDER BY poi.id`,
      [id],
    );
    const grns = await this.em.query(
      `SELECT g.*, u.username AS "receivedByName" FROM grns g
       LEFT JOIN users u ON u.id=g.received_by WHERE g.po_id=$1 ORDER BY g.id`,
      [id],
    );
    return { ...head[0], items, grns };
  }

  private async assertSupplierActive(em, supplierId: number, organizationId: number) {
    const rows = await em.query(
      `SELECT id, status FROM suppliers WHERE id=$1 AND organization_id=$2`,
      [supplierId, organizationId],
    );
    if (!rows[0]) throw new NotFoundException({ message: 'المورّد غير موجود', code: 'NOT_FOUND' });
    if (rows[0].status !== 'active') {
      throw new ConflictException({ message: 'المورّد غير نشط', code: 'SUPPLIER_DISABLED' });
    }
  }

  private async validateItems(em, items: PoItemDto[], organizationId: number) {
    if (!items.length) {
      throw new BadRequestException({ message: 'يجب إضافة صنف واحد على الأقل', code: 'EMPTY_ITEMS' });
    }
    for (const it of items) {
      const p = await em.query(
        `SELECT id FROM products WHERE id=$1 AND organization_id=$2`,
        [it.productId, organizationId],
      );
      if (!p[0]) throw new NotFoundException({ message: `المنتج ${it.productId} غير موجود`, code: 'NOT_FOUND' });
    }
  }

  async create(ctx: AuthContext, input: CreatePoDto) {
    await this.support.assertBranchAsync(ctx, input.branchId ?? null);
    return this.support.ds.transaction(async (tx) => {
      await this.assertSupplierActive(tx, input.supplierId, ctx.organizationId);
      await this.validateItems(tx, input.items, ctx.organizationId);
      const branchId = input.branchId ?? ctx.branchId;
      const ref = await this.nextRefTx(tx, 'PO', 'po_seq', ctx.organizationId);
      const rows = await tx.query(
        `INSERT INTO purchase_orders (ref, supplier_id, expected_at, notes, branch_id, created_by, organization_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
        [ref, input.supplierId, input.expectedAt || null, input.notes || '', branchId, ctx.userId, ctx.organizationId],
      );
      const poId = Number(rows[0].id);
      for (const it of input.items) {
        await tx.query(
          `INSERT INTO purchase_order_items (po_id, product_id, qty, unit_cost)
           VALUES ($1,$2,$3,$4)`,
          [poId, it.productId, Math.trunc(it.qty), it.unitCost],
        );
      }
      await tx.query(
        `INSERT INTO audit_log (actor_id, action, entity_type, entity_id, details, organization_id)
         VALUES ($1,'purchase.create','purchase_order',$2,$3,$4)`,
        [ctx.userId, poId, JSON.stringify({ ref }), ctx.organizationId],
      );
      return rows[0];
    });
  }

  async updateItems(ctx: AuthContext, id: number, input: UpdatePoDto) {
    return this.support.ds.transaction(async (tx) => {
      const cur = await tx.query(
        `SELECT * FROM purchase_orders WHERE id=$1 AND organization_id=$2 FOR UPDATE`,
        [id, ctx.organizationId],
      );
      if (!cur[0]) throw new NotFoundException({ message: 'أمر الشراء غير موجود', code: 'NOT_FOUND' });
      if (cur[0].status !== 'draft') {
        throw new ConflictException({
          message: 'يمكن تعديل أوامر الشراء في حالة المسودة فقط',
          code: 'INVALID_STATUS',
        });
      }
      await this.validateItems(tx, input.items, ctx.organizationId);
      await tx.query(`DELETE FROM purchase_order_items WHERE po_id=$1`, [id]);
      for (const it of input.items) {
        await tx.query(
          `INSERT INTO purchase_order_items (po_id, product_id, qty, unit_cost) VALUES ($1,$2,$3,$4)`,
          [id, it.productId, Math.trunc(it.qty), it.unitCost],
        );
      }
      await tx.query(
        `UPDATE purchase_orders SET expected_at=COALESCE($2,expected_at),
                notes=COALESCE($3,notes), updated_at=now() WHERE id=$1`,
        [id, input.expectedAt ?? null, input.notes ?? null],
      );
      await tx.query(
        `INSERT INTO audit_log (actor_id, action, entity_type, entity_id, organization_id)
         VALUES ($1,'purchase.update','purchase_order',$2,$3)`,
        [ctx.userId, id, ctx.organizationId],
      );
      return { ok: true as const };
    });
  }

  private async transition(
    ctx: AuthContext,
    id: number,
    from: string[],
    to: string,
    action: string,
    cancelReason?: string,
  ) {
    return this.support.ds.transaction(async (tx) => {
      const cur = await tx.query(
        `SELECT * FROM purchase_orders WHERE id=$1 AND organization_id=$2 FOR UPDATE`,
        [id, ctx.organizationId],
      );
      if (!cur[0]) throw new NotFoundException({ message: 'أمر الشراء غير موجود', code: 'NOT_FOUND' });
      if (!from.includes(cur[0].status)) {
        throw new ConflictException({ message: `حالة غير صالحة للانتقال إلى (${to})`, code: 'INVALID_STATUS' });
      }
      if (action === 'purchase.approve') {
        await tx.query(
          `UPDATE purchase_orders SET status=$2, approved_by=$3, approved_at=now(), updated_at=now() WHERE id=$1`,
          [id, to, ctx.userId],
        );
      } else if (action === 'purchase.cancel') {
        await tx.query(
          `UPDATE purchase_orders SET status=$2, cancelled_by=$3, cancelled_at=now(),
                  cancel_reason=$4, updated_at=now() WHERE id=$1`,
          [id, to, ctx.userId, cancelReason || ''],
        );
      } else {
        await tx.query(`UPDATE purchase_orders SET status=$2, updated_at=now() WHERE id=$1`, [id, to]);
      }
      await tx.query(
        `INSERT INTO audit_log (actor_id, action, entity_type, entity_id, details, organization_id)
         VALUES ($1,$2,'purchase_order',$3,$4,$5)`,
        [ctx.userId, action, id, JSON.stringify({ from: cur[0].status, to }), ctx.organizationId],
      );
      return { ok: true as const };
    });
  }

  submit(ctx: AuthContext, id: number) {
    return this.transition(ctx, id, ['draft'], 'submitted', 'purchase.submit');
  }

  approve(ctx: AuthContext, id: number) {
    return this.transition(ctx, id, ['submitted'], 'approved', 'purchase.approve');
  }

  async cancel(ctx: AuthContext, id: number, reason: string) {
    return this.support.ds.transaction(async (tx) => {
      const recv = await tx.query(
        `SELECT COALESCE(SUM(received_qty),0)::int AS c FROM purchase_order_items WHERE po_id=$1`,
        [id],
      );
      if (Number(recv[0].c) > 0) {
        throw new ConflictException({
          message: 'لا يمكن إلغاء أمر شراء تم استلام جزء منه',
          code: 'ALREADY_RECEIVED',
        });
      }
      return this.transition(ctx, id, ['draft', 'submitted', 'approved'], 'cancelled', 'purchase.cancel', reason);
    });
  }

  async receiveGoods(ctx: AuthContext, poId: number, input: ReceiveDto) {
    const res = await this.support.ds.transaction(async (tx) => {
      const po = await tx.query(
        `SELECT * FROM purchase_orders WHERE id=$1 AND organization_id=$2 FOR UPDATE`,
        [poId, ctx.organizationId],
      );
      if (!po[0]) throw new NotFoundException({ message: 'أمر الشراء غير موجود', code: 'NOT_FOUND' });
      if (!['approved', 'partially_received'].includes(po[0].status)) {
        throw new ConflictException({ message: 'لا يمكن الاستلام إلا للأوامر المعتمدة', code: 'INVALID_STATUS' });
      }
      const branchId = po[0].branch_id != null ? Number(po[0].branch_id) : ctx.branchId;
      await this.support.assertBranchAsync(ctx, branchId);

      const plans: ReceiveLinePlan[] = [];
      for (const ln of input.lines) {
        const item = await tx.query(
          `SELECT * FROM purchase_order_items WHERE id=$1 AND po_id=$2 FOR UPDATE`,
          [ln.poItemId, poId],
        );
        if (!item[0]) {
          throw new NotFoundException({ message: `بند أمر الشراء ${ln.poItemId} غير موجود`, code: 'NOT_FOUND' });
        }
        const remaining = Number(item[0].qty) - Number(item[0].received_qty);
        const receive = Math.trunc(ln.receiveQty);
        const damaged = Math.trunc(ln.damagedQty || 0);
        if (receive <= 0) {
          throw new BadRequestException({ message: 'كمية الاستلام يجب أن تكون أكبر من صفر', code: 'INVALID_QTY' });
        }
        if (receive > remaining) {
          throw new ConflictException({
            message: `الاستلام يتجاوز الكمية المتبقية (المتبقي ${remaining})`,
            code: 'OVER_RECEIVE',
          });
        }
        if (damaged < 0 || damaged > receive) {
          throw new BadRequestException({ message: 'كمية التالف غير صالحة', code: 'INVALID_DAMAGED' });
        }
        plans.push({
          poItemId: Number(item[0].id),
          productId: Number(item[0].product_id),
          receive,
          damaged,
          good: receive - damaged,
          unitCost: Number(item[0].unit_cost),
        });
      }

      const grnRef = await this.nextRefTx(tx, 'GRN', 'grn_seq', ctx.organizationId);
      const grnRows = await tx.query(
        `INSERT INTO grns (ref, po_id, supplier_id, branch_id, received_at, notes, received_by, organization_id)
         VALUES ($1,$2,$3,$4,now(),$5,$6,$7) RETURNING id`,
        [grnRef, poId, po[0].supplier_id, branchId, input.notes || '', ctx.userId, ctx.organizationId],
      );
      const grnId = Number(grnRows[0].id);

      for (const plan of plans) {
        const row = await this.support.ensureBranchRowTx(tx, branchId, plan.productId, ctx.organizationId);
        const oldQty = row.quantity;
        const oldCost = row.cost;
        const newQty = oldQty + plan.good;
        let newCost = oldCost;
        if (plan.good > 0 && newQty > 0 && plan.unitCost !== oldCost) {
          newCost = Number(((oldQty * oldCost + plan.good * plan.unitCost) / newQty).toFixed(4));
        }

        await tx.query(
          `UPDATE branch_inventory SET quantity=$3, cost=$4, updated_at=now()
           WHERE branch_id=$1 AND product_id=$2`,
          [branchId, plan.productId, newQty, newCost],
        );

        const isDefault = await this.support.isDefaultBranchTx(tx, branchId);
        if (isDefault && plan.good > 0) {
          await tx.query(
            `UPDATE products SET quantity=$2, cost=$3, updated_at=now() WHERE id=$1`,
            [plan.productId, newQty, newCost],
          );
        }

        await tx.query(
          `INSERT INTO grn_items (grn_id, po_item_id, product_id, qty_received, qty_damaged, unit_cost)
           VALUES ($1,$2,$3,$4,$5,$6)`,
          [grnId, plan.poItemId, plan.productId, plan.receive, plan.damaged, plan.unitCost],
        );
        await tx.query(
          `UPDATE purchase_order_items SET received_qty=received_qty+$2 WHERE id=$1`,
          [plan.poItemId, plan.receive],
        );
        await this.support.insMovement(tx, {
          productId: plan.productId,
          change: plan.good,
          reason: 'grn_receive',
          reasonCode: 'PURCHASE_RECEIVE',
          refType: 'grn',
          refId: grnId,
          balanceAfter: newQty,
          actorId: ctx.userId,
          note: `GRN ${grnRef}`,
          branchId,
        });
        await tx.query(
          `INSERT INTO cost_history (product_id, source_type, grn_id, supplier_id, branch_id,
                                     qty_received, unit_cost, prev_cost, new_cost, actor_id)
           VALUES ($1,'grn',$2,$3,$4,$5,$6,$7,$8,$9)`,
          [
            plan.productId, grnId, po[0].supplier_id, branchId,
            plan.good, plan.unitCost, oldCost, newCost, ctx.userId,
          ],
        );
      }

      const sums = await tx.query(
        `SELECT COALESCE(SUM(qty),0)::int AS ordered, COALESCE(SUM(received_qty),0)::int AS received
         FROM purchase_order_items WHERE po_id=$1`,
        [poId],
      );
      const newStatus =
        Number(sums[0].received) >= Number(sums[0].ordered) ? 'fully_received' : 'partially_received';
      await tx.query(`UPDATE purchase_orders SET status=$2, updated_at=now() WHERE id=$1`, [poId, newStatus]);

      await tx.query(
        `INSERT INTO audit_log (actor_id, action, entity_type, entity_id, details, organization_id)
         VALUES ($1,'purchase.receive','purchase_order',$2,$3,$4)`,
        [ctx.userId, poId, JSON.stringify({ grnRef, lines: plans.length }), ctx.organizationId],
      );
      return { grnId, ref: grnRef, status: newStatus, poRef: String(po[0].ref || ''), branchId: po[0].branch_id != null ? Number(po[0].branch_id) : null };
    });
    if (res.branchId != null) {
      this.events.emitBranch(res.branchId, EVENTS.PURCHASE_RECEIVED, {
        grnId: res.grnId,
        ref: res.ref,
        poRef: res.poRef,
        status: res.status,
        branchId: res.branchId,
      });
    }
    return res;
  }

  async grnList(ctx: AuthContext) {
    const params: unknown[] = [ctx.organizationId];
    let where = `WHERE g.organization_id=$1`;
    if (!ctx.spansAll) {
      params.push(ctx.accessibleBranchIds);
      where += ` AND (g.branch_id IS NULL OR g.branch_id = ANY($${params.length}))`;
    }
    return this.em.query(
      `SELECT g.ref, g.id, g.po_id AS "poId", g.received_at AS "receivedAt", g.notes,
              s.name AS "supplierName", b.name AS "branchName",
              (SELECT COUNT(*)::int FROM grn_items gi WHERE gi.grn_id=g.id) AS "lineCount"
       FROM grns g
       LEFT JOIN suppliers s ON s.id=g.supplier_id
       LEFT JOIN branches b ON b.id=g.branch_id
       ${where} ORDER BY g.id DESC LIMIT 300`,
      params,
    );
  }
}

export class PoItemDto {
  @IsInt() productId!: number;
  @IsInt() @Min(1) qty!: number;
  @IsNumber() @Min(0) unitCost!: number;
}

export class CreatePoDto {
  @IsInt() supplierId!: number;
  @IsOptional() @IsInt() branchId?: number | null;
  @IsOptional() @IsString() expectedAt?: string | null;
  @IsOptional() @IsString() notes?: string;
  @IsArray() @ValidateNested({ each: true })
  @Type(() => PoItemDto)
  items!: PoItemDto[];
}

export class UpdatePoDto extends CreatePoDto {}

export class ReceiveLineDto {
  @IsInt() poItemId!: number;
  @IsInt() @Min(1) receiveQty!: number;
  @IsOptional() @IsInt() @Min(0) damagedQty?: number;
}

export class ReceiveDto {
  @IsArray() @ValidateNested({ each: true })
  @Type(() => ReceiveLineDto)
  lines!: ReceiveLineDto[];
  @IsOptional() @IsString() notes?: string;
}

@Controller('purchases')
export class PurchasesController {
  constructor(private readonly svc: PurchasesService) {}

  @Get()
  @RequirePermission('purchases.read')
  list(@CurrentAuth() ctx: AuthContext, @Query('status') status?: string) {
    return this.svc.list(ctx, { status });
  }

  @Get('grns')
  @RequirePermission('purchases.read')
  grns(@CurrentAuth() ctx: AuthContext) {
    return this.svc.grnList(ctx);
  }

  @Get(':id')
  @RequirePermission('purchases.read')
  getOne(@Param('id', ParseIntPipe) id: number, @CurrentAuth() ctx: AuthContext) {
    return this.svc.getOne(id, ctx.organizationId);
  }

  @Post()
  @RequirePermission('purchases.create')
  create(@Body() dto: CreatePoDto, @CurrentAuth() ctx: AuthContext) {
    return this.svc.create(ctx, dto);
  }

  @Patch(':id')
  @RequirePermission('purchases.update')
  update(@Param('id', ParseIntPipe) id: number, @Body() dto: UpdatePoDto, @CurrentAuth() ctx: AuthContext) {
    return this.svc.updateItems(ctx, id, dto);
  }

  @Post(':id/submit')
  @RequirePermission('purchases.update')
  submit(@Param('id', ParseIntPipe) id: number, @CurrentAuth() ctx: AuthContext) {
    return this.svc.submit(ctx, id);
  }

  @Post(':id/approve')
  @RequirePermission('purchases.approve')
  approve(@Param('id', ParseIntPipe) id: number, @CurrentAuth() ctx: AuthContext) {
    return this.svc.approve(ctx, id);
  }

  @Post(':id/cancel')
  @RequirePermission('purchases.cancel')
  cancel(@Param('id', ParseIntPipe) id: number, @Body('reason') reason: string, @CurrentAuth() ctx: AuthContext) {
    return this.svc.cancel(ctx, id, String(reason || ''));
  }

  @Post(':id/receive')
  @RequirePermission('purchases.receive')
  receive(@Param('id', ParseIntPipe) id: number, @Body() dto: ReceiveDto, @CurrentAuth() ctx: AuthContext) {
    return this.svc.receiveGoods(ctx, id, dto);
  }
}

@Module({
  controllers: [PurchasesController],
  providers: [PurchasesService],
})
export class PurchasesModule {}
