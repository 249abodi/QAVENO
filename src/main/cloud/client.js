'use strict';

/**
 * Phase 25 transition layer — Cloud status probe (read-only, opt-in).
 *
 * The Electron/SQLite app remains the system of record. This module only
 * reports whether the optional cloud backend (Phase 25) is reachable so a
 * future migration path can be surfaced in the UI. It never writes to the
 * cloud and never changes local behavior.
 *
 * Settings keys (managed manually for now):
 *   cloud_mode    '0' | '1'
 *   cloud_api_url base URL, e.g. http://127.0.0.1:3000
 */

const db = require('../db');

async function probe(url) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 3000);
  try {
    const res = await fetch(`${url.replace(/\/+$/, '')}/api/v1/health`, {
      signal: ctrl.signal,
    });
    if (!res.ok) return { reachable: false };
    const body = await res.json().catch(() => null);
    return { reachable: true, dbUp: !!(body && body.db === 'up') };
  } catch {
    return { reachable: false };
  } finally {
    clearTimeout(timer);
  }
}

async function getStatus() {
  let mode = '0';
  let url = '';
  try {
    const s = db.getSettings();
    mode = String(s.cloud_mode || '0');
    url = String(s.cloud_api_url || '');
  } catch {
    /* settings unavailable → treat as disabled */
  }
  const enabled = mode === '1' && !!url;
  if (!enabled) return { enabled: false, url: '', reachable: false };

  const r = await probe(url);
  return { enabled: true, url, reachable: r.reachable, dbUp: r.dbUp === true };
}

module.exports = { getStatus };
