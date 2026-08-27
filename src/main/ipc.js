'use strict';

const { ipcMain, shell, app, BrowserWindow } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const db = require('./db');
const pdf = require('./pdf');
const auth = require('./auth');
const purchases = require('./purchases');
const inventory = require('./inventory');
const branches = require('./branches');
const transfers = require('./transfers');
const cloud = require('./cloud/client');
const outbox = require('./cloud/outbox');
const syncEngine = require('./cloud/sync');
const dataPath = require('./data-path');

function logoDataUrl() {
  const p = path.join(app.getAppPath(), 'assets', 'logo.png');
  if (!fs.existsSync(p)) return null;
  try {
    return 'data:image/png;base64,' + fs.readFileSync(p).toString('base64');
  } catch {
    return null;
  }
}

function invoicesDir() {
  return dataPath.invoicesDir();
}

/* ---------------- authorization helpers ----------------
 * The renderer is untrusted. Every handler resolves the caller's session
 * from its webContents id (main-process state) and enforces permissions
 * here. Unknown/expired/disabled sessions fail closed.
 */

function UNAUTHORIZED_MSG() {
  return 'انتهت الجلسة. يرجى تسجيل الدخول من جديد';
}

function user(e) {
  const u = auth.userForWebContents(e.sender.id);
  if (!u) throw new Error(UNAUTHORIZED_MSG());
  return u;
}

function perm(e, p) {
  const u = user(e);
  auth.assertCan(u, p);
  return u;
}

function broadcastChanged(win, topic, payload = {}) {
  const message = {
    topic,
    ...payload,
    alerts: db.lowStockAlerts(),
    at: new Date().toISOString()
  };
  for (const w of BrowserWindow.getAllWindows()) {
    if (!w.isDestroyed()) {
      w.webContents.send('db:changed', message);
    }
  }
}

/* Resolve the caller's effective branch for a request:
   explicit branch_id (validated) -> server-side session context -> primary
   assignment -> default. The renderer is never trusted implicitly. */
function resolveBranch(e, u, requestedBranchId) {
  return branches.resolveBranchId(u, requestedBranchId, auth.getCurrentBranchId(e.sender.id));
}

function sessionBranchInfo(e, u) {
  let bid = auth.getCurrentBranchId(e.sender.id);
  if (bid == null) bid = branches.getPrimaryBranchId(u.id);
  if (bid != null && !branches.canAccessBranch(u, bid)) bid = null;
  if (bid == null && (u.role === 'owner' || u.role === 'admin')) bid = branches.DEFAULT_BRANCH_ID;
  const b = bid != null ? branches.getBranch(bid) : null;
  return b ? { id: b.id, name: b.name, code: b.code } : null;
}

