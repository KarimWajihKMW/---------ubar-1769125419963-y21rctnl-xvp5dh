const express = require('express');
const promClient = require('prom-client');
const { Pool } = require('pg');
const { createHmac, timingSafeEqual } = require('crypto');
const cron = require('node-cron');
const { createBillingProvider } = require('./provider-adapter');

const app = express();
const PORT = Number(process.env.SAAS_SERVICE_PORT || 4105);
const useDatabase = Boolean(process.env.DATABASE_URL);
const pool = useDatabase ? new Pool({ connectionString: process.env.DATABASE_URL }) : null;
const billingWebhookSecret = process.env.BILLING_WEBHOOK_SECRET || 'billing-webhook-dev-secret';
const billingProviderName = process.env.BILLING_PROVIDER || 'mockpay';
const mockCheckoutBaseUrl = process.env.MOCKPAY_CHECKOUT_BASE_URL || 'https://mockpay.local';
const stripeSecretKey = process.env.STRIPE_SECRET_KEY || '';
const stripeWebhookSecret = process.env.STRIPE_WEBHOOK_SECRET || '';
const stripeSuccessUrl = process.env.STRIPE_SUCCESS_URL || 'https://example.com/billing/success';
const stripeCancelUrl = process.env.STRIPE_CANCEL_URL || 'https://example.com/billing/cancel';
const autoCycleEnabled = String(process.env.SAAS_BILLING_AUTOCYCLE_ENABLED || 'false').toLowerCase() === 'true';
const autoCycleSchedule = process.env.SAAS_BILLING_AUTOCYCLE_CRON || '0 1 * * *';
const reconciliationEnabled = String(process.env.SAAS_RECONCILIATION_ENABLED || 'false').toLowerCase() === 'true';
const reconciliationSchedule = process.env.SAAS_RECONCILIATION_CRON || '*/30 * * * *';

const billingProvider = createBillingProvider({
    provider: billingProviderName,
    webhookSecret: billingWebhookSecret,
    mockCheckoutBaseUrl,
    stripeSecretKey,
    stripeWebhookSecret,
    stripeSuccessUrl,
    stripeCancelUrl
});

const metricsRegistry = new promClient.Registry();
promClient.collectDefaultMetrics({ register: metricsRegistry, prefix: 'ubar_saas_service_' });
const requestCounter = new promClient.Counter({
    name: 'ubar_saas_service_http_requests_total',
    help: 'Total HTTP requests handled by saas service',
    labelNames: ['method', 'route', 'status_code'],
    registers: [metricsRegistry]
});

app.use(express.json({ limit: '1mb' }));

const memTenants = new Map();
const memSubscriptions = new Map();
const memUsageEvents = [];
const memInvoices = [];
const memWebhookEvents = [];

const plans = {
    starter: { code: 'starter', monthly_price: 199, included_rides: 5000, overage_per_ride: 0.05 },
    growth: { code: 'growth', monthly_price: 599, included_rides: 25000, overage_per_ride: 0.04 },
    enterprise: { code: 'enterprise', monthly_price: 1999, included_rides: 120000, overage_per_ride: 0.03 }
};

function getTenantId(req) {
    const tenantId = String(req.headers['x-tenant-id'] || 'public').trim();
    return tenantId || 'public';
}

function getRole(req) {
    return String(req.headers['x-role'] || 'system').trim().toLowerCase();
}

function requireRole(allowed) {
    const allowedSet = new Set(allowed.map((x) => String(x).toLowerCase()));
    return (req, res, next) => {
        const role = getRole(req);
        if (!allowedSet.has(role)) {
            return res.status(403).json({ success: false, error: 'forbidden', required_roles: Array.from(allowedSet) });
        }
        next();
    };
}

