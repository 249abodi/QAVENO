import {
  Body,
  Controller,
  ConflictException,
  ForbiddenException,
  Get,
  Injectable,
  Module,
  NotFoundException,
  Param,
  Post,
  Query,
} from '@nestjs/common';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsIn,
  IsInt,
  IsObject,
  IsOptional,
  IsString,
  Length,
  Min,
  ValidateNested,
} from 'class-validator';
import { randomUUID } from 'node:crypto';
import { CurrentAuth, AuthContext, RequirePermission } from '../../common/auth-context';
import { DomainSupport } from '../../common/domain-support';
import { ROLE_PERMISSIONS } from '../../common/rbac.constants';

/** Operation types accepted by the sync endpoint and the permission each
 *  requires (mirrors the REST route that performs the same change).
 *  Deliberately metadata-only: inventory quantities, cost and financial
 *  records are server-authoritative and can never be mutated through sync. */
const OP_TYPES = ['product.update'] as const;
type OpType = (typeof OP_TYPES)[number];

const OP_PERMISSION: Record<OpType, string> = {
  'product.update': 'products.update',
};

/** Fields that belong to other authoritative domains. Their presence in a
 *  synced payload is converted into an auditable permanent rejection. */
const IMMUTABLE_FIELDS = ['quantity', 'cost', 'stock'] as const;

export class SyncOpDto {
  @IsString() @Length(8, 64)
  opId!: string;

  @IsIn(OP_TYPES as unknown as string[])
  type!: OpType;

  @IsObject()
  payload!: Record<string, unknown>;
}

export class PushDto {
  @IsOptional() @IsString() @Length(1, 64)
  deviceId?: string;

  @IsArray() @ArrayMinSize(1) @ArrayMaxSize(100)
  @ValidateNested({ each: true }) @Type(() => SyncOpDto)
  ops!: SyncOpDto[];
}

export class ResolveDto {
  @IsIn(['keep_server', 'apply_local'])
  resolution!: 'keep_server' | 'apply_local';
}

export interface TxLike {
  query: (sql: string, p?: unknown[]) => Promise<unknown>;
}

function rows(raw: unknown): unknown[] {
  // em.query may return [records, affected] for write statements
  if (Array.isArray(raw) && Array.isArray(raw[0])) return raw[0] as unknown[];
  return Array.isArray(raw) ? raw : [];
}

type ApplyOutcome =
  | { kind: 'applied' }
  | { kind: 'rejected'; code: string }
  | { kind: 'conflict'; conflictId: string; conflictType: string };

@Injectable()
export class SyncService {
  constructor(private readonly support: DomainSupport) {}

  private hasPerm(role: string, perm: string): boolean {
    return ((ROLE_PERMISSIONS as Record<string, string[]>)[role] || []).includes(perm);
  }

  /** Inserts an auditable conflict row. Never mutates the entity. */
  private async recordConflict(
    tx: TxLike,
    data: {
      opId: string;
      deviceId: string | null;
      actorId: number;
      entityType: string;
      entityId: number | null;
      localVersion: number | null;
      serverVersion: number | null;
      localPayload: Record<string, unknown>;
      serverSnapshot: Record<string, unknown> | null;
      conflictType: string;
      organizationId?: number | null;
    },
  ): Promise<string> {
    const conflictId = randomUUID();
    await tx.query(
      `INSERT INTO sync_conflicts
         (conflict_id, op_id, device_id, actor_id, entity_type, entity_id,
          local_version, server_version, local_payload, server_snapshot, conflict_type, organization_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10::jsonb,$11,$12)`,
      [
        conflictId, data.opId, data.deviceId, data.actorId,
        data.entityType, data.entityId, data.localVersion, data.serverVersion,
        JSON.stringify(data.localPayload),
        data.serverSnapshot ? JSON.stringify(data.serverSnapshot) : null,
        data.conflictType,
        data.organizationId ?? null,
      ],
    );
    return conflictId;
  }

