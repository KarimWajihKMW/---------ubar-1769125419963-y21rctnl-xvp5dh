#!/usr/bin/env node

const { spawn, spawnSync } = require('node:child_process');
const { createHmac } = require('node:crypto');
const billingWebhookSecret = process.env.BILLING_WEBHOOK_SECRET || 'billing-webhook-dev-secret';
const paymentWebhookSecret = process.env.PAYMENT_WEBHOOK_SECRET || 'payment-webhook-dev-secret';

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

async function fetchJsonWithTimeout(url, options = {}, timeoutMs = 4000, retries = 2) {
  let lastError = null;

  for (let attempt = 0; attempt <= retries; attempt++) {
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(url, { ...options, signal: controller.signal });
      const data = await res.json().catch(() => ({}));

      if (res.status >= 500 && attempt < retries) {
        await sleep(200 + (attempt * 150));
        continue;
      }

      return { res, data };
    } catch (error) {
      lastError = error;
      if (attempt < retries) {
        await sleep(200 + (attempt * 150));
        continue;
      }
      throw error;
    } finally {
      clearTimeout(t);
    }
  }

  throw lastError || new Error('request_failed');
}

function start(cmd, args, env = {}) {
  return spawn(cmd, args, {
    stdio: 'ignore',
    env: { ...process.env, ...env }
  });
}

function freePort(port) {
  spawnSync('bash', ['-lc', `lsof -ti tcp:${port} | xargs -r kill -9`], {
    stdio: 'ignore'
  });
}

const memoryModeEnv = { DATABASE_URL: '' };

