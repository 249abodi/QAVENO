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
import { IsArray, IsInt, IsOptional, IsString, Min, ValidateNested } from 'class-validator';
import { Type } from 'class-transformer';
import { CurrentAuth, AuthContext, RequirePermission } from '../../common/auth-context';
import { DomainSupport } from '../../common/domain-support';
import { EVENTS, EventsGateway } from '../../events/events.module';

@Injectable()
export class TransfersService {
  constructor(private readonly support: DomainSupport, private readonly events: EventsGateway) {}

  private async nextRefTx(tx, organizationId: number, key = 'transfer_seq'): Promise<string> {
    let rows = await tx.query(
      `SELECT value FROM org_settings WHERE organization_id=$1 AND key=$2 FOR UPDATE`,
      [organizationId, key],
    );
    if (!rows[0]) {
      rows = await tx.query(`SELECT value FROM settings WHERE key=$1 FOR UPDATE`, [key]);
    }
    const n = Number(rows[0]?.value || 0) + 1;
    await tx.query(
      `INSERT INTO org_settings (organization_id, key, value) VALUES ($1,$2,$3) ON CONFLICT (organization_id, key) DO UPDATE SET value=$3`,
      [organizationId, key, String(n)],
    );
    return `TRF-${String(n).padStart(4, '0')}`;
  }

  async list(ctx: AuthContext, q: { status?: string }) {
    const params: unknown[] = [];
    let where = `WHERE 1=1`;
    params.push(ctx.organizationId);
    where += ` AND t.organization_id=$${params.length}`;
    if (!ctx.spansAll) {
      params.push(ctx.accessibleBranchIds);
      where += ` AND (t.source_branch_id = ANY($${params.length}) OR t.dest_branch_id = ANY($${params.length}))`;
    }
    if (q.status) {
      params.push(q.status);
      where += ` AND t.status=$${params.length}`;
    }
    return this.support.ds.manager.query(
      `SELECT t.*, sb.name AS "sourceBranchName", db.name AS "destBranchName",
              cu.username AS "createdByName",
              (SELECT COUNT(*)::int FROM stock_transfer_items ti WHERE ti.transfer_id=t.id) AS "lineCount"
       FROM stock_transfers t
       JOIN branches sb ON sb.id=t.source_branch_id
       JOIN branches db ON db.id=t.dest_branch_id
       LEFT JOIN users cu ON cu.id=t.created_by
       ${where} ORDER BY t.id DESC LIMIT 300`,
      params,
    );
  }

  async getOne(ctx: AuthContext, id: number) {
    const em = this.support.ds.manager;
    const head = await em.query(
      `SELECT t.*, sb.name AS "sourceBranchName", db.name AS "destBranchName"
       FROM stock_transfers t
       JOIN branches sb ON sb.id=t.source_branch_id
       JOIN branches db ON db.id=t.dest_branch_id
       WHERE t.id=$1 AND t.organization_id=$2`,
      [id, ctx.organizationId],
    );
    const t = head[0];
    if (!t) throw new NotFoundException({ message: 'التحويل غير موجود', code: 'NOT_FOUND' });
    if (!ctx.spansAll &&
        !ctx.accessibleBranchIds.includes(Number(t.source_branch_id)) &&
        !ctx.accessibleBranchIds.includes(Number(t.dest_branch_id))) {
      throw new ConflictException({ message: 'ليس لديك صلاحية على هذا التحويل', code: 'NO_BRANCH_ACCESS' });
    }
    const items = await em.query(
      `SELECT ti.*, p.name AS "productName" FROM stock_transfer_items ti
       JOIN products p ON p.id=ti.product_id WHERE ti.transfer_id=$1 ORDER BY ti.id`,
      [id],
    );
    return { ...t, items };
  }