async function ensureSchema() {
    if (!pool) return;

    await pool.query(`
        CREATE TABLE IF NOT EXISTS ms_saas_tenants (
            id BIGSERIAL PRIMARY KEY,
            tenant_id TEXT NOT NULL UNIQUE,
            name TEXT NOT NULL,
            status TEXT NOT NULL DEFAULT 'active',
            region TEXT NOT NULL DEFAULT 'me-central',
            branding JSONB NOT NULL DEFAULT '{}'::jsonb,
            settings JSONB NOT NULL DEFAULT '{}'::jsonb,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
    `);

    await pool.query(`
        CREATE TABLE IF NOT EXISTS ms_saas_subscriptions (
            id BIGSERIAL PRIMARY KEY,
            tenant_id TEXT NOT NULL,
            plan_code TEXT NOT NULL,
            status TEXT NOT NULL DEFAULT 'active',
            started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            renewed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
            UNIQUE (tenant_id)
        )
    `);

    await pool.query(`
        CREATE TABLE IF NOT EXISTS ms_saas_usage_events (
            id BIGSERIAL PRIMARY KEY,
            tenant_id TEXT NOT NULL,
            metric TEXT NOT NULL,
            quantity NUMERIC(14,2) NOT NULL,
            metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
            recorded_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
    `);

    await pool.query(`
        CREATE TABLE IF NOT EXISTS ms_saas_invoices (
            id BIGSERIAL PRIMARY KEY,
            tenant_id TEXT NOT NULL,
            plan_code TEXT NOT NULL,
            billing_period TEXT NOT NULL,
            status TEXT NOT NULL DEFAULT 'pending',
            currency TEXT NOT NULL DEFAULT 'USD',
            base_amount NUMERIC(14,2) NOT NULL,
            overage_amount NUMERIC(14,2) NOT NULL DEFAULT 0,
            total_amount NUMERIC(14,2) NOT NULL,
            provider_reference TEXT,
            details JSONB NOT NULL DEFAULT '{}'::jsonb,
            issued_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            paid_at TIMESTAMPTZ
        )
    `);

    await pool.query(`
        CREATE TABLE IF NOT EXISTS ms_saas_billing_webhook_events (
            id BIGSERIAL PRIMARY KEY,
            tenant_id TEXT,
            provider TEXT NOT NULL,
            event_type TEXT NOT NULL,
            signature_valid BOOLEAN NOT NULL,
            payload JSONB NOT NULL DEFAULT '{}'::jsonb,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
    `);
}

function signWebhookPayload(payload) {
    return billingProvider.signWebhookPayload(payload);
}

function verifyWebhookSignature(payload, signature) {
    if (!signature) return false;
    const expected = signWebhookPayload(payload);
    const a = Buffer.from(String(expected));
    const b = Buffer.from(String(signature));
    if (a.length !== b.length) return false;
    return timingSafeEqual(a, b);
}

app.use((req, res, next) => {
    res.on('finish', () => {
        const route = req.route && req.route.path ? String(req.route.path) : String(req.path || req.url || 'unknown');
        requestCounter.inc({ method: req.method, route, status_code: String(res.statusCode || 0) });
    });
    next();
});

app.get('/api/saas-service/health', (_req, res) => {
    return res.json({ success: true, service: 'saas-service', status: 'ok', database_mode: useDatabase ? 'postgres' : 'memory' });
});

app.get('/metrics', async (_req, res) => {
    res.set('Content-Type', metricsRegistry.contentType);
    res.end(await metricsRegistry.metrics());
});

app.get('/api/saas-service/plans', (_req, res) => {
    return res.json({ success: true, data: Object.values(plans) });
});

app.get('/api/saas-service/billing/provider/status', requireRole(['super-admin', 'admin']), (_req, res) => {
    return res.json({
        success: true,
        data: {
            provider: billingProvider.name,
            meta: billingProvider.meta || { configured: true, mode: 'active' }
        }
    });
});

