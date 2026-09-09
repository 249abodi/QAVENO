import { Body, Controller, Get, HttpCode, Param, ParseIntPipe, Patch, Post } from '@nestjs/common';
import { RequirePermission, CurrentAuth, Public } from '../../common/auth-context';
import { AuthContext } from '../../common/auth-context';
import { OwnerService } from './owner.service';

@Controller('owner')
export class OwnerController {
  constructor(private readonly ownerSvc: OwnerService) {}

  // ── Dashboard ──────────────────────────────────────────────────

  @Get('dashboard')
  @RequirePermission('platform.manage')
  async dashboard() {
    return this.ownerSvc.getDashboard();
  }

  // ── Organizations ──────────────────────────────────────────────

  @Get('organizations')
  @RequirePermission('platform.orgs')
  async listOrgs() {
    return this.ownerSvc.listOrganizations();
  }

  @Get('organizations/:id')
  @RequirePermission('platform.orgs')
  async getOrg(@Param('id', ParseIntPipe) id: number) {
    return this.ownerSvc.getOrgDetail(id);
  }

  @Post('organizations')
  @RequirePermission('platform.orgs')
  async createOrg(
    @Body() body: { name: string; slug?: string },
    @CurrentAuth() auth: AuthContext,
  ) {
    return this.ownerSvc.createOrganization(body, auth.userId);
  }

  @Patch('organizations/:id/status')
  @RequirePermission('platform.orgs')
  async updateOrgStatus(
    @Param('id', ParseIntPipe) id: number,
    @Body() body: { status: string; reason?: string },
    @CurrentAuth() auth: AuthContext,
  ) {
    await this.ownerSvc.updateOrgStatus(id, body.status, auth.userId, body.reason ?? '');
    return { ok: true };
  }

  // ── Plans ──────────────────────────────────────────────────────

  @Get('plans')
  @RequirePermission('platform.plans')
  async listPlans() {
    return this.ownerSvc.listPlans();
  }

  @Get('plans/:id')
  @RequirePermission('platform.plans')
  async getPlan(@Param('id', ParseIntPipe) id: number) {
    return this.ownerSvc.getPlan(id);
  }

  @Post('plans')
  @RequirePermission('platform.plans')
  async createPlan(@Body() body: {
    name: string; slug: string; description?: string;
    priceMonthly?: number; priceYearly?: number; currency?: string;
    maxUsers?: number; maxBranches?: number; maxProducts?: number;
    features?: Record<string, boolean>; trialDays?: number; sortOrder?: number;
  }) {
    return this.ownerSvc.createPlan(body);
  }

  @Patch('plans/:id')
  @RequirePermission('platform.plans')
  async updatePlan(@Param('id', ParseIntPipe) id: number, @Body() body: Record<string, unknown>) {
    return this.ownerSvc.updatePlan(id, body);
  }

  @Post('plans/:id/delete')
  @HttpCode(200)
  @RequirePermission('platform.plans')
  async deletePlan(@Param('id', ParseIntPipe) id: number) {
    await this.ownerSvc.deletePlan(id);
    return { ok: true };
  }

  // ── Licenses ───────────────────────────────────────────────────

  @Post('licenses/create')
  @RequirePermission('platform.licenses')
  async createLicense(
    @Body() body: {
      organizationId: number; planId: number;
      durationDays?: number; userLimit?: number; branchLimit?: number;
      features?: Record<string, boolean>; notes?: string;
    },
    @CurrentAuth() auth: AuthContext,
  ) {
    return this.ownerSvc.createLicense(
      body.organizationId, body.planId, auth.userId,
      { durationDays: body.durationDays, userLimit: body.userLimit,
        branchLimit: body.branchLimit, features: body.features, notes: body.notes },
    );
  }

  @Get('licenses')
  @RequirePermission('platform.licenses')
  async listLicenses() {
    return this.ownerSvc.getAllLicenses();
  }

  @Get('licenses/lookup/:code')
  @RequirePermission('platform.licenses')
  async lookupLicense(@Param('code') code: string) {
    return this.ownerSvc.getLicenseByCode(code);
  }

