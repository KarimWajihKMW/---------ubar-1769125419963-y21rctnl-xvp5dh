function safeNumber(v, fallback = 0) {
    const n = Number(v);
    return Number.isFinite(n) ? n : fallback;
}

function clamp(v, lo, hi) {
    return Math.max(lo, Math.min(hi, v));
}

function scoreRisk({ tripAmount = 0, tripDistanceKm = 0, riderCancelRate = 0, driverCancelRate = 0, paymentMethod = 'cash', hourOfDay = 12 }) {
    let score = 0;
    const reasons = [];

    if (tripAmount >= 120) {
        score += 20;
        reasons.push('high_value_trip');
    }
    if (tripDistanceKm <= 1) {
        score += 10;
        reasons.push('micro_trip_pattern');
    }
    if (riderCancelRate >= 0.25) {
        score += 15;
        reasons.push('rider_high_cancel_rate');
    }
    if (driverCancelRate >= 0.2) {
        score += 12;
        reasons.push('driver_high_cancel_rate');
    }
    if (String(paymentMethod).toLowerCase() === 'cash') {
        score += 8;
        reasons.push('cash_payment');
    }
    if (hourOfDay >= 1 && hourOfDay <= 5) {
        score += 10;
        reasons.push('overnight_window');
    }

    const bounded = clamp(Math.round(score), 0, 100);
    const level = bounded >= 60 ? 'high' : bounded >= 35 ? 'medium' : 'low';
    return { score: bounded, level, reasons };
}

function demandForecast({ baselineTrips = 1000, activeDrivers = 500, weatherFactor = 1, eventsFactor = 1, lookaheadHours = 6 }) {
    const loadFactor = clamp((safeNumber(weatherFactor, 1) * 0.35) + (safeNumber(eventsFactor, 1) * 0.65), 0.4, 2.4);
    const supplyFactor = clamp(activeDrivers <= 0 ? 1.6 : 500 / safeNumber(activeDrivers, 500), 0.5, 2.2);
    const horizon = clamp(safeNumber(lookaheadHours, 6), 1, 48);

    const projectedTrips = Math.round(safeNumber(baselineTrips, 1000) * loadFactor * (1 + ((horizon - 1) * 0.015)));
    const capacityPressure = clamp((projectedTrips / Math.max(1, activeDrivers * 2)) * 100, 0, 100);
    const etaPressure = clamp(capacityPressure * 0.22, 2, 35);

    return {
        projected_trips: projectedTrips,
        capacity_pressure_score: Number(capacityPressure.toFixed(2)),
        projected_eta_minutes: Number(etaPressure.toFixed(2)),
        confidence: Number(clamp(88 - Math.abs(horizon - 6) * 1.7, 55, 92).toFixed(2))
    };
}

function pricingRecommendation({ baseFare = 10, demandPressure = 0.5, supplyPressure = 0.5, activeIncidents = 0 }) {
    const demand = clamp(safeNumber(demandPressure, 0.5), 0, 1);
    const supply = clamp(safeNumber(supplyPressure, 0.5), 0, 1);
    const incidents = clamp(safeNumber(activeIncidents, 0), 0, 50);

    const surge = clamp(1 + (demand * 0.9) + ((1 - supply) * 0.6) + (incidents * 0.01), 1, 2.8);
    const recommendedFare = Number((safeNumber(baseFare, 10) * surge).toFixed(2));

    return {
        surge_multiplier: Number(surge.toFixed(2)),
        recommended_fare: recommendedFare,
        strategy: surge >= 1.9 ? 'aggressive_supply_protection' : surge >= 1.35 ? 'balanced_market' : 'normal_market'
    };
}

function summarizeTicket({ subject = '', description = '', category = 'general' }) {
    const text = `${subject}. ${description}`.trim();
    const words = text.split(/\s+/).filter(Boolean);
    const head = words.slice(0, 28).join(' ');
    const severity = /crash|unsafe|fraud|harass|accident|panic|emergency/i.test(text)
        ? 'high'
        : /late|delay|cancel|refund/i.test(text)
            ? 'medium'
            : 'low';

    return {
        summary: head || 'No ticket details provided',
        category: String(category || 'general').toLowerCase(),
        severity,
        next_best_action: severity === 'high' ? 'route_to_safety_ops_immediately' : severity === 'medium' ? 'assign_to_support_tier2' : 'queue_for_standard_support'
    };
}

async function ensureAiTables(pool) {
    await pool.query(`
        CREATE TABLE IF NOT EXISTS ai_decision_logs (
            id BIGSERIAL PRIMARY KEY,
            model_key VARCHAR(80) NOT NULL,
            decision_type VARCHAR(80) NOT NULL,
            input_json JSONB,
            output_json JSONB,
            actor_user_id BIGINT,
            tenant_id BIGINT,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        );
    `);

    await pool.query('CREATE INDEX IF NOT EXISTS idx_ai_decision_logs_created ON ai_decision_logs(created_at DESC);');
    await pool.query('CREATE INDEX IF NOT EXISTS idx_ai_decision_logs_type ON ai_decision_logs(decision_type, created_at DESC);');
}

async function logAiDecision(pool, req, { decisionType, input, output }) {
    await pool.query(
        `INSERT INTO ai_decision_logs (model_key, decision_type, input_json, output_json, actor_user_id, tenant_id)
         VALUES ($1,$2,$3,$4,$5,$6)`,
        [
            'heuristic-ai-v1',
            decisionType,
            JSON.stringify(input || {}),
            JSON.stringify(output || {}),
            req.auth?.uid || null,
            req.tenant?.id || null
        ]
    );
}

