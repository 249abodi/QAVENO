'use strict';

/* Canonical writable data-directory resolver.

   In development, app.getAppPath() is the project folder, so the app keeps
   using the existing ./data directory (matches the pre-packaging layout and
   keeps the dev database/tests where they already are).

   In a packaged build, app.getAppPath() points inside the read-only
   resources/app.asar archive, where nothing can be created or written. We
   probe for writability and, when that fails, fall back to the per-user
   writable data directory (app.getPath('userData')) so the database and
   invoice PDFs can actually be persisted. */

const { app } = require('electron');
const path = require('node:path');
const fs = require('node:fs');

let cached = null;

function probeWritable(candidate) {
  try {
    fs.mkdirSync(candidate, { recursive: true });
    const probe = path.join(candidate, '.qw-probe');
    fs.writeFileSync(probe, String(Date.now()));
    fs.unlinkSync(probe);
    return true;
  } catch {
    return false;
  }
}

function resolveDataDir() {
  if (cached) return cached;
  const inApp = path.join(app.getAppPath(), 'data');
  if (probeWritable(inApp)) {
    cached = inApp;
    return cached;
  }
  const inUserData = path.join(app.getPath('userData'), 'data');
  probeWritable(inUserData);
  cached = inUserData;
  return cached;
}

function invoicesDir() {
  return path.join(resolveDataDir(), 'invoices');
}

function dbPath() {
  return path.join(resolveDataDir(), 'pos.db');
}

module.exports = { resolveDataDir, invoicesDir, dbPath };
