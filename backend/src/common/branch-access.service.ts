import { Injectable } from '@nestjs/common';
import { DataSource, EntityManager } from 'typeorm';
import { Errors } from './domain.error';
import { AuthContext } from './auth-context';
import { spansAllBranches } from './rbac.constants';

/** Port of branches.js access rules for the API layer, now with tenant context. */
@Injectable()
export class BranchAccessService {
  constructor(private readonly ds: DataSource) {}

  /**
   * Resolve the active organization from the X-Org-Id header.
   * Falls back to the user's sole active membership if no header is supplied.
   * Throws for invalid/unauthorized orgs.
   */
  async resolveOrganization(
    userId: number,
    headerOrgIdRaw: string | undefined,
  ): Promise<{ organizationId: number; membershipRole: string }> {
    const memberships = await this.ds.manager.query(
      `SELECT organization_id, role FROM organization_members
       WHERE user_id=$1 AND status='active'`,
      [userId],
    );
    if (!memberships.length) throw Errors.unauthorized('لا تملك عضوية في أي مؤسسة');

    const selectedOrgId = headerOrgIdRaw != null && String(headerOrgIdRaw).trim() !== ''
      ? Number(headerOrgIdRaw)
      : null;

    let membership: { organizationId: number; membershipRole: string };
    if (selectedOrgId) {
      const match = memberships.find((m: any) => Number(m.organization_id) === selectedOrgId);
      if (!match) throw Errors.noBranchAccess(); // reuse branch access error for unauthorized org
      membership = { organizationId: selectedOrgId, membershipRole: match.role };
    } else {
      // No header: pick sole membership, or first if multiple (pre-existing behavior)
      membership = { organizationId: Number(memberships[0].organization_id), membershipRole: memberships[0].role };
    }

    // Verify org is active
    const orgRows = await this.ds.manager.query(
      `SELECT id, status FROM organizations WHERE id=$1`, [membership.organizationId],
    );
    if (!orgRows[0] || orgRows[0].status !== 'active') {
      throw Errors.unauthorized('المؤسسة غير نشطة');
    }
    return membership;
  }

  async accessibleBranchRows(user: {
    id: number;
    role: string;
    organizationId: number;
  }): Promise<{ id: number; name: string; status: string; isPrimary: number }[]> {
    const spanning = spansAllBranches(user.role as never);
    const em = this.ds.manager;
    if (spanning) {
      return em.query(
        `SELECT id, name, status, 0 AS "isPrimary"
         FROM branches WHERE status='active' AND organization_id=$1 ORDER BY id`,
        [user.organizationId],
      );
    }
    return em.query(
      `SELECT b.id, b.name, b.status, COALESCE(ub.is_primary,0) AS "isPrimary"
       FROM user_branches ub JOIN branches b ON b.id=ub.branch_id
       WHERE ub.user_id=$1 AND b.status='active' AND b.organization_id=$2 ORDER BY b.id`,
      [user.id, user.organizationId],
    );
  }

  async buildContext(
    reqUser: { id: number; username: string; role: string; display_name?: string },
    headerBranchIdRaw: string | undefined,
    headerOrgIdRaw: string | undefined,
  ): Promise<AuthContext> {
    const { organizationId, membershipRole } = await this.resolveOrganization(reqUser.id, headerOrgIdRaw);
    const rows = await this.accessibleBranchRows({ id: reqUser.id, role: reqUser.role, organizationId });
    if (!rows.length) throw Errors.noBranchAccess();
    const ids = rows.map((r) => Number(r.id));
    let branchId: number;
    if (headerBranchIdRaw != null && String(headerBranchIdRaw).trim() !== '') {
      const wanted = Number(headerBranchIdRaw);
      if (!ids.includes(wanted)) throw Errors.noBranchAccess();
      branchId = wanted;
    } else {
      const primary = rows.find((r) => Number(r.isPrimary) === 1);
      branchId = primary ? Number(primary.id) : ids[0];
    }
    const row = rows.find((r) => Number(r.id) === branchId)!;
    return {
      userId: reqUser.id,
      username: reqUser.username,
      role: reqUser.role as AuthContext['role'],
      displayName: reqUser.display_name || reqUser.username,
      organizationId,
      branchId,
      branchName: row.name,
      accessibleBranchIds: ids,
      spansAll: spansAllBranches(reqUser.role as never),
    };
  }

  assertBranch(ctx: AuthContext, branchId: number | null | undefined): void {
    if (branchId == null) return;
    if (!ctx.spansAll && !ctx.accessibleBranchIds.includes(Number(branchId))) {
      throw Errors.noBranchAccess();
    }
  }

  /** Async variant usable inside services before opening a transaction. */
  async assertBranchAsync(ctx: AuthContext, branchId: number | null | undefined): Promise<void> {
    this.assertBranch(ctx, branchId);
  }
}
