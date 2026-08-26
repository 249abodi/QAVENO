/* ============================================================
   Owner Control Center — Application Logic
   ============================================================ */
(function () {
  'use strict';

  // ---- i18n ----
  const LANG = document.documentElement.lang === 'ar' ? 'ar' : 'en';
  const T = {
    ar: {
      dashboard: 'لوحة المعلومات', organizations: 'المؤسسات', plans: 'الباقات',
      licenses: 'التراخيص', usage: 'الاستخدام',
      totalOrgs: 'إجمالي المؤسسات', activeLicenses: 'التراخيص النشطة',
      totalRevenue: 'إجمالي الإيرادات', expiringSoon: 'تنتهي قريباً',
      create: 'إنشاء', edit: 'تعديل', delete: 'حذف', save: 'حفظ', cancel: 'إلغاء',
      confirm: 'تأكيد', search: 'بحث...', loading: 'جارٍ التحميل...',
      noData: 'لا توجد بيانات', deleteConfirm: 'هل أنت متأكد من الحذف؟',
      status: 'الحالة', name: 'المسمى', code: 'الرمز', email: 'البريد الإلكتروني',
      phone: 'هاتف', address: 'العنوان', notes: 'ملاحظات',
      planName: 'اسم الباقة', price: 'السعر', duration: 'المدة (يوم)',
      maxUsers: 'حد المستخدمين', maxBranches: 'حد الفروع', features: 'المزايا',
      licenseCode: 'كود الترخيص', organization: 'المؤسسة', plan: 'الباقة',
      userLimit: 'حد المستخدمين', branchLimit: 'حد الفروع',
      createdAt: 'تاريخ الإنشاء', expiresAt: 'تاريخ الانتهاء',
      active: 'نشط', pending: 'قيد الانتظار', expired: 'منتهي',
      suspended: 'معلق', revoked: 'ملغي', draft: 'مسودة', disabled: 'معطل',
      orgCreated: 'تم إنشاء المؤسسة', orgUpdated: 'تم تحديث المؤسسة',
      orgDeleted: 'تم حذف المؤسسة', planCreated: 'تم إنشاء الباقة',
      planUpdated: 'تم تحديث الباقة', planDeleted: 'تم حذف الباقة',
      licenseCreated: 'تم إنشاء الترخيص', licenseUpdated: 'تم تحديث الترخيص',
      licenseSuspended: 'تم تعليق الترخيص', licenseRevoked: 'تم إلغاء الترخيص',
      licenseReactivated: 'تم إعادة تنشيط الترخيص',
      licenseExtended: 'تم تمديد الترخيص', licensePlanChanged: 'تم تغيير باقة الترخيص',
      limitsUpdated: 'تم تحديث الحدود', statusUpdated: 'تم تحديث الحالة',
      extendDays: 'عدد أيام التمديد', extend: 'تمديد',
      suspend: 'تعليق', revoke: 'إلغاء', reactivate: 'إعادة تنشيط',
      changePlan: 'تغيير الباقة', updateLimits: 'تحديث الحدود',
      copyCode: 'انقر لنسخ الكود', copied: 'تم النسخ!',
      history: 'السجل', licenseHistory: 'سجل التراخيص',
      action: 'الإجراء', performedAt: 'التاريخ', details: 'التفاصيل',
      createLicense: 'إنشاء ترخيص جديد', createOrg: 'إنشاء مؤسسة جديدة',
      createPlan: 'إنشاء باقة جديدة',
      days: 'يوم', orgCount: 'عدد المؤسسات', licenseCount: 'عدد التراخيص',
      revenue: 'الإيرادات', totalUsers: 'إجمالي المستخدمين',
      totalBranches: 'إجمالي الفروع', recentActivity: 'النشاط الأخير',
      platformStats: 'إحصائيات المنصة', topPlans: 'الباقات الأكثر استخداماً',
      activate: 'تنشيط', activationCode: 'كود التنشيط',
      activationSuccess: 'تم تنشيط الترخيص بنجاح', activationFailed: 'فشل تنشيط الترخيص',
      directActivate: 'تنشيط مباشر',
      actionRequired: 'إجراء مطلوب',
    },
    en: {
      dashboard: 'Dashboard', organizations: 'Organizations', plans: 'Plans',
      licenses: 'Licenses', usage: 'Usage',
      totalOrgs: 'Total Organizations', activeLicenses: 'Active Licenses',
      totalRevenue: 'Total Revenue', expiringSoon: 'Expiring Soon',
      create: 'Create', edit: 'Edit', delete: 'Delete', save: 'Save', cancel: 'Cancel',
      confirm: 'Confirm', search: 'Search...', loading: 'Loading...',
      noData: 'No data', deleteConfirm: 'Are you sure you want to delete?',
      status: 'Status', name: 'Name', code: 'Code', email: 'Email',
      phone: 'Phone', address: 'Address', notes: 'Notes',
      planName: 'Plan Name', price: 'Price', duration: 'Duration (days)',
      maxUsers: 'Max Users', maxBranches: 'Max Branches', features: 'Features',
      licenseCode: 'License Code', organization: 'Organization', plan: 'Plan',
      userLimit: 'User Limit', branchLimit: 'Branch Limit',
      createdAt: 'Created At', expiresAt: 'Expires At',
      active: 'Active', pending: 'Pending', expired: 'Expired',
      suspended: 'Suspended', revoked: 'Revoked', draft: 'Draft', disabled: 'Disabled',
      orgCreated: 'Organization created', orgUpdated: 'Organization updated',
      orgDeleted: 'Organization deleted', planCreated: 'Plan created',
      planUpdated: 'Plan updated', planDeleted: 'Plan deleted',
      licenseCreated: 'License created', licenseUpdated: 'License updated',
      licenseSuspended: 'License suspended', licenseRevoked: 'License revoked',
      licenseReactivated: 'License reactivated',
      licenseExtended: 'License extended', licensePlanChanged: 'License plan changed',
      limitsUpdated: 'Limits updated', statusUpdated: 'Status updated',
      extendDays: 'Days to extend', extend: 'Extend',
      suspend: 'Suspend', revoke: 'Revoke', reactivate: 'Reactivate',
      changePlan: 'Change Plan', updateLimits: 'Update Limits',
      copyCode: 'Click to copy code', copied: 'Copied!',
      history: 'History', licenseHistory: 'License History',
      action: 'Action', performedAt: 'Date', details: 'Details',
      createLicense: 'Create New License', createOrg: 'Create New Organization',
      createPlan: 'Create New Plan',
      days: 'days', orgCount: 'Organizations', licenseCount: 'Licenses',
      revenue: 'Revenue', totalUsers: 'Total Users',
      totalBranches: 'Total Branches', recentActivity: 'Recent Activity',
      platformStats: 'Platform Statistics', topPlans: 'Top Plans',
      activate: 'Activate', activationCode: 'Activation Code',
      activationSuccess: 'License activated successfully', activationFailed: 'License activation failed',
      directActivate: 'Direct Activation',
      actionRequired: 'Action Required',
    }
  }[LANG];

  // ---- API bridge ----
  const api = window.owner || {};

  function toast(msg, type = 'success') {
    const c = document.getElementById('toastContainer');
    const t = document.createElement('div');
    t.className = 'toast toast-' + type;
    t.textContent = msg;
    c.appendChild(t);
    setTimeout(() => t.remove(), 3500);
  }

  async function apiCall(method, ...args) {
    try {
      const fn = api[method];
      if (!fn) return null;
      const res = await fn(...args);
      if (res && res.status === 'error') { toast(res.code || 'API Error', 'error'); return null; }
      if (res && res.status === 'disabled') { toast('Cloud sync is disabled', 'error'); return null; }
      return res;
    } catch (e) { toast(e.message, 'error'); return null; }
  }

  // ---- Modal helpers ----
  function openModal(title, bodyHTML, footerHTML) {
    document.getElementById('modalTitle').textContent = title;
    document.getElementById('modalBody').innerHTML = bodyHTML;
    document.getElementById('modalFooter').innerHTML = footerHTML;
    document.getElementById('modalOverlay').classList.remove('hidden');
  }

  function closeModal() { document.getElementById('modalOverlay').classList.add('hidden'); }

  document.getElementById('modalClose').onclick = closeModal;
  document.getElementById('modalOverlay').addEventListener('click', function (e) {
    if (e.target === this) closeModal();
  });

  // ---- Navigation ----
  const titles = { dashboard: T.dashboard, organizations: T.organizations, plans: T.plans, licenses: T.licenses, usage: T.usage };
  let currentTab = 'dashboard';

  function switchTab(tab) {
    currentTab = tab;
    document.querySelectorAll('.nav-item').forEach(b => b.classList.toggle('active', b.dataset.tab === tab));
    document.querySelectorAll('.tab-panel').forEach(p => p.classList.toggle('active', p.id === 'panel-' + tab));
    document.getElementById('pageTitle').textContent = titles[tab] || tab;
    renderTab(tab);
  }

  document.getElementById('sidebarNav').addEventListener('click', function (e) {
    const btn = e.target.closest('.nav-item');
    if (btn) switchTab(btn.dataset.tab);
  });

  // ---- Status badge helper ----
  function badge(status) {
    const map = { active: 'active', pending: 'pending', expired: 'expired', suspended: 'suspended', revoked: 'revoked', draft: 'draft', disabled: 'disabled' };
    const label = T[status] || status;
    return `<span class="badge badge-${map[status] || 'draft'}">${label}</span>`;
  }

  function formatDate(d) {
    if (!d) return '—';
    return new Date(d).toLocaleDateString(LANG === 'ar' ? 'ar-EG' : 'en-US', { year: 'numeric', month: 'short', day: 'numeric' });
  }

  function formatMoney(n) {
    if (n == null) return '0';
    return Number(n).toLocaleString(LANG === 'ar' ? 'ar-EG' : 'en-US');
  }

  // ---- Tab renderers ----
  async function renderTab(tab) {
    switch (tab) {
      case 'dashboard': return renderDashboard();
      case 'organizations': return renderOrganizations();
      case 'plans': return renderPlans();
      case 'licenses': return renderLicenses();
      case 'usage': return renderUsage();
    }
  }

  // ==== DASHBOARD ====
  async function renderDashboard() {
    const data = await apiCall('dashboard');
    if (!data) return;
    const p = document.getElementById('panel-dashboard');
    p.innerHTML = `
      <div class="kpi-grid">
        <div class="kpi-card accent-ai">
          <div class="kpi-label">${T.totalOrgs}</div>
          <div class="kpi-value">${formatMoney(data.stats?.totalOrgs || data.stats?.total_orgs || 0)}</div>
        </div>
        <div class="kpi-card accent-success">
          <div class="kpi-label">${T.activeLicenses}</div>
          <div class="kpi-value">${formatMoney(data.stats?.activeLicenses || data.stats?.active_licenses || 0)}</div>
        </div>
        <div class="kpi-card accent-warning">
          <div class="kpi-label">${T.expiringSoon}</div>
          <div class="kpi-value">${formatMoney(data.stats?.expiringSoon || data.stats?.expiring_soon || 0)}</div>
        </div>
        <div class="kpi-card accent-danger">
          <div class="kpi-label">${T.totalUsers}</div>
          <div class="kpi-value">${formatMoney(data.stats?.totalUsers || data.stats?.total_users || 0)}</div>
        </div>
      </div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:var(--space-lg)">
        <div class="card">
          <div class="card-header"><span class="card-title">${T.platformStats}</span></div>
          <div class="card-body">
            <table style="width:100%">
              <tr><td style="color:var(--text-muted)">${T.totalBranches}</td><td style="text-align:left;font-weight:600">${formatMoney(data.stats?.totalBranches || data.stats?.total_branches || 0)}</td></tr>
              <tr><td style="color:var(--text-muted)">${T.orgCount}</td><td style="text-align:left;font-weight:600">${formatMoney(data.stats?.totalOrgs || data.stats?.total_orgs || 0)}</td></tr>
              <tr><td style="color:var(--text-muted)">${T.licenseCount}</td><td style="text-align:left;font-weight:600">${formatMoney(data.stats?.totalLicenses || data.stats?.total_licenses || 0)}</td></tr>
            </table>
          </div>
        </div>
        <div class="card">
          <div class="card-header"><span class="card-title">${T.recentActivity}</span></div>
          <div class="card-body">
            ${(data.recentActivity || data.recent_activity || []).slice(0, 8).map(a => `
              <div style="display:flex;justify-content:space-between;padding:6px 0;border-bottom:1px solid var(--border-subtle);font-size:var(--font-size-sm)">
                <span>${a.action || a.type || '—'}</span>
                <span style="color:var(--text-muted)">${formatDate(a.performed_at || a.createdAt)}</span>
              </div>
            `).join('') || `<div class="empty-state"><div class="empty-state-icon">📊</div><div class="empty-state-text">${T.noData}</div></div>`}
          </div>
        </div>
      </div>
    `;
  }

  // ==== ORGANIZATIONS ====
  let orgs = [];
  async function renderOrganizations() {
    orgs = await apiCall('organizations') || [];
    const p = document.getElementById('panel-organizations');
    p.innerHTML = `
      <div class="toolbar">
        <div class="search-box">
          <span class="search-icon">🔍</span>
          <input type="text" placeholder="${T.search}" id="orgSearch"/>
        </div>
        <button class="btn btn-ai" id="btnCreateOrg">${T.createOrg}</button>
      </div>
      <div class="table-wrap">
        <table id="orgTable">
          <thead><tr>
            <th>#</th><th>${T.name}</th><th>${T.email}</th><th>${T.status}</th><th>${T.createdAt}</th><th></th>
          </tr></thead>
          <tbody id="orgTableBody"></tbody>
        </table>
      </div>
    `;
    document.getElementById('btnCreateOrg').onclick = () => openOrgModal();
    document.getElementById('orgSearch').oninput = (e) => renderOrgTable(e.target.value);
    renderOrgTable();
  }

  function renderOrgTable(q = '') {
    const filtered = orgs.filter(o => !q || (o.name || '').toLowerCase().includes(q.toLowerCase()));
    const tb = document.getElementById('orgTableBody');
    if (!tb) return;
    tb.innerHTML = filtered.length ? filtered.map(o => `
      <tr>
        <td>${o.id}</td>
        <td><strong>${o.name || '—'}</strong></td>
        <td>${o.email || '—'}</td>
        <td>${badge(o.status || 'active')}</td>
        <td>${formatDate(o.created_at || o.createdAt)}</td>
        <td>
          <div class="btn-group">
            <button class="btn btn-sm btn-ghost" onclick="window._ownerApp.editOrg(${o.id})">${T.edit}</button>
            <button class="btn btn-sm btn-ghost" onclick="window._ownerApp.statusOrg(${o.id})">${T.status}</button>
          </div>
        </td>
      </tr>
    `).join('') : `<tr><td colspan="6" style="text-align:center;color:var(--text-muted)">${T.noData}</td></tr>`;
  }

  function openOrgModal(org = null) {
    const isEdit = !!org;
    openModal(isEdit ? T.edit : T.createOrg, `
      <div class="form-group">
        <label class="form-label">${T.name}</label>
        <input class="form-input" id="fOrgName" value="${org?.name || ''}"/>
      </div>
      <div class="form-row">
        <div class="form-group">
          <label class="form-label">${T.email}</label>
          <input class="form-input" id="fOrgEmail" type="email" value="${org?.email || ''}"/>
        </div>
        <div class="form-group">
          <label class="form-label">${T.phone}</label>
          <input class="form-input" id="fOrgPhone" value="${org?.phone || ''}"/>
        </div>
      </div>
      <div class="form-group">
        <label class="form-label">${T.address}</label>
        <input class="form-input" id="fOrgAddress" value="${org?.address || ''}"/>
      </div>
      <div class="form-group">
        <label class="form-label">${T.notes}</label>
        <textarea class="form-textarea" id="fOrgNotes">${org?.notes || ''}</textarea>
      </div>
    `, `
      <button class="btn btn-ghost" onclick="window._ownerApp.closeModal()">${T.cancel}</button>
      <button class="btn btn-ai" id="fOrgSave">${T.save}</button>
    `);
    document.getElementById('fOrgSave').onclick = async () => {
      const payload = {
        name: document.getElementById('fOrgName').value.trim(),
        email: document.getElementById('fOrgEmail').value.trim(),
        phone: document.getElementById('fOrgPhone').value.trim(),
        address: document.getElementById('fOrgAddress').value.trim(),
        notes: document.getElementById('fOrgNotes').value.trim(),
      };
      if (!payload.name) { toast(T.name + ' مطلوب', 'error'); return; }
      const res = isEdit ? await apiCall('updateOrg', org.id, payload) : await apiCall('createOrg', payload);
      if (res) { toast(isEdit ? T.orgUpdated : T.orgCreated); closeModal(); renderOrganizations(); }
    };
  }

  async function editOrg(id) {
    const org = orgs.find(o => o.id === id);
    if (org) openOrgModal(org);
  }

  async function statusOrg(id) {
    const org = orgs.find(o => o.id === id);
    if (!org) return;
    openModal(T.status + ': ' + org.name, `
      <div class="form-group">
        <label class="form-label">${T.status}</label>
        <select class="form-select" id="fOrgStatus">
          <option value="active" ${org.status === 'active' ? 'selected' : ''}>${T.active}</option>
          <option value="disabled" ${org.status === 'disabled' ? 'selected' : ''}>${T.disabled}</option>
        </select>
      </div>
      <div class="form-group">
        <label class="form-label">${T.notes}</label>
        <textarea class="form-textarea" id="fOrgStatusReason" placeholder="${T.notes}"></textarea>
      </div>
    `, `
      <button class="btn btn-ghost" onclick="window._ownerApp.closeModal()">${T.cancel}</button>
      <button class="btn btn-primary" id="fOrgStatusSave">${T.save}</button>
    `);
    document.getElementById('fOrgStatusSave').onclick = async () => {
      const status = document.getElementById('fOrgStatus').value;
      const reason = document.getElementById('fOrgStatusReason').value.trim();
      const res = await apiCall('updateOrgStatus', id, status, reason || undefined);
      if (res) { toast(T.statusUpdated); closeModal(); renderOrganizations(); }
    };
  }

  // ==== PLANS ====
  let plans = [];
  async function renderPlans() {
    plans = await apiCall('plans') || [];
    const p = document.getElementById('panel-plans');
    p.innerHTML = `
      <div class="toolbar">
        <div class="search-box">
          <span class="search-icon">🔍</span>
          <input type="text" placeholder="${T.search}" id="planSearch"/>
        </div>
        <button class="btn btn-ai" id="btnCreatePlan">${T.createPlan}</button>
      </div>
      <div class="table-wrap">
        <table>
          <thead><tr>
            <th>#</th><th>${T.planName}</th><th>${T.price}</th><th>${T.duration}</th>
            <th>${T.maxUsers}</th><th>${T.maxBranches}</th><th></th>
          </tr></thead>
          <tbody id="planTableBody"></tbody>
        </table>
      </div>
    `;
    document.getElementById('btnCreatePlan').onclick = () => openPlanModal();
    document.getElementById('planSearch').oninput = (e) => renderPlanTable(e.target.value);
    renderPlanTable();
  }

  function renderPlanTable(q = '') {
    const filtered = plans.filter(pl => !q || (pl.name || '').toLowerCase().includes(q.toLowerCase()));
    const tb = document.getElementById('planTableBody');
    if (!tb) return;
    tb.innerHTML = filtered.length ? filtered.map(pl => `
      <tr>
        <td>${pl.id}</td>
        <td><strong>${pl.name || '—'}</strong></td>
        <td>${formatMoney(pl.price)}</td>
        <td>${pl.duration_days || pl.durationDays || '—'} ${T.days}</td>
        <td>${pl.user_limit || pl.userLimit || '—'}</td>
        <td>${pl.branch_limit || pl.branchLimit || '—'}</td>
        <td>
          <div class="btn-group">
            <button class="btn btn-sm btn-ghost" onclick="window._ownerApp.editPlan(${pl.id})">${T.edit}</button>
            <button class="btn btn-sm btn-danger" onclick="window._ownerApp.deletePlan(${pl.id})">${T.delete}</button>
          </div>
        </td>
      </tr>
    `).join('') : `<tr><td colspan="7" style="text-align:center;color:var(--text-muted)">${T.noData}</td></tr>`;
  }

  function openPlanModal(plan = null) {
    const isEdit = !!plan;
    const featuresList = plan?.features || [];
    openModal(isEdit ? T.edit : T.createPlan, `
      <div class="form-group">
        <label class="form-label">${T.planName}</label>
        <input class="form-input" id="fPlanName" value="${plan?.name || ''}"/>
      </div>
      <div class="form-row">
        <div class="form-group">
          <label class="form-label">${T.price}</label>
          <input class="form-input" id="fPlanPrice" type="number" step="0.01" value="${plan?.price || ''}"/>
        </div>
        <div class="form-group">
          <label class="form-label">${T.duration}</label>
          <input class="form-input" id="fPlanDuration" type="number" value="${plan?.duration_days || plan?.durationDays || 30}"/>
        </div>
      </div>
      <div class="form-row">
        <div class="form-group">
          <label class="form-label">${T.maxUsers}</label>
          <input class="form-input" id="fPlanUsers" type="number" value="${plan?.user_limit || plan?.userLimit || 5}"/>
        </div>
        <div class="form-group">
          <label class="form-label">${T.maxBranches}</label>
          <input class="form-input" id="fPlanBranches" type="number" value="${plan?.branch_limit || plan?.branchLimit || 1}"/>
        </div>
      </div>
      <div class="form-group">
        <label class="form-label">${T.features} (JSON array)</label>
        <textarea class="form-textarea" id="fPlanFeatures">${JSON.stringify(featuresList)}</textarea>
      </div>
    `, `
      <button class="btn btn-ghost" onclick="window._ownerApp.closeModal()">${T.cancel}</button>
      <button class="btn btn-ai" id="fPlanSave">${T.save}</button>
    `);
    document.getElementById('fPlanSave').onclick = async () => {
      let features = [];
      try { features = JSON.parse(document.getElementById('fPlanFeatures').value || '[]'); } catch (e) { features = []; }
      const payload = {
        name: document.getElementById('fPlanName').value.trim(),
        price: parseFloat(document.getElementById('fPlanPrice').value) || 0,
        durationDays: parseInt(document.getElementById('fPlanDuration').value) || 30,
        userLimit: parseInt(document.getElementById('fPlanUsers').value) || 5,
        branchLimit: parseInt(document.getElementById('fPlanBranches').value) || 1,
        features,
      };
      if (!payload.name) { toast(T.planName + ' مطلوب', 'error'); return; }
      const res = isEdit ? await apiCall('updatePlan', plan.id, payload) : await apiCall('createPlan', payload);
      if (res) { toast(isEdit ? T.planUpdated : T.planCreated); closeModal(); renderPlans(); }
    };
  }

  function editPlan(id) {
    const pl = plans.find(p => p.id === id);
    if (pl) openPlanModal(pl);
  }

  async function deletePlan(id) {
    openModal(T.delete, `<p>${T.deleteConfirm}</p>`, `
      <button class="btn btn-ghost" onclick="window._ownerApp.closeModal()">${T.cancel}</button>
      <button class="btn btn-danger" id="fPlanDelConfirm">${T.confirm}</button>
    `);
    document.getElementById('fPlanDelConfirm').onclick = async () => {
      const res = await apiCall('deletePlan', id);
      if (res !== null) { toast(T.planDeleted); closeModal(); renderPlans(); }
    };
  }

  // ==== LICENSES ====
  let licenses = [];
  async function renderLicenses() {
    licenses = await apiCall('licenses') || [];
    const p = document.getElementById('panel-licenses');
    p.innerHTML = `
      <div class="toolbar">
        <div class="search-box">
          <span class="search-icon">🔍</span>
          <input type="text" placeholder="${T.search}" id="licSearch"/>
        </div>
        <button class="btn btn-ai" id="btnCreateLicense">${T.createLicense}</button>
        <button class="btn btn-primary" id="btnDirectActivate">${T.directActivate}</button>
      </div>
      <div class="table-wrap">
        <table>
          <thead><tr>
            <th>#</th><th>${T.licenseCode}</th><th>${T.organization}</th><th>${T.plan}</th>
            <th>${T.status}</th><th>${T.expiresAt}</th><th></th>
          </tr></thead>
          <tbody id="licTableBody"></tbody>
        </table>
      </div>
    `;
    document.getElementById('btnCreateLicense').onclick = () => openCreateLicenseModal();
    document.getElementById('btnDirectActivate').onclick = () => openDirectActivateModal();
    document.getElementById('licSearch').oninput = (e) => renderLicTable(e.target.value);
    renderLicTable();
  }

  function renderLicTable(q = '') {
    const filtered = licenses.filter(l => !q || (l.license_code || l.licenseCode || '').toLowerCase().includes(q.toLowerCase()));
    const tb = document.getElementById('licTableBody');
    if (!tb) return;
    tb.innerHTML = filtered.length ? filtered.map(l => {
      const code = l.license_code || l.licenseCode || '—';
      const orgName = l.organization?.name || l.org_name || '—';
      const planName = l.plan?.name || l.plan_name || '—';
      return `
        <tr>
          <td>${l.id}</td>
          <td><code class="license-code" style="font-size:var(--font-size-xs);padding:2px 6px" title="${T.copyCode}" onclick="window._ownerApp.copyCode('${code}')">${code}</code></td>
          <td>${orgName}</td>
          <td>${planName}</td>
          <td>${badge(l.status)}</td>
          <td>${formatDate(l.expires_at || l.expiresAt)}</td>
          <td>
            <div class="btn-group">
              <button class="btn btn-sm btn-ghost" onclick="window._ownerApp.licenseActions(${l.id})">${T.actionRequired}</button>
            </div>
          </td>
        </tr>
      `;
    }).join('') : `<tr><td colspan="7" style="text-align:center;color:var(--text-muted)">${T.noData}</td></tr>`;
  }

  function openCreateLicenseModal() {
    const orgOpts = orgs.map(o => `<option value="${o.id}">${o.name}</option>`).join('');
    const planOpts = plans.map(p => `<option value="${p.id}">${p.name}</option>`).join('');
    openModal(T.createLicense, `
      <div class="form-group">
        <label class="form-label">${T.organization}</label>
        <select class="form-select" id="fLicOrg"><option value="">${T.select || '—'}</option>${orgOpts}</select>
      </div>
      <div class="form-group">
        <label class="form-label">${T.plan}</label>
        <select class="form-select" id="fLicPlan"><option value="">${T.select || '—'}</option>${planOpts}</select>
      </div>
      <div class="form-group">
        <label class="form-label">${T.notes}</label>
        <textarea class="form-textarea" id="fLicNotes"></textarea>
      </div>
    `, `
      <button class="btn btn-ghost" onclick="window._ownerApp.closeModal()">${T.cancel}</button>
      <button class="btn btn-ai" id="fLicSave">${T.save}</button>
    `);
    document.getElementById('fLicSave').onclick = async () => {
      const organizationId = parseInt(document.getElementById('fLicOrg').value);
      const planId = parseInt(document.getElementById('fLicPlan').value);
      const notes = document.getElementById('fLicNotes').value.trim();
      if (!organizationId || !planId) { toast(T.actionRequired, 'error'); return; }
      const res = await apiCall('createLicense', { organizationId, planId, notes: notes || undefined });
      if (res) {
        toast(T.licenseCreated);
        closeModal();
        const code = res.license_code || res.licenseCode;
        if (code) openModal(T.licenseCode, `
          <p style="margin-bottom:var(--space-md)">${T.licenseCode}:</p>
          <div class="license-code" onclick="window._ownerApp.copyCode('${code}')">${code}</div>
          <p style="margin-top:var(--space-sm);color:var(--text-muted);font-size:var(--font-size-sm)">${T.copyCode}</p>
        `, `<button class="btn btn-ai" onclick="window._ownerApp.closeModal()">${T.confirm}</button>`);
        renderLicenses();
      }
    };
  }

  function openDirectActivateModal() {
    const orgOpts = orgs.map(o => `<option value="${o.id}">${o.name}</option>`).join('');
    openModal(T.directActivate, `
      <div class="form-group">
        <label class="form-label">${T.activationCode}</label>
        <input class="form-input" id="fActivateCode" placeholder="XX-XX-XX-XX-XX-XX"/>
      </div>
      <div class="form-group">
        <label class="form-label">${T.organization}</label>
        <select class="form-select" id="fActivateOrg"><option value="">${T.select || '—'}</option>${orgOpts}</select>
      </div>
    `, `
      <button class="btn btn-ghost" onclick="window._ownerApp.closeModal()">${T.cancel}</button>
      <button class="btn btn-success" id="fActivateDo">${T.activate}</button>
    `);
    document.getElementById('fActivateDo').onclick = async () => {
      const code = document.getElementById('fActivateCode').value.trim();
      const organizationId = parseInt(document.getElementById('fActivateOrg').value);
      if (!code || !organizationId) { toast(T.actionRequired, 'error'); return; }
      const res = await apiCall('activate', code, organizationId);
      if (res) { toast(T.activationSuccess); closeModal(); }
      else { toast(T.activationFailed, 'error'); }
    };
  }

  function licenseActions(id) {
    const l = licenses.find(lic => lic.id === id);
    if (!l) return;
    const code = l.license_code || l.licenseCode || '—';
    const status = l.status;
    let actions = '';
    if (status === 'active') {
      actions += `<button class="btn btn-primary" onclick="window._ownerApp.extendLicenseModal(${id})">${T.extend}</button>`;
      actions += `<button class="btn btn-danger" onclick="window._ownerApp.suspendLicenseModal(${id})">${T.suspend}</button>`;
      actions += `<button class="btn btn-danger" onclick="window._ownerApp.revokeLicenseModal(${id})">${T.revoke}</button>`;
      actions += `<button class="btn btn-ghost" onclick="window._ownerApp.changePlanModal(${id})">${T.changePlan}</button>`;
      actions += `<button class="btn btn-ghost" onclick="window._ownerApp.updateLimitsModal(${id})">${T.updateLimits}</button>`;
    } else if (status === 'suspended' || status === 'expired') {
      actions += `<button class="btn btn-success" onclick="window._ownerApp.reactivateLicense(${id})">${T.reactivate}</button>`;
      actions += `<button class="btn btn-danger" onclick="window._ownerApp.revokeLicenseModal(${id})">${T.revoke}</button>`;
    } else if (status === 'pending') {
      actions += `<button class="btn btn-success" onclick="window._ownerApp.reactivateLicense(${id})">${T.reactivate}</button>`;
    } else if (status === 'revoked') {
      actions += `<button class="btn btn-success" onclick="window._ownerApp.reactivateLicense(${id})">${T.reactivate}</button>`;
    }
    actions += `<button class="btn btn-ghost" onclick="window._ownerApp.licenseHistoryModal(${id})">${T.history}</button>`;
    openModal(T.licenseCode + ': ' + code, `
      <div style="margin-bottom:var(--space-md)">${T.status}: ${badge(status)}</div>
      <div class="btn-group" style="flex-wrap:wrap">${actions}</div>
    `, '');
  }

  function extendLicenseModal(id) {
    openModal(T.extend, `
      <div class="form-group">
        <label class="form-label">${T.extendDays}</label>
        <input class="form-input" id="fExtendDays" type="number" value="30"/>
      </div>
    `, `
      <button class="btn btn-ghost" onclick="window._ownerApp.closeModal()">${T.cancel}</button>
      <button class="btn btn-primary" id="fExtendDo">${T.extend}</button>
    `);
    document.getElementById('fExtendDo').onclick = async () => {
      const days = parseInt(document.getElementById('fExtendDays').value) || 30;
      const res = await apiCall('extendLicense', id, days);
      if (res) { toast(T.licenseExtended); closeModal(); renderLicenses(); }
    };
  }

  function suspendLicenseModal(id) {
    openModal(T.suspend, `
      <div class="form-group">
        <label class="form-label">${T.notes}</label>
        <textarea class="form-textarea" id="fSuspendReason"></textarea>
      </div>
    `, `
      <button class="btn btn-ghost" onclick="window._ownerApp.closeModal()">${T.cancel}</button>
      <button class="btn btn-danger" id="fSuspendDo">${T.suspend}</button>
    `);
    document.getElementById('fSuspendDo').onclick = async () => {
      const reason = document.getElementById('fSuspendReason').value.trim();
      const res = await apiCall('suspendLicense', id, reason || undefined);
      if (res) { toast(T.licenseSuspended); closeModal(); renderLicenses(); }
    };
  }

  function revokeLicenseModal(id) {
    openModal(T.revoke, `
      <div class="form-group">
        <label class="form-label">${T.notes}</label>
        <textarea class="form-textarea" id="fRevokeReason"></textarea>
      </div>
    `, `
      <button class="btn btn-ghost" onclick="window._ownerApp.closeModal()">${T.cancel}</button>
      <button class="btn btn-danger" id="fRevokeDo">${T.revoke}</button>
    `);
    document.getElementById('fRevokeDo').onclick = async () => {
      const reason = document.getElementById('fRevokeReason').value.trim();
      const res = await apiCall('revokeLicense', id, reason || undefined);
      if (res) { toast(T.licenseRevoked); closeModal(); renderLicenses(); }
    };
  }

  async function reactivateLicense(id) {
    const res = await apiCall('reactivateLicense', id);
    if (res) { toast(T.licenseReactivated); closeModal(); renderLicenses(); }
  }

  function changePlanModal(id) {
    const planOpts = plans.map(p => `<option value="${p.id}">${p.name}</option>`).join('');
    openModal(T.changePlan, `
      <div class="form-group">
        <label class="form-label">${T.plan}</label>
        <select class="form-select" id="fChangePlan">${planOpts}</select>
      </div>
    `, `
      <button class="btn btn-ghost" onclick="window._ownerApp.closeModal()">${T.cancel}</button>
      <button class="btn btn-primary" id="fChangePlanDo">${T.save}</button>
    `);
    document.getElementById('fChangePlanDo').onclick = async () => {
      const planId = parseInt(document.getElementById('fChangePlan').value);
      const res = await apiCall('changePlan', id, planId);
      if (res) { toast(T.licensePlanChanged); closeModal(); renderLicenses(); }
    };
  }

  function updateLimitsModal(id) {
    const l = licenses.find(lic => lic.id === id);
    openModal(T.updateLimits, `
      <div class="form-row">
        <div class="form-group">
          <label class="form-label">${T.userLimit}</label>
          <input class="form-input" id="fLimitsUsers" type="number" value="${l?.user_limit || l?.userLimit || 5}"/>
        </div>
        <div class="form-group">
          <label class="form-label">${T.branchLimit}</label>
          <input class="form-input" id="fLimitsBranches" type="number" value="${l?.branch_limit || l?.branchLimit || 1}"/>
        </div>
      </div>
      <div class="form-group">
        <label class="form-label">${T.features} (JSON array)</label>
        <textarea class="form-textarea" id="fLimitsFeatures">${JSON.stringify(l?.features || [])}</textarea>
      </div>
    `, `
      <button class="btn btn-ghost" onclick="window._ownerApp.closeModal()">${T.cancel}</button>
      <button class="btn btn-primary" id="fLimitsDo">${T.save}</button>
    `);
    document.getElementById('fLimitsDo').onclick = async () => {
      const userLimit = parseInt(document.getElementById('fLimitsUsers').value);
      const branchLimit = parseInt(document.getElementById('fLimitsBranches').value);
      let features = [];
      try { features = JSON.parse(document.getElementById('fLimitsFeatures').value || '[]'); } catch (e) {}
      const res = await apiCall('updateLimits', id, userLimit, branchLimit, features);
      if (res) { toast(T.limitsUpdated); closeModal(); renderLicenses(); }
    };
  }

  async function licenseHistoryModal(id) {
    const l = licenses.find(lic => lic.id === id);
    const orgId = l?.organization_id || l?.organizationId;
    if (!orgId) { toast('Organization ID not found', 'error'); return; }
    const history = await apiCall('licenseHistory', orgId);
    const rows = history || [];
    openModal(T.licenseHistory, `
      <div class="table-wrap" style="max-height:400px;overflow-y:auto">
        <table>
          <thead><tr><th>${T.action}</th><th>${T.performedAt}</th><th>${T.details}</th></tr></thead>
          <tbody>
            ${rows.length ? rows.map(h => `
              <tr>
                <td>${h.action || '—'}</td>
                <td>${formatDate(h.performed_at || h.performedAt || h.created_at || h.createdAt)}</td>
                <td style="max-width:200px;overflow:hidden;text-overflow:ellipsis">${h.details || h.metadata || '—'}</td>
              </tr>
            `).join('') : `<tr><td colspan="3" style="text-align:center;color:var(--text-muted)">${T.noData}</td></tr>`}
          </tbody>
        </table>
      </div>
    `, `<button class="btn btn-ghost" onclick="window._ownerApp.closeModal()">${T.cancel}</button>`);
  }

  function copyCode(code) {
    navigator.clipboard.writeText(code).then(() => toast(T.copied)).catch(() => {});
  }

  // ==== USAGE ====
  async function renderUsage() {
    const data = await apiCall('usage');
    if (!data) return;
    const p = document.getElementById('panel-usage');
    p.innerHTML = `
      <div class="kpi-grid">
        <div class="kpi-card accent-ai">
          <div class="kpi-label">${T.totalUsers}</div>
          <div class="kpi-value">${formatMoney(data.totalUsers || data.total_users || 0)}</div>
        </div>
        <div class="kpi-card accent-success">
          <div class="kpi-label">${T.totalBranches}</div>
          <div class="kpi-value">${formatMoney(data.totalBranches || data.total_branches || 0)}</div>
        </div>
        <div class="kpi-card accent-warning">
          <div class="kpi-label">${T.totalOrgs}</div>
          <div class="kpi-value">${formatMoney(data.totalOrgs || data.total_orgs || 0)}</div>
        </div>
      </div>
      <div class="card" style="margin-top:var(--space-lg)">
        <div class="card-header"><span class="card-title">${T.usage}</span></div>
        <div class="card-body">
          <div class="table-wrap">
            <table>
              <thead><tr><th>${T.organization}</th><th>${T.totalUsers}</th><th>${T.totalBranches}</th></tr></thead>
              <tbody>
                ${(data.organizations || data.orgs || []).map(o => `
                  <tr>
                    <td>${o.name || o.organizationName || '—'}</td>
                    <td>${formatMoney(o.userCount || o.user_count || 0)}</td>
                    <td>${formatMoney(o.branchCount || o.branch_count || 0)}</td>
                  </tr>
                `).join('') || `<tr><td colspan="3" style="text-align:center;color:var(--text-muted)">${T.noData}</td></tr>`}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    `;
  }

  // ---- Public API for onclick handlers ----
  window._ownerApp = {
    closeModal,
    editOrg, statusOrg,
    editPlan, deletePlan,
    licenseActions, extendLicenseModal, suspendLicenseModal, revokeLicenseModal,
    reactivateLicense, changePlanModal, updateLimitsModal, licenseHistoryModal,
    copyCode,
  };

  // ---- Init ----
  switchTab('dashboard');
})();
