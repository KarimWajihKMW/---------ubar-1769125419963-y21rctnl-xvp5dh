const crypto = require('crypto');

function normText(v, max = 120) {
    return String(v === undefined || v === null ? '' : v).trim().slice(0, max);
}

function normKey(v, max = 60) {
    return normText(v, max).toLowerCase().replace(/[^a-z0-9_-]/g, '_').replace(/_+/g, '_').replace(/^_+|_+$/g, '');
}

function normJson(v) {
    if (v && typeof v === 'object') return v;
    return null;
}

function nowIso() {
    return new Date().toISOString();
}

async function ensureSaasTables(pool) {
    await pool.query(`
        CREATE TABLE IF NOT EXISTS saas_tenants (
            id BIGSERIAL PRIMARY KEY,
            tenant_key VARCHAR(60) UNIQUE NOT NULL,
            name VARCHAR(140) NOT NULL,
            status VARCHAR(20) NOT NULL DEFAULT 'active',
            country_code VARCHAR(8),
            timezone VARCHAR(60) DEFAULT 'UTC',
            branding_json JSONB,
            config_json JSONB,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        );
    `);

    await pool.query(`
        CREATE TABLE IF NOT EXISTS saas_tenant_domains (
            id BIGSERIAL PRIMARY KEY,
            tenant_id BIGINT NOT NULL REFERENCES saas_tenants(id) ON DELETE CASCADE,
            domain VARCHAR(255) UNIQUE NOT NULL,
            is_primary BOOLEAN DEFAULT false,
            verified_at TIMESTAMP,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        );
    `);

    await pool.query(`
        CREATE TABLE IF NOT EXISTS saas_subscription_plans (
            id BIGSERIAL PRIMARY KEY,
            plan_key VARCHAR(60) UNIQUE NOT NULL,
            title VARCHAR(100) NOT NULL,
            monthly_price NUMERIC(12,2) NOT NULL DEFAULT 0,
            yearly_price NUMERIC(12,2) NOT NULL DEFAULT 0,
            limits_json JSONB,
            features_json JSONB,
            is_active BOOLEAN DEFAULT true,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        );
    `);

    await pool.query(`
        CREATE TABLE IF NOT EXISTS saas_tenant_subscriptions (
            id BIGSERIAL PRIMARY KEY,
            tenant_id BIGINT NOT NULL REFERENCES saas_tenants(id) ON DELETE CASCADE,
            plan_id BIGINT NOT NULL REFERENCES saas_subscription_plans(id),
            status VARCHAR(20) NOT NULL DEFAULT 'active',
            cycle VARCHAR(20) NOT NULL DEFAULT 'monthly',
            starts_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            ends_at TIMESTAMP,
            auto_renew BOOLEAN DEFAULT true,
            created_by_user_id BIGINT,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        );
    `);

    await pool.query(`
        CREATE TABLE IF NOT EXISTS saas_usage_events (
            id BIGSERIAL PRIMARY KEY,
            tenant_id BIGINT NOT NULL REFERENCES saas_tenants(id) ON DELETE CASCADE,
            metric_key VARCHAR(80) NOT NULL,
            value NUMERIC(14,2) NOT NULL DEFAULT 1,
            dimensions_json JSONB,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        );
    `);

    await pool.query(`
        CREATE TABLE IF NOT EXISTS saas_invoices (
            id BIGSERIAL PRIMARY KEY,
            tenant_id BIGINT NOT NULL REFERENCES saas_tenants(id) ON DELETE CASCADE,
            subscription_id BIGINT REFERENCES saas_tenant_subscriptions(id),
            period_start TIMESTAMP NOT NULL,
            period_end TIMESTAMP NOT NULL,
            currency VARCHAR(10) NOT NULL DEFAULT 'USD',
            plan_amount NUMERIC(14,2) NOT NULL DEFAULT 0,
            usage_amount NUMERIC(14,2) NOT NULL DEFAULT 0,
            total_amount NUMERIC(14,2) NOT NULL DEFAULT 0,
            status VARCHAR(20) NOT NULL DEFAULT 'draft',
            breakdown_json JSONB,
            generated_by_user_id BIGINT,
            generated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            paid_at TIMESTAMP,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            CONSTRAINT saas_invoice_period_check CHECK (period_end > period_start)
        );
    `);

    await pool.query(`
        CREATE TABLE IF NOT EXISTS saas_invoice_payments (
            id BIGSERIAL PRIMARY KEY,
            invoice_id BIGINT NOT NULL REFERENCES saas_invoices(id) ON DELETE CASCADE,
            tenant_id BIGINT NOT NULL REFERENCES saas_tenants(id) ON DELETE CASCADE,
            provider VARCHAR(40) NOT NULL DEFAULT 'manual',
            provider_event_id VARCHAR(140),
            status VARCHAR(20) NOT NULL DEFAULT 'succeeded',
            amount NUMERIC(14,2) NOT NULL,
            currency VARCHAR(10) NOT NULL DEFAULT 'USD',
            paid_at TIMESTAMP,
            meta_json JSONB,
            created_by_user_id BIGINT,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        );
    `);

    await pool.query(`
        CREATE TABLE IF NOT EXISTS saas_billing_webhook_events (
            id BIGSERIAL PRIMARY KEY,
            provider VARCHAR(40) NOT NULL,
            event_id VARCHAR(140) NOT NULL,
            invoice_id BIGINT,
            payload_json JSONB,
            signature_valid BOOLEAN DEFAULT false,
            processed BOOLEAN DEFAULT false,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            UNIQUE (provider, event_id)
        );
    `);

    await pool.query(`
        CREATE TABLE IF NOT EXISTS saas_invoice_payment_attempts (
            id BIGSERIAL PRIMARY KEY,
            invoice_id BIGINT NOT NULL REFERENCES saas_invoices(id) ON DELETE CASCADE,
            tenant_id BIGINT NOT NULL REFERENCES saas_tenants(id) ON DELETE CASCADE,
            provider VARCHAR(40) NOT NULL DEFAULT 'mockpay',
            idempotency_key VARCHAR(140),
            attempt_no INTEGER NOT NULL DEFAULT 1,
            requested_amount NUMERIC(14,2) NOT NULL,
            currency VARCHAR(10) NOT NULL DEFAULT 'USD',
            status VARCHAR(20) NOT NULL DEFAULT 'processing',
            provider_payment_id VARCHAR(140),
            provider_response_json JSONB,
            error_message TEXT,
            processed_at TIMESTAMP,
            created_by_user_id BIGINT,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        );
    `);

    await pool.query('CREATE INDEX IF NOT EXISTS idx_saas_tenants_key ON saas_tenants(tenant_key);');
    await pool.query('CREATE INDEX IF NOT EXISTS idx_saas_domains_domain ON saas_tenant_domains(domain);');
    await pool.query('CREATE INDEX IF NOT EXISTS idx_saas_subs_tenant ON saas_tenant_subscriptions(tenant_id, created_at DESC);');
    await pool.query('CREATE INDEX IF NOT EXISTS idx_saas_usage_tenant_metric ON saas_usage_events(tenant_id, metric_key, created_at DESC);');
    await pool.query('CREATE INDEX IF NOT EXISTS idx_saas_invoices_tenant ON saas_invoices(tenant_id, created_at DESC);');
    await pool.query('CREATE INDEX IF NOT EXISTS idx_saas_invoices_status ON saas_invoices(status, created_at DESC);');
    await pool.query('CREATE INDEX IF NOT EXISTS idx_saas_invoice_payments_invoice ON saas_invoice_payments(invoice_id, created_at DESC);');
    await pool.query('CREATE UNIQUE INDEX IF NOT EXISTS uq_saas_invoice_payments_provider_event ON saas_invoice_payments(provider, provider_event_id) WHERE provider_event_id IS NOT NULL;');
    await pool.query('CREATE INDEX IF NOT EXISTS idx_saas_webhooks_provider_event ON saas_billing_webhook_events(provider, event_id);');
    await pool.query('CREATE INDEX IF NOT EXISTS idx_saas_payment_attempts_invoice ON saas_invoice_payment_attempts(invoice_id, created_at DESC);');
    await pool.query('CREATE INDEX IF NOT EXISTS idx_saas_payment_attempts_status ON saas_invoice_payment_attempts(status, created_at DESC);');
    await pool.query('CREATE UNIQUE INDEX IF NOT EXISTS uq_saas_payment_attempts_idempotency ON saas_invoice_payment_attempts(provider, idempotency_key) WHERE idempotency_key IS NOT NULL;');

    const defaultPlans = [
        {
            key: 'starter',
            title: 'Starter',
            monthly_price: 299,
            yearly_price: 2990,
            limits: { max_monthly_trips: 5000, max_drivers: 200, max_admins: 10 },
            features: ['core_dispatch', 'wallet', 'promotions', 'basic_analytics']
        },
        {
            key: 'growth',
            title: 'Growth',
            monthly_price: 899,
            yearly_price: 8990,
            limits: { max_monthly_trips: 40000, max_drivers: 1500, max_admins: 60 },
            features: ['all_starter', 'advanced_analytics', 'automation', 'ai_ops']
        },
        {
            key: 'enterprise',
            title: 'Enterprise',
            monthly_price: 2499,
            yearly_price: 24990,
            limits: { max_monthly_trips: 500000, max_drivers: 15000, max_admins: 500 },
            features: ['all_growth', 'custom_sla', 'white_label', 'multi_region']
        }
    ];

    for (const p of defaultPlans) {
        await pool.query(
            `INSERT INTO saas_subscription_plans (plan_key, title, monthly_price, yearly_price, limits_json, features_json)
             VALUES ($1,$2,$3,$4,$5,$6)
             ON CONFLICT (plan_key)
             DO UPDATE SET
                title = EXCLUDED.title,
                monthly_price = EXCLUDED.monthly_price,
                yearly_price = EXCLUDED.yearly_price,
                limits_json = EXCLUDED.limits_json,
                features_json = EXCLUDED.features_json,
                updated_at = CURRENT_TIMESTAMP`,
            [
                p.key,
                p.title,
                p.monthly_price,
                p.yearly_price,
                JSON.stringify(p.limits),
                JSON.stringify(p.features)
            ]
        );
    }
}

