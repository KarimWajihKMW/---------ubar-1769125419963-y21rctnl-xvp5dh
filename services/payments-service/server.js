const express = require('express');
const promClient = require('prom-client');
const { Pool } = require('pg');
const { timingSafeEqual } = require('crypto');
const { createPaymentProvider } = require('./provider-adapter');

const app = express();
const PORT = Number(process.env.PAYMENTS_SERVICE_PORT || 4102);
const useDatabase = Boolean(process.env.DATABASE_URL);
const pool = useDatabase ? new Pool({ connectionString: process.env.DATABASE_URL }) : null;
const inMemoryWallets = new Map();
const inMemoryOnlinePayments = [];
const inMemoryWebhookEvents = [];
const paymentWebhookSecret = process.env.PAYMENT_WEBHOOK_SECRET || 'payment-webhook-dev-secret';
const paymentProviderName = process.env.PAYMENT_PROVIDER || 'mockpay';
const paymentMockCheckoutBaseUrl = process.env.MOCKPAY_PAYMENT_CHECKOUT_BASE_URL || 'https://mockpay.local';

const paymentProvider = createPaymentProvider({
    provider: paymentProviderName,
    webhookSecret: paymentWebhookSecret,
    mockCheckoutBaseUrl: paymentMockCheckoutBaseUrl
});

const metricsRegistry = new promClient.Registry();
promClient.collectDefaultMetrics({ register: metricsRegistry, prefix: 'ubar_payments_service_' });
const requestCounter = new promClient.Counter({
    name: 'ubar_payments_service_http_requests_total',
    help: 'Total HTTP requests handled by payments service',
    labelNames: ['method', 'route', 'status_code'],
    registers: [metricsRegistry]
});

app.use(express.json());

function getTenantId(req) {
    const tenantId = String(req.headers['x-tenant-id'] || 'public').trim();
    return tenantId || 'public';
}

function walletKey(tenantId, userId) {
    return `${tenantId}:${userId}`;
}

