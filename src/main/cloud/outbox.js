'use strict';

/**
 * Phase 27 — local outbox for offline-first operation.
 * Durable queue of operations to replicate to the cloud backend.
 * Pure functions over the database handle → trivially testable.
 */

const crypto = require('node:crypto');

/** Backoff schedule (seconds) before a failed op becomes eligible again. */
const BACKOFF_SEC = [30, 120, 600, 1800];

/** Accepts either the raw sqlite handle or the db.js module wrapper. */
function resolve(dbLike) {
  return typeof dbLike.getDb === 'function' ? dbLike.getDb() : dbLike;
}

function enqueue(dbModule, opType, payload) {
  const d = resolve(dbModule);
  const opId = crypto.randomUUID();
  d.prepare(
    `INSERT INTO outbox (op_id, op_type, payload) VALUES (?, ?, ?)`
  ).run(opId, String(opType), JSON.stringify(payload || {}));
  return opId;
}

function nowStr() {
  return new Date().toISOString().replace('T', ' ').slice(0, 19);
}

function plusSec(sec) {
  return new Date(Date.now() + sec * 1000).toISOString().replace('T', ' ').slice(0, 19);
}

/** Pending ops whose retry backoff has elapsed, in FIFO order. */
function takePending(dbModule, limit = 50) {
  const db = resolve(dbModule);
  return db.prepare(
    `SELECT id, op_id AS opId, op_type AS opType, payload, attempts
     FROM outbox
     WHERE status = 'pending'
       AND (available_at IS NULL OR available_at <= ?)
     ORDER BY id
     LIMIT ?`
  ).all(nowStr(), limit).map((r) => ({ ...r, payload: JSON.parse(r.payload) }));
}

function markSent(dbModule, opIds) {
  const db = resolve(dbModule);
  const stmt = db.prepare(
    `UPDATE outbox SET status='sent', updated_at=? WHERE op_id=?`
  );
  db.exec('BEGIN IMMEDIATE');
  try {
    for (const opId of opIds) stmt.run(nowStr(), opId);
    db.exec('COMMIT');
  } catch (e) {
    try { db.exec('ROLLBACK'); } catch { /* noop */ }
    throw e;
  }
}

function markFailed(dbModule, opId, errMessage) {
  const db = resolve(dbModule);
  const row = db.prepare('SELECT attempts FROM outbox WHERE op_id=?').get(opId);
  if (!row) return null;
  const attempts = Number(row.attempts) + 1;
  const idx = Math.min(attempts - 1, BACKOFF_SEC.length - 1);
  // after exhausting the schedule the op stays pending but waits on the last,
  // longest interval — it is never dropped silently
  const delay = BACKOFF_SEC[idx];
  db.prepare(
    `UPDATE outbox SET status='pending', attempts=?, last_error=?, available_at=?, updated_at=? WHERE op_id=?`
  ).run(attempts, String(errMessage).slice(0, 500), plusSec(delay), nowStr(), opId);
  return { attempts, retryInSec: delay };
}

/** Manual override: make an op eligible again immediately (operator action). */
function clearBackoff(dbModule, opId) {
  const db = resolve(dbModule);
  db.prepare(
    `UPDATE outbox SET available_at=NULL WHERE op_id=?`
  ).run(opId);
}

/** A server-detected conflict parks the op: it stops retrying (retrying would
 *  only bounce off the idempotency ledger) but is preserved for review. */
function markBlocked(dbModule, opId, conflictRef, reason) {
  const db = resolve(dbModule);
  db.prepare(
    `UPDATE outbox SET status='blocked', conflict_ref=?, last_error=?, updated_at=? WHERE op_id=?`
  ).run(conflictRef ?? null, String(reason || 'conflict').slice(0, 500), nowStr(), opId);
}

function listConflicts(dbModule) {
  const db = resolve(dbModule);
  return db.prepare(
    `SELECT conflict_id, op_id, entity_type, entity_id, conflict_type, status,
            resolution, reason, local_payload, created_at, updated_at
     FROM cloud_conflicts ORDER BY created_at DESC`
  ).all();
}

function upsertConflict(dbModule, c) {
  const db = resolve(dbModule);
  db.prepare(`
    INSERT INTO cloud_conflicts
      (conflict_id, op_id, entity_type, entity_id, conflict_type, status, resolution, reason, local_payload, created_at)
    VALUES (?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(conflict_id) DO UPDATE SET
      status=excluded.status, resolution=excluded.resolution, updated_at=excluded.updated_at
  `).run(
    String(c.conflictId), String(c.opId), String(c.entityType || 'product'),
    c.entityId ?? null, String(c.conflictType || 'UNKNOWN'),
    String(c.status || 'open'), c.resolution ?? null,
    c.reason ? String(c.reason).slice(0, 500) : null,
    c.localPayload ? JSON.stringify(c.localPayload) : null,
    c.createdAt ?? nowStr(),
  );
}

function stats(dbModule) {
  const db = resolve(dbModule);
  const rows = db.prepare(
    `SELECT status, COUNT(*) AS c FROM outbox GROUP BY status`
  ).all();
  const out = { pending: 0, sent: 0, failed: 0 };
  let total = 0;
  for (const r of rows) { out[r.status] = Number(r.c); total += Number(r.c); }
  out.total = total;
  return out;
}

module.exports = { enqueue, takePending, markSent, markFailed, clearBackoff, markBlocked, upsertConflict, listConflicts, stats, BACKOFF_SEC };
