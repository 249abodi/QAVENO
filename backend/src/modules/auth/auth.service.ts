import {
  BadRequestException,
  ConflictException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import * as bcrypt from 'bcryptjs';
import * as crypto from 'crypto';
import { DataSource, EntityManager } from 'typeorm';
import { ConfigService } from '@nestjs/config';
import { ROLE_PERMISSIONS } from '../../common/rbac.constants';
import { BranchAccessService } from '../../common/branch-access.service';

const MAX_ATTEMPTS = 5;
const LOCK_MINUTES = 15;

export interface TokenPair {
  accessToken: string;
  refreshToken: string;
}

@Injectable()
export class AuthService {
  constructor(
    private readonly ds: DataSource,
    private readonly jwt: JwtService,
    private readonly config: ConfigService,
    private readonly branchAccess: BranchAccessService,
  ) {}

  static sha256(s: string): string {
    return crypto.createHash('sha256').update(s).digest('hex');
  }

  async countUsers(): Promise<number> {
    const rows = await this.ds.manager.query('SELECT COUNT(*)::int AS c FROM users');
    return Number(rows[0]?.c || 0);
  }

  async setupOwner(input: {
    username: string;
    password: string;
    displayName?: string;
  }): Promise<{ id: number; username: string }> {
    if ((await this.countUsers()) > 0) {
      throw new ConflictException({ message: 'تم إنشاء حساب المالك مسبقاً', code: 'SETUP_ALREADY_DONE' });
    }
    const em = this.ds.manager;
    const hash = bcrypt.hashSync(String(input.password), 10);
    const rows = await em.query(
      `INSERT INTO users (username, display_name, password_hash, role, status)
       VALUES ($1,$2,$3,'owner','active') RETURNING id, username`,
      [input.username.trim(), input.displayName?.trim() || input.username.trim(), hash],
    );
    const userId = Number(rows[0].id);

    // Create default organization and membership (multi-tenancy bootstrap).
    // Use existing org 1 if present, otherwise create one.
    let orgRows = await em.query(`SELECT id FROM organizations WHERE id=1`);
    let orgId: number;
    if (orgRows[0]) {
      orgId = Number(orgRows[0].id);
    } else {
      const created = await em.query(
        `INSERT INTO organizations (name, slug, status) VALUES ('المؤسسة الافتراضية','default','active') RETURNING id`,
      );
      orgId = Number(created[0].id);
    }

    await em.query(
      `INSERT INTO organization_members (user_id, organization_id, role, status)
       VALUES ($1,$2,'owner','active')`,
      [userId, orgId],
    );

    // Use existing branch if present, otherwise create one.
    let existingBranch = await em.query(`SELECT id FROM branches WHERE organization_id=$1 ORDER BY id LIMIT 1`, [orgId]);
    let branchId: number;
    if (existingBranch[0]) {
      branchId = Number(existingBranch[0].id);
    } else {
      const brRows = await em.query(
        `INSERT INTO branches (name, code, status, organization_id)
         VALUES ('المخزن الرئيسي','HQ','active',$1) RETURNING id`,
        [orgId],
      );
      branchId = Number(brRows[0].id);
    }

    // Link owner to branch if not already linked.
    const existingLink = await em.query(
      `SELECT 1 FROM user_branches WHERE user_id=$1 AND branch_id=$2`, [userId, branchId],
    );
    if (!existingLink[0]) {
      await em.query(
        `INSERT INTO user_branches (user_id, branch_id, is_primary) VALUES ($1,$2,1)`,
        [userId, branchId],
      );
    }

    return { id: userId, username: rows[0].username };
  }

  async login(username: string, password: string): Promise<TokenPair & { user: Record<string, unknown> }> {
    const em = this.ds.manager;
    const rows = await em.query(
      `SELECT * FROM users WHERE lower(username)=lower($1)`,
      [String(username || '').trim()],
    );
    const user = rows[0];
    if (!user) throw new UnauthorizedException({ message: 'بيانات الدخول غير صحيحة', code: 'INVALID_CREDENTIALS' });
    if (user.status !== 'active') {
      throw new UnauthorizedException({ message: 'الحساب معطل', code: 'ACCOUNT_DISABLED' });
    }
    const lockedUntil = user.locked_until ? new Date(user.locked_until) : null;
    if (user.failed_attempts >= MAX_ATTEMPTS && lockedUntil && lockedUntil.getTime() > Date.now()) {
      throw new UnauthorizedException({
        message: `الحساب مقفل مؤقتاً حتى ${lockedUntil.toISOString()}`,
        code: 'ACCOUNT_LOCKED',
      });
    }
    const ok = bcrypt.compareSync(String(password || ''), user.password_hash);
    if (!ok) {
      const attempts = Number(user.failed_attempts || 0) + 1;
      const lock = attempts >= MAX_ATTEMPTS;
      await em.query(
        `UPDATE users SET failed_attempts=$2,
           locked_until = CASE WHEN $3 THEN now() + interval '${LOCK_MINUTES} minutes' ELSE locked_until END,
           updated_at=now()
         WHERE id=$1`,
        [user.id, attempts, lock],
      );
      throw new UnauthorizedException({ message: 'بيانات الدخول غير صحيحة', code: 'INVALID_CREDENTIALS' });
    }
    await em.query(
      `UPDATE users SET failed_attempts=0, locked_until=NULL, last_login_at=now() WHERE id=$1`,
      [user.id],
    );
    const tokens = await this.issueTokens(this.ds.manager, user);
    return {
      ...tokens,
      user: {
        id: user.id,
        username: user.username,
        displayName: user.display_name,
        role: user.role,
        mustChangePassword: !!Number(user.must_change_password),
      },
    };
  }

  async refresh(refreshToken: string): Promise<TokenPair & { user: Record<string, unknown> }> {
    const em = this.ds.manager;
    const hash = AuthService.sha256(String(refreshToken || ''));
    const rows = await em.query(
      `SELECT rt.*, u.username, u.display_name, u.role, u.status
       FROM refresh_tokens rt JOIN users u ON u.id=rt.user_id
       WHERE rt.token_hash=$1`,
      [hash],
    );
    const row = rows[0];
    if (!row || row.revoked_at) {
      throw new UnauthorizedException({ message: 'جلسة غير صالحة', code: 'REFRESH_INVALID' });
    }
    if (new Date(row.expires_at).getTime() <= Date.now()) {
      throw new UnauthorizedException({ message: 'انتهت صلاحية الجلسة', code: 'REFRESH_EXPIRED' });
    }
    if (row.status !== 'active') {
      throw new UnauthorizedException({ message: 'الحساب معطل', code: 'ACCOUNT_DISABLED' });
    }
    // rotation: revoke old, mint new
    await em.query(`UPDATE refresh_tokens SET revoked_at=now() WHERE id=$1`, [row.id]);
    const user = { id: row.user_id, username: row.username, display_name: row.display_name, role: row.role };
    const tokens = await this.issueTokens(em, user);
    return {
      ...tokens,
      user: {
        id: user.id,
        username: user.username,
        displayName: user.display_name,
        role: user.role,
        mustChangePassword: false,
      },
    };
  }

  async logout(refreshToken: string): Promise<void> {
    const hash = AuthService.sha256(String(refreshToken || ''));
    await this.ds.manager.query(
      `UPDATE refresh_tokens SET revoked_at=now() WHERE token_hash=$1 AND revoked_at IS NULL`,
      [hash],
    );
  }

  async revokeAllForUser(userId: number): Promise<void> {
    await this.ds.manager.query(
      `UPDATE refresh_tokens SET revoked_at=now() WHERE user_id=$1 AND revoked_at IS NULL`,
      [userId],
    );
  }

  private async issueTokens(em: EntityManager, user: { id: number; username: string; role: string }): Promise<TokenPair> {
    const ttl = this.config.get<number>('jwt.accessTtlSec') ?? 900;
    const accessToken = await this.jwt.signAsync(
      { sub: user.id, username: user.username, role: user.role },
      { expiresIn: ttl },
    );
    const refreshToken = crypto.randomBytes(48).toString('hex');
    const refreshTtl = this.config.get<number>('jwt.refreshTtlSec') ?? 7 * 24 * 3600;
    await em.query(
      `INSERT INTO refresh_tokens (token_hash, user_id, expires_at)
       VALUES ($1,$2, now() + ($3 || ' seconds')::interval)`,
      [AuthService.sha256(refreshToken), user.id, String(refreshTtl)],
    );
    return { accessToken, refreshToken };
  }

  async profilePayload(userId: number): Promise<Record<string, unknown>> {
    const rows = await this.ds.manager.query(
      `SELECT id, username, display_name AS "displayName", role, status,
              must_change_password AS "mustChangePassword", last_login_at AS "lastLoginAt"
       FROM users WHERE id=$1`,
      [userId],
    );
    const user = rows[0];
    if (!user) throw new UnauthorizedException('الحساب غير موجود');
    // Resolve user's default org membership for branch listing.
    const memberships = await this.ds.manager.query(
      `SELECT organization_id FROM organization_members WHERE user_id=$1 AND status='active'`,
      [userId],
    );
    const organizationId = memberships[0] ? Number(memberships[0].organization_id) : 1;
    const branches = await this.branchAccess.accessibleBranchRows({ id: userId, role: user.role, organizationId });
    return {
      user,
      permissions: (ROLE_PERMISSIONS as Record<string, string[]>)[user.role] || [],
      branches,
    };
  }
}

export function bad(msg: string, code = 'INVALID_INPUT'): never {
  throw new BadRequestException({ message: msg, code });
}
