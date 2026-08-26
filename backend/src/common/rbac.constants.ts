/**
 * RBAC policy — ported 1:1 from src/main/auth.js (Phase 20/24 matrix).
 * Any change here must be reflected in both places until Phase 26+ unifies.
 */
export const PERMISSIONS = [
  'pos.access', 'admin.access',
  'products.read', 'products.create', 'products.update', 'products.delete',
  'inventory.read', 'inventory.adjust', 'inventory.reconcile',
  'inventory.valuation', 'inventory.cost.read', 'inventory.rules.manage',
  'categories.manage',
  'suppliers.read', 'suppliers.manage',
  'purchases.read', 'purchases.create', 'purchases.update',
  'purchases.approve', 'purchases.receive', 'purchases.cancel',
  'branches.read', 'branches.manage',
  'transfers.read', 'transfers.create', 'transfers.approve',
  'transfers.dispatch', 'transfers.receive', 'transfers.cancel',
  'sales.create', 'sales.read', 'sales.refund',
  'reports.read', 'reports.export', 'analytics.read',
  'users.manage',
  'settings.read', 'settings.prefs', 'settings.manage',
  'audit.read',
  'billing.read', 'billing.manage',
  'ai.read',
  'platform.manage', 'platform.orgs', 'platform.licenses', 'platform.plans', 'platform.usage',
] as const;

export type Permission = (typeof PERMISSIONS)[number];
export type Role = 'owner' | 'admin' | 'manager' | 'cashier';

const ALL = [...PERMISSIONS] as Permission[];

export const ROLE_PERMISSIONS: Record<Role, Permission[]> = {
  owner: ALL,
  admin: [
    'pos.access', 'admin.access',
    'products.read', 'products.create', 'products.update', 'products.delete',
    'inventory.read', 'inventory.adjust',
    'inventory.reconcile', 'inventory.valuation', 'inventory.cost.read', 'inventory.rules.manage',
    'categories.manage',
    'suppliers.read', 'suppliers.manage',
    'purchases.read', 'purchases.create', 'purchases.update',
    'purchases.approve', 'purchases.receive', 'purchases.cancel',
    'branches.read', 'branches.manage',
    'transfers.read', 'transfers.create',
    'transfers.approve', 'transfers.dispatch', 'transfers.receive', 'transfers.cancel',
    'sales.create', 'sales.read', 'sales.refund',
    'reports.read', 'reports.export', 'analytics.read', 'users.manage',
    'settings.read', 'settings.prefs', 'settings.manage',
    'audit.read',
    'billing.read', 'billing.manage',
    'ai.read',
  ],
  manager: [
    'pos.access', 'admin.access',
    'products.read', 'products.create', 'products.update', 'products.delete',
    'inventory.read', 'inventory.adjust',
    'inventory.reconcile', 'inventory.valuation', 'inventory.cost.read', 'inventory.rules.manage',
    'categories.manage',
    'suppliers.read', 'suppliers.manage',
    'purchases.read', 'purchases.create', 'purchases.update', 'purchases.receive',
    'branches.read',
    'transfers.read', 'transfers.create', 'transfers.dispatch', 'transfers.receive',
    'sales.read', 'reports.read', 'analytics.read',
    'settings.read', 'settings.prefs',
    'billing.read',
    'ai.read',
  ],
  cashier: [
    'pos.access',
    'products.read', 'inventory.read',
    'sales.create', 'sales.read',
    'settings.read', 'settings.prefs',
  ],
};

export const ROLES: Role[] = ['owner', 'admin', 'manager', 'cashier'];

/** Roles that implicitly span every branch (D4 policy). */
export function spansAllBranches(role: Role): boolean {
  return role === 'owner' || role === 'admin';
}