async function ensureSchema() {
    if (!pool) return;

    await pool.query(`
        CREATE TABLE IF NOT EXISTS ms_wallet_accounts (
            id BIGSERIAL PRIMARY KEY,
            tenant_id TEXT NOT NULL,
            user_id TEXT NOT NULL,
            role TEXT NOT NULL DEFAULT 'rider',
            balance NUMERIC(14,2) NOT NULL DEFAULT 0,
            updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            UNIQUE (tenant_id, user_id)
        )
    `);

    await pool.query(`
        CREATE TABLE IF NOT EXISTS ms_wallet_transactions (
            id BIGSERIAL PRIMARY KEY,
            tenant_id TEXT NOT NULL,
            user_id TEXT NOT NULL,
            type TEXT NOT NULL,
            amount NUMERIC(14,2) NOT NULL,
            reference_id TEXT,
            metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
    `);

    await pool.query(`
        CREATE TABLE IF NOT EXISTS ms_withdrawal_requests (
            id BIGSERIAL PRIMARY KEY,
            tenant_id TEXT NOT NULL,
            user_id TEXT NOT NULL,
            amount NUMERIC(14,2) NOT NULL,
            status TEXT NOT NULL DEFAULT 'pending',
            method TEXT NOT NULL DEFAULT 'bank_transfer',
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            reviewed_at TIMESTAMPTZ
        )
    `);

    await pool.query(`
        CREATE TABLE IF NOT EXISTS ms_online_payments (
            id BIGSERIAL PRIMARY KEY,
            tenant_id TEXT NOT NULL,
            user_id TEXT NOT NULL,
            trip_id TEXT,
            amount NUMERIC(14,2) NOT NULL,
            currency TEXT NOT NULL DEFAULT 'SAR',
            status TEXT NOT NULL DEFAULT 'pending',
            provider TEXT NOT NULL,
            provider_reference TEXT,
            checkout_id TEXT,
            metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            paid_at TIMESTAMPTZ
        )
    `);

    await pool.query(`
        CREATE TABLE IF NOT EXISTS ms_online_payment_webhook_events (
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

function signPaymentWebhookPayload(payload) {
    return paymentProvider.signWebhookPayload(payload);
}

function verifyPaymentWebhookSignature(payload, signature) {
    if (!signature) return false;
    const expected = signPaymentWebhookPayload(payload);
    const a = Buffer.from(String(expected));
    const b = Buffer.from(String(signature));
    if (a.length !== b.length) return false;
    return timingSafeEqual(a, b);
}

async function createOnlinePaymentIntent({ tenantId, userId, tripId, amount, currency, metadata = {} }) {
    if (pool) {
        const result = await pool.query(
            `INSERT INTO ms_online_payments
             (tenant_id, user_id, trip_id, amount, currency, status, provider, metadata)
             VALUES ($1, $2, $3, $4, $5, 'pending', $6, $7)
             RETURNING id, tenant_id, user_id, trip_id, amount::float8 AS amount, currency, status,
                provider, provider_reference, checkout_id, metadata, created_at, updated_at, paid_at`,
            [tenantId, userId, tripId || null, amount, currency, paymentProvider.name, metadata]
        );
        return result.rows[0];
    }

    const row = {
        id: `pay-${Date.now()}-${Math.floor(Math.random() * 1000)}`,
        tenant_id: tenantId,
        user_id: userId,
        trip_id: tripId || null,
        amount,
        currency,
        status: 'pending',
        provider: paymentProvider.name,
        provider_reference: null,
        checkout_id: null,
        metadata,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        paid_at: null
    };
    inMemoryOnlinePayments.push(row);
    return row;
}

async function findOnlinePayment(paymentId) {
    if (pool) {
        const result = await pool.query(
            `SELECT id, tenant_id, user_id, trip_id, amount::float8 AS amount, currency, status,
                provider, provider_reference, checkout_id, metadata, created_at, updated_at, paid_at
             FROM ms_online_payments
             WHERE id::text = $1`,
            [String(paymentId)]
        );
        return result.rows[0] || null;
    }
    return inMemoryOnlinePayments.find((x) => String(x.id) === String(paymentId)) || null;
}

async function updateOnlinePaymentCheckout(paymentId, checkout) {
    if (pool) {
        const result = await pool.query(
            `UPDATE ms_online_payments
             SET provider_reference = COALESCE($2, provider_reference),
                 checkout_id = COALESCE($3, checkout_id),
                 metadata = COALESCE(metadata, '{}'::jsonb) || $4::jsonb,
                 updated_at = NOW()
             WHERE id::text = $1
             RETURNING id, tenant_id, user_id, trip_id, amount::float8 AS amount, currency, status,
                provider, provider_reference, checkout_id, metadata, created_at, updated_at, paid_at`,
            [String(paymentId), checkout.provider_reference || null, checkout.checkout_id || null, { payment_checkout: checkout }]
        );
        return result.rows[0] || null;
    }

    const row = await findOnlinePayment(paymentId);
    if (!row) return null;
    row.provider_reference = checkout.provider_reference || row.provider_reference;
    row.checkout_id = checkout.checkout_id || row.checkout_id;
    row.metadata = { ...(row.metadata || {}), payment_checkout: checkout };
    row.updated_at = new Date().toISOString();
    return row;
}

async function markOnlinePaymentStatus(paymentId, status, providerReference, paidAt) {
    if (pool) {
        const result = await pool.query(
            `UPDATE ms_online_payments
             SET status = $2,
                 provider_reference = COALESCE($3, provider_reference),
                 paid_at = CASE WHEN $2 = 'paid' THEN COALESCE($4::timestamptz, NOW()) ELSE paid_at END,
                 updated_at = NOW()
             WHERE id::text = $1
             RETURNING id, tenant_id, user_id, trip_id, amount::float8 AS amount, currency, status,
                provider, provider_reference, checkout_id, metadata, created_at, updated_at, paid_at`,
            [String(paymentId), status, providerReference || null, paidAt || null]
        );
        return result.rows[0] || null;
    }

    const row = await findOnlinePayment(paymentId);
    if (!row) return null;
    row.status = status;
    if (providerReference) row.provider_reference = providerReference;
    if (status === 'paid') row.paid_at = paidAt || new Date().toISOString();
    row.updated_at = new Date().toISOString();
    return row;
}

async function listPendingOnlinePayments(tenantId) {
    if (pool) {
        const values = [];
        let where = `WHERE status = 'pending'`;
        if (tenantId) {
            values.push(tenantId);
            where += ' AND tenant_id = $1';
        }
        const result = await pool.query(
            `SELECT id, tenant_id, user_id, trip_id, amount::float8 AS amount, currency, status,
                provider, provider_reference, checkout_id, metadata, created_at, updated_at, paid_at
             FROM ms_online_payments
             ${where}
             ORDER BY id ASC
             LIMIT 200`,
            values
        );
        return result.rows;
    }
    return inMemoryOnlinePayments.filter((x) => x.status === 'pending' && (!tenantId || x.tenant_id === tenantId));
}

async function getOrCreateBalance(tenantId, userId, role = 'rider') {
    if (!pool) {
        const key = walletKey(tenantId, userId);
        if (!inMemoryWallets.has(key)) {
            inMemoryWallets.set(key, { tenant_id: tenantId, user_id: userId, role, balance: 0 });
        }
        return inMemoryWallets.get(key);
    }

    await pool.query(
        `INSERT INTO ms_wallet_accounts (tenant_id, user_id, role)
         VALUES ($1, $2, $3)
         ON CONFLICT (tenant_id, user_id) DO NOTHING`,
        [tenantId, userId, role]
    );

    const account = await pool.query(
        `SELECT tenant_id, user_id, role, balance::float8 AS balance
         FROM ms_wallet_accounts
         WHERE tenant_id = $1 AND user_id = $2`,
        [tenantId, userId]
    );

    return account.rows[0];
}

async function addTransaction(tenantId, userId, type, amount, referenceId, metadata = {}) {
    if (!pool) return;
    await pool.query(
        `INSERT INTO ms_wallet_transactions (tenant_id, user_id, type, amount, reference_id, metadata)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [tenantId, userId, type, amount, referenceId || null, metadata]
    );
}

