const express = require('express');
const promClient = require('prom-client');

const app = express();
const PORT = Number(process.env.AI_SERVICE_PORT || 4104);

const metricsRegistry = new promClient.Registry();
promClient.collectDefaultMetrics({ register: metricsRegistry, prefix: 'ubar_ai_service_' });
const requestCounter = new promClient.Counter({
    name: 'ubar_ai_service_http_requests_total',
    help: 'Total HTTP requests handled by ai service',
    labelNames: ['method', 'route', 'status_code'],
    registers: [metricsRegistry]
});

app.use(express.json({ limit: '1mb' }));

function getTenantId(req) {
    const tenantId = String(req.headers['x-tenant-id'] || 'public').trim();
    return tenantId || 'public';
}

app.use((req, res, next) => {
    res.on('finish', () => {
        const route = req.route && req.route.path ? String(req.route.path) : String(req.path || req.url || 'unknown');
        requestCounter.inc({ method: req.method, route, status_code: String(res.statusCode || 0) });
    });
    next();
});

app.get('/api/ai-service/health', (_req, res) => {
    return res.json({ success: true, service: 'ai-service', status: 'ok' });
});

app.get('/metrics', async (_req, res) => {
    res.set('Content-Type', metricsRegistry.contentType);
    res.end(await metricsRegistry.metrics());
});

app.post('/api/ai-service/fraud/score', (req, res) => {
    const tenantId = getTenantId(req);
    const payload = req.body || {};

    const accountAgeDays = Math.max(0, Number(payload.account_age_days || 0));
    const cancellationRate = Math.max(0, Math.min(1, Number(payload.cancellation_rate || 0)));
    const paymentFailures = Math.max(0, Number(payload.payment_failures || 0));
    const rapidRequests = Math.max(0, Number(payload.rapid_requests_last_hour || 0));

    const raw =
        (cancellationRate * 45) +
        (Math.min(30, paymentFailures * 6)) +
        (Math.min(20, rapidRequests * 2)) +
        (accountAgeDays < 30 ? 15 : 0);
    const score = Math.max(0, Math.min(100, Math.round(raw)));

    const level = score >= 75 ? 'high' : score >= 40 ? 'medium' : 'low';

    return res.json({
        success: true,
        data: {
            tenant_id: tenantId,
            fraud_score: score,
            risk_level: level,
            recommendation: level === 'high' ? 'require_otp_and_manual_review' : level === 'medium' ? 'soft_hold_and_monitor' : 'auto_approve'
        }
    });
});

app.post('/api/ai-service/demand/forecast', (req, res) => {
    const tenantId = getTenantId(req);
    const zoneId = String(req.body.zone_id || 'default-zone').trim();
    const historical = Array.isArray(req.body.historical_rides) ? req.body.historical_rides.map((n) => Math.max(0, Number(n || 0))) : [40, 45, 50, 52, 60, 65, 70];

    const avg = historical.length ? historical.reduce((a, b) => a + b, 0) / historical.length : 0;
    const growthFactor = 1.08;
    const forecastNextHour = Math.round(avg * growthFactor);
    const forecastNextDay = Math.round(forecastNextHour * 24 * 0.35);

    return res.json({
        success: true,
        data: {
            tenant_id: tenantId,
            zone_id: zoneId,
            forecast_next_hour: forecastNextHour,
            forecast_next_day: forecastNextDay,
            confidence: 0.73
        }
    });
});

app.post('/api/ai-service/pricing/recommendation', (req, res) => {
    const tenantId = getTenantId(req);
    const demandIndex = Math.max(0, Number(req.body.demand_index || 1));
    const supplyIndex = Math.max(0.01, Number(req.body.supply_index || 1));
    const weatherRisk = Math.max(0, Math.min(1, Number(req.body.weather_risk || 0)));

    const ratio = demandIndex / supplyIndex;
    const surge = Number(Math.max(1, Math.min(3.5, (ratio * 0.9) + (weatherRisk * 0.6))).toFixed(2));

    return res.json({
        success: true,
        data: {
            tenant_id: tenantId,
            surge_multiplier: surge,
            explanation: 'demand_supply_weather_model_v1'
        }
    });
});

app.post('/api/ai-service/support/summarize-ticket', (req, res) => {
    const tenantId = getTenantId(req);
    const text = String(req.body.text || '').trim();
    if (!text) {
        return res.status(400).json({ success: false, error: 'text_required' });
    }

    const normalized = text.replace(/\s+/g, ' ').trim();
    const summary = normalized.split(' ').slice(0, 30).join(' ');
    const sentiment = /angry|refund|bad|problem|late|cancel/i.test(normalized) ? 'negative' : 'neutral';

    return res.json({
        success: true,
        data: {
            tenant_id: tenantId,
            summary,
            sentiment,
            suggested_next_action: sentiment === 'negative' ? 'priority_support_followup' : 'standard_support_flow'
        }
    });
});

app.post('/api/ai-service/business/insights', (req, res) => {
    const tenantId = getTenantId(req);
    const tripsToday = Math.max(0, Number(req.body.trips_today || 0));
    const activeDrivers = Math.max(0, Number(req.body.active_drivers || 0));
    const completionRate = Math.max(0, Math.min(1, Number(req.body.completion_rate || 0)));

    const tripsPerDriver = activeDrivers > 0 ? Number((tripsToday / activeDrivers).toFixed(2)) : 0;
    const retentionRisk = completionRate < 0.75 ? 'high' : completionRate < 0.88 ? 'medium' : 'low';

    return res.json({
        success: true,
        data: {
            tenant_id: tenantId,
            kpis: {
                trips_per_driver: tripsPerDriver,
                completion_rate: completionRate
            },
            retention_risk: retentionRisk,
            recommendations: retentionRisk === 'high'
                ? ['increase_driver_bonus_peak_hours', 'trigger_rider_recovery_campaign']
                : ['keep_current_pricing_strategy']
        }
    });
});

app.listen(PORT, () => {
    console.log(`🤖 AI service listening on ${PORT}`);
});
