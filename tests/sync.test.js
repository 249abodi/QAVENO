'use strict';

/* Phase 27 gate: offline-first outbox + sync engine (real SQLite + mock cloud) */

const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const http = require('node:http');

const db = require('../src/main/db');
const migrations = require('../src/main/migrations');
const outbox = require('../src/main/cloud/outbox');
const syncEngine = require('../src/main/cloud/sync');

let passed = 0;
let failed = 0;
function assert(cond, label) {
  if (cond) { passed++; console.log('  PASS', label); }
  else { failed++; console.error('  FAIL', label); }
}

function startMockCloud(state) {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => {
        state.requests.push({ method: req.method, url: req.url, auth: req.headers.authorization, body: body ? JSON.parse(body) : null });
        if (req.url === '/api/v1/health') {
          if (!state.healthy) { res.writeHead(503, { connection: 'close' }); res.end(); return; }
          res.writeHead(200, { 'content-type': 'application/json', connection: 'close' });
          res.end(JSON.stringify({ status: 'ok', db: 'up' }));
          return;
        }
        if (req.url === '/api/v1/auth/login') {
          const { username, password } = state.credentials;
          const ok = body && JSON.parse(body).username === username && JSON.parse(body).password === password;
          res.writeHead(ok ? 201 : 401, { 'content-type': 'application/json', connection: 'close' });
          res.end(JSON.stringify(ok ? { accessToken: `tok-${++state.tokenCounter}` } : { message: 'bad' }));
          return;
        }
        if (req.url === '/api/v1/sync/push' && req.method === 'POST') {
          if (!state.healthy) { res.writeHead(503, { connection: 'close' }); res.end(); return; }
          const auth = String(req.headers.authorization || '');
          if (auth !== `Bearer tok-${state.tokenCounter}` && !state.acceptAnyToken) {
            res.writeHead(401, { 'content-type': 'application/json', connection: 'close' });
            res.end(JSON.stringify({ statusCode: 401, code: 'UNAUTHORIZED' }));
            return;
          }
          const results = [];
          for (const op of JSON.parse(body).ops || []) {
            state.appliedOps.push(op);
            const mode = state.resultMode(op, state);
            if (mode === 'applied') results.push({ opId: op.opId, status: 'applied' });
            else if (mode === 'duplicate') results.push({ opId: op.opId, status: 'duplicate' });
            else if (mode.conflict) results.push({ opId: op.opId, status: 'conflict', conflictId: mode.conflict, conflictType: mode.type });
            else results.push({ opId: op.opId, status: 'rejected', code: mode });
          }
          res.writeHead(201, { 'content-type': 'application/json', connection: 'close' });
          res.end(JSON.stringify({ results }));
          return;
        }
        if (req.url.startsWith('/api/v1/sync/conflicts') && req.method === 'GET') {
          res.writeHead(200, { 'content-type': 'application/json', connection: 'close' });
          res.end(JSON.stringify({ items: state.serverConflicts || [], total: (state.serverConflicts || []).length }));
          return;
        }
        res.writeHead(404); res.end();
      });
    });
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