async function applyWalletDelta({ tenantId, userId, role, deltaAmount, type, referenceId, metadata }) {
    if (!pool) {
        const key = walletKey(tenantId, userId);
        const account = await getOrCreateBalance(tenantId, userId, role);
        const nextBalance = Number((Number(account.balance || 0) + deltaAmount).toFixed(2));
        if (nextBalance < 0) {
            throw new Error('insufficient_balance');
        }
        account.balance = nextBalance;
        inMemoryWallets.set(key, account);
        return account;
    }

    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        await client.query(
            `INSERT INTO ms_wallet_accounts (tenant_id, user_id, role)
             VALUES ($1, $2, $3)
             ON CONFLICT (tenant_id, user_id) DO NOTHING`,
            [tenantId, userId, role]
        );

        const current = await client.query(
            `SELECT balance::float8 AS balance
             FROM ms_wallet_accounts
             WHERE tenant_id = $1 AND user_id = $2
             FOR UPDATE`,
            [tenantId, userId]
        );

        const currentBalance = Number(current.rows[0]?.balance || 0);
        const nextBalance = Number((currentBalance + deltaAmount).toFixed(2));
        if (nextBalance < 0) {
            throw new Error('insufficient_balance');
        }

        await client.query(
            `UPDATE ms_wallet_accounts
             SET balance = $3, updated_at = NOW()
             WHERE tenant_id = $1 AND user_id = $2`,
            [tenantId, userId, nextBalance]
        );

        await client.query(
            `INSERT INTO ms_wallet_transactions (tenant_id, user_id, type, amount, reference_id, metadata)
             VALUES ($1, $2, $3, $4, $5, $6)`,
            [tenantId, userId, type, deltaAmount, referenceId || null, metadata || {}]
        );

        await client.query('COMMIT');
        return { tenant_id: tenantId, user_id: userId, role, balance: nextBalance };
    } catch (error) {
        await client.query('ROLLBACK');
        throw error;
    } finally {
        client.release();
    }
}

app.use((req, res, next) => {
    res.on('finish', () => {
        const route = req.route && req.route.path ? String(req.route.path) : String(req.path || req.url || 'unknown');
        requestCounter.inc({ method: req.method, route, status_code: String(res.statusCode || 0) });
    });
    next();
});

