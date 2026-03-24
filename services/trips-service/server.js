const express = require('express');
const promClient = require('prom-client');

const app = express();
const PORT = Number(process.env.TRIPS_SERVICE_PORT || 4101);

const metricsRegistry = new promClient.Registry();
promClient.collectDefaultMetrics({ register: metricsRegistry, prefix: 'ubar_trips_service_' });
const requestCounter = new promClient.Counter({
    name: 'ubar_trips_service_http_requests_total',
    help: 'Total HTTP requests handled by trips service',
    labelNames: ['method', 'route', 'status_code'],
    registers: [metricsRegistry]
});

app.use(express.json());

app.use((req, res, next) => {
    res.on('finish', () => {
        const route = req.route && req.route.path ? String(req.route.path) : String(req.path || req.url || 'unknown');
        requestCounter.inc({ method: req.method, route, status_code: String(res.statusCode || 0) });
    });
    next();
});

app.get('/api/trips-service/health', (_req, res) => {
    return res.json({ success: true, service: 'trips-service', status: 'ok' });
});

app.get('/metrics', async (_req, res) => {
    res.set('Content-Type', metricsRegistry.contentType);
    res.end(await metricsRegistry.metrics());
});

app.get('/api/trips-service/match/recommendation', (req, res) => {
    const demand = Number(req.query.demand || 0.6);
    const supply = Number(req.query.supply || 0.7);
    const score = Math.max(0, Math.min(100, Math.round((demand * 60) + ((1 - supply) * 40))));

    const strategy = score >= 75
        ? 'expand_search_radius_and_apply_priority_pool'
        : score >= 45
            ? 'balanced_zone_matching'
            : 'nearest_driver_low_latency';

    return res.json({
        success: true,
        data: {
            matching_score: score,
            strategy,
            demand,
            supply
        }
    });
});

app.post('/api/trips-service/lifecycle/validate', (req, res) => {
    const current = String(req.body.current_state || '').trim().toLowerCase();
    const next = String(req.body.next_state || '').trim().toLowerCase();

    const allowed = {
        searching: ['assigned', 'cancelled'],
        assigned: ['arriving', 'cancelled'],
        arriving: ['started', 'cancelled'],
        started: ['completed', 'cancelled'],
        completed: [],
        cancelled: []
    };

    const canMove = Array.isArray(allowed[current]) && allowed[current].includes(next);

    return res.json({
        success: true,
        data: {
            valid: canMove,
            current,
            next,
            allowed_next: allowed[current] || []
        }
    });
});

app.listen(PORT, () => {
    console.log(`🚕 Trips service listening on ${PORT}`);
});
