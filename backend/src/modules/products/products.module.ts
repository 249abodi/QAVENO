import {
  Body, Controller, Delete, Get, Injectable, Module, Param, ParseIntPipe, Patch, Post, Query,
} from '@nestjs/common';
import { IsInt, IsNumber, IsOptional, IsString, MaxLength, Min } from 'class-validator';
import { DataSource } from 'typeorm';
import { ConflictException, NotFoundException } from '@nestjs/common';
import { Product } from '../../database/entities';
import { CurrentAuth, AuthContext, RequirePermission } from '../../common/auth-context';

@Injectable()
export class ProductsService {
  constructor(private readonly ds: DataSource) {}

  async list(
    ctx: AuthContext,
    opts: { search?: string; lowOnly?: boolean },
  ): Promise<Record<string, unknown>[]> {
    const o = ctx.organizationId;
    const params: unknown[] = [ctx.branchId, o];
    let where = `WHERE p.organization_id=$2`;
    if (opts.search) {
      params.push(`%${opts.search}%`);
      where += ` AND (p.name ILIKE $${params.length} OR COALESCE(p.barcode,'') ILIKE $${params.length})`;
    }
    const rows = await this.ds.query(
      `SELECT p.id, p.name, p.barcode, p.price, p.cost,
              CASE WHEN $1 = (SELECT MIN(b2.id) FROM branches b2 WHERE b2.organization_id=$2)
                   THEN p.quantity
                   ELSE COALESCE(bi.quantity, 0) END AS quantity,
              CASE WHEN $1 = (SELECT MIN(b2.id) FROM branches b2 WHERE b2.organization_id=$2)
                   THEN p.low_stock_threshold
                   ELSE COALESCE(bi.low_stock_threshold, p.low_stock_threshold) END AS low_stock_threshold,
              p.reorder_qty, p.category_id, c.name AS category_name, p.version, p.created_at
       FROM products p
       LEFT JOIN categories c ON c.id=p.category_id AND c.organization_id=$2
       LEFT JOIN branch_inventory bi ON bi.product_id=p.id AND bi.branch_id=$1
       ${where}
       ORDER BY p.name`,
      params,
    );
    return opts.lowOnly ? rows.filter((r) => Number(r.quantity) <= Number(r.low_stock_threshold)) : rows;
  }

  async get(ctx: AuthContext, id: number): Promise<Record<string, unknown>> {
    const rows = await this.list(ctx, {});
    const row = rows.find((r) => Number(r['id']) === id);
    if (!row) throw new NotFoundException({ message: 'المنتج غير موجود', code: 'NOT_FOUND' });
    return row;
  }

  private async assertBarcodeFree(barcode: string | null | undefined, orgId: number, excludeId?: number) {
    if (!barcode) return;
    const rows = excludeId
      ? await this.ds.query(`SELECT id FROM products WHERE barcode=$1 AND id<>$2 AND organization_id=$3`, [barcode, excludeId, orgId])
      : await this.ds.query(`SELECT id FROM products WHERE barcode=$1 AND organization_id=$2`, [barcode, orgId]);
    if (rows[0]) throw new ConflictException({ message: 'الباركود مستخدم مسبقاً', code: 'DUPLICATE_BARCODE' });
  }

