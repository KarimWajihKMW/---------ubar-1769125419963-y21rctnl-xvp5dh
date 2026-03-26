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

app.get('/api/trips-service/health', (_req, res) => {
    return res.json({ success: true, service: 'trips-service', status: 'ok', tenant_mode: 'header_based' });
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
            tenant_id: getTenantId(req),
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
            tenant_id: getTenantId(req),
            valid: canMove,
            current,
            next,
            allowed_next: allowed[current] || []
        }
    });
});

app.post('/api/trips-service/match/assign', (req, res) => {
    const tenantId = getTenantId(req);
    const demand = Math.max(0, Number(req.body.demand || 0.6));
    const surgeMultiplier = Math.max(1, Number(req.body.surge_multiplier || 1));
    const ride = req.body.ride || {};
    const drivers = Array.isArray(req.body.drivers) ? req.body.drivers : [];

    if (!drivers.length) {
        return res.status(400).json({ success: false, error: 'drivers_required' });
    }

    const scored = drivers.map((driver) => {
        const distanceKm = Math.max(0, Number(driver.distance_km || 0));
        const rating = Math.max(0, Math.min(5, Number(driver.rating || 0)));
        const acceptance = Math.max(0, Math.min(1, Number(driver.acceptance_rate || 0)));
        const cancellations = Math.max(0, Math.min(1, Number(driver.cancellation_rate || 0)));
        const etaMin = Math.max(0, Number(driver.eta_min || 0));

        const distanceScore = Math.max(0, 100 - (distanceKm * 10));
        const etaScore = Math.max(0, 100 - (etaMin * 8));
        const ratingScore = (rating / 5) * 100;
        const acceptanceScore = acceptance * 100;
        const cancellationPenalty = cancellations * 100;
        const demandBoost = Math.min(20, demand * 20);

        const totalScore = Number((
            (distanceScore * 0.25) +
            (etaScore * 0.30) +
            (ratingScore * 0.20) +
            (acceptanceScore * 0.20) -
            (cancellationPenalty * 0.10) +
            demandBoost
        ).toFixed(2));

        return {
            driver_id: driver.driver_id,
            distance_km: distanceKm,
            eta_min: etaMin,
            rating,
            acceptance_rate: acceptance,
            cancellation_rate: cancellations,
            total_score: totalScore
        };
    }).sort((a, b) => b.total_score - a.total_score);

    const selected = scored[0] || null;

    return res.json({
        success: true,
        data: {
            tenant_id: tenantId,
            ride_id: ride.ride_id || null,
            surge_multiplier: surgeMultiplier,
            selected_driver: selected,
            alternatives: scored.slice(1, 4)
        }
    });
});

app.post('/api/trips-service/lifecycle/advance', (req, res) => {
    const tenantId = getTenantId(req);
    const tripId = String(req.body.trip_id || '').trim();
    const current = String(req.body.current_state || '').trim().toLowerCase();
    const action = String(req.body.action || '').trim().toLowerCase();

    if (!tripId || !current || !action) {
        return res.status(400).json({ success: false, error: 'trip_id_current_state_action_required' });
    }

    const transitionByAction = {
        assign_driver: { from: 'searching', to: 'assigned' },
        driver_arriving: { from: 'assigned', to: 'arriving' },
        start_trip: { from: 'arriving', to: 'started' },
        complete_trip: { from: 'started', to: 'completed' },
        cancel_trip: { from: ['searching', 'assigned', 'arriving', 'started'], to: 'cancelled' },
        skip_rating: { from: 'completed', to: 'searching' }
    };

    const rule = transitionByAction[action];
    if (!rule) {
        return res.status(400).json({ success: false, error: 'invalid_action' });
    }

    const allowedFrom = Array.isArray(rule.from) ? rule.from : [rule.from];
    if (!allowedFrom.includes(current)) {
        return res.status(422).json({
            success: false,
            error: 'invalid_transition',
            data: { current_state: current, action, expected_from: allowedFrom }
        });
    }

    return res.json({
        success: true,
        data: {
            tenant_id: tenantId,
            trip_id: tripId,
            action,
            previous_state: current,
            next_state: rule.to,
            ui_hints: {
                reset_map: rule.to === 'searching' || rule.to === 'completed' || rule.to === 'cancelled',
                rating_optional: action === 'complete_trip' || action === 'skip_rating',
                allow_next_ride_immediately: action === 'skip_rating' || rule.to === 'cancelled'
            }
        }
    });
});

app.listen(PORT, () => {
    console.log(`🚕 Trips service listening on ${PORT}`);
});
