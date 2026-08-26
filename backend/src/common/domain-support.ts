import { ConflictException, ForbiddenException, Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { AuthContext } from './auth-context';
import { AuditService } from './audit.service';

/**
 * Shared helpers for domain services: branch guards, audit-on-error-free
 * writes, and the DEFAULT_BRANCH / OPEN_RECONCILIATIONS style checks.
 * All methods are now tenant-aware.
 */
@Injectable()
export class DomainSupport {
  constructor(
    public readonly ds: DataSource,
    public readonly audit: AuditService,
  ) {}

  assertBranch(ctx: AuthContext, branchId: number | null | undefined): void {
    if (branchId == null) return;
    if (!ctx.spansAll && !ctx.accessibleBranchIds.includes(Number(branchId))) {
      throw new ForbiddenException({ message: 'ليس لديك صلاحية على هذا الفرع', code: 'NO_BRANCH_ACCESS' });
    }
  }

  async assertBranchAsync(ctx: AuthContext, branchId: number | null | undefined): Promise<void> {
    this.assertBranch(ctx, branchId);
  }

  async getDefaultBranchId(em = this.ds.manager, organizationId?: number): Promise<number> {
    const orgCond = organizationId ? `WHERE organization_id=$1` : '';
    const params = organizationId ? [organizationId] : [];
    const rows = await em.query(`SELECT id FROM branches ${orgCond} ORDER BY id LIMIT 1`, params);
    if (!rows[0]) throw new ConflictException({ message: 'لا يوجد فرع', code: 'NO_BRANCH' });
    return Number(rows[0].id);
  }

  async assertNoOpenReconciliations(branchId: number, em = this.ds.manager): Promise<void> {
    const rows = await em.query(
      `SELECT COUNT(*)::int AS c FROM stock_reconciliations WHERE branch_id=$1 AND status='open'`,
      [branchId],
    );
    if (Number(rows[0]?.c || 0) > 0) {
      throw new ConflictException({ message: 'لا يمكن تعديل الفرع لوجود جرد مفتوح عليه', code: 'OPEN_RECONCILIATIONS' });
    }
  }

  async insMovement(
    em,
    input: {
      productId: number;
      change: number;
      reason: string;
      reasonCode?: string | null;
      refType?: string | null;
      refId?: number | null;
      balanceAfter: number;
      actorId?: number | null;
      note?: string | null;
      branchId?: number | null;
      organizationId?: number | null;
    },
  ): Promise<number> {
    const rows = await em.query(
      `INSERT INTO inventory_movements
         (product_id, change, reason, reason_code, ref_type, ref_id, balance_after, actor_id, note, branch_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id`,
      [
        input.productId,
        Math.trunc(input.change),
        input.reason,
        input.reasonCode ?? null,
        input.refType ?? null,
        input.refId ?? null,
        Math.trunc(input.balanceAfter),
        input.actorId ?? null,
        input.note ?? null,
        input.branchId ?? null,
      ],
    );
    return Number(rows[0].id);
  }

  async ensureBranchRowTx(
    em,
    branchId: number,
    productId: number,
    organizationId?: number,
  ): Promise<{ quantity: number; cost: number }> {
    const upd = await em.query(
      `UPDATE branch_inventory SET updated_at=now()
       WHERE branch_id=$1 AND product_id=$2 AND updated_at IS NULL
       RETURNING quantity, cost`,
      [branchId, productId],
    );
    void upd;
    const rows = await em.query(
      `SELECT quantity, cost FROM branch_inventory WHERE branch_id=$1 AND product_id=$2 FOR UPDATE`,
      [branchId, productId],
    );
    if (rows[0]) return { quantity: Number(rows[0].quantity), cost: Number(rows[0].cost) };
    const isDefault = await this.isDefaultBranchTx(em, branchId, organizationId);
    const orgCond = organizationId ? `AND organization_id=$2` : '';
    const p = await em.query(`SELECT quantity, cost FROM products WHERE id=$1 ${orgCond}`, organizationId ? [productId, organizationId] : [productId]);
    if (!p[0]) throw new ConflictException({ message: 'المنتج غير موجود', code: 'NOT_FOUND' });
    const qty = isDefault ? Number(p[0].quantity) : 0;
    const cost = Number(p[0].cost);
    await em.query(
      `INSERT INTO branch_inventory (branch_id, product_id, quantity, cost)
       VALUES ($1,$2,$3,$4) ON CONFLICT (branch_id, product_id) DO NOTHING`,
      [branchId, productId, qty, cost],
    );
    const again = await em.query(
      `SELECT quantity, cost FROM branch_inventory WHERE branch_id=$1 AND product_id=$2 FOR UPDATE`,
      [branchId, productId],
    );
    return { quantity: Number(again[0].quantity), cost: Number(again[0].cost) };
  }

  async isDefaultBranchTx(em, branchId: number, organizationId?: number): Promise<boolean> {
    const orgCond = organizationId ? `WHERE organization_id=$1` : '';
    const params = organizationId ? [organizationId] : [];
    const rows = await em.query(`SELECT MIN(id)::int AS d FROM branches ${orgCond}`, params);
    return Number(rows[0]?.d || 0) === Number(branchId);
  }
}
