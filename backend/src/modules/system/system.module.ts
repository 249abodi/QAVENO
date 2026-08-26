import {
  Body, Controller, Get, Injectable, Module, Param, Patch, Query,
} from '@nestjs/common';
import { IsString } from 'class-validator';
import { DataSource } from 'typeorm';
import { CurrentAuth, AuthContext, Public, RequirePermission } from '../../common/auth-context';

@Injectable()
export class SystemService {
  constructor(private readonly ds: DataSource) {}

  async auditPaged(ctx: AuthContext, q: { action?: string; page?: number; pageSize?: number }) {
    const em = this.ds.manager;
    const page = Math.max(1, Number(q.page || 1));
    const size = Math.min(200, Math.max(1, Number(q.pageSize || 50)));
    const params: unknown[] = [ctx.organizationId];
    let where = `WHERE a.organization_id=$1`;
    if (q.action) {
      params.push(`%${q.action}%`);
      where += ` AND a.action ILIKE $${params.length}`;
    }
    const total = await em.query(`SELECT COUNT(*)::int AS c FROM audit_log a ${where}`, params);
    params.push(size, (page - 1) * size);
    const rows = await em.query(
      `SELECT a.id, a.action, a.entity_type AS "entityType", a.entity_id AS "entityId",
              a.details, a.created_at AS "createdAt", u.username AS "actorName"
       FROM audit_log a LEFT JOIN users u ON u.id=a.actor_id
       ${where} ORDER BY a.id DESC LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params,
    );
    return { rows, total: Number(total[0].c), page, pageSize: size };
  }

  async allSettings(ctx: AuthContext): Promise<Record<string, string>> {
    const o = ctx.organizationId;
    const globalRows = await this.ds.manager.query(`SELECT key, value FROM settings`);
    const orgRows = await this.ds.manager.query(
      `SELECT key, value FROM org_settings WHERE organization_id=$1`, [o],
    );
    const map = Object.fromEntries(globalRows.map((r: any) => [r.key, r.value]));
    for (const r of orgRows) map[r.key] = r.value;
    return map;
  }

  async setSetting(ctx: AuthContext, key: string, value: string): Promise<void> {
    const o = ctx.organizationId;
    await this.ds.manager.query(
      `INSERT INTO org_settings (organization_id, key, value) VALUES ($1,$2,$3)
       ON CONFLICT (organization_id, key) DO UPDATE SET value=$3`,
      [o, key, value],
    );
  }

  async health(): Promise<{ status: string; db: string; time: string }> {
    let db = 'up';
    try {
      await this.ds.manager.query('SELECT 1');
    } catch {
      db = 'down';
    }
    return { status: db === 'up' ? 'ok' : 'degraded', db, time: new Date().toISOString() };
  }
}

export class SetSettingDto {
  @IsString() value!: string;
}

@Controller()
export class SystemController {
  constructor(private readonly svc: SystemService) {}

  @Public()
  @Get('health')
  health() {
    return this.svc.health();
  }

  @Get('settings')
  @RequirePermission('settings.read')
  getSettings(@CurrentAuth() ctx: AuthContext) {
    return this.svc.allSettings(ctx);
  }

  @Patch('settings/:key')
  @RequirePermission('settings.manage')
  setSetting(@Param('key') key: string, @Body() dto: SetSettingDto, @CurrentAuth() ctx: AuthContext) {
    return this.svc.setSetting(ctx, key, dto.value).then(() => ({ ok: true }));
  }

  @Get('audit')
  @RequirePermission('audit.read')
  audit(
    @CurrentAuth() ctx: AuthContext,
    @Query('action') action?: string,
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
  ) {
    return this.svc.auditPaged(ctx, { action, page: Number(page), pageSize: Number(pageSize) });
  }
}

@Module({
  controllers: [SystemController],
  providers: [SystemService],
})
export class SystemModule {}
