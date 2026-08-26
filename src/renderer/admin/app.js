'use strict';

const $ = (id) => document.getElementById(id);
const t = (key, params) => window.i18n.t(key, params);

let settings = { store_name: 'متجري', tax_rate: '15', currency: 'ر.س', lang: 'ar', theme: 'light' };
let editingProductId = null;
let restockProductId = null;

/* Categories page state */
const PALETTE = [
  ['#2563eb', 'color.blue'], ['#16a34a', 'color.green'],
  ['#eab308', 'color.yellow'], ['#ea580c', 'color.orange'],
  ['#ec4899', 'color.pink'], ['#8b5cf6', 'color.purple'],
  ['#0d9488', 'color.teal'], ['#dc2626', 'color.red']
];
let cats = [];
let catsState = 'loading'; // loading | ready | error
let editingCatId = null;
let deleteCatId = null;
let selectedColor = PALETTE[0][0];
let openMenuCatId = null;
let catSortMode = 'count'; // name | count | newest | oldest

const money = (n) => Number(n || 0).toFixed(2);
const escapeHtml = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
}[c]));

function debounce(fn, wait = 300) {
  let timer = null;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), wait);
  };
}

function fmtDate(iso) {
  try {
    return new Date(String(iso).replace(' ', 'T') + 'Z')
      .toLocaleString(window.i18n.locale(), { dateStyle: 'short', timeStyle: 'short' });
  } catch { return iso; }
}

function toast(msg, type = '') {
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.textContent = msg;
  $('toasts').appendChild(el);
  setTimeout(() => el.remove(), 3200);
}

/* ---------------- Table state helpers ---------------- */

function stateCell(cols, inner) {
  return `<tr class="state-row"><td colspan="${cols}">${inner}</td></tr>`;
}
function loadingState(cols) {
  return stateCell(cols, `<div class="state-box"><span class="s">${escapeHtml(t('state.loading'))}</span></div>`);
}
function errorState(cols, retryName) {
  return stateCell(cols, `
    <div class="state-box">
      <div class="state-ic">${window.icon('notification', { size: 28 })}</div>
      <div class="t">${escapeHtml(t('err.loadShort'))}</div>
      <button type="button" class="btn small primary" data-retry="${retryName}">${escapeHtml(t('common.retry'))}</button>
    </div>`);
}
function wireRetry(container, fn) {
  const b = container.querySelector('[data-retry]');
  if (b) b.addEventListener('click', () => fn());
}

/* ---------------- Modal manager ---------------- */

let lastFocusedTrigger = null;
let confirmResolve = null;

function openModal(id) {
  lastFocusedTrigger = document.activeElement;
  const m = $(id);
  m.classList.remove('hidden');
  const first = m.querySelector('input:not([type="hidden"]), select, button');
  if (first && !first.disabled) first.focus();
}

function closeModal(id) {
  $(id).classList.add('hidden');
  if (lastFocusedTrigger && document.contains(lastFocusedTrigger)) {
    lastFocusedTrigger.focus();
  }
  lastFocusedTrigger = null;
}

function confirmDialog(messageKey, params, okLabelKey = 'common.delete') {
  return new Promise((resolve) => {
    $('confirmMsg').textContent = t(messageKey, params);
    $('confirmOkBtn').textContent = t(okLabelKey);
    confirmResolve = resolve;
    openModal('confirmModal');
    $('confirmOkBtn').focus();
  });
}

function closeConfirm(result) {
  if (!confirmResolve) return;
  const resolve = confirmResolve;
  confirmResolve = null;
  $('confirmModal').classList.add('hidden');
  if (lastFocusedTrigger && document.contains(lastFocusedTrigger)) {
    lastFocusedTrigger.focus();
  }
  lastFocusedTrigger = null;
  resolve(result);
}

$('confirmOkBtn').addEventListener('click', () => closeConfirm(true));
$('confirmCancelBtn').addEventListener('click', () => closeConfirm(false));

document.addEventListener('keydown', (e) => {
  const openModals = [...document.querySelectorAll('.modal:not(.hidden)')];
  if (openModals.length === 0) return;
  const top = openModals[openModals.length - 1];

  if (e.key === 'Escape') {
    e.preventDefault();
    if (top.id === 'confirmModal') closeConfirm(false);
    else closeModal(top.id);
    return;
  }

  if (e.key === 'Tab') {
    const items = [...top.querySelectorAll('button, input, select, a[href]')]
      .filter(el => !el.disabled && el.offsetParent !== null);
    if (items.length === 0) return;
    const first = items[0];
    const last = items[items.length - 1];
    if (!top.contains(document.activeElement)) {
      e.preventDefault();
      first.focus();
    } else if (e.shiftKey && document.activeElement === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  }
});

document.querySelectorAll('.modal').forEach((m) => {
  m.addEventListener('mousedown', (e) => {
    if (e.target !== m || m.classList.contains('hidden')) return;
    // destructive dialogs require an explicit choice — no accidental dismissal
    if (m.id === 'confirmModal' || m.id === 'deleteCatModal') return;
    closeModal(m.id);
  });
});

/* ---------------- Tabs ---------------- */

function activateTab(name) {
  document.querySelectorAll('.tab').forEach(b => b.classList.toggle('active', b.dataset.tab === name));
  document.querySelectorAll('.tab-page').forEach(p => p.classList.toggle('active', p.id === `tab-${name}`));
  closeCatMenu();
  activeTab = name;
  refreshActiveTab();
}

document.querySelectorAll('.tab').forEach(btn =>
  btn.addEventListener('click', () => activateTab(btn.dataset.tab)));

/* ---------------- Preferences (lang + theme) ---------------- */

function applyPrefs() {
  window.i18n.setLang(settings.lang || 'ar');
  document.documentElement.dataset.theme = settings.theme === 'dark' ? 'dark' : 'light';
  $('langToggle').textContent = (settings.lang === 'en') ? 'عربي' : 'EN';
  $('themeToggle').innerHTML = window.icon(settings.theme === 'dark' ? 'sun' : 'moon', { size: 16 });
  $('themeToggle').setAttribute('aria-label', t('ui.toggleTheme'));
  $('langToggle').setAttribute('aria-label', t('ui.toggleLang'));
  $('prodSearch').setAttribute('aria-label', t('prod.searchPh'));
  $('catSearch').setAttribute('aria-label', t('cats.searchPh'));
}

$('langToggle').addEventListener('click', async () => {
  const next = settings.lang === 'en' ? 'ar' : 'en';
  settings.lang = next;
  applyPrefs();
  refreshAll();
  try { await window.pos.settings.set('lang', next); } catch (e) { toast(e.message, 'error'); }
});

$('themeToggle').addEventListener('click', async () => {
  const next = settings.theme === 'dark' ? 'light' : 'dark';
  settings.theme = next;
  applyPrefs();
  try { await window.pos.settings.set('theme', next); } catch (e) { toast(e.message, 'error'); }
});

/* ---------------- Dashboard ---------------- */

async function refreshDashboard() {
  const [stats, alerts, movements] = await Promise.all([
    window.pos.stats.today(),
    window.pos.alerts.lowStock(),
    window.pos.movements.list(12)
  ]);

  $('stCount').textContent = stats.sales_count;
  $('stRevenue').textContent = money(stats.revenue);
  $('stProfit').textContent = money(stats.profit);
  $('stTax').textContent = money(stats.tax);

  const outCount = alerts.filter(a => a.severity === 'out').length;
  const lowCount = alerts.length - outCount;

  const banner = $('criticalBanner');
  if (outCount > 0) {
    banner.classList.remove('hidden');
    banner.textContent = t('banner.critical', { out: outCount, low: lowCount });
  } else if (lowCount > 0) {
    banner.classList.remove('hidden');
    banner.textContent = t('banner.low', { low: lowCount });
  } else {
    banner.classList.add('hidden');
  }

  const tabBadge = $('alertsTabBadge');
  if (alerts.length > 0) {
    tabBadge.classList.remove('hidden');
    tabBadge.textContent = alerts.length;
  } else {
    tabBadge.classList.add('hidden');
  }

  const panel = $('alertsPanel');
  if (alerts.length === 0) {
    panel.innerHTML = `<div class="all-good">${t('alerts.allGood')}</div>`;
  } else {
    panel.innerHTML = '';
    for (const a of alerts) {
      const div = document.createElement('div');
      div.className = `alert-item ${a.severity}`;
      div.innerHTML = `
        <span class="name">${escapeHtml(a.name)}</span>
        <span class="qty-chip">${escapeHtml(t('alerts.chip', { qty: a.quantity, min: a.low_stock_threshold }))}</span>`;
      panel.appendChild(div);
    }
  }

  const mv = $('recentMovements');
  mv.innerHTML = movements.length === 0
    ? `<div class="all-good">${t('mov.none')}</div>`
    : movements.map(m => `
      <div class="mini-item">
        <div>${escapeHtml(m.product_name)}<div class="when">${fmtDate(m.created_at)}</div></div>
        <div>
          <span class="${m.change >= 0 ? 'mv-pos' : 'mv-neg'}">${m.change >= 0 ? '+' : ''}${m.change}</span>
          <div class="when">${escapeHtml(t('mov.balance', { b: m.balance_after }))}</div>
        </div>
      </div>`).join('');
}

/* ---------------- Products table ---------------- */

function statusOf(p) {
  if (p.quantity <= 0) return ['st-out', t('st.out')];
  if (p.quantity <= p.low_stock_threshold) return ['st-low', t('st.low')];
  return ['st-ok', t('st.ok')];
}

async function refreshProducts() {
  const q = $('prodSearch').value.trim();
  const tbody = $('productsBody');
  tbody.innerHTML = loadingState(8);
  let list;
  try {
    list = await window.pos.products.list(q);
  } catch {
    tbody.innerHTML = errorState(8, 'products');
    wireRetry(tbody, refreshProducts);
    return;
  }
  // keep low-stock on top when not searching
  if (!q) {
    list = [...list].sort((a, b) =>
      (a.quantity <= a.low_stock_threshold ? 0 : 1) - (b.quantity <= b.low_stock_threshold ? 0 : 1));
  }
  if (list.length === 0) {
    if (q) {
      tbody.innerHTML = stateCell(8, `
        <div class="state-box">
          <div class="state-ic">${window.icon('search', { size: 28 })}</div>
          <div class="t">${escapeHtml(t('prod.noResults.title'))}</div>
          <div class="s">${escapeHtml(t('prod.noResults.sub', { q }))}</div>
          <button type="button" class="btn small" id="clearProdSearchBtn">${escapeHtml(t('prod.clearSearch'))}</button>
        </div>`);
      $('clearProdSearchBtn').addEventListener('click', () => {
        $('prodSearch').value = '';
        refreshProducts();
      });
    } else {
      tbody.innerHTML = stateCell(8, `
        <div class="state-box">
          <div class="state-ic">${window.icon('products', { size: 28 })}</div>
          <div class="t">${escapeHtml(t('prod.empty.title'))}</div>
          <div class="s">${escapeHtml(t('prod.empty.sub'))}</div>
          <button type="button" class="btn small primary" id="emptyAddProductBtn">${escapeHtml(t('prod.new'))}</button>
        </div>`);
      $('emptyAddProductBtn').addEventListener('click', () => openProductModal());
    }
    return;
  }
  tbody.innerHTML = list.map(p => {
    const [cls, label] = statusOf(p);
    return `<tr>
      <td><b>${escapeHtml(p.name)}</b></td>
      <td class="muted">${escapeHtml(p.barcode || '—')}</td>
      <td>${p.category_name
        ? `<span class="cat-chip"><span class="dot" style="background:${escapeHtml(p.category_color || '#94a3b8')}"></span>${escapeHtml(p.category_name)}</span>`
        : '<span class="muted">—</span>'}</td>
      <td>${money(p.price)} <span class="cur">${settings.currency}</span></td>
      <td class="muted">${money(p.cost)}</td>
      <td><b>${p.quantity}</b></td>
      <td><span class="status-chip ${cls}">${label}</span></td>
      <td>
        <div class="actions-cell">
          <button class="btn small" data-act="restock" data-id="${p.id}">${escapeHtml(t('prod.restockBtn'))}</button>
          <button class="btn small icon-act" data-act="edit" data-id="${p.id}" aria-label="${escapeHtml(t('aria.edit'))}" title="${escapeHtml(t('aria.edit'))}">${window.icon('edit', { size: 14 })}</button>
          <button class="btn small danger-text icon-act" data-act="delete" data-id="${p.id}" aria-label="${escapeHtml(t('aria.delete'))}" title="${escapeHtml(t('aria.delete'))}">${window.icon('delete', { size: 14 })}</button>
        </div>
      </td>
    </tr>`;
  }).join('');
}

$('productsBody').addEventListener('click', async (e) => {
  const btn = e.target.closest('button[data-act]');
  if (!btn) return;
  const id = Number(btn.dataset.id);
  const products = await window.pos.products.list('');
  const p = products.find(x => x.id === id);
  if (!p) return;

  if (btn.dataset.act === 'restock') {
    restockProductId = id;
    $('restockTitle').textContent = `${t('restock.title')} — ${p.name}`;
    $('restockInfo').textContent = t('restock.currentQty', { qty: p.quantity });
    openModal('restockModal');
    $('restockForm').qty.value = '';
    $('restockForm').qty.focus();

  } else if (btn.dataset.act === 'edit') {
    openProductModal(p);

  } else if (btn.dataset.act === 'delete') {
    const ok = await confirmDialog('confirm.delete', { name: p.name });
    if (!ok) return;
    try {
      await window.pos.products.remove(id);
      toast(t('toast.deleted'), 'success');
      refreshAll();
    } catch (err) {
      toast(err.message?.replace(/^Error: /, ''), 'error');
    }
  }
});

$('prodSearch').addEventListener('input', () => refreshProducts());

/* ---------------- Product modal ---------------- */

function openProductModal(product = null) {
  editingProductId = product ? product.id : null;
  $('productModalTitle').textContent = product
    ? `${t('prod.modalEdit')} ${product.name}`
    : t('prod.modalNew');
  $('qtyFieldWrap').style.display = product ? 'none' : '';

  const f = $('productForm');
  f.name.value = product?.name || '';
  f.barcode.value = product?.barcode || '';
  f.category_id.value = product?.category_id ?? '';
  if (f.category_id.value !== String(product?.category_id ?? '')) f.category_id.value = '';
  f.price.value = product?.price ?? '';
  f.cost.value = product?.cost ?? 0;
  f.quantity.value = 0;
  f.low_stock_threshold.value = product?.low_stock_threshold ?? 5;

  openModal('productModal');
  f.name.focus();
}

$('addProductBtn').addEventListener('click', () => openProductModal());
$('productCancelBtn').addEventListener('click', () => closeModal('productModal'));

$('productForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = e.target;
  const payload = {
    name: f.name.value.trim(),
    barcode: f.barcode.value.trim() || null,
    category_id: f.category_id.value ? Number(f.category_id.value) : null,
    price: Number(f.price.value),
    cost: Number(f.cost.value || 0),
    low_stock_threshold: Number(f.low_stock_threshold.value)
  };
  try {
    if (editingProductId) {
      await window.pos.products.update(editingProductId, payload);
      toast(t('toast.productUpdated'), 'success');
    } else {
      payload.quantity = Number(f.quantity.value || 0);
      await window.pos.products.create(payload);
      toast(t('toast.productAdded'), 'success');
    }
    closeModal('productModal');
    refreshAll();
  } catch (err) {
    toast(err.message?.replace(/^Error: /, ''), 'error');
  }
});

/* ---------------- Restock modal ---------------- */

$('restockCancelBtn').addEventListener('click', () => closeModal('restockModal'));

$('restockForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  try {
    await window.pos.products.restock(restockProductId, Number(e.target.qty.value), e.target.note.value.trim());
    toast(t('toast.restocked'), 'success');
    closeModal('restockModal');
    refreshAll();
  } catch (err) {
    toast(err.message?.replace(/^Error: /, ''), 'error');
  }
});

/* ---------------- Sales ---------------- */

