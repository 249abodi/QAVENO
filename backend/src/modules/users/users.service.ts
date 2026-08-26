import { ConflictException, Injectable } from '@nestjs/common';
import * as bcrypt from 'bcryptjs';
import { DataSource, EntityManager } from 'typeorm';
import { AuthService } from '../auth/auth.service';
import { ROLES } from '../../common/rbac.constants';
import { validateNewPassword, validateUsername } from '../../common/validation.util';
import { AuthContext } from '../../common/auth-context';

@Injectable()
export class UsersService {
  constructor(private readonly ds: DataSource, private readonly auth: AuthService) {}

  private async activeOwnerCount(em: EntityManager): Promise<number> {
    const rows = await em.query(
      `SELECT COUNT(*)::int AS c FROM users WHERE role='owner' AND status='active'`,
    );
    return Number(rows[0]?.c || 0);
  }

  async list(ctx: AuthContext): Promise<Record<string, unknown>[]> {
    const o = ctx.organizationId;
    const users = await this.ds.manager.query(
      `SELECT u.id, u.username, u.display_name AS "displayName", u.role, u.status,
              u.must_change_password AS "mustChangePassword", u.failed_attempts AS "failedAttempts",
              u.locked_until AS "lockedUntil", u.last_login_at AS "lastLoginAt", u.created_at AS "createdAt"
       FROM users u
       JOIN organization_members om ON om.user_id=u.id AND om.organization_id=$1 AND om.status='active'
       ORDER BY u.id`,
      [o],
    );
    // Only return branch links for branches in this org.
    const links = await this.ds.manager.query(
      `SELECT ub.user_id AS "userId", ub.branch_id AS "branchId", ub.is_primary AS "isPrimary"
       FROM user_branches ub
       JOIN branches b ON b.id=ub.branch_id AND b.organization_id=$1`,
      [o],
    );
    for (const u of users) {
      u.branches = links.filter((l) => Number(l.userId) === Number(u.id));
    }
    return users;
  }

  async create(ctx: AuthContext, input: {
    username: string;
    displayName?: string;
    password: string;
    role: string;
    branches?: { branchId: number; isPrimary?: boolean }[];
    actorId: number;
  }): Promise<Record<string, unknown>> {
    if (!ROLES.includes(input.role as never)) throw new ConflictException({ message: 'الدور غير صالح', code: 'BAD_ROLE' });
    const username = validateUsername(input.username);
    validateNewPassword(input.password);
    const o = ctx.organizationId;
    return this.ds.transaction(async (em) => {
      await this.assertNoDuplicate(em, username, null);
      const hash = bcrypt.hashSync(input.password, 10);
      const created = await em.query(
        `INSERT INTO users (username, display_name, password_hash, role, status)
         VALUES ($1,$2,$3,$4,'active') RETURNING id, username`,
        [username, input.displayName?.trim() || username, hash, input.role],
      );
      const userId = Number(created[0].id);
      // Auto-create org membership for the new user.
      // Map system roles to membership roles (CHECK: owner|admin|member).
      const membershipRole = ['owner', 'admin'].includes(input.role) ? input.role : 'member';
      await em.query(
        `INSERT INTO organization_members (user_id, organization_id, role, status)
         VALUES ($1,$2,$3,'active')`,
        [userId, o, membershipRole],
      );
      await this.saveBranchLinksTx(em, userId, input.role, input.branches || [], true, o);
      await em.query(
        `INSERT INTO audit_log (actor_id, action, entity_type, entity_id, organization_id)
         VALUES ($1,'user.create','user',$2,$3)`,
        [input.actorId, userId, o],
      );
      return { id: userId, username };
    });
  }

  async update(
    ctx: AuthContext,
    id: number,
    input: {
      displayName?: string;
      role?: string;
      status?: string;
      branches?: { branchId: number; isPrimary?: boolean }[];
      actorId: number;
    },
  ): Promise<{ ok: true }> {
    const o = ctx.organizationId;
    return this.ds.transaction(async (em) => {
      const rows = await em.query(`SELECT * FROM users WHERE id=$1`, [id]);
      const user = rows[0];
      if (!user) throw new ConflictException({ message: 'المستخدم غير موجود', code: 'NOT_FOUND' });

      const nextRole = input.role ?? user.role;
      const nextStatus = input.status ?? user.status;
      if (!ROLES.includes(nextRole as never)) throw new ConflictException({ message: 'الدور غير صالح', code: 'BAD_ROLE' });
      if (!['active', 'disabled'].includes(nextStatus)) {
        throw new ConflictException({ message: 'الحالة غير صالحة', code: 'BAD_STATUS' });
      }
      if (user.role === 'owner' && (nextRole !== 'owner' || nextStatus !== 'active')) {
        const owners = await this.activeOwnerCount(em);
        const selfIsOwner = user.role === 'owner' && user.status === 'active';
        if (selfIsOwner && owners <= 1) {
          throw new ConflictException({ message: 'لا يمكن تعطيل أو تخفيض آخر مالك نشط', code: 'LAST_OWNER' });
        }
      }
      await em.query(
        `UPDATE users SET display_name=COALESCE($2,display_name), role=$3, status=$4, updated_at=now() WHERE id=$1`,
        [id, input.displayName?.trim() ?? null, nextRole, nextStatus],
      );
      if (input.branches) {
        await this.saveBranchLinksTx(em, id, nextRole, input.branches, false, o);
      }
      if (nextStatus === 'disabled') {
        await em.query(`UPDATE refresh_tokens SET revoked_at=now() WHERE user_id=$1 AND revoked_at IS NULL`, [id]);
      }
      await em.query(
        `INSERT INTO audit_log (actor_id, action, entity_type, entity_id, details, organization_id)
         VALUES ($1,'user.update','user',$2,$3,$4)`,
        [input.actorId, id, JSON.stringify({ role: nextRole, status: nextStatus }), o],
      );
      return { ok: true as const };
    });
  }

