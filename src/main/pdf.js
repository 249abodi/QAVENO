'use strict';

const { BrowserWindow } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const db = require('./db');
const { buildInvoiceHTML } = require('./invoice-template');

function invoicesDir(appPath) {
  return path.join(appPath, 'data', 'invoices');
}

function readLogoDataUrl(appPath) {
  const p = path.join(appPath, 'assets', 'logo.png');
  if (!fs.existsSync(p)) return null;
  try {
    return 'data:image/png;base64,' + fs.readFileSync(p).toString('base64');
  } catch {
    return null;
  }
}

async function generateInvoice(saleId, appPath) {
  const sale = db.getSale(saleId);
  if (!sale) throw new Error('الفاتورة غير موجودة');

  const settings = db.getSettings();
  const lang = settings.lang === 'en' ? 'en' : 'ar';
  const html = buildInvoiceHTML(sale, settings, lang, readLogoDataUrl(appPath));

  // Hidden window renders the HTML; Chromium produces a perfect RTL/Arabic PDF.
  const win = new BrowserWindow({
    show: false,
    webPreferences: {
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  try {
    await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));
    const pdfBuffer = await win.webContents.printToPDF({
      pageSize: 'A4',
      printBackground: true,
      margins: { marginType: 'custom', top: 0.4, bottom: 0.4, left: 0.4, right: 0.4 }
    });

    const dir = invoicesDir(appPath);
    fs.mkdirSync(dir, { recursive: true });
    const filePath = path.join(dir, `${sale.invoice_no}.pdf`);
    fs.writeFileSync(filePath, pdfBuffer);
    return { path: filePath };
  } finally {
    if (!win.isDestroyed()) win.destroy();
  }
}

module.exports = { generateInvoice, buildInvoiceHTML };