async function refreshSales() {
  const tbody = $('salesBody');
  tbody.innerHTML = loadingState(8);
  let sales;
  try {
    sales = await window.pos.sales.list(100);
  } catch {
    tbody.innerHTML = errorState(8, 'sales');
    wireRetry(tbody, refreshSales);
    return;
  }
  if (sales.length === 0) {
    tbody.innerHTML = stateCell(8, `
      <div class="state-box">
        <div class="state-ic">${window.icon('sales', { size: 28 })}</div>
        <div class="t">${escapeHtml(t('empty.sales.title'))}</div>
        <div class="s">${escapeHtml(t('empty.sales.sub'))}</div>
      </div>`);
    return;
  }
  tbody.innerHTML = sales.map(s => `
    <tr>
      <td><b>${s.invoice_no}</b></td>
      <td class="muted">${escapeHtml(s.branch_name || '—')}</td>
      <td class="muted">${fmtDate(s.created_at)}</td>
      <td>${s.payment_method === 'card' ? t('pay.card') : t('pay.cash')}</td>
      <td>${money(s.tax_total)}</td>
      <td>${money(s.discount)}</td>
      <td><b>${money(s.total)} <span class="cur">${settings.currency}</span></b></td>
      <td>
        <div class="actions-cell">
          <button class="btn small" data-sale="${s.id}">${escapeHtml(t('common.view'))}</button>
          <button class="btn small icon-act" data-pdf="${s.id}" aria-label="${escapeHtml(t('aria.pdf'))}" title="${escapeHtml(t('aria.pdf'))}">${window.icon('print', { size: 14 })}</button>
        </div>
      </td>
    </tr>`).join('');
}

$('salesBody').addEventListener('click', async (e) => {
  const pdfBtn = e.target.closest('button[data-pdf]');
  if (pdfBtn) {
    try {
      const r = await window.pos.invoices.generate(Number(pdfBtn.dataset.pdf));
      toast(t('invoice.saved'), 'success');
      window.pos.invoices.open(r.path);
    } catch {
      toast(t('invoice.failed'), 'error');
    }
    return;
  }
  const btn = e.target.closest('button[data-sale]');
  if (!btn) return;
  await showSaleDetails(Number(btn.dataset.sale));
});

async function showSaleDetails(saleId) {
  const sale = await window.pos.sales.get(Number(saleId));
  if (!sale) return;

  $('saleModalTitle').textContent = `${sale.invoice_no} — ${fmtDate(sale.created_at)}`;
  $('saleItemsBody').innerHTML = sale.items.map(si => `
    <tr>
      <td>${escapeHtml(si.product_name)}</td>
      <td>${si.quantity}</td>
      <td>${money(si.unit_price)}</td>
      <td>${money(si.line_tax)}</td>
      <td>${money(si.line_total)}</td>
    </tr>`).join('');
  $('saleTotals').innerHTML = `
    <div class="row"><span>${t('cart.subtotal')}</span><b>${money(sale.subtotal)}</b></div>
    <div class="row"><span>${t('cart.tax')}</span><b>${money(sale.tax_total)}</b></div>
    <div class="row"><span>${t('tbl.discount')}</span><b>${money(sale.discount)}</b></div>
    <div class="row total"><span>${t('tbl.grand')}</span><b>${money(sale.total)} ${settings.currency}</b></div>`;
  openModal('saleModal');
}

$('saleCloseBtn').addEventListener('click', () => closeModal('saleModal'));

/* ---------------- Movements ---------------- */

const mvState = { page: 0, limit: 50 };

function mvFilters() {
  return {
    q: $('mvSearch').value.trim(),
    reason: $('mvReasonFilter').value,
    ref_type: $('mvRefFilter').value,
    branch_id: $('mvBranchFilter') ? $('mvBranchFilter').value : '',
    date_from: $('mvDateFrom').value || '',
    date_to: $('mvDateTo').value || '',
    limit: mvState.limit,
    offset: mvState.page * mvState.limit
  };
}

function mvRefCell(m) {
  if (m.ref_type === 'sale' && m.ref_id) {
    return `<button class="btn small link-act" data-mvsale="${m.ref_id}">#${m.ref_id}</button>`;
  }
  if (m.ref_type === 'grn' && m.ref_id) return `<span class="ref-chip">GRN #${m.ref_id}</span>`;
  if (m.ref_type === 'reconciliation' && m.ref_id) return `<span class="ref-chip">#${m.ref_id}</span>`;
  if (m.ref_type === 'transfer' && m.ref_id) return `<span class="ref-chip">${escapeHtml(t('mv.ref.transfer'))} #${m.ref_id}</span>`;
  return '<span class="muted">—</span>';
}

async function refreshMovements() {
  const tbody = $('movementsBody');
  tbody.innerHTML = loadingState(8);
  let res;
  try {
    res = await window.pos.inventory.movementsPaged(mvFilters());
  } catch (err) {
    tbody.innerHTML = errorState(8, 'movements');
    wireRetry(tbody, refreshMovements);
    return;
  }
  const { rows, total } = res;
  const maxPage = Math.max(0, Math.ceil(total / mvState.limit) - 1);
  if (mvState.page > maxPage) { mvState.page = maxPage; return refreshMovements(); }
  $('mvPrevBtn').disabled = mvState.page <= 0;
  $('mvNextBtn').disabled = mvState.page >= maxPage;
  $('mvPageInfo').textContent = total > 0
    ? t('mv.pageInfo', { from: mvState.page * mvState.limit + 1, to: Math.min(total, (mvState.page + 1) * mvState.limit), total })
    : '';
  if (rows.length === 0) {
    tbody.innerHTML = stateCell(7, `
      <div class="state-box">
        <div class="state-ic">${window.icon('inventory', { size: 28 })}</div>
        <div class="t">${escapeHtml(t('empty.mov.title'))}</div>
      </div>`);
    return;
  }
  tbody.innerHTML = rows.map(m => {
    let reason = t(`mv.reason.${m.reason}`);
    if (reason.startsWith('mv.reason.')) reason = m.reason; // unknown key fallback
    const code = m.reason_code ? ` <span class="ref-chip">${escapeHtml(t(`inv.rc.${m.reason_code}`))}</span>` : '';
    const actor = m.actor_username
      ? `${escapeHtml(m.actor_display_name || m.actor_username)}`
      : '<span class="muted">—</span>';
    return `<tr>
      <td class="muted">${fmtDate(m.created_at)}</td>
      <td class="muted">${escapeHtml(m.branch_name || '—')}</td>
      <td><b>${escapeHtml(m.product_name)}</b></td>
      <td class="${m.change >= 0 ? 'mv-pos' : 'mv-neg'}">${m.change >= 0 ? '+' : ''}${m.change}</td>
      <td>${escapeHtml(reason)}${code}${m.note ? ` (${escapeHtml(m.note)})` : ''}</td>
      <td>${mvRefCell(m)}</td>
      <td>${actor}</td>
      <td><b>${m.balance_after}</b></td>
    </tr>`;
  }).join('');
}

$('movementsBody').addEventListener('click', async (e) => {
  const btn = e.target.closest('button[data-mvsale]');
  if (!btn) return;
  await showSaleDetails(Number(btn.dataset.mvsale));
});

const mvSearchDebounced = debounce(() => { mvState.page = 0; refreshMovements(); }, 300);
$('mvSearch').addEventListener('input', mvSearchDebounced);
['mvReasonFilter', 'mvRefFilter', 'mvBranchFilter', 'mvDateFrom', 'mvDateTo'].forEach(id => {
  $(id).addEventListener('change', () => { mvState.page = 0; refreshMovements(); });
});
$('mvResetBtn').addEventListener('click', () => {
  $('mvSearch').value = '';
  $('mvReasonFilter').value = '';
  $('mvRefFilter').value = '';
  $('mvBranchFilter').value = '';
  $('mvDateFrom').value = '';
  $('mvDateTo').value = '';
  mvState.page = 0;
  refreshMovements();
});
$('mvPrevBtn').addEventListener('click', () => { if (mvState.page > 0) { mvState.page--; refreshMovements(); } });
$('mvNextBtn').addEventListener('click', () => { mvState.page++; refreshMovements(); });

/* ---------------- Advanced Inventory (Phase 23) ---------------- */

const ADJUST_REASONS_UI = ['damaged', 'lost', 'found', 'counting_error', 'opening_balance', 'correction', 'other'];
const RECON_ST = {
  open: ['st-submitted'],
  applied: ['st-fully_received'],
  cancelled: ['st-cancelled'],
  stale: ['st-partially_received']
};
let adjTarget = null;
let rulesTarget = null;
let reconProductsCache = [];

async function refreshInvadv() {
  await Promise.all([refreshInvOverview(), refreshValuation(), refreshRecons()]);
}

async function refreshInvOverview() {
  const box = $('invOverview');
  let ov;
  try {
    ov = await window.pos.inventory.overview();
  } catch {
    box.innerHTML = `<div class="stat-card"><div class="stat-value muted">—</div></div>`;
    return;
  }
  const cards = [
    [t('inv.ovValue'), money(ov.total_value), settings.currency],
    [t('inv.ovProducts'), ov.products_count, t('cats.many', { n: ov.products_count })],
    [t('inv.ovLow'), ov.low_count, ''],
    [t('inv.ovOut'), ov.out_count, '']
  ];
  if (PERMS.has('inventory.reconcile')) {
    cards.push([t('inv.ovOpen'), ov.open_reconciliations, '']);
  }
  box.innerHTML = cards.map(([label, value, sub]) => `
    <div class="stat-card">
      <div class="stat-label">${escapeHtml(label)}</div>
      <div class="stat-value">${escapeHtml(String(value))}</div>
      <div class="stat-sub">${escapeHtml(String(sub))}</div>
    </div>`).join('');
}

function valuationFilters() {
  return {
    q: $('valSearch').value.trim(),
    category_id: $('valCat').value || '',
    branch_id: $('valBranch') ? $('valBranch').value : '',
    low_stock_only: $('valLowOnly').checked
  };
}

async function refreshValuation() {
  const tbody = $('valBody');
  tbody.innerHTML = loadingState(8);
  let res;
  try {
    res = await window.pos.inventory.valuation(valuationFilters());
  } catch {
    tbody.innerHTML = errorState(8, 'inv');
    wireRetry(tbody, refreshValuation);
    return;
  }
  const canAdjust = PERMS.has('inventory.adjust');
  const canRules = PERMS.has('inventory.rules.manage');
  const canCost = PERMS.has('inventory.cost.read');

  if (res.rows.length === 0) {
    tbody.innerHTML = stateCell(8, `
      <div class="state-box">
        <div class="state-ic">${window.icon('inventory', { size: 28 })}</div>
        <div class="t">${escapeHtml(t('inv.noRows'))}</div>
      </div>`);
  } else {
    tbody.innerHTML = res.rows.map(r => {
      const [stCls, stLabel] = statusOf(r);
      const acts = [
        canAdjust ? `<button class="btn small icon-act" data-invadj="${r.id}" title="${escapeHtml(t('inv.adjustTitle'))}" aria-label="${escapeHtml(t('inv.adjustTitle'))}">${window.icon('edit', { size: 14 })}</button>` : '',
        canRules ? `<button class="btn small icon-act" data-invrules="${r.id}" title="${escapeHtml(t('inv.rulesTitle'))}" aria-label="${escapeHtml(t('inv.rulesTitle'))}">${window.icon('settings', { size: 14 })}</button>` : '',
        canCost ? `<button class="btn small icon-act" data-invcost="${r.id}" data-name="${escapeHtml(r.name)}" title="${escapeHtml(t('inv.costTitle'))}" aria-label="${escapeHtml(t('inv.costTitle'))}">${window.icon('view', { size: 14 })}</button>` : ''
      ].join('');
      return `<tr>
        <td><b>${escapeHtml(r.name)}</b>${r.barcode ? ` <span class="muted">${escapeHtml(r.barcode)}</span>` : ''}</td>
        <td class="muted">${escapeHtml(r.branch_name || '—')}</td>
        <td class="muted">${escapeHtml(r.category_name || '—')}</td>
        <td><b>${r.quantity}</b> <span class="status-badge ${stCls}">${escapeHtml(stLabel)}</span></td>
        <td>${money(r.cost)} <span class="cur">${settings.currency}</span></td>
        <td><b>${money(r.value)} <span class="cur">${settings.currency}</span></b></td>
        <td>${r.suggested_order != null ? `<b class="mv-pos">+${r.suggested_order}</b>` : '<span class="muted">—</span>'}</td>
        <td><div class="actions-cell">${acts}</div></td>
      </tr>`;
    }).join('');
  }
  $('valTotals').innerHTML = `
    <span>${escapeHtml(t('inv.totalProducts'))}: <b>${res.totals.filtered_total_products}</b></span>
    <span>${escapeHtml(t('inv.ovLow'))}: <b>${res.totals.low_count}</b> · ${escapeHtml(t('inv.ovOut'))}: <b>${res.totals.out_count}</b></span>
    <span>${escapeHtml(t('inv.grandValue'))}: <b>${money(res.totals.total_value)} <span class="cur">${settings.currency}</span></b></span>`;
}

const valSearchDebounced = debounce(refreshValuation, 300);
$('valSearch').addEventListener('input', valSearchDebounced);
$('valCat').addEventListener('change', refreshValuation);
$('valBranch').addEventListener('change', refreshValuation);
$('valLowOnly').addEventListener('change', refreshValuation);

async function populateValCategories() {
  try {
    const catsList = await window.pos.categories.list();
    const sel = $('valCat');
    sel.innerHTML = `<option value="">${escapeHtml(t('inv.allCats'))}</option>` +
      catsList.map(c => `<option value="${c.id}">${escapeHtml(c.name)}</option>`).join('');
  } catch { /* non-critical */ }
}

async function refreshRecons() {
  const tbody = $('reconsBody');
  if (!tbody) return;
  tbody.innerHTML = loadingState(8);
  let rows;
  try {
    rows = await window.pos.inventory.recons({ limit: 50 });
  } catch {
    tbody.innerHTML = errorState(8, 'recons');
    wireRetry(tbody, refreshRecons);
    return;
  }
  if (rows.length === 0) {
    tbody.innerHTML = stateCell(8, `
      <div class="state-box">
        <div class="state-ic">${window.icon('check', { size: 28 })}</div>
        <div class="t">${escapeHtml(t('inv.noRecons'))}</div>
      </div>`);
    return;
  }
  tbody.innerHTML = rows.map(r => {
    const [cls] = RECON_ST[r.status] || [''];
    const diffCls = r.diff_qty > 0 ? 'mv-pos' : r.diff_qty < 0 ? 'mv-neg' : 'muted';
    const actor = r.created_by_name ? escapeHtml(r.created_by_name) : '<span class="muted">—</span>';
    const acts = r.status === 'open'
      ? `<div class="actions-cell">
           <button class="btn small primary" data-reconok="${r.id}">${escapeHtml(t('inv.confirm'))}</button>
           <button class="btn small ghost" data-reconcancel="${r.id}">${escapeHtml(t('common.cancel'))}</button>
         </div>`
      : '';
    return `<tr${r.status === 'open' ? ' class="row-active"' : ''}>
      <td class="muted">#${r.id}</td>
      <td><b>${escapeHtml(r.product_name)}</b></td>
      <td>${r.system_qty}</td>
      <td>${r.counted_qty}</td>
      <td class="${diffCls}"><b>${r.diff_qty > 0 ? '+' : ''}${r.diff_qty}</b></td>
      <td><span class="status-badge ${cls}">${escapeHtml(t('inv.rs.' + r.status))}</span></td>
      <td>${actor}</td>
      <td>${acts}</td>
    </tr>`;
  }).join('');
}

$('reconsBody').addEventListener('click', async (e) => {
  const okBtn = e.target.closest('button[data-reconok]');
  if (okBtn) {
    try {
      await window.pos.inventory.reconConfirm(Number(okBtn.dataset.reconok));
      toast(t('inv.confirmedToast'), 'success');
    } catch (err) {
      toast(err.message?.replace(/^Error: /, ''), 'error');
    }
    refreshInvadv();
    return;
  }
  const cancelBtn = e.target.closest('button[data-reconcancel]');
  if (!cancelBtn) return;
  try {
    await window.pos.inventory.reconCancel(Number(cancelBtn.dataset.reconcancel));
    toast(t('toast.saved'), 'success');
  } catch (err) {
    toast(err.message?.replace(/^Error: /, ''), 'error');
  }
  refreshRecons();
});

/* --- Adjustment modal --- */

function openAdjustModal(product) {
  adjTarget = product;
  $('invAdjProductName').textContent = product.name;
  $('invAdjCurrentQty').textContent = String(product.quantity);
  const f = $('invAdjustForm');
  f.reset();
  f.delta.value = '';
  updateAdjPreview();
  hideErr($('invAdjustErr'));
  openModal('invAdjustModal');
}