app.post('/api/saas-service/tenants', requireRole(['super-admin', 'admin']), async (req, res) => {
    try {
        const actorRole = getRole(req);
        const tenantId = String(req.body.tenant_id || '').trim().toLowerCase();
        const name = String(req.body.name || '').trim();
        const region = String(req.body.region || 'me-central').trim();
        const branding = req.body.branding && typeof req.body.branding === 'object' ? req.body.branding : {};

        if (!tenantId || !name) {
            return res.status(400).json({ success: false, error: 'tenant_id_and_name_required' });
        }

        if (pool) {
            const result = await pool.query(
                `INSERT INTO ms_saas_tenants (tenant_id, name, region, branding, settings)
                 VALUES ($1, $2, $3, $4, $5)
                 ON CONFLICT (tenant_id) DO UPDATE SET
                    name = EXCLUDED.name,
                    region = EXCLUDED.region,
                    branding = EXCLUDED.branding,
                    updated_at = NOW()
                 RETURNING id, tenant_id, name, status, region, branding, settings, created_at, updated_at`,
                [tenantId, name, region, branding, { created_by_role: actorRole }]
            );
            return res.json({ success: true, data: result.rows[0] });
        }

        const now = new Date().toISOString();
        const existing = memTenants.get(tenantId);
        const tenant = existing
            ? { ...existing, name, region, branding, updated_at: now }
            : {
                id: `tenant-${Date.now()}`,
                tenant_id: tenantId,
                name,
                status: 'active',
                region,
                branding,
                settings: { created_by_role: actorRole },
                created_at: now,
                updated_at: now
            };

        memTenants.set(tenantId, tenant);
        return res.json({ success: true, data: tenant });
    } catch (error) {
        return res.status(500).json({ success: false, error: 'tenant_upsert_failed', message: error.message });
    }
});

app.get('/api/saas-service/tenants/:tenantId', requireRole(['super-admin', 'admin', 'tenant-admin']), async (req, res) => {
    try {
        const tenantId = String(req.params.tenantId || '').trim().toLowerCase();

        if (pool) {
            const result = await pool.query(
                `SELECT id, tenant_id, name, status, region, branding, settings, created_at, updated_at
                 FROM ms_saas_tenants
                 WHERE tenant_id = $1`,
                [tenantId]
            );
            if (!result.rows[0]) {
                return res.status(404).json({ success: false, error: 'tenant_not_found' });
            }
            return res.json({ success: true, data: result.rows[0] });
        }

        const tenant = memTenants.get(tenantId);
        if (!tenant) {
            return res.status(404).json({ success: false, error: 'tenant_not_found' });
        }

        return res.json({ success: true, data: tenant });
    } catch (error) {
        return res.status(500).json({ success: false, error: 'tenant_fetch_failed', message: error.message });
    }
});

app.patch('/api/saas-service/tenants/:tenantId/branding', requireRole(['super-admin', 'admin', 'tenant-admin']), async (req, res) => {
    try {
        const tenantId = String(req.params.tenantId || '').trim().toLowerCase();
        const branding = req.body.branding && typeof req.body.branding === 'object' ? req.body.branding : null;

        if (!branding) {
            return res.status(400).json({ success: false, error: 'branding_required' });
        }

        if (pool) {
            const result = await pool.query(
                `UPDATE ms_saas_tenants
                 SET branding = $2,
                     updated_at = NOW()
                 WHERE tenant_id = $1
                 RETURNING id, tenant_id, name, status, region, branding, settings, created_at, updated_at`,
                [tenantId, branding]
            );
            if (!result.rows[0]) {
                return res.status(404).json({ success: false, error: 'tenant_not_found' });
            }
            return res.json({ success: true, data: result.rows[0] });
        }

        const tenant = memTenants.get(tenantId);
        if (!tenant) {
            return res.status(404).json({ success: false, error: 'tenant_not_found' });
        }

        tenant.branding = branding;
        tenant.updated_at = new Date().toISOString();
        memTenants.set(tenantId, tenant);
        return res.json({ success: true, data: tenant });
    } catch (error) {
        return res.status(500).json({ success: false, error: 'branding_update_failed', message: error.message });
    }
});

