const express = require('express');
const promClient = require('prom-client');
const { Pool } = require('pg');

const app = express();
const PORT = Number(process.env.SAAS_SERVICE_PORT || 4105);
const useDatabase = Boolean(process.env.DATABASE_URL);
const pool = useDatabase ? new Pool({ connectionString: process.env.DATABASE_URL }) : null;

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
        const subscription = await getSubscription(tenantId);

        if (!subscription) {
            return res.status(404).json({ success: false, error: 'subscription_not_found' });
        }

        const plan = plans[subscription.plan_code];
        if (!plan) {
            return res.status(422).json({ success: false, error: 'plan_not_found' });
        }

        const rides = await getUsageSum(tenantId, 'rides');
        const overageRides = Math.max(0, rides - plan.included_rides);
        const overageCost = Number((overageRides * plan.overage_per_ride).toFixed(2));
        const total = Number((plan.monthly_price + overageCost).toFixed(2));

        return res.json({
            success: true,
            data: {
                tenant_id: tenantId,
                subscription,
                plan,
                usage: { rides, overage_rides: overageRides },
                charges: {
                    base_monthly: plan.monthly_price,
                    overage: overageCost,
                    total
                }
            }
        });
    } catch (error) {
        return res.status(500).json({ success: false, error: 'billing_preview_failed', message: error.message });
    }
});

ensureSchema()
    .catch((error) => {
        console.error('⚠️ SaaS schema init failed, service will continue:', error.message);
    })
    .finally(() => {
        app.listen(PORT, () => {
            console.log(`🏢 SaaS service listening on ${PORT}`);
        });
    });