  /** Version-aware, field-guarded application of one product.update.
   *  Returns applied / rejected(code) / conflict(conflictId). */
  private async applyProductUpdate(
    tx: TxLike,
    meta: { opId: string; deviceId: string | null; actorId: number; organizationId?: number | null },
    payload: Record<string, unknown>,
    opts: { enforceBaseVersion: boolean },
  ): Promise<ApplyOutcome> {
    const productId = Number(payload.productId);
    if (!Number.isInteger(productId) || productId <= 0) return { kind: 'rejected', code: 'BAD_PRODUCT_ID' };

    // Inventory/cost domains are server-authoritative: refuse loudly & auditably.
    const immutable = IMMUTABLE_FIELDS.filter((f) => payload[f] !== undefined);
    if (immutable.length) {
      const snapshot = rows(
        await tx.query(
          `SELECT id, name, quantity, cost FROM products WHERE id=$1 AND organization_id=$2`,
          [productId, meta.organizationId],
        ),
      )[0] as Record<string, unknown> | undefined;
      const conflictId = await this.recordConflict(tx, {
        opId: meta.opId, deviceId: meta.deviceId, actorId: meta.actorId,
        entityType: 'product', entityId: productId,
        localVersion: null,
        serverVersion: snapshot ? Number(snapshot.quantity) : null,
        localPayload: payload,
        serverSnapshot: snapshot ?? null,
        conflictType: 'IMMUTABLE_FIELDS',
        organizationId: meta.organizationId,
      });
      // immediately closed: there is nothing to resolve — the decision IS the
      // rejection; the row exists purely for audit/visibility
      await tx.query(
        `UPDATE sync_conflicts SET status='resolved', resolution='rejected_permanent',
           resolved_at=now() WHERE conflict_id=$1`,
        [conflictId],
      );
      return { kind: 'rejected', code: `IMMUTABLE_FIELD_${immutable.map((f) => f.toUpperCase()).join('_')}` };
    }

    const sets: string[] = [];
    const params: unknown[] = [productId];
    let touchesImportantField = false;
    if (payload.name !== undefined) {
      const name = String(payload.name).trim();
      if (!name) return { kind: 'rejected', code: 'BAD_NAME' };
      params.push(name);
      sets.push(`name=$${params.length}`);
    }
    if (payload.price !== undefined) {
      touchesImportantField = true;
      const price = Number(payload.price);
      if (!Number.isFinite(price) || price < 0) return { kind: 'rejected', code: 'BAD_PRICE' };
      params.push(price);
      sets.push(`price=$${params.length}`);
    }
    if (payload.lowStockThreshold !== undefined) {
      const v = Math.trunc(Number(payload.lowStockThreshold));
      if (!Number.isFinite(v) || v < 0) return { kind: 'rejected', code: 'BAD_THRESHOLD' };
      params.push(v);
      sets.push(`low_stock_threshold=$${params.length}`);
    }
    if (payload.reorderQty !== undefined) {
      const v = Math.trunc(Number(payload.reorderQty));
      if (!Number.isFinite(v) || v < 0) return { kind: 'rejected', code: 'BAD_REORDER' };
      params.push(v);
      sets.push(`reorder_qty=$${params.length}`);
    }
    if (!sets.length) return { kind: 'rejected', code: 'EMPTY_PAYLOAD' };

    // serialize on the row so concurrent pushes cannot interleave check+write
    const current = rows(
      await tx.query(
        `SELECT version FROM products WHERE id=$1 AND organization_id=$2 FOR UPDATE`,
        [productId, meta.organizationId],
      ),
    )[0] as { version?: number } | undefined;
    if (!current) return { kind: 'rejected', code: 'NOT_FOUND' };
    const serverVersion = Math.trunc(Number(current.version ?? 1));

    const baseRaw = payload.baseVersion;
    if (baseRaw !== undefined) {
      const baseVersion = Math.trunc(Number(baseRaw));
      if (!Number.isFinite(baseVersion)) return { kind: 'rejected', code: 'BAD_VERSION' };
      if (baseVersion > serverVersion) return { kind: 'rejected', code: 'BAD_VERSION' };
      if (baseVersion < serverVersion) {
        const conflictId = await this.recordConflict(tx, {
          opId: meta.opId, deviceId: meta.deviceId, actorId: meta.actorId,
          entityType: 'product', entityId: productId,
          localVersion: baseVersion, serverVersion,
          localPayload: payload,
          serverSnapshot: rows(
            await tx.query(
              `SELECT id, name, price, low_stock_threshold, reorder_qty, version FROM products WHERE id=$1 AND organization_id=$2`,
              [productId, meta.organizationId],
            ),
          )[0] as Record<string, unknown>,
          conflictType: 'STALE_VERSION',
          organizationId: meta.organizationId,
        });
        return { kind: 'conflict', conflictId, conflictType: 'STALE_VERSION' };
      }
    } else if (touchesImportantField && opts.enforceBaseVersion) {
      const conflictId = await this.recordConflict(tx, {
        opId: meta.opId, deviceId: meta.deviceId, actorId: meta.actorId,
        entityType: 'product', entityId: productId,
        localVersion: null, serverVersion,
        localPayload: payload,
        serverSnapshot: rows(
          await tx.query(
            `SELECT id, name, price, low_stock_threshold, reorder_qty, version FROM products WHERE id=$1 AND organization_id=$2`,
            [productId, meta.organizationId],
          ),
        )[0] as Record<string, unknown>,
        conflictType: 'MISSING_BASE_VERSION',
        organizationId: meta.organizationId,
      });
      return { kind: 'conflict', conflictId, conflictType: 'MISSING_BASE_VERSION' };
    }

    sets.push(`version = version + 1`);

    const orgIdx = params.length + 1;
    const updateParams = [...params, meta.organizationId];
    const updated = rows(
      await tx.query(
        `UPDATE products SET ${sets.join(', ')}, updated_at=now() WHERE id=$1 AND organization_id=$${orgIdx} RETURNING id`,
        updateParams,
      ),
    );
    return updated.length ? { kind: 'applied' } : { kind: 'rejected', code: 'NOT_FOUND' };
  }