function updateAdjPreview() {
  const f = $('invAdjustForm');
  const d = Math.trunc(Number(f.delta.value));
  if (!Number.isFinite(d) || f.delta.value === '' || !adjTarget) {
    $('invAdjPreview').textContent = '—';
    return;
  }
  const result = adjTarget.quantity + d;
  const el = $('invAdjPreview');
  el.textContent = `${result}`;
  el.className = result < 0 ? 'mv-neg' : '';
}

$('invAdjustForm').addEventListener('input', updateAdjPreview);

$('invAdjustForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = e.target;
  try {
    await window.pos.inventory.adjust({
      product_id: adjTarget.id,
      delta: Number(f.delta.value),
      reason_code: f.reason_code.value,
      note: f.note.value.trim()
    });
    closeModal('invAdjustModal');
    toast(t('inv.adjustedToast'), 'success');
    refreshInvadv();
  } catch (err) {
    showErr($('invAdjustErr'), err);
  }
});
$('invAdjustCancelBtn').addEventListener('click', () => closeModal('invAdjustModal'));

/* --- Reorder rules modal --- */

function openRulesModal(product) {
  rulesTarget = product;
  $('invRulesProductName').textContent = product.name;
  const f = $('invRulesForm');
  f.low_stock_threshold.value = String(product.low_stock_threshold ?? 0);
  f.reorder_qty.value = String(product.reorder_qty ?? 0);
  hideErr($('invRulesErr'));
  openModal('invRulesModal');
}

$('invRulesForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = e.target;
  try {
    await window.pos.inventory.setRules(rulesTarget.id, {
      low_stock_threshold: Number(f.low_stock_threshold.value),
      reorder_qty: Number(f.reorder_qty.value)
    });
    closeModal('invRulesModal');
    toast(t('toast.saved'), 'success');
    refreshInvadv();
  } catch (err) {
    showErr($('invRulesErr'), err);
  }
});
$('invRulesCancelBtn').addEventListener('click', () => closeModal('invRulesModal'));

/* --- Reconciliation modal --- */

async function populateReconProducts() {
  try {
    reconProductsCache = await window.pos.products.list('');
    const sel = $('invReconProduct');
    sel.innerHTML = reconProductsCache.map(p =>
      `<option value="${p.id}">${escapeHtml(p.name)} (${p.quantity})</option>`).join('');
    updateReconSystemQty();
  } catch { /* handled on submit otherwise */ }
}

function updateReconSystemQty() {
  const id = Number($('invReconProduct').value);
  const p = reconProductsCache.find(x => x.id === id);
  $('invReconSystemQty').textContent = p ? String(p.quantity) : '—';
}

$('invReconProduct').addEventListener('change', updateReconSystemQty);

$('newReconBtn').addEventListener('click', async () => {
  const f = $('invReconForm');
  f.reset();
  hideErr($('invReconErr'));
  await populateReconProducts();
  openModal('invReconModal');
});

$('invReconForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = e.target;
  try {
    await window.pos.inventory.reconOpen({
      product_id: Number(f.product_id.value),
      counted_qty: Number(f.counted_qty.value),
      reason_code: f.reason_code.value,
      note: f.note.value.trim()
    });
    closeModal('invReconModal');
    toast(t('inv.capturedToast'), 'success');
    refreshInvadv();
  } catch (err) {
    showErr($('invReconErr'), err);
  }
});
$('invReconCancelBtn').addEventListener('click', () => closeModal('invReconModal'));

/* --- Cost history modal --- */

async function openCostHistory(productId, name) {
  $('invCostProductName').textContent = name;
  const tbody = $('invCostBody');
  tbody.innerHTML = loadingState(7);
  openModal('invCostModal');
  let rows;
  try {
    rows = await window.pos.inventory.costHistory({ product_id: productId, limit: 200 });
  } catch {
    tbody.innerHTML = errorState(7, 'cost');
    wireRetry(tbody, () => openCostHistory(productId, name));
    return;
  }
  if (rows.length === 0) {
    tbody.innerHTML = stateCell(7, `
      <div class="state-box">
        <div class="state-ic">${window.icon('inventory', { size: 28 })}</div>
        <div class="t">${escapeHtml(t('inv.noCost'))}</div>
      </div>`);
    return;
  }
  tbody.innerHTML = rows.map(c => {
    let src = escapeHtml(t(`inv.src.${c.source_type}`));
    if (c.source_type === 'grn' && c.grn_ref) src += ` <span class="ref-chip">${escapeHtml(c.grn_ref)}</span>`;
    if (c.supplier_name) src += ` · ${escapeHtml(c.supplier_name)}`;
    return `<tr>
      <td class="muted">${fmtDate(c.created_at)}</td>
      <td>${src}</td>
      <td>${c.qty_received != null ? c.qty_received : '—'}</td>
      <td>${money(c.unit_cost)}</td>
      <td class="muted">${c.prev_cost != null ? money(c.prev_cost) : '—'}</td>
      <td><b>${c.new_cost != null ? money(c.new_cost) : '—'} <span class="cur">${settings.currency}</span></b></td>
      <td>${c.actor_username ? escapeHtml(c.actor_display_name || c.actor_username) : '<span class="muted">—</span>'}</td>
    </tr>`;
  }).join('');
}
$('invCostCloseBtn').addEventListener('click', () => closeModal('invCostModal'));

/* --- Valuation row actions delegation --- */

$('valBody').addEventListener('click', async (e) => {
  const adjBtn = e.target.closest('button[data-invadj]');
  if (adjBtn) {
    const p = await findProduct(Number(adjBtn.dataset.invadj));
    if (p && PERMS.has('inventory.adjust')) openAdjustModal(p);
    return;
  }
  const rulesBtn = e.target.closest('button[data-invrules]');
  if (rulesBtn) {
    const p = await findProduct(Number(rulesBtn.dataset.invrules));
    if (p && PERMS.has('inventory.rules.manage')) openRulesModal(p);
    return;
  }
  const costBtn = e.target.closest('button[data-invcost]');
  if (costBtn) {
    openCostHistory(Number(costBtn.dataset.invcost), costBtn.dataset.name || '');
  }
});

async function findProduct(id) {
  try {
    const list = await window.pos.products.list('');
    return list.find(p => p.id === id) || null;
  } catch {
    return null;
  }
}

function showErr(el, err) {
  el.textContent = String(err?.message || '').replace(/^Error: /, '');
  el.hidden = false;
}
function hideErr(el) {
  el.hidden = true;
  el.textContent = '';
}

/* ---------------- Categories ---------------- */

function fmtProducts(n) {
  if (n === 1) return t('cats.one');
  if (n === 2) return t('cats.two');
  return t('cats.many', { n });
}

function sortedCats(list) {
  const arr = [...list];
  if (catSortMode === 'name') arr.sort((a, b) => a.name.localeCompare(b.name, 'ar'));
  else if (catSortMode === 'count') arr.sort((a, b) => b.product_count - a.product_count || a.name.localeCompare(b.name, 'ar'));
  else if (catSortMode === 'newest') arr.sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
  else if (catSortMode === 'oldest') arr.sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)));
  return arr;
}

async function loadCategories() {
  const listView = $('catsList');
  try {
    catsState = 'loading';
    renderCats();
    const [list, stats] = await Promise.all([
      window.pos.categories.list(),
      window.pos.stats.categories()
    ]);
    cats = list;
    catsState = 'ready';

    $('csTotal').textContent = stats.total;
    $('csProducts').textContent = stats.products_total;
    $('csTop').textContent = stats.top_category ? `${stats.top_category} (${stats.top_count})` : '—';
    $('csEmpty').textContent = stats.empty_categories;
    $('catsSubtitle').textContent = t('cats.subtitle', { n: cats.length });

    renderCats();
    fillCategorySelects();
  } catch {
    catsState = 'error';
    renderCats();
  }
}

function renderCats() {
  const list = $('catsList');

  if (catsState === 'loading') {
    list.innerHTML = Array.from({ length: 5 }).map(() => `
      <div class="skel-row">
        <div class="skel dot"></div>
        <div class="skel line"></div>
        <div class="skel chip"></div>
      </div>`).join('');
    return;
  }

  if (catsState === 'error') {
    list.innerHTML = `
      <div class="state-box">
        <div class="state-ic">${window.icon('notification', { size: 28 })}</div>
        <div class="t">${t('err.load')}</div>
        <button class="btn primary" id="catsRetryBtn">${t('common.retry')}</button>
      </div>`;
    $('catsRetryBtn').addEventListener('click', loadCategories);
    return;
  }

  const q = $('catSearch').value.trim().toLowerCase();
  const filtered = sortedCats(q ? cats.filter(c => c.name.toLowerCase().includes(q)) : cats);

  if (filtered.length === 0) {
    const isSearch = q.length > 0;
    list.innerHTML = isSearch
      ? `
        <div class="state-box">
          <div class="state-ic">${window.icon('search', { size: 28 })}</div>
          <div class="t">${t('prod.noResults.title')}</div>
          <button class="btn small" id="clearCatSearchBtn">${t('prod.clearSearch')}</button>
        </div>`
      : `
        <div class="state-box">
          <div class="state-ic">${window.icon('categories', { size: 28 })}</div>
          <div class="t">${t('empty.catsTitle')}</div>
          <div class="s">${t('empty.catsSub')}</div>
          <button class="btn primary" id="catsEmptyAddBtn">${t('cats.add')}</button>
        </div>`;
    if (isSearch) {
      $('clearCatSearchBtn').addEventListener('click', () => {
        $('catSearch').value = '';
        renderCats();
      });
    } else {
      $('catsEmptyAddBtn').addEventListener('click', () => openCategoryModal());
    }
    return;
  }

  list.innerHTML = '';
  for (const c of filtered) {
    const row = document.createElement('div');
    row.className = 'cat-row';
    row.innerHTML = `
      <span class="cat-dot" style="background:${escapeHtml(c.color)}"></span>
      <span class="cat-name" title="${escapeHtml(c.name)}">${escapeHtml(c.name)}</span>
      <button class="cat-count" title="${escapeHtml(t('cats.menuView'))}">${fmtProducts(c.product_count)}</button>
      <button class="kebab-btn" aria-label="${escapeHtml(t('aria.more'))}" title="${escapeHtml(t('aria.more'))}">${window.icon('more', { size: 16 })}</button>
      ${openMenuCatId === c.id ? `
        <div class="row-menu">
          <button data-m="edit">${window.icon('edit', { size: 14 })}&nbsp;&nbsp;${t('cats.menuEdit')}</button>
          <button data-m="view">${window.icon('view', { size: 14 })}&nbsp;&nbsp;${t('cats.menuView')}</button>
          <button data-m="delete" class="danger">${window.icon('delete', { size: 14 })}&nbsp;&nbsp;${t('cats.menuDelete')}</button>
        </div>` : ''}`;

    row.querySelector('.kebab-btn').addEventListener('click', (e) => {
      e.stopPropagation();
      openMenuCatId = openMenuCatId === c.id ? null : c.id;
      renderCats();
    });
    row.querySelector('.cat-count').addEventListener('click', (e) => {
      e.stopPropagation();
      gotoProductsOf(c);
    });
    row.addEventListener('click', () => gotoProductsOf(c));
    row.querySelectorAll('.row-menu button').forEach(mb => {
      mb.addEventListener('click', (e) => {
        e.stopPropagation();
        const act = mb.dataset.m;
        closeCatMenu();
        if (act === 'edit') openCategoryModal(c);
        else if (act === 'view') gotoProductsOf(c);
        else if (act === 'delete') openDeleteCatModal(c);
      });
    });
    list.appendChild(row);
  }
}

function closeCatMenu() {
  if (openMenuCatId !== null) {
    openMenuCatId = null;
    if (catsState === 'ready' && !$('tab-categories').classList.contains('hidden')) renderCats();
  }
}
document.addEventListener('click', closeCatMenu);

function gotoProductsOf(cat) {
  $('prodSearch').value = cat.name;
  activateTab('products');
}

$('catSearch').addEventListener('input', () => { if (catsState === 'ready') renderCats(); });
$('catSort').addEventListener('change', (e) => {
  catSortMode = e.target.value;
  if (catsState === 'ready') renderCats();
});

/* --- Category add/edit modal --- */

function buildSwatches(selected) {
  const wrap = $('colorSwatches');
  wrap.innerHTML = '';
  for (const [hex, key] of PALETTE) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'swatch' + (hex === selected ? ' selected' : '');
    b.style.background = hex;
    b.title = t(key);
    b.setAttribute('aria-label', t(key));
    b.addEventListener('click', () => { selectedColor = hex; buildSwatches(hex); });
    wrap.appendChild(b);
  }
}

function openCategoryModal(cat = null) {
  editingCatId = cat ? cat.id : null;
  $('categoryModalTitle').textContent = cat ? t('cats.modalEdit') : t('cats.modalNew');
  $('categorySaveBtn').textContent = cat ? t('cats.saveChanges') : t('cats.saveNew');
  $('categorySaveBtn').disabled = false;
  $('categoryForm').name.value = cat?.name || '';
  selectedColor = cat?.color || PALETTE[0][0];
  buildSwatches(selectedColor);
  openModal('categoryModal');
  $('categoryForm').name.focus();
}

$('addCategoryBtn').addEventListener('click', () => openCategoryModal());
$('categoryCancelBtn').addEventListener('click', () => closeModal('categoryModal'));

$('categoryForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const name = e.target.name.value.trim();
  if (!name) return;

  const dup = cats.find(c => c.name.toLowerCase() === name.toLowerCase() && c.id !== editingCatId);
  if (dup) {
    toast(t('err.catDuplicate', { name }), 'error');
    return;
  }

  const saveBtn = $('categorySaveBtn');
  saveBtn.disabled = true; // prevent double-submit
  try {
    if (editingCatId) {
      await window.pos.categories.update(editingCatId, { name, color: selectedColor });
      toast(t('toast.catUpdated'), 'success');
    } else {
      await window.pos.categories.create({ name, color: selectedColor });
      toast(t('toast.catAdded'), 'success');
    }
    closeModal('categoryModal');
    await loadCategories();
  } catch (err) {
    toast(err.message?.replace(/^Error: /, ''), 'error');
  } finally {
    saveBtn.disabled = false;
  }
});

/* --- Category delete modal --- */

function openDeleteCatModal(cat) {
  deleteCatId = cat.id;
  $('delWarnText').textContent = t('del.warn', { name: cat.name });

  const hasProducts = cat.product_count > 0;
  const optionsBox = document.querySelector('#deleteCatModal .del-options');
  optionsBox.style.display = hasProducts ? '' : 'none';
  $('delProductsQ').style.display = hasProducts ? '' : 'none';
  if (hasProducts) {
    $('delProductsQ').textContent = t('del.hasProducts', { n: fmtProducts(cat.product_count) });
    const sel = $('moveToSelect');
    sel.innerHTML = cats.filter(x => x.id !== cat.id)
      .map(x => `<option value="${x.id}">${escapeHtml(x.name)}</option>`).join('');
    sel.disabled = sel.options.length === 0;
    document.querySelector('input[name="delMode"][value="move"]').checked = true;
  }

  $('deleteCatConfirmBtn').disabled = false;
  openModal('deleteCatModal');
}

$('deleteCatCancelBtn').addEventListener('click', () => closeModal('deleteCatModal'));

$('deleteCatConfirmBtn').addEventListener('click', async () => {
  const btn = $('deleteCatConfirmBtn');
  btn.disabled = true;
  try {
    const mode = document.querySelector('input[name="delMode"]:checked')?.value || 'detach';
    const moveTo = mode === 'move' ? (Number($('moveToSelect').value) || null) : null;
    await window.pos.categories.remove(deleteCatId, moveTo);
    toast(t('toast.catDeleted'), 'success');
    closeModal('deleteCatModal');
    await loadCategories();
    refreshAll();
  } catch (err) {
    toast(err.message?.replace(/^Error: /, ''), 'error');
  } finally {
    btn.disabled = false;
  }
});

/* --- Category select inside product form --- */

function fillCategorySelects() {
  const sel = $('productCategorySelect');
  if (!sel) return;
  const current = sel.value;
  sel.innerHTML = `<option value="">${t('prod.noCategory')}</option>` +
    cats.map(c => `<option value="${c.id}">${escapeHtml(c.name)}</option>`).join('');
  sel.value = current;
  if (sel.value !== current) sel.value = '';
}

