import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { JwtModule } from '@nestjs/jwt';
import { ThrottlerModule } from '@nestjs/throttler';

import { entitiesArray } from './database/entities';
import { configuration } from './config/configuration';
import { CommonModule } from './common/common.module';
import { EventsModule } from './events/events.module';
import { JwtAuthGuard } from './common/jwt-auth.guard';
import { PermissionsGuard } from './common/permissions.guard';
import { CustomThrottlerGuard } from './common/custom-throttler.guard';

import { AuthModule } from './modules/auth/auth.module';
import { UsersModule } from './modules/users/users.module';
import { BranchesModule } from './modules/branches/branches.module';
import { CategoriesModule } from './modules/categories/categories.module';
import { ProductsModule } from './modules/products/products.module';
import { SuppliersModule } from './modules/suppliers/suppliers.module';
import { PurchasesModule } from './modules/purchases/purchases.module';
import { InventoryModule } from './modules/inventory/inventory.module';
import { SalesModule } from './modules/sales/sales.module';
import { TransfersModule } from './modules/transfers/transfers.module';
import { SystemModule } from './modules/system/system.module';
import { SyncModule } from './modules/sync/sync.module';
import { BillingModule } from './modules/billing/billing.module';
import { AnalyticsModule } from './modules/analytics/analytics.module';
import { AiModule } from './modules/ai/ai.module';
import { OwnerModule } from './modules/owner/owner.module';

@Module({
  imports: [
    ThrottlerModule.forRoot([{
      ttl: 60_000,
      limit: 100,
    }]),
    CommonModule,
    EventsModule,
    ConfigModule.forRoot({ isGlobal: true, load: [configuration] }),
    TypeOrmModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (cfg: ConfigService) => ({
        type: 'postgres' as const,
        host: String(cfg.get('database.host')),
        port: Number(cfg.get('database.port')),
        username: String(cfg.get('database.user')),
        password: String(cfg.get('database.password') ?? ''),
        database: String(cfg.get('database.name')),
        ssl: cfg.get('database.ssl'),
        entities: entitiesArray,
        synchronize: false,
      }),
    }),
    JwtModule.registerAsync({
      inject: [ConfigService],
      useFactory: (cfg: ConfigService) => ({
        secret: cfg.get<string>('jwt.secret'),
        signOptions: { issuer: cfg.get<string>('jwt.issuer') },
      }),
    }),
    AuthModule,
    UsersModule,
    BranchesModule,
    CategoriesModule,
    ProductsModule,
    SuppliersModule,
    PurchasesModule,
    InventoryModule,
    SalesModule,
    TransfersModule,
    SystemModule,
    SyncModule,
    BillingModule,
    AnalyticsModule,
    AiModule,
    OwnerModule,
  ],
  providers: [
    { provide: APP_GUARD, useClass: CustomThrottlerGuard },
    { provide: APP_GUARD, useClass: JwtAuthGuard },
    { provide: APP_GUARD, useClass: PermissionsGuard },
  ],
})
export class AppModule {}