app.get('/api/payments-service/health', (_req, res) => {
    return res.json({ success: true, service: 'payments-service', status: 'ok', database_mode: useDatabase ? 'postgres' : 'memory' });
});

app.get('/api/payments-service/provider/status', (_req, res) => {
    return res.json({
        success: true,
        data: {
            provider: paymentProvider.name,
            meta: paymentProvider.meta || { configured: true, mode: 'active' }
        }
    });
});

app.get('/metrics', async (_req, res) => {
    res.set('Content-Type', metricsRegistry.contentType);
    res.end(await metricsRegistry.metrics());
});

app.post('/api/payments-service/fare/calculate', (req, res) => {
    const distanceKm = Math.max(0, Number(req.body.distance_km || 0));
    const durationMin = Math.max(0, Number(req.body.duration_min || 0));
    const surge = Math.max(1, Number(req.body.surge_multiplier || 1));

    const baseFare = 6;
    const perKm = 2.3;
    const perMin = 0.4;

    const subtotal = baseFare + (distanceKm * perKm) + (durationMin * perMin);
    const total = Number((subtotal * surge).toFixed(2));

    return res.json({
        success: true,
        data: {
            tenant_id: getTenantId(req),
            currency: 'SAR',
            base_fare: baseFare,
            distance_km: distanceKm,
            duration_min: durationMin,
            surge_multiplier: surge,
            total
        }
    });
});

app.post('/api/payments-service/commission/calculate', (req, res) => {
    const tripTotal = Math.max(0, Number(req.body.trip_total || 0));
    const commissionRate = Math.max(0, Math.min(100, Number(req.body.commission_rate || 20)));

    const commission = Number(((tripTotal * commissionRate) / 100).toFixed(2));
    const driverNet = Number((tripTotal - commission).toFixed(2));

    return res.json({
        success: true,
        data: {
            tenant_id: getTenantId(req),
            trip_total: tripTotal,
            commission_rate: commissionRate,
            commission,
            driver_net: driverNet
        }
    });
});

app.get('/api/payments-service/wallet/:userId', async (req, res) => {
    try {
        const tenantId = getTenantId(req);
        const userId = String(req.params.userId || '').trim();
        const role = String(req.query.role || 'rider').trim();
        if (!userId) {
            return res.status(400).json({ success: false, error: 'user_id_required' });
        }

        const account = await getOrCreateBalance(tenantId, userId, role);
        return res.json({ success: true, data: account });
    } catch (error) {
        return res.status(500).json({ success: false, error: 'wallet_read_failed', message: error.message });
    }
});

app.post('/api/payments-service/wallet/topup', async (req, res) => {
    try {
        const tenantId = getTenantId(req);
        const userId = String(req.body.user_id || '').trim();
        const role = String(req.body.role || 'rider').trim();
        const amount = Math.max(0, Number(req.body.amount || 0));
        const referenceId = String(req.body.reference_id || '').trim();

        if (!userId || !amount) {
            return res.status(400).json({ success: false, error: 'user_id_and_amount_required' });
        }

        const account = await applyWalletDelta({
            tenantId,
            userId,
            role,
            deltaAmount: amount,
            type: 'topup',
            referenceId,
            metadata: { source: req.body.source || 'manual' }
        });

        return res.json({ success: true, data: account });
    } catch (error) {
        return res.status(500).json({ success: false, error: 'wallet_topup_failed', message: error.message });
    }
});

app.post('/api/payments-service/wallet/charge', async (req, res) => {
    try {
        const tenantId = getTenantId(req);
        const userId = String(req.body.user_id || '').trim();
        const role = String(req.body.role || 'rider').trim();
        const amount = Math.max(0, Number(req.body.amount || 0));
        const referenceId = String(req.body.reference_id || '').trim();

        if (!userId || !amount) {
            return res.status(400).json({ success: false, error: 'user_id_and_amount_required' });
        }

        const account = await applyWalletDelta({
            tenantId,
            userId,
            role,
            deltaAmount: -amount,
            type: 'charge',
            referenceId,
            metadata: { reason: req.body.reason || 'trip_payment' }
        });

        return res.json({ success: true, data: account });
    } catch (error) {
        if (error.message === 'insufficient_balance') {
            return res.status(422).json({ success: false, error: 'insufficient_balance' });
        }
        return res.status(500).json({ success: false, error: 'wallet_charge_failed', message: error.message });
    }
});