app.post('/api/saas-service/subscriptions/activate', requireRole(['super-admin', 'admin']), async (req, res) => {
    try {
        const tenantId = String(req.body.tenant_id || '').trim().toLowerCase();
        const planCode = String(req.body.plan_code || '').trim().toLowerCase();
        const metadata = req.body.metadata && typeof req.body.metadata === 'object' ? req.body.metadata : {};

        if (!tenantId || !planCode) {
            return res.status(400).json({ success: false, error: 'tenant_id_and_plan_code_required' });
        }
        if (!plans[planCode]) {
            return res.status(400).json({ success: false, error: 'invalid_plan_code' });
        }

        if (pool) {
            const result = await pool.query(
                `INSERT INTO ms_saas_subscriptions (tenant_id, plan_code, status, metadata)
                 VALUES ($1, $2, 'active', $3)
                 ON CONFLICT (tenant_id) DO UPDATE SET
                    plan_code = EXCLUDED.plan_code,
                    status = 'active',
                    renewed_at = NOW(),
                    metadata = EXCLUDED.metadata
                 RETURNING id, tenant_id, plan_code, status, started_at, renewed_at, metadata`,
                [tenantId, planCode, metadata]
            );
            return res.json({ success: true, data: result.rows[0] });
        }

        const sub = {
            id: `sub-${Date.now()}`,
            tenant_id: tenantId,
            plan_code: planCode,
            status: 'active',
            started_at: new Date().toISOString(),
            renewed_at: new Date().toISOString(),
            metadata
        };
        memSubscriptions.set(tenantId, sub);
        return res.json({ success: true, data: sub });
    } catch (error) {
        return res.status(500).json({ success: false, error: 'subscription_activate_failed', message: error.message });
    }
});

app.post('/api/saas-service/usage/record', requireRole(['system', 'admin', 'tenant-admin']), async (req, res) => {
    try {
        const tenantId = String(req.body.tenant_id || getTenantId(req)).trim().toLowerCase();
        const metric = String(req.body.metric || '').trim().toLowerCase();
        const quantity = Math.max(0, Number(req.body.quantity || 0));
        const metadata = req.body.metadata && typeof req.body.metadata === 'object' ? req.body.metadata : {};

        if (!tenantId || !metric || !quantity) {
            return res.status(400).json({ success: false, error: 'tenant_id_metric_quantity_required' });
        }

        if (pool) {
            const result = await pool.query(
                `INSERT INTO ms_saas_usage_events (tenant_id, metric, quantity, metadata)
                 VALUES ($1, $2, $3, $4)
                 RETURNING id, tenant_id, metric, quantity::float8 AS quantity, metadata, recorded_at`,
                [tenantId, metric, quantity, metadata]
            );
            return res.json({ success: true, data: result.rows[0] });
        }

        const event = {
            id: `usage-${Date.now()}-${Math.floor(Math.random() * 1000)}`,
            tenant_id: tenantId,
            metric,
            quantity,
            metadata,
            recorded_at: new Date().toISOString()
        };
        memUsageEvents.push(event);
        return res.json({ success: true, data: event });
    } catch (error) {
        return res.status(500).json({ success: false, error: 'usage_record_failed', message: error.message });
    }
});

async function getSubscription(tenantId) {
    if (pool) {
        const result = await pool.query(
            `SELECT id, tenant_id, plan_code, status, started_at, renewed_at, metadata
             FROM ms_saas_subscriptions
             WHERE tenant_id = $1`,
            [tenantId]
        );
        return result.rows[0] || null;
    }
    return memSubscriptions.get(tenantId) || null;
}

async function getUsageSum(tenantId, metric) {
    if (pool) {
        const result = await pool.query(
            `SELECT COALESCE(SUM(quantity), 0)::float8 AS total
             FROM ms_saas_usage_events
             WHERE tenant_id = $1 AND metric = $2`,
            [tenantId, metric]
        );
        return Number(result.rows[0]?.total || 0);
    }

    return memUsageEvents
        .filter((x) => x.tenant_id === tenantId && x.metric === metric)
        .reduce((sum, x) => sum + Number(x.quantity || 0), 0);
}

async function calculateBilling(tenantId) {
    const subscription = await getSubscription(tenantId);
    if (!subscription) {
        throw new Error('subscription_not_found');
    }

    const plan = plans[subscription.plan_code];
    if (!plan) {
        throw new Error('plan_not_found');
    }

    const rides = await getUsageSum(tenantId, 'rides');
    const overageRides = Math.max(0, rides - plan.included_rides);
    const overageCost = Number((overageRides * plan.overage_per_ride).toFixed(2));
    const total = Number((plan.monthly_price + overageCost).toFixed(2));

    return {
        subscription,
        plan,
        usage: { rides, overage_rides: overageRides },
        charges: {
            base_monthly: plan.monthly_price,
            overage: overageCost,
            total
        }
    };
}

