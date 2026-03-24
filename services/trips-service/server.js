const express = require('express');

const app = express();
const PORT = Number(process.env.TRIPS_SERVICE_PORT || 4101);

app.use(express.json());

app.get('/api/trips-service/health', (_req, res) => {
    return res.json({ success: true, service: 'trips-service', status: 'ok' });
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
