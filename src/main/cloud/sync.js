'use strict';

/**
 * Phase 27 — offline-first sync engine.
 *
 * Local Operation → Local Database (always) → Outbox → Sync Engine → Cloud API
 *
 * - The app keeps working fully offline; the outbox survives restarts.
 * - Pushes are idempotent: every queued op carries a stable op_id, and the
 *   server records each op_id exactly once.
 * - Network detection via health probe; failures retry with backoff and are
 *   never silently dropped.
 */

const db = require('../db');
const outbox = require('./outbox');
const getDb = () => db.getDb();

let cachedAuth = null; // { accessToken, expiresAt }
let pushing = null;    // single-flight guard

function cfg() {
  const s = db.getSettings();
  return {
    enabled: String(s.cloud_mode || '') === '1',
    apiBase: String(s.cloud_api_url || '').replace(/\/+$/, ''),
    username: String(s.cloud_username || ''),
    password: String(s.cloud_password || ''),
  };
}

function deviceId() {
  const row = getDb().prepare('SELECT value FROM sync_state WHERE key=?').get('device_id');
  if (row) return row.value;
  const id = require('node:crypto').randomUUID();
  getDb().prepare('INSERT INTO sync_state (key,value) VALUES (?,?)').run('device_id', id);
  return id;
}

async function fetchJson(url, opts = {}, timeoutMs = 8000) {
  try {
    const res = await fetch(url, { ...opts, signal: AbortSignal.timeout(timeoutMs) });
    const body = await res.json().catch(() => null);
    return { status: res.status, ok: res.ok, body };
  } catch (e) {
    if (e && (e.name === 'TimeoutError' || /abort/i.test(String(e.message || '')))) {
      throw new Error('request timed out');
    }
    throw e;
  }
}

async function probeHealth(apiBase) {
  try {
    const r = await fetchJson(`${apiBase}/api/v1/health`, {}, 4000);
    return r.ok;
  } catch {
    return false;
  }
}

async function login(apiBase, username, password) {
  const r = await fetchJson(`${apiBase}/api/v1/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username, password }),
  });
  if (!r.ok) throw new Error(`cloud login failed (${r.status})`);
  cachedAuth = {
    accessToken: String(r.body.accessToken),
    // refresh 60s before real expiry to ride through long pushes
    expiresAt: Date.now() + 55_000,
  };
  return cachedAuth;
}

async function ensureToken(apiBase, username, password) {
  if (cachedAuth && Date.now() < cachedAuth.expiresAt) return cachedAuth.accessToken;
  const a = await login(apiBase, username, password);
  return a.accessToken;
}

/** Push all currently-eligible pending ops. Safe to call concurrently —
 *  single-flight. Returns a summary object, never throws. */
async function pushPending() {
  if (pushing) return pushing;
  pushing = (async () => {
    const { enabled, apiBase, username, password } = cfg();
    if (!enabled) return { status: 'disabled' };
    if (!username || !password) return { status: 'not_configured' };

    const healthy = await probeHealth(apiBase);
    if (!healthy) return { status: 'offline', stats: outbox.stats(db) };

    let token;
    try {
      token = await ensureToken(apiBase, username, password);
    } catch (e) {
      return { status: 'auth_failed', error: e.message, stats: outbox.stats(db) };
    }

    const batch = outbox.takePending(db, 50);
    if (!batch.length) return { status: 'idle', stats: outbox.stats(db) };

    let res;
    try {
      res = await fetchJson(`${apiBase}/api/v1/sync/push`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ deviceId: deviceId(), ops: batch.map((b) => ({
          opId: b.opId,
          type: b.opType,
          payload: b.payload,
        })) }),
      });
    } catch (e) {
      for (const b of batch) outbox.markFailed(db, b.opId, e.message);
      return { status: 'network_error', error: e.message, stats: outbox.stats(db) };
    }

    if (res.status === 401) {
      // token raced to expiry: one fresh login + retry of this same batch
      cachedAuth = null;
      try {
        token = await ensureToken(apiBase, username, password);
        res = await fetchJson(`${apiBase}/api/v1/sync/push`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
          body: JSON.stringify({ deviceId: deviceId(), ops: batch.map((b) => ({
            opId: b.opId, type: b.opType, payload: b.payload,
          })) }),
        });
      } catch (e) {
        for (const b of batch) outbox.markFailed(db, b.opId, e.message);
        return { status: 'network_error', error: e.message, stats: outbox.stats(db) };
      }
    }

    if (res.status !== 201 && res.status !== 200) {
      for (const b of batch) outbox.markFailed(db, b.opId, `push failed (${res.status})`);
      return { status: 'rejected_batch', httpStatus: res.status, stats: outbox.stats(db) };
    }

    const byOp = new Map((res.body?.results || []).map((r) => [String(r.opId), r]));
    let applied = 0, duplicates = 0, rejected = 0, conflicts = 0;
    for (const b of batch) {
      const r = byOp.get(String(b.opId));
      if (!r) {
        outbox.markFailed(db, b.opId, 'no result from server');
        continue;
      }
      if (r.status === 'applied') { outbox.markSent(db, [b.opId]); applied++; }
      else if (r.status === 'duplicate') { outbox.markSent(db, [b.opId]); duplicates++; }
      else if (r.status === 'conflict') {
        // server refused to overwrite: park the op and surface the conflict.
        // Retrying would just re-hit the ledger; resolution happens in the UI.
        conflicts++;
        outbox.markBlocked(db, b.opId, r.conflictId,
          `conflict: ${r.conflictType || 'UNKNOWN'}`);
        outbox.upsertConflict(db, {
          conflictId: String(r.conflictId),
          opId: b.opId,
          entityType: 'product',
          entityId: Number(b.payload?.productId) || null,
          conflictType: String(r.conflictType || 'UNKNOWN'),
          status: 'open',
          reason: `conflict: ${r.conflictType || 'UNKNOWN'}`,
          localPayload: b.payload,
        });
      }
      else { rejected++; outbox.markFailed(db, b.opId, `server rejected: ${r.code || 'unknown'}`); }
    }
    return {
      status: 'ok',
      applied,
      duplicates,
      rejected,
      conflicts,
      stats: outbox.stats(db),
    };
  })();
  try {
    return await pushing;
  } finally {
    pushing = null;
  }
}

/** Pull the authoritative conflict list from the cloud and mirror status /
 *  resolution changes into the local table. Never throws. */
async function pullConflicts() {
  const { enabled, apiBase, username, password } = cfg();
  if (!enabled) return { status: 'disabled' };
  if (!username || !password) return { status: 'not_configured' };
  let token;
  try {
    const healthy = await probeHealth(apiBase);
    if (!healthy) return { status: 'offline' };
    token = await ensureToken(apiBase, username, password);
  } catch (e) {
    return { status: 'auth_failed', error: e.message };
  }
  let res;
  try {
    res = await fetchJson(`${apiBase}/api/v1/sync/conflicts?limit=200`, {
      headers: { authorization: `Bearer ${token}` },
    });
  } catch (e) {
    return { status: 'network_error', error: e.message };
  }
  if (!res.ok || !Array.isArray(res.body?.items)) return { status: 'error', httpStatus: res.status };
  for (const c of res.body.items) {
    outbox.upsertConflict(db, {
      conflictId: c.conflict_id,
      opId: c.op_id,
      entityType: c.entity_type,
      entityId: c.entity_id ?? null,
      conflictType: c.conflict_type,
      status: c.status,
      resolution: c.resolution ?? null,
      reason: c.conflict_type,
      localPayload: null,
      createdAt: c.created_at,
    });
  }
  return { status: 'ok', count: res.body.items.length };
}

/** Resolve a conflict on the authoritative server. Never throws. */
async function resolveConflict(conflictId, resolution) {
  return conflictAction('resolve', { resolution }, conflictId);
}

/** Retry a safely re-appliable conflict on the server. Never throws. */
async function retryConflict(conflictId) {
  return conflictAction('retry', null, conflictId);
}

async function conflictAction(action, bodyObj, conflictId) {
  const { enabled, apiBase, username, password } = cfg();
  if (!enabled) return { status: 'disabled' };
  if (!username || !password) return { status: 'not_configured' };
  let token;
  try {
    const healthy = await probeHealth(apiBase);
    if (!healthy) return { status: 'offline' };
    token = await ensureToken(apiBase, username, password);
  } catch (e) {
    return { status: 'auth_failed', error: e.message };
  }
  try {
    const res = await fetchJson(
      `${apiBase}/api/v1/sync/conflicts/${encodeURIComponent(String(conflictId))}/${action}`,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${token}`,
        },
        body: JSON.stringify(bodyObj || {}),
      },
    );
    if (res.status === 401) {
      cachedAuth = null;
      return { status: 'error', code: 'AUTH', httpStatus: res.status };
    }
    if (!res.ok) {
      return { status: 'error', code: res.body?.code || 'CONFLICT_ACTION_FAILED', httpStatus: res.status };
    }
    return { status: 'ok', ...res.body };
  } catch (e) {
    return { status: 'network_error', error: e.message };
  }
}