/* ---------------- Settings ---------------- */

async function loadSettingsForm() {
  settings = await window.pos.settings.get();
  $('storeName').textContent = settings.store_name;
  document.querySelectorAll('.cur').forEach(el => el.textContent = settings.currency);
  const f = $('settingsForm');
  f.store_name.value = settings.store_name;
  f.tax_rate.value = settings.tax_rate;
  f.currency.value = settings.currency;
}

$('settingsForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = e.target;
  try {
    for (const key of ['store_name', 'tax_rate', 'currency']) {
      await window.pos.settings.set(key, f[key].value);
    }
    toast(t('toast.saved'), 'success');
    loadSettingsForm();
  } catch (err) {
    toast(err.message?.replace(/^Error: /, ''), 'error');
  }
});

/* ---------------- Refresh & live sync ---------------- */

let activeTab = 'dashboard';

function refreshActiveTab() {
  refreshDashboard(); // stats + alerts always fresh for badge/banner
  if (activeTab === 'products') refreshProducts();
  if (activeTab === 'categories') loadCategories();
  if (activeTab === 'sales') refreshSales();
  if (activeTab === 'movements') refreshMovements();
  if (activeTab === 'invadv') refreshInvadv();
  if (activeTab === 'users' && PERMS.has('users.manage')) refreshUsers();
  if (activeTab === 'suppliers' && PERMS.has('suppliers.manage')) refreshSuppliers();
  if (activeTab === 'purchases' && PERMS.has('purchases.read')) refreshPurchases();
  if (activeTab === 'transfers' && PERMS.has('transfers.read')) refreshTransfers();
  if (activeTab === 'branches' && PERMS.has('branches.read')) refreshBranches();
  if (activeTab === 'conflicts' && PERMS.has('settings.manage')) refreshConflicts();
  if (activeTab === 'billing' && PERMS.has('settings.manage')) refreshBilling();
  if (activeTab === 'analytics' && PERMS.has('analytics.read')) refreshAnalytics();
  if (activeTab === 'ai' && PERMS.has('ai.read')) refreshAi();
}

function refreshAll() { refreshActiveTab(); }

window.pos.onChanged(async (payload) => {
  if (payload.topic === 'settings') {
    await loadSettingsForm();
    applyPrefs();
    refreshAll();
    return;
  }
  if (payload.topic === 'category' && payload.senderIsSelf !== true) {
    await loadCategories();
  }
  refreshAll();
});

/* ---------------- Session & Users (Phase 20) ---------------- */

let ME = null;
let PERMS = new Set();
let editingUserId = null;
let ALL_BRANCHES = [];

function isSessionErr(err) {
  return err && typeof err.message === 'string' && err.message.includes('انتهت الجلسة');
}

async function handleSessionLoss() {
  try { await window.pos.auth.logout(); } catch { /* gate reopens anyway */ }
}

function activeBranches() {
  return ALL_BRANCHES.filter(b => b.status === 'active');
}

function branchNameOf(id) {
  const b = ALL_BRANCHES.find(x => Number(x.id) === Number(id));
  return b ? b.name : `#${id}`;
}

function fillBranchSelect(sel) {
  if (!sel) return;
  const prev = sel.value;
  sel.innerHTML = `<option value="">${escapeHtml(t('mv.allBranches'))}</option>` +
    ALL_BRANCHES.map(b => `<option value="${b.id}">${escapeHtml(b.name)}</option>`).join('');
  if ([...sel.options].some(o => o.value === prev)) sel.value = prev;
}

async function loadBranchesCache() {
  if (!PERMS.has('branches.read')) return;
  try {
    ALL_BRANCHES = await window.pos.branches.list();
  } catch (err) {
    if (isSessionErr(err)) { handleSessionLoss(); return; }
    ALL_BRANCHES = [];
  }
}

async function initBranchUI() {
  await loadBranchesCache();
  const sw = $('branchSwitcher');
  if (!ALL_BRANCHES.length) { sw.classList.add('hidden'); return; }
  sw.innerHTML = activeBranches()
    .map(b => `<option value="${b.id}">${escapeHtml(b.name)}</option>`).join('');
  const curId = ME.branch && ME.branch.id ? ME.branch.id : 1;
  sw.value = String(curId);
  if (![...sw.options].some(o => o.value === String(curId))) sw.classList.add('hidden');
  else sw.classList.remove('hidden');
  fillBranchSelect($('mvBranchFilter'));
  fillBranchSelect($('poBranchFilter'));
  fillBranchSelect($('tfBranchFilter'));
  fillBranchSelect($('valBranch'));
  if (!sw.dataset.wired) {
    sw.dataset.wired = '1';
    sw.addEventListener('change', async () => {
      const bid = Number(sw.value);
      try {
        const res = await window.pos.branches.switch(bid);
        ME.branch = { id: res.id, name: res.name };
        toast(`${t('branch.switcherTitle')}: ${res.name}`, 'success');
        refreshAll();
      } catch (err) {
        if (isSessionErr(err)) return handleSessionLoss();
        toast(err.message, 'error');
        sw.value = String(ME.branch && ME.branch.id ? ME.branch.id : 1);
      }
    });
  }
}

function applySessionUI() {
  if (!ME) return;
  $('userChip').classList.remove('hidden');
  $('userName').textContent = `${ME.display_name || ME.username} · ${t('users.role.' + ME.role)}`;
  $('logoutBtn').innerHTML = window.icon('logout', { size: 16 });
  $('logoutBtn').setAttribute('aria-label', t('common.logout'));
  const canUsers = PERMS.has('users.manage');
  const canSuppliers = PERMS.has('suppliers.manage');
  const canPurchases = PERMS.has('purchases.read');
  const canInvAdv = PERMS.has('inventory.valuation') || PERMS.has('inventory.reconcile');
  const canRecon = PERMS.has('inventory.reconcile');
  const canTransfers = PERMS.has('transfers.read');
  const canBranches = PERMS.has('branches.manage');
  $('usersTabBtn').classList.toggle('hidden', !canUsers);
  $('suppliersTabBtn').classList.toggle('hidden', !canSuppliers);
  $('purchasesTabBtn').classList.toggle('hidden', !canPurchases);
  $('invadvTabBtn').classList.toggle('hidden', !canInvAdv);
  $('transfersTabBtn').classList.toggle('hidden', !canTransfers);
  $('branchesTabBtn').classList.toggle('hidden', !canBranches);
  $('newReconBtn').classList.toggle('hidden', !canRecon);
  $('reconPanel').classList.toggle('hidden', !canRecon);
  if (canUsers) refreshUsers();
  if (canSuppliers) refreshSuppliers();
  if (canPurchases) refreshPurchases();
  if (canInvAdv) { populateValCategories(); refreshInvadv(); }
  // Phase 28: conflict management is owner/admin (settings.manage) + Cloud Mode
  const canConflicts = PERMS.has('settings.manage') && String(settings.cloud_mode || '') === '1';
  $('conflictsTabBtn').classList.toggle('hidden', !canConflicts);
  if (canConflicts) refreshConflicts(); // keeps the open-conflict badge fresh
  initBranchUI().then(() => {
    if (canTransfers) refreshTransfers();
    if (canBranches) refreshBranches();
  });
  // Phase 30: billing tab visible for owner/admin (settings.manage)
  const canBilling = PERMS.has('settings.manage');
  $('billingTabBtn').classList.toggle('hidden', !canBilling);
  // Phase 31: analytics tab visible for owner/admin/manager (analytics.read)
  const canAnalytics = PERMS.has('analytics.read');
  $('analyticsTabBtn').classList.toggle('hidden', !canAnalytics);
  // Phase 32: AI insights tab visible for owner/admin/manager (ai.read)
  const canAi = PERMS.has('ai.read');
  $('aiTabBtn').classList.toggle('hidden', !canAi);
}

/* ---------------- Subscription & Billing (Phase 30) ---------------- */

const BILLING_STATUS_MAP = {
  trialing: 'billing.trialing',
  active: 'billing.active',
  past_due: 'billing.past_due',
  cancelled: 'billing.cancelled',
  suspended: 'billing.suspended',
};

async function refreshBilling() {
  try {
    const [subRes, limitsRes, plansRes, historyRes] = await Promise.all([
      window.billing.subscription(),
      window.billing.limits(),
      window.billing.plans(),
      window.billing.history()
    ]);

    // Current plan & status
    if (subRes && subRes.planName) {
      $('billingPlanName').textContent = escapeHtml(subRes.planName);
      const price = Number(subRes.priceMonthly || 0);
      $('billingPlanPrice').textContent = price > 0
        ? `${price.toFixed(2)} ${escapeHtml(subRes.currency || 'USD')}${t('billing.monthly')}`
        : t('billing.priceFree');
      const statusKey = BILLING_STATUS_MAP[subRes.status] || subRes.status;
      $('billingStatus').textContent = t(statusKey);
      // Trial info
      if (subRes.status === 'trialing' && subRes.trialEndsAt) {
        const daysLeft = Math.max(0, Math.ceil((new Date(subRes.trialEndsAt).getTime() - Date.now()) / 86400000));
        $('billingStatusSub').textContent = daysLeft > 0
          ? t('billing.daysLeft', { days: daysLeft })
          : t('billing.expired');
      } else if (subRes.currentPeriodEndsAt) {
        $('billingStatusSub').textContent = fmtDate(subRes.currentPeriodEndsAt);
      } else {
        $('billingStatusSub').textContent = '';
      }
    } else {
      $('billingPlanName').textContent = '—';
      $('billingPlanPrice').textContent = '';
      $('billingStatus').textContent = '—';
      $('billingStatusSub').textContent = '';
    }

    // Usage/limits
    if (limitsRes && limitsRes.usage) {
      const u = limitsRes.usage;
      const userMax = u.users.max || 0;
      const branchMax = u.branches.max || 0;
      $('billingUsers').textContent = userMax > 0 ? `${u.users.current} / ${userMax}` : `${u.users.current} / ${t('billing.unlimited')}`;
      $('billingBranches').textContent = branchMax > 0 ? `${u.branches.current} / ${branchMax}` : `${u.branches.current} / ${t('billing.unlimited')}`;
    }

    // Alert banner
    const alertEl = $('billingAlert');
    alertEl.classList.add('hidden');
    if (subRes) {
      if (subRes.status === 'trialing' && subRes.trialEndsAt) {
        const daysLeft = Math.max(0, Math.ceil((new Date(subRes.trialEndsAt).getTime() - Date.now()) / 86400000));
        if (daysLeft <= 3 && daysLeft > 0) {
          alertEl.textContent = t('billing.alertTrialExpiring');
          alertEl.classList.remove('hidden');
        } else if (daysLeft <= 0) {
          alertEl.textContent = t('billing.alertTrialExpired');
          alertEl.classList.remove('hidden');
        }
      } else if (subRes.status === 'suspended') {
        alertEl.textContent = t('billing.alertSuspended');
        alertEl.classList.remove('hidden');
      } else if (subRes.status === 'cancelled') {
        alertEl.textContent = t('billing.alertCancelled');
        alertEl.classList.remove('hidden');
      }
    }

    // Plans list
    const plansEl = $('billingPlansList');
    if (plansRes && plansRes.length) {
      const currentSlug = subRes?.planSlug || '';
      plansEl.innerHTML = plansRes.map(p => {
        const isCurrent = p.slug === currentSlug;
        const price = Number(p.priceMonthly || 0);
        const priceStr = price > 0
          ? `${price.toFixed(2)} ${escapeHtml(p.currency || 'USD')}${t('billing.monthly')}`
          : t('billing.priceFree');
        return `<div class="flex" style="justify-content:space-between;align-items:center;padding:10px 0;border-bottom:1px solid var(--border)">
          <div>
            <strong>${escapeHtml(p.name)}</strong>
            <span style="color:var(--text-muted);margin-inline-start:8px">${escapeHtml(p.description)}</span>
            <span style="margin-inline-start:8px;font-weight:600">${priceStr}</span>
          </div>
          <div>${isCurrent ? `<span class="tag">${t('billing.current')}</span>`
            : `<button class="btn small primary" data-billing-plan="${escapeHtml(p.slug)}">${t('billing.selectPlan')}</button>`}</div>
        </div>`;
      }).join('');
      // Wire plan buttons
      plansEl.querySelectorAll('[data-billing-plan]').forEach(btn => {
        btn.addEventListener('click', async () => {
          const slug = btn.dataset.billingPlan;
          if (!confirm(t('billing.confirmUpgrade', { plan: slug }))) return;
          try {
            await window.billing.subscribe(slug);
            toast(t('common.save'), '');
            refreshBilling();
          } catch (err) { toast(err.message, 'error'); }
        });
      });
    } else {
      plansEl.innerHTML = `<div class="state-box"><span class="s">${t('billing.noPlans')}</span></div>`;
    }

    // Billing history
    const histEl = $('billingHistoryList');
    if (historyRes && historyRes.length) {
      histEl.innerHTML = `<div class="table-wrap plain"><table class="tbl"><thead><tr>
        <th>${t('tbl.date')}</th><th>${t('billing.invoice')}</th><th>${t('cf.type')}</th><th>${t('cf.status')}</th>
      </tr></thead><tbody>${historyRes.map(h => `<tr>
        <td>${fmtDate(h.createdAt)}</td>
        <td>${escapeHtml(h.eventType)}</td>
        <td>${escapeHtml(h.provider)}</td>
        <td><span class="status-badge">${escapeHtml(h.status)}</span></td>
      </tr>`).join('')}</tbody></table></div>`;
    } else {
      histEl.innerHTML = `<div class="state-box"><span class="s">${t('billing.noHistory')}</span></div>`;
    }
  } catch (err) {
    $('billingPlanName').textContent = '—';
    $('billingStatus').textContent = '—';
    toast(err.message, 'error');
  }
}

$('billingRenewBtn').addEventListener('click', async () => {
  if (!confirm(t('billing.confirmRenew'))) return;
  try {
    await window.billing.renew();
    toast(t('common.save'), '');
    refreshBilling();
  } catch (err) { toast(err.message, 'error'); }
});

$('billingCancelBtn').addEventListener('click', async () => {
  if (!confirm(t('billing.confirmCancel'))) return;
  try {
    await window.billing.cancel('');
    toast(t('common.save'), '');
    refreshBilling();
  } catch (err) { toast(err.message, 'error'); }
});

/* ---------------- Analytics & Reports (Phase 31) ---------------- */

let analyticsParams = {};

function axDateRange() {
  const from = $('analyticsFrom').value;
  const to = $('analyticsTo').value;
  const p = { ...analyticsParams };
  if (from) p.from = from;
  if (to) p.to = to;
  return p;
}

function axIsDisabled(res) { return res && res.status === 'disabled'; }

function renderTrendTable(el, items, cols) {
  if (!items || !items.length) { el.innerHTML = `<div class="state-box"><span class="s">${escapeHtml(t('analytics.noData'))}</span></div>`; return; }
  const rows = items.map(r => `<tr>${cols.map(c => `<td>${escapeHtml(String(r[c.key] ?? ''))}</td>`).join('')}</tr>`).join('');
  el.innerHTML = `<table class="tbl"><thead><tr>${cols.map(c => `<th>${escapeHtml(c.label)}</th>`).join('')}</tr></thead><tbody>${rows}</tbody></table>`;
}

function renderPerfBars(el, items, labelKey, valueKey) {
  if (!items || !items.length) { el.innerHTML = `<div class="state-box"><span class="s">${escapeHtml(t('analytics.noData'))}</span></div>`; return; }
  const max = Math.max(...items.map(r => Number(r[valueKey]) || 0), 1);
  el.innerHTML = items.map(r => {
    const v = Number(r[valueKey]) || 0;
    const pct = Math.round((v / max) * 100);
    return `<div class="bar-row"><div class="bar-label">${escapeHtml(String(r[labelKey] ?? ''))}</div><div class="bar-track"><div class="bar-fill" style="width:${pct}%"></div></div><div class="bar-val">${money(v)}</div></div>`;
  }).join('');
}

