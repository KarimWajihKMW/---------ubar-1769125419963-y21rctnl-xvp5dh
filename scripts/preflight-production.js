#!/usr/bin/env node

function mask(value) {
  if (!value) return '(missing)';
  const str = String(value);
  if (str.length <= 6) return '***';
  return `${str.slice(0, 2)}***${str.slice(-2)}`;
}

function requireEnv(name, issues) {
  const value = process.env[name];
  if (!value || !String(value).trim()) {
    issues.push(`Missing required env: ${name}`);
    return null;
  }
  return String(value).trim();
}

async function healthCheck(url, issues) {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 2500);
    const res = await fetch(url, { signal: controller.signal });
    clearTimeout(timeout);
    if (!res.ok) {
      issues.push(`Health check failed: ${url} status=${res.status}`);
      return;
    }
    console.log(`OK health: ${url}`);
  } catch (error) {
    issues.push(`Health check error: ${url} (${error.message})`);
  }
}

async function main() {
  const issues = [];

  const nodeEnv = process.env.NODE_ENV || 'production';
  const gatewayBaseUrl = process.env.GATEWAY_BASE_URL || '';
  const billingProvider = (process.env.BILLING_PROVIDER || 'mockpay').toLowerCase();
  const paymentProvider = (process.env.PAYMENT_PROVIDER || 'mockpay').toLowerCase();

  console.log('Preflight summary');
  console.log(`NODE_ENV=${nodeEnv}`);
  console.log(`BILLING_PROVIDER=${billingProvider}`);
  console.log(`PAYMENT_PROVIDER=${paymentProvider}`);

  requireEnv('DATABASE_URL', issues);
  requireEnv('JWT_SECRET', issues);
  requireEnv('METRICS_TOKEN', issues);
  requireEnv('BILLING_WEBHOOK_SECRET', issues);
  requireEnv('PAYMENT_WEBHOOK_SECRET', issues);

  if (billingProvider === 'stripe') {
    requireEnv('STRIPE_SECRET_KEY', issues);
    requireEnv('STRIPE_WEBHOOK_SECRET', issues);
    requireEnv('STRIPE_SUCCESS_URL', issues);
    requireEnv('STRIPE_CANCEL_URL', issues);
  }

  if (paymentProvider === 'stripe') {
    requireEnv('STRIPE_SECRET_KEY', issues);
    requireEnv('STRIPE_WEBHOOK_SECRET', issues);
  }

  if (gatewayBaseUrl) {
    const base = gatewayBaseUrl.replace(/\/$/, '');
    await healthCheck(`${base}/health`, issues);
    await healthCheck(`${base}/api/ms/trips/health`, issues);
    await healthCheck(`${base}/api/ms/payments/health`, issues);
    await healthCheck(`${base}/api/ms/ops/health`, issues);
    await healthCheck(`${base}/api/ms/ai/health`, issues);
    await healthCheck(`${base}/api/ms/saas/health`, issues);
    await healthCheck(`${base}/api/ms/events/health`, issues);
  } else {
    console.log('Skipped endpoint checks (set GATEWAY_BASE_URL to enable).');
  }

  console.log('Sensitive env preview');
  console.log(`DATABASE_URL=${mask(process.env.DATABASE_URL)}`);
  console.log(`JWT_SECRET=${mask(process.env.JWT_SECRET)}`);
  console.log(`METRICS_TOKEN=${mask(process.env.METRICS_TOKEN)}`);

  if (issues.length > 0) {
    console.error('\nPreflight failed with issues:');
    issues.forEach((x) => console.error(`- ${x}`));
    process.exit(1);
  }

  console.log('\nPreflight passed: production baseline is ready.');
}

main().catch((error) => {
  console.error(`Preflight crashed: ${error.message}`);
  process.exit(1);
});