  async resetPassword(id: number, newPassword: string, actorId: number): Promise<{ ok: true }> {
    validateNewPassword(newPassword);
    return this.ds.transaction(async (em) => {
      const rows = await em.query(`SELECT id FROM users WHERE id=$1`, [id]);
      if (!rows[0]) throw new ConflictException({ message: 'المستخدم غير موجود', code: 'NOT_FOUND' });
      await em.query(
        `UPDATE users SET password_hash=$2, must_change_password=1, failed_attempts=0,
                locked_until=NULL, updated_at=now() WHERE id=$1`,
        [id, bcrypt.hashSync(newPassword, 10)],
      );
      await this.auth.revokeAllForUser(id);
      await em.query(
        `INSERT INTO audit_log (actor_id, action, entity_type, entity_id)
         VALUES ($1,'user.reset_password','user',$2)`,
        [actorId, id],
      );
      return { ok: true as const };
    });
  }

  async unlock(id: number, actorId: number): Promise<{ ok: true }> {
    await this.ds.manager.query(
      `UPDATE users SET failed_attempts=0, locked_until=NULL, updated_at=now() WHERE id=$1`,
      [id],
    );
    await this.ds.manager.query(
      `INSERT INTO audit_log (actor_id, action, entity_type, entity_id)
       VALUES ($1,'user.unlock','user',$2)`,
      [actorId, id],
    );
    return { ok: true };
  }

  private async saveBranchLinksTx(
    em: EntityManager,
    userId: number,
    role: string,
    wanted: { branchId: number; isPrimary?: boolean }[],
    creating: boolean,
    organizationId: number,
  ): Promise<void> {
    const spanning = role === 'owner' || role === 'admin';
    const current = await em.query(
      `SELECT ub.branch_id, ub.is_primary FROM user_branches ub
       JOIN branches b ON b.id=ub.branch_id AND b.organization_id=$2
       WHERE ub.user_id=$1 ORDER BY ub.branch_id`,
      [userId, organizationId],
    );
    const currentIds = current.map((r) => Number(r.branch_id));
    const wantIds = [...new Set(wanted.map((w) => Number(w.branchId)))];

    for (const bid of wantIds) {
      const b = await em.query(`SELECT id FROM branches WHERE id=$1 AND organization_id=$2`, [bid, organizationId]);
      if (!b[0]) throw new ConflictException({ message: `الفرع ${bid} غير موجود`, code: 'BRANCH_NOT_FOUND' });
    }
    if (!spanning && !creating && wantIds.length === 0 && currentIds.length > 0) {
      throw new ConflictException({ message: 'يجب أن يبقى للمستخدم فرع أساسي واحد على الأقل', code: 'LAST_BRANCH' });
    }

    let primary = wanted.find((w) => w.isPrimary)?.branchId ?? wantIds[0];
    if (primary == null) primary = currentIds[0];
    if (primary != null && !wantIds.includes(Number(primary)) && !(!spanning && wantIds.length === 0)) {
      throw new ConflictException({ message: 'الفرع الأساسي يجب أن يكون ضمن الفروع المحددة', code: 'PRIMARY_NOT_SELECTED' });
    }

    const toAdd = wantIds.filter((b) => !currentIds.includes(b));
    const toRemove = currentIds.filter((b) => !wantIds.includes(b));
    for (const b of toAdd) {
      await em.query(
        `INSERT INTO user_branches (user_id, branch_id, is_primary) VALUES ($1,$2,$3)
         ON CONFLICT (user_id, branch_id) DO UPDATE SET is_primary=$3`,
        [userId, b, Number(b) === Number(primary) ? 1 : 0],
      );
    }
    for (const b of toRemove) {
      await em.query(`DELETE FROM user_branches WHERE user_id=$1 AND branch_id=$2`, [userId, b]);
    }
    if (wantIds.includes(Number(primary))) {
      // Only clear primaries for branches in this org.
      await em.query(
        `UPDATE user_branches SET is_primary=0 WHERE user_id=$1 AND branch_id<>$2
         AND branch_id IN (SELECT id FROM branches WHERE organization_id=$3)`,
        [userId, primary, organizationId],
      );
      await em.query(`UPDATE user_branches SET is_primary=1 WHERE user_id=$1 AND branch_id=$2`, [userId, primary]);
    }
  }

  private async assertNoDuplicate(em: EntityManager, username: string, excludeId: number | null): Promise<void> {
    const rows = excludeId
      ? await em.query(`SELECT id FROM users WHERE lower(username)=lower($1) AND id<>$2`, [username, excludeId])
      : await em.query(`SELECT id FROM users WHERE lower(username)=lower($1)`, [username]);
    if (rows[0]) {
      throw new ConflictException({ message: 'اسم المستخدم مستخدم مسبقاً', code: 'USERNAME_TAKEN' });
    }
  }
}
