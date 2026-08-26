import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';

/**
 * Uniform error envelope: { statusCode, code, message }.
 * Domain codes mirror the Electron services (NO_BRANCH_ACCESS, ...).
 */
@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger(AllExceptionsFilter.name);

  catch(exception: unknown, host: ArgumentsHost) {
    const res = host.switchToHttp().getResponse();
    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const body = exception.getResponse() as Record<string, unknown> | string;
      let message: unknown;
      let code = 'ERROR';
      if (typeof body === 'string') {
        message = body;
      } else {
        message = body['message'];
        code = (body['code'] as string) || 'ERROR';
      }
      if (Array.isArray(message)) message = message[0];
      if (status === HttpStatus.BAD_REQUEST && code === 'ERROR') code = 'VALIDATION_ERROR';
      return res.status(status).json({ statusCode: status, code, message });
    }
    const msg = exception instanceof Error ? exception.message : String(exception);
    // Surface DB constraint violations as friendly domain-ish errors.
    this.logger.error(`Unhandled: ${msg}`, exception instanceof Error ? exception.stack : undefined);
    return res.status(HttpStatus.INTERNAL_SERVER_ERROR).json({
      statusCode: 500,
      code: 'INTERNAL_ERROR',
      message: 'حدث خطأ غير متوقع في الخادم',
    });
  }
}