app.post('/api/payments-service/wallet/withdrawals/request', async (req, res) => {
    try {
        const tenantId = getTenantId(req);
        const userId = String(req.body.user_id || '').trim();
        const amount = Math.max(0, Number(req.body.amount || 0));
        const method = String(req.body.method || 'bank_transfer').trim();

        if (!userId || !amount) {
            return res.status(400).json({ success: false, error: 'user_id_and_amount_required' });
        }

        await applyWalletDelta({
            tenantId,
            userId,
            role: 'driver',
            deltaAmount: -amount,
            type: 'withdrawal_pending',
            referenceId: null,
            metadata: { method }
        });

        if (pool) {
            const result = await pool.query(
                `INSERT INTO ms_withdrawal_requests (tenant_id, user_id, amount, method)
                 VALUES ($1, $2, $3, $4)
                 RETURNING id, tenant_id, user_id, amount::float8 AS amount, method, status, created_at`,
                [tenantId, userId, amount, method]
            );
            return res.json({ success: true, data: result.rows[0] });
        }

        return res.json({
            success: true,
            data: {
                id: `mem-${Date.now()}`,
                tenant_id: tenantId,
                user_id: userId,
                amount,
                method,
                status: 'pending'
            }
        });
    } catch (error) {
        if (error.message === 'insufficient_balance') {
            return res.status(422).json({ success: false, error: 'insufficient_balance' });
        }
        return res.status(500).json({ success: false, error: 'withdrawal_request_failed', message: error.message });
    }
});

app.get('/api/payments-service/wallet/transactions/:userId', async (req, res) => {
    try {
        const tenantId = getTenantId(req);
        const userId = String(req.params.userId || '').trim();
        const limit = Math.max(1, Math.min(100, Number(req.query.limit || 20)));

        if (!userId) {
            return res.status(400).json({ success: false, error: 'user_id_required' });
        }

        if (!pool) {
            return res.json({ success: true, data: [], mode: 'memory' });
        }

        const result = await pool.query(
            `SELECT id, tenant_id, user_id, type, amount::float8 AS amount, reference_id, metadata, created_at
             FROM ms_wallet_transactions
             WHERE tenant_id = $1 AND user_id = $2
             ORDER BY id DESC
             LIMIT $3`,
            [tenantId, userId, limit]
        );

        return res.json({ success: true, data: result.rows });
    } catch (error) {
        return res.status(500).json({ success: false, error: 'wallet_transactions_failed', message: error.message });
    }
});

app.post('/api/payments-service/online/intent', async (req, res) => {
    try {
        const tenantId = getTenantId(req);
        const userId = String(req.body.user_id || '').trim();
        const tripId = req.body.trip_id ? String(req.body.trip_id).trim() : null;
        const amount = Math.max(0, Number(req.body.amount || 0));
        const currency = String(req.body.currency || 'SAR').trim().toUpperCase();

        if (!userId || !amount) {
            return res.status(400).json({ success: false, error: 'user_id_and_amount_required' });
        }

        const intent = await createOnlinePaymentIntent({
            tenantId,
            userId,
            tripId,
            amount,
            currency,
            metadata: { source: req.body.source || 'app' }
        });

        return res.json({ success: true, data: intent });
    } catch (error) {
        return res.status(500).json({ success: false, error: 'online_intent_failed', message: error.message });
    }
});

app.post('/api/payments-service/online/checkout/session', async (req, res) => {
    try {
        const paymentId = String(req.body.payment_id || '').trim();
        if (!paymentId) {
            return res.status(400).json({ success: false, error: 'payment_id_required' });
        }

        const payment = await findOnlinePayment(paymentId);
        if (!payment) {
            return res.status(404).json({ success: false, error: 'payment_not_found' });
        }

        const checkout = await paymentProvider.createCheckoutSession({
            tenantId: payment.tenant_id,
            paymentId: String(payment.id),
            amount: payment.amount,
            currency: payment.currency
        });

        await updateOnlinePaymentCheckout(String(payment.id), checkout);
        return res.json({ success: true, data: checkout });
    } catch (error) {
        return res.status(500).json({ success: false, error: 'online_checkout_failed', message: error.message });
    }
});

