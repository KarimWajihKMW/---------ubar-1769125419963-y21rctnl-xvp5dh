const { createHmac } = require('crypto');

function toMinorUnits(amount, currency) {
    const normalized = String(currency || 'USD').toUpperCase();
    const zeroDecimal = new Set(['BIF', 'CLP', 'DJF', 'GNF', 'JPY', 'KMF', 'KRW', 'MGA', 'PYG', 'RWF', 'UGX', 'VND', 'VUV', 'XAF', 'XOF', 'XPF']);
    if (zeroDecimal.has(normalized)) {
        return Math.round(Number(amount || 0));
    }
    return Math.round(Number(amount || 0) * 100);
}

function fromMinorUnits(amountMinor, currency) {
    const normalized = String(currency || 'USD').toUpperCase();
    const zeroDecimal = new Set(['BIF', 'CLP', 'DJF', 'GNF', 'JPY', 'KMF', 'KRW', 'MGA', 'PYG', 'RWF', 'UGX', 'VND', 'VUV', 'XAF', 'XOF', 'XPF']);
    if (zeroDecimal.has(normalized)) {
        return Number(amountMinor || 0);
    }
    return Number((Number(amountMinor || 0) / 100).toFixed(2));
}

function buildMockProvider(config) {
    const providerName = 'mockpay';

    async function createCheckoutSession({ tenantId, invoiceId, amount, currency }) {
        const now = Date.now();
        return {
            provider: providerName,
            checkout_id: `chk_${tenantId}_${invoiceId}_${now}`,
            provider_reference: `mockpay_ref_${invoiceId}_${now}`,
            status: 'pending',
            amount,
            currency,
            checkout_url: `${config.mockCheckoutBaseUrl}/checkout/${tenantId}/${invoiceId}`
        };
    }

    async function getPaymentStatus({ providerReference }) {
        const normalized = String(providerReference || '').toLowerCase();
        if (normalized.includes('fail')) {
            return { provider: providerName, status: 'failed' };
        }
        return { provider: providerName, status: 'paid' };
    }

    function signWebhookPayload(payload) {
        return createHmac('sha256', config.webhookSecret)
            .update(JSON.stringify(payload))
            .digest('hex');
    }

    return {
        name: providerName,
        createCheckoutSession,
        getPaymentStatus,
        signWebhookPayload
    };
}

function buildStripeProvider(config) {
    const providerName = 'stripe';
    const apiBase = 'https://api.stripe.com/v1';
    const secretKey = String(config.stripeSecretKey || '').trim();
    const webhookSecret = String(config.stripeWebhookSecret || config.webhookSecret || '').trim();

    async function stripeRequest(path, bodyObj) {
        if (!secretKey) {
            throw new Error('stripe_secret_key_missing');
        }

        const form = new URLSearchParams();
        Object.entries(bodyObj || {}).forEach(([key, value]) => {
            if (value === null || value === undefined) return;
            form.append(key, String(value));
        });

        const response = await fetch(`${apiBase}${path}`, {
            method: 'POST',
            headers: {
                Authorization: `Bearer ${secretKey}`,
                'Content-Type': 'application/x-www-form-urlencoded'
            },
            body: form
        });

        const json = await response.json().catch(() => ({}));
        if (!response.ok) {
            const message = json?.error?.message || 'stripe_request_failed';
            throw new Error(message);
        }
        return json;
    }

    async function createCheckoutSession({ tenantId, invoiceId, amount, currency }) {
        const normalizedCurrency = String(currency || 'USD').toLowerCase();
        const amountMinor = toMinorUnits(amount, normalizedCurrency);

        const session = await stripeRequest('/checkout/sessions', {
            mode: 'payment',
            'line_items[0][price_data][currency]': normalizedCurrency,
            'line_items[0][price_data][product_data][name]': `Ubar SaaS Invoice ${invoiceId}`,
            'line_items[0][price_data][unit_amount]': amountMinor,
            'line_items[0][quantity]': 1,
            success_url: config.stripeSuccessUrl || 'https://example.com/billing/success',
            cancel_url: config.stripeCancelUrl || 'https://example.com/billing/cancel',
            'metadata[tenant_id]': tenantId,
            'metadata[invoice_id]': invoiceId
        });

        return {
            provider: providerName,
            checkout_id: session.id,
            provider_reference: session.payment_intent || session.id,
            status: 'pending',
            amount,
            currency: String(currency || 'USD').toUpperCase(),
            checkout_url: session.url || null
        };
    }

    async function getPaymentStatus({ providerReference, invoiceId }) {
        if (!secretKey) {
            return { provider: providerName, status: 'unknown', reason: 'missing_secret_key' };
        }

        const ref = String(providerReference || '').trim();
        const id = String(invoiceId || '').trim();
        if (!ref && !id) {
            return { provider: providerName, status: 'unknown', reason: 'missing_reference' };
        }

        const target = ref || id;
        const response = await fetch(`${apiBase}/payment_intents/${encodeURIComponent(target)}`, {
            method: 'GET',
            headers: {
                Authorization: `Bearer ${secretKey}`
            }
        });

        const json = await response.json().catch(() => ({}));
        if (!response.ok) {
            return { provider: providerName, status: 'unknown', reason: json?.error?.message || 'intent_lookup_failed' };
        }

        const stripeStatus = String(json.status || '').toLowerCase();
        if (stripeStatus === 'succeeded') {
            return {
                provider: providerName,
                status: 'paid',
                provider_reference: json.id,
                amount: fromMinorUnits(json.amount_received || json.amount || 0, json.currency || 'usd')
            };
        }

        if (stripeStatus === 'requires_payment_method' || stripeStatus === 'canceled') {
            return { provider: providerName, status: 'failed', provider_reference: json.id };
        }

        return { provider: providerName, status: 'pending', provider_reference: json.id };
    }

    function signWebhookPayload(payload) {
        return createHmac('sha256', webhookSecret || config.webhookSecret)
            .update(JSON.stringify(payload))
            .digest('hex');
    }

    return {
        name: providerName,
        createCheckoutSession,
        getPaymentStatus,
        signWebhookPayload,
        meta: {
            configured: Boolean(secretKey),
            mode: secretKey ? 'live-capable' : 'misconfigured'
        }
    };
}

function createBillingProvider(config) {
    const provider = String(config.provider || 'mockpay').trim().toLowerCase();
    if (provider === 'mockpay') {
        return buildMockProvider(config);
    }
    if (provider === 'stripe') {
        return buildStripeProvider(config);
    }

    return {
        name: provider,
        async createCheckoutSession({ tenantId, invoiceId, amount, currency }) {
            return {
                provider,
                checkout_id: `manual_${tenantId}_${invoiceId}_${Date.now()}`,
                provider_reference: `${provider}_ref_${invoiceId}_${Date.now()}`,
                status: 'pending',
                amount,
                currency,
                checkout_url: null,
                notice: 'provider_adapter_placeholder'
            };
        },
        async getPaymentStatus() {
            return { provider, status: 'unknown' };
        },
        signWebhookPayload(payload) {
            return createHmac('sha256', config.webhookSecret)
                .update(JSON.stringify(payload))
                .digest('hex');
        },
        meta: {
            configured: false,
            mode: 'placeholder'
        }
    };
}

module.exports = {
    createBillingProvider
};
