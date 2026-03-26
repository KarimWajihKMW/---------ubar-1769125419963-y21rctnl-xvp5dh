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
  const ops = start(process.execPath, ['services/ops-service/server.js']);
  const ai = start(process.execPath, ['services/ai-service/server.js']);
  const gateway = start(process.execPath, ['gateway/server.js'], {
    GATEWAY_PORT: '8080',
    TRIPS_SERVICE_URL: 'http://localhost:4101',
    PAYMENTS_SERVICE_URL: 'http://localhost:4102',
    OPS_SERVICE_URL: 'http://localhost:4103',
    AI_SERVICE_URL: 'http://localhost:4104',
    MONOLITH_URL: 'http://localhost:3000'
  });

  try {
    const okTrips = await waitFor('http://localhost:4101/api/trips-service/health');
    const okPayments = await waitFor('http://localhost:4102/api/payments-service/health');
    const okGateway = await waitFor('http://localhost:8080/health');
    const okOps = await waitFor('http://localhost:4103/api/ops-service/health');
    const okAi = await waitFor('http://localhost:4104/api/ai-service/health');

    if (!okTrips || !okPayments || !okGateway || !okOps || !okAi) {
      throw new Error('services_not_ready');
    }

    const recResp = await fetchJsonWithTimeout('http://localhost:8080/api/ms/trips/match/recommendation?demand=0.8&supply=0.5');
    const rec = recResp.data;
    if (!recResp.res.ok || !rec?.success) throw new Error('gateway_trips_proxy_failed');

    const assignResp = await fetchJsonWithTimeout('http://localhost:8080/api/ms/trips/match/assign', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-tenant-id': 'demo-tenant'
      },
      body: JSON.stringify({
        ride: { ride_id: 'ride-101' },
        demand: 0.9,
        surge_multiplier: 1.5,
        drivers: [
          { driver_id: 'd1', distance_km: 2.1, rating: 4.8, acceptance_rate: 0.94, cancellation_rate: 0.04, eta_min: 6 },
          { driver_id: 'd2', distance_km: 0.9, rating: 4.3, acceptance_rate: 0.88, cancellation_rate: 0.09, eta_min: 4 }
        ]
      })
    });
    if (!assignResp.res.ok || !assignResp.data?.success || !assignResp.data?.data?.selected_driver?.driver_id) {
      throw new Error('gateway_trips_assignment_failed');
    }

    const lifecycleResp = await fetchJsonWithTimeout('http://localhost:8080/api/ms/trips/lifecycle/advance', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-tenant-id': 'demo-tenant'
      },
      body: JSON.stringify({
        trip_id: 'trip-700',
        current_state: 'started',
        action: 'complete_trip'
      })
    });
    if (!lifecycleResp.res.ok || lifecycleResp.data?.data?.next_state !== 'completed') {
      throw new Error('gateway_trips_lifecycle_advance_failed');
    }

    const fareResp = await fetchJsonWithTimeout('http://localhost:8080/api/ms/payments/fare/calculate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ distance_km: 12, duration_min: 25, surge_multiplier: 1.4 })
    });
    const fare = fareResp.data;
    if (!fareResp.res.ok || !fare?.success || !fare?.data?.total) throw new Error('gateway_payments_proxy_failed');

    const topupResp = await fetchJsonWithTimeout('http://localhost:8080/api/ms/payments/wallet/topup', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-tenant-id': 'demo-tenant'
      },
      body: JSON.stringify({
        user_id: 'driver-1',
        role: 'driver',
        amount: 100,
        source: 'test'
      })
    });
    if (!topupResp.res.ok || !topupResp.data?.success) throw new Error('wallet_topup_failed');

    const withdrawalResp = await fetchJsonWithTimeout('http://localhost:8080/api/ms/payments/wallet/withdrawals/request', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-tenant-id': 'demo-tenant'
      },
      body: JSON.stringify({
        user_id: 'driver-1',
        amount: 30,
        method: 'bank_transfer'
      })
    });
    if (!withdrawalResp.res.ok || withdrawalResp.data?.data?.status !== 'pending') {
      throw new Error('wallet_withdrawal_request_failed');
    }

    const manualAssignResp = await fetchJsonWithTimeout('http://localhost:8080/api/ms/ops/dispatch/manual-assign', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-tenant-id': 'demo-tenant',
        'x-role': 'dispatcher'
      },
      body: JSON.stringify({
        trip_id: 'trip-900',
        driver_id: 'driver-9',
        reason: 'vip_reassignment'
      })
    });
    if (!manualAssignResp.res.ok || !manualAssignResp.data?.success) {
      throw new Error('ops_manual_assign_failed');
    }

    const ticketResp = await fetchJsonWithTimeout('http://localhost:8080/api/ms/ops/support/tickets', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-tenant-id': 'demo-tenant',
        'x-role': 'support'
      },
      body: JSON.stringify({
        rider_id: 'rider-1',
        category: 'trip_issue',
        priority: 'high',
        summary: 'Driver took wrong route and ride was delayed',
        details: 'Customer requesting partial refund'
      })
    });
    if (!ticketResp.res.ok || !ticketResp.data?.success || !ticketResp.data?.data?.id) {
      throw new Error('ops_ticket_create_failed');
    }

    const fraudScoreResp = await fetchJsonWithTimeout('http://localhost:8080/api/ms/ai/fraud/score', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-tenant-id': 'demo-tenant'
      },
      body: JSON.stringify({
        account_age_days: 10,
        cancellation_rate: 0.5,
        payment_failures: 2,
        rapid_requests_last_hour: 3
      })
    });
    if (!fraudScoreResp.res.ok || !fraudScoreResp.data?.success || typeof fraudScoreResp.data?.data?.fraud_score !== 'number') {
      throw new Error('ai_fraud_score_failed');
    }

    const pricingResp = await fetchJsonWithTimeout('http://localhost:8080/api/ms/ai/pricing/recommendation', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-tenant-id': 'demo-tenant'
      },
      body: JSON.stringify({
        demand_index: 1.8,
        supply_index: 1.2,
        weather_risk: 0.3
      })
    });
    if (!pricingResp.res.ok || !pricingResp.data?.success || !pricingResp.data?.data?.surge_multiplier) {
      throw new Error('ai_pricing_recommendation_failed');
    }

    console.log('✅ Gateway test passed', {
      match_strategy: rec.data.strategy,
      assigned_driver: assignResp.data.data.selected_driver.driver_id,
      fare_total: fare.data.total,
      wallet_balance_after_withdrawal: withdrawalResp.data.data.user_id ? 'ok' : 'unknown',
      ops_ticket_id: ticketResp.data.data.id,
      ai_fraud_score: fraudScoreResp.data.data.fraud_score,
      ai_surge: pricingResp.data.data.surge_multiplier
    });
  } finally {
    for (const p of [gateway, trips, payments, ops, ai]) {
      try { p.kill('SIGTERM'); } catch (_) {}
    }
  }
}

main().catch((err) => {
  console.error('❌ Gateway test failed:', err.message);
  process.exit(1);
});
