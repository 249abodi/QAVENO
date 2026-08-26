import { Body, Controller, Get, Injectable, Module, Param, ParseIntPipe, Patch, Post } from '@nestjs/common';
import { IsIn, IsOptional, IsString, MaxLength } from 'class-validator';
import { DataSource } from 'typeorm';
import { ConflictException } from '@nestjs/common';
import { Category } from '../../database/entities';
import { CurrentAuth, AuthContext, RequirePermission } from '../../common/auth-context';

@Injectable()
export class CategoriesService {
  constructor(private readonly ds: DataSource) {}

  async list(ctx: AuthContext) {
    const cats = await this.ds.query(
      `SELECT c.*, (SELECT COUNT(*)::int FROM products p WHERE p.category_id=c.id AND p.organization_id=$1) AS "productCount"
       FROM categories c WHERE c.organization_id=$1 ORDER BY c.name`,
      [ctx.organizationId],
    );
    return cats;
  }

  async create(ctx: AuthContext, input: { name: string; color?: string }): Promise<Category> {
    const o = ctx.organizationId;
    const dup = await this.ds.query(`SELECT id FROM categories WHERE lower(name)=lower($1) AND organization_id=$2`, [input.name.trim(), o]);
    if (dup[0]) throw new ConflictException({ message: 'التصنيف موجود مسبقاً', code: 'DUPLICATE_NAME' });
    const rows = await this.ds.query(
      `INSERT INTO categories (name, color, organization_id) VALUES ($1,$2,$3) RETURNING *`,
      [input.name.trim(), input.color || '#2563eb', o],
    );
    return rows[0];
  }

  async update(ctx: AuthContext, id: number, input: { name?: string; color?: string }): Promise<Record<string, unknown>> {
    const o = ctx.organizationId;
    const cur = await this.ds.query(`SELECT * FROM categories WHERE id=$1 AND organization_id=$2`, [id, o]);
    if (!cur[0]) throw new ConflictException({ message: 'التصنيف غير موجود', code: 'NOT_FOUND' });
    if (input.name) {
      const dup = await this.ds.query(
        `SELECT id FROM categories WHERE lower(name)=lower($1) AND id<>$2 AND organization_id=$3`,
        [input.name.trim(), id, o],
      );
      if (dup[0]) throw new ConflictException({ message: 'التصنيف موجود مسبقاً', code: 'DUPLICATE_NAME' });
    }
    const rows = await this.ds.query(
      `UPDATE categories SET name=COALESCE($2,name), color=COALESCE($3,color) WHERE id=$1 AND organization_id=$4 RETURNING *`,
      [id, input.name?.trim() ?? null, input.color ?? null, o],
    );
    if (input.name && input.name.trim() !== cur[0].name) {
      await this.ds.query(`UPDATE products SET category=$2 WHERE category_id=$1 AND organization_id=$3`, [id, input.name.trim(), o]);
    }
    return rows[0];
  }

  async remove(ctx: AuthContext, id: number): Promise<{ ok: true }> {
    const o = ctx.organizationId;
    const used = await this.ds.query(`SELECT COUNT(*)::int AS c FROM products WHERE category_id=$1 AND organization_id=$2`, [id, o]);
    if (Number(used[0].c) > 0) {
      throw new ConflictException({ message: 'لا يمكن حذف تصنيف مرتبط بمنتجات', code: 'IN_USE' });
    }
    await this.ds.query(`DELETE FROM categories WHERE id=$1 AND organization_id=$2`, [id, o]);
    return { ok: true };
  }
}

export class CategoryDto {
  @IsString() @MaxLength(80) name!: string;
  @IsOptional() @IsString() @MaxLength(20) color?: string;
}

export class CategoryUpdateDto {
  @IsOptional() @IsString() @MaxLength(80) name?: string;
  @IsOptional() @IsString() @MaxLength(20) color?: string;
}

@Controller('categories')
export class CategoriesController {
  constructor(private readonly svc: CategoriesService) {}

  @Get()
  list(@CurrentAuth() ctx: AuthContext) {
    return this.svc.list(ctx);
  }

  @Post()
  @RequirePermission('categories.manage')
  create(@CurrentAuth() ctx: AuthContext, @Body() dto: CategoryDto) {
    return this.svc.create(ctx, dto);
  }

  @Patch(':id')
  @RequirePermission('categories.manage')
  update(@CurrentAuth() ctx: AuthContext, @Param('id', ParseIntPipe) id: number, @Body() dto: CategoryUpdateDto) {
    return this.svc.update(ctx, id, dto);
  }
}

@Module({
  controllers: [CategoriesController],
  providers: [CategoriesService],
})
export class CategoriesModule {}