async function refreshAnalytics() {
  const params = axDateRange();
  try {
    const [dashRes, topRes, catRes, branchRes, salesTrendRes, profitTrendRes] = await Promise.all([
      window.analytics.dashboard(params),
      window.analytics.topProducts({ ...params, limit: 10 }),
      window.analytics.categoryPerformance(params),
      window.analytics.branchPerformance(params),
      window.analytics.salesTrend(params),
      window.analytics.profitTrend(params)
    ]);

    if (axIsDisabled(dashRes) || axIsDisabled(topRes)) {
      $('analyticsStats').innerHTML = `<div class="state-box"><span class="s">${escapeHtml(t('analytics.noData'))}</span></div>`;
      return;
    }

    // KPIs
    const kpis = dashRes || {};
    $('axRevenue').textContent = money(kpis.totalRevenue);
    $('axProfit').textContent = money(kpis.totalProfit);
    $('axOrders').textContent = Number(kpis.totalOrders || 0);
    $('axAvgOrder').textContent = kpis.totalOrders > 0 ? money(kpis.totalRevenue / kpis.totalOrders) : '—';

    // Sales trend
    renderTrendTable($('axSalesTrend'), salesTrendRes?.items || salesTrendRes, [
      { key: 'date', label: t('analytics.date') },
      { key: 'revenue', label: t('analytics.revenue') },
      { key: 'orders', label: t('analytics.orders') }
    ]);

    // Profit trend
    renderTrendTable($('axProfitTrend'), profitTrendRes?.items || profitTrendRes, [
      { key: 'date', label: t('analytics.date') },
      { key: 'profit', label: t('analytics.profit') },
      { key: 'revenue', label: t('analytics.revenue') }
    ]);

    // Top products
    renderTrendTable($('axTopProducts'), topRes?.items || topRes, [
      { key: 'productName', label: t('tbl.product') },
      { key: 'totalQty', label: t('analytics.totalQty') },
      { key: 'totalRevenue', label: t('analytics.totalRevenue') }
    ]);

    // Category performance
    renderPerfBars($('axCatPerf'), catRes?.items || catRes, 'categoryName', 'totalRevenue');

    // Branch performance
    renderPerfBars($('axBranchPerf'), branchRes?.items || branchRes, 'branchName', 'totalRevenue');
  } catch (err) {
    if (isSessionErr(err)) return handleSessionLoss();
    $('analyticsStats').innerHTML = `<div class="state-box"><span class="s">${escapeHtml(err.message)}</span></div>`;
  }
}

$('analyticsFilterBtn').addEventListener('click', () => refreshAnalytics());
$('analyticsRefreshBtn').addEventListener('click', () => refreshAnalytics());

$('axExportSales').addEventListener('click', async () => {
  try { await window.analytics.reportSales({ ...axDateRange(), pageSize: 10000 }); toast(t('analytics.exportSales'), ''); } catch (err) { toast(err.message, 'error'); }
});
$('axExportProfit').addEventListener('click', async () => {
  try { await window.analytics.reportProfit({ ...axDateRange(), pageSize: 10000 }); toast(t('analytics.exportProfit'), ''); } catch (err) { toast(err.message, 'error'); }
});
$('axExportInventory').addEventListener('click', async () => {
  try { await window.analytics.inventoryValuation(axDateRange()); toast(t('analytics.exportInventory'), ''); } catch (err) { toast(err.message, 'error'); }
});

/* ---------------- AI Intelligence (Phase 32) ---------------- */

async function refreshAi() {
  const panels = [
    ['aiForecastPanel', renderAiForecast],
    ['aiReorderPanel', renderAiReorder],
    ['aiAnomaliesPanel', renderAiAnomalies],
    ['aiProfitAlertPanel', renderAiProfitAlert],
    ['aiSlowMovingPanel', renderAiSlowMoving],
    ['aiCostTrendPanel', renderAiCostTrend],
  ];

  // Show loading state
  for (const [id] of panels) {
    $(id).innerHTML = `<div class="ai-loading"><span data-icon="refresh"></span> <span>${escapeHtml(t('state.loading'))}</span></div>`;
    window.icons.mount($(id));
  }

  try {
    const res = await window.ai.refresh();
    if (!res) {
      for (const [id] of panels) $(id).innerHTML = `<div class="state-box"><span class="s">${escapeHtml(t('ai.noInsights'))}</span></div>`;
      return;
    }

    // Update KPIs
    const forecast = res.forecast || {};
    const anomalies = res.anomalies || {};
    const reorder = res.reorder || {};
    const summary = res.summary || {};

    $('aiTotalProducts').textContent = String((forecast.forecasts || []).length);
    $('aiAnomalyCount').textContent = String(anomalies.total || 0);
    $('aiReorderCount').textContent = String(reorder.total || 0);

    const revChg = summary.changes?.revenueChangePct ?? 0;
    const revEl = $('aiRevenueChange');
    revEl.textContent = (revChg >= 0 ? '+' : '') + revChg.toFixed(1) + '%';
    revEl.style.color = revChg >= 0 ? 'var(--success)' : 'var(--danger)';

    // Render panels
    for (const [id, renderer] of panels) {
      const key = id.replace('ai', '').replace('Panel', '').toLowerCase();
      const dataMap = {
        forecast: forecast,
        reorder: reorder,
        anomalies: anomalies,
        profitalert: res.profitAlert || {},
        slowmoving: res.slowMoving || {},
        costtrend: res.costTrend || {},
      };
      const data = dataMap[key] || {};
      $(id).innerHTML = renderer(data);
      window.icons.mount($(id));
    }
  } catch (err) {
    if (isSessionErr(err)) return handleSessionLoss();
    for (const [id] of panels) {
      $(id).innerHTML = `<div class="state-box"><span class="s">${escapeHtml(err.message)}</span></div>`;
    }
  }
}

function renderAiForecast(data) {
  const items = data.forecasts || [];
  if (!items.length) return `<div class="state-box"><span class="s">${escapeHtml(t('ai.noInsights'))}</span></div>`;
  return `<div style="max-height:400px;overflow-y:auto">${items.slice(0, 15).map(r => `
    <div class="ai-item">
      <div class="ai-item-content">
        <div class="ai-item-title">${escapeHtml(r.productName)}</div>
        <div class="ai-item-message">${escapeHtml(t('ai.avgDaily'))}: ${r.avgDailyDemand} · ${escapeHtml(t('ai.forecast7d'))}: ${r.forecastNext7d}</div>
      </div>
      <span class="conf-badge conf-${r.confidence}">${escapeHtml(t('ai.' + r.confidence))}</span>
    </div>`).join('')}</div>`;
}

function renderAiReorder(data) {
  const items = data.recommendations || [];
  if (!items.length) return `<div class="all-good">${escapeHtml(t('ai.noInsights'))}</div>`;
  return `<div style="max-height:400px;overflow-y:auto">${items.slice(0, 15).map(r => `
    <div class="ai-item">
      <span class="ai-item-severity ${r.urgency === 'critical' ? 'critical' : r.urgency === 'high' ? 'warning' : 'info'}"></span>
      <div class="ai-item-content">
        <div class="ai-item-title">${escapeHtml(r.productName)} <span class="muted">(${escapeHtml(r.branchName)})</span></div>
        <div class="ai-item-message">${escapeHtml(t('ai.currentStock'))}: ${r.currentStock} · ${escapeHtml(t('ai.suggestedQty'))}: ${r.suggestedQty} · ${escapeHtml(t('ai.estimatedCost'))}: ${money(r.estimatedCost)}</div>
      </div>
    </div>`).join('')}</div>`;
}

function renderAiAnomalies(data) {
  const items = data.anomalies || [];
  if (!items.length) return `<div class="all-good">${escapeHtml(t('ai.noInsights'))}</div>`;
  return `<div style="max-height:400px;overflow-y:auto">${items.slice(0, 15).map(a => `
    <div class="ai-item">
      <span class="ai-item-severity ${a.severity}"></span>
      <div class="ai-item-content">
        <div class="ai-item-title">${escapeHtml(a.title)}</div>
        <div class="ai-item-message">${escapeHtml(a.message)}</div>
      </div>
      <span class="sev-badge sev-${a.severity}">${escapeHtml(t('ai.' + a.severity))}</span>
    </div>`).join('')}</div>`;
}

function renderAiProfitAlert(data) {
  const items = data.alerts || [];
  if (!items.length) return `<div class="all-good">${escapeHtml(t('ai.noInsights'))}</div>`;
  return `<div style="max-height:400px;overflow-y:auto">${items.map(a => `
    <div class="ai-item">
      <span class="ai-item-severity ${a.severity}"></span>
      <div class="ai-item-content">
        <div class="ai-item-title">${escapeHtml(a.productName)}</div>
        <div class="ai-item-message">${escapeHtml(t('ai.margin'))}: ${a.marginPct}% · ${escapeHtml(t('analytics.revenue'))}: ${money(a.revenue)}</div>
      </div>
      <span class="sev-badge sev-${a.severity}">${escapeHtml(t('ai.' + a.severity))}</span>
    </div>`).join('')}</div>`;
}

function renderAiSlowMoving(data) {
  const items = data.items || [];
  if (!items.length) return `<div class="all-good">${escapeHtml(t('ai.noInsights'))}</div>`;
  return `<div style="max-height:400px;overflow-y:auto">${items.slice(0, 15).map(r => `
    <div class="ai-item">
      <div class="ai-item-content">
        <div class="ai-item-title">${escapeHtml(r.productName)} <span class="muted">(${escapeHtml(r.branchName)})</span></div>
        <div class="ai-item-message">${escapeHtml(t('ai.currentStock'))}: ${r.currentStock} · ${escapeHtml(t('ai.loss'))}: ${money(r.inventoryValue)}</div>
      </div>
    </div>`).join('')}</div>`;
}

function renderAiCostTrend(data) {
  const items = data.trend || [];
  if (!items.length) return `<div class="state-box"><span class="s">${escapeHtml(t('ai.noInsights'))}</span></div>`;
  return `<div style="max-height:400px;overflow-y:auto">${items.slice(0, 15).map(r => `
    <div class="ai-item">
      <span class="ai-item-severity ${r.changePct > 0 ? 'warning' : r.changePct < 0 ? 'positive' : 'info'}"></span>
      <div class="ai-item-content">
        <div class="ai-item-title">${escapeHtml(r.productName)}</div>
        <div class="ai-item-message">${escapeHtml(t('analytics.amount'))}: ${r.changePct > 0 ? '+' : ''}${r.changePct}%</div>
      </div>
    </div>`).join('')}</div>`;
}

$('aiRefreshBtn').addEventListener('click', () => refreshAi());

$('logoutBtn').addEventListener('click', () => window.pos.auth.logout());

/* ---------- Phase 28: sync conflict management ---------- */
const CF_REASON = {
  STALE_VERSION: 'cf.stale',
  MISSING_BASE_VERSION: 'cf.missingBase',
  IMMUTABLE_FIELDS: 'cf.immutable'
};
const CF_RES = {
  applied_local: 'cf.res.applied_local',
  keep_server: 'cf.res.keep_server',
  rejected_permanent: 'cf.res.rejected_permanent'
};

function cfStatusPill(c) {
  if (c.status === 'resolved') {
    const label = t(CF_RES[c.resolution] || 'cf.resolved');
    return `<span class="status-badge st-active">${escapeHtml(label)}</span>`;
  }
  return `<span class="status-badge st-submitted">${escapeHtml(t('cf.open'))}</span>`;
}

function cfReason(c) {
  const key = CF_REASON[c.conflict_type];
  return key ? t(key) : escapeHtml(String(c.conflict_type || ''));
}

async function refreshConflicts() {
  if (!PERMS.has('settings.manage')) return;
  let list;
  try {
    list = await window.cloud.conflictsList();
  } catch (err) {
    if (isSessionErr(err)) return handleSessionLoss();
    toast(err.message, 'error');
    return;
  }
  const openCount = list.filter((c) => c.status === 'open').length;
  const badge = $('conflictsTabBadge');
  badge.textContent = String(openCount);
  badge.classList.toggle('hidden', openCount === 0);

  const tb = $('conflictsBody');
  $('conflictsEmpty').classList.toggle('hidden', list.length > 0);
  tb.innerHTML = list.map((c) => `
    <tr>
      <td><strong>${escapeHtml(c.entity_type)}</strong> #${escapeHtml(c.entity_id ?? '—')}</td>
      <td>${escapeHtml(c.conflict_type)}</td>
      <td class="muted">${fmtDate(c.created_at)}</td>
      <td>${cfStatusPill(c)}</td>
      <td>${cfReason(c)}</td>
      <td class="row-actions">
        <details class="cf-details">
          <summary aria-label="${escapeHtml(t('cf.details'))}">${escapeHtml(t('cf.details'))}</summary>
          <pre dir="ltr">${escapeHtml(JSON.stringify(safeParse(c.local_payload), null, 2))}</pre>
        </details>
        ${c.status === 'open' && c.conflict_type !== 'IMMUTABLE_FIELDS' ? `
          ${c.conflict_type !== 'MISSING_BASE_VERSION' ? `<button class="btn small" data-cf="retry" data-cid="${escapeHtml(c.conflict_id)}">${escapeHtml(t('cf.retry'))}</button>` : ''}
          <button class="btn small primary" data-cf="apply" data-cid="${escapeHtml(c.conflict_id)}">${escapeHtml(t('cf.applyLocal'))}</button>
          <button class="btn small ghost" data-cf="keep" data-cid="${escapeHtml(c.conflict_id)}">${escapeHtml(t('cf.keepServer'))}</button>
        ` : ''}
      </td>
    </tr>`).join('');
}

function safeParse(s) {
  try { return typeof s === 'string' ? JSON.parse(s) : s; } catch { return s ?? null; }
}

async function cfAct(kind, cid) {
  try {
    if (kind === 'retry') await window.cloud.conflictsRetry(cid);
    else {
      const ok = await confirmDialog(
        kind === 'apply' ? 'cf.confirmApply' : 'cf.confirmKeep', {},
        kind === 'apply' ? 'cf.applyLocal' : 'cf.keepServer'
      );
      if (!ok) return;
      await window.cloud.conflictResolve(cid, kind === 'apply' ? 'apply_local' : 'keep_server');
    }
    await window.cloud.conflictsRefresh();
    await refreshConflicts();
    toast(t('common.saved'));
  } catch (err) {
    if (isSessionErr(err)) return handleSessionLoss();
    toast(err.message, 'error');
  }
}

$('conflictsBody').addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-cf]');
  if (!btn) return;
  cfAct(btn.dataset.cf, btn.dataset.cid);
});

$('conflictsRefreshBtn').addEventListener('click', async () => {
  try {
    await window.cloud.conflictsRefresh();
    await refreshConflicts();
    toast(t('common.saved'));
  } catch (err) {
    if (isSessionErr(err)) return handleSessionLoss();
    toast(err.message, 'error');
  }
});

async function refreshUsers() {
  const tb = $('usersBody');
  tb.innerHTML = loadingState(5);
  let list;
  try {
    list = await window.pos.users.list();
  } catch (err) {
    if (isSessionErr(err)) return handleSessionLoss();
    tb.innerHTML = errorState(5, 'users');
    wireRetry(tb, refreshUsers);
    return;
  }
  if (!list.length) {
    tb.innerHTML = stateCell(5, `
      <div class="state-box">
        <div class="state-ic">${window.icon('users', { size: 28 })}</div>
        <div class="t">${escapeHtml(t('users.empty'))}</div>
      </div>`);
    window.icons.mount(tb);
    return;
  }
  tb.innerHTML = '';
  for (const u of list) {
    const tr = document.createElement('tr');
    const isSelf = ME && u.id === ME.id;
    const youTag = isSelf ? ` <span class="you-tag">${escapeHtml(t('users.you'))}</span>` : '';
    tr.innerHTML = `
      <td><div class="u-name">${escapeHtml(u.display_name || u.username)}${youTag}</div><div class="u-user" dir="ltr">${escapeHtml(u.username)}</div></td>
      <td><span class="role-badge role-${u.role}">${escapeHtml(t('users.role.' + u.role))}</span></td>
      <td><span class="status-badge st-${u.status}">${escapeHtml(t('users.status.' + u.status))}</span></td>
      <td class="muted">${u.last_login_at ? fmtDate(u.last_login_at) : '—'}</td>
      <td class="acts">
        <button type="button" class="btn small ghost icon-act" data-act="edit" aria-label="${escapeHtml(t('aria.edit'))}" title="${escapeHtml(t('aria.edit'))}">${window.icon('edit', { size: 14 })}</button>
        ${!isSelf ? `<button type="button" class="btn small ghost icon-act" data-act="delete" aria-label="${escapeHtml(t('aria.delete'))}" title="${escapeHtml(t('aria.delete'))}">${window.icon('delete', { size: 14 })}</button>` : ''}
      </td>`;
    tr.querySelector('[data-act="edit"]').addEventListener('click', () => openUserModal(u));
    const delBtn = tr.querySelector('[data-act="delete"]');
    if (delBtn) {
      delBtn.addEventListener('click', async () => {
        const ok = await confirmDialog('confirm.deleteUser', { name: u.display_name || u.username });
        if (!ok) return;
        try {
          await window.pos.users.remove(u.id);
          refreshUsers();
        } catch (err) {
          if (isSessionErr(err)) return handleSessionLoss();
          toast(err.message, 'error');
        }
      });
    }
    tb.appendChild(tr);
  }
  window.icons.mount(tb);
}

