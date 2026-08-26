import {
  Body, Controller, Get, Injectable, Module, Param, ParseIntPipe, Patch, Post, Query,
} from '@nestjs/common';
import { IsIn, IsOptional, IsString } from 'class-validator';
import { DataSource } from 'typeorm';
import { ConflictException, NotFoundException } from '@nestjs/common';
import { Supplier } from '../../database/entities';
import { RequirePermission, CurrentAuth, AuthContext } from '../../common/auth-context';

@Injectable()
export class SuppliersService {
  constructor(private readonly ds: DataSource) {}

  async list(ctx: AuthContext, opts: { search?: string; status?: string }) {
    const o = ctx.organizationId;
    const params: unknown[] = [o];
    let where = `WHERE s.organization_id=$1`;
    if (opts.search) {
      params.push(`%${opts.search}%`);
      where += ` AND (s.name ILIKE $2 OR s.phone ILIKE $2)`;
    }
    if (opts.status) {
      params.push(opts.status);
      where += ` AND s.status=$${params.length}`;
    }
    return this.ds.query(
      `SELECT s.*,
        (SELECT COUNT(*)::int FROM purchase_orders po WHERE po.supplier_id=s.id AND po.status NOT IN ('draft','cancelled') AND po.organization_id=$1) AS "poCount",
        (SELECT COALESCE(ROUND(SUM(poi.qty*poi.unit_cost)::numeric,2)::double precision,0)
           FROM purchase_orders po JOIN purchase_order_items poi ON poi.po_id=po.id
           WHERE po.supplier_id=s.id AND po.status NOT IN ('draft','cancelled') AND po.organization_id=$1) AS "purchasedValue"
       FROM suppliers s ${where} ORDER BY s.name`,
      params,
    );
  }

  async create(ctx: AuthContext, input: Partial<Supplier> & { name: string }): Promise<Record<string, unknown>> {
    const rows = await this.ds.query(
      `INSERT INTO suppliers (name, phone, email, address, notes, organization_id)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
      [input.name.trim(), input.phone || '', input.email || '', input.address || '', input.notes || '', ctx.organizationId],
    );
    return rows[0];
  }

  async update(ctx: AuthContext, id: number, input: Record<string, string | undefined>): Promise<Record<string, unknown>> {
    const o = ctx.organizationId;
    const cur = await this.ds.query(`SELECT * FROM suppliers WHERE id=$1 AND organization_id=$2`, [id, o]);
    if (!cur[0]) throw new NotFoundException({ message: 'المورّد غير موجود', code: 'NOT_FOUND' });
    const rows = await this.ds.query(
      `UPDATE suppliers SET name=COALESCE($2,name), phone=COALESCE($3,phone), email=COALESCE($4,email),
              address=COALESCE($5,address), notes=COALESCE($6,notes), updated_at=now()
       WHERE id=$1 AND organization_id=$7 RETURNING *`,
      [id, input.name?.trim() ?? null, input.phone ?? null, input.email ?? null,
       input.address ?? null, input.notes ?? null, o],
    );
    return rows[0];
  }

  async setStatus(ctx: AuthContext, id: number, status: 'active' | 'disabled'): Promise<Record<string, unknown>> {
    await this.update(ctx, id, {});
    const rows = await this.ds.query(
      `UPDATE suppliers SET status=$2, updated_at=now() WHERE id=$1 AND organization_id=$3 RETURNING *`,
      [id, status, ctx.organizationId],
    );
    return rows[0];
  }
}

export class SupplierDto {
  @IsString() name!: string;
  @IsOptional() @IsString() phone?: string;
  @IsOptional() @IsString() email?: string;
  @IsOptional() @IsString() address?: string;
  @IsOptional() @IsString() notes?: string;
}

@Controller('suppliers')
export class SuppliersController {
  constructor(private readonly svc: SuppliersService) {}

  @Get()
  @RequirePermission('suppliers.read')
  list(@CurrentAuth() ctx: AuthContext, @Query('search') search?: string, @Query('status') status?: string) {
    return this.svc.list(ctx, { search, status });
  }

  @Post()
  @RequirePermission('suppliers.manage')
  create(@CurrentAuth() ctx: AuthContext, @Body() dto: SupplierDto) {
    return this.svc.create(ctx, dto);
  }

  @Patch(':id')
  @RequirePermission('suppliers.manage')
  update(@CurrentAuth() ctx: AuthContext, @Param('id', ParseIntPipe) id: number, @Body() dto: SupplierDto) {
    return this.svc.update(ctx, id, dto as never);
  }

  @Patch(':id/status/:status')
  @RequirePermission('suppliers.manage')
  setStatus(
    @CurrentAuth() ctx: AuthContext,
    @Param('id', ParseIntPipe) id: number,
    @Param('status') status: 'active' | 'disabled',
  ) {
    return this.svc.setStatus(ctx, id, status);
  }
}

@Module({
  controllers: [SuppliersController],
  providers: [SuppliersService],
})
export class SuppliersModule {}
