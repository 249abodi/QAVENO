'use strict';

const { readFileSync } = require('fs');
const { join } = require('path');

const ROOT = join(__dirname, '..');
const html = readFileSync(join(ROOT, 'owner-portal', 'index.html'), 'utf8');
const appJs = readFileSync(join(ROOT, 'owner-portal', 'app.js'), 'utf8');
const vercelJson = readFileSync(join(ROOT, 'owner-portal', 'vercel.json'), 'utf8');

let pass = 0;
let fail = 0;

function assert(label, ok) {
  if (ok) { pass++; }
  else { fail++; console.error('FAIL: ' + label); }
}

const API = 'https://qaveno-production.up.railway.app/api/v1';

// ── API wiring ──
assert('app.js default API_BASE = production /api/v1', appJs.includes(`'${API}'`));
assert('app.js derives origin for /health probe', appJs.includes("API_BASE.replace(/\\/api\\/v1$/, '')"));
assert('vercel.json CSP connect-src allows the API host', vercelJson.includes('connect-src \'self\' https://qaveno-production.up.railway.app'));

// ── Login screen must NOT fire dashboard requests (regression for the 401 toast) ──
assert('init no longer calls handleHash() unconditionally', /\/\/ NOTE: no handleHash\(\) here\./.test(appJs));
assert('loadTab refuses data loads without a token', appJs.includes('if (!this.token) return;'));
assert('health check kicked off from init()', appJs.includes('this.checkApiHealth();'));
assert('has /health probe endpoint', appJs.includes("'/health'"));

// ── Error classification (no more blanket "بيانات الدخول غير صحيحة") ──
assert('login 401 mapped to bad-credentials message', appJs.includes("endpoint === '/auth/login'"));
assert('non-login 401 mapped to session-expired message', appJs.includes('انتهت صلاحية الجلسة، يرجى تسجيل الدخول مجدداً'));
assert('403 has its own message', appJs.includes('ليس لديك صلاحية للوصول إلى هذا المورد'));
assert('404 has its own message', appJs.includes('المورد المطلوب غير موجود'));
assert('429 has its own message', appJs.includes('طلبات كثيرة جداً'));
assert('5xx has its own message', appJs.includes('حدث خطأ في الخادم، حاول مرة أخرى لاحقاً'));
assert('network errors have their own message', appJs.includes('تعذر الوصول إلى الخادم'));

// ── Session handling ──
assert('login parses accessToken from backend response', appJs.includes('data.token || data.data?.token || data.accessToken'));
assert('protected 401 clears the stored session', appJs.includes("res.status === 401 && endpoint !== '/auth/login'"));
assert('no refresh-token persistence (token only in localStorage key)', appJs.includes("localStorage.getItem('qaveno_owner_token')"));

// ── Dashboard contract matches backend (getDashboard: totalOrgs/activeOrgs/recentActivity) ──
assert('dashboard maps totalOrgs', appJs.includes('stats.totalOrgs ??'));
assert('dashboard maps activeOrgs', appJs.includes('stats.activeOrgs ??'));
assert('dashboard maps recentActivity list', appJs.includes('stats.recentActivity ??'));
assert('activity list renders server reason/action', appJs.includes('this.historyLabel(a.action)'));

// ── Usage page contract (aggregate summary, no fabricated zeros) ──
assert('usage reads the aggregate endpoint /owner/usage/stats', appJs.includes("'/owner/usage/stats'"));
assert('usage reads real totalUsers', appJs.includes('usage.totalUsers != null ? this.formatArabicNumber(usage.totalUsers)'));
assert('usage reads real activeSessions', appJs.includes('usage.activeSessions != null ? this.formatArabicNumber(usage.activeSessions)'));
assert('unavailable API-calls metric renders "غير متاح" not 0', appJs.includes("api && api.available === true ? this.formatNumber") || appJs.includes("api && api.available === true ? this.formatArabicNumber"));
assert('fabricated apiCalls "?? 0" fallback removed', !appJs.includes('usage.apiCalls ?? usage.api_calls ?? 0'));
assert('unavailable storage metric renders "غير متاح" not -', appJs.includes("sto && sto.available === true ? this.formatBytes"));
assert('"غير متاح" sentinel used for null metrics', appJs.includes("'غير متاح'") && appJs.includes("el.textContent = value == null ? 'غير متاح' : value;"));
assert('Arabic-Indic number formatting implemented', appJs.includes('formatArabicNumber(num) {'));
assert('Arabic byte formatting implemented', appJs.includes('formatBytes(bytes) {'));
assert('backend unavailable flag contract parsed', appJs.includes('api.available') && appJs.includes('sto.available'));
assert('usage skeleton stays wired', appJs.includes("_skeletonUsage(true)") && appJs.includes("_skeletonUsage(false)"));

// ── No secrets / no fake auth ──
assert('no hardcoded password in portal JS', !appJs.includes('OwnerPass1!'));
assert('no Basic auth / apiKey shims', !appJs.includes('Authorization: Basic') && !appJs.includes('apiKey'));
assert('no token is ever printed to console', !/[cC]onsole\.(log|debug)\([^)]*this\.token/.test(appJs) && !appJs.includes('JSON.stringify(this.token)'));
assert('no hardcoded fake success', !appJs.includes('return { accessToken:') && !appJs.includes("accessToken: 'fake'"));

console.log('\nOwner Portal static QA: ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail > 0 ? 1 : 0);