async function resolveTenant(pool, req) {
    const headerTenant = normKey(req.headers['x-tenant-key'] || req.headers['x-tenant-id']);
    if (headerTenant) {
        const t = await pool.query(
            `SELECT id, tenant_key, name, status, branding_json, config_json
             FROM saas_tenants
             WHERE tenant_key = $1
             LIMIT 1`,
            [headerTenant]
        );
        if (t.rows[0]) return t.rows[0];
    }

    const hostRaw = normText(req.headers.host || '', 255).toLowerCase();
    const host = hostRaw.split(':')[0];
    if (!host) return null;

    const byDomain = await pool.query(
        `SELECT t.id, t.tenant_key, t.name, t.status, t.branding_json, t.config_json
         FROM saas_tenant_domains d
         INNER JOIN saas_tenants t ON t.id = d.tenant_id
         WHERE LOWER(d.domain) = $1
         LIMIT 1`,
        [host]
    );

    return byDomain.rows[0] || null;
}

function makeTenantMiddleware(pool) {
    return async (req, _res, next) => {
        try {
            req.tenant = await resolveTenant(pool, req);
        } catch (e) {
            req.tenant = null;
        }
        next();
    };
}

function ensureTenantFromRequest(req, res) {
    if (!req.tenant || !req.tenant.id) {
        res.status(400).json({ success: false, error: 'tenant_not_resolved' });
        return false;
    }
    return true;
}

async function writeAuditSafe(writeAdminAudit, req, payload) {
    if (typeof writeAdminAudit !== 'function') return;
    try {
        await writeAdminAudit(req, payload);
    } catch (_e) {
        // non-blocking
    }
}

function invoiceStatusFromInput(v) {
    const s = normKey(v, 20);
    if (['draft', 'issued', 'paid', 'void'].includes(s)) return s;
    return null;
}

function paymentStatusFromInput(v) {
    const s = normKey(v, 20);
    if (['pending', 'processing', 'succeeded', 'failed', 'paid'].includes(s)) return s;
    return 'succeeded';
}

async function resolveLatestSubscription(pool, tenantId) {
    const sub = await pool.query(
        `SELECT s.id, s.tenant_id, s.plan_id, s.status, s.cycle, s.starts_at, p.plan_key, p.monthly_price, p.yearly_price
         FROM saas_tenant_subscriptions s
         INNER JOIN saas_subscription_plans p ON p.id = s.plan_id
         WHERE s.tenant_id = $1
         ORDER BY s.created_at DESC
         LIMIT 1`,
        [tenantId]
    );
    return sub.rows[0] || null;
}

async function computeUsageCharges(pool, tenantId, { periodStart, periodEnd }) {
    const rows = await pool.query(
        `SELECT metric_key, SUM(value)::numeric(14,2) AS units
         FROM saas_usage_events
         WHERE tenant_id = $1
           AND created_at >= $2
           AND created_at < $3
         GROUP BY metric_key
         ORDER BY metric_key ASC`,
        [tenantId, periodStart, periodEnd]
    );

    // Default simple catalog; can be made tenant-specific later.
    const unitPrice = {
        trip_created: 0.02,
        api_call: 0.001,
        ai_query: 0.03
    };

    const items = [];
    let usageAmount = 0;

    for (const r of rows.rows || []) {
        const key = String(r.metric_key || 'unknown');
        const units = Number(r.units || 0);
        const price = Number.isFinite(unitPrice[key]) ? unitPrice[key] : 0.005;
        const amount = Number((units * price).toFixed(2));
        usageAmount += amount;
        items.push({ metric_key: key, units, unit_price: price, amount });
    }

    return { usageAmount: Number(usageAmount.toFixed(2)), usageItems: items };
}

function billingWebhookSecret() {
    return String(process.env.BILLING_WEBHOOK_SECRET || process.env.JWT_SECRET || 'billing-webhook-dev-secret');
}