function registerAiRoutes(app, { pool, requirePermission, requireRole }) {
    app.post('/api/admin/ai/fraud-score', requirePermission('admin.risk.scan', 'admin.risk.read'), async (req, res) => {
        try {
            const input = {
                tripAmount: safeNumber(req.body?.trip_amount, 0),
                tripDistanceKm: safeNumber(req.body?.trip_distance_km, 0),
                riderCancelRate: safeNumber(req.body?.rider_cancel_rate, 0),
                driverCancelRate: safeNumber(req.body?.driver_cancel_rate, 0),
                paymentMethod: String(req.body?.payment_method || 'cash'),
                hourOfDay: safeNumber(req.body?.hour_of_day, new Date().getHours())
            };
            const output = scoreRisk(input);
            await logAiDecision(pool, req, { decisionType: 'fraud_score', input, output });
            return res.json({ success: true, data: output });
        } catch (e) {
            return res.status(500).json({ success: false, error: e.message || 'ai_fraud_score_failed' });
        }
    });

    app.post('/api/admin/ai/demand-forecast', requirePermission('admin.ops.read', 'admin.executive.read'), async (req, res) => {
        try {
            const input = {
                baselineTrips: safeNumber(req.body?.baseline_trips, 1000),
                activeDrivers: safeNumber(req.body?.active_drivers, 500),
                weatherFactor: safeNumber(req.body?.weather_factor, 1),
                eventsFactor: safeNumber(req.body?.events_factor, 1),
                lookaheadHours: safeNumber(req.body?.lookahead_hours, 6)
            };
            const output = demandForecast(input);
            await logAiDecision(pool, req, { decisionType: 'demand_forecast', input, output });
            return res.json({ success: true, data: output });
        } catch (e) {
            return res.status(500).json({ success: false, error: e.message || 'ai_demand_forecast_failed' });
        }
    });

    app.post('/api/admin/ai/pricing-recommendation', requirePermission('admin.ops.read', 'admin.executive.read'), async (req, res) => {
        try {
            const input = {
                baseFare: safeNumber(req.body?.base_fare, 10),
                demandPressure: safeNumber(req.body?.demand_pressure, 0.5),
                supplyPressure: safeNumber(req.body?.supply_pressure, 0.5),
                activeIncidents: safeNumber(req.body?.active_incidents, 0)
            };
            const output = pricingRecommendation(input);
            await logAiDecision(pool, req, { decisionType: 'pricing_recommendation', input, output });
            return res.json({ success: true, data: output });
        } catch (e) {
            return res.status(500).json({ success: false, error: e.message || 'ai_pricing_failed' });
        }
    });

    app.post('/api/admin/ai/ticket-summarize', requirePermission('admin.support.read', 'admin.cases.read'), async (req, res) => {
        try {
            const input = {
                subject: String(req.body?.subject || ''),
                description: String(req.body?.description || ''),
                category: String(req.body?.category || 'general')
            };
            const output = summarizeTicket(input);
            await logAiDecision(pool, req, { decisionType: 'ticket_summarize', input, output });
            return res.json({ success: true, data: output });
        } catch (e) {
            return res.status(500).json({ success: false, error: e.message || 'ai_ticket_summary_failed' });
        }
    });

    app.get('/api/admin/ai/insights/overview', requirePermission('admin.executive.read', 'admin.ops.read'), async (req, res) => {
        try {
            const daysRaw = Number(req.query?.days);
            const days = Number.isFinite(daysRaw) ? Math.max(1, Math.min(daysRaw, 60)) : 7;

            const rows = await pool.query(
                `SELECT decision_type,
                        COUNT(*)::int AS total,
                        MAX(created_at) AS last_at
                 FROM ai_decision_logs
                 WHERE created_at >= NOW() - ($1::text || ' days')::interval
                 GROUP BY decision_type
                 ORDER BY total DESC, decision_type ASC`,
                [String(days)]
            );

            return res.json({
                success: true,
                lookback_days: days,
                model_key: 'heuristic-ai-v1',
                data: rows.rows
            });
        } catch (e) {
            return res.status(500).json({ success: false, error: e.message || 'ai_insights_failed' });
        }
    });

    app.post('/api/ai/assistant/query', requireRole('admin', 'driver', 'passenger'), async (req, res) => {
        try {
            const role = String(req.auth?.role || 'guest').toLowerCase();
            const query = String(req.body?.query || '').trim();
            if (!query) {
                return res.status(400).json({ success: false, error: 'query_required' });
            }

            const q = query.toLowerCase();
            let response = 'We received your request.';
            let intent = 'general';

            if (q.includes('cancel') || q.includes('إلغاء')) {
                response = role === 'driver'
                    ? 'To reduce penalties: accept rides you can commit to and use justified-cancel reasons from the captain panel.'
                    : 'You can cancel before pickup from trip details. Frequent cancellations can affect matching quality.';
                intent = 'cancellation_policy';
            } else if (q.includes('wallet') || q.includes('محفظ')) {
                response = role === 'driver'
                    ? 'Your wallet and withdrawals are available in earnings. Cash trips may create debt entries against commission.'
                    : 'You can top up and pay with wallet from payment settings. Promo and pass discounts apply before wallet debit.';
                intent = 'wallet_help';
            } else if (q.includes('safety') || q.includes('أمان')) {
                response = 'Use in-trip safety tools: guardian share, emergency card, and verified pickup handshake.';
                intent = 'safety_help';
            }

            const output = { intent, answer: response };
            await logAiDecision(pool, req, { decisionType: 'assistant_query', input: { role, query }, output });

            return res.json({ success: true, data: output });
        } catch (e) {
            return res.status(500).json({ success: false, error: e.message || 'assistant_query_failed' });
        }
    });
}

module.exports = {
    ensureAiTables,
    registerAiRoutes
};
