import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ROLE_PERMISSIONS } from './rbac.constants';
import { Errors } from './domain.error';

/**
 * Checks @RequirePermission(...) metadata against the role matrix
 * (ROLE_PERMISSIONS ported verbatim from the Electron app).
 */
@Injectable()
export class PermissionsGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const required = this.reflector.getAllAndOverride<string[] | undefined>('storaga.perms', [
      context.getHandler(),
      context.getClass(),
    ]);
    if (!required || !required.length) return true;
    const req = context.switchToHttp().getRequest();
    const role = req.user?.role;
    const granted = (ROLE_PERMISSIONS as Record<string, string[]>)[role] || [];
    const ok = required.every((p) => granted.includes(p));
    if (!ok) throw Errors.forbidden();
    return true;
  }
}
