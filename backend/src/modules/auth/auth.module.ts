import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { BranchAccessService } from '../../common/branch-access.service';

@Module({
  imports: [
    JwtModule.registerAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (cfg: ConfigService) => ({
        secret: cfg.get<string>('jwt.secret'),
        signOptions: { issuer: cfg.get<string>('jwt.issuer') },
      }),
    }),
  ],
  controllers: [AuthController],
  providers: [AuthService, BranchAccessService],
  exports: [AuthService],
})
export class AuthModule {}
