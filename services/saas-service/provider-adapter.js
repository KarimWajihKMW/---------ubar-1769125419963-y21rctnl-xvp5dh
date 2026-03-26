const { createHmac } = require('crypto');

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

function createBillingProvider(config) {
    const provider = String(config.provider || 'mockpay').trim().toLowerCase();
    if (provider === 'mockpay') {
        return buildMockProvider(config);
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
        }
    };
}

module.exports = {
    createBillingProvider
};
