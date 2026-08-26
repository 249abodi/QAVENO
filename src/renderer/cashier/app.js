'use strict';

const $ = (id) => document.getElementById(id);
const t = (key, params) => window.i18n.t(key, params);

let products = [];
let cart = new Map(); // product_id -> { id, name, price, quantity }
let settings = { store_name: 'متجري', tax_rate: '15', currency: 'ر.س', lang: 'ar', theme: 'light' };
let paymentMethod = 'cash';

const round2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;
const money = (n) => Number(n || 0).toFixed(2);

function toast(msg, type = '') {
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.textContent = msg;
  $('toasts').appendChild(el);
  setTimeout(() => el.remove(), 3200);
}

/* ---------------- Preferences (lang + theme) ---------------- */

function applyPrefs() {
  window.i18n.setLang(settings.lang || 'ar');
  document.documentElement.dataset.theme = settings.theme === 'dark' ? 'dark' : 'light';
  $('langToggle').textContent = (settings.lang === 'en') ? 'عربي' : 'EN';
  $('themeToggle').innerHTML = window.icon(settings.theme === 'dark' ? 'sun' : 'moon', { size: 16 });
  $('themeToggle').setAttribute('aria-label', t('ui.toggleTheme'));
  $('langToggle').setAttribute('aria-label', t('ui.toggleLang'));
  $('searchInput').setAttribute('aria-label', t('cashier.searchPh'));
}

$('langToggle').addEventListener('click', async () => {
  const next = settings.lang === 'en' ? 'ar' : 'en';
  settings.lang = next;          // optimistic
  applyPrefs();
  renderGrid();
  renderCart();
  updateTaxBadge();
  try { await window.pos.settings.set('lang', next); } catch (e) { toast(e.message, 'error'); }
});

$('themeToggle').addEventListener('click', async () => {
  const next = settings.theme === 'dark' ? 'light' : 'dark';
  settings.theme = next;
  applyPrefs();
  try { await window.pos.settings.set('theme', next); } catch (e) { toast(e.message, 'error'); }
});

/* ---------------- Products grid ---------------- */

function stockClass(p) {
  if (p.quantity <= 0) return 'stock-out';
  if (p.quantity <= p.low_stock_threshold) return 'stock-low';
  return 'stock-ok';
}
function stockLabel(p) {
  if (p.quantity <= 0) return t('stock.out');
  if (p.quantity <= p.low_stock_threshold) return t('stock.low', { qty: p.quantity });
  return t('stock.in', { qty: p.quantity });
}

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));
}

function renderGrid() {
  const q = $('searchInput').value.trim().toLowerCase();
  const list = q
    ? products.filter(p =>
        p.name.toLowerCase().includes(q) ||
        String(p.barcode || '').toLowerCase().includes(q) ||
        String(p.category || '').toLowerCase().includes(q))
    : products;

  $('productsCount').textContent = `(${list.length})`;
  const grid = $('productGrid');

  if (products.length === 0) {
    grid.innerHTML = `
      <div class="grid-state">
        <div class="state-ic">${window.icon('products', { size: 28 })}</div>
        <div class="t">${escapeHtml(t('prod.empty.title'))}</div>
        <div>${escapeHtml(t('prod.empty.sub'))}</div>
      </div>`;
    window.icons.mount(grid);
    return;
  }

  if (list.length === 0) {
    grid.innerHTML = `
      <div class="grid-state">
        <div class="state-ic">${window.icon('search', { size: 28 })}</div>
        <div class="t">${escapeHtml(t('prod.noResults.title'))}</div>
        <button type="button" class="btn small" id="clearGridSearchBtn">${escapeHtml(t('prod.clearSearch'))}</button>
      </div>`;
    window.icons.mount(grid);
    $('clearGridSearchBtn').addEventListener('click', () => {
      $('searchInput').value = '';
      renderGrid();
      $('searchInput').focus();
    });
    return;
  }

  grid.innerHTML = '';

  for (const p of list) {
    const card = document.createElement('div');
    card.className = 'card' + (p.quantity <= 0 ? ' out' : '');
    card.dataset.id = p.id;
    card.innerHTML = `
      <div class="name">${escapeHtml(p.name)}</div>
      ${p.category_name ? `<div class="cat">${p.category_color ? '<span class="cat-dot"></span>' : ''}${escapeHtml(p.category_name)}</div>` : ''}
      <div class="meta">
        <span class="price">${money(p.price)} <span class="cur">${settings.currency}</span></span>
        <span class="stock-badge ${stockClass(p)}">${escapeHtml(stockLabel(p))}</span>
      </div>`;
    const dot = card.querySelector('.cat-dot');
    if (dot && p.category_color) dot.style.background = p.category_color;
    if (p.quantity > 0) {
      card.addEventListener('click', () => addToCart(p));
    }
    grid.appendChild(card);
  }
}

