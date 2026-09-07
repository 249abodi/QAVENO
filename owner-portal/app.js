/* Production API base (matches owner-portal/vercel.json CSP connect-src).
   Override at deploy time by setting window.QAVENO_API_OVERRIDE in index.html
   before app.js loads; otherwise it falls back to the production URL. */
const API_BASE =
    window.QAVENO_API_OVERRIDE ||
    'https://qaveno-production.up.railway.app/api/v1';

const App = {
    token: localStorage.getItem('qaveno_owner_token'),
    currentTab: 'dashboard',

    init() {
        this.bindEvents();
        if (this.token) {
            this.checkAuth();
        } else {
            this.showLogin();
        }
        // NOTE: no handleHash() here. Loading any tab would fire unauthenticated
        // owner API calls from the login screen and surface a misleading 401 toast.
        // Data loads only after auth succeeds (via showApp() -> handleHash()).
    },

    bindEvents() {
        document.getElementById('login-form').addEventListener('submit', (e) => {
            e.preventDefault();
            this.login();
        });

        document.getElementById('logout-btn').addEventListener('click', () => this.logout());

        document.getElementById('hamburger').addEventListener('click', () => this.toggleSidebar());
        document.getElementById('sidebar-close').addEventListener('click', () => this.closeSidebar());
        document.getElementById('sidebar-overlay').addEventListener('click', () => this.closeSidebar());

        document.querySelectorAll('.nav-item').forEach(item => {
            item.addEventListener('click', (e) => {
                e.preventDefault();
                const tab = item.dataset.tab;
                window.location.hash = tab;
            });
        });

        window.addEventListener('hashchange', () => this.handleHash());

        document.getElementById('modal-overlay').addEventListener('click', (e) => {
            if (e.target === e.currentTarget) this.closeModal();
        });

        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape') this.closeModal();
        });
    },

    handleHash() {
        const hash = window.location.hash.slice(1) || 'dashboard';
        this.switchTab(hash);
    },

    // Map a failed request to a clear, user-safe Arabic message without
    // exposing server internals, while keeping enough detail to debug.
    describeError(status, raw, endpoint = '') {
        if (status === 0) {
            // Network-level failure (DNS, connection refused, CORS, backend down).
            return {
                message: 'تعذر الوصول إلى الخادم. تأكد من أن الخادم يعمل وأن اتصال الإنترنت متاح.',
                kind: 'network'
            };
        }
        switch (status) {
            case 401:
                // A 401 on the login endpoint means wrong credentials; anywhere
                // else it means the stored session is missing/expired/rejected.
                return endpoint === '/auth/login'
                    ? { message: 'اسم المستخدم أو كلمة المرور غير صحيحة', kind: 'unauthorized' }
                    : { message: 'انتهت صلاحية الجلسة، يرجى تسجيل الدخول مجدداً', kind: 'unauthorized' };
            case 403: return { message: 'ليس لديك صلاحية للوصول إلى هذا المورد', kind: 'forbidden' };
            case 404: return { message: 'المورد المطلوب غير موجود', kind: 'notfound' };
            case 429: return { message: 'طلبات كثيرة جداً. حاول مرة أخرى لاحقاً.', kind: 'ratelimit' };
            default:
                if (status >= 500) return { message: 'حدث خطأ في الخادم، حاول مرة أخرى لاحقاً', kind: 'server' };
                return { message: raw && raw !== '' ? raw : `خطأ ${status}`, kind: 'http' };
        }
    },

    async api(endpoint, options = {}) {
        const headers = {
            'Content-Type': 'application/json',
            ...(this.token ? { 'Authorization': `Bearer ${this.token}` } : {}),
            ...options.headers
        };

        let res = null;
        try {
            res = await fetch(`${API_BASE}${endpoint}`, {
                ...options,
                headers
            });
        } catch (err) {
            // fetch throws a TypeError on DNS / connection / CORS failures.
            throw new Error(this.describeError(0, null).message);
        }

        let data = {};
        try {
            data = await res.json();
        } catch {
            data = {};
        }

        if (!res.ok) {
            const msg = (data && (data.message || data.error)) || '';
            const err = new Error(this.describeError(res.status, msg, endpoint).message);
            err.status = res.status;
            err.endpoint = endpoint;
            if (res.status === 401 && endpoint !== '/auth/login') {
                // A rejected session on any protected endpoint is fatal: clear the
                // stored token and return to the login screen for a fresh sign-in.
                this.logout();
            }
            throw err;
        }

        return data;
    },

    async login() {
        const username = document.getElementById('username').value.trim();
        const password = document.getElementById('password').value;
        const errorEl = document.getElementById('login-error');
        const btn = document.getElementById('login-btn');

        if (!username || !password) {
            errorEl.textContent = 'يرجى إدخال اسم المستخدم وكلمة المرور';
            errorEl.style.display = 'block';
            return;
        }

        btn.disabled = true;
        btn.querySelector('.btn-text').style.display = 'none';
        btn.querySelector('.btn-loader').style.display = 'inline-block';
        errorEl.style.display = 'none';

        try {
            const data = await this.api('/auth/login', {
                method: 'POST',
                body: JSON.stringify({ username, password })
            });

            this.token = data.token || data.data?.token || data.accessToken;
            if (!this.token) throw new Error('لم يتم استلام الرمز');

            localStorage.setItem('qaveno_owner_token', this.token);
            this.showApp();
        } catch (err) {
            errorEl.textContent = err.message;
            errorEl.style.display = 'block';
        } finally {
            btn.disabled = false;
            btn.querySelector('.btn-text').style.display = 'inline';
            btn.querySelector('.btn-loader').style.display = 'none';
        }
    },

    async checkAuth() {
        try {
            await this.api('/auth/me');
            this.showApp();
        } catch {
            this.logout();
        }
    },

    logout() {
        this.token = null;
        localStorage.removeItem('qaveno_owner_token');
        this.showLogin();
    },

    showLogin() {
        document.getElementById('login-screen').style.display = 'flex';
        document.getElementById('app').style.display = 'none';
        document.getElementById('username').value = '';
        document.getElementById('password').value = '';
        document.getElementById('login-error').style.display = 'none';
    },

    showApp() {
        document.getElementById('login-screen').style.display = 'none';
        document.getElementById('app').style.display = 'flex';
        if (!window.location.hash) {
            window.location.hash = 'dashboard';
        } else {
            this.handleHash();
        }
    },

    switchTab(tab) {
        this.currentTab = tab;

        document.querySelectorAll('.nav-item').forEach(item => {
            item.classList.toggle('active', item.dataset.tab === tab);
        });

        document.querySelectorAll('.page').forEach(page => {
            page.classList.remove('active');
        });

        const pageEl = document.getElementById(`page-${tab}`);
        if (pageEl) pageEl.classList.add('active');

        const titles = {
            dashboard: 'لوحة التحكم',
            organizations: 'المنظمات',
            plans: 'الخطط',
            licenses: 'التراخيص',
            usage: 'الاستخدام'
        };
        document.getElementById('page-title').textContent = titles[tab] || tab;

        this.loadTab(tab);
        this.closeSidebar();
    },

    async loadTab(tab) {
        // Never fetch owner data without a valid session: unauthenticated calls
        // would 401 and show a misleading error while the login screen is visible.
        if (!this.token) return;
        switch (tab) {
            case 'dashboard': await this.loadDashboard(); break;
            case 'organizations': await this.loadOrganizations(); break;
            case 'plans': await this.loadPlans(); break;
            case 'licenses': await this.loadLicenses(); break;
            case 'usage': await this.loadUsage(); break;
        }
    },

    toggleSidebar() {
        document.getElementById('sidebar').classList.toggle('open');
        document.getElementById('sidebar-overlay').classList.toggle('active');
    },

    closeSidebar() {
        document.getElementById('sidebar').classList.remove('open');
        document.getElementById('sidebar-overlay').classList.remove('active');
    },

    /* ==================== DASHBOARD ==================== */
    async loadDashboard() {
        try {
            const data = await this.api('/owner/dashboard');
            const stats = data.data || data;

            document.getElementById('stat-total-orgs').textContent = stats.totalOrgs ?? stats.totalOrganizations ?? stats.total_orgs ?? '-';
            document.getElementById('stat-active-orgs').textContent = stats.activeOrgs ?? stats.activeOrganizations ?? stats.active_orgs ?? '-';
            document.getElementById('stat-active-licenses').textContent = stats.activeLicenses ?? stats.active_licenses ?? '-';

            const recent = stats.recentActivity ?? stats.recentActivities ?? stats.activities ?? stats.recent_activity_list ?? [];
            document.getElementById('stat-recent-activity').textContent = Array.isArray(recent) ? recent.length : (recent ?? '-');
            this.renderActivityList(Array.isArray(recent) ? recent : []);
        } catch (err) {
            this.toast('خطأ في تحميل لوحة التحكم: ' + err.message, 'error');
        }
    },

    renderActivityList(activities) {
        const container = document.getElementById('recent-activity-list');
        if (!activities.length) {
            container.innerHTML = '<div class="empty-state">لا يوجد نشاط حديث</div>';
            return;
        }

        container.innerHTML = activities.map(a => `
            <div class="activity-item">
                <div class="activity-dot ${a.type || a.action || 'primary'}"></div>
                <div class="activity-text">${a.reason || a.message || this.historyLabel(a.action) || a.description || a.text || a.action || ''}</div>
                <div class="activity-time">${this.formatDate(a.createdAt || a.created_at || a.timestamp)}</div>
            </div>
        `).join('');
    },

    /* ==================== ORGANIZATIONS ==================== */
    async loadOrganizations() {
        try {
            const data = await this.api('/owner/organizations');
            const orgs = data.data || data.organizations || data || [];
            this.renderOrganizations(Array.isArray(orgs) ? orgs : []);
        } catch (err) {
            this.toast('خطأ في تحميل المنظمات: ' + err.message, 'error');
        }
    },

    renderOrganizations(orgs) {
        const tbody = document.getElementById('organizations-table');
        if (!orgs.length) {
            tbody.innerHTML = '<tr><td colspan="6" class="empty-state">لا توجد منظمات</td></tr>';
            return;
        }

        tbody.innerHTML = orgs.map(item => {
            const org = item.organization || item;
            const orgId = org.id != null ? org.id : org._id;
            const adminMember = (item.members || []).find(m => m.role === 'owner' || m.role === 'admin');
            const adminName = (adminMember && adminMember.displayName) || org.admin?.name || org.adminName || org.admin || '-';
            return `
            <tr>
                <td>${orgId != null ? orgId : '-'}</td>
                <td>${org.name || org.organizationName || '-'}</td>
                <td>${adminName}</td>
                <td>${this.statusBadge(org.status)}</td>
                <td>${this.formatDate(org.createdAt || org.created_at)}</td>
                <td>
                    <div class="action-btns">
                        <button class="btn btn-sm btn-ghost" onclick="App.showOrgDetail('${orgId}')">عرض</button>
                        <select class="btn btn-sm" onchange="App.updateOrgStatus('${orgId}', this.value)" style="padding: 4px 8px; font-size: 12px; border: 1px solid var(--border); border-radius: var(--radius); direction: rtl;">
                            <option value="">تغيير الحالة</option>
                            <option value="active" ${org.status === 'active' ? 'disabled' : ''}>نشط</option>
                            <option value="suspended" ${org.status === 'suspended' ? 'disabled' : ''}>معلق</option>
                            <option value="disabled" ${org.status === 'disabled' ? 'disabled' : ''}>معطل</option>
                        </select>
                    </div>
                </td>
            </tr>`;
        }).join('');
    },

    async showOrgDetail(id) {
        if (!id) {
            this.showModal('إضافة منظمة جديدة', `
                <div class="form-group">
                    <label>اسم المنظمة</label>
                    <input type="text" id="new-org-name" placeholder="أدخل اسم المنظمة">
                </div>
                <div class="form-group">
                    <label>اسم المدير</label>
                    <input type="text" id="new-org-admin" placeholder="أدخل اسم المدير">
                </div>
                <div class="form-group">
                    <label>البريد الإلكتروني</label>
                    <input type="email" id="new-org-email" placeholder="أدخل البريد الإلكتروني">
                </div>
            `, [
                { text: 'إلغاء', class: 'btn btn-ghost', action: 'App.closeModal()' },
                { text: 'إضافة', class: 'btn btn-primary', action: 'App.createOrg()' }
            ]);
            return;
        }

        try {
            const data = await this.api(`/owner/organizations/${id}`);
            const item = data.data || data;
            const org = item.organization || item;
            const adminMember = (item.members || []).find(m => m.role === 'owner' || m.role === 'admin');
            const adminName = (adminMember && adminMember.displayName) || org.admin?.name || org.adminName || org.admin || '-';

            this.showModal(`تفاصيل المنظمة: ${org.name || org.organizationName || ''}`, `
                <div class="detail-grid">
                    <div class="detail-item">
                        <label>المعرف</label>
                        <span>${org.id != null ? org.id : (org._id || '-')}</span>
                    </div>
                    <div class="detail-item">
                        <label>الاسم</label>
                        <span>${org.name || org.organizationName || '-'}</span>
                    </div>
                    <div class="detail-item">
                        <label>المدير</label>
                        <span>${adminName}</span>
                    </div>
                    <div class="detail-item">
                        <label>البريد الإلكتروني</label>
                        <span>${org.email || adminMember?.email || '-'}</span>
                    </div>
                    <div class="detail-item">
                        <label>الحالة</label>
                        <span>${this.statusBadge(org.status)}</span>
                    </div>
                    <div class="detail-item">
                        <label>تاريخ الإنشاء</label>
                        <span>${this.formatDate(org.createdAt || org.created_at)}</span>
                    </div>
                    <div class="detail-item">
                        <label>عدد المستخدمين</label>
                        <span>${item.userCount ?? org.users_count ?? '-'}</span>
                    </div>
                    <div class="detail-item">
                        <label>الخطة</label>
                        <span>${item.plan?.name || org.planName || '-'}</span>
                    </div>
                </div>
            `, [
                { text: 'إغلاق', class: 'btn btn-ghost', action: 'App.closeModal()' }
            ]);
        } catch (err) {
            this.toast('خطأ في تحميل تفاصيل المنظمة: ' + err.message, 'error');
        }
    },

    async createOrg() {
        const name = document.getElementById('new-org-name').value.trim();
        const admin = document.getElementById('new-org-admin').value.trim();
        const email = document.getElementById('new-org-email').value.trim();

        if (!name) {
            this.toast('يرجى إدخال اسم المنظمة', 'warning');
            return;
        }

        try {
            await this.api('/owner/organizations', {
                method: 'POST',
                body: JSON.stringify({ name, admin, email })
            });
            this.toast('تم إنشاء المنظمة بنجاح', 'success');
            this.closeModal();
            this.loadOrganizations();
        } catch (err) {
            this.toast('خطأ في إنشاء المنظمة: ' + err.message, 'error');
        }
    },

    async updateOrgStatus(id, status) {
        if (!status) return;

        const statusLabels = { active: 'نشط', suspended: 'معلق', disabled: 'معطل' };
        if (!confirm(`هل تريد تغيير حالة المنظمة إلى "${statusLabels[status]}"؟`)) return;

        try {
            await this.api(`/owner/organizations/${id}/status`, {
                method: 'PATCH',
                body: JSON.stringify({ status })
            });
            this.toast('تم تحديث حالة المنظمة بنجاح', 'success');
            this.loadOrganizations();
        } catch (err) {
            this.toast('خطأ في تحديث الحالة: ' + err.message, 'error');
        }
    },

    /* ==================== PLANS ==================== */
    async loadPlans() {
        try {
            const data = await this.api('/owner/plans');
            const plans = data.data || data.plans || data || [];
            this.renderPlans(Array.isArray(plans) ? plans : []);
        } catch (err) {
            this.toast('خطأ في تحميل الخطط: ' + err.message, 'error');
        }
    },

    renderPlans(plans) {
        const tbody = document.getElementById('plans-table');
        if (!plans.length) {
            tbody.innerHTML = '<tr><td colspan="6" class="empty-state">لا توجد خطط</td></tr>';
            return;
        }

        tbody.innerHTML = plans.map(plan => `
            <tr>
                <td>${plan.id || plan._id || '-'}</td>
                <td>${plan.name || '-'}</td>
                <td>${plan.price != null ? plan.price + ' ر.س' : '-'}</td>
                <td>${plan.maxUsers ?? plan.max_users ?? '-'}</td>
                <td>${this.statusBadge(plan.status || (plan.isActive !== false ? 'active' : 'inactive'))}</td>
                <td>
                    <div class="action-btns">
                        <button class="btn btn-sm btn-primary" onclick='App.showPlanModal(${JSON.stringify(plan).replace(/'/g, "&#39;")})'>تعديل</button>
                        <button class="btn btn-sm btn-danger" onclick="App.deletePlan('${plan.id || plan._id}')">حذف</button>
                    </div>
                </td>
            </tr>
        `).join('');
    },

    showPlanModal(plan = null) {
        const isEdit = !!plan;
        const title = isEdit ? 'تعديل الخطة' : 'إضافة خطة جديدة';

        this.showModal(title, `
            <div class="form-group">
                <label>اسم الخطة</label>
                <input type="text" id="plan-name" value="${plan?.name || ''}" placeholder="أدخل اسم الخطة">
            </div>
            <div class="form-group">
                <label>السعر (ر.س)</label>
                <input type="number" id="plan-price" value="${plan?.price ?? ''}" placeholder="أدخل السعر" min="0" step="0.01">
            </div>
            <div class="form-group">
                <label>الحد الأقصى للمستخدمين</label>
                <input type="number" id="plan-max-users" value="${plan?.maxUsers ?? plan?.max_users ?? ''}" placeholder="أدخل الحد الأقصى" min="1">
            </div>
            <div class="form-group">
                <label>الوصف</label>
                <input type="text" id="plan-description" value="${plan?.description || ''}" placeholder="أدخل وصف الخطة">
            </div>
            <div class="form-group">
                <label>الحالة</label>
                <select id="plan-status">
                    <option value="active" ${(plan?.status === 'active' || plan?.isActive) ? 'selected' : ''}>نشط</option>
                    <option value="inactive" ${plan?.status === 'inactive' ? 'selected' : ''}>غير نشط</option>
                </select>
            </div>
        `, [
            { text: 'إلغاء', class: 'btn btn-ghost', action: 'App.closeModal()' },
            { text: isEdit ? 'حفظ التعديلات' : 'إضافة', class: 'btn btn-primary', action: isEdit ? `App.updatePlan('${plan.id || plan._id}')` : 'App.createPlan()' }
        ]);
    },

    async createPlan() {
        const name = document.getElementById('plan-name').value.trim();
        const price = document.getElementById('plan-price').value;
        const maxUsers = document.getElementById('plan-max-users').value;
        const description = document.getElementById('plan-description').value.trim();
        const status = document.getElementById('plan-status').value;

        if (!name) {
            this.toast('يرجى إدخال اسم الخطة', 'warning');
            return;
        }

        try {
            await this.api('/owner/plans', {
                method: 'POST',
                body: JSON.stringify({
                    name,
                    price: price ? parseFloat(price) : undefined,
                    maxUsers: maxUsers ? parseInt(maxUsers) : undefined,
                    description,
                    status
                })
            });
            this.toast('تم إنشاء الخطة بنجاح', 'success');
            this.closeModal();
            this.loadPlans();
        } catch (err) {
            this.toast('خطأ في إنشاء الخطة: ' + err.message, 'error');
        }
    },

    async updatePlan(id) {
        const name = document.getElementById('plan-name').value.trim();
        const price = document.getElementById('plan-price').value;
        const maxUsers = document.getElementById('plan-max-users').value;
        const description = document.getElementById('plan-description').value.trim();
        const status = document.getElementById('plan-status').value;

        if (!name) {
            this.toast('يرجى إدخال اسم الخطة', 'warning');
            return;
        }

        try {
            await this.api(`/owner/plans/${id}`, {
                method: 'PATCH',
                body: JSON.stringify({
                    name,
                    price: price ? parseFloat(price) : undefined,
                    maxUsers: maxUsers ? parseInt(maxUsers) : undefined,
                    description,
                    status
                })
            });
            this.toast('تم تحديث الخطة بنجاح', 'success');
            this.closeModal();
            this.loadPlans();
        } catch (err) {
            this.toast('خطأ في تحديث الخطة: ' + err.message, 'error');
        }
    },

    async deletePlan(id) {
        if (!confirm('هل أنت متأكد من حذف هذه الخطة؟')) return;

        try {
            await this.api(`/owner/plans/${id}/delete`, { method: 'POST' });
            this.toast('تم حذف الخطة بنجاح', 'success');
            this.loadPlans();
        } catch (err) {
            this.toast('خطأ في حذف الخطة: ' + err.message, 'error');
        }
    },

    /* ==================== LICENSES ==================== */
    async loadLicenses() {
        try {
            const data = await this.api('/owner/licenses');
            const licenses = data.data || data.licenses || data || [];
            this.renderLicenses(Array.isArray(licenses) ? licenses : []);
        } catch (err) {
            this.toast('خطأ في تحميل التراخيص: ' + err.message, 'error');
        }
    },

    renderLicenses(licenses) {
        const tbody = document.getElementById('licenses-table');
        if (!licenses.length) {
            tbody.innerHTML = '<tr><td colspan="7" class="empty-state">لا توجد تراخيص</td></tr>';
            return;
        }

        tbody.innerHTML = licenses.map(lic => {
            const displayStatus = lic.trialStatus || lic.status;
            // Fall back to field variants depending on backend serialization
            const orgName = lic.organizationName || lic.organization?.name || lic.orgName || lic.organization_id || '-';
            const planName = lic.planName || lic.plan?.name || lic.planNameFallback || lic.plan_id || '-';
            const exp = lic.trialExpiresAt || lic.expiresAt || lic.expires_at || lic.endDate;
            const id = lic.id ?? lic._id ?? lic.subscriptionId;
            return `
            <tr>
                <td>${id ?? '-'}</td>
                <td style="font-family: monospace; font-size: 12px;">${lic.licenseCode || lic.key || lic.license_key || (lic.type === 'trial' ? 'Trial' : '-')}</td>
                <td>${orgName}</td>
                <td>${planName}</td>
                <td>${this.statusBadge(displayStatus)}</td>
                <td>${this.formatDate(exp)}</td>
                <td>
                    <div class="action-btns">
                        <button class="btn btn-sm" onclick="App.showLicenseDetail('${id}')">تفاصيل</button>
                        <select class="btn btn-sm" onchange="App.licenseAction('${id}', this.value); this.value='';" style="padding:4px 8px;font-size:12px;border:1px solid var(--border);border-radius:var(--radius);direction:rtl;">
                            <option value="">إجراءات</option>
                            <option value="extend">تمديد</option>
                            <option value="suspend" ${displayStatus === 'active' || displayStatus === 'trialing' ? '' : 'disabled'}>تعليق</option>
                            <option value="reactivate" ${displayStatus === 'suspended' ? '' : 'disabled'}>إعادة تنشيط</option>
                            <option value="revoke">إلغاء</option>
                        </select>
                    </div>
                </td>
            </tr>`;
        }).join('');

        // Remember rows for the detail modal
        this._licenses = licenses;
    },

    /** Optional inline dataset lookup for a license by id. */
    _licenses: [],

    async showLicenseDetail(id) {
        const lic = (this._licenses || []).find(l => String(l.id ?? l._id) === String(id));
        if (!lic) {
            this.toast('تعذر العثور على تفاصيل الترخيص', 'error');
            return;
        }

        const displayStatus = lic.trialStatus || lic.status;
        const trial = lic.type === 'trial' || lic.trialEndsAt || displayStatus === 'trialing';
        const orgName = lic.organizationName || lic.organization?.name || '-';
        const planName = lic.planName || lic.plan?.name || '-';

        let quickActions = '';
        if (trial) {
            quickActions = `
                <div class="trial-actions" style="margin-bottom:16px">
                    <button class="btn btn-primary btn-sm" onclick="App.extendLicenseDays('${lic.id}', 1)">تمديد 24 ساعة</button>
                    <button class="btn btn-primary btn-sm" onclick="App.extendLicenseDays('${lic.id}', 7)">تمديد 7 أيام</button>
                    <button class="btn btn-primary btn-sm" onclick="App.extendLicenseDays('${lic.id}', 30)">تمديد 30 يوماً</button>
                </div>`;
        }

        const remainingText = (lic.trialRemainingMs != null)
            ? this.formatDuration(lic.trialRemainingMs)
            : '—';

        const history = await this.loadLicenseHistoryFor(lic.organizationId);

        this.showModal(`تفاصيل الترخيص — ${orgName}`, `
            ${quickActions}
            <div class="detail-grid" style="display:grid;gap:8px;margin-bottom:16px">
                <div class="form-group"><label>المعرف</label><div>${lic.id ?? '-'}</div></div>
                <div class="form-group"><label>رمز الترخيص</label><div style="font-family:monospace" dir="ltr">${lic.licenseCode || lic.key || '-'}</div></div>
                <div class="form-group"><label>المنظمة</label><div>${orgName}</div></div>
                <div class="form-group"><label>الخطة</label><div>${planName}</div></div>
                <div class="form-group"><label>الحالة</label><div>${this.statusBadge(displayStatus)}</div></div>
                ${trial ? `<div class="form-group"><label>بداية التجربة</label><div>${this.formatDate(lic.trialStartsAt || lic.type === 'trial' ? lic.startedAt : null)}</div></div>
                    <div class="form-group"><label>نهاية التجربة</label><div>${this.formatDate(lic.trialExpiresAt || lic.expiresAt || lic.trialEndsAt)}</div></div>
                    <div class="form-group"><label>المتبقي</label><div>${remainingText}</div></div>` : ''}
                <div class="form-group"><label>تاريخ الانتهاء (الفترة)</label><div>${this.formatDate(lic.expiresAt || lic.currentPeriodEndsAt || lic.expires_at)}</div></div>
            </div>
            <div class="form-group">
                <label>سجل الترخيص</label>
                <div style="max-height:180px;overflow:auto;border:1px solid var(--border);border-radius:var(--radius);padding:8px">
                    ${history.length ? history.map(h =>
                        `<div style="display:flex;justify-content:space-between;gap:8px;padding:4px 0;border-bottom:1px solid var(--border);font-size:13px">
                            <span>${this.historyLabel(h.action)}</span>
                            <span style="color:var(--text-muted)">${this.formatDate(h.createdAt || h.created_at)}</span>
                        </div>`
                    ).join('') : '<span style="color:var(--text-muted);font-size:13px">لا يوجد سجل</span>'}
                </div>
            </div>
        `, [
            { text: 'إغلاق', class: 'btn btn-ghost', action: 'App.closeModal()' }
        ]);
    },

    historyLabel(action) {
        const map = {
            created: 'إنشاء', extended: 'تمديد', suspended: 'تعليق', activated: 'تفعيل',
            reactivated: 'إعادة تنشيط', revoked: 'إلغاء', plan_changed: 'تغيير الخطة',
            limits_changed: 'تغيير الحدود'
        };
        return map[action] || action;
    },

    formatDuration(ms) {
        if (ms == null) return '—';
        const days = Math.floor(ms / 86400000);
        const hours = Math.floor((ms % 86400000) / 3600000);
        if (days > 0) return `${days} يوم ${hours > 0 ? hours + ' ساعة' : ''}`;
        return `${hours} ساعة`;
    },

    async loadLicenseHistoryFor(orgId) {
        try {
            const res = await this.api('/owner/licenses/history/' + orgId);
            const data = res || [];
            return Array.isArray(data) ? data : (data.data || []);
        } catch {
            return [];
        }
    },

    extendLicenseDays(id, days) {
        this.executeLicenseAction(id, 'extend', days);
    },

    showLicenseModal() {
        this.showModal('إنشاء ترخيص جديد', `
            <div class="form-group">
                <label>المنظمة</label>
                <input type="text" id="lic-org-id" placeholder="معرف المنظمة">
            </div>
            <div class="form-group">
                <label>الخطة</label>
                <input type="text" id="lic-plan-id" placeholder="معرف الخطة">
            </div>
            <div class="form-group">
                <label>مدة الترخيص (أيام)</label>
                <input type="number" id="lic-duration" placeholder="أدخل المدة بالأيام" min="1" value="365">
            </div>
            <div class="form-group">
                <label>الحد الأقصى للمستخدمين</label>
                <input type="number" id="lic-max-users" placeholder="أدخل الحد الأقصى" min="1">
            </div>
        `, [
            { text: 'إلغاء', class: 'btn btn-ghost', action: 'App.closeModal()' },
            { text: 'إنشاء', class: 'btn btn-primary', action: 'App.createLicense()' }
        ]);
    },

    async createLicense() {
        const orgId = document.getElementById('lic-org-id').value.trim();
        const planId = document.getElementById('lic-plan-id').value.trim();
        const duration = document.getElementById('lic-duration').value;
        const maxUsers = document.getElementById('lic-max-users').value;

        if (!orgId || !planId) {
            this.toast('يرجى إدخال معرف المنظمة والخطة', 'warning');
            return;
        }

        try {
            await this.api('/owner/licenses/create', {
                method: 'POST',
                body: JSON.stringify({
                    organizationId: orgId,
                    planId: planId,
                    duration: duration ? parseInt(duration) : undefined,
                    maxUsers: maxUsers ? parseInt(maxUsers) : undefined
                })
            });
            this.toast('تم إنشاء الترخيص بنجاح', 'success');
            this.closeModal();
            this.loadLicenses();
        } catch (err) {
            this.toast('خطأ في إنشاء الترخيص: ' + err.message, 'error');
        }
    },

    async licenseAction(id, action) {
        if (!action) return;

        const actions = {
            extend: { label: 'تمديد الترخيص', endpoint: `/owner/licenses/${id}/extend`, needsInput: true, inputLabel: 'عدد الأيام الإضافية', inputType: 'number' },
            suspend: { label: 'تعليق الترخيص', endpoint: `/owner/licenses/${id}/suspend` },
            revoke: { label: 'إلغاء الترخيص', endpoint: `/owner/licenses/${id}/revoke` },
            reactivate: { label: 'إعادة تنشيط الترخيص', endpoint: `/owner/licenses/${id}/reactivate` },
            'change-plan': { label: 'تغيير الخطة', endpoint: `/owner/licenses/${id}/change-plan`, needsInput: true, inputLabel: 'معرف الخطة الجديدة', inputType: 'text' }
        };

        const act = actions[action];
        if (!act) return;

        if (act.needsInput) {
            this.showModal(act.label, `
                <div class="form-group">
                    <label>${act.inputLabel}</label>
                    <input type="${act.inputType}" id="license-action-input" placeholder="أدخل القيمة" ${act.inputType === 'number' ? 'min="1"' : ''}>
                </div>
            `, [
                { text: 'إلغاء', class: 'btn btn-ghost', action: 'App.closeModal()' },
                { text: 'تأكيد', class: 'btn btn-primary', action: `App.executeLicenseAction('${id}', '${action}')` }
            ]);
            return;
        }

        if (!confirm(`هل أنت متأكد من ${act.label}؟`)) return;

        try {
            await this.api(act.endpoint, { method: 'POST' });
            this.toast(`تم ${act.label} بنجاح`, 'success');
            this.loadLicenses();
        } catch (err) {
            this.toast(`خطأ: ${err.message}`, 'error');
        }
    },

    async executeLicenseAction(id, action, presetDays, presetPlanId) {
        if (['extend', 'change-plan'].includes(action) && !presetDays && !presetPlanId) {
            const input = document.getElementById('license-action-input').value.trim();
            if (!input) {
                this.toast('يرجى إدخال القيمة المطلوبة', 'warning');
                return;
            }
            if (action === 'extend') presetDays = parseInt(input);
            if (action === 'change-plan') presetPlanId = input;
        }

        const endpoints = {
            extend: `/owner/licenses/${id}/extend`,
            'change-plan': `/owner/licenses/${id}/change-plan`
        };

        const body = action === 'extend'
            ? { days: presetDays }
            : { planId: presetPlanId };

        try {
            await this.api(endpoints[action], {
                method: 'POST',
                body: JSON.stringify(body)
            });
            this.toast('تمت العملية بنجاح', 'success');
            this.closeModal();
            this.loadLicenses();
        } catch (err) {
            this.toast('خطأ: ' + err.message, 'error');
        }
    },

    /* ==================== USAGE ==================== */
    async loadUsage() {
        try {
            const data = await this.api('/owner/usage');
            const usage = data.data || data;

            document.getElementById('usage-total-users').textContent = usage.totalUsers ?? usage.total_users ?? '-';
            document.getElementById('usage-api-calls').textContent = this.formatNumber(usage.apiCalls ?? usage.api_calls ?? 0);
            document.getElementById('usage-storage').textContent = usage.storage ?? usage.storageUsed ?? '-';
            document.getElementById('usage-active-sessions').textContent = usage.activeSessions ?? usage.active_sessions ?? '-';
        } catch (err) {
            this.toast('خطأ في تحميل بيانات الاستخدام: ' + err.message, 'error');
        }
    },

    /* ==================== MODAL ==================== */
    showModal(title, bodyHtml, buttons = []) {
        document.getElementById('modal-title').textContent = title;
        document.getElementById('modal-body').innerHTML = bodyHtml;

        const footer = document.getElementById('modal-footer');
        footer.innerHTML = buttons.map(btn =>
            `<button class="${btn.class}" onclick="${btn.action}">${btn.text}</button>`
        ).join('');

        document.getElementById('modal-overlay').style.display = 'flex';
    },

    closeModal() {
        document.getElementById('modal-overlay').style.display = 'none';
    },

    /* ==================== TOAST ==================== */
    toast(message, type = 'info') {
        const container = document.getElementById('toast-container');
        const icons = {
            success: '<svg class="toast-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 11.08V12a10 10 0 11-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg>',
            error: '<svg class="toast-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><path d="M15 9l-6 6M9 9l6 6"/></svg>',
            warning: '<svg class="toast-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>',
            info: '<svg class="toast-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/></svg>'
        };

        const toast = document.createElement('div');
        toast.className = `toast toast-${type}`;
        toast.innerHTML = `
            ${icons[type] || icons.info}
            <span class="toast-message">${message}</span>
            <button class="toast-close" onclick="this.parentElement.remove()">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 6L6 18M6 6l12 12"/></svg>
            </button>
        `;

        container.appendChild(toast);

        setTimeout(() => {
            toast.style.animation = 'slideOut 0.3s ease forwards';
            setTimeout(() => toast.remove(), 300);
        }, 4000);
    },

    /* ==================== HELPERS ==================== */
    statusBadge(status) {
        const map = {
            active: '<span class="badge badge-success">نشط</span>',
            trialing: '<span class="badge badge-info">تجربة مجانية</span>',
            inactive: '<span class="badge badge-warning">غير نشط</span>',
            suspended: '<span class="badge badge-warning">معلق</span>',
            disabled: '<span class="badge badge-danger">معطل</span>',
            revoked: '<span class="badge badge-danger">ملغي</span>',
            expired: '<span class="badge badge-danger">منتهي</span>',
            pending: '<span class="badge badge-info">قيد الانتظار</span>'
        };
        return map[status] || `<span class="badge badge-info">${status || '-'}</span>`;
    },

    formatDate(dateStr) {
        if (!dateStr) return '-';
        try {
            const d = new Date(dateStr);
            if (isNaN(d.getTime())) return dateStr;
            return d.toLocaleDateString('ar-SA', {
                year: 'numeric',
                month: 'short',
                day: 'numeric'
            });
        } catch {
            return dateStr;
        }
    },

    formatNumber(num) {
        if (num == null) return '-';
        if (num >= 1000000) return (num / 1000000).toFixed(1) + 'M';
        if (num >= 1000) return (num / 1000).toFixed(1) + 'K';
        return num.toString();
    }
};

document.addEventListener('DOMContentLoaded', () => App.init());