function signWebhookBody(payload) {
    const body = typeof payload === 'string' ? payload : JSON.stringify(payload || {});
    return crypto.createHmac('sha256', billingWebhookSecret()).update(body).digest('hex');
}

function isWebhookSignatureValid(rawBody, signature) {
    const provided = String(signature || '').trim().toLowerCase();
    if (!provided) return false;
    const expected = signWebhookBody(rawBody);
    const a = Buffer.from(provided, 'utf8');
    const b = Buffer.from(expected, 'utf8');
    if (a.length !== b.length) return false;
    return crypto.timingSafeEqual(a, b);
}

async function applyInvoicePaidStatus(pool, invoiceId) {
    const invRes = await pool.query(
        `SELECT id, total_amount, status
         FROM saas_invoices
         WHERE id = $1
         LIMIT 1`,
        [invoiceId]
    );
    const inv = invRes.rows[0] || null;
    if (!inv) return null;

    const paidRes = await pool.query(
        `SELECT COALESCE(SUM(amount),0)::numeric(14,2) AS paid_total
         FROM saas_invoice_payments
         WHERE invoice_id = $1
           AND status IN ('succeeded','paid')`,
        [invoiceId]
    );
    const paidTotal = Number(paidRes.rows?.[0]?.paid_total || 0);
    const targetTotal = Number(inv.total_amount || 0);

    let status = 'issued';
    if (paidTotal >= targetTotal && targetTotal > 0) status = 'paid';
    if (String(inv.status || '').toLowerCase() === 'void') status = 'void';

    const upd = await pool.query(
        `UPDATE saas_invoices
         SET status = $2::text,
             paid_at = CASE WHEN $2::text = 'paid' THEN COALESCE(paid_at, CURRENT_TIMESTAMP) ELSE paid_at END,
             updated_at = CURRENT_TIMESTAMP
         WHERE id = $1
         RETURNING *`,
        [invoiceId, status]
    );

    return {
        invoice: upd.rows[0] || inv,
        paid_total: Number(paidTotal.toFixed(2)),
        due_total: Number(targetTotal.toFixed(2))
    };
}

async function getInvoiceBalance(pool, invoiceId) {
    const invRes = await pool.query(
        `SELECT id, tenant_id, currency, total_amount, status
         FROM saas_invoices
         WHERE id = $1
         LIMIT 1`,
        [invoiceId]
    );
    const invoice = invRes.rows[0] || null;
    if (!invoice) return null;

    const paidRes = await pool.query(
        `SELECT COALESCE(SUM(amount),0)::numeric(14,2) AS paid_total
         FROM saas_invoice_payments
         WHERE invoice_id = $1
           AND status IN ('succeeded','paid')`,
        [invoiceId]
    );
    const paidTotal = Number(paidRes.rows?.[0]?.paid_total || 0);
    const total = Number(invoice.total_amount || 0);
    const due = Number(Math.max(0, total - paidTotal).toFixed(2));
    return {
        invoice,
        total,
        paid_total: Number(paidTotal.toFixed(2)),
        due_total: due
    };
}

async function nextAttemptNo(pool, invoiceId) {
    const r = await pool.query(
        `SELECT COALESCE(MAX(attempt_no), 0) AS max_no
         FROM saas_invoice_payment_attempts
         WHERE invoice_id = $1`,
        [invoiceId]
    );
    return Number(r.rows?.[0]?.max_no || 0) + 1;
}

function simulateProviderCharge({ provider, invoiceId, amount, currency, requestId, forceFail }) {
    const providerKey = normKey(provider || 'mockpay', 40) || 'mockpay';
    if (forceFail) {
        return {
            ok: false,
            provider: providerKey,
            code: 'provider_declined',
            message: 'Payment provider declined this attempt',
            raw: { request_id: requestId, invoice_id: invoiceId, amount, currency }
        };
    }
    return {
        ok: true,
        provider: providerKey,
        provider_payment_id: `${providerKey}_pay_${Date.now()}_${Math.floor(Math.random() * 100000)}`,
        raw: { request_id: requestId, invoice_id: invoiceId, amount, currency, captured: true }
    };
}