app.post('/api/payments-service/online/webhooks/provider', async (req, res) => {
    try {
        const payload = req.body || {};
        const signature = String(req.headers['x-payment-signature'] || '');
        const signatureValid = verifyPaymentWebhookSignature(payload, signature);
        const provider = String(payload.provider || paymentProvider.name).trim();
        const eventType = String(payload.event_type || '').trim();
        const tenantId = payload.tenant_id ? String(payload.tenant_id).trim().toLowerCase() : null;

        if (pool) {
            await pool.query(
                `INSERT INTO ms_online_payment_webhook_events (tenant_id, provider, event_type, signature_valid, payload)
                 VALUES ($1, $2, $3, $4, $5)`,
                [tenantId, provider, eventType || 'unknown', signatureValid, payload]
            );
        } else {
            inMemoryWebhookEvents.push({
                id: `pay-webhook-${Date.now()}-${Math.floor(Math.random() * 1000)}`,
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

        const paymentId = payload.payment_id ? String(payload.payment_id) : '';
        if ((eventType === 'payment.paid' || eventType === 'checkout.completed') && paymentId) {
            const payment = await markOnlinePaymentStatus(paymentId, 'paid', payload.provider_reference || null, payload.paid_at || null);
            if (!payment) {
                return res.status(404).json({ success: false, error: 'payment_not_found' });
            }
            return res.json({ success: true, data: { processed: true, payment } });
        }

        if ((eventType === 'payment.failed' || eventType === 'checkout.failed') && paymentId) {
            const payment = await markOnlinePaymentStatus(paymentId, 'failed', payload.provider_reference || null, null);
            if (!payment) {
                return res.status(404).json({ success: false, error: 'payment_not_found' });
            }
            return res.json({ success: true, data: { processed: true, payment } });
        }

        return res.json({ success: true, data: { processed: false } });
    } catch (error) {
        return res.status(500).json({ success: false, error: 'online_webhook_failed', message: error.message });
    }
});

app.post('/api/payments-service/online/reconciliation/run', async (req, res) => {
    try {
        const tenantId = req.body.tenant_id ? String(req.body.tenant_id).trim().toLowerCase() : null;
        const pending = await listPendingOnlinePayments(tenantId);
        const updated = [];

        for (const payment of pending) {
            const statusResult = await paymentProvider.getPaymentStatus({
                tenantId: payment.tenant_id,
                paymentId: String(payment.id),
                providerReference: payment.provider_reference
            });

            if (statusResult.status === 'paid') {
                const next = await markOnlinePaymentStatus(String(payment.id), 'paid', statusResult.provider_reference || payment.provider_reference, null);
                if (next) updated.push({ payment_id: next.id, status: next.status, tenant_id: next.tenant_id });
                continue;
            }

            if (statusResult.status === 'failed') {
                const next = await markOnlinePaymentStatus(String(payment.id), 'failed', statusResult.provider_reference || payment.provider_reference, null);
                if (next) updated.push({ payment_id: next.id, status: next.status, tenant_id: next.tenant_id });
            }
        }

        return res.json({ success: true, data: { checked: pending.length, updated } });
    } catch (error) {
        return res.status(500).json({ success: false, error: 'online_reconciliation_failed', message: error.message });
    }
});

app.get('/api/payments-service/online/reconciliation/summary', async (req, res) => {
    try {
        const tenantId = req.query.tenant_id ? String(req.query.tenant_id).trim().toLowerCase() : null;
        const pending = await listPendingOnlinePayments(tenantId);
        return res.json({
            success: true,
            data: {
                provider: paymentProvider.name,
                pending_count: pending.length,
                sample_payment_ids: pending.slice(0, 10).map((x) => x.id)
            }
        });
    } catch (error) {
        return res.status(500).json({ success: false, error: 'online_reconciliation_summary_failed', message: error.message });
    }
});

ensureSchema()
    .catch((error) => {
        console.error('⚠️ Payments schema init failed, service will continue:', error.message);
    })
    .finally(() => {
        app.listen(PORT, () => {
            console.log(`💳 Payments service listening on ${PORT}`);
        });
    });