function register(getAdminWindow, hooks = {}, getOwnerWindowFn) {
  const { onLogout, onLogin } = hooks;
  const getOwnerWindow = getOwnerWindowFn;

  /* ---------------- Auth ---------------- */

  // Public bootstrap for the login gate: branding + UI prefs only. No secrets.
  ipcMain.handle('auth:bootstrap', () => {
    const s = db.getSettings();
    return {
      store_name: s.store_name || '',
      lang: s.lang === 'en' ? 'en' : 'ar',
      theme: s.theme === 'dark' ? 'dark' : 'light',
      needsSetup: !auth.hasUsers()
    };
  });

  ipcMain.handle('auth:status', () => ({ needsSetup: !auth.hasUsers() }));

  ipcMain.handle('auth:setup', (e, { username, password, display_name } = {}) => {
    const pu = auth.setupOwner({ username, password, display_name });
    const { token } = auth.createSession(pu.id);
    auth.bindWindow(e.sender.id, token);
    if (onLogin) onLogin(e.sender.id, pu, token);
    return {
      user: pu,
      permissions: auth.permissionsOf({ role: pu.role, status: 'active' }),
      branch: sessionBranchInfo(e, { id: pu.id, role: pu.role, status: 'active' })
    };
  });

  ipcMain.handle('auth:login', (e, { username, password } = {}) => {
    const res = auth.authenticate(username, password);
    if (!res.ok) {
      if (res.reason === 'disabled') throw new Error('هذا الحساب معطل. راجع مدير النظام');
      // generic message: no user enumeration
      throw new Error('اسم المستخدم أو كلمة المرور غير صحيحة');
    }
    const { token } = auth.createSession(res.user.id);
    auth.bindWindow(e.sender.id, token);
    if (onLogin) onLogin(e.sender.id, res.user, token);
    return {
      user: res.user,
      permissions: auth.permissionsOf(res.user),
      branch: sessionBranchInfo(e, res.user)
    };
  });

  ipcMain.handle('auth:me', (e) => {
    const u = auth.userForWebContents(e.sender.id);
    if (!u) return { user: null, permissions: [], branch: null };
    return {
      user: auth.publicUser(u),
      permissions: auth.permissionsOf(u),
      branch: sessionBranchInfo(e, u)
    };
  });

  ipcMain.handle('auth:logout', (e) => {
    const sessionId = auth.getSessionIdFor(e.sender.id);
    if (sessionId) {
      const sessUser = auth.userForWebContents(e.sender.id);
      auth.revokeSessionById(sessionId);
      auth.audit({
        actorId: sessUser ? sessUser.id : null,
        action: 'auth.logout',
        entity_type: 'user',
        entity_id: sessUser ? sessUser.id : null
      });
    }
    if (onLogout) onLogout();
    return true;
  });

  /* ---------------- Users management ---------------- */

  ipcMain.handle('users:list', (e) => auth.listUsers(user(e)));

  ipcMain.handle('users:create', (e, payload) => auth.createUser(user(e), payload || {}));

  ipcMain.handle('users:update', (e, { id, patch } = {}) => auth.updateUser(user(e), id, patch || {}));

  ipcMain.handle('users:set-password', (e, { id, new_password, current_password } = {}) => {
    return auth.setUserPassword(user(e), id, new_password, current_password);
  });

  ipcMain.handle('users:delete', (e, id) => auth.deleteUser(user(e), id));

  /* ---------------- Audit ---------------- */

  ipcMain.handle('audit:list', (e, limit) => auth.listAudit(user(e), limit));

  /* ---------------- Products ---------------- */
  ipcMain.handle('products:list', (e, search) => { perm(e, 'products.read'); return db.listProducts(search); });
  ipcMain.handle('products:create', (e, p) => {
    perm(e, 'products.create');
    const product = db.createProduct(p);
    broadcastChanged(e.sender, 'product', { action: 'create', product });
    return product;
  });
  ipcMain.handle('products:update', (e, { id, patch }) => {
    const u = perm(e, 'products.update');
    const product = db.updateProduct(id, patch, u.id);
    broadcastChanged(e.sender, 'product', { action: 'update', product });
    // Phase 27: queue metadata replication when Cloud Mode is on (local commit
    // already succeeded — the outbox never blocks or rolls back the UI)
    try {
      const s = db.getSettings();
      if (String(s.cloud_mode || '') === '1') {
        outbox.enqueue(db, 'product.update', {
          productId: id,
          ...(patch.name !== undefined ? { name: patch.name } : {}),
          ...(patch.price !== undefined ? { price: patch.price } : {}),
          ...(patch.low_stock_threshold !== undefined ? { lowStockThreshold: patch.low_stock_threshold } : {}),
          ...(patch.reorder_qty !== undefined ? { reorderQty: patch.reorder_qty } : {}),
        });
      }
    } catch { /* outbox must never break local operation */ }
    return product;
  });
  ipcMain.handle('products:delete', (e, id) => {
    perm(e, 'products.delete');
    const res = db.deleteProduct(id);
    broadcastChanged(e.sender, 'product', { action: 'delete', productId: id });
    return res;
  });
  ipcMain.handle('products:restock', (e, { id, qty, note, branch_id } = {}) => {
    const u = perm(e, 'inventory.adjust');
    const product = db.restock(id, qty, note, { actorId: u.id, branchId: resolveBranch(e, u, branch_id) });
    broadcastChanged(e.sender, 'restock', { product });
    return product;
  });
  ipcMain.handle('products:adjust', (e, { id, quantity, branch_id } = {}) => {
    const u = perm(e, 'inventory.adjust');
    const product = db.adjustQuantity(id, quantity, { actorId: u.id, branchId: resolveBranch(e, u, branch_id) });
    broadcastChanged(e.sender, 'adjust', { product });
    return product;
  });

  /* ---------------- Advanced inventory (Phase 23) ---------------- */
  ipcMain.handle('inventory:overview', (e) => {
    perm(e, 'inventory.read');
    return inventory.overview();
  });
  ipcMain.handle('inventory:valuation', (e, filters) => {
    perm(e, 'inventory.valuation');
    return inventory.valuation(filters || {});
  });
  ipcMain.handle('inventory:movements-paged', (e, filters) => {
    perm(e, 'inventory.read');
    return inventory.listMovementsPaged(filters || {});
  });
  ipcMain.handle('inventory:adjust', (e, payload) => {
    const u = perm(e, 'inventory.adjust');
    const body = { ...(payload || {}) };
    body.branch_id = resolveBranch(e, u, body.branch_id);
    const res = inventory.adjustStock(u.id, body);
    broadcastChanged(e.sender, 'inventory-adjust', { product: res.product });
    return res;
  });
  ipcMain.handle('inventory:recon-open', (e, payload) => {
    const u = perm(e, 'inventory.reconcile');
    const body = { ...(payload || {}) };
    body.branch_id = resolveBranch(e, u, body.branch_id);
    return inventory.openReconciliation(u.id, body);
  });
  ipcMain.handle('inventory:recon-confirm', (e, id) => {
    const u = perm(e, 'inventory.reconcile');
    const res = inventory.confirmReconciliation(u.id, id);
    broadcastChanged(e.sender, 'inventory-reconcile', { product: res.product });
    return res;
  });
  ipcMain.handle('inventory:recon-cancel', (e, id) => {
    perm(e, 'inventory.reconcile');
    return inventory.cancelReconciliation(user(e).id, id);
  });
  ipcMain.handle('inventory:recons', (e, filters) => {
    perm(e, 'inventory.read');
    return inventory.listReconciliations(filters || {});
  });
  ipcMain.handle('inventory:set-rules', (e, { id, patch } = {}) => {
    const u = perm(e, 'inventory.rules.manage');
    const body = { ...(patch || {}) };
    body.branch_id = resolveBranch(e, u, body.branch_id);
    const product = inventory.setReorderRules(u.id, id, body);
    broadcastChanged(e.sender, 'product', { action: 'update', product });
    return product;
  });
  ipcMain.handle('inventory:cost-history', (e, filters) => {
    perm(e, 'inventory.cost.read');
    return inventory.costHistory(filters || {});
  });

  /* ---------------- Categories ---------------- */
  ipcMain.handle('categories:list', (e) => { perm(e, 'products.read'); return db.listCategories(); });
  ipcMain.handle('categories:create', (e, p) => {
    perm(e, 'categories.manage');
    const cat = db.createCategory(p);
    broadcastChanged(e.sender, 'category', { action: 'create', category: cat });
    return cat;
  });
  ipcMain.handle('categories:update', (e, { id, patch }) => {
    perm(e, 'categories.manage');
    const cat = db.updateCategory(id, patch);
    broadcastChanged(e.sender, 'category', { action: 'update', category: cat });
    return cat;
  });
  ipcMain.handle('categories:delete', (e, { id, moveTo }) => {
    perm(e, 'categories.manage');
    const res = db.deleteCategory(id, moveTo);
    broadcastChanged(e.sender, 'category', { action: 'delete', categoryId: id });
    return res;
  });

  /* ---------------- Suppliers ---------------- */
  ipcMain.handle('suppliers:list', (e) => { perm(e, 'suppliers.read'); return db.listSuppliers(); });
  ipcMain.handle('suppliers:create', (e, p) => {
    const u = perm(e, 'suppliers.manage');
    const sup = db.createSupplier(p || {});
    auth.audit({ actorId: u.id, action: 'supplier.create', entity_type: 'supplier', entity_id: sup.id });
    broadcastChanged(e.sender, 'supplier', { action: 'create', supplier: sup });
    return sup;
  });
  ipcMain.handle('suppliers:update', (e, { id, patch } = {}) => {
    const u = perm(e, 'suppliers.manage');
    const sup = db.updateSupplier(id, patch || {});
    auth.audit({ actorId: u.id, action: 'supplier.update', entity_type: 'supplier', entity_id: Number(id), details: { fields: Object.keys(patch || {}) } });
    broadcastChanged(e.sender, 'supplier', { action: 'update', supplier: sup });
    return sup;
  });
  ipcMain.handle('suppliers:set-status', (e, { id, status } = {}) => {
    const u = perm(e, 'suppliers.manage');
    const sup = db.setSupplierStatus(id, status);
    auth.audit({ actorId: u.id, action: 'supplier.status', entity_type: 'supplier', entity_id: Number(id), details: { status } });
    broadcastChanged(e.sender, 'supplier', { action: 'status', supplier: sup });
    return sup;
  });
  ipcMain.handle('suppliers:delete', (e, id) => {
    const u = perm(e, 'suppliers.manage');
    const res = db.deleteSupplier(id);
    auth.audit({ actorId: u.id, action: 'supplier.delete', entity_type: 'supplier', entity_id: Number(id) });
    broadcastChanged(e.sender, 'supplier', { action: 'delete', supplierId: id });
    return res;
  });

  /* ---------------- Purchasing & GRN ---------------- */
  ipcMain.handle('purchases:list', (e, filters) => {
    perm(e, 'purchases.read');
    return purchases.listPurchaseOrders(filters || {});
  });
  ipcMain.handle('purchases:get', (e, id) => {
    perm(e, 'purchases.read');
    const po = purchases.getPurchaseOrder(id);
    if (!po) throw new Error('أمر الشراء غير موجود');
    return po;
  });
  ipcMain.handle('purchases:create', (e, payload) => {
    const u = perm(e, 'purchases.create');
    const body = { ...(payload || {}) };
    body.branch_id = resolveBranch(e, u, body.branch_id);
    const po = purchases.createPurchaseOrder(u.id, body);
    auth.audit({ actorId: u.id, action: 'po.create', entity_type: 'purchase_order', entity_id: po.id, details: { ref: po.ref } });
    broadcastChanged(e.sender, 'purchase', { action: 'create', poId: po.id });
    return po;
  });
  ipcMain.handle('purchases:update', (e, { id, patch } = {}) => {
    const u = perm(e, 'purchases.update');
    const po = purchases.updatePurchaseOrder(u.id, id, patch || {});
    auth.audit({ actorId: u.id, action: 'po.update', entity_type: 'purchase_order', entity_id: Number(id) });
    broadcastChanged(e.sender, 'purchase', { action: 'update', poId: Number(id) });
    return po;
  });
  ipcMain.handle('purchases:add-item', (e, { po_id, item } = {}) => {
    const u = perm(e, 'purchases.update');
    const po = purchases.addPoItem(u.id, po_id, item || {});
    auth.audit({ actorId: u.id, action: 'po.item.add', entity_type: 'purchase_order', entity_id: Number(po_id) });
    broadcastChanged(e.sender, 'purchase', { action: 'update', poId: Number(po_id) });
    return po;
  });
  ipcMain.handle('purchases:set-item', (e, { item_id, patch } = {}) => {
    const u = perm(e, 'purchases.update');
    const po = purchases.setPoItem(u.id, item_id, patch || {});
    auth.audit({ actorId: u.id, action: 'po.item.update', entity_type: 'purchase_order', entity_id: po.id });
    broadcastChanged(e.sender, 'purchase', { action: 'update', poId: po.id });
    return po;
  });
  ipcMain.handle('purchases:remove-item', (e, item_id) => {
    const u = perm(e, 'purchases.update');
    const po = purchases.removePoItem(u.id, item_id);
    auth.audit({ actorId: u.id, action: 'po.item.remove', entity_type: 'purchase_order', entity_id: po.id });
    broadcastChanged(e.sender, 'purchase', { action: 'update', poId: po.id });
    return po;
  });
  ipcMain.handle('purchases:submit', (e, id) => {
    const u = perm(e, 'purchases.update');
    const po = purchases.submitPurchaseOrder(id);
    auth.audit({ actorId: u.id, action: 'po.submit', entity_type: 'purchase_order', entity_id: Number(id), details: { ref: po.ref } });
    broadcastChanged(e.sender, 'purchase', { action: 'submit', poId: Number(id) });
    return po;
  });
  ipcMain.handle('purchases:approve', (e, id) => {
    const u = perm(e, 'purchases.approve');
    const po = purchases.approvePurchaseOrder(u.id, id);
    auth.audit({ actorId: u.id, action: 'po.approve', entity_type: 'purchase_order', entity_id: Number(id), details: { ref: po.ref } });
    broadcastChanged(e.sender, 'purchase', { action: 'approve', poId: Number(id) });
    return po;
  });
  ipcMain.handle('purchases:cancel', (e, { id, reason } = {}) => {
    const u = perm(e, 'purchases.cancel');
    const po = purchases.cancelPurchaseOrder(id, reason);
    auth.audit({ actorId: u.id, action: 'po.cancel', entity_type: 'purchase_order', entity_id: Number(id), details: { ref: po.ref, reason: String(reason || '') } });
    broadcastChanged(e.sender, 'purchase', { action: 'cancel', poId: Number(id) });
    return po;
  });
  ipcMain.handle('purchases:receive', (e, payload) => {
    const u = perm(e, 'purchases.receive');
    const res = purchases.receiveGoods(u.id, payload || {});
    auth.audit({
      actorId: u.id,
      action: 'grn.receive',
      entity_type: 'grn',
      entity_id: res.grn.id,
      details: { ref: res.grn.ref, po_ref: res.po.ref, lines: res.grn.items.length }
    });
    broadcastChanged(e.sender, 'grn', { action: 'receive', grnId: res.grn.id, poId: res.po.id });
    return res;
  });
  ipcMain.handle('grns:list', (e, filters) => {
    perm(e, 'purchases.read');
    return purchases.listGrns(filters || {});
  });
  ipcMain.handle('grns:get', (e, id) => {
    perm(e, 'purchases.read');
    const g = purchases.getGrn(id);
    if (!g) throw new Error('سجل الاستلام غير موجود');
    return g;
  });
  ipcMain.handle('purchases:history', (e, supplierId) => {
    perm(e, 'purchases.read');
    return purchases.supplierPurchaseHistory(supplierId);
  });

  /* ---------------- Branches & user assignment (Phase 24) ---------------- */
  ipcMain.handle('branches:list', (e) => {
    const u = perm(e, 'branches.read');
    const spanning = u.role === 'owner' || u.role === 'admin';
    return branches.listBranches({ includeDisabled: spanning })
      .filter(b => spanning || branches.canAccessBranch(u, b.id));
  });
  ipcMain.handle('branches:create', (e, payload) => {
    const u = perm(e, 'branches.manage');
    return branches.createBranch(u.id, payload || {});
  });
  ipcMain.handle('branches:update', (e, { id, patch } = {}) => {
    const u = perm(e, 'branches.manage');
    return branches.updateBranch(u.id, id, patch || {});
  });
  ipcMain.handle('branches:set-status', (e, { id, status } = {}) => {
    const u = perm(e, 'branches.manage');
    return branches.setBranchStatus(u.id, id, status);
  });
  ipcMain.handle('userbranches:list', (e, userId) => {
    perm(e, 'users.manage');
    return branches.getUserBranches(userId);
  });
  ipcMain.handle('userbranches:assign', (e, { user_id, branch_id, is_primary } = {}) => {
    const u = perm(e, 'users.manage');
    return branches.assignUserBranch(u.id, user_id, branch_id, !!is_primary);
  });
  ipcMain.handle('userbranches:remove', (e, { user_id, branch_id } = {}) => {
    const u = perm(e, 'users.manage');
    return branches.removeUserBranch(u.id, user_id, branch_id);
  });

  // Switch the caller's server-side current-branch context.
  ipcMain.handle('branches:switch', (e, { branch_id } = {}) => {
    const u = user(e);
    const bid = Number(branch_id);
    if (!branches.canAccessBranch(u, bid)) {
      throw new Error('ليس لديك صلاحية على هذا الفرع');
    }
    auth.setCurrentBranch(e.sender.id, bid);
    const b = branches.getBranch(bid);
    return { id: b.id, name: b.name, code: b.code };
  });

  /* ---------------- Stock transfers (Phase 24) ---------------- */
  ipcMain.handle('transfers:list', (e, filters) => {
    const u = perm(e, 'transfers.read');
    return transfers.listTransfers(u, filters || {});
  });
  ipcMain.handle('transfers:get', (e, id) => {
    const u = perm(e, 'transfers.read');
    const t = transfers.getTransfer(id);
    if (!t) throw new Error('أمر التحويل غير موجود');
    if (!(u.role === 'owner' || u.role === 'admin')) {
      const acc = branches.accessibleBranchIds(u);
      if (!acc.includes(t.source_branch_id) && !acc.includes(t.dest_branch_id)) {
        throw new Error('ليس لديك صلاحية على هذا التحويل');
      }
    }
    return t;
  });
  ipcMain.handle('transfers:create', (e, payload) => {
    const u = perm(e, 'transfers.create');
    return transfers.createTransfer(u.id, payload || {});
  });
  ipcMain.handle('transfers:submit', (e, id) => {
    const u = perm(e, 'transfers.create');
    return transfers.submitTransfer(u.id, id);
  });
  ipcMain.handle('transfers:approve', (e, id) => {
    const u = perm(e, 'transfers.approve');
    return transfers.approveTransfer(u.id, id);
  });
  ipcMain.handle('transfers:dispatch', (e, payload) => {
    const u = perm(e, 'transfers.dispatch');
    const res = transfers.dispatchTransfer(u.id, payload || {});
    broadcastChanged(e.sender, 'transfer', { action: 'dispatch', transferId: res.id });
    return res;
  });
  ipcMain.handle('transfers:receive', (e, payload) => {
    const u = perm(e, 'transfers.receive');
    const res = transfers.receiveTransfer(u.id, payload || {});
    broadcastChanged(e.sender, 'transfer', { action: 'receive', transferId: res.id });
    return res;
  });
  ipcMain.handle('transfers:cancel', (e, { id, reason } = {}) => {
    const u = perm(e, 'transfers.cancel');
    return transfers.cancelTransfer(u.id, { id, reason });
  });

  /* ---------------- Checkout & sales ---------------- */
  ipcMain.handle('checkout', (e, order) => {
    const u = perm(e, 'sales.create');
    // Sale branch comes from the SERVER-SIDE session context, never the payload.
    const sale = db.checkout(order, { actorId: u.id, branchId: resolveBranch(e, u, null) });
    broadcastChanged(e.sender, 'sale', { saleId: sale.id, invoiceNo: sale.invoiceNo });
    return sale;
  });

  ipcMain.handle('sales:list', (e, limit) => { perm(e, 'sales.read'); return db.listSales(limit); });
  ipcMain.handle('sales:get', (e, id) => { perm(e, 'sales.read'); return db.getSale(id); });

  /* ---------------- PDF invoices ---------------- */
  ipcMain.handle('invoice:generate', async (e, saleId) => {
    perm(e, 'sales.create');
    const appPath = app.getAppPath();
    return pdf.generateInvoice(saleId, appPath);
  });
  ipcMain.handle('invoice:open', (e, filePath) => {
    perm(e, 'sales.create');
    // Security: only files we generated may be opened.
    const allowedRoot = path.resolve(invoicesDir());
    const target = path.resolve(String(filePath || ''));
    if (!target.startsWith(allowedRoot + path.sep)) {
      throw new Error('مسار غير مسموح به');
    }
    if (!fs.existsSync(target)) throw new Error('الملف غير موجود');
    shell.openPath(target);
    return true;
  });

  /* ---------------- Stats & alerts ---------------- */
  ipcMain.handle('stats:today', (e) => { perm(e, 'reports.read'); return db.todayStats(); });
  ipcMain.handle('stats:categories', (e) => { perm(e, 'reports.read'); return db.categoryStats(); });
  ipcMain.handle('alerts:lowstock', (e) => { perm(e, 'reports.read'); return db.lowStockAlerts(); });
  ipcMain.handle('movements:list', (e, limit) => { perm(e, 'inventory.read'); return db.listMovements(limit); });

  /* ---------------- Owner Control Center (proxied to cloud backend) ---------------- */
  ipcMain.handle('owner:dashboard', (e) => { perm(e, 'platform.manage'); return syncEngine.apiGet('/owner/dashboard'); });
  ipcMain.handle('owner:organizations', (e) => { perm(e, 'platform.orgs'); return syncEngine.apiGet('/owner/organizations'); });
  ipcMain.handle('owner:organization', (e, { id }) => { perm(e, 'platform.orgs'); return syncEngine.apiGet('/owner/organizations/' + id); });
  ipcMain.handle('owner:create-organization', (e, data) => { perm(e, 'platform.orgs'); return syncEngine.apiPost('/owner/organizations', data); });
  ipcMain.handle('owner:update-org-status', (e, { id, status, reason }) => { perm(e, 'platform.orgs'); return syncEngine.apiPatch('/owner/organizations/' + id + '/status', { status, reason }); });
  ipcMain.handle('owner:plans', (e) => { perm(e, 'platform.plans'); return syncEngine.apiGet('/owner/plans'); });
  ipcMain.handle('owner:plan', (e, { id }) => { perm(e, 'platform.plans'); return syncEngine.apiGet('/owner/plans/' + id); });
  ipcMain.handle('owner:create-plan', (e, data) => { perm(e, 'platform.plans'); return syncEngine.apiPost('/owner/plans', data); });
  ipcMain.handle('owner:update-plan', (e, { id, ...data }) => { perm(e, 'platform.plans'); return syncEngine.apiPatch('/owner/plans/' + id, data); });
  ipcMain.handle('owner:delete-plan', (e, { id }) => { perm(e, 'platform.plans'); return syncEngine.apiPost('/owner/plans/' + id + '/delete'); });
  ipcMain.handle('owner:licenses', (e) => { perm(e, 'platform.licenses'); return syncEngine.apiGet('/owner/licenses'); });
  ipcMain.handle('owner:create-license', (e, data) => { perm(e, 'platform.licenses'); return syncEngine.apiPost('/owner/licenses/create', data); });
  ipcMain.handle('owner:lookup-license', (e, { code }) => { perm(e, 'platform.licenses'); return syncEngine.apiGet('/owner/licenses/lookup/' + code); });
  ipcMain.handle('owner:extend-license', (e, { id, days, force }) => { perm(e, 'platform.licenses'); return syncEngine.apiPost('/owner/licenses/' + id + '/extend', { days, force }); });
  ipcMain.handle('owner:suspend-license', (e, { id, reason }) => { perm(e, 'platform.licenses'); return syncEngine.apiPost('/owner/licenses/' + id + '/suspend', { reason }); });
  ipcMain.handle('owner:revoke-license', (e, { id, reason }) => { perm(e, 'platform.licenses'); return syncEngine.apiPost('/owner/licenses/' + id + '/revoke', { reason }); });
  ipcMain.handle('owner:reactivate-license', (e, { id }) => { perm(e, 'platform.licenses'); return syncEngine.apiPost('/owner/licenses/' + id + '/reactivate'); });
  ipcMain.handle('owner:change-plan', (e, { id, planId }) => { perm(e, 'platform.licenses'); return syncEngine.apiPost('/owner/licenses/' + id + '/change-plan', { planId }); });
  ipcMain.handle('owner:update-limits', (e, { id, userLimit, branchLimit, features }) => { perm(e, 'platform.licenses'); return syncEngine.apiPatch('/owner/licenses/' + id + '/limits', { userLimit, branchLimit, features }); });
  ipcMain.handle('owner:license-history', (e, { orgId }) => { perm(e, 'platform.licenses'); return syncEngine.apiGet('/owner/licenses/history/' + orgId); });
  ipcMain.handle('owner:usage', (e) => { perm(e, 'platform.usage'); return syncEngine.apiGet('/owner/usage'); });
  ipcMain.handle('owner:activate', (e, { licenseCode, organizationId }) => {
    return syncEngine.apiPost('/owner/activate', { licenseCode, organizationId });
  });

  /* ---------------- Settings ---------------- */
  ipcMain.handle('settings:get', (e) => { perm(e, 'settings.read'); return db.getSettings(); });
  // Phase 25 transition layer: read-only cloud reachability probe (no permission gate — safe, no data exposed)
  ipcMain.handle('cloud:status', () => cloud.getStatus());
  // Phase 27 offline-first: manual sync trigger + outbox visibility
  ipcMain.handle('cloud:sync:push', (e) => { perm(e, 'settings.manage'); return syncEngine.pushPending(); });
  ipcMain.handle('cloud:sync:stats', (e) => { perm(e, 'settings.manage'); return outbox.stats(db); });
  // Phase 28 conflict management: local mirror + authoritative refresh from the cloud
  ipcMain.handle('cloud:conflicts:list', (e) => { perm(e, 'settings.manage'); return outbox.listConflicts(db); });
  ipcMain.handle('cloud:conflicts:refresh', (e) => {
    perm(e, 'settings.manage');
    return syncEngine.pullConflicts().then((r) => ({ ...r, items: outbox.listConflicts(db) }));
  });
  ipcMain.handle('cloud:conflicts:resolve', (e, { conflictId, resolution }) => {
    perm(e, 'settings.manage');
    return syncEngine.resolveConflict(conflictId, resolution);
  });
  ipcMain.handle('cloud:conflicts:retry', (e, { conflictId }) => {
    perm(e, 'settings.manage');
    return syncEngine.retryConflict(conflictId);
  });

  /* ---------------- Analytics (proxied to cloud backend) ---------------- */
  function analyticsQuery(params) {
    const p = params || {};
    const entries = Object.entries(p).filter(([, v]) => v !== undefined && v !== null && v !== '');
    return entries.length ? '?' + new URLSearchParams(entries.map(([k, v]) => [k, String(v)])).toString() : '';
  }

  ipcMain.handle('analytics:dashboard', (e, params) => { perm(e, 'analytics.read'); return syncEngine.apiGet('/analytics/dashboard' + analyticsQuery(params)); });
  ipcMain.handle('analytics:sales-trend', (e, params) => { perm(e, 'analytics.read'); return syncEngine.apiGet('/analytics/sales-trend' + analyticsQuery(params)); });
  ipcMain.handle('analytics:profit-trend', (e, params) => { perm(e, 'analytics.read'); return syncEngine.apiGet('/analytics/profit-trend' + analyticsQuery(params)); });
  ipcMain.handle('analytics:top-products', (e, params) => { perm(e, 'analytics.read'); return syncEngine.apiGet('/analytics/top-products' + analyticsQuery(params)); });
  ipcMain.handle('analytics:branch-performance', (e, params) => { perm(e, 'analytics.read'); return syncEngine.apiGet('/analytics/branch-performance' + analyticsQuery(params)); });
  ipcMain.handle('analytics:product-performance', (e, params) => { perm(e, 'analytics.read'); return syncEngine.apiGet('/analytics/product-performance' + analyticsQuery(params)); });
  ipcMain.handle('analytics:category-performance', (e, params) => { perm(e, 'analytics.read'); return syncEngine.apiGet('/analytics/category-performance' + analyticsQuery(params)); });
  ipcMain.handle('analytics:supplier-performance', (e, params) => { perm(e, 'analytics.read'); return syncEngine.apiGet('/analytics/supplier-performance' + analyticsQuery(params)); });
  ipcMain.handle('analytics:inventory-valuation', (e, params) => { perm(e, 'analytics.read'); return syncEngine.apiGet('/analytics/inventory-valuation' + analyticsQuery(params)); });
  ipcMain.handle('analytics:low-stock', (e, params) => { perm(e, 'analytics.read'); return syncEngine.apiGet('/analytics/low-stock' + analyticsQuery(params)); });
  ipcMain.handle('analytics:payment-methods', (e, params) => { perm(e, 'analytics.read'); return syncEngine.apiGet('/analytics/payment-methods' + analyticsQuery(params)); });
  ipcMain.handle('analytics:purchases', (e, params) => { perm(e, 'analytics.read'); return syncEngine.apiGet('/analytics/purchases' + analyticsQuery(params)); });
  ipcMain.handle('analytics:transfers', (e, params) => { perm(e, 'analytics.read'); return syncEngine.apiGet('/analytics/transfers' + analyticsQuery(params)); });
  ipcMain.handle('analytics:discounts', (e, params) => { perm(e, 'analytics.read'); return syncEngine.apiGet('/analytics/discounts' + analyticsQuery(params)); });
  ipcMain.handle('analytics:taxes', (e, params) => { perm(e, 'analytics.read'); return syncEngine.apiGet('/analytics/taxes' + analyticsQuery(params)); });
  ipcMain.handle('analytics:stock-movements', (e, params) => { perm(e, 'analytics.read'); return syncEngine.apiGet('/analytics/stock-movements' + analyticsQuery(params)); });
  ipcMain.handle('analytics:report-sales', (e, params) => { perm(e, 'reports.read'); return syncEngine.apiGet('/analytics/report/sales' + analyticsQuery(params)); });
  ipcMain.handle('analytics:report-profit', (e, params) => { perm(e, 'reports.read'); return syncEngine.apiGet('/analytics/report/profit' + analyticsQuery(params)); });
  ipcMain.handle('analytics:report-purchasing', (e, params) => { perm(e, 'reports.read'); return syncEngine.apiGet('/analytics/report/purchasing' + analyticsQuery(params)); });
  ipcMain.handle('analytics:report-branches', (e, params) => { perm(e, 'reports.read'); return syncEngine.apiGet('/analytics/report/branches' + analyticsQuery(params)); });
  ipcMain.handle('analytics:report-movements', (e, params) => { perm(e, 'reports.read'); return syncEngine.apiGet('/analytics/report/movements' + analyticsQuery(params)); });

  /* ---------------- AI Intelligence (proxied to cloud backend) ---------------- */
  ipcMain.handle('ai:forecast', (e) => { perm(e, 'ai.read'); return syncEngine.apiGet('/ai/forecast'); });
  ipcMain.handle('ai:anomalies', (e) => { perm(e, 'ai.read'); return syncEngine.apiGet('/ai/anomalies'); });
  ipcMain.handle('ai:reorder', (e) => { perm(e, 'ai.read'); return syncEngine.apiGet('/ai/reorder'); });
  ipcMain.handle('ai:slow-moving', (e) => { perm(e, 'ai.read'); return syncEngine.apiGet('/ai/slow-moving'); });
  ipcMain.handle('ai:summary', (e) => { perm(e, 'ai.read'); return syncEngine.apiGet('/ai/summary'); });
  ipcMain.handle('ai:cost-trend', (e) => { perm(e, 'ai.read'); return syncEngine.apiGet('/ai/cost-trend'); });
  ipcMain.handle('ai:profit-alert', (e) => { perm(e, 'ai.read'); return syncEngine.apiGet('/ai/profit-alert'); });
  ipcMain.handle('ai:insights', (e, params) => { perm(e, 'ai.read'); return syncEngine.apiGet('/ai/insights' + analyticsQuery(params)); });
  ipcMain.handle('ai:dismiss', (e, { id }) => { perm(e, 'ai.read'); return syncEngine.apiPost('/ai/insights/' + id + '/dismiss', {}); });
  ipcMain.handle('ai:refresh', (e) => { perm(e, 'ai.read'); return syncEngine.apiGet('/ai/refresh'); });

  /* ---------------- Billing (proxied to cloud backend) ---------------- */
  ipcMain.handle('billing:plans', (e) => {
    perm(e, 'settings.read');
    return syncEngine.apiGet('/billing/plans');
  });
  ipcMain.handle('billing:subscription', (e) => {
    perm(e, 'settings.manage');
    return syncEngine.apiGet('/billing/subscription');
  });
  ipcMain.handle('billing:limits', (e) => {
    perm(e, 'settings.read');
    return syncEngine.apiGet('/billing/limits');
  });
  ipcMain.handle('billing:subscribe', (e, { planSlug }) => {
    perm(e, 'settings.manage');
    return syncEngine.apiPost('/billing/subscribe', { planSlug });
  });
  ipcMain.handle('billing:cancel', (e, { reason }) => {
    perm(e, 'settings.manage');
    return syncEngine.apiPost('/billing/cancel', { reason });
  });
  ipcMain.handle('billing:renew', (e) => {
    perm(e, 'settings.manage');
    return syncEngine.apiPost('/billing/renew', {});
  });
  ipcMain.handle('billing:history', (e) => {
    perm(e, 'settings.read');
    return syncEngine.apiGet('/billing/history');
  });

  ipcMain.handle('settings:set', (e, { key, value }) => {
    const prefs = ['lang', 'theme'];
    if (!prefs.includes(key)) perm(e, 'settings.manage');
    else perm(e, 'settings.prefs');

    const allowed = ['store_name', 'tax_rate', 'currency', 'lang', 'theme'];
    if (!allowed.includes(key)) throw new Error('إعداد غير مسموح به');

    const before = key === 'lang' || key === 'theme' ? null : db.getSettings()[key];
    db.setSetting(key, value);

    if (key !== 'lang' && key !== 'theme') {
      auth.audit({
        actorId: user(e).id,
        action: 'settings.change',
        entity_type: 'setting',
        entity_id: null,
        details: { key, from: before }
      });
    }
    broadcastChanged(e.sender, 'settings', {});
    return db.getSettings();
  });

  /* ---------------- Windows ---------------- */
  ipcMain.handle('admin:open', (e) => {
    perm(e, 'admin.access');
    const win = getAdminWindow ? getAdminWindow() : null;
    if (win && !win.isDestroyed()) {
      try {
        auth.copyBinding(e.sender.id, win.webContents.id);
        // Capture the id BEFORE 'destroyed': reading win.webContents.id inside
        // the destroyed handler throws "Object has been destroyed".
        const webContentsId = win.webContents.id;
        win.webContents.once('destroyed', () => {
          try {
            auth.unbindWindow(webContentsId);
          } catch { /* window already destroyed mid-flight */ }
        });
      } catch { /* window raced closed */ }
    }
    return true;
  });

  ipcMain.handle('owner:open', (e) => {
    perm(e, 'platform.manage');
    const win = getOwnerWindow ? getOwnerWindow() : null;
    if (win && !win.isDestroyed()) {
      try {
        auth.copyBinding(e.sender.id, win.webContents.id);
        const webContentsId = win.webContents.id;
        win.webContents.once('destroyed', () => {
          try {
            auth.unbindWindow(webContentsId);
          } catch { /* window already destroyed mid-flight */ }
        });
      } catch { /* window raced closed */ }
    }
    return true;
  });
  ipcMain.handle('app:logo', () => logoDataUrl());

  /* Housekeeping: drop bindings when any window dies */
  BrowserWindow.getAllWindows().forEach(w => {
    if (!w.isDestroyed()) {
      const webContentsId = w.webContents.id;
      w.webContents.once('destroyed', () => {
        try {
          auth.unbindWindow(webContentsId);
        } catch { /* window already destroyed mid-flight */ }
      });
    }
  });
}

module.exports = { register, invoicesDir };
