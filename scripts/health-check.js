#!/usr/bin/env node
/* QAVENO — Production Health Check
   Usage: node scripts/health-check.js [api-url]
   Exit 0 = healthy, Exit 1 = unhealthy */

'use strict';

const API_URL = process.argv[2] || process.env.QAVENO_API_URL || 'http://localhost:3000';

async function checkHealth() {
  const checks = [];
  const start = Date.now();

  // 1. Health endpoint
  try {
    const res = await fetch(`${API_URL}/health`);
    const data = await res.json();
    checks.push({ name: 'health', status: res.ok ? 'ok' : 'fail', data });
  } catch (err) {
    checks.push({ name: 'health', status: 'fail', error: err.message });
  }

  // 2. API root
  try {
    const res = await fetch(`${API_URL}/api/v1/owner/usage`, {
      method: 'GET',
      headers: { 'Content-Type': 'application/json' },
    });
    checks.push({ name: 'api', status: res.status === 401 ? 'ok' : 'warn', httpStatus: res.status });
  } catch (err) {
    checks.push({ name: 'api', status: 'fail', error: err.message });
  }

  // 3. Trial endpoint
  try {
    const res = await fetch(`${API_URL}/api/v1/owner/trial/validate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ organizationId: 99999, deviceFingerprint: 'healthcheck' }),
    });
    checks.push({ name: 'trial-api', status: res.ok ? 'ok' : 'warn', httpStatus: res.status });
  } catch (err) {
    checks.push({ name: 'trial-api', status: 'fail', error: err.message });
  }

  const duration = Date.now() - start;
  const allOk = checks.every(c => c.status === 'ok');
  const result = {
    status: allOk ? 'healthy' : 'unhealthy',
    duration: `${duration}ms`,
    timestamp: new Date().toISOString(),
    checks,
  };

  console.log(JSON.stringify(result, null, 2));
  process.exit(allOk ? 0 : 1);
}

checkHealth().catch(() => process.exit(1));
