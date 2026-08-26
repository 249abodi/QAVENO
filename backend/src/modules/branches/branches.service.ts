import { ConflictException, Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { DomainSupport } from '../../common/domain-support';
import { AuthContext } from '../../common/auth-context';

@Injectable()
export class BranchesService {
  constructor(private readonly support: DomainSupport) {}

  async listWithStats(ctx: AuthContext) {
    const em = this.support.ds.manager;
    const o = ctx.organizationId;
    const branches = await em.query(`SELECT * FROM branches WHERE organization_id=$1 ORDER BY id`, [o]);
    const out = [];
    for (const b of branches) {
      const stats = await em.query(
        `SELECT
           (SELECT COUNT(*)::int FROM branch_inventory bi WHERE bi.branch_id=$1 AND bi.quantity>0) AS "activeProducts",
           (SELECT COALESCE(SUM(bi.quantity),0)::int FROM branch_inventory bi WHERE bi.branch_id=$1) AS "totalUnits",
           (SELECT COALESCE(ROUND(SUM(bi.quantity*bi.cost)::numeric,2)::double precision,0)
              FROM branch_inventory bi WHERE bi.branch_id=$1) AS "stockValue",
           (SELECT COUNT(*)::int FROM users u JOIN user_branches ub ON ub.user_id=u.id
              WHERE ub.branch_id=$1 AND u.status='active') AS "users"`,
        [b.id],
      );
      out.push({ ...b, ...stats[0] });
    }
    return out;
  }

  async mine(ctx: AuthContext) {
    const o = ctx.organizationId;
    if (ctx.spansAll) {
      const rows = await this.support.ds.manager.query(
        `SELECT b.*, 1 AS spans FROM branches b WHERE b.status='active' AND b.organization_id=$1 ORDER BY b.id`,
        [o],
      );
      return rows;
    }
    const rows = await this.support.ds.manager.query(
      `SELECT b.*, COALESCE(ub.is_primary,0) AS is_primary FROM user_branches ub
       JOIN branches b ON b.id=ub.branch_id WHERE ub.user_id=$1 AND b.status='active' AND b.organization_id=$2 ORDER BY b.id`,
      [ctx.userId, o],
    );
    return rows;
  }

  async create(ctx: AuthContext, input: {
    name: string;
    code?: string | null;
    address?: string;
    phone?: string;
    actorId: number;
  }): Promise<Record<string, unknown>> {
    const em = this.support.ds.manager;
    const o = ctx.organizationId;
    if (input.code) {
      const dup = await em.query(`SELECT id FROM branches WHERE code=$1 AND organization_id=$2`, [input.code, o]);
      if (dup[0]) throw new ConflictException({ message: 'رمز الفرع مستخدم مسبقاً', code: 'DUPLICATE_CODE' });
    }
    const rows = await em.query(
      `INSERT INTO branches (name, code, address, phone, organization_id) VALUES ($1,$2,$3,$4,$5) RETURNING *`,
      [input.name.trim(), input.code?.trim() || null, input.address?.trim() || '', input.phone?.trim() || '', o],
    );
    await em.query(
      `INSERT INTO audit_log (actor_id, action, entity_type, entity_id, details, organization_id)
       VALUES ($1,'branch.create','branch',$2,$3,$4)`,
      [input.actorId, rows[0].id, JSON.stringify({ name: rows[0].name }), o],
    );
    return rows[0];
  }

  async update(
    ctx: AuthContext,
    id: number,
    input: {
      name?: string;
      code?: string | null;
      address?: string;
      phone?: string;
      status?: string;
      actorId: number;
    },
  ): Promise<Record<string, unknown>> {
    const em = this.support.ds.manager;
    const o = ctx.organizationId;
    const cur = await em.query(`SELECT * FROM branches WHERE id=$1 AND organization_id=$2`, [id, o]);
    if (!cur[0]) throw new ConflictException({ message: 'الفرع غير موجود', code: 'NOT_FOUND' });

    if (input.status === 'disabled' && cur[0].status !== 'disabled') {
      const first = await em.query(`SELECT MIN(id)::int AS d FROM branches WHERE organization_id=$1`, [o]);
      if (Number(first[0].d) === Number(id)) {
        throw new ConflictException({ message: 'لا يمكن تعطيل الفرع الرئيسي', code: 'DEFAULT_BRANCH' });
      }
      await this.support.assertNoOpenReconciliations(id);
      const pend = await em.query(
        `SELECT COUNT(*)::int AS c FROM stock_transfers
         WHERE (source_branch_id=$1 OR dest_branch_id=$1)
           AND status IN ('draft','submitted','approved','dispatched','partially_received')`,
        [id],
      );
      if (Number(pend[0].c) > 0) {
        throw new ConflictException({ message: 'لا يمكن تعطيل الفرع لوجود تحويلات نشطة عليه', code: 'ACTIVE_TRANSFERS' });
      }
    }

    if (input.code != null && input.code !== '' && input.code !== cur[0].code) {
      const dup = await em.query(`SELECT id FROM branches WHERE code=$1 AND id<>$2 AND organization_id=$3`, [input.code, id, o]);
      if (dup[0]) throw new ConflictException({ message: 'رمز الفرع مستخدم مسبقاً', code: 'DUPLICATE_CODE' });
    }

    const rows = await em.query(
      `UPDATE branches SET
         name=COALESCE($2,name), code=CASE WHEN $3::boolean THEN $4 ELSE code END,
         address=COALESCE($5,address), phone=COALESCE($6,phone),
         status=COALESCE($7,status), updated_at=now()
       WHERE id=$1 AND organization_id=$8 RETURNING *`,
      [
        id,
        input.name?.trim() ?? null,
        input.code !== undefined,
        input.code === null ? null : (input.code?.trim() || cur[0].code),
        input.address?.trim() ?? null,
        input.phone?.trim() ?? null,
        input.status ?? null,
        o,
      ],
    );
    await em.query(
      `INSERT INTO audit_log (actor_id, action, entity_type, entity_id, details, organization_id)
       VALUES ($1,'branch.update','branch',$2,$3,$4)`,
      [input.actorId, id, JSON.stringify({ status: input.status ?? undefined, name: input.name ?? undefined }), o],
    );
    return rows[0];
  }

  async overview(branchId: number) {
    const em = this.support.ds.manager;
    const low = await em.query(
      `SELECT COUNT(*)::int AS c FROM branch_inventory WHERE branch_id=$1 AND quantity <= low_stock_threshold`,
      [branchId],
    );
    const value = await em.query(
      `SELECT COALESCE(ROUND(SUM(quantity*cost)::numeric,2)::double precision,0) AS v
       FROM branch_inventory WHERE branch_id=$1`,
      [branchId],
    );
    return { lowStock: Number(low[0].c), stockValue: Number(value[0].v) };
  }
}