/* ---------------- Cart ---------------- */

function addToCart(p, qty = 1) {
  const existing = cart.get(p.id);
  const currentQty = existing ? existing.quantity : 0;
  if (currentQty + qty > p.quantity) {
    toast(t('err.stockShort', { name: p.name, qty: p.quantity }), 'error');
    return;
  }
  if (existing) {
    existing.quantity += qty;
  } else {
    cart.set(p.id, { id: p.id, name: p.name, price: p.price, quantity: qty });
  }
  renderCart();
}

function setCartQty(id, qty) {
  const item = cart.get(id);
  if (!item) return;
  const p = products.find(x => x.id === id);
  const maxStock = p ? p.quantity : item.quantity;
  if (qty <= 0) {
    cart.delete(id);
  } else if (qty > maxStock) {
    item.quantity = maxStock;
    toast(t('err.maxStock', { qty: maxStock }), 'error');
  } else {
    item.quantity = qty;
  }
  renderCart();
}

function cartTotals() {
  let subtotal = 0;
  for (const it of cart.values()) subtotal += it.price * it.quantity;
  subtotal = round2(subtotal);
  const rate = Number(settings.tax_rate) / 100;
  const tax = round2(subtotal * rate);
  const discount = Math.max(0, round2($('discountInput').value || 0));
  const total = round2(Math.max(0, subtotal + tax - discount));
  return { subtotal, tax, discount, total };
}

function renderCart() {
  const wrap = $('cartItems');
  const items = [...cart.values()];

  $('cartCount').textContent = items.reduce((s, i) => s + i.quantity, 0);
  $('checkoutBtn').disabled = items.length === 0;

  if (items.length === 0) {
    wrap.innerHTML = `
      <div class="empty-cart">
        <span class="state-ic">${window.icon('cart', { size: 26 })}</span>
        <span>${escapeHtml(t('cart.empty'))}</span>
      </div>`;
  } else {
    wrap.innerHTML = '';
    for (const it of items) {
      const row = document.createElement('div');
      row.className = 'cart-row';
      row.innerHTML = `
        <div class="name">${escapeHtml(it.name)}</div>
        <button class="remove-btn" aria-label="${escapeHtml(t('aria.delete'))}" title="${escapeHtml(t('aria.delete'))}">${window.icon('delete', { size: 15 })}</button>
        <div class="qty-stepper">
          <button class="qty-btn minus" aria-label="−">${window.icon('minus', { size: 13 })}</button>
          <span class="qty-num">${it.quantity}</span>
          <button class="qty-btn plus" aria-label="+">${window.icon('plus', { size: 13 })}</button>
        </div>
        <div class="line-wrap">
          <div class="unit">${money(it.price)} × ${it.quantity}</div>
          <div class="line-total">${money(round2(it.price * it.quantity))} <span class="cur">${settings.currency}</span></div>
        </div>`;
      row.querySelector('.plus').addEventListener('click', () => setCartQty(it.id, it.quantity + 1));
      row.querySelector('.minus').addEventListener('click', () => setCartQty(it.id, it.quantity - 1));
      row.querySelector('.remove-btn').addEventListener('click', () => { cart.delete(it.id); renderCart(); });
      wrap.appendChild(row);
    }
  }
  window.icons.mount(wrap);

  updateTotals();
}

function updateTaxBadge() {
  $('taxBadge').textContent = t('taxBadge.fmt', { rate: settings.tax_rate });
  $('taxRateLabel').textContent = settings.tax_rate;
}

function updateTotals() {
  const tot = cartTotals();
  $('subtotalEl').textContent = money(tot.subtotal);
  $('taxEl').textContent = money(tot.tax);
  $('totalEl').textContent = money(tot.total);

  const paid = Number($('paidInput').value || 0);
  const change = paid > 0 ? round2(paid - tot.total) : 0;
  $('changeEl').textContent = money(change);
  $('changeEl').style.color = change < 0 ? 'var(--danger)' : 'var(--success)';
}

/* ---------------- Checkout ---------------- */

let currentPdfPath = null;

