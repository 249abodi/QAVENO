import { ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { SwaggerModule, DocumentBuilder } from '@nestjs/swagger';
import helmet from 'helmet';
import { ConfigService } from '@nestjs/config';
import { AppModule } from './app.module';
import { AllExceptionsFilter } from './common/all-exceptions.filter';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule, {
    logger: process.env.NODE_ENV === 'production'
      ? ['error', 'warn', 'log']
      : ['error', 'warn', 'log', 'debug', 'verbose'],
  });
  const cfg = app.get(ConfigService);

  // ── JWT secret validation ──────────────────────────────────────
  const secret = process.env.JWT_SECRET || '';
  if (process.env.NODE_ENV === 'production' && secret.length < 32) {
    throw new Error('JWT_SECRET must be set (>=32 chars) in production');
  }

  // ── Security headers ───────────────────────────────────────────
  app.use(helmet({
    contentSecurityPolicy: process.env.NODE_ENV === 'production' ? {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        imgSrc: ["'self'", 'data:'],
        connectSrc: ["'self'"],
      },
    } : false,
    crossOriginEmbedderPolicy: false,
  }));

  // ── CORS ───────────────────────────────────────────────────────
  const allowedOrigins = (process.env.CORS_ORIGINS || '').split(',').filter(Boolean);
  if (process.env.NODE_ENV === 'production') {
    // Production: strict CORS
    app.enableCors({
      origin: allowedOrigins.length > 0 ? allowedOrigins : [
        'https://qaveno.com',
        'https://www.qaveno.com',
        'https://owner.qaveno.com',
      ],
      methods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
      allowedHeaders: ['Content-Type', 'Authorization', 'X-Branch-Id', 'X-Org-Id'],
      credentials: true,
      maxAge: 86400,
    });
  } else {
    // Development: allow all origins
    app.enableCors({ origin: true, credentials: true });
  }

  // ── Global middleware ───────────────────────────────────────────
  app.setGlobalPrefix('api/v1');
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: false,
      transform: true,
      transformOptions: { enableImplicitConversion: true },
    }),
  );
  app.useGlobalFilters(new AllExceptionsFilter());
  app.enableShutdownHooks();

  // ── Health check (raw HTTP, outside NestJS routing) ─────────────
  const httpApp = app.getHttpAdapter();
  httpApp.get('/health', (_req, res) => {
    res.json({
      status: 'ok',
      version: process.env.npm_package_version || '1.0.0',
      uptime: process.uptime(),
      timestamp: new Date().toISOString(),
    });
  });

  // ── Swagger (disabled in production) ───────────────────────────
  if (cfg.get('swaggerEnabled')) {
    const doc = new DocumentBuilder()
      .setTitle('QAVENO API')
      .setDescription('QAVENO Cloud Backend')
      .setVersion('1.0')
      .addBearerAuth()
      .build();
    SwaggerModule.setup('api/docs', app, SwaggerModule.createDocument(app, doc));
  }

  const port = Number(cfg.get('port') || 3000);
  await app.listen(port);
  console.log(`[QAVENO] API listening on :${port} (env=${process.env.NODE_ENV || 'development'})`);
}

void bootstrap();