function getBillingPeriod(date = new Date()) {
    const year = date.getUTCFullYear();
    const month = String(date.getUTCMonth() + 1).padStart(2, '0');
    return `${year}-${month}`;
}

async function issueInvoiceForTenant(tenantId, metadata = {}) {
    const billing = await calculateBilling(tenantId);
    const billingPeriod = getBillingPeriod();
    const providerReference = `mockpay_${tenantId}_${Date.now()}`;

    if (pool) {
        const result = await pool.query(
            `INSERT INTO ms_saas_invoices
             (tenant_id, plan_code, billing_period, status, currency, base_amount, overage_amount, total_amount, provider_reference, details)
             VALUES ($1, $2, $3, 'pending', 'USD', $4, $5, $6, $7, $8)
             RETURNING id, tenant_id, plan_code, billing_period, status, currency,
                base_amount::float8 AS base_amount,
                overage_amount::float8 AS overage_amount,
                total_amount::float8 AS total_amount,
                provider_reference, details, issued_at, paid_at`,
            [
                tenantId,
                billing.subscription.plan_code,
                billingPeriod,
                billing.charges.base_monthly,
                billing.charges.overage,
                billing.charges.total,
                providerReference,
                { ...billing, metadata }
            ]
        );
        return result.rows[0];
    }

    const invoice = {
        id: `inv-${Date.now()}-${Math.floor(Math.random() * 1000)}`,
        tenant_id: tenantId,
        plan_code: billing.subscription.plan_code,
        billing_period: billingPeriod,
        status: 'pending',
        currency: 'USD',
        base_amount: billing.charges.base_monthly,
        overage_amount: billing.charges.overage,
        total_amount: billing.charges.total,
        provider_reference: providerReference,
        details: { ...billing, metadata },
        issued_at: new Date().toISOString(),
        paid_at: null
    };
    memInvoices.push(invoice);
    return invoice;
}

async function markInvoiceStatus(invoiceId, status, paidAt, providerReference) {
    if (pool) {
        const result = await pool.query(
            `UPDATE ms_saas_invoices
             SET status = $2,
                 paid_at = CASE WHEN $2 = 'paid' THEN COALESCE($3::timestamptz, NOW()) ELSE paid_at END,
                 provider_reference = COALESCE($4, provider_reference)
             WHERE id::text = $1
             RETURNING id, tenant_id, plan_code, billing_period, status, currency,
                base_amount::float8 AS base_amount,
                overage_amount::float8 AS overage_amount,
                total_amount::float8 AS total_amount,
                provider_reference, details, issued_at, paid_at`,
            [invoiceId, status, paidAt || null, providerReference || null]
        );
        return result.rows[0] || null;
    }

    const idx = memInvoices.findIndex((x) => String(x.id) === String(invoiceId));
    if (idx < 0) return null;
    memInvoices[idx].status = status;
    if (status === 'paid') {
        memInvoices[idx].paid_at = paidAt || new Date().toISOString();
    }
    if (providerReference) memInvoices[idx].provider_reference = providerReference;
    return memInvoices[idx];
}

async function findInvoice(invoiceId) {
    if (pool) {
        const result = await pool.query(
            `SELECT id, tenant_id, plan_code, billing_period, status, currency,
                base_amount::float8 AS base_amount,
                overage_amount::float8 AS overage_amount,
                total_amount::float8 AS total_amount,
                provider_reference, details, issued_at, paid_at
             FROM ms_saas_invoices
             WHERE id::text = $1`,
            [String(invoiceId)]
        );
        return result.rows[0] || null;
    }

    const found = memInvoices.find((x) => String(x.id) === String(invoiceId));
    return found || null;
}

async function upsertInvoiceDetails(invoiceId, extraDetails) {
    if (pool) {
        const result = await pool.query(
            `UPDATE ms_saas_invoices
             SET details = COALESCE(details, '{}'::jsonb) || $2::jsonb
             WHERE id::text = $1
             RETURNING id, tenant_id, plan_code, billing_period, status, currency,
                base_amount::float8 AS base_amount,
                overage_amount::float8 AS overage_amount,
                total_amount::float8 AS total_amount,
                provider_reference, details, issued_at, paid_at`,
            [String(invoiceId), extraDetails]
        );
        return result.rows[0] || null;
    }

    const idx = memInvoices.findIndex((x) => String(x.id) === String(invoiceId));
    if (idx < 0) return null;
    memInvoices[idx].details = { ...(memInvoices[idx].details || {}), ...extraDetails };
    return memInvoices[idx];
}

