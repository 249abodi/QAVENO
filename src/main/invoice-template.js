'use strict';

/*
 * Pure invoice HTML template builder (no Electron dependency).
 * Rendered through Chromium (printToPDF) so Arabic shaping/RTL is perfect.
 */

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));
}

const money = (n) => Number(n || 0).toFixed(2);

function fmtDate(iso, locale) {
  try {
    return new Date(String(iso).replace(' ', 'T') + 'Z')
      .toLocaleString(locale, { dateStyle: 'medium', timeStyle: 'short' });
  } catch { return iso; }
}

function buildInvoiceHTML(sale, settings, lang, logoDataUrl = null) {
  const L = lang === 'en'
    ? {
        dir: 'ltr',
        title: 'Tax Invoice',
        invoiceNo: 'Invoice No.',
        date: 'Date',
        payment: 'Payment',
        cash: 'Cash',
        card: 'Card',
        thNo: '#',
        thProduct: 'Product',
        thQty: 'Qty',
        thPrice: 'Unit Price',
        thTax: 'Tax',
        thTotal: 'Line Total',
        subtotal: 'Subtotal',
        taxRate: 'Tax rate',
        tax: 'VAT',
        discount: 'Discount',
        grandTotal: 'Grand Total',
        paidRow: 'Paid',
        change: 'Change',
        thanks: 'Thank you for your business!',
        footerNote: 'This invoice was generated electronically.'
      }
    : {
        dir: 'rtl',
        title: 'فاتورة ضريبية',
        invoiceNo: 'رقم الفاتورة',
        date: 'التاريخ',
        payment: 'طريقة الدفع',
        cash: 'نقداً',
        card: 'بطاقة',
        thNo: '#',
        thProduct: 'المنتج',
        thQty: 'الكمية',
        thPrice: 'سعر الوحدة',
        thTax: 'الضريبة',
        thTotal: 'الإجمالي',
        subtotal: 'المجموع الفرعي',
        taxRate: 'نسبة الضريبة',
        tax: 'ضريبة القيمة المضافة',
        discount: 'الخصم',
        grandTotal: 'الإجمالي النهائي',
        paidRow: 'المدفوع',
        change: 'الباقي',
        thanks: 'شكراً لتعاملكم معنا!',
        footerNote: 'هذه الفاتورة صادرة إلكترونياً.'
      };

  const currency = esc(settings.currency || '');
  const taxRatePct = Number(settings.tax_rate || 0);

  const rows = sale.items.map((si, i) => `
    <tr>
      <td class="c">${i + 1}</td>
      <td>${esc(si.product_name)}</td>
      <td class="c">${si.quantity}</td>
      <td class="num">${money(si.unit_price)}</td>
      <td class="c">${taxRatePct}%</td>
      <td class="num">${money(si.line_total)} ${currency}</td>
    </tr>`).join('');

  return `<!DOCTYPE html>
<html lang="${lang}" dir="${L.dir}">
<head>
<meta charset="UTF-8">
<title>${esc(sale.invoice_no)}</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    font-family: "Segoe UI", Tahoma, Arial, sans-serif;
    color: #111827;
    font-size: 13px;
    padding: 8px;
  }
  .head { display: flex; justify-content: space-between; align-items: flex-start; border-bottom: 3px solid #2563eb; padding-bottom: 14px; }
  .store-name { font-size: 26px; font-weight: 800; color: #2563eb; }
  .doc-title { font-size: 16px; font-weight: 700; color: #374151; margin-top: 2px; }
  .meta-box { text-align: ${L.dir === 'rtl' ? 'left' : 'right'}; font-size: 12px; line-height: 1.9; color: #374151; min-width: 220px; }
  .meta-box b { font-weight: 700; }
  table { width: 100%; border-collapse: collapse; margin-top: 18px; }
  th { background: #eff6ff; color: #1e3a8a; padding: 9px 8px; font-size: 12px; border-bottom: 2px solid #2563eb; }
  td { padding: 8px; border-bottom: 1px solid #e5e7eb; }
  tr:nth-child(even) td { background: #f9fafb; }
  td.c { text-align: center; }
  td.num { text-align: ${L.dir === 'rtl' ? 'left' : 'right'}; white-space: nowrap; }
  .totals-wrap { display: flex; justify-content: flex-end; margin-top: 16px; }
  .totals { width: 300px; border: 1px solid #e5e7eb; border-radius: 8px; overflow: hidden; }
  .totals .row { display: flex; justify-content: space-between; padding: 7px 14px; border-bottom: 1px solid #f3f4f6; }
  .totals .row.grand { background: #2563eb; color: #fff; font-size: 15px; font-weight: 800; padding: 10px 14px; }
  .footer { margin-top: 34px; text-align: center; color: #6b7280; font-size: 12px; }
  .thanks { font-size: 14px; font-weight: 700; color: #374151; margin-bottom: 4px; }
</style>
</head>
<body>
  <div class="head">
    <div style="display:flex;align-items:center;gap:14px;">
      ${logoDataUrl ? `<img src="${logoDataUrl}" alt="" style="height:64px;width:64px;object-fit:contain;border-radius:10px;" />` : ''}
      <div>
        <div class="store-name">${esc(settings.store_name)}</div>
        <div class="doc-title">${L.title}</div>
      </div>
    </div>
    <div class="meta-box">
      <div><b>${L.invoiceNo}:</b> ${esc(sale.invoice_no)}</div>
      <div><b>${L.date}:</b> ${fmtDate(sale.created_at, lang === 'en' ? 'en-GB' : 'ar')}</div>
      <div><b>${L.payment}:</b> ${sale.payment_method === 'card' ? L.card : L.cash}</div>
    </div>
  </div>

  <table>
    <thead>
      <tr>
        <th style="width:36px">${L.thNo}</th>
        <th>${L.thProduct}</th>
        <th style="width:56px">${L.thQty}</th>
        <th style="width:90px">${L.thPrice}</th>
        <th style="width:56px">${L.thTax}</th>
        <th style="width:110px">${L.thTotal}</th>
      </tr>
    </thead>
    <tbody>${rows}</tbody>
  </table>

  <div class="totals-wrap">
    <div class="totals">
      <div class="row"><span>${L.subtotal}</span><span>${money(sale.subtotal)} ${currency}</span></div>
      <div class="row"><span>${L.tax} (${taxRatePct}%)</span><span>${money(sale.tax_total)} ${currency}</span></div>
      ${sale.discount > 0 ? `<div class="row"><span>${L.discount}</span><span>- ${money(sale.discount)} ${currency}</span></div>` : ''}
      <div class="row grand"><span>${L.grandTotal}</span><span>${money(sale.total)} ${currency}</span></div>
      <div class="row"><span>${L.paidRow}</span><span>${money(sale.paid)} ${currency}</span></div>
      <div class="row"><span>${L.change}</span><span>${money(sale.change_amount)} ${currency}</span></div>
    </div>
  </div>

  <div class="footer">
    <div class="thanks">${L.thanks}</div>
    <div>${L.footerNote}</div>
  </div>
</body>
</html>`;
}

module.exports = { buildInvoiceHTML };
