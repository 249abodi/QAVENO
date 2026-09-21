'use strict';

const $ = (s) => document.querySelector(s);

let boot = { store_name: '', lang: 'ar', theme: 'light', needsSetup: false };
let busy = false;

function t(key, params) { return window.i18n.t(key, params); }

function showErr(msg) {
  const el = $('#errLine');
  el.textContent = msg;
  el.hidden = false;
}
function hideErr() { $('#errLine').hidden = true; }

function showLicErr(msg) {
  const el = $('#licErr');
  el.textContent = msg;
  el.hidden = false;
}
function hideLicErr() { $('#licErr').hidden = true; }

function setBusy(isBusy, label) {
  busy = isBusy;
  $('#submitBtn').disabled = isBusy;
  $('#submitLabel').textContent = label;
}

/* ── License screen ────────────────────────────────────────────── */

function showLicenseScreen() {
  const form = $('#loginForm');
  form.closest('section').querySelector('.brand').style.display = 'none';
  $('#formTitle').style.display = 'none';
  $('#formSub').style.display = 'none';
  form.style.display = 'none';
  $('#licenseScreen').classList.remove('hidden');
  checkLicenseStatus();
}

function hideLicenseScreen() {
  const form = $('#loginForm');
  form.closest('section').querySelector('.brand').style.display = '';
  $('#formTitle').style.display = '';
  $('#formSub').style.display = '';
  form.style.display = '';
  $('#licenseScreen').classList.add('hidden');
}

/*
 * Classify a license status for the login gate.
 *  - 'ok'          -> active trial or active license: login allowed
 *  - 'none'        -> no license/trial at all: user must start a trial or activate
 *  - 'blocked'     -> expired / suspended / revoked / tampered: locked (never allowed)
 *  - 'unavailable' -> unreadable / unexpected state: fail-closed, never allow login
 */
function licenseVerdict(st) {
  if (!st || st.type === 'none' || st.status === 'none') return 'none';
  if (st.status === 'expired' || st.status === 'suspended' || st.status === 'revoked' || st.status === 'tampered') {
    return 'blocked';
  }
  if (st.status === 'active') return 'ok';
  return 'unavailable';
}

/* ── Lock screen (expired / suspended / revoked / tampered) ───────── */

function showLockScreen(st) {
  $('#licenseScreen').classList.add('hidden');
  $('#lockScreen').classList.remove('hidden');

  const trial = st.trial || {};
  const lic = st.license || {};
  $('#lockOrgId').textContent = trial.organizationId || lic.organizationId || 1;

  const statusKey = {
    expired: 'login.lock.stExpired',
    suspended: 'login.lock.stSuspended',
    revoked: 'login.lock.stRevoked',
    tampered: 'login.lock.stTampered'
  }[st.status] || 'login.lock.stExpired';
  $('#lockStatus').textContent = t(statusKey);

  const expiresAt = trial.endsAt || trial.expiresAt || lic.expiresAt || null;
  $('#lockExpires').textContent = expiresAt
    ? new Date(expiresAt).toLocaleString(window.i18n.locale())
    : '—';
  $('#lockErr').hidden = true;
}

function hideLockScreen() {
  $('#lockScreen').classList.add('hidden');
}

function restoreLogin() {
  hideLockScreen();
  $('#licenseScreen').classList.add('hidden');
  const form = $('#loginForm');
  form.closest('section').querySelector('.brand').style.display = '';
  $('#formTitle').style.display = '';
  $('#formSub').style.display = '';
  form.style.display = '';
}

async function checkLicenseStatus() {
  try {
    const st = await window.pos.license.status();
    if (st.type === 'license' && st.status === 'active') {
      showLicActive(st.license);
    } else if (st.type === 'trial' && st.status === 'active') {
      showTrialBanner(st.trial);
    } else if (st.type === 'trial' && st.status === 'expired') {
      showLockScreen(st);
    } else if (st.type === 'trial' && st.status === 'tampered') {
      showLockScreen(st);
    } else if (st.status === 'suspended' || st.status === 'revoked') {
      showLockScreen(st);
    } else {
      // No license, no trial — show trial button
      $('#trialBtn').classList.remove('hidden');
    }
  } catch {
    showLicErr(t('login.license.failed'));
  }
}

function showTrialBanner(trial) {
  const el = $('#trialBanner');
  el.classList.remove('hidden');
  if (trial.offlineGrace) {
    $('#trialText').textContent = `التجربة منتهية — فترة الأونلاين: ${formatTimeRemaining(trial.graceExpiresAt)}`;
    el.style.borderColor = '#f59e0b';
  } else {
    const hours = trial.hoursLeft || 0;
    const minutes = trial.minutesLeft || 0;
    if (hours > 0) {
      $('#trialText').textContent = `التجربة المجانية: ${hours} ساعة و ${minutes} دقيقة متبقية`;
    } else {
      $('#trialText').textContent = `التجربة المجانية: ${minutes} دقيقة متبقية`;
    }
    if (hours < 4) el.style.borderColor = '#ef4444';
  }
  // Start countdown
  startTrialCountdown(trial);
}