  async create(input: {
    name: string;
    barcode?: string | null;
    price: number;
    cost?: number;
    lowStockThreshold?: number;
    reorderQty?: number;
    categoryId?: number | null;
    categoryName?: string | null;
    actorId: number;
    organizationId: number;
  }): Promise<Record<string, unknown>> {
    const o = input.organizationId;
    await this.assertBarcodeFree(input.barcode || null, o);
    let categoryId = input.categoryId ?? null;
    let categoryName = input.categoryName?.trim() || '';
    if (categoryId == null && categoryName) {
      const cat = await this.ds.query(`SELECT id FROM categories WHERE lower(name)=lower($1) AND organization_id=$2`, [categoryName, o]);
      if (cat[0]) categoryId = Number(cat[0].id);
    }
    if (categoryId != null) {
      const cat = await this.ds.query(`SELECT name FROM categories WHERE id=$1 AND organization_id=$2`, [categoryId, o]);
      if (!cat[0]) throw new ConflictException({ message: 'التصنيف غير موجود', code: 'NOT_FOUND' });
      categoryName = cat[0].name;
    }
    const rows = await this.ds.query(
      `INSERT INTO products (name, barcode, price, cost, low_stock_threshold, reorder_qty, category, category_id, organization_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
      [
        input.name.trim(),
        input.barcode?.trim() || null,
        Number(input.price),
        Number(input.cost ?? 0),
        Math.max(0, Math.trunc(Number(input.lowStockThreshold ?? 5))),
        Math.max(0, Math.trunc(Number(input.reorderQty ?? 0))),
        categoryName,
        categoryId,
        o,
      ],
    );
    await this.ds.query(
      `INSERT INTO audit_log (actor_id, action, entity_type, entity_id, details, organization_id)
       VALUES ($1,'product.create','product',$2,$3,$4)`,
      [input.actorId, rows[0].id, JSON.stringify({ name: rows[0].name }), o],
    );
    await this.ds.query(
      `INSERT INTO branch_inventory (branch_id, product_id, quantity, cost, low_stock_threshold, reorder_qty)
       SELECT MIN(b.id), $1, 0, $2, $3, $4 FROM branches b WHERE b.organization_id=$5
       ON CONFLICT (branch_id, product_id) DO NOTHING`,
      [
        rows[0].id,
        Number(input.cost ?? 0),
        Math.max(0, Math.trunc(Number(input.lowStockThreshold ?? 5))),
        Math.max(0, Math.trunc(Number(input.reorderQty ?? 0))),
        o,
      ],
    );
    return rows[0];
  }

  async update(
    ctx: AuthContext,
    id: number,
    input: {
      name?: string;
      barcode?: string | null;
      price?: number;
      cost?: number;
      lowStockThreshold?: number;
      reorderQty?: number;
      categoryId?: number | null;
      categoryName?: string | null;
      actorId: number;
    },
  ): Promise<Record<string, unknown>> {
    const o = ctx.organizationId;
    const cur = await this.ds.query(`SELECT * FROM products WHERE id=$1 AND organization_id=$2`, [id, o]);
    if (!cur[0]) throw new NotFoundException({ message: 'المنتج غير موجود', code: 'NOT_FOUND' });
    await this.assertBarcodeFree(input.barcode ?? cur[0].barcode, o, id);
    let categoryId = input.categoryId === undefined ? cur[0].category_id : input.categoryId;
    let categoryName: string = cur[0].category || '';
    if (input.categoryName !== undefined && input.categoryName !== null) {
      categoryName = input.categoryName.trim();
      if (categoryId == null && categoryName) {
        const cat = await this.ds.query(`SELECT id FROM categories WHERE lower(name)=lower($1) AND organization_id=$2`, [categoryName, o]);
        if (cat[0]) categoryId = Number(cat[0].id);
      }
    }
    if (categoryId != null) {
      const cat = await this.ds.query(`SELECT name FROM categories WHERE id=$1 AND organization_id=$2`, [categoryId, o]);
      if (!cat[0]) throw new ConflictException({ message: 'التصنيف غير موجود', code: 'NOT_FOUND' });
      categoryName = cat[0].name;
    }
    const rows = await this.ds.query(
      `UPDATE products SET
         name=COALESCE($2,name), barcode=CASE WHEN $3::boolean THEN $4 ELSE barcode END,
         price=COALESCE($5,price), cost=COALESCE($6,cost),
         low_stock_threshold=COALESCE($7,low_stock_threshold), reorder_qty=COALESCE($8,reorder_qty),
         category=$9, category_id=$10, version=version+1, updated_at=now()
       WHERE id=$1 AND organization_id=$11 RETURNING *`,
      [
        id,
        input.name?.trim() ?? null,
        input.barcode !== undefined,
        input.barcode === null ? null : (input.barcode?.trim() ?? null),
        input.price != null ? Number(input.price) : null,
        input.cost != null ? Number(input.cost) : null,
        input.lowStockThreshold != null ? Math.max(0, Math.trunc(Number(input.lowStockThreshold))) : null,
        input.reorderQty != null ? Math.max(0, Math.trunc(Number(input.reorderQty))) : null,
        categoryName,
        categoryId,
        o,
      ],
    );
    await this.ds.query(
      `INSERT INTO audit_log (actor_id, action, entity_type, entity_id, details, organization_id)
       VALUES ($1,'product.update','product',$2,$3,$4)`,
      [input.actorId, id, JSON.stringify({ name: rows[0].name }), o],
    );
    return rows[0];
  }

  async remove(ctx: AuthContext, id: number): Promise<{ ok: true }> {
    const o = ctx.organizationId;
    const refs = await this.ds.query(
      `SELECT
         (SELECT COUNT(*)::int FROM sale_items si WHERE si.product_id=$1) AS sales,
         (SELECT COUNT(*)::int FROM purchase_order_items poi WHERE poi.product_id=$1) AS poItems,
         (SELECT COUNT(*)::int FROM inventory_movements m WHERE m.product_id=$1) AS movements`,
      [id],
    );
    const r = refs[0];
    if (r.sales > 0 || r.poItems > 0 || r.movements > 0) {
      throw new ConflictException({ message: 'لا يمكن حذف منتج مرتبط بحركات أو فواتير', code: 'IN_USE' });
    }
    await this.ds.query(`DELETE FROM branch_inventory WHERE product_id=$1`, [id]);
    await this.ds.query(`DELETE FROM products WHERE id=$1 AND organization_id=$2`, [id, o]);
    return { ok: true };
  }
}

export class CreateProductDto {
  @IsString() @MaxLength(200) name!: string;
  @IsOptional() @IsString() @MaxLength(64) barcode?: string | null;
  @IsNumber() @Min(0) price!: number;
  @IsOptional() @IsNumber() @Min(0) cost?: number;
  @IsOptional() @IsInt() @Min(0) lowStockThreshold?: number;
  @IsOptional() @IsInt() @Min(0) reorderQty?: number;
  @IsOptional() categoryId?: number | null;
  @IsOptional() @IsString() categoryName?: string | null;
}

export class UpdateProductDto extends CreateProductDto {
  declare name: string | undefined;
}

@Controller('products')
export class ProductsController {
  constructor(private readonly svc: ProductsService) {}

  @Get()
  @RequirePermission('products.read')
  list(
    @CurrentAuth() ctx: AuthContext,
    @Query('search') search?: string,
    @Query('low') lowOnly?: string,
  ) {
    return this.svc.list(ctx, { search, lowOnly: lowOnly === '1' });
  }

  @Get(':id')
  @RequirePermission('products.read')
  get(@Param('id', ParseIntPipe) id: number, @CurrentAuth() ctx: AuthContext) {
    return this.svc.get(ctx, id);
  }

  @Post()
  @RequirePermission('products.create')
  create(@Body() dto: CreateProductDto, @CurrentAuth() ctx: AuthContext) {
    return this.svc.create({ ...dto, actorId: ctx.userId, organizationId: ctx.organizationId });
  }

  @Patch(':id')
  @RequirePermission('products.update')
  update(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: UpdateProductDto,
    @CurrentAuth() ctx: AuthContext,
  ) {
    return this.svc.update(ctx, id, { ...dto, actorId: ctx.userId });
  }

  @Delete(':id')
  @RequirePermission('products.delete')
  remove(@Param('id', ParseIntPipe) id: number, @CurrentAuth() ctx: AuthContext) {
    return this.svc.remove(ctx, id);
  }
}

@Module({
  controllers: [ProductsController],
  providers: [ProductsService],
})
export class ProductsModule {}
