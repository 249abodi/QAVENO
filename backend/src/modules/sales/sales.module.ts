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
import { IsArray, IsInt, IsNumber, IsOptional, IsString, Min, ValidateNested } from 'class-validator';
import { Type } from 'class-transformer';
import { CurrentAuth, AuthContext, RequirePermission } from '../../common/auth-context';
import { DomainSupport } from '../../common/domain-support';
import { EVENTS, EventsGateway } from '../../events/events.module';

function round2(n: number): number {
  return Math.round((Number(n) || 0) * 100) / 100;
}

@Injectable()
export class SalesService {
  constructor(private readonly support: DomainSupport, private readonly events: EventsGateway) {}

  async checkout(ctx: AuthContext, input: CheckoutDto) {
    const branchId = ctx.branchId;
    const organizationId = ctx.organizationId;
    const result = await this.support.ds.transaction(async (tx) => {
      const items = [...input.items].sort((a, b) => a.productId - b.productId);
      const taxRows = await tx.query(`SELECT value FROM settings WHERE key='tax_rate'`);
      const taxRate = Math.max(0, Number(taxRows[0]?.value ?? 0));

      const plans: {
        productId: number;
        name: string;
        qty: number;
        price: number;
        cost: number;
        available: number;
      }[] = [];
      for (const it of items) {
        const qty = Math.trunc(it.quantity);
        if (qty <= 0) {
          throw new BadRequestException({ message: 'الكمية يجب أن تكون أكبر من صفر', code: 'INVALID_QTY' });
        }
        const prod = await tx.query(
          `SELECT id, name, price FROM products WHERE id=$1 AND organization_id=$2`,
          [it.productId, organizationId],
        );
        if (!prod[0]) {
          throw new NotFoundException({ message: `المنتج ${it.productId} غير موجود`, code: 'NOT_FOUND' });
        }
        const row = await this.support.ensureBranchRowTx(tx, branchId, it.productId, organizationId);
        if (row.quantity < qty) {
          throw new ConflictException({
            message: `الكمية غير كافية للمنتج «${prod[0].name}» (المتاح ${row.quantity})`,
            code: 'INSUFFICIENT_STOCK',
          });
        }
        plans.push({
          productId: it.productId,
          name: prod[0].name,
          qty,
          price: Number(prod[0].price),
          cost: row.cost,
          available: row.quantity,
        });
      }

      const discount = round2(Math.max(0, Number(input.discount ?? 0)));
      let subtotal = 0;
      let taxTotal = 0;
      const lines = plans.map((p) => {
        const lineSubtotal = round2(p.qty * p.price);
        const lineTax = round2((lineSubtotal * taxRate) / 100);
        subtotal += lineSubtotal;
        taxTotal += lineTax;
        return { ...p, lineSubtotal, lineTax, lineTotal: round2(lineSubtotal + lineTax) };
      });
      subtotal = round2(subtotal);
      taxTotal = round2(taxTotal);
      const total = round2(subtotal + taxTotal - discount);
      const paid = round2(Number(input.paid ?? total));
      if (paid < total) {
        throw new BadRequestException({ message: 'المبلغ المدفوع أقل من الإجمالي', code: 'INSUFFICIENT_PAYMENT' });
      }
      const changeAmount = round2(paid - total);

      let seqN: number;
      const orgSeqRows = await tx.query(
        `SELECT value FROM org_settings WHERE organization_id=$1 AND key='invoice_seq' FOR UPDATE`,
        [organizationId],
      );
      if (orgSeqRows[0]) {
        seqN = Number(orgSeqRows[0].value) + 1;
        await tx.query(
          `INSERT INTO org_settings (organization_id, key, value) VALUES ($1,'invoice_seq',$2)
           ON CONFLICT (organization_id, key) DO UPDATE SET value=$2`,
          [organizationId, String(seqN)],
        );
      } else {
        const globalSeqRows = await tx.query(
          `SELECT value FROM settings WHERE key='invoice_seq' FOR UPDATE`,
        );
        seqN = Number(globalSeqRows[0]?.value || 0) + 1;
        await tx.query(
          `INSERT INTO org_settings (organization_id, key, value) VALUES ($1,'invoice_seq',$2)
           ON CONFLICT (organization_id, key) DO UPDATE SET value=$2`,
          [organizationId, String(seqN)],
        );
      }
      const invoiceNo = `INV-${String(seqN).padStart(4, '0')}`;

      const saleRows = await tx.query(
        `INSERT INTO sales (invoice_no, subtotal, tax_total, discount, total, paid, change_amount, payment_method, branch_id, organization_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id`,
        [invoiceNo, subtotal, taxTotal, discount, total, paid, changeAmount, input.paymentMethod || 'cash', branchId, organizationId],
      );
      const saleId = Number(saleRows[0].id);

      for (const ln of lines) {
        const newQty = ln.available - ln.qty;
        await tx.query(
          `UPDATE branch_inventory SET quantity=$3, updated_at=now() WHERE branch_id=$1 AND product_id=$2`,
          [branchId, ln.productId, newQty],
        );
        const isDefault = await this.support.isDefaultBranchTx(tx, branchId, organizationId);
        if (isDefault) {
          await tx.query(`UPDATE products SET quantity=$2, updated_at=now() WHERE id=$1`, [ln.productId, newQty]);
        }
        await this.support.insMovement(tx, {
          productId: ln.productId,
          change: -ln.qty,
          reason: 'sale',
          reasonCode: 'SALE',
          refType: 'sale',
          refId: saleId,
          balanceAfter: newQty,
          actorId: ctx.userId,
          note: invoiceNo,
          branchId,
          organizationId,
        });
        await tx.query(
          `INSERT INTO sale_items (sale_id, product_id, product_name, quantity, unit_price, unit_cost,
                                   tax_rate, line_subtotal, line_tax, line_total)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
          [saleId, ln.productId, ln.name, ln.qty, ln.price, ln.cost, taxRate,
           ln.lineSubtotal, ln.lineTax, ln.lineTotal],
        );
      }

      return { id: saleId, invoiceNo, subtotal, taxTotal, discount, total, paid, changeAmount };
    });
    this.events.emitBranch(branchId, EVENTS.SALE_CREATED, {
      saleId: result.id,
      invoiceNo: result.invoiceNo,
      total: result.total,
      branchId,
    });
    return result;
  }

  async list(ctx: AuthContext, q: { page?: number; pageSize?: number }) {
    const em = this.support.ds.manager;
    const page = Math.max(1, Number(q.page || 1));
    const size = Math.min(200, Math.max(1, Number(q.pageSize || 50)));
    const params: unknown[] = [];
    let where = `WHERE 1=1`;
    params.push(ctx.organizationId);
    where += ` AND s.organization_id=$${params.length}`;
    params.push(ctx.branchId);
    where += ` AND s.branch_id=$${params.length}`;
    const total = await em.query(`SELECT COUNT(*)::int AS c FROM sales s ${where}`, params);
    params.push(size, (page - 1) * size);
    const rows = await em.query(
      `SELECT s.*, b.name AS "branchName",
              (SELECT COUNT(*)::int FROM sale_items si WHERE si.sale_id=s.id) AS "lineCount"
       FROM sales s LEFT JOIN branches b ON b.id=s.branch_id
       ${where} ORDER BY s.id DESC LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params,
    );
    return { rows, total: Number(total[0].c), page, pageSize: size };
  }

  async getOne(ctx: AuthContext, id: number) {
    const em = this.support.ds.manager;
    const head = await em.query(
      `SELECT * FROM sales WHERE id=$1 AND organization_id=$2`,
      [id, ctx.organizationId],
    );
    if (!head[0]) throw new NotFoundException({ message: 'الفاتورة غير موجودة', code: 'NOT_FOUND' });
    if (!ctx.spansAll && !ctx.accessibleBranchIds.includes(Number(head[0].branch_id))) {
      throw new ConflictException({ message: 'ليس لديك صلاحية على هذا الفرع', code: 'NO_BRANCH_ACCESS' });
    }
    const items = await em.query(
      `SELECT si.*, p.barcode FROM sale_items si
       LEFT JOIN products p ON p.id=si.product_id WHERE si.sale_id=$1 ORDER BY si.id`,
      [id],
    );
    return { ...head[0], items };
  }
}

export class CheckoutItemDto {
  @IsInt() productId!: number;
  @IsInt() @Min(1) quantity!: number;
}

export class CheckoutDto {
  @IsArray() @ValidateNested({ each: true })
  @Type(() => CheckoutItemDto)
  items!: CheckoutItemDto[];
  @IsOptional() @IsNumber() discount?: number;
  @IsOptional() @IsNumber() paid?: number;
  @IsOptional() @IsString() paymentMethod?: string;
}

@Controller('sales')
export class SalesController {
  constructor(private readonly svc: SalesService) {}

  @Post('checkout')
  @RequirePermission('sales.create')
  checkout(@Body() dto: CheckoutDto, @CurrentAuth() ctx: AuthContext) {
    return this.svc.checkout(ctx, dto);
  }

  @Get()
  @RequirePermission('sales.read')
  list(
    @CurrentAuth() ctx: AuthContext,
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
  ) {
    return this.svc.list(ctx, { page: Number(page), pageSize: Number(pageSize) });
  }

  @Get(':id')
  @RequirePermission('sales.read')
  getOne(@Param('id', ParseIntPipe) id: number, @CurrentAuth() ctx: AuthContext) {
    return this.svc.getOne(ctx, id);
  }
}

@Module({
  controllers: [SalesController],
  providers: [SalesService],
})
export class SalesModule {}