  async create(ctx: AuthContext, input: CreateTransferDto) {
    await this.support.assertBranchAsync(ctx, input.sourceBranchId);
    await this.support.assertBranchAsync(ctx, input.destBranchId);
    if (input.sourceBranchId === input.destBranchId) {
      throw new BadRequestException({ message: 'لا يمكن التحويل بين الفرع ونفسه', code: 'SAME_BRANCH' });
    }
    return this.support.ds.transaction(async (tx) => {
      const branches = await tx.query(
        `SELECT id, status FROM branches WHERE id IN ($1,$2) AND organization_id=$3`,
        [input.sourceBranchId, input.destBranchId, ctx.organizationId],
      );
      for (const b of branches) {
        if (b.status !== 'active') {
          throw new BadRequestException({ message: 'الفرع غير نشط', code: 'BRANCH_DISABLED' });
        }
      }
      if (branches.length !== 2) {
        throw new BadRequestException({ message: 'فرع غير موجود', code: 'BRANCH_NOT_FOUND' });
      }
      const ids = new Set<number>();
      for (const it of input.items) {
        if (ids.has(it.productId)) {
          throw new BadRequestException({ message: 'منتج مكرر في نفس التحويل', code: 'DUPLICATE_PRODUCT' });
        }
        ids.add(it.productId);
        const p = await tx.query(`SELECT id FROM products WHERE id=$1 AND organization_id=$2`, [it.productId, ctx.organizationId]);
        if (!p[0]) throw new NotFoundException({ message: `المنتج ${it.productId} غير موجود`, code: 'NOT_FOUND' });
      }
      const ref = await this.nextRefTx(tx, ctx.organizationId);
      const rows = await tx.query(
        `INSERT INTO stock_transfers (ref, source_branch_id, dest_branch_id, notes, created_by, organization_id)
         VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
        [ref, input.sourceBranchId, input.destBranchId, input.notes || '', ctx.userId, ctx.organizationId],
      );
      const trId = Number(rows[0].id);
      for (const it of input.items) {
        await tx.query(
          `INSERT INTO stock_transfer_items (transfer_id, product_id, qty) VALUES ($1,$2,$3)`,
          [trId, it.productId, Math.trunc(it.qty)],
        );
      }
      await tx.query(
        `INSERT INTO audit_log (actor_id, action, entity_type, entity_id, details, organization_id)
         VALUES ($1,'transfer.create','stock_transfer',$2,$3,$4)`,
        [ctx.userId, trId, JSON.stringify({ ref }), ctx.organizationId],
      );
      return rows[0];
    });
  }

  private async loadForUpdate(tx, id: number, organizationId: number) {
    const rows = await tx.query(
      `SELECT * FROM stock_transfers WHERE id=$1 AND organization_id=$2 FOR UPDATE`,
      [id, organizationId],
    );
    if (!rows[0]) throw new NotFoundException({ message: 'التحويل غير موجود', code: 'NOT_FOUND' });
    return rows[0];
  }

  submit(ctx: AuthContext, id: number) {
    return this.support.ds.transaction(async (tx) => {
      const t = await this.loadForUpdate(tx, id, ctx.organizationId);
      if (t.status !== 'draft') {
        throw new ConflictException({ message: 'الإرسال متاح من حالة المسودة فقط', code: 'INVALID_STATUS' });
      }
      await this.support.assertBranchAsync(ctx, Number(t.source_branch_id));
      await tx.query(`UPDATE stock_transfers SET status='submitted', updated_at=now() WHERE id=$1`, [id]);
      await tx.query(
        `INSERT INTO audit_log (actor_id, action, entity_type, entity_id, organization_id)
         VALUES ($1,'transfer.submit','stock_transfer',$2,$3)`,
        [ctx.userId, id, ctx.organizationId],
      );
      return { ok: true as const };
    });
  }

  approve(ctx: AuthContext, id: number) {
    return this.support.ds.transaction(async (tx) => {
      const t = await this.loadForUpdate(tx, id, ctx.organizationId);
      if (t.status !== 'submitted') {
        throw new ConflictException({ message: 'الاعتماد متاح من الحالة المرسلة فقط', code: 'INVALID_STATUS' });
      }
      await this.support.assertBranchAsync(ctx, Number(t.dest_branch_id));
      await tx.query(
        `UPDATE stock_transfers SET status='approved', approved_by=$2, approved_at=now(), updated_at=now() WHERE id=$1`,
        [id, ctx.userId],
      );
      await tx.query(
        `INSERT INTO audit_log (actor_id, action, entity_type, entity_id, organization_id)
         VALUES ($1,'transfer.approve','stock_transfer',$2,$3)`,
        [ctx.userId, id, ctx.organizationId],
      );
      return { ok: true as const };
    });
  }

  async dispatch(ctx: AuthContext, id: number, lines: DispatchLineDto[]) {
    const res = await this.support.ds.transaction(async (tx) => {
      const t = await this.loadForUpdate(tx, id, ctx.organizationId);
      if (!['approved', 'dispatched'].includes(t.status)) {
        throw new ConflictException({
          message: 'الشحن متاح للأوامر المعتمدة أو المشحونة جزئياً',
          code: 'INVALID_STATUS',
        });
      }
      await this.support.assertBranchAsync(ctx, Number(t.source_branch_id));

      const plans: { itemId: number; productId: number; send: number }[] = [];
      for (const ln of lines) {
        const item = await tx.query(
          `SELECT * FROM stock_transfer_items WHERE id=$1 AND transfer_id=$2 FOR UPDATE`,
          [ln.itemId, id],
        );
        if (!item[0]) throw new NotFoundException({ message: `بند التحويل غير موجود`, code: 'NOT_FOUND' });
        const remaining = Number(item[0].qty) - Number(item[0].dispatched_qty);
        const send = Math.trunc(ln.qty);
        if (send <= 0 || send > remaining) {
          throw new ConflictException({
            message: `كمية الشحن غير صالحة (المتبقي ${remaining})`,
            code: 'INVALID_DISPATCH_QTY',
          });
        }
        plans.push({ itemId: Number(item[0].id), productId: Number(item[0].product_id), send });
      }

      for (const plan of plans) {
        const row = await this.support.ensureBranchRowTx(tx, Number(t.source_branch_id), plan.productId, ctx.organizationId);
        if (row.quantity < plan.send) {
          throw new ConflictException({
            message: `المخزون غير كافٍ في فرع المصدر للمنتج ${plan.productId} (المتاح ${row.quantity})`,
            code: 'INSUFFICIENT_STOCK',
          });
        }
        const srcNewQty = row.quantity - plan.send;
        await tx.query(
          `UPDATE branch_inventory SET quantity=$3, updated_at=now()
           WHERE branch_id=$1 AND product_id=$2`,
          [t.source_branch_id, plan.productId, srcNewQty],
        );
        const isDefaultSrc = await this.support.isDefaultBranchTx(tx, Number(t.source_branch_id));
        if (isDefaultSrc) {
          await tx.query(`UPDATE products SET quantity=$2, updated_at=now() WHERE id=$1`, [plan.productId, srcNewQty]);
        }
        await tx.query(
          `UPDATE stock_transfer_items SET dispatched_qty=dispatched_qty+$2 WHERE id=$1`,
          [plan.itemId, plan.send],
        );
        await this.support.insMovement(tx, {
          productId: plan.productId,
          change: -plan.send,
          reason: 'transfer_dispatch',
          reasonCode: 'TRANSFER_DISPATCH',
          refType: 'stock_transfer',
          refId: Number(t.id),
          balanceAfter: srcNewQty,
          actorId: ctx.userId,
          note: String(t.ref),
          branchId: Number(t.source_branch_id),
        });
      }

      const anyCost = await tx.query(
        `SELECT COUNT(*)::int AS c FROM stock_transfer_items WHERE transfer_id=$1 AND unit_cost IS NOT NULL`,
        [id],
      );
      if (Number(anyCost[0].c) === 0) {
        for (const plan of plans) {
          const row = await tx.query(
            `SELECT cost FROM branch_inventory WHERE branch_id=$1 AND product_id=$2`,
            [t.source_branch_id, plan.productId],
          );
          await tx.query(
            `UPDATE stock_transfer_items SET unit_cost=$3 WHERE id=$1 AND product_id=$2`,
            [plan.itemId, plan.productId, row.length ? Number(row[0].cost) : 0],
          );
        }
      }

      await tx.query(
        `UPDATE stock_transfers SET status='dispatched', last_dispatched_by=$2,
                last_dispatched_at=now(), updated_at=now() WHERE id=$1`,
        [id, ctx.userId],
      );
      await tx.query(
        `INSERT INTO audit_log (actor_id, action, entity_type, entity_id, details, organization_id)
         VALUES ($1,'transfer.dispatch','stock_transfer',$2,$3,$4)`,
        [ctx.userId, id, JSON.stringify({ lines: plans.length }), ctx.organizationId],
      );
      return { ok: true as const, ref: String(t.ref || ''), sourceBranchId: Number(t.source_branch_id), destBranchId: Number(t.dest_branch_id) };
    });
    for (const bid of new Set([res.sourceBranchId, res.destBranchId])) {
      this.events.emitBranch(bid, EVENTS.TRANSFER_DISPATCHED, {
        ref: res.ref,
        from: res.sourceBranchId,
        to: res.destBranchId,
        branchId: bid,
      });
    }
    return { ok: true as const };
  }

  async receive(ctx: AuthContext, id: number, lines: ReceiveLineDto[]) {
    const res = await this.support.ds.transaction(async (tx) => {
      const t = await this.loadForUpdate(tx, id, ctx.organizationId);
      if (!['dispatched', 'partially_received'].includes(t.status)) {
        throw new ConflictException({
          message: 'الاستلام متاح بعد الشحن فقط',
          code: 'INVALID_STATUS',
        });
      }
      await this.support.assertBranchAsync(ctx, Number(t.dest_branch_id));

      const plans: { itemId: number; productId: number; recv: number }[] = [];
      for (const ln of lines) {
        const item = await tx.query(
          `SELECT * FROM stock_transfer_items WHERE id=$1 AND transfer_id=$2 FOR UPDATE`,
          [ln.itemId, id],
        );
        if (!item[0]) throw new NotFoundException({ message: 'بند التحويل غير موجود', code: 'NOT_FOUND' });
        const outstanding = Number(item[0].dispatched_qty) - Number(item[0].received_qty);
        const recv = Math.trunc(ln.qty);
        if (recv <= 0 || recv > outstanding) {
          throw new ConflictException({
            message: `كمية الاستلام غير صالحة (المتاح للاستلام ${outstanding})`,
            code: 'INVALID_RECEIVE_QTY',
          });
        }
        plans.push({ itemId: Number(item[0].id), productId: Number(item[0].product_id), recv });
      }

      for (const plan of plans) {
        const itemRow = await tx.query(`SELECT unit_cost FROM stock_transfer_items WHERE id=$1`, [plan.itemId]);
        const carriedCost = Number(itemRow[0].unit_cost ?? 0);
        const dst = await this.support.ensureBranchRowTx(tx, Number(t.dest_branch_id), plan.productId, ctx.organizationId);
        const oldQty = dst.quantity;
        const oldCost = dst.cost;
        const newQty = oldQty + plan.recv;
        const blended =
          carriedCost !== oldCost && newQty > 0 && plan.recv > 0
            ? ((oldQty * oldCost + plan.recv * carriedCost) / newQty).toFixed(4)
            : String(oldCost);
        const newCost = Number(blended);

        await tx.query(
          `UPDATE branch_inventory SET quantity=$3, cost=$4, updated_at=now()
           WHERE branch_id=$1 AND product_id=$2`,
          [t.dest_branch_id, plan.productId, newQty, newCost],
        );
        const isDefaultDst = await this.support.isDefaultBranchTx(tx, Number(t.dest_branch_id));
        if (isDefaultDst) {
          await tx.query(
            `UPDATE products SET quantity=$2, cost=$3, updated_at=now() WHERE id=$1`,
            [plan.productId, newQty, newCost],
          );
        }
        await tx.query(
          `UPDATE stock_transfer_items SET received_qty=received_qty+$2 WHERE id=$1`,
          [plan.itemId, plan.recv],
        );
        await this.support.insMovement(tx, {
          productId: plan.productId,
          change: plan.recv,
          reason: 'transfer_receive',
          reasonCode: 'TRANSFER_RECEIVE',
          refType: 'stock_transfer',
          refId: Number(t.id),
          balanceAfter: newQty,
          actorId: ctx.userId,
          note: String(t.ref),
          branchId: Number(t.dest_branch_id),
        });
      }

      const sums = await tx.query(
        `SELECT COALESCE(SUM(dispatched_qty),0)::int AS disp, COALESCE(SUM(received_qty),0)::int AS rec
         FROM stock_transfer_items WHERE transfer_id=$1`,
        [id],
      );
      const newStatus = Number(sums[0].rec) >= Number(sums[0].disp) ? 'received' : 'partially_received';
      await tx.query(
        `UPDATE stock_transfers SET status=$2, last_received_by=$3, last_received_at=now(),
                updated_at=now() WHERE id=$1`,
        [id, newStatus, ctx.userId],
      );
      await tx.query(
        `INSERT INTO audit_log (actor_id, action, entity_type, entity_id, details, organization_id)
         VALUES ($1,'transfer.receive','stock_transfer',$2,$3,$4)`,
        [ctx.userId, id, JSON.stringify({ lines: plans.length, status: newStatus }), ctx.organizationId],
      );
      return { status: newStatus, ref: String(t.ref || ''), sourceBranchId: Number(t.source_branch_id), destBranchId: Number(t.dest_branch_id) };
    });
    for (const bid of new Set([res.sourceBranchId, res.destBranchId])) {
      this.events.emitBranch(bid, EVENTS.TRANSFER_RECEIVED, {
        ref: res.ref,
        from: res.sourceBranchId,
        to: res.destBranchId,
        status: res.status,
        branchId: bid,
      });
    }
    return { status: res.status };
  }

  async cancel(ctx: AuthContext, id: number, reason: string) {
    return this.support.ds.transaction(async (tx) => {
      const t = await this.loadForUpdate(tx, id, ctx.organizationId);
      if (!['draft', 'submitted', 'approved'].includes(t.status)) {
        throw new ConflictException({ message: 'بدأ شحن التحويل — لا يمكن الإلغاء', code: 'DISPATCH_STARTED' });
      }
      await this.support.assertBranchAsync(ctx, Number(t.source_branch_id));
      await tx.query(
        `UPDATE stock_transfers SET status='cancelled', cancelled_by=$2, cancelled_at=now(),
                cancel_reason=$3, updated_at=now() WHERE id=$1`,
        [id, ctx.userId, reason || ''],
      );
      await tx.query(
        `INSERT INTO audit_log (actor_id, action, entity_type, entity_id, details, organization_id)
         VALUES ($1,'transfer.cancel','stock_transfer',$2,$3,$4)`,
        [ctx.userId, id, JSON.stringify({ reason }), ctx.organizationId],
      );
      return { ok: true as const };
    });
  }
}

export class TransferItemDto {
  @IsInt() productId!: number;
  @IsInt() @Min(1) qty!: number;
}

export class CreateTransferDto {
  @IsInt() sourceBranchId!: number;
  @IsInt() destBranchId!: number;
  @IsOptional() @IsString() notes?: string;
  @IsArray() @ValidateNested({ each: true })
  @Type(() => TransferItemDto)
  items!: TransferItemDto[];
}

export class DispatchLineDto {
  @IsInt() itemId!: number;
  @IsInt() @Min(1) qty!: number;
}

export class ReceiveLineDto {
  @IsInt() itemId!: number;
  @IsInt() @Min(1) qty!: number;
}

export class LinesDto {
  @IsArray() @ValidateNested({ each: true })
  @Type(() => DispatchLineDto)
  lines!: DispatchLineDto[];
}

@Controller('transfers')
export class TransfersController {
  constructor(private readonly svc: TransfersService) {}

  @Get()
  @RequirePermission('transfers.read')
  list(@CurrentAuth() ctx: AuthContext, @Query('status') status?: string) {
    return this.svc.list(ctx, { status });
  }

  @Get(':id')
  @RequirePermission('transfers.read')
  getOne(@Param('id', ParseIntPipe) id: number, @CurrentAuth() ctx: AuthContext) {
    return this.svc.getOne(ctx, id);
  }

  @Post()
  @RequirePermission('transfers.create')
  create(@Body() dto: CreateTransferDto, @CurrentAuth() ctx: AuthContext) {
    return this.svc.create(ctx, dto);
  }

  @Post(':id/submit')
  @RequirePermission('transfers.create')
  submit(@Param('id', ParseIntPipe) id: number, @CurrentAuth() ctx: AuthContext) {
    return this.svc.submit(ctx, id);
  }

  @Post(':id/approve')
  @RequirePermission('transfers.approve')
  approve(@Param('id', ParseIntPipe) id: number, @CurrentAuth() ctx: AuthContext) {
    return this.svc.approve(ctx, id);
  }

  @Post(':id/dispatch')
  @RequirePermission('transfers.dispatch')
  dispatch(@Param('id', ParseIntPipe) id: number, @Body() dto: LinesDto, @CurrentAuth() ctx: AuthContext) {
    return this.svc.dispatch(ctx, id, dto.lines);
  }

  @Post(':id/receive')
  @RequirePermission('transfers.receive')
  receive(@Param('id', ParseIntPipe) id: number, @Body() dto: LinesDto, @CurrentAuth() ctx: AuthContext) {
    return this.svc.receive(ctx, id, dto.lines as never[]);
  }

  @Post(':id/cancel')
  @RequirePermission('transfers.cancel')
  cancel(@Param('id', ParseIntPipe) id: number, @Body('reason') reason: string, @CurrentAuth() ctx: AuthContext) {
    return this.svc.cancel(ctx, id, String(reason || ''));
  }
}

@Module({
  controllers: [TransfersController],
  providers: [TransfersService],
})
export class TransfersModule {}
