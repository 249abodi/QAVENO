/* QAVENO Owner Portal — application logic.
   Production API base (matches owner-portal/vercel.json CSP connect-src).
   Override at deploy time by setting window.QAVENO_API_OVERRIDE in index.html
   before app.js loads; otherwise it falls back to the production URL. */
const API_BASE =
    window.QAVENO_API_OVERRIDE ||
    'https://qaveno-production.up.railway.app/api/v1';

// Backend origin without the API prefix (used for the unauthenticated /health probe).
const API_ORIGIN = API_BASE.replace(/\/api\/v1$/, '');

const App = {
    token: localStorage.getItem('qaveno_owner_token'),
    currentTab: 'dashboard',
    _apiHealth: null,
    _lastApiIssue: null,
    _confirmCallback: null,
    _lastFocused: null,
    _lastSidebarFocus: null,
    _orgs: [],
    _licenses: [],
    _licenseView: [],

    init() {
        this.initTheme();
        this.bindEvents();
        if (this.token) {
            this.checkAuth();
        } else {
            this.showLogin();
        }
        // NOTE: no handleHash() here. Loading any tab would fire unauthenticated
        // owner API calls from the login screen and surface a misleading 401 toast.
        // Data loads only after auth succeeds (via showApp() -> handleHash()).
        this.checkApiHealth();
    },

    initTheme() {
        let theme = null;
        try { theme = localStorage.getItem('qaveno_owner_theme'); } catch (e) { /* ignore */ }
        if (!theme || (theme !== 'light' && theme !== 'dark')) {
            theme = (window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches)
                ? 'dark'
                : 'light';
        }
        this.applyTheme(theme);
    },

    applyTheme(theme) {
        document.documentElement.setAttribute('data-theme', theme);
        try { localStorage.setItem('qaveno_owner_theme', theme); } catch (e) { /* ignore */ }
    },

    toggleTheme() {
        const current = document.documentElement.getAttribute('data-theme') === 'dark' ? 'dark' : 'light';
        this.applyTheme(current === 'dark' ? 'light' : 'dark');
    },

    togglePassword() {
        const input = document.getElementById('password');
        const btn = document.getElementById('password-toggle');
        if (!input || !btn) return;
        const willShow = input.type === 'password';
        input.type = willShow ? 'text' : 'password';
        btn.setAttribute('aria-pressed', willShow ? 'true' : 'false');
        btn.setAttribute('aria-label', willShow ? 'إخفاء كلمة المرور' : 'إظهار كلمة المرور');
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

        document.getElementById('theme-toggle').addEventListener('click', () => this.toggleTheme());
        document.getElementById('password-toggle').addEventListener('click', () => this.togglePassword());

        document.getElementById('modal-close').addEventListener('click', () => this.closeModal());

        document.getElementById('btn-add-org').addEventListener('click', () => this.showOrgDetail(null));
        document.getElementById('btn-add-plan').addEventListener('click', () => this.showPlanModal());
        document.getElementById('btn-add-license').addEventListener('click', () => this.showLicenseModal());

        const orgSearch = document.getElementById('org-search');
        if (orgSearch) orgSearch.addEventListener('input', () => this._renderOrgRows());
        const orgFilter = document.getElementById('org-status-filter');
        if (orgFilter) orgFilter.addEventListener('change', () => this._renderOrgRows());

        const licSearch = document.getElementById('license-search');
        if (licSearch) licSearch.addEventListener('input', () => this._renderLicenseRows());
        const licFilter = document.getElementById('license-status-filter');
        if (licFilter) licFilter.addEventListener('change', () => this._renderLicenseRows());

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
            if (e.key === 'Escape') {
                const modalOpen = document.getElementById('modal-overlay').style.display !== 'none';
                if (modalOpen) { this.closeModal(); return; }
                if (document.getElementById('sidebar').classList.contains('open')) {
                    this.closeSidebar();
                    return;
                }
            }
            if (e.key === 'Tab') {
                const overlay = document.getElementById('modal-overlay');
                if (overlay.style.display !== 'none') {
                    this._trapFocus(e);
                }
            }
        });
    },

    _trapFocus(e) {
        const focusables = this._modalFocusables();
        if (!focusables.length) return;
        const first = focusables[0];
        const last = focusables[focusables.length - 1];
        const active = document.activeElement;
        if (e.shiftKey) {
            if (active === first || !focusables.includes(active)) {
                e.preventDefault();
                last.focus();
            }
        } else {
            if (active === last || !focusables.includes(active)) {
                e.preventDefault();
                first.focus();
            }
        }
    },

    _modalFocusables() {
        const modal = document.getElementById('modal');
        const els = modal.querySelectorAll(
            'button:not([disabled]), a[href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
        );
        return Array.from(els).filter(el => (el.offsetParent !== null || el === document.activeElement));
    },

    toggleSidebar() {
        const sidebar = document.getElementById('sidebar');
        const isOpen = sidebar.classList.contains('open');
        if (isOpen) {
            this.closeSidebar();
            return;
        }
        this._lastSidebarFocus = document.activeElement;
        sidebar.classList.add('open');
        document.getElementById('sidebar-overlay').classList.add('active');
        document.getElementById('hamburger').setAttribute('aria-expanded', 'true');
        const close = document.getElementById('sidebar-close');
        if (close) close.focus();
    },

    closeSidebar() {
        document.getElementById('sidebar').classList.remove('open');
        document.getElementById('sidebar-overlay').classList.remove('active');
        document.getElementById('hamburger').setAttribute('aria-expanded', 'false');
        if (this._lastSidebarFocus && window.innerWidth <= 1024 && document.contains(this._lastSidebarFocus)) {
            this._lastSidebarFocus.focus();
        }
        this._lastSidebarFocus = null;
    },

    handleHash() {
        const hash = window.location.hash.slice(1) || 'dashboard';
        this.switchTab(hash);
    },

    // Visual API/connectivity indicator (topbar pill + login screen line).
    // Shows API reachability, auth state, last HTTP status and failed endpoint
    // in the tooltip — never tokens or passwords.
    setApiStatus(state, label, title = '') {
        for (const id of ['api-status', 'api-status-login']) {
            const el = document.getElementById(id);
            if (!el) continue;
            el.className = 'api-status' + (id === 'api-status-login' ? ' login-api-status' : '') + ' api-status-' + state;
            el.dataset.state = state;
            el.textContent = label;
            el.title = title;
        }
    },

    // Passive connectivity probe: any HTTP reply means the API is reachable.
    // A fetch failure (DNS / TLS / CORS / backend down) is shown as unreachable.
    async checkApiHealth() {
        this.setApiStatus('checking', 'فحص الخادم...', '');
        const endpoint = '/health';
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 8000);
        try {
            const res = await fetch(API_ORIGIN + endpoint, {
                headers: { 'Accept': 'application/json' },
                signal: controller.signal,
            });
            const authLabel = this.token ? 'جلسة محفوظة' : 'لم تسجل الدخول';
            this._apiHealth = { reachable: true, status: res.status, endpoint };
            const title = `API: HTTP ${res.status} (${API_ORIGIN}${endpoint})\nالمصادقة: ${authLabel}`;
            this.setApiStatus(res.status === 200 ? 'ok' : 'warn', res.status === 200 ? 'الخادم متصل' : 'الخادم متصل', title);
        } catch (err) {
            this._apiHealth = { reachable: false, status: 0, endpoint };
            this.setApiStatus('error', 'الخادم غير متصل', `تعذر الوصول إلى API (${API_ORIGIN}${endpoint}) — تحقق من الاتصال بالإنترنت أو من CORS`);
            console.debug('[QAVENO OwnerPortal] health check failed:', API_ORIGIN + endpoint, String(err.name || err.message));
        } finally {
            clearTimeout(timer);
        }
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
            this._lastApiIssue = { endpoint, status: 0, kind: 'network', at: new Date().toISOString() };
            this.setApiStatus('error', 'الخادم غير متصل', `تعذر الوصول إلى API (${API_BASE}${endpoint})`);
            console.debug('[QAVENO OwnerPortal] network failure:', endpoint, String(err.name || err.message));
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
            const d = this.describeError(res.status, msg, endpoint);
            const err = new Error(d.message);
            err.status = res.status;
            err.endpoint = endpoint;
            this._lastApiIssue = { endpoint, status: res.status, kind: d.kind, at: new Date().toISOString() };
            if (d.kind === 'server') {
                this.setApiStatus('warn', 'الخادم متصل', `API: HTTP ${res.status} عند ${endpoint}`);
            }
            console.debug('[QAVENO OwnerPortal] api error:', { endpoint, status: res.status, kind: d.kind });
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
            errorEl.style.display = 'flex';
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
            errorEl.style.display = 'flex';
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
        const toggle = document.getElementById('password-toggle');
        if (toggle) {
            const input = document.getElementById('password');
            input.type = 'password';
            toggle.setAttribute('aria-pressed', 'false');
            toggle.setAttribute('aria-label', 'إظهار كلمة المرور');
        }
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
            const isActive = item.dataset.tab === tab;
            item.classList.toggle('active', isActive);
            if (isActive) {
                item.setAttribute('aria-current', 'page');
            } else {
                item.removeAttribute('aria-current');
            }
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
        const titleText = titles[tab] || tab;
        document.getElementById('page-title').textContent = titleText;
        document.title = titleText + ' — QAVENO Owner Portal';

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

    /* ==================== SKELETON / STATE HELPERS ==================== */
    _skeletonStats(on) {
        ['stat-total-orgs', 'stat-active-orgs', 'stat-active-licenses', 'stat-recent-activity'].forEach(id => {
            const el = document.getElementById(id);
            if (!el) return;
            if (on) { el.classList.add('skeleton', 'skeleton-stat-value'); }
            else { el.classList.remove('skeleton', 'skeleton-stat-value'); }
        });
    },

    _skeletonUsage(on) {
        ['usage-total-users', 'usage-api-calls', 'usage-storage', 'usage-active-sessions'].forEach(id => {
            const el = document.getElementById(id);
            if (!el) return;
            if (on) { el.classList.add('skeleton', 'skeleton-stat-value'); }
            else { el.classList.remove('skeleton', 'skeleton-stat-value'); }
        });
    },

    _setActivityLoading() {
        const c = document.getElementById('recent-activity-list');
        if (!c) return;
        c.innerHTML = Array.from({ length: 3 }).map(() =>
            '<div class="activity-item">' +
            '<span class="skeleton" style="width:10px;height:10px;border-radius:50%;margin-top:6px;flex-shrink:0"></span>' +
            '<span class="skeleton" style="flex:1;height:14px"></span>' +
            '</div>'
        ).join('');
    },

    _setActivityError() {
        const c = document.getElementById('recent-activity-list');
        if (!c) return;
        c.innerHTML =
            '<div class="state-block state-error">' +
            '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><circle cx="12" cy="12" r="10"/><path d="M12 8v4M12 16h.01"/></svg>' +
            '<div class="state-title">تعذر تحميل النشاط الأخير</div>' +
            '<button class="btn btn-secondary btn-sm state-action" onclick="App.loadDashboard()">إعادة المحاولة</button>' +
            '</div>';
    },

    stateRow(colspan, type, title, retryAction, ctaAction, ctaLabel) {
        let icon = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M20 12a8 8 0 11-8-8"/></svg>';
        if (type === 'error') {
            icon = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><circle cx="12" cy="12" r="10"/><path d="M12 8v4M12 16h.01"/></svg>';
        } else if (type === 'empty') {
            icon = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M3 7a2 2 0 012-2h4l2 2h8a2 2 0 012 2v9a2 2 0 01-2 2H5a2 2 0 01-2-2z"/></svg>';
        }
        const retry = retryAction ? `<button class="btn btn-secondary btn-sm state-action" onclick="${retryAction}">إعادة المحاولة</button>` : '';
        const cta = ctaAction ? `<button class="btn btn-primary btn-sm state-action" onclick="${ctaAction}">${ctaLabel || ''}</button>` : '';
        return `<tr><td colspan="${colspan}"><div class="state-block ${type === 'error' ? 'state-error' : type === 'empty' ? 'state-empty' : 'state-loading'}">${icon}<div class="state-title">${title}</div><div style="display:flex;gap:8px;justify-content:center;flex-wrap:wrap">${retry}${cta}</div></div></td></tr>`;
    },

    /* ==================== DASHBOARD ==================== */
    async loadDashboard() {
        this._skeletonStats(true);
        this._setActivityLoading();
        try {
            const data = await this.api('/owner/dashboard');
            const stats = data.data || data;

            document.getElementById('stat-total-orgs').textContent = stats.totalOrgs ?? stats.totalOrganizations ?? stats.total_orgs ?? '-';
            document.getElementById('stat-active-orgs').textContent = stats.activeOrgs ?? stats.activeOrganizations ?? stats.active_orgs ?? '-';
            document.getElementById('stat-active-licenses').textContent = stats.activeLicenses ?? stats.active_licenses ?? '-';

            const recent = stats.recentActivity ?? stats.recentActivities ?? stats.activities ?? stats.recent_activity_list ?? [];
            document.getElementById('stat-recent-activity').textContent = Array.isArray(recent) ? recent.length : (recent ?? '-');
            this._skeletonStats(false);
            this.renderActivityList(Array.isArray(recent) ? recent : []);
        } catch (err) {
            this._skeletonStats(false);
            this._setActivityError();
            this.toast('خطأ في تحميل لوحة التحكم: ' + err.message, 'error');
        }
    },

    renderActivityList(activities) {
        const container = document.getElementById('recent-activity-list');
        if (!container) return;
        if (!activities.length) {
            container.innerHTML =
                '<div class="state-block state-empty">' +
                '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M3 7a2 2 0 012-2h4l2 2h8a2 2 0 012 2v9a2 2 0 01-2 2H5a2 2 0 01-2-2z"/></svg>' +
                '<div class="state-title">لا يوجد نشاط حديث</div>' +
                '</div>';
            return;
        }

        container.innerHTML = activities.map(a => `
            <div class="activity-item">
                <span class="activity-dot ${a.type || a.action || 'primary'}" aria-hidden="true"></span>
                <span class="activity-text">${a.reason || a.message || this.historyLabel(a.action) || a.description || a.text || a.action || ''}</span>
                <span class="activity-time">${this.formatDate(a.createdAt || a.created_at || a.timestamp)}</span>
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
            this.renderOrganizations(null);
        }
    },

    renderOrganizations(orgs) {
        const tbody = document.getElementById('organizations-table');
        if (!tbody) return;
        if (orgs === null) {
            tbody.innerHTML = this.stateRow(6, 'error', 'تعذر تحميل المنظمات', 'App.loadOrganizations()');
            this._orgs = [];
            this._renderOrgCount();
            return;
        }

        this._orgs = orgs.map(item => {
            const org = item.organization || item;
            const orgId = org.id != null ? org.id : org._id;
            const adminMember = (item.members || []).find(m => m.role === 'owner' || m.role === 'admin');
            const adminName = (adminMember && adminMember.displayName) || org.admin?.name || org.adminName || org.admin || '-';
            return {
                id: orgId != null ? orgId : '-',
                name: org.name || org.organizationName || '-',
                admin: adminName,
                status: org.status,
                createdAt: org.createdAt || org.created_at
            };
        });
        this._renderOrgRows();
    },

    _renderOrgRows() {
        const tbody = document.getElementById('organizations-table');
        if (!tbody) return;
        const q = (document.getElementById('org-search').value || '').trim().toLowerCase();
        const status = document.getElementById('org-status-filter').value;

        const rows = this._orgs.filter(org => {
            const matchesStatus = !status || org.status === status;
            const matchesQuery = !q ||
                String(org.name).toLowerCase().includes(q) ||
                String(org.admin).toLowerCase().includes(q);
            return matchesStatus && matchesQuery;
        });

        this._renderOrgCount(rows.length);

        if (!this._orgs.length) {
            tbody.innerHTML = this.stateRow(6, 'empty', 'لا توجد منظمات', null, 'App.showOrgDetail(null)', 'إضافة منظمة');
            return;
        }
        if (!rows.length) {
            tbody.innerHTML = this.stateRow(6, 'empty', 'لا توجد نتائج مطابقة للبحث');
            return;
        }

        tbody.innerHTML = rows.map(org => `
            <tr>
                <td class="id-cell">${org.id}</td>
                <td>${org.name}</td>
                <td>${org.admin}</td>
                <td>${this.statusBadge(org.status)}</td>
                <td>${this.formatDate(org.createdAt)}</td>
                <td>
                    <div class="action-btns">
                        <button class="btn btn-sm btn-secondary" onclick="App.showOrgDetail('${org.id}')">عرض</button>
                        <button class="btn btn-sm btn-ghost" onclick="App.showOrgStatusMenu('${org.id}')">الحالة</button>
                    </div>
                </td>
            </tr>
        `).join('');
    },

    _renderOrgCount(total) {
        const el = document.getElementById('org-count');
        if (!el) return;
        if (total === undefined) { el.textContent = ''; return; }
        el.textContent = `${total} منظمة`;
    },

    showOrgStatusMenu(id) {
        const org = (this._orgs || []).find(o => String(o.id) === String(id));
        const current = org ? org.status : null;
        const labels = { active: 'نشط', suspended: 'معلق', disabled: 'معطل' };
        const options = [
            { value: 'active', cls: 'btn btn-success', enabled: current !== 'active' },
            { value: 'suspended', cls: 'btn btn-warning', enabled: current !== 'suspended' },
            { value: 'disabled', cls: 'btn btn-soft-danger', enabled: current !== 'disabled' }
        ];

        this.showModal('تغيير حالة المنظمة', `
            <div class="confirm-dialog">
                <p style="margin-bottom:14px;color:var(--text-secondary);font-size:14px;">اختر الحالة الجديدة لهذه المنظمة:</p>
                <div class="trial-actions">
                    ${options.map(o => `
                        <button class="${o.cls}" ${o.enabled ? '' : 'disabled'} onclick="App.pickOrgStatus('${id}','${o.value}')">
                            ${labels[o.value]}
                        </button>
                    `).join('')}
                </div>
                ${current ? `<div class="confirm-note">الحالة الحالية: ${this.statusBadge(current)}</div>` : ''}
            </div>
        `, [
            { text: 'إلغاء', class: 'btn btn-secondary', action: 'App.closeModal()' }
        ]);
    },

    pickOrgStatus(id, status) {
        this.closeModal();
        const labels = { active: 'نشط', suspended: 'معلق', disabled: 'معطل' };
        this.confirmDialog({
            title: 'تأكيد تغيير الحالة',
            message: `سيتم تعيين حالة المنظمة إلى "${labels[status] || status}"`,
            danger: status !== 'active',
            confirmLabel: 'تغيير الحالة',
            onConfirm: () => this._doUpdateOrgStatus(id, status)
        });
    },

    async _doUpdateOrgStatus(id, status) {
        const statusLabels = { active: 'نشط', suspended: 'معلق', disabled: 'معطل' };
        try {
            await this.api(`/owner/organizations/${id}/status`, {
                method: 'PATCH',
                body: JSON.stringify({ status })
            });
            this.toast(`تم تحديث حالة المنظمة إلى "${statusLabels[status] || status}" بنجاح`, 'success');
            this.loadOrganizations();
        } catch (err) {
            this.toast('خطأ في تحديث الحالة: ' + err.message, 'error');
        }
    },

    async showOrgDetail(id) {
        if (!id) {
            this.showModal('إضافة منظمة جديدة', `
                <div class="form-group">
                    <label for="new-org-name">اسم المنظمة <span class="required-asterisk" aria-hidden="true">*</span></label>
                    <input type="text" id="new-org-name" name="new-org-name" class="form-control" placeholder="أدخل اسم المنظمة" required>
                    <div class="field-hint">هذا الحقل مطلوب</div>
                </div>
                <div class="form-group">
                    <label for="new-org-admin">اسم المدير</label>
                    <input type="text" id="new-org-admin" name="new-org-admin" class="form-control" placeholder="أدخل اسم المدير">
                </div>
                <div class="form-group">
                    <label for="new-org-email">البريد الإلكتروني</label>
                    <input type="email" id="new-org-email" name="new-org-email" class="form-control ltr-input" placeholder="أدخل البريد الإلكتروني">
                </div>
            `, [
                { text: 'إلغاء', class: 'btn btn-secondary', action: 'App.closeModal()' },
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
                        <span class="mono">${org.id != null ? org.id : (org._id || '-')}</span>
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
                { text: 'إغلاق', class: 'btn btn-secondary', action: 'App.closeModal()' }
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
            this._showFieldError('new-org-name', 'يرجى إدخال اسم المنظمة');
            this.toast('يرجى إدخال اسم المنظمة', 'warning');
            return;
        }
        this._clearFieldError('new-org-name');
        if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
            this._showFieldError('new-org-email', 'يرجى إدخال بريد إلكتروني صالح');
            this.toast('يرجى إدخال بريد إلكتروني صالح', 'warning');
            return;
        }
        this._clearFieldError('new-org-email');

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

    /* ==================== PLANS ==================== */
    async loadPlans() {
        try {
            const data = await this.api('/owner/plans');
            const plans = data.data || data.plans || data || [];
            this.renderPlans(Array.isArray(plans) ? plans : []);
        } catch (err) {
            this.toast('خطأ في تحميل الخطط: ' + err.message, 'error');
            this.renderPlans(null);
        }
    },

    renderPlans(plans) {
        const tbody = document.getElementById('plans-table');
        if (!tbody) return;
        if (plans === null) {
            tbody.innerHTML = this.stateRow(6, 'error', 'تعذر تحميل الخطط', 'App.loadPlans()');
            return;
        }
        if (!plans.length) {
            tbody.innerHTML = this.stateRow(6, 'empty', 'لا توجد خطط', null, 'App.showPlanModal()', 'إضافة خطة');
            return;
        }

        tbody.innerHTML = plans.map(plan => `
            <tr>
                <td class="id-cell">${plan.id || plan._id || '-'}</td>
                <td>${plan.name || '-'}</td>
                <td>${plan.price != null ? plan.price + ' ر.س' : '-'}</td>
                <td>${plan.maxUsers ?? plan.max_users ?? '-'}</td>
                <td>${this.statusBadge(plan.status || (plan.isActive !== false ? 'active' : 'inactive'))}</td>
                <td>
                    <div class="action-btns">
                        <button class="btn btn-sm btn-secondary" onclick='App.showPlanModal(${JSON.stringify(plan).replace(/'/g, "&#39;")})'>تعديل</button>
                        <button class="btn btn-sm btn-soft-danger" onclick="App.deletePlan('${plan.id || plan._id}')">حذف</button>
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
                <label for="plan-name">اسم الخطة <span class="required-asterisk" aria-hidden="true">*</span></label>
                <input type="text" id="plan-name" name="plan-name" class="form-control" value="${plan?.name || ''}" placeholder="أدخل اسم الخطة" required>
            </div>
            <div class="form-group">
                <label for="plan-price">السعر (ر.س)</label>
                <input type="number" id="plan-price" name="plan-price" class="form-control ltr-input" value="${plan?.price ?? ''}" placeholder="أدخل السعر" min="0" step="0.01" inputmode="decimal">
            </div>
            <div class="form-group">
                <label for="plan-max-users">الحد الأقصى للمستخدمين</label>
                <input type="number" id="plan-max-users" name="plan-max-users" class="form-control ltr-input" value="${plan?.maxUsers ?? plan?.max_users ?? ''}" placeholder="أدخل الحد الأقصى" min="1" inputmode="numeric">
            </div>
            <div class="form-group">
                <label for="plan-description">الوصف</label>
                <input type="text" id="plan-description" name="plan-description" class="form-control" value="${plan?.description || ''}" placeholder="أدخل وصف الخطة">
            </div>
            <div class="form-group">
                <label for="plan-status">الحالة</label>
                <select id="plan-status" name="plan-status" class="form-control">
                    <option value="active" ${(plan?.status === 'active' || plan?.isActive) ? 'selected' : ''}>نشط</option>
                    <option value="inactive" ${plan?.status === 'inactive' ? 'selected' : ''}>غير نشط</option>
                </select>
            </div>
        `, [
            { text: 'إلغاء', class: 'btn btn-secondary', action: 'App.closeModal()' },
            { text: isEdit ? 'حفظ التعديلات' : 'إضافة', class: 'btn btn-primary', action: isEdit ? `App.updatePlan('${plan.id || plan._id}')` : 'App.createPlan()' }
        ]);
    },

    async createPlan() {
        if (!this._validatePlanForm()) return;

        const name = document.getElementById('plan-name').value.trim();
        const price = document.getElementById('plan-price').value;
        const maxUsers = document.getElementById('plan-max-users').value;
        const description = document.getElementById('plan-description').value.trim();
        const status = document.getElementById('plan-status').value;

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
        if (!this._validatePlanForm()) return;

        const name = document.getElementById('plan-name').value.trim();
        const price = document.getElementById('plan-price').value;
        const maxUsers = document.getElementById('plan-max-users').value;
        const description = document.getElementById('plan-description').value.trim();
        const status = document.getElementById('plan-status').value;

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

    _validatePlanForm() {
        const name = document.getElementById('plan-name').value.trim();
        const priceEl = document.getElementById('plan-price');
        const maxEl = document.getElementById('plan-max-users');
        let ok = true;

        if (!name) {
            this._showFieldError('plan-name', 'يرجى إدخال اسم الخطة');
            ok = false;
        } else {
            this._clearFieldError('plan-name');
        }

        if (priceEl.value !== '' && (!isFinite(parseFloat(priceEl.value)) || parseFloat(priceEl.value) < 0)) {
            this._showFieldError('plan-price', 'يرجى إدخال سعر صحيح غير سالب');
            ok = false;
        } else {
            this._clearFieldError('plan-price');
        }

        if (maxEl.value !== '' && (!isFinite(parseInt(maxEl.value, 10)) || parseInt(maxEl.value, 10) < 1)) {
            this._showFieldError('plan-max-users', 'يرجى إدخال عدد صحيح أكبر من صفر');
            ok = false;
        } else {
            this._clearFieldError('plan-max-users');
        }

        if (!ok) this.toast('يرجى مراجعة الحقول المطلوبة', 'warning');
        return ok;
    },

    deletePlan(id) {
        this.confirmDialog({
            title: 'حذف الخطة',
            message: 'هل أنت متأكد من حذف هذه الخطة؟ قد يؤثر ذلك على التراخيص والاشتراكات المرتبطة بها.',
            danger: true,
            confirmLabel: 'حذف الخطة',
            onConfirm: () => this._doDeletePlan(id)
        });
    },

    async _doDeletePlan(id) {
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
            this.renderLicenses(null);
        }
    },

    renderLicenses(licenses) {
        const tbody = document.getElementById('licenses-table');
        if (!tbody) return;
        if (licenses === null) {
            tbody.innerHTML = this.stateRow(7, 'error', 'تعذر تحميل التراخيص', 'App.loadLicenses()');
            this._licenses = [];
            this._licenseView = [];
            this._renderLicenseCount();
            return;
        }

        // Remember rows for the detail modal
        this._licenses = licenses;

        this._licenseView = licenses.map(lic => {
            const displayStatus = lic.trialStatus || lic.status;
            const orgName = lic.organizationName || lic.organization?.name || lic.orgName || lic.organization_id || '-';
            const planName = lic.planName || lic.plan?.name || lic.planNameFallback || lic.plan_id || '-';
            const exp = lic.trialExpiresAt || lic.expiresAt || lic.expires_at || lic.endDate;
            const id = lic.id ?? lic._id ?? lic.subscriptionId;
            return {
                id: id ?? '-',
                key: lic.licenseCode || lic.key || lic.license_key || (lic.type === 'trial' ? 'Trial' : '-'),
                orgName: String(orgName),
                planName: String(planName),
                status: displayStatus,
                exp: exp
            };
        });
        this._renderLicenseRows();
    },

    _renderLicenseRows() {
        const tbody = document.getElementById('licenses-table');
        if (!tbody) return;
        const q = (document.getElementById('license-search').value || '').trim().toLowerCase();
        const status = document.getElementById('license-status-filter').value;

        const rows = this._licenseView.filter(lic => {
            const matchesStatus = !status || lic.status === status;
            const matchesQuery = !q ||
                lic.key.toLowerCase().includes(q) ||
                lic.orgName.toLowerCase().includes(q) ||
                lic.planName.toLowerCase().includes(q);
            return matchesStatus && matchesQuery;
        });

        this._renderLicenseCount(rows.length);

        if (!this._licenseView.length) {
            tbody.innerHTML = this.stateRow(7, 'empty', 'لا توجد تراخيص', null, 'App.showLicenseModal()', 'إنشاء ترخيص');
            return;
        }
        if (!rows.length) {
            tbody.innerHTML = this.stateRow(7, 'empty', 'لا توجد نتائج مطابقة للبحث');
            return;
        }

        tbody.innerHTML = rows.map(lic => {
            const rawLic = (this._licenses || []).find(l => String(l.id ?? l._id ?? l.subscriptionId) === String(lic.id)) || {};
            const displayStatus = lic.status;
            const canSuspend = displayStatus === 'active' || displayStatus === 'trialing';
            const canReactivate = displayStatus === 'suspended';
            return `
            <tr>
                <td class="id-cell">${lic.id}</td>
                <td class="key-cell">${lic.key}</td>
                <td>${lic.orgName}</td>
                <td>${lic.planName}</td>
                <td>${this.statusBadge(displayStatus)}</td>
                <td>${this.formatDate(lic.exp)}</td>
                <td>
                    <div class="action-btns">
                        <button class="btn btn-sm btn-secondary" onclick="App.showLicenseDetail('${lic.id}')">تفاصيل</button>
                        <button class="btn btn-sm btn-ghost" onclick="App.showLicenseActions('${lic.id}')">إجراءات</button>
                    </div>
                </td>
            </tr>`;
        }).join('');
    },

    _renderLicenseCount(total) {
        const el = document.getElementById('license-count');
        if (!el) return;
        if (total === undefined) { el.textContent = ''; return; }
        el.textContent = `${total} ترخيص`;
    },

    showLicenseActions(id) {
        const lic = (this._licenses || []).find(l => String(l.id ?? l._id ?? l.subscriptionId) === String(id));
        const displayStatus = lic ? (lic.trialStatus || lic.status) : null;
        const canSuspend = displayStatus === 'active' || displayStatus === 'trialing';
        const canReactivate = displayStatus === 'suspended';

        this.showModal(`إجراءات الترخيص — ${lic ? (lic.organizationName || lic.organization?.name || id) : id}`, `
            <div class="confirm-dialog">
                <p style="margin-bottom:14px;color:var(--text-secondary);font-size:14px;">اختر الإجراء المطلوب لهذا الترخيص:</p>
                <div class="trial-actions">
                    <button class="btn btn-success" onclick="App.licenseAction('${id}','extend')">تمديد</button>
                    ${canSuspend ? `<button class="btn btn-warning" onclick="App.licenseAction('${id}','suspend')">تعليق</button>` : ''}
                    ${canReactivate ? `<button class="btn btn-primary" onclick="App.licenseAction('${id}','reactivate')">إعادة تنشيط</button>` : ''}
                    <button class="btn btn-secondary" onclick="App.licenseAction('${id}','change-plan')">تغيير الخطة</button>
                    <button class="btn btn-soft-danger" onclick="App.licenseAction('${id}','revoke')">إلغاء</button>
                </div>
                ${displayStatus ? `<div class="confirm-note">الحالة الحالية: ${this.statusBadge(displayStatus)}</div>` : ''}
            </div>
        `, [
            { text: 'إغلاق', class: 'btn btn-secondary', action: 'App.closeModal()' }
        ]);
    },

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
                <div class="trial-actions">
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
            <div class="detail-grid">
                <div class="detail-item"><label>المعرف</label><span class="mono">${lic.id ?? '-'}</span></div>
                <div class="detail-item"><label>رمز الترخيص</label><span class="mono">${lic.licenseCode || lic.key || '-'}</span></div>
                <div class="detail-item"><label>المنظمة</label><span>${orgName}</span></div>
                <div class="detail-item"><label>الخطة</label><span>${planName}</span></div>
                <div class="detail-item"><label>الحالة</label><span>${this.statusBadge(displayStatus)}</span></div>
                ${trial ? `<div class="detail-item"><label>بداية التجربة</label><span>${this.formatDate(lic.trialStartsAt || lic.type === 'trial' ? lic.startedAt : null)}</span></div>
                    <div class="detail-item"><label>نهاية التجربة</label><span>${this.formatDate(lic.trialExpiresAt || lic.expiresAt || lic.trialEndsAt)}</span></div>
                    <div class="detail-item"><label>المتبقي</label><span>${remainingText}</span></div>` : ''}
                <div class="detail-item"><label>تاريخ الانتهاء (الفترة)</label><span>${this.formatDate(lic.expiresAt || lic.currentPeriodEndsAt || lic.expires_at)}</span></div>
            </div>
            <div class="form-group">
                <label for="license-history">سجل الترخيص</label>
                <div class="history-list" id="license-history">
                    ${history.length ? history.map(h =>
                        `<div class="history-item">
                            <span class="history-label">${this.historyLabel(h.action)}</span>
                            <span class="history-time">${this.formatDate(h.createdAt || h.created_at)}</span>
                        </div>`
                    ).join('') : '<span class="text-muted" style="font-size:13px">لا يوجد سجل</span>'}
                </div>
            </div>
        `, [
            { text: 'إغلاق', class: 'btn btn-secondary', action: 'App.closeModal()' }
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

    async showLicenseModal() {
        // Prefer searchable selects populated from the existing APIs; fall back to
        // typed ID fields if the org/plan lists are empty or unavailable.
        let orgsHtml = `<input type="text" id="lic-org-id" name="lic-org-id" class="form-control ltr-input" placeholder="معرف المنظمة" autocomplete="off">`;
        let plansHtml = `<input type="text" id="lic-plan-id" name="lic-plan-id" class="form-control ltr-input" placeholder="معرف الخطة" autocomplete="off">`;

        try {
            const orgData = await this.api('/owner/organizations');
            const orgs = orgData.data || orgData.organizations || orgData || [];
            if (Array.isArray(orgs) && orgs.length) {
                orgsHtml = `<select id="lic-org-id" name="lic-org-id" class="form-control">
                    <option value="">اختر المنظمة...</option>
                    ${orgs.map(item => {
                        const org = item.organization || item;
                        const oid = org.id != null ? org.id : org._id;
                        return `<option value="${oid}">${org.name || org.organizationName || oid}</option>`;
                    }).join('')}
                </select>`;
            }
        } catch (e) { /* keep the text fallback */ }

        try {
            const planData = await this.api('/owner/plans');
            const plans = planData.data || planData.plans || planData || [];
            if (Array.isArray(plans) && plans.length) {
                plansHtml = `<select id="lic-plan-id" name="lic-plan-id" class="form-control">
                    <option value="">اختر الخطة...</option>
                    ${plans.map(p => `<option value="${p.id || p._id}">${p.name || p.id}</option>`).join('')}
                </select>`;
            }
        } catch (e) { /* keep the text fallback */ }

        this.showModal('إنشاء ترخيص جديد', `
            <div class="form-group">
                <label for="lic-org-id">المنظمة <span class="required-asterisk" aria-hidden="true">*</span></label>
                ${orgsHtml}
            </div>
            <div class="form-group">
                <label for="lic-plan-id">الخطة <span class="required-asterisk" aria-hidden="true">*</span></label>
                ${plansHtml}
            </div>
            <div class="form-group">
                <label for="lic-duration">مدة الترخيص (أيام)</label>
                <input type="number" id="lic-duration" name="lic-duration" class="form-control ltr-input" placeholder="أدخل المدة بالأيام" min="1" value="365" inputmode="numeric">
            </div>
            <div class="form-group">
                <label for="lic-max-users">الحد الأقصى للمستخدمين</label>
                <input type="number" id="lic-max-users" name="lic-max-users" class="form-control ltr-input" placeholder="أدخل الحد الأقصى" min="1" inputmode="numeric">
            </div>
        `, [
            { text: 'إلغاء', class: 'btn btn-secondary', action: 'App.closeModal()' },
            { text: 'إنشاء', class: 'btn btn-primary', action: 'App.createLicense()' }
        ]);
    },

    async createLicense() {
        const orgId = document.getElementById('lic-org-id').value.trim();
        const planId = document.getElementById('lic-plan-id').value.trim();
        const duration = document.getElementById('lic-duration').value;
        const maxUsers = document.getElementById('lic-max-users').value;

        if (!orgId) {
            this._showFieldError('lic-org-id', 'يرجى اختيار المنظمة');
            this.toast('يرجى إدخال معرف المنظمة', 'warning');
            return;
        }
        this._clearFieldError('lic-org-id');
        if (!planId) {
            this._showFieldError('lic-plan-id', 'يرجى اختيار الخطة');
            this.toast('يرجى إدخال معرف الخطة', 'warning');
            return;
        }
        this._clearFieldError('lic-plan-id');

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
                    <label for="license-action-input">${act.inputLabel}</label>
                    <input type="${act.inputType}" id="license-action-input" name="license-action-input" class="form-control ltr-input" placeholder="أدخل القيمة" ${act.inputType === 'number' ? 'min="1"' : ''} ${act.inputType === 'number' ? 'inputmode="numeric"' : ''}>
                </div>
            `, [
                { text: 'إلغاء', class: 'btn btn-secondary', action: 'App.closeModal()' },
                { text: 'تأكيد', class: 'btn btn-primary', action: `App.executeLicenseAction('${id}', '${action}')` }
            ]);
            return;
        }

        this.confirmDialog({
            title: act.label,
            message: `هل أنت متأكد من ${act.label}؟`,
            danger: action === 'suspend' || action === 'revoke',
            confirmLabel: 'تأكيد',
            onConfirm: () => this._executeSimpleLicenseAction(id, act.label, act.endpoint)
        });
    },

    async _executeSimpleLicenseAction(id, label, endpoint) {
        try {
            await this.api(endpoint, { method: 'POST' });
            this.toast(`تم ${label} بنجاح`, 'success');
            this.loadLicenses();
        } catch (err) {
            this.toast(`خطأ: ${err.message}`, 'error');
        }
    },

    async executeLicenseAction(id, action, presetDays, presetPlanId) {
        if (['extend', 'change-plan'].includes(action) && !presetDays && !presetPlanId) {
            const input = document.getElementById('license-action-input').value.trim();
            if (!input) {
                this._showFieldError('license-action-input', 'يرجى إدخال القيمة المطلوبة');
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
        this._skeletonUsage(true);
        try {
            const data = await this.api('/owner/usage');
            const usage = data.data || data;

            document.getElementById('usage-total-users').textContent = usage.totalUsers ?? usage.total_users ?? '-';
            document.getElementById('usage-api-calls').textContent = this.formatNumber(usage.apiCalls ?? usage.api_calls ?? 0);
            document.getElementById('usage-storage').textContent = usage.storage ?? usage.storageUsed ?? '-';
            document.getElementById('usage-active-sessions').textContent = usage.activeSessions ?? usage.active_sessions ?? '-';
            this._skeletonUsage(false);
        } catch (err) {
            this._skeletonUsage(false);
            document.getElementById('usage-total-users').textContent = '-';
            document.getElementById('usage-api-calls').textContent = '-';
            document.getElementById('usage-storage').textContent = '-';
            document.getElementById('usage-active-sessions').textContent = '-';
            this.toast('خطأ في تحميل بيانات الاستخدام: ' + err.message, 'error');
        }
    },

    /* ==================== MODAL ==================== */
    showModal(title, bodyHtml, buttons = []) {
        const overlay = document.getElementById('modal-overlay');
        document.getElementById('modal-title').textContent = title;
        document.getElementById('modal-body').innerHTML = bodyHtml;

        const footer = document.getElementById('modal-footer');
        footer.innerHTML = buttons.map(btn =>
            `<button class="${btn.class}" onclick="${btn.action}">${btn.text}</button>`
        ).join('');

        this._lastFocused = document.activeElement;
        overlay.style.display = 'flex';
        requestAnimationFrame(() => overlay.classList.add('open'));
        document.body.style.overflow = 'hidden';

        const modal = document.getElementById('modal');
        const firstFocusable = this._modalFocusables()[0];
        if (firstFocusable) {
            firstFocusable.focus();
        } else {
            modal.focus();
        }
    },

    closeModal() {
        const overlay = document.getElementById('modal-overlay');
        if (overlay.style.display === 'none') return;
        overlay.classList.remove('open');
        overlay.style.display = 'none';
        document.body.style.overflow = '';
        if (this._lastFocused && document.contains(this._lastFocused)) {
            this._lastFocused.focus();
        }
        this._lastFocused = null;
    },

    confirmDialog({ title, message, note = '', danger = false, confirmLabel = 'تأكيد', onConfirm }) {
        this._confirmCallback = onConfirm;
        const icon = danger
            ? '<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>'
            : '<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><circle cx="12" cy="12" r="10"/><path d="M12 16v-4M12 8h.01"/></svg>';

        this.showModal(title, `
            <div class="confirm-dialog">
                <div class="confirm-icon confirm-icon--${danger ? 'danger' : 'info'}">${icon}</div>
                <p>${message}</p>
                ${note ? `<div class="confirm-note">${note}</div>` : ''}
            </div>
        `, [
            { text: 'إلغاء', class: 'btn btn-secondary', action: 'App.closeModal()' },
            { text: confirmLabel, class: danger ? 'btn btn-danger' : 'btn btn-primary', action: 'App.confirmAction()' }
        ]);
    },

    confirmAction() {
        const cb = this._confirmCallback;
        this._confirmCallback = null;
        this.closeModal();
        if (typeof cb === 'function') cb();
    },

    /* ==================== TOAST ==================== */
    toast(message, type = 'info') {
        const container = document.getElementById('toast-container');
        const icons = {
            success: '<svg class="toast-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M22 11.08V12a10 10 0 11-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg>',
            error: '<svg class="toast-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><circle cx="12" cy="12" r="10"/><path d="M15 9l-6 6M9 9l6 6"/></svg>',
            warning: '<svg class="toast-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>',
            info: '<svg class="toast-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/></svg>'
        };

        const toast = document.createElement('div');
        toast.className = `toast toast-${type}`;
        toast.setAttribute('role', type === 'error' ? 'alert' : 'status');
        toast.innerHTML = `
            ${icons[type] || icons.info}
            <span class="toast-message">${message}</span>
            <button class="toast-close" aria-label="إغلاق الإشعار" onclick="this.parentElement.remove()">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M18 6L6 18M6 6l12 12"/></svg>
            </button>
        `;

        container.appendChild(toast);

        setTimeout(() => {
            toast.style.animation = 'slideOut 0.3s ease forwards';
            setTimeout(() => toast.remove(), 300);
        }, 4000);
    },

    /* ==================== FIELD VALIDATION ==================== */
    _showFieldError(inputId, message) {
        const input = document.getElementById(inputId);
        if (!input) return;
        input.classList.add('invalid');
        let errorEl = document.getElementById(inputId + '-error');
        if (!errorEl) {
            errorEl = document.createElement('div');
            errorEl.id = inputId + '-error';
            errorEl.className = 'field-error';
            errorEl.setAttribute('role', 'alert');
            errorEl.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><circle cx="12" cy="12" r="10"/><path d="M12 8v4M12 16h.01"/></svg><span></span>';
            input.insertAdjacentElement('afterend', errorEl);
            input.setAttribute('aria-describedby', inputId + '-error');
        }
        errorEl.querySelector('span').textContent = message;
        errorEl.classList.add('visible');
    },

    _clearFieldError(inputId) {
        const input = document.getElementById(inputId);
        if (!input) return;
        input.classList.remove('invalid');
        const errorEl = document.getElementById(inputId + '-error');
        if (errorEl) {
            errorEl.classList.remove('visible');
        }
    },

    /* ==================== HELPERS ==================== */
    statusBadge(status) {
        const dot = '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M12 12m-6 0a6 6 0 1 0 12 0a6 6 0 1 0 -12 0"/></svg>';
        const map = {
            active: `<span class="badge badge-success">${dot}نشط</span>`,
            trialing: `<span class="badge badge-info">${dot}تجربة مجانية</span>`,
            inactive: `<span class="badge badge-warning">${dot}غير نشط</span>`,
            suspended: `<span class="badge badge-warning">${dot}معلق</span>`,
            disabled: `<span class="badge badge-danger">${dot}معطل</span>`,
            revoked: `<span class="badge badge-danger">${dot}ملغي</span>`,
            expired: `<span class="badge badge-danger">${dot}منتهي</span>`,
            pending: `<span class="badge badge-info">${dot}قيد الانتظار</span>`
        };
        return map[status] || `<span class="badge badge-neutral">${dot}${status || '-'}</span>`;
    },

    formatDate(dateStr) {
        if (!dateStr) return '-';
        try {
            const d = new Date(dateStr);
            if (isNaN(d.getTime())) return dateStr;
            return d.toLocaleDateString('ar-EG', {
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