async function listPendingInvoices(tenantId) {
    if (pool) {
        const values = [];
        let where = `WHERE status = 'pending'`;
        if (tenantId) {
            values.push(tenantId);
            where += ' AND tenant_id = $1';
        }
        const result = await pool.query(
            `SELECT id, tenant_id, plan_code, billing_period, status, currency,
                base_amount::float8 AS base_amount,
                overage_amount::float8 AS overage_amount,
                total_amount::float8 AS total_amount,
                provider_reference, details, issued_at, paid_at
             FROM ms_saas_invoices
             ${where}
             ORDER BY id ASC
             LIMIT 200`,
            values
        );
        return result.rows;
    }

    return memInvoices.filter((x) => x.status === 'pending' && (!tenantId || x.tenant_id === tenantId));
}

app.get('/api/saas-service/usage/summary/:tenantId', requireRole(['super-admin', 'admin', 'tenant-admin']), async (req, res) => {
    try {
        const tenantId = String(req.params.tenantId || '').trim().toLowerCase();
        const rides = await getUsageSum(tenantId, 'rides');
        const apiCalls = await getUsageSum(tenantId, 'api_calls');
        const activeDrivers = await getUsageSum(tenantId, 'active_drivers');

        return res.json({
            success: true,
            data: {
                tenant_id: tenantId,
                usage: {
                    rides,
                    api_calls: apiCalls,
                    active_drivers: activeDrivers
                }
            }
        });
    } catch (error) {
        return res.status(500).json({ success: false, error: 'usage_summary_failed', message: error.message });
    }
});

app.get('/api/saas-service/billing/preview/:tenantId', requireRole(['super-admin', 'admin', 'tenant-admin']), async (req, res) => {
    try {
        const tenantId = String(req.params.tenantId || '').trim().toLowerCase();
        const billing = await calculateBilling(tenantId);

        return res.json({
            success: true,
            data: {
                tenant_id: tenantId,
                ...billing
            }
        });
    } catch (error) {
        if (error.message === 'subscription_not_found') {
            return res.status(404).json({ success: false, error: 'subscription_not_found' });
        }
        if (error.message === 'plan_not_found') {
            return res.status(422).json({ success: false, error: 'plan_not_found' });
        }
        return res.status(500).json({ success: false, error: 'billing_preview_failed', message: error.message });
    }
});

app.post('/api/saas-service/billing/invoices/issue', requireRole(['super-admin', 'admin']), async (req, res) => {
    try {
        const tenantId = String(req.body.tenant_id || '').trim().toLowerCase();
        if (!tenantId) {
            return res.status(400).json({ success: false, error: 'tenant_id_required' });
        }

        const invoice = await issueInvoiceForTenant(tenantId, { source: req.body.source || 'manual' });
        return res.json({ success: true, data: invoice });
    } catch (error) {
        if (error.message === 'subscription_not_found') {
            return res.status(404).json({ success: false, error: 'subscription_not_found' });
        }
        if (error.message === 'plan_not_found') {
            return res.status(422).json({ success: false, error: 'plan_not_found' });
        }
        return res.status(500).json({ success: false, error: 'invoice_issue_failed', message: error.message });
    }
});

app.post('/api/saas-service/billing/checkout/session', requireRole(['super-admin', 'admin', 'tenant-admin']), async (req, res) => {
    try {
        const invoiceId = String(req.body.invoice_id || '').trim();
        if (!invoiceId) {
            return res.status(400).json({ success: false, error: 'invoice_id_required' });
        }

        const invoice = await findInvoice(invoiceId);
        if (!invoice) {
            return res.status(404).json({ success: false, error: 'invoice_not_found' });
        }

        const checkout = await billingProvider.createCheckoutSession({
            tenantId: invoice.tenant_id,
            invoiceId: String(invoice.id),
            amount: invoice.total_amount,
            currency: invoice.currency
        });

        await upsertInvoiceDetails(String(invoice.id), {
            payment_checkout: checkout,
            payment_provider: billingProvider.name,
            payment_checkout_created_at: new Date().toISOString()
        });

        return res.json({ success: true, data: checkout });
    } catch (error) {
        return res.status(500).json({ success: false, error: 'checkout_session_failed', message: error.message });
    }
});