async function doCheckout() {
  const items = [...cart.values()];
  if (items.length === 0) return;
  const tot = cartTotals();

  let paid = Number($('paidInput').value || 0);
  if (!paid) paid = tot.total; // default: pay exact amount

  try {
    const sale = await window.pos.checkout({
      items: items.map(i => ({ product_id: i.id, quantity: i.quantity })),
      discount: tot.discount,
      paid,
      payment_method: paymentMethod
    });
    showReceipt(sale);
    cart.clear();
    $('discountInput').value = 0;
    $('paidInput').value = '';
    renderCart();
    refreshProducts();
    generateInvoicePdf(sale.id); // async, does not block the receipt display
  } catch (err) {
    toast(err.message?.replace(/^Error: /, '') || t('err.generic'), 'error');
  }
}

async function generateInvoicePdf(saleId) {
  currentPdfPath = null;
  $('openPdfBtn').disabled = true;
  $('openPdfBtn').textContent = t('invoice.generating');
  try {
    const res = await window.pos.invoices.generate(saleId);
    currentPdfPath = res.path;
    toast(t('invoice.saved'), 'success');
  } catch (err) {
    console.error(err);
    toast(t('invoice.failed'), 'error');
  } finally {
    $('openPdfBtn').textContent = t('receipt.openPdf');
    $('openPdfBtn').disabled = !currentPdfPath;
    window.i18n.apply(); // restore data-i18n label exactly
  }
}

$('openPdfBtn').addEventListener('click', () => {
  if (currentPdfPath) window.pos.invoices.open(currentPdfPath);
});

/* ---------------- Barcode scanner (HID keyboard-wedge) ----------------
 * Scanners type the code very fast then send Enter. We capture keystrokes
 * globally so scanning works even when the search box is not focused.
 * Typing inside an input field is left to its own handler to avoid doubles.
 */
const SCAN_MAX_GAP_MS = 60;   // max gap between scanner keystrokes
let scanBuf = '';
let scanLastTime = 0;

function isInTextField(e) {
  const el = e.target;
  return el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA');
}

document.addEventListener('keydown', (e) => {
  if (!$('receiptModal').classList.contains('hidden')) return; // ignore scans on receipt screen

  const now = Date.now();
  if (now - scanLastTime > SCAN_MAX_GAP_MS) scanBuf = '';
  scanLastTime = now;

  if (isInTextField(e)) return; // search/discount/paid inputs handle themselves

  if (e.key === 'Enter') {
    const code = scanBuf.trim();
    scanBuf = '';
    if (code.length >= 3) handleScannedCode(code);
    return;
  }
  if (e.key.length === 1) scanBuf += e.key;
});

function handleScannedCode(code) {
  const p = products.find(x => String(x.barcode || '') === code);
  if (!p) {
    toast(t('scan.notFound', { code }), 'error');
    return;
  }
  if (p.quantity <= 0) {
    toast(t('err.outOfStock'), 'error');
    return;
  }
  addToCart(p);
  toast(t('scan.added', { name: p.name }), 'success');
}

function showReceipt(sale) {
  $('rStoreName').textContent = settings.store_name;
  $('rInvoiceNo').textContent = `${t('receipt.invoiceNo')} ${sale.invoice_no}`;
  $('rDate').textContent = new Date(sale.created_at.replace(' ', 'T') + 'Z')
    .toLocaleString(window.i18n.locale(), { dateStyle: 'medium', timeStyle: 'short' });

  const tbody = $('rItems');
  tbody.innerHTML = sale.items.map(si => `
    <tr>
      <td>${escapeHtml(si.product_name)}</td>
      <td>${si.quantity}</td>
      <td>${money(si.unit_price)}</td>
      <td>${money(si.line_total)}</td>
    </tr>`).join('');

  $('rSubtotal').textContent = `${money(sale.subtotal)} ${settings.currency}`;
  $('rTax').textContent = `${money(sale.tax_total)} ${settings.currency}`;
  $('rDiscountRow').style.display = sale.discount > 0 ? '' : 'none';
  $('rDiscount').textContent = `${money(sale.discount)} ${settings.currency}`;
  $('rPaid').textContent = `${money(sale.paid)} ${settings.currency}`;
  $('rChange').textContent = `${money(sale.change_amount)} ${settings.currency}`;

  $('receiptModal').classList.remove('hidden');
}

/* ---------------- Session ---------------- */

let ME = null;
let PERMS = new Set();

function isSessionErr(err) {
  return err && typeof err.message === 'string' && err.message.includes('انتهت الجلسة');
}

async function handleSessionLoss() {
  try { await window.pos.auth.logout(); } catch { /* gate reopens anyway */ }
}

function applySessionUI() {
  if (!ME) return;
  $('userChip').classList.remove('hidden');
  $('userName').textContent = `${ME.display_name || ME.username} · ${t('users.role.' + ME.role)}`;
  $('logoutBtn').innerHTML = window.icon('logout', { size: 16 });
  $('logoutBtn').setAttribute('aria-label', t('common.logout'));
  $('openAdminBtn').classList.toggle('hidden', !PERMS.has('admin.access'));
}