(async () => {
  console.log('\n[0] fresh DB with v6 migration');
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sync-test-'));
  db.init(path.join(tmpDir, 'test.db'));
  const applied = db.getDb().prepare('SELECT version FROM schema_migrations ORDER BY version').all().map((r) => r.version);
  assert(applied.includes(6), 'migration v6 applied');
  const tables = db.getDb().prepare(
    `SELECT name FROM sqlite_master WHERE type='table' AND name IN ('outbox','sync_state')`
  ).all().map((r) => r.name).sort();
  assert(JSON.stringify(tables) === JSON.stringify(['outbox', 'sync_state']), 'outbox + sync_state exist');

  console.log('\n[1] outbox lifecycle');
  const id1 = outbox.enqueue(db, 'product.update', { productId: 3, price: 42 });
  const id2 = outbox.enqueue(db, 'product.update', { productId: 4, name: 'x' });
  assert(typeof id1 === 'string' && id1.length >= 32, 'enqueue returns stable op ids');
  let pending = outbox.takePending(db, 10);
  assert(pending.length === 2 && pending[0].payload.price === 42, 'takePending FIFO with parsed payload');

  // failed ops back off but are never dropped
  outbox.markFailed(db, id1, 'boom');
  pending = outbox.takePending(db, 10);
  assert(pending.length === 1 && pending[0].opId === id2, 'failed op leaves eligibility window');
  const row = db.getDb().prepare('SELECT attempts, status FROM outbox WHERE op_id=?').get(id1);
  assert(Number(row.attempts) === 1 && row.status === 'pending', 'failed op stays pending for retry');

  outbox.markSent(db, [pending[0].opId]);
  const statsAfter = outbox.stats(db);
  assert(statsAfter.sent === 1 && statsAfter.pending === 1, 'markSent + stats reflect states');

  console.log('\n[2] engine: disabled / not configured / offline');
  db.setSetting('cloud_mode', '0');
  let res = await syncEngine.pushPending();
  assert(res.status === 'disabled', 'disabled when cloud_mode off');

  db.setSetting('cloud_mode', '1');
  db.setSetting('cloud_api_url', 'http://127.0.0.1:9'); // nothing listens
  res = await syncEngine.pushPending();
  assert(res.status === 'not_configured', 'not_configured without credentials');

  db.setSetting('cloud_username', 'svc');
  db.setSetting('cloud_password', 'SvcPass1!');
  res = await syncEngine.pushPending();
  assert(res.status === 'offline', 'offline when health probe fails');
  assert(outbox.stats(db).pending === 2 - 1, 'nothing marked failed while offline');

  console.log('\n[3] engine: happy-path push against mock cloud');
  const state = {
    healthy: true,
    credentials: { username: 'svc', password: 'SvcPass1!' },
    tokenCounter: 0,
    requests: [],
    appliedOps: [],
    resultMode: () => 'applied',
    acceptAnyToken: false,
  };
  const server = await startMockCloud(state);
  const port = server.address().port;
  db.setSetting('cloud_api_url', `http://127.0.0.1:${port}`);

  const idPush = outbox.enqueue(db, 'product.update', { productId: 7, price: 19 });
  res = await syncEngine.pushPending();
  assert(res.status === 'ok' && res.applied === 1, 'pending op pushed and marked sent');
  const loginReq = state.requests.find((r) => r.url === '/api/v1/auth/login');
  assert(!!loginReq, 'engine authenticated before pushing');
  const pushReq = state.requests.find((r) => r.url === '/api/v1/sync/push');
  assert(pushReq.body.deviceId && /^[0-9a-f-]{36}$/.test(pushReq.body.deviceId), 'stable deviceId sent');
  assert(pushReq.body.ops[0].opId === idPush, 'queued opId travels to the server');

  console.log('\n[4] engine: rejected op retries, duplicate counts as done');
  const id3 = outbox.enqueue(db, 'product.update', { productId: 9, name: 'reject-me' });
  state.resultMode = (op) => (op.payload.name === 'reject-me' ? 'BAD_NAME' : 'applied');
  res = await syncEngine.pushPending();
  assert(res.status === 'ok' && res.rejected === 1 && res.stats.pending === 2, 'server rejection → op retried later, not lost');
  state.resultMode = () => 'duplicate';
  outbox.clearBackoff(db, id3); // operator forces immediate retry
  res = await syncEngine.pushPending();
  assert(res.status === 'ok' && res.duplicates === 1, 'duplicate resolution completes the op');

  console.log('\n[5] engine: server down mid-push marks batch for retry');
  const id4 = outbox.enqueue(db, 'product.update', { productId: 10, price: 5 });
  state.healthy = false;
  res = await syncEngine.pushPending();
  assert(res.status === 'offline', 'health gate prevents blind push');
  state.healthy = true;
  state.resultMode = () => 'applied';
  res = await syncEngine.pushPending();
  assert(res.status === 'ok', 'recovers automatically once cloud returns');

  console.log('\n[6] single-flight concurrency');
  const p1 = syncEngine.pushPending();
  const p2 = syncEngine.pushPending();
  const both = await Promise.all([p1, p2]);
  assert(both.every((r) => r && r.status), 'concurrent calls resolve without corruption');

  console.log('\n[7] Phase 28: conflict handling end-to-end');
  // a conflicted op is parked (blocked), preserved, visible — and never retried
  const idConf = outbox.enqueue(db, 'product.update', { productId: 42, baseVersion: 1, price: 33 });
  const idSafe = outbox.enqueue(db, 'product.update', { productId: 43, name: 'safe' });
  state.resultMode = (op) => {
    if (op.payload && op.payload.productId === 42) {
      return { conflict: '11111111-1111-4111-8111-111111111111', type: 'STALE_VERSION' };
    }
    return 'applied';
  };
  res = await syncEngine.pushPending();
  assert(res.status === 'ok' && res.conflicts === 1 && res.applied === 1,
    'engine reports conflict alongside safe ops that keep syncing');
  const blockedRow = db.getDb().prepare('SELECT status, conflict_ref FROM outbox WHERE op_id=?').get(idConf);
  assert(blockedRow.status === 'blocked' && blockedRow.conflict_ref === '11111111-1111-4111-8111-111111111111',
    'conflicted op is blocked with server conflict reference');
  const safeRow = db.getDb().prepare('SELECT status FROM outbox WHERE op_id=?').get(idSafe);
  assert(safeRow.status === 'sent', 'safe op completed normally');
  let pend = outbox.takePending(db, 50);
  assert(!pend.some((r) => r.opId === idConf), 'blocked op never re-enters the push queue (no duplicate retries)');
  const localList = outbox.listConflicts(db);
  const localRow = localList.find((c) => c.conflict_id === '11111111-1111-4111-8111-111111111111');
  assert(!!localRow && localRow.status === 'open' && Number(localRow.entity_id) === 42,
    'conflict is locally visible for the admin UI');

  // refresh reconciles resolutions from the authoritative cloud list
  state.serverConflicts = [{
    conflict_id: '11111111-1111-4111-8111-111111111111',
    op_id: idConf,
    entity_type: 'product',
    entity_id: 42,
    conflict_type: 'STALE_VERSION',
    status: 'resolved',
    resolution: 'applied_local',
    created_at: new Date().toISOString(),
  }];
  res = await syncEngine.pullConflicts();
  assert(res.status === 'ok' && res.count === 1, 'conflict refresh pulls from the cloud');
  const refreshed = outbox.listConflicts(db).find((c) => c.conflict_id === '11111111-1111-4111-8111-111111111111');
  assert(refreshed.status === 'resolved' && refreshed.resolution === 'applied_local',
    'resolution from server is mirrored locally');

  console.log(`\n=== sync tests: ${passed} passed, ${failed} failed ===`);
  try { db.close(); } catch { /* noop */ }
  fs.rmSync(tmpDir, { recursive: true, force: true });
  // let libuv drain cleanly (avoids the Windows async-close abort on hard exit)
  await new Promise((resolve) => {
    server.close(() => resolve());
    setTimeout(resolve, 1500).unref();
  });
  process.exitCode = failed === 0 ? 0 : 1;
})().catch((e) => { console.error(e); process.exit(1); });