/** Authenticated GET to cloud backend (used by billing IPC). */
async function apiGet(path) {
  const { enabled, apiBase, username, password } = cfg();
  if (!enabled || !apiBase) return { status: 'disabled' };
  let token;
  try { token = await ensureToken(apiBase, username, password); } catch (e) { return { status: 'auth_failed', error: e.message }; }
  try {
    const res = await fetchJson(`${apiBase}/api/v1${path}`, {
      headers: { 'Authorization': `Bearer ${token}` },
    });
    return res.ok ? res.body : { status: 'error', code: res.body?.code || 'API_ERROR', httpStatus: res.status };
  } catch (e) {
    return { status: 'network_error', error: e.message };
  }
}

/** Authenticated POST to cloud backend (used by billing IPC). */
async function apiPost(path, body) {
  const { enabled, apiBase, username, password } = cfg();
  if (!enabled || !apiBase) return { status: 'disabled' };
  let token;
  try { token = await ensureToken(apiBase, username, password); } catch (e) { return { status: 'auth_failed', error: e.message }; }
  try {
    const res = await fetchJson(`${apiBase}/api/v1${path}`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body || {}),
    });
    return res.ok ? res.body : { status: 'error', code: res.body?.code || 'API_ERROR', httpStatus: res.status };
  } catch (e) {
    return { status: 'network_error', error: e.message };
  }
}

/** Authenticated PATCH to cloud backend (used by owner IPC). */
async function apiPatch(path, body) {
  const { enabled, apiBase, username, password } = cfg();
  if (!enabled || !apiBase) return { status: 'disabled' };
  let token;
  try { token = await ensureToken(apiBase, username, password); } catch (e) { return { status: 'auth_failed', error: e.message }; }
  try {
    const res = await fetchJson(`${apiBase}/api/v1${path}`, {
      method: 'PATCH',
      headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body || {}),
    });
    return res.ok ? res.body : { status: 'error', code: res.body?.code || 'API_ERROR', httpStatus: res.status };
  } catch (e) {
    return { status: 'network_error', error: e.message };
  }
}

module.exports = {
  pushPending, pullConflicts, resolveConflict, retryConflict,
  cfg, deviceId, apiGet, apiPost, apiPatch,
  _resetAuthCache: () => { cachedAuth = null; },
};