  async push(ctx: AuthContext, dto: PushDto) {
    // per-operation authorization (route itself is auth-only)
    for (const op of dto.ops) {
      const needed = OP_PERMISSION[op.type];
      if (needed && !this.hasPerm(ctx.role, needed)) {
        throw new ConflictException({
          message: 'لا تملك صلاحية تنفيذ هذه العمليات',
          code: 'FORBIDDEN_OP_TYPE',
        });
      }
    }

    const results: {
      opId: string; status: string; code?: string; conflictId?: string; conflictType?: string;
    }[] = [];
    await this.support.ds.transaction(async (tx) => {
      for (const op of dto.ops) {
        // idempotency gate: replayed op_ids are never re-applied
        const claimed = rows(
          await tx.query(
            `INSERT INTO sync_operations (op_id, device_id, actor_id, op_type, payload, result_code, organization_id)
             VALUES ($1,$2,$3,$4,$5::jsonb,'pending',$6)
             ON CONFLICT (op_id) DO NOTHING
             RETURNING id`,
            [op.opId, dto.deviceId ?? null, ctx.userId, op.type, JSON.stringify(op.payload), ctx.organizationId],
          ),
        );
        if (!claimed.length) {
          results.push({ opId: op.opId, status: 'duplicate' });
          continue;
        }
        const meta = { opId: op.opId, deviceId: dto.deviceId ?? null, actorId: ctx.userId, organizationId: ctx.organizationId };
        let outcome: ApplyOutcome;
        try {
          outcome =
            op.type === 'product.update'
              ? await this.applyProductUpdate(tx, meta, op.payload, { enforceBaseVersion: true })
              : { kind: 'rejected', code: 'UNKNOWN_OP_TYPE' };
        } catch {
          outcome = { kind: 'rejected', code: 'APPLY_FAILED' };
        }
        let resultCode: string;
        if (outcome.kind === 'applied') resultCode = 'applied';
        else if (outcome.kind === 'rejected') resultCode = `rejected:${outcome.code}`;
        else resultCode = `conflict:${outcome.conflictType}:${outcome.conflictId}`;
        await tx.query(`UPDATE sync_operations SET result_code=$2 WHERE op_id=$1`, [
          op.opId,
          resultCode,
        ]);
        if (outcome.kind === 'applied') results.push({ opId: op.opId, status: 'applied' });
        else if (outcome.kind === 'rejected')
          results.push({ opId: op.opId, status: 'rejected', code: outcome.code });
        else
          results.push({
            opId: op.opId, status: 'conflict',
            conflictId: outcome.conflictId, conflictType: outcome.conflictType,
          });
      }

      const applied = results.filter((r) => r.status === 'applied').length;
      await tx.query(
        `INSERT INTO audit_log (actor_id, action, entity_type, entity_id, details, organization_id)
         VALUES ($1,'sync.push','sync',NULL,$2,$3)`,
        [ctx.userId, JSON.stringify({
          total: dto.ops.length,
          applied,
          duplicates: results.filter((r) => r.status === 'duplicate').length,
          rejected: results.filter((r) => r.status === 'rejected').length,
          conflicts: results.filter((r) => r.status === 'conflict').length,
          deviceId: dto.deviceId ?? null,
        }), ctx.organizationId],
      );
    });
    return { results };
  }