function registerSaasRoutes(app, { pool, requirePermission, requireRole, writeAdminAudit }) {
    app.get('/api/saas/tenant/context', async (req, res) => {
        const tenant = req.tenant || null;
        return res.json({
            success: true,
            data: tenant ? {
                id: tenant.id,
                key: tenant.tenant_key,
                name: tenant.name,
                status: tenant.status,
                branding: tenant.branding_json || null,
                config: tenant.config_json || null
            } : null,
            server_time: nowIso()
        });
    });

    app.post('/api/saas/usage/events', requireRole('admin', 'driver', 'passenger'), async (req, res) => {
        try {
            if (!ensureTenantFromRequest(req, res)) return;

            const metricKey = normKey(req.body?.metric_key, 80);
            const valueRaw = Number(req.body?.value);
            const value = Number.isFinite(valueRaw) ? valueRaw : 1;
            const dimensions = normJson(req.body?.dimensions_json) || {};

            if (!metricKey) {
                return res.status(400).json({ success: false, error: 'metric_key_required' });
            }

            const ins = await pool.query(
                `INSERT INTO saas_usage_events (tenant_id, metric_key, value, dimensions_json)
                 VALUES ($1,$2,$3,$4)
                 RETURNING id, tenant_id, metric_key, value, dimensions_json, created_at`,
                [req.tenant.id, metricKey, value, JSON.stringify(dimensions)]
            );

            return res.status(201).json({ success: true, data: ins.rows[0] });
        } catch (e) {
            return res.status(500).json({ success: false, error: e.message || 'usage_event_failed' });
        }
    });

    app.get('/api/admin/saas/tenants', requirePermission('admin.ops.read', 'admin.executive.read'), async (req, res) => {
        try {
            const rows = await pool.query(
                `SELECT t.id, t.tenant_key, t.name, t.status, t.country_code, t.timezone, t.branding_json, t.config_json, t.created_at,
                        s.id AS subscription_id, s.status AS subscription_status, s.cycle AS billing_cycle,
                        p.plan_key, p.title AS plan_title, p.monthly_price, p.yearly_price
                 FROM saas_tenants t
                 LEFT JOIN LATERAL (
                    SELECT * FROM saas_tenant_subscriptions ts
                    WHERE ts.tenant_id = t.id
                    ORDER BY ts.created_at DESC
                    LIMIT 1
                 ) s ON true
                 LEFT JOIN saas_subscription_plans p ON p.id = s.plan_id
                 ORDER BY t.created_at DESC
                 LIMIT 300`
            );
            return res.json({ success: true, count: rows.rows.length, data: rows.rows });
        } catch (e) {
            return res.status(500).json({ success: false, error: e.message || 'list_tenants_failed' });
        }
    });

    app.post('/api/admin/saas/tenants', requirePermission('admin.ops.write'), async (req, res) => {
        try {
            const key = normKey(req.body?.tenant_key || req.body?.key);
            const name = normText(req.body?.name, 140);
            const countryCode = normText(req.body?.country_code, 8).toUpperCase() || null;
            const timezone = normText(req.body?.timezone, 60) || 'UTC';
            const status = ['active', 'paused', 'suspended'].includes(normKey(req.body?.status, 20))
                ? normKey(req.body?.status, 20)
                : 'active';
            const branding = normJson(req.body?.branding_json) || {
                app_name: name || key,
                primary_color: '#0e7490',
                accent_color: '#f59e0b'
            };
            const config = normJson(req.body?.config_json) || {};

            if (!key || !name) {
                return res.status(400).json({ success: false, error: 'tenant_key_and_name_required' });
            }

            const created = await pool.query(
                `INSERT INTO saas_tenants (tenant_key, name, status, country_code, timezone, branding_json, config_json)
                 VALUES ($1,$2,$3,$4,$5,$6,$7)
                 RETURNING id, tenant_key, name, status, country_code, timezone, branding_json, config_json, created_at`,
                [key, name, status, countryCode, timezone, JSON.stringify(branding), JSON.stringify(config)]
            );

            const domain = normText(req.body?.domain, 255).toLowerCase();
            if (domain) {
                await pool.query(
                    `INSERT INTO saas_tenant_domains (tenant_id, domain, is_primary)
                     VALUES ($1,$2,true)
                     ON CONFLICT (domain) DO NOTHING`,
                    [created.rows[0].id, domain]
                );
            }

            await writeAuditSafe(writeAdminAudit, req, {
                action: 'saas.tenant.create',
                entity_type: 'saas_tenant',
                entity_id: String(created.rows[0].id),
                meta: { tenant_key: created.rows[0].tenant_key }
            });

            return res.status(201).json({ success: true, data: created.rows[0] });
        } catch (e) {
            return res.status(500).json({ success: false, error: e.message || 'create_tenant_failed' });
        }
    });

    app.patch('/api/admin/saas/tenants/:id', requirePermission('admin.ops.write'), async (req, res) => {
        try {
            const id = Number(req.params.id);
            if (!Number.isFinite(id) || id <= 0) {
                return res.status(400).json({ success: false, error: 'invalid_tenant_id' });
            }

            const name = normText(req.body?.name, 140);
            const status = normKey(req.body?.status, 20);
            const timezone = normText(req.body?.timezone, 60);
            const countryCode = normText(req.body?.country_code, 8).toUpperCase();
            const config = normJson(req.body?.config_json);

            const updated = await pool.query(
                `UPDATE saas_tenants
                 SET name = COALESCE(NULLIF($2,''), name),
                     status = CASE WHEN $3 IN ('active','paused','suspended') THEN $3 ELSE status END,
                     timezone = COALESCE(NULLIF($4,''), timezone),
                     country_code = COALESCE(NULLIF($5,''), country_code),
                     config_json = COALESCE($6::jsonb, config_json),
                     updated_at = CURRENT_TIMESTAMP
                 WHERE id = $1
                 RETURNING id, tenant_key, name, status, country_code, timezone, branding_json, config_json, updated_at`,
                [id, name, status, timezone, countryCode, config ? JSON.stringify(config) : null]
            );

            if (!updated.rows[0]) {
                return res.status(404).json({ success: false, error: 'tenant_not_found' });
            }

            await writeAuditSafe(writeAdminAudit, req, {
                action: 'saas.tenant.update',
                entity_type: 'saas_tenant',
                entity_id: String(id)
            });

            return res.json({ success: true, data: updated.rows[0] });
        } catch (e) {
            return res.status(500).json({ success: false, error: e.message || 'update_tenant_failed' });
        }
    });

    app.patch('/api/admin/saas/tenants/:id/branding', requirePermission('admin.ops.write'), async (req, res) => {
        try {
            const id = Number(req.params.id);
            const branding = normJson(req.body?.branding_json);
            if (!Number.isFinite(id) || id <= 0) {
                return res.status(400).json({ success: false, error: 'invalid_tenant_id' });
            }
            if (!branding) {
                return res.status(400).json({ success: false, error: 'branding_json_required' });
            }

            const updated = await pool.query(
                `UPDATE saas_tenants
                 SET branding_json = $2, updated_at = CURRENT_TIMESTAMP
                 WHERE id = $1
                 RETURNING id, tenant_key, name, status, branding_json, updated_at`,
                [id, JSON.stringify(branding)]
            );

            if (!updated.rows[0]) {
                return res.status(404).json({ success: false, error: 'tenant_not_found' });
            }

            await writeAuditSafe(writeAdminAudit, req, {
                action: 'saas.tenant.branding.update',
                entity_type: 'saas_tenant',
                entity_id: String(id)
            });

            return res.json({ success: true, data: updated.rows[0] });
        } catch (e) {
            return res.status(500).json({ success: false, error: e.message || 'update_branding_failed' });
        }
    });

    app.get('/api/admin/saas/plans', requirePermission('admin.ops.read', 'admin.executive.read'), async (_req, res) => {
        try {
            const plans = await pool.query(
                `SELECT id, plan_key, title, monthly_price, yearly_price, limits_json, features_json, is_active, created_at, updated_at
                 FROM saas_subscription_plans
                 ORDER BY monthly_price ASC, id ASC`
            );
            return res.json({ success: true, count: plans.rows.length, data: plans.rows });
        } catch (e) {
            return res.status(500).json({ success: false, error: e.message || 'list_plans_failed' });
        }
    });

    app.post('/api/admin/saas/plans', requirePermission('admin.ops.write'), async (req, res) => {
        try {
            const planKey = normKey(req.body?.plan_key || req.body?.key);
            const title = normText(req.body?.title, 100);
            const monthly = Number(req.body?.monthly_price);
            const yearly = Number(req.body?.yearly_price);
            const limits = normJson(req.body?.limits_json) || {};
            const features = Array.isArray(req.body?.features_json) ? req.body.features_json : [];
            const isActive = req.body?.is_active === undefined ? true : !!req.body.is_active;

            if (!planKey || !title || !Number.isFinite(monthly) || !Number.isFinite(yearly)) {
                return res.status(400).json({ success: false, error: 'invalid_plan_payload' });
            }

            const up = await pool.query(
                `INSERT INTO saas_subscription_plans (plan_key, title, monthly_price, yearly_price, limits_json, features_json, is_active)
                 VALUES ($1,$2,$3,$4,$5,$6,$7)
                 ON CONFLICT (plan_key)
                 DO UPDATE SET
                    title = EXCLUDED.title,
                    monthly_price = EXCLUDED.monthly_price,
                    yearly_price = EXCLUDED.yearly_price,
                    limits_json = EXCLUDED.limits_json,
                    features_json = EXCLUDED.features_json,
                    is_active = EXCLUDED.is_active,
                    updated_at = CURRENT_TIMESTAMP
                 RETURNING id, plan_key, title, monthly_price, yearly_price, limits_json, features_json, is_active, updated_at`,
                [planKey, title, monthly, yearly, JSON.stringify(limits), JSON.stringify(features), isActive]
            );

            await writeAuditSafe(writeAdminAudit, req, {
                action: 'saas.plan.upsert',
                entity_type: 'saas_plan',
                entity_id: String(up.rows[0].id),
                meta: { plan_key: up.rows[0].plan_key }
            });

            return res.status(201).json({ success: true, data: up.rows[0] });
        } catch (e) {
            return res.status(500).json({ success: false, error: e.message || 'upsert_plan_failed' });
        }
    });

    app.post('/api/admin/saas/tenants/:id/subscription', requirePermission('admin.ops.write', 'admin.executive.write'), async (req, res) => {
        try {
            const tenantId = Number(req.params.id);
            const planKey = normKey(req.body?.plan_key, 60);
            const cycle = ['monthly', 'yearly'].includes(normKey(req.body?.cycle, 20)) ? normKey(req.body?.cycle, 20) : 'monthly';
            const status = ['active', 'trialing', 'paused', 'cancelled'].includes(normKey(req.body?.status, 20))
                ? normKey(req.body?.status, 20)
                : 'active';
            const autoRenew = req.body?.auto_renew === undefined ? true : !!req.body.auto_renew;

            if (!Number.isFinite(tenantId) || tenantId <= 0 || !planKey) {
                return res.status(400).json({ success: false, error: 'tenant_id_and_plan_key_required' });
            }

            const planRes = await pool.query('SELECT id FROM saas_subscription_plans WHERE plan_key = $1 LIMIT 1', [planKey]);
            if (!planRes.rows[0]) {
                return res.status(404).json({ success: false, error: 'plan_not_found' });
            }

            const sub = await pool.query(
                `INSERT INTO saas_tenant_subscriptions (tenant_id, plan_id, status, cycle, auto_renew, created_by_user_id)
                 VALUES ($1,$2,$3,$4,$5,$6)
                 RETURNING id, tenant_id, plan_id, status, cycle, auto_renew, starts_at, created_at`,
                [tenantId, planRes.rows[0].id, status, cycle, autoRenew, req.auth?.uid || null]
            );

            await writeAuditSafe(writeAdminAudit, req, {
                action: 'saas.subscription.create',
                entity_type: 'saas_subscription',
                entity_id: String(sub.rows[0].id),
                meta: { tenant_id: tenantId, plan_key: planKey, cycle }
            });

            return res.status(201).json({ success: true, data: sub.rows[0] });
        } catch (e) {
            return res.status(500).json({ success: false, error: e.message || 'create_subscription_failed' });
        }
    });

    app.get('/api/admin/saas/tenants/:id/usage', requirePermission('admin.ops.read', 'admin.executive.read'), async (req, res) => {
        try {
            const tenantId = Number(req.params.id);
            const daysRaw = Number(req.query?.days);
            const days = Number.isFinite(daysRaw) ? Math.max(1, Math.min(daysRaw, 180)) : 30;

            if (!Number.isFinite(tenantId) || tenantId <= 0) {
                return res.status(400).json({ success: false, error: 'invalid_tenant_id' });
            }

            const rows = await pool.query(
                `SELECT metric_key,
                        SUM(value)::numeric(14,2) AS total_value,
                        COUNT(*)::int AS events_count
                 FROM saas_usage_events
                 WHERE tenant_id = $1
                   AND created_at >= NOW() - ($2::text || ' days')::interval
                 GROUP BY metric_key
                 ORDER BY metric_key ASC`,
                [tenantId, String(days)]
            );

            const usageToken = crypto.createHash('sha256')
                .update(`${tenantId}:${days}:${nowIso()}`)
                .digest('hex')
                .slice(0, 20);

            return res.json({
                success: true,
                tenant_id: tenantId,
                lookback_days: days,
                usage_signature: usageToken,
                data: rows.rows
            });
        } catch (e) {
            return res.status(500).json({ success: false, error: e.message || 'tenant_usage_failed' });
        }
    });

    app.post('/api/admin/saas/tenants/:id/invoices/generate', requirePermission('admin.executive.write', 'admin.ops.write'), async (req, res) => {
        try {
            const tenantId = Number(req.params.id);
            if (!Number.isFinite(tenantId) || tenantId <= 0) {
                return res.status(400).json({ success: false, error: 'invalid_tenant_id' });
            }

            const lookbackDaysRaw = Number(req.body?.lookback_days);
            const lookbackDays = Number.isFinite(lookbackDaysRaw) ? Math.max(1, Math.min(lookbackDaysRaw, 366)) : 30;
            const currency = normText(req.body?.currency || 'USD', 10).toUpperCase();

            const periodEnd = new Date();
            const periodStart = new Date(periodEnd.getTime() - (lookbackDays * 24 * 60 * 60 * 1000));

            const sub = await resolveLatestSubscription(pool, tenantId);
            if (!sub) {
                return res.status(404).json({ success: false, error: 'subscription_not_found' });
            }

            const cycle = String(sub.cycle || 'monthly').toLowerCase();
            const planAmount = cycle === 'yearly'
                ? Number(sub.yearly_price || 0)
                : Number(sub.monthly_price || 0);

            const usage = await computeUsageCharges(pool, tenantId, {
                periodStart: periodStart.toISOString(),
                periodEnd: periodEnd.toISOString()
            });

            const totalAmount = Number((planAmount + usage.usageAmount).toFixed(2));
            const breakdown = {
                plan: {
                    plan_key: sub.plan_key,
                    cycle,
                    amount: planAmount
                },
                usage: usage.usageItems,
                lookback_days: lookbackDays
            };

            const ins = await pool.query(
                `INSERT INTO saas_invoices (
                    tenant_id, subscription_id, period_start, period_end, currency,
                    plan_amount, usage_amount, total_amount, status, breakdown_json, generated_by_user_id
                 ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'issued',$9,$10)
                 RETURNING *`,
                [
                    tenantId,
                    sub.id,
                    periodStart.toISOString(),
                    periodEnd.toISOString(),
                    currency,
                    planAmount,
                    usage.usageAmount,
                    totalAmount,
                    JSON.stringify(breakdown),
                    req.auth?.uid || null
                ]
            );

            await writeAuditSafe(writeAdminAudit, req, {
                action: 'saas.invoice.generate',
                entity_type: 'saas_invoice',
                entity_id: String(ins.rows[0].id),
                meta: { tenant_id: tenantId, total_amount: totalAmount, currency }
            });

            return res.status(201).json({ success: true, data: ins.rows[0] });
        } catch (e) {
            return res.status(500).json({ success: false, error: e.message || 'generate_invoice_failed' });
        }
    });

    app.get('/api/admin/saas/tenants/:id/invoices', requirePermission('admin.executive.read', 'admin.ops.read'), async (req, res) => {
        try {
            const tenantId = Number(req.params.id);
            const limitRaw = Number(req.query?.limit);
            const limit = Number.isFinite(limitRaw) ? Math.max(1, Math.min(limitRaw, 200)) : 50;

            if (!Number.isFinite(tenantId) || tenantId <= 0) {
                return res.status(400).json({ success: false, error: 'invalid_tenant_id' });
            }

            const rows = await pool.query(
                `SELECT id, tenant_id, subscription_id, period_start, period_end, currency,
                        plan_amount, usage_amount, total_amount, status, breakdown_json,
                        generated_by_user_id, generated_at, paid_at, created_at, updated_at
                 FROM saas_invoices
                 WHERE tenant_id = $1
                 ORDER BY created_at DESC
                 LIMIT $2`,
                [tenantId, limit]
            );

            return res.json({ success: true, count: rows.rows.length, data: rows.rows });
        } catch (e) {
            return res.status(500).json({ success: false, error: e.message || 'list_invoices_failed' });
        }
    });

    app.patch('/api/admin/saas/invoices/:id/status', requirePermission('admin.executive.write', 'admin.ops.write'), async (req, res) => {
        try {
            const invoiceId = Number(req.params.id);
            const status = invoiceStatusFromInput(req.body?.status);

            if (!Number.isFinite(invoiceId) || invoiceId <= 0) {
                return res.status(400).json({ success: false, error: 'invalid_invoice_id' });
            }
            if (!status) {
                return res.status(400).json({ success: false, error: 'invalid_invoice_status' });
            }

            const upd = await pool.query(
                `UPDATE saas_invoices
                 SET status = $2::text,
                     paid_at = CASE WHEN $2::text = 'paid' THEN CURRENT_TIMESTAMP ELSE paid_at END,
                     updated_at = CURRENT_TIMESTAMP
                 WHERE id = $1
                 RETURNING *`,
                [invoiceId, status]
            );

            if (!upd.rows[0]) {
                return res.status(404).json({ success: false, error: 'invoice_not_found' });
            }

            await writeAuditSafe(writeAdminAudit, req, {
                action: 'saas.invoice.status.update',
                entity_type: 'saas_invoice',
                entity_id: String(invoiceId),
                meta: { status }
            });

            return res.json({ success: true, data: upd.rows[0] });
        } catch (e) {
            return res.status(500).json({ success: false, error: e.message || 'update_invoice_status_failed' });
        }
    });

    app.get('/api/admin/saas/invoices/:id/payments', requirePermission('admin.executive.read', 'admin.ops.read'), async (req, res) => {
        try {
            const invoiceId = Number(req.params.id);
            if (!Number.isFinite(invoiceId) || invoiceId <= 0) {
                return res.status(400).json({ success: false, error: 'invalid_invoice_id' });
            }

            const rows = await pool.query(
                `SELECT id, invoice_id, tenant_id, provider, provider_event_id, status, amount, currency,
                        paid_at, meta_json, created_by_user_id, created_at
                 FROM saas_invoice_payments
                 WHERE invoice_id = $1
                 ORDER BY created_at DESC`,
                [invoiceId]
            );

            return res.json({ success: true, count: rows.rows.length, data: rows.rows });
        } catch (e) {
            return res.status(500).json({ success: false, error: e.message || 'list_invoice_payments_failed' });
        }
    });

    app.post('/api/admin/saas/invoices/:id/payments', requirePermission('admin.executive.write', 'admin.ops.write'), async (req, res) => {
        try {
            const invoiceId = Number(req.params.id);
            if (!Number.isFinite(invoiceId) || invoiceId <= 0) {
                return res.status(400).json({ success: false, error: 'invalid_invoice_id' });
            }

            const amount = Number(req.body?.amount);
            const currency = normText(req.body?.currency || 'USD', 10).toUpperCase();
            const status = paymentStatusFromInput(req.body?.status);
            const provider = normKey(req.body?.provider || 'manual', 40) || 'manual';
            const providerEventId = normText(req.body?.provider_event_id, 140) || null;
            const paidAt = req.body?.paid_at ? new Date(req.body.paid_at) : new Date();
            const meta = normJson(req.body?.meta_json) || {};

            if (!Number.isFinite(amount) || amount <= 0) {
                return res.status(400).json({ success: false, error: 'invalid_payment_amount' });
            }

            const inv = await pool.query('SELECT id, tenant_id FROM saas_invoices WHERE id = $1 LIMIT 1', [invoiceId]);
            if (!inv.rows[0]) {
                return res.status(404).json({ success: false, error: 'invoice_not_found' });
            }

            const inserted = await pool.query(
                `INSERT INTO saas_invoice_payments (
                    invoice_id, tenant_id, provider, provider_event_id, status,
                    amount, currency, paid_at, meta_json, created_by_user_id
                 ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
                 ON CONFLICT (provider, provider_event_id)
                 WHERE provider_event_id IS NOT NULL
                 DO UPDATE SET
                    status = EXCLUDED.status,
                    amount = EXCLUDED.amount,
                    currency = EXCLUDED.currency,
                    paid_at = EXCLUDED.paid_at,
                    meta_json = EXCLUDED.meta_json
                 RETURNING *`,
                [
                    invoiceId,
                    inv.rows[0].tenant_id,
                    provider,
                    providerEventId,
                    status,
                    amount,
                    currency,
                    Number.isFinite(paidAt.getTime()) ? paidAt.toISOString() : new Date().toISOString(),
                    JSON.stringify(meta),
                    req.auth?.uid || null
                ]
            );

            const invoiceState = await applyInvoicePaidStatus(pool, invoiceId);

            await writeAuditSafe(writeAdminAudit, req, {
                action: 'saas.invoice.payment.record',
                entity_type: 'saas_invoice_payment',
                entity_id: String(inserted.rows[0].id),
                meta: { invoice_id: invoiceId, amount, currency, provider, status }
            });

            return res.status(201).json({
                success: true,
                data: inserted.rows[0],
                invoice_state: invoiceState
            });
        } catch (e) {
            return res.status(500).json({ success: false, error: e.message || 'record_invoice_payment_failed' });
        }
    });

    app.get('/api/admin/saas/invoices/:id/payment-attempts', requirePermission('admin.executive.read', 'admin.ops.read'), async (req, res) => {
        try {
            const invoiceId = Number(req.params.id);
            const limitRaw = Number(req.query?.limit);
            const limit = Number.isFinite(limitRaw) ? Math.max(1, Math.min(limitRaw, 200)) : 100;
            if (!Number.isFinite(invoiceId) || invoiceId <= 0) {
                return res.status(400).json({ success: false, error: 'invalid_invoice_id' });
            }

            const rows = await pool.query(
                `SELECT id, invoice_id, tenant_id, provider, idempotency_key, attempt_no, requested_amount,
                        currency, status, provider_payment_id, provider_response_json, error_message,
                        processed_at, created_by_user_id, created_at, updated_at
                 FROM saas_invoice_payment_attempts
                 WHERE invoice_id = $1
                 ORDER BY created_at DESC
                 LIMIT $2`,
                [invoiceId, limit]
            );

            return res.json({ success: true, count: rows.rows.length, data: rows.rows });
        } catch (e) {
            return res.status(500).json({ success: false, error: e.message || 'list_payment_attempts_failed' });
        }
    });

    app.post('/api/admin/saas/invoices/:id/collect', requirePermission('admin.executive.write', 'admin.ops.write'), async (req, res) => {
        try {
            const invoiceId = Number(req.params.id);
            if (!Number.isFinite(invoiceId) || invoiceId <= 0) {
                return res.status(400).json({ success: false, error: 'invalid_invoice_id' });
            }

            const balance = await getInvoiceBalance(pool, invoiceId);
            if (!balance) {
                return res.status(404).json({ success: false, error: 'invoice_not_found' });
            }
            if (String(balance.invoice.status || '').toLowerCase() === 'void') {
                return res.status(409).json({ success: false, error: 'invoice_is_void' });
            }

            const provider = normKey(req.body?.provider || 'mockpay', 40) || 'mockpay';
            const currency = normText(req.body?.currency || balance.invoice.currency || 'USD', 10).toUpperCase();
            const requestedAmountRaw = Number(req.body?.amount);
            const requestedAmount = Number.isFinite(requestedAmountRaw) && requestedAmountRaw > 0
                ? Number(requestedAmountRaw.toFixed(2))
                : Number(balance.due_total.toFixed(2));
            const idempotencyKey = normText(req.body?.idempotency_key, 140) || `${provider}_inv_${invoiceId}_${Date.now()}`;
            const forceFail = Boolean(req.body?.force_fail);

            if (requestedAmount <= 0) {
                const invoiceState = await applyInvoicePaidStatus(pool, invoiceId);
                return res.json({
                    success: true,
                    message: 'invoice_already_fully_paid',
                    invoice_state: invoiceState
                });
            }

            const existing = await pool.query(
                `SELECT *
                 FROM saas_invoice_payment_attempts
                 WHERE provider = $1
                   AND idempotency_key = $2
                 LIMIT 1`,
                [provider, idempotencyKey]
            );
            if (existing.rows[0]) {
                const invoiceState = await applyInvoicePaidStatus(pool, invoiceId);
                return res.json({ success: true, deduplicated: true, data: existing.rows[0], invoice_state: invoiceState });
            }

            const attemptNo = await nextAttemptNo(pool, invoiceId);
            const created = await pool.query(
                `INSERT INTO saas_invoice_payment_attempts (
                    invoice_id, tenant_id, provider, idempotency_key, attempt_no, requested_amount,
                    currency, status, created_by_user_id
                 ) VALUES ($1,$2,$3,$4,$5,$6,$7,'processing',$8)
                 RETURNING *`,
                [
                    invoiceId,
                    balance.invoice.tenant_id,
                    provider,
                    idempotencyKey,
                    attemptNo,
                    requestedAmount,
                    currency,
                    req.auth?.uid || null
                ]
            );
            const attempt = created.rows[0];

            const gateway = simulateProviderCharge({
                provider,
                invoiceId,
                amount: requestedAmount,
                currency,
                requestId: idempotencyKey,
                forceFail
            });

            let finalAttempt = attempt;
            if (!gateway.ok) {
                const failed = await pool.query(
                    `UPDATE saas_invoice_payment_attempts
                     SET status = 'failed',
                         error_message = $2,
                         provider_response_json = $3,
                         processed_at = CURRENT_TIMESTAMP,
                         updated_at = CURRENT_TIMESTAMP
                     WHERE id = $1
                     RETURNING *`,
                    [attempt.id, gateway.message || 'provider_failed', JSON.stringify(gateway.raw || {})]
                );
                finalAttempt = failed.rows[0] || attempt;
                await writeAuditSafe(writeAdminAudit, req, {
                    action: 'saas.invoice.collect.failed',
                    entity_type: 'saas_payment_attempt',
                    entity_id: String(attempt.id),
                    meta: { invoice_id: invoiceId, amount: requestedAmount, provider, error: gateway.message }
                });
                const invoiceState = await applyInvoicePaidStatus(pool, invoiceId);
                return res.status(402).json({ success: false, error: 'payment_collection_failed', data: finalAttempt, invoice_state: invoiceState });
            }

            const succeeded = await pool.query(
                `UPDATE saas_invoice_payment_attempts
                 SET status = 'succeeded',
                     provider_payment_id = $2,
                     provider_response_json = $3,
                     processed_at = CURRENT_TIMESTAMP,
                     updated_at = CURRENT_TIMESTAMP
                 WHERE id = $1
                 RETURNING *`,
                [attempt.id, gateway.provider_payment_id, JSON.stringify(gateway.raw || {})]
            );
            finalAttempt = succeeded.rows[0] || attempt;

            await pool.query(
                `INSERT INTO saas_invoice_payments (
                    invoice_id, tenant_id, provider, provider_event_id, status,
                    amount, currency, paid_at, meta_json, created_by_user_id
                 ) VALUES ($1,$2,$3,$4,'succeeded',$5,$6,CURRENT_TIMESTAMP,$7,$8)
                 ON CONFLICT (provider, provider_event_id)
                 WHERE provider_event_id IS NOT NULL
                 DO UPDATE SET
                    status = EXCLUDED.status,
                    amount = EXCLUDED.amount,
                    currency = EXCLUDED.currency,
                    paid_at = EXCLUDED.paid_at,
                    meta_json = EXCLUDED.meta_json`,
                [
                    invoiceId,
                    balance.invoice.tenant_id,
                    provider,
                    gateway.provider_payment_id,
                    requestedAmount,
                    currency,
                    JSON.stringify({ source: 'collect_endpoint', attempt_id: finalAttempt.id }),
                    req.auth?.uid || null
                ]
            );

            const invoiceState = await applyInvoicePaidStatus(pool, invoiceId);
            await writeAuditSafe(writeAdminAudit, req, {
                action: 'saas.invoice.collect.succeeded',
                entity_type: 'saas_payment_attempt',
                entity_id: String(finalAttempt.id),
                meta: { invoice_id: invoiceId, amount: requestedAmount, provider, provider_payment_id: gateway.provider_payment_id }
            });

            return res.status(201).json({ success: true, data: finalAttempt, invoice_state: invoiceState });
        } catch (e) {
            return res.status(500).json({ success: false, error: e.message || 'collect_invoice_failed' });
        }
    });

    app.post('/api/admin/saas/invoices/:id/collect/retry', requirePermission('admin.executive.write', 'admin.ops.write'), async (req, res) => {
        try {
            const invoiceId = Number(req.params.id);
            if (!Number.isFinite(invoiceId) || invoiceId <= 0) {
                return res.status(400).json({ success: false, error: 'invalid_invoice_id' });
            }

            const latest = await pool.query(
                `SELECT id, provider, requested_amount, currency, status
                 FROM saas_invoice_payment_attempts
                 WHERE invoice_id = $1
                 ORDER BY created_at DESC
                 LIMIT 1`,
                [invoiceId]
            );
            const prev = latest.rows[0] || null;
            if (!prev) {
                return res.status(404).json({ success: false, error: 'no_previous_attempt' });
            }
            if (String(prev.status || '').toLowerCase() === 'succeeded') {
                const invoiceState = await applyInvoicePaidStatus(pool, invoiceId);
                return res.status(409).json({ success: false, error: 'latest_attempt_already_succeeded', invoice_state: invoiceState });
            }

            req.body = {
                provider: req.body?.provider || prev.provider,
                amount: Number.isFinite(Number(req.body?.amount)) ? Number(req.body.amount) : Number(prev.requested_amount || 0),
                currency: req.body?.currency || prev.currency || 'USD',
                idempotency_key: normText(req.body?.idempotency_key, 140) || `${normKey(prev.provider || 'mockpay', 40)}_retry_${invoiceId}_${Date.now()}`,
                force_fail: Boolean(req.body?.force_fail)
            };

            return app._router.handle({
                ...req,
                method: 'POST',
                url: `/api/admin/saas/invoices/${invoiceId}/collect`,
                originalUrl: `/api/admin/saas/invoices/${invoiceId}/collect`
            }, res, () => null);
        } catch (e) {
            return res.status(500).json({ success: false, error: e.message || 'retry_collect_failed' });
        }
    });

    app.get('/api/admin/saas/tenants/:id/reconciliation', requirePermission('admin.executive.read', 'admin.ops.read'), async (req, res) => {
        try {
            const tenantId = Number(req.params.id);
            if (!Number.isFinite(tenantId) || tenantId <= 0) {
                return res.status(400).json({ success: false, error: 'invalid_tenant_id' });
            }

            const fromRaw = normText(req.query?.from, 40);
            const toRaw = normText(req.query?.to, 40);
            const from = fromRaw ? new Date(fromRaw) : new Date(Date.now() - (30 * 24 * 60 * 60 * 1000));
            const to = toRaw ? new Date(toRaw) : new Date();
            if (!Number.isFinite(from.getTime()) || !Number.isFinite(to.getTime()) || to <= from) {
                return res.status(400).json({ success: false, error: 'invalid_date_range' });
            }

            const sums = await pool.query(
                `SELECT
                    COALESCE(SUM(i.total_amount),0)::numeric(14,2) AS invoiced_total,
                    COALESCE(SUM(CASE WHEN i.status = 'paid' THEN i.total_amount ELSE 0 END),0)::numeric(14,2) AS invoice_paid_marked_total
                 FROM saas_invoices i
                 WHERE i.tenant_id = $1
                   AND i.created_at >= $2
                   AND i.created_at < $3`,
                [tenantId, from.toISOString(), to.toISOString()]
            );

            const payments = await pool.query(
                `SELECT
                    COALESCE(SUM(p.amount),0)::numeric(14,2) AS payments_total,
                    COUNT(*)::bigint AS payments_count
                 FROM saas_invoice_payments p
                 WHERE p.tenant_id = $1
                   AND p.status IN ('succeeded','paid')
                   AND p.created_at >= $2
                   AND p.created_at < $3`,
                [tenantId, from.toISOString(), to.toISOString()]
            );

            const attempts = await pool.query(
                `SELECT
                    COUNT(*)::bigint AS attempts_count,
                    COUNT(*) FILTER (WHERE status = 'succeeded')::bigint AS attempts_succeeded,
                    COUNT(*) FILTER (WHERE status = 'failed')::bigint AS attempts_failed
                 FROM saas_invoice_payment_attempts
                 WHERE tenant_id = $1
                   AND created_at >= $2
                   AND created_at < $3`,
                [tenantId, from.toISOString(), to.toISOString()]
            );

            const summary = {
                tenant_id: tenantId,
                period: { from: from.toISOString(), to: to.toISOString() },
                invoiced_total: Number(sums.rows?.[0]?.invoiced_total || 0),
                invoice_paid_marked_total: Number(sums.rows?.[0]?.invoice_paid_marked_total || 0),
                payments_total: Number(payments.rows?.[0]?.payments_total || 0),
                payments_count: Number(payments.rows?.[0]?.payments_count || 0),
                attempts_count: Number(attempts.rows?.[0]?.attempts_count || 0),
                attempts_succeeded: Number(attempts.rows?.[0]?.attempts_succeeded || 0),
                attempts_failed: Number(attempts.rows?.[0]?.attempts_failed || 0)
            };

            summary.unreconciled_delta = Number((summary.invoiced_total - summary.payments_total).toFixed(2));

            return res.json({ success: true, data: summary });
        } catch (e) {
            return res.status(500).json({ success: false, error: e.message || 'reconciliation_report_failed' });
        }
    });

    app.post('/api/saas/billing/webhooks/generic', async (req, res) => {
        try {
            const signature = String(req.headers['x-billing-signature'] || '').trim();
            const rawBody = JSON.stringify(req.body || {});
            const signatureValid = isWebhookSignatureValid(rawBody, signature);
            if (!signatureValid) {
                return res.status(401).json({ success: false, error: 'invalid_webhook_signature' });
            }

            const provider = normKey(req.body?.provider || 'generic', 40) || 'generic';
            const eventId = normText(req.body?.event_id, 140);
            const invoiceId = Number(req.body?.invoice_id);
            const amount = Number(req.body?.amount);
            const currency = normText(req.body?.currency || 'USD', 10).toUpperCase();
            const status = paymentStatusFromInput(req.body?.status);

            if (!eventId) return res.status(400).json({ success: false, error: 'event_id_required' });
            if (!Number.isFinite(invoiceId) || invoiceId <= 0) return res.status(400).json({ success: false, error: 'invoice_id_required' });
            if (!Number.isFinite(amount) || amount <= 0) return res.status(400).json({ success: false, error: 'amount_required' });

            const webhook = await pool.query(
                `INSERT INTO saas_billing_webhook_events (provider, event_id, invoice_id, payload_json, signature_valid, processed)
                 VALUES ($1,$2,$3,$4,$5,false)
                 ON CONFLICT (provider, event_id)
                 DO UPDATE SET payload_json = EXCLUDED.payload_json
                 RETURNING *`,
                [provider, eventId, invoiceId, rawBody, true]
            );

            const inv = await pool.query('SELECT id, tenant_id FROM saas_invoices WHERE id = $1 LIMIT 1', [invoiceId]);
            if (!inv.rows[0]) {
                return res.status(404).json({ success: false, error: 'invoice_not_found' });
            }

            await pool.query(
                `INSERT INTO saas_invoice_payments (
                    invoice_id, tenant_id, provider, provider_event_id, status,
                    amount, currency, paid_at, meta_json, created_by_user_id
                 ) VALUES ($1,$2,$3,$4,$5,$6,$7,CURRENT_TIMESTAMP,$8,NULL)
                 ON CONFLICT (provider, provider_event_id)
                 WHERE provider_event_id IS NOT NULL
                 DO UPDATE SET
                    status = EXCLUDED.status,
                    amount = EXCLUDED.amount,
                    currency = EXCLUDED.currency,
                    paid_at = EXCLUDED.paid_at,
                    meta_json = EXCLUDED.meta_json`,
                [
                    invoiceId,
                    inv.rows[0].tenant_id,
                    provider,
                    eventId,
                    status,
                    amount,
                    currency,
                    JSON.stringify({ source: 'webhook', webhook_id: webhook.rows?.[0]?.id || null })
                ]
            );

            const invoiceState = await applyInvoicePaidStatus(pool, invoiceId);

            await pool.query(
                'UPDATE saas_billing_webhook_events SET processed = true WHERE id = $1',
                [webhook.rows[0].id]
            );

            return res.json({ success: true, invoice_state: invoiceState });
        } catch (e) {
            return res.status(500).json({ success: false, error: e.message || 'billing_webhook_failed' });
        }
    });
}

module.exports = {
    ensureSaasTables,
    makeTenantMiddleware,
    registerSaasRoutes
};
