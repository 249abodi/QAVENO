import { HttpException, HttpStatus } from '@nestjs/common';

/**
 * Domain error carrying a stable machine code (mirrors the err.code
 * conventions of the Electron services) plus an HTTP status.
 */
export class DomainError extends HttpException {
  readonly code: string;

  constructor(message: string, code = 'INVALID_INPUT', status: HttpStatus = HttpStatus.BAD_REQUEST) {
    super({ message, code }, status);
    this.code = code;
  }
}

export const Errors = {
  unauthorized: (msg = 'مستخدم غير مصرح به') => new DomainError(msg, 'UNAUTHORIZED', HttpStatus.UNAUTHORIZED),
  forbidden: (msg = 'ليس لديك صلاحية لتنفيذ هذا الإجراء') => new DomainError(msg, 'FORBIDDEN', HttpStatus.FORBIDDEN),
  noBranchAccess: () => new DomainError('ليس لديك صلاحية على هذا الفرع', 'NO_BRANCH_ACCESS', HttpStatus.FORBIDDEN),
  notFound: (msg = 'العنصر غير موجود') => new DomainError(msg, 'NOT_FOUND', HttpStatus.NOT_FOUND),
  invalid: (msg: string) => new DomainError(msg, 'INVALID_INPUT'),
  conflict: (msg: string, code = 'CONFLICT') => new DomainError(msg, code, HttpStatus.CONFLICT),
};
