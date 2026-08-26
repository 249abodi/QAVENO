'use strict';

const { contextBridge, ipcRenderer } = require('electron');

const onDbChanged = (callback) => {
  const listener = (_event, payload) => callback(payload);
  ipcRenderer.on('db:changed', listener);
  return () => ipcRenderer.removeListener('db:changed', listener);
};

contextBridge.exposeInMainWorld('pos', {
  products: {
    list: (search) => ipcRenderer.invoke('products:list', search),
    create: (p) => ipcRenderer.invoke('products:create', p),
    update: (id, patch) => ipcRenderer.invoke('products:update', { id, patch }),
    remove: (id) => ipcRenderer.invoke('products:delete', id),
    restock: (id, qty, note) => ipcRenderer.invoke('products:restock', { id, qty, note }),
    adjust: (id, quantity) => ipcRenderer.invoke('products:adjust', { id, quantity })
  },
  categories: {
    list: () => ipcRenderer.invoke('categories:list'),
    create: (p) => ipcRenderer.invoke('categories:create', p),
    update: (id, patch) => ipcRenderer.invoke('categories:update', { id, patch }),
    remove: (id, moveTo) => ipcRenderer.invoke('categories:delete', { id, moveTo })
  },
  suppliers: {
    list: () => ipcRenderer.invoke('suppliers:list'),
    create: (p) => ipcRenderer.invoke('suppliers:create', p),
    update: (id, patch) => ipcRenderer.invoke('suppliers:update', { id, patch }),
    setStatus: (id, status) => ipcRenderer.invoke('suppliers:set-status', { id, status }),
    remove: (id) => ipcRenderer.invoke('suppliers:delete', id)
  },
  purchases: {
    list: (filters) => ipcRenderer.invoke('purchases:list', filters),
    get: (id) => ipcRenderer.invoke('purchases:get', id),
    create: (payload) => ipcRenderer.invoke('purchases:create', payload),
    update: (id, patch) => ipcRenderer.invoke('purchases:update', { id, patch }),
    addItem: (poId, item) => ipcRenderer.invoke('purchases:add-item', { po_id: poId, item }),
    setItem: (itemId, patch) => ipcRenderer.invoke('purchases:set-item', { item_id: itemId, patch }),
    removeItem: (itemId) => ipcRenderer.invoke('purchases:remove-item', itemId),
    submit: (id) => ipcRenderer.invoke('purchases:submit', id),
    approve: (id) => ipcRenderer.invoke('purchases:approve', id),
    cancel: (id, reason) => ipcRenderer.invoke('purchases:cancel', { id, reason }),
    receive: (payload) => ipcRenderer.invoke('purchases:receive', payload),
    history: (supplierId) => ipcRenderer.invoke('purchases:history', supplierId)
  },
  grns: {
    list: (filters) => ipcRenderer.invoke('grns:list', filters),
    get: (id) => ipcRenderer.invoke('grns:get', id)
  },
  checkout: (order) => ipcRenderer.invoke('checkout', order),
  sales: {
    list: (limit) => ipcRenderer.invoke('sales:list', limit),
    get: (id) => ipcRenderer.invoke('sales:get', id)
  },
  invoices: {
    generate: (saleId) => ipcRenderer.invoke('invoice:generate', saleId),
    open: (filePath) => ipcRenderer.invoke('invoice:open', filePath)
  },
  stats: {
    today: () => ipcRenderer.invoke('stats:today'),
    categories: () => ipcRenderer.invoke('stats:categories')
  },
  alerts: {
    lowStock: () => ipcRenderer.invoke('alerts:lowstock')
  },
  movements: {
    list: (limit) => ipcRenderer.invoke('movements:list', limit)
  },
  inventory: {
    overview: () => ipcRenderer.invoke('inventory:overview'),
    valuation: (filters) => ipcRenderer.invoke('inventory:valuation', filters),
    movementsPaged: (filters) => ipcRenderer.invoke('inventory:movements-paged', filters),
    adjust: (payload) => ipcRenderer.invoke('inventory:adjust', payload),
    setRules: (id, patch) => ipcRenderer.invoke('inventory:set-rules', { id, patch }),
    costHistory: (filters) => ipcRenderer.invoke('inventory:cost-history', filters),
    recons: (filters) => ipcRenderer.invoke('inventory:recons', filters),
    reconOpen: (payload) => ipcRenderer.invoke('inventory:recon-open', payload),
    reconConfirm: (id) => ipcRenderer.invoke('inventory:recon-confirm', id),
    reconCancel: (id) => ipcRenderer.invoke('inventory:recon-cancel', id)
  },
  branches: {
    list: () => ipcRenderer.invoke('branches:list'),
    create: (payload) => ipcRenderer.invoke('branches:create', payload),
    update: (id, patch) => ipcRenderer.invoke('branches:update', { id, patch }),
    setStatus: (id, status) => ipcRenderer.invoke('branches:set-status', { id, status }),
    switch: (branchId) => ipcRenderer.invoke('branches:switch', { branch_id: branchId }),
    userList: (userId) => ipcRenderer.invoke('userbranches:list', userId),
    assign: (userId, branchId, isPrimary) =>
      ipcRenderer.invoke('userbranches:assign', { user_id: userId, branch_id: branchId, is_primary: isPrimary }),
    unassign: (userId, branchId) =>
      ipcRenderer.invoke('userbranches:remove', { user_id: userId, branch_id: branchId })
  },
  transfers: {
    list: (filters) => ipcRenderer.invoke('transfers:list', filters),
    get: (id) => ipcRenderer.invoke('transfers:get', id),
    create: (payload) => ipcRenderer.invoke('transfers:create', payload),
    submit: (id) => ipcRenderer.invoke('transfers:submit', id),
    approve: (id) => ipcRenderer.invoke('transfers:approve', id),
    dispatch: (id, lines) => ipcRenderer.invoke('transfers:dispatch', { id, lines }),
    receive: (id, lines) => ipcRenderer.invoke('transfers:receive', { id, lines }),
    cancel: (id, reason) => ipcRenderer.invoke('transfers:cancel', { id, reason })
  },
  settings: {
    get: () => ipcRenderer.invoke('settings:get'),
    set: (key, value) => ipcRenderer.invoke('settings:set', { key, value })
  },
  cloud: {
    status: () => ipcRenderer.invoke('cloud:status'),
    syncPush: () => ipcRenderer.invoke('cloud:sync:push'),
    syncStats: () => ipcRenderer.invoke('cloud:sync:stats'),
    conflictsList: () => ipcRenderer.invoke('cloud:conflicts:list'),
    conflictsRefresh: () => ipcRenderer.invoke('cloud:conflicts:refresh'),
    conflictResolve: (conflictId, resolution) => ipcRenderer.invoke('cloud:conflicts:resolve', { conflictId, resolution }),
    conflictsRetry: (conflictId) => ipcRenderer.invoke('cloud:conflicts:retry', { conflictId })
  },
  windows: {
    openAdmin: () => ipcRenderer.invoke('admin:open')
  },
  appInfo: {
    getLogo: () => ipcRenderer.invoke('app:logo')
  },
  auth: {
    bootstrap: () => ipcRenderer.invoke('auth:bootstrap'),
    status: () => ipcRenderer.invoke('auth:status'),
    login: (username, password) => ipcRenderer.invoke('auth:login', { username, password }),
    setup: (username, password, displayName) => ipcRenderer.invoke('auth:setup', { username, password, display_name: displayName }),
    me: () => ipcRenderer.invoke('auth:me'),
    logout: () => ipcRenderer.invoke('auth:logout')
  },
  license: {
    status: () => ipcRenderer.invoke('license:status'),
    activate: (licenseCode, organizationId, cloudApiBase) => ipcRenderer.invoke('license:activate', { licenseCode, organizationId, cloudApiBase }),
    startTrial: (cloudApiBase, organizationId) => ipcRenderer.invoke('license:start-trial', { cloudApiBase, organizationId }),
    clear: () => ipcRenderer.invoke('license:clear'),
    startPeriodicValidation: (cloudApiBase, organizationId) => ipcRenderer.invoke('license:start-periodic-validation', { cloudApiBase, organizationId })
  },
  users: {
    list: () => ipcRenderer.invoke('users:list'),
    create: (payload) => ipcRenderer.invoke('users:create', payload),
    update: (id, patch) => ipcRenderer.invoke('users:update', { id, patch }),
    setPassword: (id, newPassword, currentPassword) => ipcRenderer.invoke('users:set-password', { id, new_password: newPassword, current_password: currentPassword }),
    remove: (id) => ipcRenderer.invoke('users:delete', id)
  },
  analytics: {
    dashboard: (params) => ipcRenderer.invoke('analytics:dashboard', params),
    salesTrend: (params) => ipcRenderer.invoke('analytics:sales-trend', params),
    profitTrend: (params) => ipcRenderer.invoke('analytics:profit-trend', params),
    topProducts: (params) => ipcRenderer.invoke('analytics:top-products', params),
    branchPerformance: (params) => ipcRenderer.invoke('analytics:branch-performance', params),
    productPerformance: (params) => ipcRenderer.invoke('analytics:product-performance', params),
    categoryPerformance: (params) => ipcRenderer.invoke('analytics:category-performance', params),
    supplierPerformance: (params) => ipcRenderer.invoke('analytics:supplier-performance', params),
    inventoryValuation: (params) => ipcRenderer.invoke('analytics:inventory-valuation', params),
    lowStock: (params) => ipcRenderer.invoke('analytics:low-stock', params),
    paymentMethods: (params) => ipcRenderer.invoke('analytics:payment-methods', params),
    purchases: (params) => ipcRenderer.invoke('analytics:purchases', params),
    transfers: (params) => ipcRenderer.invoke('analytics:transfers', params),
    discounts: (params) => ipcRenderer.invoke('analytics:discounts', params),
    taxes: (params) => ipcRenderer.invoke('analytics:taxes', params),
    stockMovements: (params) => ipcRenderer.invoke('analytics:stock-movements', params),
    reportSales: (params) => ipcRenderer.invoke('analytics:report-sales', params),
    reportProfit: (params) => ipcRenderer.invoke('analytics:report-profit', params),
    reportPurchasing: (params) => ipcRenderer.invoke('analytics:report-purchasing', params),
    reportBranches: (params) => ipcRenderer.invoke('analytics:report-branches', params),
    reportMovements: (params) => ipcRenderer.invoke('analytics:report-movements', params)
  },
  ai: {
    forecast: () => ipcRenderer.invoke('ai:forecast'),
    anomalies: () => ipcRenderer.invoke('ai:anomalies'),
    reorder: () => ipcRenderer.invoke('ai:reorder'),
    slowMoving: () => ipcRenderer.invoke('ai:slow-moving'),
    summary: () => ipcRenderer.invoke('ai:summary'),
    costTrend: () => ipcRenderer.invoke('ai:cost-trend'),
    profitAlert: () => ipcRenderer.invoke('ai:profit-alert'),
    insights: (params) => ipcRenderer.invoke('ai:insights', params),
    dismiss: (id) => ipcRenderer.invoke('ai:dismiss', { id }),
    refresh: () => ipcRenderer.invoke('ai:refresh')
  },
  billing: {
    plans: () => ipcRenderer.invoke('billing:plans'),
    subscription: () => ipcRenderer.invoke('billing:subscription'),
    limits: () => ipcRenderer.invoke('billing:limits'),
    subscribe: (planSlug) => ipcRenderer.invoke('billing:subscribe', { planSlug }),
    cancel: (reason) => ipcRenderer.invoke('billing:cancel', { reason }),
    renew: () => ipcRenderer.invoke('billing:renew'),
    history: () => ipcRenderer.invoke('billing:history')
  },
  audit: {
    list: (limit) => ipcRenderer.invoke('audit:list', limit)
  },
  update: {
    check: () => ipcRenderer.invoke('update:check'),
    install: () => ipcRenderer.invoke('update:install'),
    version: () => ipcRenderer.invoke('update:version'),
    onAvailable: (cb) => ipcRenderer.on('update:available', (_, info) => cb(info)),
    onProgress: (cb) => ipcRenderer.on('update:progress', (_, info) => cb(info)),
    onDownloaded: (cb) => ipcRenderer.on('update:downloaded', (_, info) => cb(info))
  },
  owner: {
    dashboard: () => ipcRenderer.invoke('owner:dashboard'),
    organizations: () => ipcRenderer.invoke('owner:organizations'),
    organization: (id) => ipcRenderer.invoke('owner:organization', { id }),
    createOrganization: (data) => ipcRenderer.invoke('owner:create-organization', data),
    updateOrgStatus: (id, status, reason) => ipcRenderer.invoke('owner:update-org-status', { id, status, reason }),
    plans: () => ipcRenderer.invoke('owner:plans'),
    plan: (id) => ipcRenderer.invoke('owner:plan', { id }),
    createPlan: (data) => ipcRenderer.invoke('owner:create-plan', data),
    updatePlan: (id, data) => ipcRenderer.invoke('owner:update-plan', { id, ...data }),
    deletePlan: (id) => ipcRenderer.invoke('owner:delete-plan', { id }),
    licenses: () => ipcRenderer.invoke('owner:licenses'),
    createLicense: (data) => ipcRenderer.invoke('owner:create-license', data),
    lookupLicense: (code) => ipcRenderer.invoke('owner:lookup-license', { code }),
    extendLicense: (id, days, force) => ipcRenderer.invoke('owner:extend-license', { id, days, force }),
    suspendLicense: (id, reason) => ipcRenderer.invoke('owner:suspend-license', { id, reason }),
    revokeLicense: (id, reason) => ipcRenderer.invoke('owner:revoke-license', { id, reason }),
    reactivateLicense: (id) => ipcRenderer.invoke('owner:reactivate-license', { id }),
    changePlan: (id, planId) => ipcRenderer.invoke('owner:change-plan', { id, planId }),
    updateLimits: (id, userLimit, branchLimit, features) => ipcRenderer.invoke('owner:update-limits', { id, userLimit, branchLimit, features }),
    licenseHistory: (orgId) => ipcRenderer.invoke('owner:license-history', { orgId }),
    usage: () => ipcRenderer.invoke('owner:usage'),
    activate: (licenseCode, organizationId) => ipcRenderer.invoke('owner:activate', { licenseCode, organizationId })
  },
  onChanged: onDbChanged
});