  @Post('licenses/:id/extend')
  @HttpCode(200)
  @RequirePermission('platform.licenses')
  async extendLicense(
    @Param('id', ParseIntPipe) id: number,
    @Body() body: { days: number; force?: boolean },
    @CurrentAuth() auth: AuthContext,
  ) {
    return this.ownerSvc.extendLicense(id, body.days, auth.userId, { force: body.force });
  }

  @Post('licenses/:id/suspend')
  @HttpCode(200)
  @RequirePermission('platform.licenses')
  async suspendLicense(
    @Param('id', ParseIntPipe) id: number,
    @Body() body: { reason?: string },
    @CurrentAuth() auth: AuthContext,
  ) {
    return this.ownerSvc.suspendLicense(id, auth.userId, body.reason ?? '');
  }

  @Post('licenses/:id/revoke')
  @HttpCode(200)
  @RequirePermission('platform.licenses')
  async revokeLicense(
    @Param('id', ParseIntPipe) id: number,
    @Body() body: { reason?: string },
    @CurrentAuth() auth: AuthContext,
  ) {
    return this.ownerSvc.revokeLicense(id, auth.userId, body.reason ?? '');
  }

  @Post('licenses/:id/reactivate')
  @HttpCode(200)
  @RequirePermission('platform.licenses')
  async reactivateLicense(
    @Param('id', ParseIntPipe) id: number,
    @CurrentAuth() auth: AuthContext,
  ) {
    return this.ownerSvc.reactivateLicense(id, auth.userId);
  }

  @Post('licenses/:id/change-plan')
  @HttpCode(200)
  @RequirePermission('platform.licenses')
  async changePlan(
    @Param('id', ParseIntPipe) id: number,
    @Body() body: { planId: number },
    @CurrentAuth() auth: AuthContext,
  ) {
    return this.ownerSvc.changePlan(id, body.planId, auth.userId);
  }

  @Patch('licenses/:id/limits')
  @RequirePermission('platform.licenses')
  async updateLimits(
    @Param('id', ParseIntPipe) id: number,
    @Body() body: { userLimit?: number; branchLimit?: number; features?: Record<string, boolean> },
    @CurrentAuth() auth: AuthContext,
  ) {
    return this.ownerSvc.updateLicenseLimits(id, auth.userId, body);
  }

  @Get('licenses/history/:orgId')
  @RequirePermission('platform.licenses')
  async licenseHistory(@Param('orgId', ParseIntPipe) orgId: number) {
    return this.ownerSvc.getLicenseHistory(orgId);
  }

  // ── Public: Customer license activation ────────────────────────

  @Post('activate')
  @HttpCode(200)
  @Public()
  async activateByCode(@Body() body: { licenseCode: string; organizationId: number }) {
    return this.ownerSvc.activateLicenseByCode(body.licenseCode, body.organizationId);
  }

  // ── Public: Customer trial (server-authoritative) ────────────

  @Post('trial/start')
  @HttpCode(200)
  @Public()
  async startTrial(@Body() body: { organizationId: number; deviceFingerprint: string }) {
    if (!body.deviceFingerprint || typeof body.deviceFingerprint !== 'string') {
      return { message: 'Machine fingerprint required', code: 'FINGERPRINT_REQUIRED' };
    }
    return this.ownerSvc.startTrial(body.organizationId, body.deviceFingerprint);
  }

  @Post('trial/validate')
  @HttpCode(200)
  @Public()
  async validateTrial(@Body() body: { organizationId: number; deviceFingerprint: string }) {
    if (!body.deviceFingerprint || typeof body.deviceFingerprint !== 'string') {
      return { valid: false, status: 'none', expiresAt: null, trialToken: '' };
    }
    return this.ownerSvc.validateTrial(body.organizationId, body.deviceFingerprint);
  }

  @Post('trial/verify-token')
  @HttpCode(200)
  @Public()
  async verifyTrialToken(@Body() body: { token: string }) {
    return this.ownerSvc.verifyTrialToken(body.token);
  }

  // ── Usage ──────────────────────────────────────────────────────

  @Get('usage')
  @RequirePermission('platform.usage')
  async usage() {
    return this.ownerSvc.getUsageStats();
  }

  @Get('usage/stats')
  @RequirePermission('platform.usage')
  async usageStats() {
    return this.ownerSvc.getUsageStatsSummary();
  }
}
