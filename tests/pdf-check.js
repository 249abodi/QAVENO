'use strict';

/* End-to-end check: real DB -> checkout -> printToPDF -> valid file on disk */

const { app } = require('electron');
const path = require('node:path');
const fs = require('node:fs');

const db = require('../src/main/db');
const { generateInvoice, buildInvoiceHTML } = require('../src/main/pdf');

app.whenReady().then(async () => {
  try {
    const appPath = app.getAppPath();
    db.init(path.join(appPath, 'data', 'pos.db'));

    // 1) template sanity in both languages
    const products = db.listProducts();
    const p = products.find(x => x.quantity >= 2);
    const sale = db.checkout({ items: [{ product_id: p.id, quantity: 2 }], paid: 100000, payment_method: 'cash' });
    const st = db.getSettings();
    for (const lang of ['ar', 'en']) {
      const html = buildInvoiceHTML(sale, st, lang);
      if (!html.includes(sale.invoice_no)) throw new Error(`template missing invoice_no (${lang})`);
      if (!html.includes('dir="' + (lang === 'en' ? 'ltr' : 'rtl') + '"')) throw new Error(`template dir wrong (${lang})`);
      if (!html.includes(st.store_name)) throw new Error('template missing store name');
    }

    // 2) real PDF generation via Chromium
    const res = await generateInvoice(sale.id, appPath);
    const buf = fs.readFileSync(res.path);
    const okHeader = buf.subarray(0, 5).toString() === '%PDF-';
    console.log(`PDF_PATH ${res.path}`);
    console.log(`PDF_SIZE ${buf.length} bytes`);
    console.log(okHeader ? 'PDF_VALID_HEADER' : 'PDF_BAD_HEADER');

    fs.rmSync(res.path, { force: true }); // cleanup test artifact
    console.log(okHeader ? 'ALL_OK' : 'FAILED');
    app.exit(okHeader ? 0 : 1);
  } catch (e) {
    console.error('CHECK_FAILED:', e.message);
    app.exit(1);
  }
});