  /** Re-runs the stored local payload against fresh state inside one
   *  transaction. Used both by explicit resolution (apply_local) and by the
   *  retry endpoint. Only open conflicts of resolvable types qualify. */
  private async reapplyConflict(
    ctx: AuthContext,
    conflictId: string,
    viaRetry: boolean,
  ) {
    return this.support.ds.transaction(async (tx) => {
      const c = rows(
        await tx.query(
          `SELECT * FROM sync_conflicts WHERE conflict_id=$1 AND organization_id=$2 FOR UPDATE`,
          [conflictId, ctx.organizationId],
        ),
      )[0] as Record<string, any> | undefined;
      if (!c) throw new NotFoundException({ message: 'التعارض غير موجود', code: 'CONFLICT_NOT_FOUND' });
      if (c.status !== 'open') {
        throw new ConflictException({ message: 'التعارض محسوم مسبقاً', code: 'ALREADY_RESOLVED' });
      }
      if (c.entity_type !== 'product') {
        throw new ConflictException({ message: 'نوع غير قابل للتطبيق', code: 'NOT_APPLICABLE' });
      }
      if (c.conflict_type === 'IMMUTABLE_FIELDS') {
        throw new ConflictException({ message: 'لا يمكن تطبيق هذا التعارض', code: 'NOT_APPLICABLE' });
      }
      if (viaRetry && c.conflict_type === 'MISSING_BASE_VERSION') {
        throw new ConflictException({ message: 'يتطلب قراراً صريحاً', code: 'RETRY_NOT_ALLOWED' });
      }

      const payload = typeof c.local_payload === 'string'
        ? JSON.parse(c.local_payload)
        : c.local_payload;
      // strip version basis: we re-validate against CURRENT state by definition
      delete payload.baseVersion;

      const outcome = await this.applyProductUpdate(
        tx,
        { opId: c.op_id, deviceId: c.device_id, actorId: c.actor_id ?? ctx.userId, organizationId: ctx.organizationId },
        payload,
        { enforceBaseVersion: false },
      );
      if (outcome.kind === 'conflict') {
        throw new ConflictException({ message: 'ما زال متعارضاً', code: 'STILL_CONFLICTED' });
      }
      if (outcome.kind === 'rejected') {
        throw new ConflictException({ message: `فشل التطبيق (${outcome.code})`, code: outcome.code });
      }

      await tx.query(
        `UPDATE sync_conflicts SET status='resolved', resolution='applied_local',
           resolved_by=$2, resolved_at=now() WHERE conflict_id=$1`,
        [conflictId, ctx.userId],
      );
      await tx.query(`UPDATE sync_operations SET result_code='resolved:applied_local' WHERE op_id=$1`, [c.op_id]);
      await tx.query(
        `INSERT INTO audit_log (actor_id, action, entity_type, entity_id, details, organization_id)
         VALUES ($1,'conflict.resolve','sync_conflict',$2,$3,$4)`,
        [ctx.userId, c.id, JSON.stringify({ conflictId, resolution: 'applied_local', via: viaRetry ? 'retry' : 'resolve' }), ctx.organizationId],
      );
      return { conflictId, resolution: 'applied_local' };
    });
  }

  async resolve(ctx: AuthContext, conflictId: string, dto: ResolveDto) {
    if (dto.resolution === 'keep_server') {
      await this.support.ds.transaction(async (tx) => {
        const c = rows(
          await tx.query(
            `SELECT * FROM sync_conflicts WHERE conflict_id=$1 AND organization_id=$2 FOR UPDATE`,
            [conflictId, ctx.organizationId],
          ),
        )[0] as Record<string, any> | undefined;
        if (!c) throw new NotFoundException({ message: 'التعارض غير موجود', code: 'CONFLICT_NOT_FOUND' });
        if (c.status !== 'open') {
          throw new ConflictException({ message: 'التعارض محسوم مسبقاً', code: 'ALREADY_RESOLVED' });
        }
        await tx.query(
          `UPDATE sync_conflicts SET status='resolved', resolution='keep_server',
             resolved_by=$2, resolved_at=now() WHERE conflict_id=$1`,
          [conflictId, ctx.userId],
        );
        await tx.query(`UPDATE sync_operations SET result_code='resolved:kept_server' WHERE op_id=$1`, [c.op_id]);
        await tx.query(
          `INSERT INTO audit_log (actor_id, action, entity_type, entity_id, details, organization_id)
           VALUES ($1,'conflict.resolve','sync_conflict',$2,$3,$4)`,
          [ctx.userId, c.id, JSON.stringify({ conflictId, resolution: 'keep_server' }), ctx.organizationId],
        );
      });
      return { conflictId, resolution: 'keep_server' };
    }
    return this.reapplyConflict(ctx, conflictId, false);
  }