function openUserModal(userRow) {
  editingUserId = userRow ? userRow.id : null;
  $('userErrLine').hidden = true;
  const form = $('userForm');
  form.reset();

  const roleSel = form.elements.role;
  [...roleSel.options].forEach(o => {
    if (o.value === 'owner') o.disabled = !(ME && ME.role === 'owner');
  });

  if (userRow) {
    $('userModalTitle').textContent = t('users.modal.edit');
    form.elements.username.value = userRow.username;
    form.elements.username.disabled = true;
    form.elements.display_name.value = userRow.display_name || '';
    roleSel.value = userRow.role;
    form.elements.status.value = userRow.status;
    $('userStatusWrap').classList.remove('hidden');
    form.elements.password.removeAttribute('required');
    $('pwdLabel').textContent = t('users.field.password');
  } else {
    $('userModalTitle').textContent = t('users.modal.create');
    roleSel.value = 'cashier';
    form.elements.status.value = 'active';
    $('userStatusWrap').classList.add('hidden');
    form.elements.password.setAttribute('required', '');
    $('pwdLabel').textContent = t('users.field.password') + ' *';
  }

  const selfEdit = !!(userRow && ME && userRow.id === ME.id);
  $('curPwdWrap').classList.toggle('hidden', !selfEdit);
  f_setRequired(form.elements.current_password, selfEdit);

  renderUserBranchChecks(userRow);

  openModal('userModal');
  form.elements.username.focus();
}

let ubCurrent = [];

async function renderUserBranchChecks(userRow) {
  const wrap = $('userBranchesWrap');
  const grid = $('userBranchChecks');
  $('userBranchErr').hidden = true;
  ubCurrent = [];
  if (!PERMS.has('users.manage')) { wrap.classList.add('hidden'); return; }
  const spanning = userRow && (userRow.role === 'owner' || userRow.role === 'admin');
  if (spanning) {
    grid.innerHTML = '';
    wrap.classList.remove('hidden');
    return;
  }
  await loadBranchesCache();
  if (!ALL_BRANCHES.length) { wrap.classList.add('hidden'); return; }
  if (userRow) {
    try {
      ubCurrent = await window.pos.branches.userList(userRow.id);
    } catch (err) {
      if (isSessionErr(err)) { handleSessionLoss(); return; }
      wrap.classList.add('hidden');
      return;
    }
  } else {
    try { await loadBranchesCache(); } catch { /* ignore */ }
  }
  const selectable = activeBranches();
  if (!selectable.length) { wrap.classList.add('hidden'); return; }
  wrap.classList.remove('hidden');
  grid.innerHTML = selectable.map(b => {
    const cur = ubCurrent.find(x => Number(x.id) === Number(b.id));
    const checked = userRow ? !!cur : Number(b.id) === 1;
    const primary = checked && (userRow ? (cur && cur.is_primary) : Number(b.id) === 1);
    return `<label class="ub-line">
      <input type="checkbox" data-ub="${b.id}" ${checked ? 'checked' : ''} />
      <span class="ub-name">${escapeHtml(b.name)}</span>
      <label class="ub-primary" title="${escapeHtml(t('userBranches.primary'))}">
        <input type="radio" name="ubPrimary" value="${b.id}" ${primary ? 'checked' : ''} />
        <span>${escapeHtml(t('userBranches.primary'))}</span>
      </label>
    </label>`;
  }).join('');
  grid.querySelectorAll('input[data-ub]').forEach(cb => {
    cb.addEventListener('change', () => {
      const radio = grid.querySelector(`input[name="ubPrimary"][value="${cb.dataset.ub}"]`);
      if (radio) radio.disabled = !cb.checked;
      const anyChecked = [...grid.querySelectorAll('input[data-ub]:checked')].length > 0;
      const primaryRadio = grid.querySelector('input[name="ubPrimary"]:checked');
      if (!anyChecked && primaryRadio) primaryRadio.checked = false;
      if (anyChecked && !grid.querySelector('input[name="ubPrimary"]:checked')) {
        const first = grid.querySelector('input[data-ub]:checked');
        const r = grid.querySelector(`input[name="ubPrimary"][value="${first.dataset.ub}"]`);
        if (r) r.checked = true;
      }
    });
    const radio = grid.querySelector(`input[name="ubPrimary"][value="${cb.dataset.ub}"]`);
    if (radio) radio.disabled = !cb.checked;
  });
}

async function saveUserBranches(userId) {
  const grid = $('userBranchChecks');
  const wrap = $('userBranchesWrap');
  if (!wrap || wrap.classList.contains('hidden') || !grid || !grid.querySelector('input[data-ub]')) return true;
  const wanted = [...grid.querySelectorAll('input[data-ub]:checked')].map(cb => Number(cb.dataset.ub));
  if (!wanted.length) {
    $('userBranchErr').textContent = t('userBranches.none');
    $('userBranchErr').hidden = false;
    return false;
  }
  const primaryId = Number((grid.querySelector('input[name="ubPrimary"]:checked') || {}).value) ||
    (grid.querySelector('input[name="ubPrimary"]:not([disabled])') ? Number(grid.querySelector('input[name="ubPrimary"]:not([disabled])').value) : null);
  const had = new Set(ubCurrent.map(x => Number(x.id)));
  for (const bid of wanted) {
    if (!had.has(bid)) await window.pos.branches.assign(userId, bid, false);
  }
  for (const cur of ubCurrent) {
    if (!wanted.includes(Number(cur.id))) await window.pos.branches.unassign(userId, cur.id);
  }
  if (primaryId && wanted.includes(primaryId)) {
    await window.pos.branches.assign(userId, primaryId, true);
  }
  return true;
}

function f_setRequired(input, req) {
  if (req) input.setAttribute('required', '');
  else input.removeAttribute('required');
}

$('addUserBtn').addEventListener('click', () => openUserModal(null));
$('userCancelBtn').addEventListener('click', () => closeModal('userModal'));

$('userForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = e.target;
  const errEl = $('userErrLine');
  errEl.hidden = true;

  const password = f.elements.password.value;
  const currentPassword = f.elements.current_password.value;

  try {
    let savedUserId = editingUserId;
    if (editingUserId) {
      await window.pos.users.update(editingUserId, {
        display_name: f.elements.display_name.value,
        role: f.elements.role.value,
        status: f.elements.status.value
      });
      if (password || currentPassword) {
        await window.pos.users.setPassword(editingUserId, password, currentPassword || null);
      }
    } else {
      const created = await window.pos.users.create({
        username: f.elements.username.value.trim(),
        password,
        display_name: f.elements.display_name.value,
        role: f.elements.role.value
      });
      if (created && created.id) savedUserId = created.id;
    }
    const targetRole = f.elements.role.value;
    if (savedUserId && targetRole !== 'owner' && targetRole !== 'admin') {
      const okBranches = await saveUserBranches(savedUserId);
      if (!okBranches) return;
    }
    closeModal('userModal');
    refreshUsers();
  } catch (err) {
    if (isSessionErr(err)) return handleSessionLoss();
    errEl.textContent = err.message;
    errEl.hidden = false;
  }
});

/* ---------------- Branches (Phase 24) ---------------- */

let editingBranchId = null;

async function refreshBranches() {
  await loadBranchesCache();
  const tb = $('branchesBody');
  tb.innerHTML = loadingState(8);
  if (!ALL_BRANCHES.length) {
    tb.innerHTML = stateCell(8, `
      <div class="state-box">
        <div class="state-ic">${window.icon('inventory', { size: 28 })}</div>
        <div class="t">${escapeHtml(t('branch.empty'))}</div>
      </div>`);
    return;
  }
  tb.innerHTML = '';
  for (const b of ALL_BRANCHES) {
    const tr = document.createElement('tr');
    const isDefault = Number(b.id) === 1;
    const nameCell = `<b>${escapeHtml(b.name)}</b>${isDefault ? ` <span class="you-tag">${escapeHtml(t('branch.defaultTag'))}</span>` : ''}`;
    const s = b.stats || {};
    tr.innerHTML = `
      <td>${nameCell}<div class="u-user muted">${escapeHtml(b.address || '')}</div></td>
      <td dir="ltr">${escapeHtml(b.code)}</td>
      <td>${s.users_count ?? '—'}</td>
      <td>${s.products_count ?? '—'}</td>
      <td>${s.stock_qty ?? '—'}</td>
      <td>${money(s.stock_value)} <span class="cur">${escapeHtml(settings.currency)}</span></td>
      <td><span class="status-badge st-${b.status}">${escapeHtml(t('users.status.' + b.status))}</span></td>
      <td class="acts">
        <button type="button" class="btn small ghost icon-act" data-act="edit" aria-label="${escapeHtml(t('aria.edit'))}" title="${escapeHtml(t('aria.edit'))}">${window.icon('edit', { size: 14 })}</button>
        ${!isDefault ? `<button type="button" class="btn small ghost icon-act" data-act="toggle" aria-label="${escapeHtml(b.status === 'active' ? t('users.status.disabled') : t('users.status.active'))}" title="${escapeHtml(b.status === 'active' ? t('users.status.disabled') : t('users.status.active'))}">${window.icon(b.status === 'active' ? 'close' : 'check', { size: 14 })}</button>` : ''}
      </td>`;
    tr.querySelector('[data-act="edit"]').addEventListener('click', () => openBranchModal(b));
    const tog = tr.querySelector('[data-act="toggle"]');
    if (tog) {
      tog.addEventListener('click', async () => {
        if (b.status === 'active') {
          const ok = await confirmDialog('branch.confirmDisable', { name: b.name });
          if (!ok) return;
        }
        try {
          await window.pos.branches.setStatus(b.id, b.status === 'active' ? 'disabled' : 'active');
          refreshBranches();
        } catch (err) {
          if (isSessionErr(err)) return handleSessionLoss();
          toast(err.code === 'OPEN_RECONCILIATIONS' ? t('branch.err.hasRecons') : err.message, 'error');
        }
      });
    }
    tb.appendChild(tr);
  }
  window.icons.mount(tb);
}

function openBranchModal(row) {
  editingBranchId = row ? row.id : null;
  $('branchErrLine').hidden = true;
  const form = $('branchForm');
  form.reset();
  if (row) {
    $('branchModalTitle').textContent = t('branch.modal.edit');
    form.elements.name.value = row.name;
    form.elements.code.value = row.code;
    form.elements.phone.value = row.phone || '';
    form.elements.address.value = row.address || '';
    form.elements.status.value = row.status;
    $('branchStatusWrap').classList.remove('hidden');
    form.elements.code.disabled = false;
  } else {
    $('branchModalTitle').textContent = t('branch.modal.create');
    $('branchStatusWrap').classList.add('hidden');
  }
  openModal('branchModal');
  form.elements.name.focus();
}

$('addBranchBtn').addEventListener('click', () => openBranchModal(null));
$('branchCancelBtn').addEventListener('click', () => closeModal('branchModal'));

$('branchForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = e.target;
  const errEl = $('branchErrLine');
  errEl.hidden = true;
  const patch = {
    name: f.elements.name.value.trim(),
    code: f.elements.code.value.trim(),
    phone: f.elements.phone.value.trim(),
    address: f.elements.address.value.trim()
  };
  try {
    if (editingBranchId) {
      patch.status = f.elements.status.value;
      await window.pos.branches.update(editingBranchId, patch);
    } else {
      await window.pos.branches.create(patch);
    }
    closeModal('branchModal');
    refreshBranches();
  } catch (err) {
    if (isSessionErr(err)) return handleSessionLoss();
    errEl.textContent = err.message;
    errEl.hidden = false;
  }
});

/* ---------------- Transfers (Phase 24) ---------------- */

const TF_ST_CLS = {
  draft: 'st-draft',
  submitted: 'st-submitted',
  approved: 'st-approved',
  dispatched: 'st-partially_received',
  partially_received: 'st-partially_received',
  received: 'st-fully_received',
  cancelled: 'st-cancelled'
};
let tfDraftLines = [];

function tfBadge(s) {
  return `<span class="status-badge ${TF_ST_CLS[s] || ''}">${escapeHtml(t('tf.st.' + s))}</span>`;
}

async function refreshTransfers() {
  const tb = $('transfersBody');
  tb.innerHTML = loadingState(8);
  let list;
  try {
    list = await window.pos.transfers.list({
      status: $('tfStatusFilter') ? $('tfStatusFilter').value : '',
      branch_id: $('tfBranchFilter') ? $('tfBranchFilter').value : ''
    });
  } catch (err) {
    if (isSessionErr(err)) return handleSessionLoss();
    tb.innerHTML = errorState(8, 'transfers');
    wireRetry(tb, refreshTransfers);
    return;
  }
  if (!list.length) {
    tb.innerHTML = stateCell(8, `
      <div class="state-box">
        <div class="state-ic">${window.icon('truck', { size: 28 })}</div>
        <div class="t">${escapeHtml(t('tf.empty'))}</div>
      </div>`);
    return;
  }
  const canCancel = PERMS.has('transfers.cancel');
  tb.innerHTML = '';
  for (const tf of list) {
    const tr = document.createElement('tr');
    const cancellable = canCancel && ['draft', 'submitted'].includes(tf.status);
    tr.innerHTML = `
      <td><b dir="ltr">${escapeHtml(tf.ref)}</b></td>
      <td>${escapeHtml(tf.source_name)} <span class="muted">←</span> ${escapeHtml(tf.dest_name)}</td>
      <td>${tf.items.length}</td>
      <td><b>${Number(tf.total_qty)}</b></td>
      <td>${money(tf.total_value)} <span class="cur">${escapeHtml(settings.currency)}</span></td>
      <td>${tfBadge(tf.status)}</td>
      <td class="muted">${fmtDate(tf.created_at)}</td>
      <td class="acts">
        <button type="button" class="btn small ghost icon-act" data-act="details" data-id="${tf.id}" aria-label="${escapeHtml(t('tf.act.details'))}" title="${escapeHtml(t('tf.act.details'))}">${window.icon('view', { size: 14 })}</button>
        ${cancellable ? `<button type="button" class="btn small ghost icon-act" data-act="cancel" data-id="${tf.id}" data-ref="${escapeHtml(tf.ref)}" aria-label="${escapeHtml(t('tf.act.cancel'))}" title="${escapeHtml(t('tf.act.cancel'))}">${window.icon('close', { size: 14 })}</button>` : ''}
      </td>`;
    tr.querySelector('[data-act="details"]').addEventListener('click', () => openTransferDetails(Number(tf.id)));
    const cx = tr.querySelector('[data-act="cancel"]');
    if (cx) {
      cx.addEventListener('click', async () => {
        const ok = await confirmDialog('tf.confirmCancel', { ref: cx.dataset.ref });
        if (!ok) return;
        try { await window.pos.transfers.cancel(Number(cx.dataset.id), ''); refreshTransfers(); }
        catch (err) { if (isSessionErr(err)) return handleSessionLoss(); toast(err.message, 'error'); }
      });
    }
    tb.appendChild(tr);
  }
  window.icons.mount(tb);
}

if ($('tfStatusFilter')) {
  $('tfStatusFilter').addEventListener('change', refreshTransfers);
  $('tfBranchFilter').addEventListener('change', refreshTransfers);
}

