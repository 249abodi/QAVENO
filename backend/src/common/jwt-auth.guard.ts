import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import { DataSource } from 'typeorm';
import { Errors } from './domain.error';
import { AUTH_CTX_KEY } from './auth-context';
import { BranchAccessService } from './branch-access.service';

/**
 * Verifies the access token, re-loads the user (status/lock freshness),
 * resolves the X-Branch-Id header into a validated branch context.
 * Routes marked @Public() bypass authentication.
 */
@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(
    private readonly jwt: JwtService,
    private readonly ds: DataSource,
    private readonly branchAccess: BranchAccessService,
    private readonly reflector: Reflector,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean | undefined>('storaga.public', [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) return true;
    const req = context.switchToHttp().getRequest();
    const header: string | undefined = req.headers['authorization'];
    if (!header || !header.startsWith('Bearer ')) throw Errors.unauthorized('مطلوب تسجيل الدخول');
    const token = header.slice(7).trim();
    let payload: { sub?: number };
    try {
      payload = await this.jwt.verifyAsync(token);
    } catch {
      throw Errors.unauthorized('انتهت صلاحية الجلسة');
    }
    const userId = Number(payload.sub);
    const rows = await this.ds.manager.query(
      `SELECT id, username, display_name, role, status FROM users WHERE id=$1`,
      [userId],
    );
    const user = rows[0];
    if (!user) throw Errors.unauthorized('الحساب غير موجود');
    if (user.status !== 'active') throw Errors.unauthorized('الحساب معطل');
    req.user = user;
    req[AUTH_CTX_KEY] = await this.branchAccess.buildContext(
      user,
      req.headers['x-branch-id'],
      req.headers['x-org-id'],
    );
    return true;
  }
}