app.get('/api/saas-service/billing/invoices/:tenantId', requireRole(['super-admin', 'admin', 'tenant-admin']), async (req, res) => {
    try {
        const tenantId = String(req.params.tenantId || '').trim().toLowerCase();
        const limit = Math.max(1, Math.min(100, Number(req.query.limit || 20)));

        if (pool) {
            const result = await pool.query(
                `SELECT id, tenant_id, plan_code, billing_period, status, currency,
                    base_amount::float8 AS base_amount,
                    overage_amount::float8 AS overage_amount,
                    total_amount::float8 AS total_amount,
                    provider_reference, details, issued_at, paid_at
                 FROM ms_saas_invoices
                 WHERE tenant_id = $1
                 ORDER BY id DESC
                 LIMIT $2`,
                [tenantId, limit]
            );
            return res.json({ success: true, data: result.rows });
        }

        const data = memInvoices.filter((x) => x.tenant_id === tenantId).slice(-limit).reverse();
        return res.json({ success: true, data });
    } catch (error) {
        return res.status(500).json({ success: false, error: 'invoice_list_failed', message: error.message });
    }
});

app.post('/api/saas-service/billing/webhooks/provider', async (req, res) => {
    try {
        const payload = req.body || {};
        const signature = String(req.headers['x-billing-signature'] || '');
        const signatureValid = verifyWebhookSignature(payload, signature);
        const provider = String(payload.provider || 'mockpay').trim();
        const eventType = String(payload.event_type || '').trim();
        const tenantId = payload.tenant_id ? String(payload.tenant_id).trim().toLowerCase() : null;

        if (pool) {
            await pool.query(
                `INSERT INTO ms_saas_billing_webhook_events (tenant_id, provider, event_type, signature_valid, payload)
                 VALUES ($1, $2, $3, $4, $5)`,
                [tenantId, provider, eventType || 'unknown', signatureValid, payload]
            );
        } else {
            memWebhookEvents.push({
                id: `webhook-${Date.now()}-${Math.floor(Math.random() * 1000)}`,
                tenant_id: tenantId,
                provider,
                event_type: eventType || 'unknown',
                signature_valid: signatureValid,
                payload,
                created_at: new Date().toISOString()
            });
        }

        if (!signatureValid) {
            return res.status(401).json({ success: false, error: 'invalid_signature' });
        }

        const invoiceId = payload.invoice_id ? String(payload.invoice_id) : '';
        if (eventType === 'invoice.paid' && invoiceId) {
            const invoice = await markInvoiceStatus(invoiceId, 'paid', payload.paid_at || null, payload.provider_reference || null);
            if (!invoice) {
                return res.status(404).json({ success: false, error: 'invoice_not_found' });
            }
            return res.json({ success: true, data: { processed: true, invoice } });
        }

        if (eventType === 'invoice.failed' && invoiceId) {
            const invoice = await markInvoiceStatus(invoiceId, 'failed', null, payload.provider_reference || null);
            if (!invoice) {
                return res.status(404).json({ success: false, error: 'invoice_not_found' });
            }
            return res.json({ success: true, data: { processed: true, invoice } });
        }

        return res.json({ success: true, data: { processed: false } });
    } catch (error) {
        return res.status(500).json({ success: false, error: 'billing_webhook_failed', message: error.message });
    }
});

app.post('/api/saas-service/billing/cycle/run', requireRole(['super-admin']), async (_req, res) => {
    try {
        const processed = [];

        if (pool) {
            const result = await pool.query(
                `SELECT tenant_id
                 FROM ms_saas_subscriptions
                 WHERE status = 'active'`
            );

            for (const row of result.rows) {
                const invoice = await issueInvoiceForTenant(String(row.tenant_id), { source: 'cycle_run' });
                processed.push(invoice.id);
            }
        } else {
            for (const [tenantId, sub] of memSubscriptions.entries()) {
                if (sub.status === 'active') {
                    const invoice = await issueInvoiceForTenant(tenantId, { source: 'cycle_run' });
                    processed.push(invoice.id);
                }
            }
        }

        return res.json({ success: true, data: { processed_count: processed.length, invoice_ids: processed } });
    } catch (error) {
        return res.status(500).json({ success: false, error: 'billing_cycle_failed', message: error.message });
    }
});