async function openTransferModal() {
  $('tfErrLine').hidden = true;
  const form = $('transferForm');
  form.reset();
  tfDraftLines = [];
  const opts = activeBranches().map(b => `<option value="${b.id}">${escapeHtml(b.name)}</option>`).join('');
  $('tfSourceSelect').innerHTML = opts;
  $('tfDestSelect').innerHTML = opts;

  let products = [];
  try {
    products = await window.pos.products.list('');
  } catch (err) {
    if (isSessionErr(err)) return handleSessionLoss();
  }
  $('tfProductSelect').innerHTML = products
    .map(p => `<option value="${p.id}">${escapeHtml(p.name)}</option>`).join('');

  renderTfDraftLines();
  openModal('transferModal');
}

function renderTfDraftLines() {
  const tb = $('tfItemsBody');
  if (!tfDraftLines.length) {
    tb.innerHTML = stateCell(3, `<div class="state-box"><div class="s">${escapeHtml(t('purch.addItem'))}</div></div>`);
    return;
  }
  tb.innerHTML = '';
  for (const [idx, ln] of tfDraftLines.entries()) {
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td>${escapeHtml(ln.name)}</td>
      <td><input type="number" min="1" step="1" value="${ln.qty}" data-i="${idx}" /></td>
      <td class="acts"><button type="button" class="btn small ghost icon-act" data-rm="${idx}" aria-label="${escapeHtml(t('aria.delete'))}" title="${escapeHtml(t('aria.delete'))}">${window.icon('delete', { size: 14 })}</button></td>`;
    tr.querySelector(`[data-rm="${idx}"]`).addEventListener('click', () => {
      tfDraftLines.splice(idx, 1);
      renderTfDraftLines();
    });
    tr.querySelector('input[data-i]').addEventListener('change', (ev) => {
      const v = Number(ev.target.value);
      if (v >= 1) tfDraftLines[idx].qty = Math.trunc(v);
      renderTfDraftLines();
    });
    tb.appendChild(tr);
  }
  window.icons.mount(tb);
}

$('addTransferBtn').addEventListener('click', openTransferModal);
$('tfCancelBtn').addEventListener('click', () => closeModal('transferModal'));

$('tfAddItemBtn').addEventListener('click', () => {
  const sel = $('tfProductSelect');
  const pid = Number(sel.value);
  if (!pid) return;
  const qty = Math.trunc(Number($('tfItemQty').value));
  if (!(qty >= 1)) { toast(t('purch.qty'), 'error'); return; }
  const name = sel.options[sel.selectedIndex] ? sel.options[sel.selectedIndex].text : '';
  const existing = tfDraftLines.find(l => l.product_id === pid);
  if (existing) existing.qty += qty;
  else tfDraftLines.push({ product_id: pid, name, qty });
  renderTfDraftLines();
});

$('transferForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const errEl = $('tfErrLine');
  errEl.hidden = true;
  const srcId = Number($('tfSourceSelect').value);
  const dstId = Number($('tfDestSelect').value);
  if (!srcId || !dstId || srcId === dstId) {
    errEl.textContent = t('tf.sameBranchErr');
    errEl.hidden = false;
    return;
  }
  if (!tfDraftLines.length) {
    errEl.textContent = t('purch.empty');
    errEl.hidden = false;
    return;
  }
  try {
    const created = await window.pos.transfers.create({
      source_branch_id: srcId,
      dest_branch_id: dstId,
      notes: $('transferForm').elements.notes.value.trim(),
      items: tfDraftLines.map(l => ({ product_id: l.product_id, qty: l.qty }))
    });
    closeModal('transferModal');
    refreshTransfers();
    openTransferDetails(created.id);
  } catch (err) {
    if (isSessionErr(err)) return handleSessionLoss();
    errEl.textContent = err.message;
    errEl.hidden = false;
  }
});

$('tdCloseBtn').addEventListener('click', () => closeModal('transferDetailsModal'));

async function openTransferDetails(id) {
  const errEl = $('tdErrLine');
  errEl.hidden = true;
  let tf;
  try {
    tf = await window.pos.transfers.get(id);
  } catch (err) {
    if (isSessionErr(err)) return handleSessionLoss();
    toast(err.message, 'error');
    return;
  }
  $('tdRef').textContent = `${tf.ref} · ${t('tf.st.' + tf.status)}`;
  $('tdMeta').textContent = `${tf.source_name} ← ${tf.dest_name}` +
    (tf.dispatched_at ? ` · ${t('tf.sentCol')}: ${fmtDate(tf.dispatched_at)}` : '') +
    (tf.received_at ? ` · ${t('tf.recvCol')}: ${fmtDate(tf.received_at)}` : '');
  $('tdNotes').textContent = tf.notes || '';

  const canDispatch = PERMS.has('transfers.dispatch');
  const canReceive = PERMS.has('transfers.receive');
  const mode = (canDispatch && ['approved'].includes(tf.status)) ? 'dispatch'
    : (canReceive && ['dispatched', 'partially_received'].includes(tf.status)) ? 'receive' : '';

  const head = $('tfActionQtyHead');
  head.textContent = mode === 'dispatch' ? t('tf.outstandingDispatch')
    : mode === 'receive' ? t('tf.outstandingReceive') : '';

  $('tdItemsBody').innerHTML = tf.items.map(it => {
    const outstandingD = it.qty - it.dispatched_qty;
    const outstandingR = it.dispatched_qty - it.received_qty;
    let actCell = '<span class="muted">—</span>';
    if ((mode === 'dispatch' && outstandingD > 0) || (mode === 'receive' && outstandingR > 0)) {
      const max = mode === 'dispatch' ? outstandingD : outstandingR;
      actCell = `<input type="number" min="0" max="${max}" step="1" value="${max}" data-line="${it.id}" />`;
    }
    return `<tr>
      <td><b>${escapeHtml(it.product_name)}</b></td>
      <td>${it.qty}</td>
      <td>${it.dispatched_qty}</td>
      <td>${it.received_qty}</td>
      <td class="muted">${money(it.unit_cost)}</td>
      <td>${actCell}</td>
    </tr>`;
  }).join('');

  const actions = [];
  if (PERMS.has('transfers.submit') && tf.status === 'draft') {
    actions.push(`<button type="button" class="btn primary" id="tdSubmitBtn">${escapeHtml(t('tf.act.submit'))}</button>`);
  }
  if (PERMS.has('transfers.approve') && tf.status === 'submitted') {
    actions.push(`<button type="button" class="btn primary" id="tdApproveBtn">${escapeHtml(t('tf.act.approve'))}</button>`);
  }
  if (mode === 'dispatch') {
    actions.push(`<button type="button" class="btn primary" id="tdDispatchBtn">${escapeHtml(t('tf.dispatch'))}</button>`);
  }
  if (mode === 'receive') {
    actions.push(`<button type="button" class="btn primary" id="tdReceiveBtn">${escapeHtml(t('tf.receive'))}</button>`);
  }
  if (PERMS.has('transfers.cancel') && ['draft', 'submitted'].includes(tf.status)) {
    actions.push(`<button type="button" class="btn danger-solid" id="tdCancelBtn">${escapeHtml(t('tf.act.cancel'))}</button>`);
  }
  const bar = $('tdActions');
  bar.innerHTML = actions.join('');

  const run = (fn) => fn().catch(err => {
    if (isSessionErr(err)) return handleSessionLoss();
    errEl.textContent = err.message;
    errEl.hidden = false;
  });

  const collectLines = () => [...$('tdItemsBody').querySelectorAll('input[data-line]')]
    .map(inp => ({ item_id: Number(inp.dataset.line), qty: Math.trunc(Number(inp.value)) }))
    .filter(l => l.qty > 0);

  const submitBtn = $('tdSubmitBtn');
  if (submitBtn) submitBtn.addEventListener('click', () => run(async () => {
    await window.pos.transfers.submit(tf.id);
    refreshTransfers();
    openTransferDetails(tf.id);
  }));
  const approveBtn = $('tdApproveBtn');
  if (approveBtn) approveBtn.addEventListener('click', () => run(async () => {
    await window.pos.transfers.approve(tf.id);
    refreshTransfers();
    openTransferDetails(tf.id);
  }));
  const dispatchBtn = $('tdDispatchBtn');
  if (dispatchBtn) dispatchBtn.addEventListener('click', () => run(async () => {
    await window.pos.transfers.dispatch(tf.id, collectLines());
    refreshTransfers();
    openTransferDetails(tf.id);
  }));
  const receiveBtn = $('tdReceiveBtn');
  if (receiveBtn) receiveBtn.addEventListener('click', () => run(async () => {
    await window.pos.transfers.receive(tf.id, collectLines());
    refreshTransfers();
    openTransferDetails(tf.id);
  }));
  const cancelBtn = $('tdCancelBtn');
  if (cancelBtn) cancelBtn.addEventListener('click', () => run(async () => {
    const ok = await confirmDialog('tf.confirmCancel', { ref: tf.ref });
    if (!ok) return;
    await window.pos.transfers.cancel(tf.id, '');
    closeModal('transferDetailsModal');
    refreshTransfers();
  }));

  openModal('transferDetailsModal');
}

/* ---------------- Suppliers (Phase 21) ---------------- */

let editingSupplierId = null;
let suppliersCache = [];

async function refreshSuppliers() {
  const tb = $('suppliersBody');
  tb.innerHTML = loadingState(5);
  try {
    suppliersCache = await window.pos.suppliers.list();
  } catch (err) {
    if (isSessionErr(err)) return handleSessionLoss();
    tb.innerHTML = errorState(5, 'suppliers');
    wireRetry(tb, refreshSuppliers);
    return;
  }
  renderSuppliers();
}

function renderSuppliers() {
  const tb = $('suppliersBody');
  const q = $('supSearch').value.trim().toLowerCase();
  const list = q
    ? suppliersCache.filter(s =>
        [s.name, s.phone, s.email, s.address].some(v => String(v || '').toLowerCase().includes(q)))
    : suppliersCache;
  if (!list.length) {
    tb.innerHTML = stateCell(5, `
      <div class="state-box">
        <div class="state-ic">${window.icon('truck', { size: 28 })}</div>
        <div class="t">${escapeHtml(q ? t('state.noResults') : t('suppliers.empty'))}</div>
      </div>`);
    window.icons.mount(tb);
    return;
  }
  tb.innerHTML = '';
  for (const s of list) {
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td><div class="u-name">${escapeHtml(s.name)}</div>${s.notes ? `<div class="u-user">${escapeHtml(s.notes)}</div>` : ''}</td>
      <td class="muted" dir="ltr">${escapeHtml(s.phone || '—')}</td>
      <td class="muted" dir="ltr">${escapeHtml(s.email || '—')}</td>
      <td><span class="status-badge st-${s.status}">${escapeHtml(t('suppliers.status.' + s.status))}</span></td>
      <td class="acts">
        <button type="button" class="btn small ghost icon-act" data-act="edit" aria-label="${escapeHtml(t('aria.edit'))}" title="${escapeHtml(t('aria.edit'))}">${window.icon('edit', { size: 14 })}</button>
        <button type="button" class="btn small ghost icon-act" data-act="delete" aria-label="${escapeHtml(t('aria.delete'))}" title="${escapeHtml(t('aria.delete'))}">${window.icon('delete', { size: 14 })}</button>
      </td>`;
    tr.querySelector('[data-act="edit"]').addEventListener('click', () => openSupplierModal(s));
    tr.querySelector('[data-act="delete"]').addEventListener('click', async () => {
      const ok = await confirmDialog('confirm.deleteSupplier', { name: s.name });
      if (!ok) return;
      try {
        await window.pos.suppliers.remove(s.id);
        refreshSuppliers();
      } catch (err) {
        if (isSessionErr(err)) return handleSessionLoss();
        toast(err.message, 'error');
      }
    });
    tb.appendChild(tr);
  }
  window.icons.mount(tb);
}

$('supSearch').addEventListener('input', () => {
  if (suppliersCache.length) renderSuppliers();
});

function openSupplierModal(row) {
  editingSupplierId = row ? row.id : null;
  $('supErrLine').hidden = true;
  const form = $('supplierForm');
  form.reset();
  if (row) {
    $('supplierModalTitle').textContent = t('suppliers.modal.edit');
    form.elements.name.value = row.name;
    form.elements.phone.value = row.phone || '';
    form.elements.email.value = row.email || '';
    form.elements.address.value = row.address || '';
    form.elements.notes.value = row.notes || '';
    form.elements.status.value = row.status;
    $('supStatusWrap').classList.remove('hidden');
  } else {
    $('supplierModalTitle').textContent = t('suppliers.modal.create');
    form.elements.status.value = 'active';
    $('supStatusWrap').classList.add('hidden');
  }
  openModal('supplierModal');
  form.elements.name.focus();
}

$('addSupplierBtn').addEventListener('click', () => openSupplierModal(null));
$('supplierCancelBtn').addEventListener('click', () => closeModal('supplierModal'));

$('supplierForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = e.target;
  const errEl = $('supErrLine');
  errEl.hidden = true;

  const patch = {
    name: f.elements.name.value.trim(),
    phone: f.elements.phone.value.trim(),
    email: f.elements.email.value.trim(),
    address: f.elements.address.value.trim(),
    notes: f.elements.notes.value.trim()
  };

  try {
    if (editingSupplierId) {
      await window.pos.suppliers.update(editingSupplierId, patch);
    } else {
      await window.pos.suppliers.create(patch);
    }
    closeModal('supplierModal');
    refreshSuppliers();
  } catch (err) {
    if (isSessionErr(err)) return handleSessionLoss();
    errEl.textContent = err.message;
    errEl.hidden = false;
  }
});

/* ---------------- Purchases & GRN (Phase 22) ---------------- */

let editingPoId = null;
let poCache = [];
let poDraftLines = [];

function poStatusBadge(s) {
  return `<span class="status-badge st-${s}">${escapeHtml(t('po.st.' + s))}</span>`;
}

async function refreshPurchases() {
  const tb = $('posBody');
  tb.innerHTML = loadingState(9);
  try {
    poCache = await window.pos.purchases.list();
  } catch (err) {
    if (isSessionErr(err)) return handleSessionLoss();
    tb.innerHTML = errorState(9, 'purchases');
    wireRetry(tb, refreshPurchases);
    return;
  }
  renderPos();
  refreshGrns();
}

async function refreshGrns() {
  const tb = $('grnsBody');
  try {
    const list = await window.pos.grns.list();
    if (!list.length) {
      tb.innerHTML = stateCell(7, `
        <div class="state-box"><div class="t">${escapeHtml(t('grns.empty'))}</div></div>`);
      return;
    }
    tb.innerHTML = list.map(g => `
      <tr>
        <td><b dir="ltr">${escapeHtml(g.ref)}</b></td>
        <td dir="ltr">${escapeHtml(g.po_ref || '—')}</td>
        <td class="muted">${escapeHtml(g.branch_name || '—')}</td>
        <td>${escapeHtml(g.supplier_name || '—')}</td>
        <td>${g.total_received}</td>
        <td class="${g.total_damaged ? '' : 'muted'}">${g.total_damaged}</td>
        <td class="muted">${fmtDate(g.received_at)}</td>
      </tr>`).join('');
  } catch (err) {
    if (isSessionErr(err)) return handleSessionLoss();
    tb.innerHTML = stateCell(7, `<div class="state-box"><div class="t">${escapeHtml(err.message)}</div></div>`);
  }
}