$('logoutBtn').addEventListener('click', () => window.pos.auth.logout());

/* ---------------- Data refresh ---------------- */

async function refreshProducts() {
  const grid = $('productGrid');
  if (products.length === 0) {
    grid.innerHTML = Array.from({ length: 8 }).map(() => '<div class="skel-card"></div>').join('');
  }
  try {
    products = await window.pos.products.list('');
  } catch (err) {
    if (isSessionErr(err)) return handleSessionLoss();
    grid.innerHTML = `
      <div class="grid-state">
        <div class="state-ic">${window.icon('notification', { size: 28 })}</div>
        <div>${escapeHtml(t('err.loadShort'))}</div>
        <button type="button" class="btn small" id="gridRetryBtn">${escapeHtml(t('common.retry'))}</button>
      </div>`;
    window.icons.mount(grid);
    $('gridRetryBtn').addEventListener('click', refreshProducts);
    return;
  }
  renderGrid();
  // clamp cart quantities to live stock
  let changed = false;
  for (const [id, item] of cart) {
    const p = products.find(x => x.id === id);
    if (!p) {
      cart.delete(id);
      changed = true;
    } else if (item.quantity > p.quantity) {
      item.quantity = p.quantity;
      changed = true;
    }
  }
  if (changed) renderCart();
}

async function loadSettings() {
  settings = await window.pos.settings.get();
  $('storeName').textContent = settings.store_name;
  document.querySelectorAll('.cur').forEach(el => el.textContent = settings.currency);
  $('discountCurrency').textContent = settings.currency;
  updateTaxBadge();
}

/* ---------------- Events ---------------- */

$('searchInput').addEventListener('keydown', async (e) => {
  if (e.key !== 'Enter') return;
  const val = e.target.value.trim();
  if (!val) return;

  // exact barcode first
  const byBarcode = products.find(p => String(p.barcode || '') === val);
  if (byBarcode && byBarcode.quantity > 0) {
    addToCart(byBarcode);
  } else {
    const matches = products.filter(p =>
      p.name.toLowerCase().includes(val.toLowerCase()) ||
      String(p.category || '').toLowerCase().includes(val.toLowerCase()));
    const target = matches[0];
    if (target && target.quantity > 0) addToCart(target);
    else if (byBarcode || target) toast(t('err.outOfStock'), 'error');
    else toast(t('err.notFound'), 'error');
  }
  e.target.value = '';
  e.target.focus();
});

$('searchInput').addEventListener('input', renderGrid);
$('clearSearchBtn').addEventListener('click', () => {
  $('searchInput').value = '';
  renderGrid();
  $('searchInput').focus();
});

document.querySelectorAll('.pm').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.pm').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    paymentMethod = btn.dataset.pm;
  });
});

['discountInput', 'paidInput'].forEach(id => $(id).addEventListener('input', updateTotals));

$('checkoutBtn').addEventListener('click', doCheckout);
$('newSaleBtn').addEventListener('click', () => {
  $('receiptModal').classList.add('hidden');
  $('searchInput').focus();
});
$('printReceiptBtn').addEventListener('click', () => window.print());
$('openAdminBtn').addEventListener('click', () => window.pos.windows.openAdmin());

document.addEventListener('keydown', (e) => {
  if (e.key === 'F9') { e.preventDefault(); doCheckout(); }
  if (e.key === 'Escape') {
    if (!$('receiptModal').classList.contains('hidden')) {
      $('receiptModal').classList.add('hidden');
      $('searchInput').focus();
    }
  }
});

window.pos.onChanged(async (payload) => {
  if (payload.topic === 'settings') {
    await loadSettings();
    applyPrefs();
    renderGrid();
    renderCart();
    return;
  }
  await refreshProducts();
});

/* ---------------- Init ---------------- */

(async function init() {
  try {
    const me0 = await window.pos.auth.me();
    if (!me0 || !me0.user) return handleSessionLoss();
    ME = me0.user;
    PERMS = new Set(me0.permissions);
  } catch {
    return handleSessionLoss();
  }
  $('clearSearchBtn').innerHTML = window.icon('close', { size: 14 });
  $('clearSearchBtn').setAttribute('aria-label', t('cashier.clear'));
  if (ME.branch && ME.branch.name) {
    const chip = $('branchChip');
    chip.textContent = ME.branch.name;
    chip.title = t('cashier.branch');
    chip.classList.remove('hidden');
  }
  await loadSettings();
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
  await refreshProducts();
  renderCart();
  $('searchInput').focus();
})();