app.post('/api/saas-service/billing/reconciliation/run', requireRole(['super-admin', 'admin']), async (req, res) => {
    try {
        const tenantId = req.body.tenant_id ? String(req.body.tenant_id).trim().toLowerCase() : null;
        const pending = await listPendingInvoices(tenantId);
        const updated = [];

        for (const invoice of pending) {
            const statusResult = await billingProvider.getPaymentStatus({
                tenantId: invoice.tenant_id,
                invoiceId: String(invoice.id),
                providerReference: invoice.provider_reference
            });

            if (statusResult.status === 'paid') {
                const next = await markInvoiceStatus(String(invoice.id), 'paid', null, invoice.provider_reference);
                if (next) updated.push({ invoice_id: next.id, status: next.status, tenant_id: next.tenant_id });
                continue;
            }

            if (statusResult.status === 'failed') {
                const next = await markInvoiceStatus(String(invoice.id), 'failed', null, invoice.provider_reference);
                if (next) updated.push({ invoice_id: next.id, status: next.status, tenant_id: next.tenant_id });
            }
        }

        return res.json({ success: true, data: { checked: pending.length, updated } });
    } catch (error) {
        return res.status(500).json({ success: false, error: 'reconciliation_failed', message: error.message });
    }
});

app.get('/api/saas-service/billing/reconciliation/summary', requireRole(['super-admin', 'admin']), async (req, res) => {
    try {
        const tenantId = req.query.tenant_id ? String(req.query.tenant_id).trim().toLowerCase() : null;
        const pending = await listPendingInvoices(tenantId);
        return res.json({
            success: true,
            data: {
                provider: billingProvider.name,
                pending_count: pending.length,
                sample_invoice_ids: pending.slice(0, 10).map((x) => x.id)
            }
        });
    } catch (error) {
        return res.status(500).json({ success: false, error: 'reconciliation_summary_failed', message: error.message });
    }
});

if (autoCycleEnabled) {
    cron.schedule(autoCycleSchedule, async () => {
        try {
            if (pool) {
                const result = await pool.query(
                    `SELECT tenant_id
                     FROM ms_saas_subscriptions
                     WHERE status = 'active'`
                );
                for (const row of result.rows) {
                    await issueInvoiceForTenant(String(row.tenant_id), { source: 'auto_cron' });
                }
            } else {
                for (const [tenantId, sub] of memSubscriptions.entries()) {
                    if (sub.status === 'active') {
                        await issueInvoiceForTenant(tenantId, { source: 'auto_cron' });
                    }
                }
            }
        } catch (error) {
            console.error('⚠️ Auto billing cycle failed:', error.message);
        }
    });
}

if (reconciliationEnabled) {
    cron.schedule(reconciliationSchedule, async () => {
        try {
            const pending = await listPendingInvoices(null);
            for (const invoice of pending) {
                const statusResult = await billingProvider.getPaymentStatus({
                    tenantId: invoice.tenant_id,
                    invoiceId: String(invoice.id),
                    providerReference: invoice.provider_reference
                });

                if (statusResult.status === 'paid') {
                    await markInvoiceStatus(String(invoice.id), 'paid', null, invoice.provider_reference);
                } else if (statusResult.status === 'failed') {
                    await markInvoiceStatus(String(invoice.id), 'failed', null, invoice.provider_reference);
                }
            }
        } catch (error) {
            console.error('⚠️ Billing reconciliation failed:', error.message);
        }
    });
}

ensureSchema()
    .catch((error) => {
        console.error('⚠️ SaaS schema init failed, service will continue:', error.message);
    })
    .finally(() => {
        app.listen(PORT, () => {
            console.log(`🏢 SaaS service listening on ${PORT}`);
        });
    });