  async retry(ctx: AuthContext, conflictId: string) {
    return this.reapplyConflict(ctx, conflictId, true);
  }

  async listConflicts(ctx: AuthContext, q: { status?: string; entityType?: string; limit?: number; offset?: number }) {
    const limit = Math.min(Math.max(Math.trunc(Number(q.limit) || 50), 1), 200);
    const offset = Math.max(Math.trunc(Number(q.offset) || 0), 0);
    const where: string[] = ['organization_id=$1'];
    const params: unknown[] = [ctx.organizationId];
    if (q.status && ['open', 'resolved'].includes(q.status)) {
      params.push(q.status);
      where.push(`status=$${params.length}`);
    }
    if (q.entityType) {
      params.push(String(q.entityType));
      where.push(`entity_type=$${params.length}`);
    }
    const sqlWhere = `WHERE ${where.join(' AND ')}`;
    const items = rows(
      await this.support.ds.query(
        `SELECT conflict_id, op_id, device_id, entity_type, entity_id, local_version,
                server_version, conflict_type, status, resolution, created_at, resolved_at
         FROM sync_conflicts ${sqlWhere}
         ORDER BY created_at DESC, id DESC
         LIMIT ${limit} OFFSET ${offset}`,
        params,
      ),
    );
    const totalRows = rows(
      await this.support.ds.query(
        `SELECT COUNT(*)::int AS total FROM sync_conflicts ${sqlWhere}`,
        params,
      ),
    );
    const total = Number((totalRows[0] as { total?: number })?.total ?? 0);
    return { items, total, limit, offset };
  }

  async getConflict(ctx: AuthContext, conflictId: string) {
    const item = rows(
      await this.support.ds.query(
        `SELECT c.*, u.username AS resolved_by_name
         FROM sync_conflicts c LEFT JOIN users u ON u.id = c.resolved_by
         WHERE c.conflict_id=$1 AND c.organization_id=$2`,
        [conflictId, ctx.organizationId],
      ),
    )[0] as Record<string, unknown> | undefined;
    if (!item) throw new NotFoundException({ message: 'التعارض غير موجود', code: 'CONFLICT_NOT_FOUND' });
    return item;
  }
}

@Controller('sync')
export class SyncController {
  constructor(private readonly svc: SyncService) {}

  @Post('push')
  @RequirePermission() // no static permission; validated per operation type in the service
  push(@Body() dto: PushDto, @CurrentAuth() ctx: AuthContext) {
    return this.svc.push(ctx, dto);
  }

  @Get('conflicts')
  @RequirePermission('settings.manage')
  list(
    @Query('status') status: string | undefined,
    @Query('entityType') entityType: string | undefined,
    @Query('limit') limit: string | undefined,
    @Query('offset') offset: string | undefined,
    @CurrentAuth() ctx: AuthContext,
  ) {
    return this.svc.listConflicts(ctx, {
      status, entityType,
      limit: limit ? Number(limit) : undefined,
      offset: offset ? Number(offset) : undefined,
    });
  }

  @Get('conflicts/:conflictId')
  @RequirePermission('settings.manage')
  detail(@Param('conflictId') conflictId: string, @CurrentAuth() ctx: AuthContext) {
    void ctx;
    return this.svc.getConflict(ctx, conflictId);
  }

  @Post('conflicts/:conflictId/resolve')
  @RequirePermission('settings.manage')
  resolve(
    @Param('conflictId') conflictId: string,
    @Body() dto: ResolveDto,
    @CurrentAuth() ctx: AuthContext,
  ) {
    return this.svc.resolve(ctx, conflictId, dto);
  }

  @Post('conflicts/:conflictId/retry')
  @RequirePermission('settings.manage')
  retry(@Param('conflictId') conflictId: string, @CurrentAuth() ctx: AuthContext) {
    void ctx;
    return this.svc.retry(ctx, conflictId);
  }
}

@Module({
  controllers: [SyncController],
  providers: [SyncService],
})
export class SyncModule {}
