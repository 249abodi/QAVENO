import { SetMetadata, createParamDecorator, ExecutionContext } from '@nestjs/common';
import { Role } from '../common/rbac.constants';

/** Authenticated request context attached by JwtAuthGuard. */
export interface AuthContext {
  userId: number;
  username: string;
  role: Role;
  displayName: string;
  /** Resolved active organization (tenant). Never trust payload — derived server-side from membership. */
  organizationId: number;
  /** Resolved active branch for this request (validated). */
  branchId: number;
  branchName: string;
  /** Branches the user may operate on (spanning roles = all active branches in this org). */
  accessibleBranchIds: number[];
  spansAll: boolean;
}

export const AUTH_CTX_KEY = 'storaga.authContext';

export const CurrentAuth = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): AuthContext => {
    const req = ctx.switchToHttp().getRequest();
    return req[AUTH_CTX_KEY];
  },
);

export const RequirePermission = (...perms: string[]) => SetMetadata('storaga.perms', perms);

export const Public = () => SetMetadata('storaga.public', true);
