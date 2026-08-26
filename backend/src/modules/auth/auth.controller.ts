import { Body, Controller, Get, HttpCode, Post, Req } from '@nestjs/common';
import { IsOptional, IsString, MinLength } from 'class-validator';
import { AuthService } from './auth.service';
import { CurrentAuth, AuthContext, Public } from '../../common/auth-context';

export class LoginDto {
  @IsString() username!: string;
  @IsString() password!: string;
}

export class RefreshDto {
  @IsString() refreshToken!: string;
}

export class SetupOwnerDto {
  @IsString() username!: string;
  @IsString() @MinLength(8) password!: string;
  @IsOptional() @IsString() displayName?: string;
}

@Controller('auth')
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  /** Public: first-run owner creation (409 once any user exists). */
  @Public()
  @Post('setup-owner')
  @HttpCode(200)
  setupOwner(@Body() dto: SetupOwnerDto) {
    return this.auth.setupOwner(dto);
  }

  /** Public. */
  @Public()
  @Post('login')
  @HttpCode(200)
  login(@Body() dto: LoginDto) {
    return this.auth.login(dto.username, dto.password);
  }

  /** Public (refresh token in body). */
  @Public()
  @Post('refresh')
  @HttpCode(200)
  refresh(@Body() dto: RefreshDto) {
    return this.auth.refresh(dto.refreshToken);
  }

  /** Public best-effort revoke. */
  @Public()
  @Post('logout')
  @HttpCode(200)
  logout(@Body() dto: RefreshDto) {
    return this.auth.logout(dto.refreshToken).then(() => ({ ok: true }));
  }

  /** Authenticated: current profile + permissions + accessible branches. */
  @Get('me')
  me(@Req() req: { user: { id: number } }, @CurrentAuth() _ctx: AuthContext) {
    return this.auth.profilePayload(req.user.id);
  }
}