function startTrialCountdown(trial) {
  const update = () => {
    const now = new Date();
    const endsAt = new Date(trial.endsAt);
    const remaining = endsAt.getTime() - now.getTime();
    if (remaining <= 0) {
      $('#trialText').textContent = 'انتهت التجربة المجانية. أدخل كود الترخيص.';
      $('#trialBanner').style.borderColor = '#ef4444';
      return;
    }
    const h = Math.floor(remaining / (1000 * 60 * 60));
    const m = Math.floor((remaining % (1000 * 60 * 60)) / (1000 * 60));
    const s = Math.floor((remaining % (1000 * 60)) / 1000);
    $('#trialText').textContent = `التجربة المجانية: ${h}h ${m}m ${s}s متبقية`;
    setTimeout(update, 1000);
  };
  update();
}

function formatTimeRemaining(isoStr) {
  const remaining = new Date(isoStr).getTime() - Date.now();
  if (remaining <= 0) return 'منتهية';
  const h = Math.floor(remaining / (1000 * 60 * 60));
  const m = Math.floor((remaining % (1000 * 60 * 60)) / (1000 * 60));
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

function showLicActive(lic) {
  $('#licForm').classList.add('hidden');
  $('#licActive').classList.remove('hidden');
  const info = lic.licenseCode ? `كود: ${lic.licenseCode}` : '';
  const exp = lic.expiresAt ? ` | ينتهي: ${new Date(lic.expiresAt).toLocaleDateString('ar-EG')}` : '';
  $('#licActiveInfo').textContent = info + exp;
}

$('#activateBtn').addEventListener('click', async () => {
  hideLicErr();
  const code = $('#licCode').value.trim().toUpperCase();
  const cloudUrl = $('#cloudUrl').value.trim().replace(/\/+$/, '');
  if (!code) { showLicErr('أدخل كود الترخيص'); return; }
  if (!cloudUrl) { showLicErr('أدخل عنوان الخادم السحابي'); return; }

  $('#activateBtn').disabled = true;
  $('#activateBtn').textContent = 'جارٍ التفعيل...';
  try {
    const lic = await window.pos.license.activate(code, 1, cloudUrl);
    showLicActive(lic);
  } catch (err) {
    showLicErr(err.message || 'فشل التفعيل');
  } finally {
    $('#activateBtn').disabled = false;
    $('#activateBtn').textContent = 'تفعيل الترخيص';
  }
});

$('#trialBtn').addEventListener('click', async () => {
  hideLicErr();
  const cloudUrl = $('#cloudUrl').value.trim().replace(/\/+$/, '');
  if (!cloudUrl) { showLicErr('أدخل عنوان الخادم السحابي لبدء التجربة'); return; }

  $('#trialBtn').disabled = true;
  $('#trialBtn').textContent = 'جارٍ بدء التجربة...';
  try {
    const st = await window.pos.license.startTrial(cloudUrl, 1);
    if (st.type === 'trial' && st.status === 'active') {
      showTrialBanner(st.trial);
      // Start periodic validation
      window.pos.license.startPeriodicValidation(cloudUrl, 1);
    }
  } catch (err) {
    showLicErr(err.message || 'فشل بدء التجربة');
  } finally {
    $('#trialBtn').disabled = false;
    $('#trialBtn').textContent = 'ابدأ التجربة المجانية (24 ساعة)';
  }
});

/* Complete the flow after starting a trial / activating a license. Credentials
   that were typed into the login form are re-submitted through the enforced main
   gate — entering is only possible once the license state is active. */
async function enterTheApp() {
  const username = $('#username').value.trim();
  const password = $('#password').value;
  hideErr();
  hideLicErr();
  setBusy(true, t('login.signingIn'));
  try {
    await window.pos.auth.login(username, password);
    // main process swaps this window for the POS window
  } catch (err) {
    const msg = err && err.message ? err.message : t('login.err.generic');
    showErr(msg);
    showLicErr(msg);
    setBusy(false, t('login.submit'));
  }
}

$('#skipBtn').addEventListener('click', enterTheApp);

$('#goAppBtn').addEventListener('click', enterTheApp);

/* ── Lock screen actions ────────────────────────────────────────── */

$('#lockRetryBtn').addEventListener('click', async () => {
  const el = $('#lockRetryBtn');
  const label = el.querySelector('span');
  const cloudUrl = $('#cloudUrl').value.trim().replace(/\/+$/, '');
  const st = await window.pos.license.status();
  const organizationId = (st.trial || st.license || {}).organizationId || 1;

  const base = cloudUrl || 'https://qaveno-production.up.railway.app';

  el.disabled = true;
  label.textContent = t('login.lock.retrying');
  $('#lockErr').hidden = true;
  try {
    const res = await window.pos.license.revalidate(base, organizationId);
    if (res.type === 'trial' && res.status === 'active') {
      restoreLogin();
      showTrialBanner(res.trial);
      window.pos.license.startPeriodicValidation(base, organizationId);
    } else if (res.type === 'license' && res.status === 'active') {
      restoreLogin();
      showLicActive(res.license);
    } else {
      showLockScreen(res);
      $('#lockErr').textContent = t('login.lock.retryFailed');
      $('#lockErr').hidden = false;
    }
  } catch (err) {
    $('#lockErr').textContent = t('login.lock.retryOffline');
    $('#lockErr').hidden = false;
  } finally {
    el.disabled = false;
    label.textContent = t('login.lock.retry');
    // Re-apply i18n after restoring (button text was replaced)
    window.i18n.apply();
  }
});

$('#lockContactBtn').addEventListener('click', async () => {
  const st = await window.pos.license.status();
  const trial = st.trial || {};
  const lic = st.license || {};
  const info = {
    organizationId: trial.organizationId || lic.organizationId || 1,
    status: st.status,
    expiresAt: trial.endsAt || trial.expiresAt || lic.expiresAt || null
  };
  try {
    await navigator.clipboard.writeText(JSON.stringify(info));
  } catch { /* clipboard may be blocked; text is shown below */ }
  $('#lockErr').textContent = t('login.lock.copied');
  $('#lockErr').hidden = false;
});

/* ── Pre-auth prefs ─────────────────────────────────────────────── */

function applyPrefs() {
  window.i18n.setLang(boot.lang);
  document.documentElement.dataset.theme = boot.theme === 'dark' ? 'dark' : 'light';
  $('#langToggle').textContent = boot.lang === 'en' ? 'عربي' : 'EN';
  $('#themeToggle').innerHTML = window.icon(boot.theme === 'dark' ? 'sun' : 'moon', { size: 16 });
  $('#storeName').textContent = boot.store_name || '';
}

function renderMode() {
  if (boot.needsSetup) {
    document.body.classList.add('setup');
    $('#formTitle').textContent = t('login.setupTitle');
    $('#formSub').textContent = t('login.setupSub');
    $('#username').setAttribute('autocomplete', 'off');
    $('#password').setAttribute('autocomplete', 'new-password');
  } else {
    document.body.classList.remove('setup');
    $('#formTitle').textContent = t('login.welcome');
    $('#formSub').textContent = t('login.sub');
  }
}

$('#langToggle').addEventListener('click', () => {
  boot.lang = boot.lang === 'ar' ? 'en' : 'ar';
  applyPrefs();
  window.i18n.apply();
  window.icons.mount(document);
  renderMode();
});

$('#themeToggle').addEventListener('click', () => {
  boot.theme = boot.theme === 'dark' ? 'light' : 'dark';
  applyPrefs();
});

$('#loginForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  if (busy) return;
  hideErr();

  const username = $('#username').value.trim();
  const password = $('#password').value;
  if (!username || !password) return showErr(t('login.err.required'));

  if (boot.needsSetup) {
    if (password !== $('#confirmPassword').value) return showErr(t('login.err.mismatch'));
    setBusy(true, t('login.creating'));
    try {
      await window.pos.auth.setup(username, password, $('#displayName').value.trim());
      // After setup, show license activation screen
      showLicenseScreen();
      setBusy(false, t('login.submit'));
    } catch (err) {
      showErr(err && err.message ? err.message : t('login.err.generic'));
      setBusy(false, t('login.submit'));
    }
  } else {
    // License gate (fail-closed). Entering the app requires a valid, active
    // trial or license. Any error while determining license state BLOCKS login
    // instead of silently proceeding to auth.login.
    let st;
    try {
      st = await window.pos.license.status();
    } catch {
      showErr(t('login.license.failed'));
      setBusy(false, t('login.submit'));
      return;
    }
    const verdict = licenseVerdict(st);
    if (verdict === 'none') {
      showLicenseScreen();
      setBusy(false, t('login.submit'));
      return;
    }
    if (verdict === 'blocked') {
      showLockScreen(st);
      setBusy(false, t('login.submit'));
      return;
    }
    if (verdict === 'unavailable') {
      showErr(t('login.license.failed'));
      setBusy(false, t('login.submit'));
      return;
    }

    setBusy(true, t('login.signingIn'));
    try {
      await window.pos.auth.login(username, password);
      // main process swaps this window for the POS window
    } catch (err) {
      showErr(err && err.message ? err.message : t('login.err.generic'));
      setBusy(false, t('login.submit'));
    }
  }
});

(async function init() {
  try {
    const b = await window.pos.auth.bootstrap();
    boot = { ...boot, ...b };
  } catch { /* defaults already set */ }
  applyPrefs();
  window.icons.mount(document);
  try {
    const logo = await window.pos.appInfo.getLogo();
    if (logo) {
      $('#brandLogo').src = logo;
      $('#brandLogo').classList.remove('hidden');
      $('#logoEmoji').classList.add('hidden');
    }
  } catch { /* keep lock icon fallback */ }
  window.i18n.apply();
  renderMode();
  $('#username').focus();
})();
