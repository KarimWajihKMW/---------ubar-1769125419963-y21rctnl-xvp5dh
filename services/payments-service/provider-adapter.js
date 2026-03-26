const { createHmac } = require('crypto');

function buildMockProvider(config) {
    const providerName = 'mockpay';

    async function createCheckoutSession({ tenantId, paymentId, amount, currency }) {
        const now = Date.now();
        return {
            provider: providerName,
            checkout_id: `pay_chk_${tenantId}_${paymentId}_${now}`,
            provider_reference: `mockpay_payment_${paymentId}_${now}`,
            status: 'pending',
            amount,
            currency,
            checkout_url: `${config.mockCheckoutBaseUrl}/pay/${tenantId}/${paymentId}`
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
        signWebhookPayload,
        meta: {
            configured: true,
            mode: 'deterministic_test'
        }
    };
}

function createPaymentProvider(config) {
    const provider = String(config.provider || 'mockpay').trim().toLowerCase();
    if (provider === 'mockpay') {
        return buildMockProvider(config);
    }

    return {
        name: provider,
        async createCheckoutSession({ tenantId, paymentId, amount, currency }) {
            return {
                provider,
                checkout_id: `manual_pay_${tenantId}_${paymentId}_${Date.now()}`,
                provider_reference: `${provider}_payref_${paymentId}_${Date.now()}`,
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
    createPaymentProvider
};
