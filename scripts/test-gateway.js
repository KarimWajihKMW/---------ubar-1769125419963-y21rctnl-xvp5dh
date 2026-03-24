#!/usr/bin/env node

const { spawn } = require('node:child_process');

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(url, tries = 40) {
  for (let i = 0; i < tries; i++) {
    try {
      const controller = new AbortController();
      const t = setTimeout(() => controller.abort(), 800);
      const res = await fetch(url, { signal: controller.signal });
      clearTimeout(t);
      if (res.ok) return true;
    } catch (_) {
      // ignore
    }
    await sleep(250);
  }
  return false;
}

async function fetchJsonWithTimeout(url, options = {}, timeoutMs = 2000) {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...options, signal: controller.signal });
    const data = await res.json().catch(() => ({}));
    return { res, data };
  } finally {
    clearTimeout(t);
  }
}

function start(cmd, args, env = {}) {
  return spawn(cmd, args, {
    stdio: 'ignore',
    env: { ...process.env, ...env }
  });
}

async function main() {
  const trips = start(process.execPath, ['services/trips-service/server.js']);
  const payments = start(process.execPath, ['services/payments-service/server.js']);
  const gateway = start(process.execPath, ['gateway/server.js'], {
    GATEWAY_PORT: '8080',
    TRIPS_SERVICE_URL: 'http://localhost:4101',
    PAYMENTS_SERVICE_URL: 'http://localhost:4102',
    MONOLITH_URL: 'http://localhost:3000'
  });

  try {
    const okTrips = await waitFor('http://localhost:4101/api/trips-service/health');
    const okPayments = await waitFor('http://localhost:4102/api/payments-service/health');
    const okGateway = await waitFor('http://localhost:8080/health');

    if (!okTrips || !okPayments || !okGateway) {
      throw new Error('services_not_ready');
    }

    const recResp = await fetchJsonWithTimeout('http://localhost:8080/api/ms/trips/match/recommendation?demand=0.8&supply=0.5');
    const rec = recResp.data;
    if (!recResp.res.ok || !rec?.success) throw new Error('gateway_trips_proxy_failed');

    const fareResp = await fetchJsonWithTimeout('http://localhost:8080/api/ms/payments/fare/calculate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ distance_km: 12, duration_min: 25, surge_multiplier: 1.4 })
    });
    const fare = fareResp.data;
    if (!fareResp.res.ok || !fare?.success || !fare?.data?.total) throw new Error('gateway_payments_proxy_failed');

    console.log('✅ Gateway test passed', {
      match_strategy: rec.data.strategy,
      fare_total: fare.data.total
    });
  } finally {
    for (const p of [gateway, trips, payments]) {
      try { p.kill('SIGTERM'); } catch (_) {}
    }
  }
}

main().catch((err) => {
  console.error('❌ Gateway test failed:', err.message);
  process.exit(1);
});