async function main() {
  for (const port of [4101, 4102, 4103, 4104, 4105, 4106, 8080]) {
    freePort(port);
  }

  const trips = start(process.execPath, ['services/trips-service/server.js'], memoryModeEnv);
  const payments = start(process.execPath, ['services/payments-service/server.js'], memoryModeEnv);
  const ops = start(process.execPath, ['services/ops-service/server.js'], memoryModeEnv);
  const ai = start(process.execPath, ['services/ai-service/server.js'], memoryModeEnv);
  const saas = start(process.execPath, ['services/saas-service/server.js'], memoryModeEnv);
  const events = start(process.execPath, ['services/events-service/server.js'], memoryModeEnv);
  const gateway = start(process.execPath, ['gateway/server.js'], {
    GATEWAY_PORT: '8080',
    TRIPS_SERVICE_URL: 'http://localhost:4101',
    PAYMENTS_SERVICE_URL: 'http://localhost:4102',
    OPS_SERVICE_URL: 'http://localhost:4103',
    AI_SERVICE_URL: 'http://localhost:4104',
    SAAS_SERVICE_URL: 'http://localhost:4105',
    EVENTS_SERVICE_URL: 'http://localhost:4106',
    MONOLITH_URL: 'http://localhost:3000'
  });

  try {
    const okTrips = await waitFor('http://localhost:4101/api/trips-service/health');
    const okPayments = await waitFor('http://localhost:4102/api/payments-service/health');
    const okGateway = await waitFor('http://localhost:8080/health');
    const okOps = await waitFor('http://localhost:4103/api/ops-service/health');
    const okAi = await waitFor('http://localhost:4104/api/ai-service/health');
    const okSaas = await waitFor('http://localhost:4105/api/saas-service/health');
    const okEvents = await waitFor('http://localhost:4106/api/events-service/health');

    if (!okTrips || !okPayments || !okGateway || !okOps || !okAi || !okSaas || !okEvents) {
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

    const providerStatusResp = await fetchJsonWithTimeout('http://localhost:8080/api/ms/payments/provider/status');
    if (!providerStatusResp.res.ok || !providerStatusResp.data?.success || !providerStatusResp.data?.data?.provider) {
      throw new Error('payments_provider_status_failed');
    }

    const onlineIntentResp = await fetchJsonWithTimeout('http://localhost:8080/api/ms/payments/online/intent', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-tenant-id': 'demo-tenant'
      },
      body: JSON.stringify({
        user_id: 'rider-99',
        trip_id: 'trip-700',
        amount: 61.04,
        currency: 'SAR',
        source: 'integration_test'
      })
    });
    if (!onlineIntentResp.res.ok || !onlineIntentResp.data?.success || !onlineIntentResp.data?.data?.id) {
      throw new Error('payments_online_intent_failed');
    }

    const onlineCheckoutResp = await fetchJsonWithTimeout('http://localhost:8080/api/ms/payments/online/checkout/session', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-tenant-id': 'demo-tenant'
      },
      body: JSON.stringify({
        payment_id: String(onlineIntentResp.data.data.id)
      })
    });
    if (!onlineCheckoutResp.res.ok || !onlineCheckoutResp.data?.success || !onlineCheckoutResp.data?.data?.checkout_id) {
      throw new Error('payments_online_checkout_failed');
    }

    const paymentWebhookPayload = {
      provider: 'mockpay',
      event_type: 'payment.paid',
      tenant_id: 'demo-tenant',
      payment_id: String(onlineIntentResp.data.data.id),
      provider_reference: `pay_ref_${Date.now()}`
    };
    const paymentWebhookSignatureFixed = createHmac('sha256', paymentWebhookSecret)
      .update(JSON.stringify(paymentWebhookPayload))
      .digest('hex');

    const paymentWebhookResp = await fetchJsonWithTimeout('http://localhost:8080/api/ms/payments/online/webhooks/provider', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-payment-signature': paymentWebhookSignatureFixed
      },
      body: JSON.stringify(paymentWebhookPayload)
    });
    if (!paymentWebhookResp.res.ok || !paymentWebhookResp.data?.success || paymentWebhookResp.data?.data?.payment?.status !== 'paid') {
      throw new Error('payments_online_webhook_failed');
    }

    const paymentReconciliationSummary = await fetchJsonWithTimeout('http://localhost:8080/api/ms/payments/online/reconciliation/summary');
    if (!paymentReconciliationSummary.res.ok || !paymentReconciliationSummary.data?.success || typeof paymentReconciliationSummary.data?.data?.pending_count !== 'number') {
      throw new Error('payments_online_reconciliation_summary_failed');
    }

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

    let manualAssignResp;
    for (let i = 0; i < 3; i++) {
      manualAssignResp = await fetchJsonWithTimeout('http://localhost:8080/api/ms/ops/dispatch/manual-assign', {
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
      if (manualAssignResp.res.ok && manualAssignResp.data?.success) break;
      await sleep(200 + (i * 150));
    }
    if (!manualAssignResp.res.ok || !manualAssignResp.data?.success) {
      throw new Error('ops_manual_assign_failed');
    }

    let ticketResp;
    for (let i = 0; i < 3; i++) {
      ticketResp = await fetchJsonWithTimeout('http://localhost:8080/api/ms/ops/support/tickets', {
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
      if (ticketResp.res.ok && ticketResp.data?.success) break;
      await sleep(200 + (i * 150));
    }
    if (!ticketResp.res.ok || !ticketResp.data?.success || !ticketResp.data?.data?.id) {
      throw new Error('ops_ticket_create_failed');
    }

    const escalationResp = await fetchJsonWithTimeout(`http://localhost:8080/api/ms/ops/support/tickets/${ticketResp.data.data.id}/escalate`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-tenant-id': 'demo-tenant',
        'x-role': 'support'
      },
      body: JSON.stringify({
        level: 'critical',
        reason: 'multiple customer complaints and safety concern'
      })
    });
    if (!escalationResp.res.ok || !escalationResp.data?.success || escalationResp.data?.data?.ticket?.status !== 'escalated') {
      throw new Error('ops_ticket_escalation_failed');
    }

    const escalationListResp = await fetchJsonWithTimeout('http://localhost:8080/api/ms/ops/support/escalations?limit=5', {
      headers: {
        'x-tenant-id': 'demo-tenant',
        'x-role': 'support'
      }
    });
    if (!escalationListResp.res.ok || !escalationListResp.data?.success || !Array.isArray(escalationListResp.data?.data) || !escalationListResp.data.data.length) {
      throw new Error('ops_escalation_list_failed');
    }

    const slaBreachesResp = await fetchJsonWithTimeout('http://localhost:8080/api/ms/ops/support/sla/breaches?limit=5&max_open_minutes=0', {
      headers: {
        'x-tenant-id': 'demo-tenant',
        'x-role': 'support'
      }
    });
    if (!slaBreachesResp.res.ok || !slaBreachesResp.data?.success || !Array.isArray(slaBreachesResp.data?.data?.tickets) || !slaBreachesResp.data.data.tickets.length) {
      throw new Error('ops_sla_breaches_failed');
    }

    const supportKpisResp = await fetchJsonWithTimeout('http://localhost:8080/api/ms/ops/support/kpis?window_minutes=1440', {
      headers: {
        'x-tenant-id': 'demo-tenant',
        'x-role': 'support'
      }
    });
    if (!supportKpisResp.res.ok || !supportKpisResp.data?.success || supportKpisResp.data?.data?.escalated_tickets < 1 || supportKpisResp.data?.data?.total_tickets < 1) {
      throw new Error('ops_support_kpis_failed');
    }

    const supportAlertsResp = await fetchJsonWithTimeout('http://localhost:8080/api/ms/ops/support/alerts?max_open_minutes=0&breach_threshold=1&escalation_threshold=1&critical_threshold=1&window_minutes=1440', {
      headers: {
        'x-tenant-id': 'demo-tenant',
        'x-role': 'support'
      }
    });
    if (!supportAlertsResp.res.ok || !supportAlertsResp.data?.success || !Array.isArray(supportAlertsResp.data?.data?.alerts) || !supportAlertsResp.data.data.alerts.length) {
      throw new Error('ops_support_alerts_failed');
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

    const publishResp = await fetchJsonWithTimeout('http://localhost:8080/api/ms/events/publish', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-tenant-id': 'demo-tenant',
        'x-role': 'service'
      },
      body: JSON.stringify({
        topic: 'trip.lifecycle',
        event_type: 'trip.completed',
        producer: 'trips-service',
        payload: { trip_id: 'trip-700', driver_id: 'driver-9' }
      })
    });
    if (!publishResp.res.ok || !publishResp.data?.success || !publishResp.data?.data?.id) {
      throw new Error('events_publish_failed');
    }

    const listEventsResp = await fetchJsonWithTimeout('http://localhost:8080/api/ms/events/events?topic=trip.lifecycle&since_id=0&limit=10', {
      headers: {
        'x-tenant-id': 'demo-tenant',
        'x-role': 'dispatcher'
      }
    });
    if (!listEventsResp.res.ok || !listEventsResp.data?.success || !Array.isArray(listEventsResp.data?.data) || !listEventsResp.data.data.length) {
      throw new Error('events_list_failed');
    }

    const tenantResp = await fetchJsonWithTimeout('http://localhost:8080/api/ms/saas/tenants', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-role': 'super-admin'
      },
      body: JSON.stringify({
        tenant_id: 'demo-tenant',
        name: 'Demo Tenant',
        region: 'eg-cairo-1',
        branding: { primary: '#115e59', logo: 'demo.svg' }
      })
    });
    if (!tenantResp.res.ok || !tenantResp.data?.success) {
      throw new Error('saas_tenant_create_failed');
    }

    const subResp = await fetchJsonWithTimeout('http://localhost:8080/api/ms/saas/subscriptions/activate', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-role': 'admin'
      },
      body: JSON.stringify({
        tenant_id: 'demo-tenant',
        plan_code: 'growth',
        metadata: { contract: 'annual' }
      })
    });
    if (!subResp.res.ok || !subResp.data?.success) {
      throw new Error('saas_subscription_activate_failed');
    }

    const usageResp = await fetchJsonWithTimeout('http://localhost:8080/api/ms/saas/usage/record', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-role': 'system'
      },
      body: JSON.stringify({
        tenant_id: 'demo-tenant',
        metric: 'rides',
        quantity: 1200,
        metadata: { source: 'integration_test' }
      })
    });
    if (!usageResp.res.ok || !usageResp.data?.success) {
      throw new Error('saas_usage_record_failed');
    }

    const billingResp = await fetchJsonWithTimeout('http://localhost:8080/api/ms/saas/billing/preview/demo-tenant', {
      headers: {
        'x-role': 'admin'
      }
    });
    if (!billingResp.res.ok || !billingResp.data?.success || !billingResp.data?.data?.charges?.total) {
      throw new Error('saas_billing_preview_failed');
    }

    const issueInvoiceResp = await fetchJsonWithTimeout('http://localhost:8080/api/ms/saas/billing/invoices/issue', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-role': 'admin'
      },
      body: JSON.stringify({
        tenant_id: 'demo-tenant',
        source: 'integration_test'
      })
    });
    if (!issueInvoiceResp.res.ok || !issueInvoiceResp.data?.success || !issueInvoiceResp.data?.data?.id) {
      throw new Error('saas_invoice_issue_failed');
    }

    const checkoutResp = await fetchJsonWithTimeout('http://localhost:8080/api/ms/saas/billing/checkout/session', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-role': 'admin'
      },
      body: JSON.stringify({
        invoice_id: String(issueInvoiceResp.data.data.id)
      })
    });
    if (!checkoutResp.res.ok || !checkoutResp.data?.success || !checkoutResp.data?.data?.checkout_id) {
      throw new Error('saas_checkout_session_failed');
    }

    const webhookPayload = {
      provider: 'mockpay',
      event_type: 'invoice.paid',
      tenant_id: 'demo-tenant',
      invoice_id: String(issueInvoiceResp.data.data.id),
      provider_reference: `paid_ref_${Date.now()}`
    };
    const webhookSignature = createHmac('sha256', billingWebhookSecret)
      .update(JSON.stringify(webhookPayload))
      .digest('hex');

    const webhookResp = await fetchJsonWithTimeout('http://localhost:8080/api/ms/saas/billing/webhooks/provider', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-billing-signature': webhookSignature
      },
      body: JSON.stringify(webhookPayload)
    });
    if (!webhookResp.res.ok || !webhookResp.data?.success || webhookResp.data?.data?.invoice?.status !== 'paid') {
      throw new Error('saas_webhook_payment_failed');
    }

    const reconciliationResp = await fetchJsonWithTimeout('http://localhost:8080/api/ms/saas/billing/reconciliation/summary', {
      headers: {
        'x-role': 'admin'
      }
    });
    if (!reconciliationResp.res.ok || !reconciliationResp.data?.success || typeof reconciliationResp.data?.data?.pending_count !== 'number') {
      throw new Error('saas_reconciliation_summary_failed');
    }

    console.log('✅ Gateway test passed', {
      match_strategy: rec.data.strategy,
      assigned_driver: assignResp.data.data.selected_driver.driver_id,
      fare_total: fare.data.total,
      payment_provider: providerStatusResp.data.data.provider,
      payment_checkout_provider: onlineCheckoutResp.data.data.provider,
      wallet_balance_after_withdrawal: withdrawalResp.data.data.user_id ? 'ok' : 'unknown',
      ops_ticket_id: ticketResp.data.data.id,
      ops_escalation_status: escalationResp.data.data.ticket.status,
      ops_sla_breach_count: slaBreachesResp.data.data.breach_count,
      ops_escalated_tickets: supportKpisResp.data.data.escalated_tickets,
      ops_alerts_count: supportAlertsResp.data.data.alerts.length,
      ai_fraud_score: fraudScoreResp.data.data.fraud_score,
      ai_surge: pricingResp.data.data.surge_multiplier,
      saas_plan: subResp.data.data.plan_code,
      saas_billing_total: billingResp.data.data.charges.total,
      events_count: listEventsResp.data.data.length,
      invoice_status_after_webhook: webhookResp.data.data.invoice.status,
      checkout_provider: checkoutResp.data.data.provider,
      pending_reconciliation: reconciliationResp.data.data.pending_count
    });
  } finally {
    for (const p of [gateway, trips, payments, ops, ai, saas, events]) {
      try { p.kill('SIGTERM'); } catch (_) {}
    }
  }
}

main().catch((err) => {
  console.error('❌ Gateway test failed:', err.message);
  process.exit(1);
});
