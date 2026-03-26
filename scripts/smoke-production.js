#!/usr/bin/env node

function requiredEnv(name) {
  const value = String(process.env[name] || '').trim();
  if (!value) {
    throw new Error(`Missing required env: ${name}`);
  }
  return value;
}

function mask(value) {
  if (!value) return '(missing)';
  const str = String(value);
  if (str.length <= 6) return '***';
  return `${str.slice(0, 2)}***${str.slice(-2)}`;
}

async function fetchJsonWithTimeout(url, options = {}, timeoutMs = 5000) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...options, signal: controller.signal });
    const data = await res.json().catch(() => ({}));
    return { res, data };
  } finally {
    clearTimeout(timeout);
  }
}

async function check(name, fn, issues) {
  try {
    await fn();
    console.log(`OK ${name}`);
  } catch (error) {
    issues.push(`${name}: ${error.message}`);
  }
}

async function main() {
  const issues = [];

  const gatewayBaseUrl = requiredEnv('GATEWAY_BASE_URL').replace(/\/$/, '');
  const tenantId = String(process.env.SMOKE_TENANT_ID || process.env.DEFAULT_TENANT_ID || 'public').trim() || 'public';
  const smokeRole = String(process.env.SMOKE_ROLE || 'support').trim().toLowerCase();

  console.log('Production smoke summary');
  console.log(`GATEWAY_BASE_URL=${gatewayBaseUrl}`);
  console.log(`SMOKE_TENANT_ID=${tenantId}`);
  console.log(`SMOKE_ROLE=${smokeRole}`);
  console.log(`METRICS_TOKEN=${mask(process.env.METRICS_TOKEN)}`);

  await check('gateway_health', async () => {
    const { res, data } = await fetchJsonWithTimeout(`${gatewayBaseUrl}/health`);
    if (!res.ok || !data?.success) throw new Error(`status=${res.status}`);
  }, issues);

  await check('trips_health', async () => {
    const { res, data } = await fetchJsonWithTimeout(`${gatewayBaseUrl}/api/ms/trips/health`);
    if (!res.ok || !data?.success) throw new Error(`status=${res.status}`);
  }, issues);

  await check('payments_health', async () => {
    const { res, data } = await fetchJsonWithTimeout(`${gatewayBaseUrl}/api/ms/payments/health`);
    if (!res.ok || !data?.success) throw new Error(`status=${res.status}`);
  }, issues);

  await check('ops_health', async () => {
    const { res, data } = await fetchJsonWithTimeout(`${gatewayBaseUrl}/api/ms/ops/health`);
    if (!res.ok || !data?.success) throw new Error(`status=${res.status}`);
  }, issues);

  await check('ai_health', async () => {
    const { res, data } = await fetchJsonWithTimeout(`${gatewayBaseUrl}/api/ms/ai/health`);
    if (!res.ok || !data?.success) throw new Error(`status=${res.status}`);
  }, issues);

  await check('saas_health', async () => {
    const { res, data } = await fetchJsonWithTimeout(`${gatewayBaseUrl}/api/ms/saas/health`);
    if (!res.ok || !data?.success) throw new Error(`status=${res.status}`);
  }, issues);

  await check('events_health', async () => {
    const { res, data } = await fetchJsonWithTimeout(`${gatewayBaseUrl}/api/ms/events/health`);
    if (!res.ok || !data?.success) throw new Error(`status=${res.status}`);
  }, issues);

  await check('payments_provider_status', async () => {
    const { res, data } = await fetchJsonWithTimeout(`${gatewayBaseUrl}/api/ms/payments/provider/status`, {
      headers: {
        'x-tenant-id': tenantId
      }
    });
    if (!res.ok || !data?.success || !data?.data?.provider) throw new Error(`status=${res.status}`);
  }, issues);

  await check('saas_plans', async () => {
    const { res, data } = await fetchJsonWithTimeout(`${gatewayBaseUrl}/api/ms/saas/plans`, {
      headers: {
        'x-role': 'admin',
        'x-tenant-id': tenantId
      }
    });
    if (!res.ok || !data?.success || !Array.isArray(data?.data) || data.data.length < 1) {
      throw new Error(`status=${res.status}`);
    }
  }, issues);

  await check('ops_support_kpis', async () => {
    const { res, data } = await fetchJsonWithTimeout(`${gatewayBaseUrl}/api/ms/ops/support/kpis?window_minutes=60`, {
      headers: {
        'x-role': smokeRole,
        'x-tenant-id': tenantId
      }
    });
    if (!res.ok || !data?.success || typeof data?.data?.total_tickets !== 'number') {
      throw new Error(`status=${res.status}`);
    }
  }, issues);

  if (issues.length) {
    console.error('\nProduction smoke failed:');
    for (const issue of issues) console.error(`- ${issue}`);
    process.exit(1);
  }

  console.log('\nProduction smoke passed.');
}

main().catch((error) => {
  console.error(`Production smoke crashed: ${error.message}`);
  process.exit(1);
});