function renderPos() {
  const tb = $('posBody');
  const q = $('poSearch').value.trim().toLowerCase();
  const st = $('poStatusFilter').value;
  const br = $('poBranchFilter') ? $('poBranchFilter').value : '';
  let list = poCache;
  if (st) list = list.filter(p => p.status === st);
  if (br) list = list.filter(p => String(p.branch_id) === br);
  if (q) {
    list = list.filter(p =>
      String(p.ref || '').toLowerCase().includes(q) ||
      String(p.supplier_name || '').toLowerCase().includes(q));
  }
  if (!list.length) {
    tb.innerHTML = stateCell(9, `
      <div class="state-box">
        <div class="state-ic">${window.icon('truck', { size: 28 })}</div>
        <div class="t">${escapeHtml(poCache.length ? t('state.noResults') : t('purch.empty'))}</div>
      </div>`);
    window.icons.mount(tb);
    return;
  }

  const canUpdate = PERMS.has('purchases.update');
  const canApprove = PERMS.has('purchases.approve');
  const canReceive = PERMS.has('purchases.receive');
  const canCancel = PERMS.has('purchases.cancel');

  tb.innerHTML = '';
  for (const p of list) {
    const tr = document.createElement('tr');
    const receivable = p.status === 'approved' || p.status === 'partially_received';
    const acts = [];
    acts.push(`<button type="button" class="btn small ghost icon-act" data-act="details" aria-label="${escapeHtml(t('aria.view'))}" title="${escapeHtml(t('aria.view'))}">${window.icon('view', { size: 14 })}</button>`);
    if (canUpdate && p.status === 'draft') {
      acts.push(`<button type="button" class="btn small ghost icon-act" data-act="edit" aria-label="${escapeHtml(t('aria.edit'))}" title="${escapeHtml(t('aria.edit'))}">${window.icon('edit', { size: 14 })}</button>`);
      acts.push(`<button type="button" class="btn small ghost icon-act" data-act="submit" aria-label="${escapeHtml(t('purch.act.submit'))}" title="${escapeHtml(t('purch.act.submit'))}">${window.icon('sales', { size: 14 })}</button>`);
    }
    if (canApprove && p.status === 'submitted') {
      acts.push(`<button type="button" class="btn small ghost icon-act" data-act="approve" aria-label="${escapeHtml(t('purch.act.approve'))}" title="${escapeHtml(t('purch.act.approve'))}">${window.icon('check', { size: 14 })}</button>`);
    }
    if (canReceive && receivable) {
      acts.push(`<button type="button" class="btn small ghost icon-act" data-act="receive" aria-label="${escapeHtml(t('purch.act.receive'))}" title="${escapeHtml(t('purch.act.receive'))}">${window.icon('truck', { size: 14 })}</button>`);
    }
    if (canCancel && p.status !== 'fully_received' && p.status !== 'cancelled') {
      acts.push(`<button type="button" class="btn small ghost icon-act" data-act="cancel" aria-label="${escapeHtml(t('purch.act.cancelPo'))}" title="${escapeHtml(t('purch.act.cancelPo'))}">${window.icon('close', { size: 14 })}</button>`);
    }

    tr.innerHTML = `
      <td><b dir="ltr">${escapeHtml(p.ref)}</b></td>
      <td class="muted">${escapeHtml(p.branch_name || '—')}</td>
      <td>${escapeHtml(p.supplier_name || '—')}</td>
      <td>${p.line_count}</td>
      <td>${money(p.total_cost)} <span class="cur">${escapeHtml(settings.currency)}</span></td>
      <td class="muted">${p.received_qty}/${p.ordered_qty}</td>
      <td>${poStatusBadge(p.status)}</td>
      <td class="muted">${p.expected_at ? escapeHtml(p.expected_at) : '—'}</td>
      <td class="acts">${acts.join('')}</td>`;

    tr.querySelector('[data-act="details"]').addEventListener('click', () => openPoDetails(p.id));
    const on = (sel, fn) => {
      const b = tr.querySelector(sel);
      if (b) b.addEventListener('click', fn);
    };
    on('[data-act="edit"]', () => openPoModal(p));
    on('[data-act="submit"]', async () => {
      try { await window.pos.purchases.submit(p.id); refreshPurchases(); }
      catch (err) { if (isSessionErr(err)) return handleSessionLoss(); toast(err.message, 'error'); }
    });
    on('[data-act="approve"]', async () => {
      try { await window.pos.purchases.approve(p.id); refreshPurchases(); }
      catch (err) { if (isSessionErr(err)) return handleSessionLoss(); toast(err.message, 'error'); }
    });
    on('[data-act="receive"]', async () => {
      try {
        receivePo = await window.pos.purchases.get(p.id);
        openReceiveModal();
      } catch (err) { if (isSessionErr(err)) return handleSessionLoss(); toast(err.message, 'error'); }
    });
    on('[data-act="cancel"]', async () => {
      const ok = await confirmDialog('confirm.cancelPo', { ref: p.ref });
      if (!ok) return;
      try { await window.pos.purchases.cancel(p.id, ''); refreshPurchases(); }
      catch (err) { if (isSessionErr(err)) return handleSessionLoss(); toast(err.message, 'error'); }
    });
    tb.appendChild(tr);
  }
  window.icons.mount(tb);
}

$('poSearch').addEventListener('input', () => { if (poCache.length) renderPos(); });
$('poStatusFilter').addEventListener('change', () => { if (poCache.length) renderPos(); });
if ($('poBranchFilter')) {
  $('poBranchFilter').addEventListener('change', () => { if (poCache.length) renderPos(); });
}

async function openPoDetails(id) {
  let po;
  try {
    po = await window.pos.purchases.get(id);
  } catch (err) {
    if (isSessionErr(err)) return handleSessionLoss();
    toast(err.message, 'error');
    return;
  }
  $('poDetailsRef').textContent = `${po.ref} · ${t('po.st.' + po.status)}`;
  $('poDetailsMeta').textContent =
    `${po.supplier_name || '—'} · ${t('purch.receivedOf')}: ${po.received_qty}/${po.ordered_qty}` +
    (po.notes ? ` · ${po.notes}` : '');
  $('poDetailsBody').innerHTML = po.items.map(it => `
    <tr>
      <td>${escapeHtml(it.product_name)}</td>
      <td>${it.qty}</td>
      <td>${it.received_qty}</td>
      <td class="${it.qty - it.received_qty > 0 ? '' : 'muted'}">${it.qty - it.received_qty}</td>
      <td class="muted">${money(it.unit_cost)}</td>
      <td><b>${money(it.qty * it.unit_cost)}</b></td>
    </tr>`).join('');
  openModal('poDetailsModal');
}
$('poDetailsCloseBtn').addEventListener('click', () => closeModal('poDetailsModal'));

function renderPoDraftLines() {
  const tb = $('poItemsBody');
  if (!poDraftLines.length) {
    tb.innerHTML = stateCell(4, `<div class="state-box"><div class="s">${escapeHtml(t('purch.addItem'))}</div></div>`);
    return;
  }
  tb.innerHTML = '';
  for (const [idx, ln] of poDraftLines.entries()) {
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td>${escapeHtml(ln.name)}</td>
      <td><input type="number" min="1" step="1" value="${ln.qty}" data-f="qty" data-i="${idx}" /></td>
      <td><input type="number" min="0" step="0.01" value="${ln.unit_cost}" data-f="cost" data-i="${idx}" dir="ltr" /></td>
      <td class="acts"><button type="button" class="btn small ghost icon-act" data-rm="${idx}" aria-label="${escapeHtml(t('aria.delete'))}" title="${escapeHtml(t('aria.delete'))}">${window.icon('delete', { size: 14 })}</button></td>`;
    tr.querySelector(`[data-rm="${idx}"]`).addEventListener('click', () => {
      poDraftLines.splice(idx, 1);
      renderPoDraftLines();
    });
    tb.appendChild(tr);
  }
  window.icons.mount(tb);
  tb.querySelectorAll('input[data-f]').forEach(inp => {
    inp.addEventListener('change', () => {
      const i = Number(inp.dataset.i);
      const v = Number(inp.value);
      if (inp.dataset.f === 'qty' && v >= 1) poDraftLines[i].qty = Math.trunc(v);
      if (inp.dataset.f === 'cost' && v >= 0) poDraftLines[i].unit_cost = Math.round(v * 100) / 100;
      renderPoDraftLines();
    });
  });
}

async function openPoModal(poRow) {
  $('poErrLine').hidden = true;
  const form = $('poForm');
  form.reset();
  poDraftLines = [];
  editingPoId = poRow ? poRow.id : null;

  let suppliers = [];
  try {
    suppliers = (await window.pos.suppliers.list()).filter(s => s.status === 'active');
  } catch (err) {
    if (isSessionErr(err)) return handleSessionLoss();
  }
  const supSel = $('poSupplierSelect');
  supSel.innerHTML = suppliers
    .map(s => `<option value="${s.id}">${escapeHtml(s.name)}</option>`).join('');

  const brSel = $('poBranchSelect');
  if (brSel) {
    brSel.innerHTML = activeBranches()
      .map(b => `<option value="${b.id}">${escapeHtml(b.name)}</option>`).join('');
    const ctxId = ME.branch && ME.branch.id ? ME.branch.id : 1;
    brSel.value = String([...brSel.options].some(o => o.value === String(ctxId)) ? ctxId : (activeBranches()[0] ? activeBranches()[0].id : ''));
    brSel.disabled = !!poRow;
  }

  let products = [];
  try {
    products = await window.pos.products.list('');
  } catch (err) {
    if (isSessionErr(err)) return handleSessionLoss();
  }
  const prodSel = $('poProductSelect');
  prodSel.innerHTML = products
    .map(p => `<option value="${p.id}" data-cost="${p.cost}">${escapeHtml(p.name)}</option>`).join('');

  if (poRow) {
    $('poModalTitle').textContent = t('purch.modal.edit');
    let full;
    try {
      full = await window.pos.purchases.get(poRow.id);
    } catch (err) {
      if (isSessionErr(err)) return handleSessionLoss();
      toast(err.message, 'error');
      return;
    }
    form.elements.supplier_id.value = String(full.supplier_id);
    form.elements.expected_at.value = full.expected_at || '';
    form.elements.notes.value = full.notes || '';
    poDraftLines = full.items.map(it => ({
      product_id: it.product_id,
      name: it.product_name,
      qty: it.qty,
      unit_cost: it.unit_cost
    }));
  } else {
    $('poModalTitle').textContent = t('purch.modal.create');
  }

  renderPoDraftLines();
  openModal('poModal');
}

$('addPoBtn').addEventListener('click', () => openPoModal(null));
$('poCancelBtn').addEventListener('click', () => closeModal('poModal'));

$('poAddItemBtn').addEventListener('click', () => {
  const sel = $('poProductSelect');
  const pid = Number(sel.value);
  if (!pid) return;
  const qty = Math.trunc(Number($('poItemQty').value));
  const cost = Math.round(Number($('poItemCost').value) * 100) / 100;
  if (!(qty >= 1)) { toast(t('purch.qty'), 'error'); return; }
  if (!(cost >= 0)) { toast(t('purch.unitCost'), 'error'); return; }
  const name = sel.options[sel.selectedIndex] ? sel.options[sel.selectedIndex].text : '';
  const existing = poDraftLines.find(l => l.product_id === pid);
  if (existing) {
    existing.qty += qty;
    existing.unit_cost = cost;
  } else {
    poDraftLines.push({ product_id: pid, name, qty, unit_cost: cost });
  }
  renderPoDraftLines();
});

$('poForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = e.target;
  const errEl = $('poErrLine');
  errEl.hidden = true;

  if (!$('poSupplierSelect').value) {
    errEl.textContent = t('purch.supplier');
    errEl.hidden = false;
    return;
  }
  if (!poDraftLines.length) {
    errEl.textContent = t('purch.empty');
    errEl.hidden = false;
    return;
  }

  const payload = {
    supplier_id: Number(f.elements.supplier_id.value),
    expected_at: f.elements.expected_at.value || null,
    notes: f.elements.notes.value.trim(),
    items: poDraftLines.map(l => ({ product_id: l.product_id, qty: l.qty, unit_cost: l.unit_cost }))
  };
  if (!editingPoId && $('poBranchSelect') && $('poBranchSelect').value) {
    payload.branch_id = Number($('poBranchSelect').value);
  }

  try {
    if (editingPoId) {
      await window.pos.purchases.update(editingPoId, payload);
    } else {
      await window.pos.purchases.create(payload);
    }
    closeModal('poModal');
    refreshPurchases();
  } catch (err) {
    if (isSessionErr(err)) return handleSessionLoss();
    errEl.textContent = err.message;
    errEl.hidden = false;
  }
});

/* --- GRN receiving --- */

function openReceiveModal() {
  const po = receivePo;
  if (!po) return;
  $('receiveRef').textContent = po.ref;
  $('receiveMeta').textContent = `${po.supplier_name || '—'} · ${t('purch.receivedOf')}: ${po.received_qty}/${po.ordered_qty}`;
  const tb = $('receiveItemsBody');
  const lines = po.items.filter(it => it.qty - it.received_qty > 0);
  tb.innerHTML = lines.map(it => {
    const rem = it.qty - it.received_qty;
    return `
      <tr data-poi="${it.id}">
        <td>${escapeHtml(it.product_name)}</td>
        <td>${rem}</td>
        <td><input type="number" min="0" max="${rem}" step="1" value="${rem}" data-f="received" /></td>
        <td><input type="number" min="0" step="1" value="0" data-f="damaged" /></td>
        <td><input type="number" min="0" step="0.01" value="${it.unit_cost}" data-f="cost" dir="ltr" /></td>
      </tr>`;
  }).join('');
  $('receiveForm').elements.notes.value = '';
  $('receiveErrLine').hidden = true;
  openModal('receiveModal');
}
$('receiveCancelBtn').addEventListener('click', () => closeModal('receiveModal'));

$('receiveForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const errEl = $('receiveErrLine');
  errEl.hidden = true;
  const items = [];
  for (const tr of $('receiveItemsBody').querySelectorAll('tr[data-poi]')) {
    const received = Math.trunc(Number(tr.querySelector('[data-f="received"]').value));
    const damaged = Math.trunc(Number(tr.querySelector('[data-f="damaged"]').value));
    const cost = Number(tr.querySelector('[data-f="cost"]').value);
    if (!(received >= 0) || !(damaged >= 0) || !(cost >= 0)) continue;
    if (received > 0) {
      items.push({
        po_item_id: Number(tr.dataset.poi),
        qty_received: received,
        qty_damaged: damaged,
        unit_cost: cost
      });
    }
  }
  if (!items.length) {
    errEl.textContent = t('grns.hint');
    errEl.hidden = false;
    return;
  }
  try {
    await window.pos.purchases.receive({
      po_id: receivePo.id,
      items,
      notes: $('receiveForm').elements.notes.value.trim()
    });
    closeModal('receiveModal');
    receivePo = null;
    refreshPurchases();
  } catch (err) {
    if (isSessionErr(err)) return handleSessionLoss();
    errEl.textContent = err.message;
    errEl.hidden = false;
  }
});

/* Init */
(async function init() {
  try {
    const me0 = await window.pos.auth.me();
    if (!me0 || !me0.user) return handleSessionLoss();
    ME = me0.user;
    PERMS = new Set(me0.permissions);
  } catch {
    return handleSessionLoss();
  }

  // Check license/trial status
  try {
    const licSt = await window.pos.license.status();
    if (licSt.type === 'none' || (licSt.type === 'trial' && licSt.status === 'expired') || (licSt.type === 'license' && licSt.status === 'expired') || licSt.status === 'tampered' || licSt.status === 'suspended' || licSt.status === 'revoked') {
      // Redirect to login for license activation
      window.pos.auth.logout();
      return;
    }
    if (licSt.type === 'trial' && licSt.trial) {
      showTrialBanner(licSt.trial);
    }
  } catch { /* no license module */ }

  await loadSettingsForm();
  applyPrefs();
  applySessionUI();
  window.icons.mount(document);
  try {
    const logo = await window.pos.appInfo.getLogo();
    if (logo) {
      $('brandLogo').src = logo;
      $('brandLogo').classList.remove('hidden');
      $('logoEmoji').classList.add('hidden');
    }
  } catch { /* keep icon fallback */ }
  await loadCategories();
  refreshAll();
})();

function showTrialBanner(trial) {
  let banner = document.getElementById('trialBanner');
  if (!banner) {
    banner = document.createElement('div');
    banner.id = 'trialBanner';
    banner.style.cssText = 'position:fixed;top:0;left:0;right:0;z-index:9999;background:#fef3c7;border-bottom:2px solid #f59e0b;padding:8px 16px;text-align:center;font-size:14px;font-weight:600;color:#92400e;';
    document.body.prepend(banner);
  }
  const update = () => {
    const endsAt = new Date(trial.endsAt);
    const remaining = endsAt.getTime() - Date.now();
    if (remaining <= 0) {
      banner.textContent = 'التجربة منتهية — أدخل كود الترخيص';
      banner.style.borderColor = '#ef4444';
      banner.style.color = '#dc2626';
      return;
    }
    const h = Math.floor(remaining / (1000 * 60 * 60));
    const m = Math.floor((remaining % (1000 * 60 * 60)) / (1000 * 60));
    const s = Math.floor((remaining % (1000 * 60)) / 1000);
    banner.textContent = `التجربة المجانية: ${h}h ${m}m ${s}s متبقية — تواصل مع المبيعات للحصول على ترخيص`;
    setTimeout(update, 1000);
  };
  update();
}
