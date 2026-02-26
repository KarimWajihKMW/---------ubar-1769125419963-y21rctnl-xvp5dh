function clamp(value, min, max, fallback) {
    const n = Number(value);
    if (!Number.isFinite(n)) return fallback;
    return Math.max(min, Math.min(max, n));
}

function pct(value, fallback = 0) {
    return clamp(value, -1000, 1000, fallback);
}

function normalizeZoneKey(value) {
    const raw = value !== undefined && value !== null ? String(value).trim().toLowerCase() : '';
    return raw ? raw.slice(0, 80) : 'citywide';
}

function routeKeyFromRow(row) {
    const pLat = Number(row.pickup_lat);
    const pLng = Number(row.pickup_lng);
    const dLat = Number(row.dropoff_lat);
    const dLng = Number(row.dropoff_lng);
    if ([pLat, pLng, dLat, dLng].every(Number.isFinite)) {
        const p = `${pLat.toFixed(3)},${pLng.toFixed(3)}`;
        const d = `${dLat.toFixed(3)},${dLng.toFixed(3)}`;
        return `${p}->${d}`;
    }
    const pickup = String(row.pickup_location || 'unknown').trim().slice(0, 40);
    const dropoff = String(row.dropoff_location || 'unknown').trim().slice(0, 40);
    return `${pickup}->${dropoff}`;
}

async function ensureAdminInnovationTables(pool) {
    try {
        await pool.query(`
            CREATE TABLE IF NOT EXISTS admin_innovation_features (
                key VARCHAR(120) PRIMARY KEY,
                title VARCHAR(180) NOT NULL,
                objective TEXT,
                phase VARCHAR(20) NOT NULL DEFAULT 'phase_1',
                enabled BOOLEAN NOT NULL DEFAULT true,
                kpis_json JSONB,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
        `);

        await pool.query(`
            CREATE TABLE IF NOT EXISTS admin_innovation_runs (
                id BIGSERIAL PRIMARY KEY,
                feature_key VARCHAR(120) REFERENCES admin_innovation_features(key) ON DELETE SET NULL,
                run_type VARCHAR(40) NOT NULL DEFAULT 'simulate',
                input_json JSONB,
                output_json JSONB,
                triggered_by_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
                triggered_by_role VARCHAR(40),
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
        `);
        await pool.query('CREATE INDEX IF NOT EXISTS idx_admin_innovation_runs_feature ON admin_innovation_runs(feature_key, created_at DESC);');

        await pool.query(`
            CREATE TABLE IF NOT EXISTS admin_city_pulse_genome (
                id BIGSERIAL PRIMARY KEY,
                zone_key VARCHAR(80) NOT NULL,
                demand_index NUMERIC(10,2) NOT NULL,
                supply_index NUMERIC(10,2) NOT NULL,
                stress_index NUMERIC(10,2) NOT NULL,
                anomaly_score NUMERIC(10,2) NOT NULL,
                snapshot_json JSONB,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
        `);
        await pool.query('CREATE INDEX IF NOT EXISTS idx_admin_city_pulse_zone ON admin_city_pulse_genome(zone_key, created_at DESC);');

        await pool.query(`
            CREATE TABLE IF NOT EXISTS admin_route_trust_index (
                id BIGSERIAL PRIMARY KEY,
                route_key VARCHAR(180) NOT NULL,
                trust_score NUMERIC(10,2) NOT NULL,
                trips_count INTEGER NOT NULL DEFAULT 0,
                incidents_count INTEGER NOT NULL DEFAULT 0,
                cancel_rate NUMERIC(10,4) NOT NULL DEFAULT 0,
                match_mode VARCHAR(20) NOT NULL DEFAULT 'balanced',
                raw_json JSONB,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                UNIQUE (route_key)
            );
        `);

        await pool.query(`
            CREATE TABLE IF NOT EXISTS admin_outcome_market (
                id BIGSERIAL PRIMARY KEY,
                title VARCHAR(180) NOT NULL,
                hypothesis TEXT NOT NULL,
                predicted_impact_json JSONB,
                actual_impact_json JSONB,
                accuracy_score NUMERIC(10,2),
                stake_points INTEGER NOT NULL DEFAULT 10,
                status VARCHAR(20) NOT NULL DEFAULT 'open',
                created_by_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
                settled_by_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                settled_at TIMESTAMP
            );
        `);
        await pool.query('CREATE INDEX IF NOT EXISTS idx_admin_outcome_market_status ON admin_outcome_market(status, created_at DESC);');

        await pool.query(`
            CREATE TABLE IF NOT EXISTS admin_silent_crisis_predictions (
                id BIGSERIAL PRIMARY KEY,
                risk_level VARCHAR(20) NOT NULL,
                score NUMERIC(10,2) NOT NULL,
                signals_json JSONB,
                recommendation TEXT,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
        `);

        await pool.query(`
            CREATE TABLE IF NOT EXISTS admin_recovery_composer_plans (
                id BIGSERIAL PRIMARY KEY,
                case_type VARCHAR(40),
                case_id VARCHAR(80),
                severity VARCHAR(20),
                plan_json JSONB NOT NULL,
                estimated_cost NUMERIC(10,2) NOT NULL DEFAULT 0,
                expected_reopen_reduction_pct NUMERIC(10,2) NOT NULL DEFAULT 0,
                created_by_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
        `);

        await pool.query(`
            CREATE TABLE IF NOT EXISTS admin_ethical_risk_dial (
                id SMALLINT PRIMARY KEY DEFAULT 1,
                profit_weight NUMERIC(10,4) NOT NULL DEFAULT 0.33,
                fairness_weight NUMERIC(10,4) NOT NULL DEFAULT 0.34,
                safety_weight NUMERIC(10,4) NOT NULL DEFAULT 0.33,
                updated_by_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                CONSTRAINT admin_ethical_risk_dial_singleton CHECK (id = 1)
            );
        `);
        await pool.query('INSERT INTO admin_ethical_risk_dial (id) VALUES (1) ON CONFLICT (id) DO NOTHING;');

        await pool.query(`
            CREATE TABLE IF NOT EXISTS admin_narrative_audits (
                id BIGSERIAL PRIMARY KEY,
                title VARCHAR(180) NOT NULL,
                entity_type VARCHAR(60),
                entity_id VARCHAR(80),
                window_hours INTEGER NOT NULL DEFAULT 24,
                narrative_text TEXT NOT NULL,
                stats_json JSONB,
                created_by_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
        `);

        await pool.query(`
            CREATE TABLE IF NOT EXISTS admin_copilot_arena_sessions (
                id BIGSERIAL PRIMARY KEY,
                scenario_type VARCHAR(80) NOT NULL,
                difficulty VARCHAR(20) NOT NULL DEFAULT 'normal',
                scenario_json JSONB NOT NULL,
                submitted_decision_json JSONB,
                score NUMERIC(10,2),
                feedback TEXT,
                created_by_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
                scored_by_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                scored_at TIMESTAMP
            );
        `);

        await pool.query(`
            CREATE TABLE IF NOT EXISTS admin_hub_rebalance_actions (
                id BIGSERIAL PRIMARY KEY,
                zone_key VARCHAR(80) NOT NULL,
                source_hub_id INTEGER REFERENCES pickup_hubs(id) ON DELETE SET NULL,
                target_hub_id INTEGER REFERENCES pickup_hubs(id) ON DELETE SET NULL,
                suggested_shift INTEGER NOT NULL DEFAULT 0,
                rationale TEXT,
                status VARCHAR(20) NOT NULL DEFAULT 'proposed',
                created_by_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
        `);

        console.log('✅ Admin innovation tables ensured');
    } catch (err) {
        console.error('❌ Failed to ensure admin innovation tables:', err.message);
    }
}

async function ensureDefaultAdminInnovationFeatures(pool) {
    const features = [
        { key: 'policy_twin_simulator', title: 'Policy Twin Simulator', phase: 'phase_1', objective: 'محاكاة أثر السياسات قبل الإطلاق', kpis: ['decision_accuracy_vs_actual', 'mttr_minutes'] },
        { key: 'city_pulse_genome', title: 'City Pulse Genome', phase: 'phase_3', objective: 'بصمة تشغيلية لكل منطقة واكتشاف الانحرافات', kpis: ['silent_crisis_prevent_rate', 'false_alert_rate'] },
        { key: 'trust_by_route_index', title: 'Trust-by-Route Index', phase: 'phase_2', objective: 'مؤشر ثقة لكل مسار لتحسين المطابقة', kpis: ['route_incident_rate', 'route_cancel_rate'] },
        { key: 'outcome_market', title: 'Outcome Market', phase: 'phase_3', objective: 'منافسة فرضيات الإدارة وقياس الدقة', kpis: ['decision_accuracy_vs_actual'] },
        { key: 'silent_crisis_predictor', title: 'Silent Crisis Predictor', phase: 'phase_1', objective: 'استباق الأزمات قبل الشكاوى العلنية', kpis: ['silent_crisis_prevent_rate', 'false_alert_rate'] },
        { key: 'recovery_composer', title: 'Recovery Composer', phase: 'phase_1', objective: 'توليد خطة تعويض مخصصة لكل حالة', kpis: ['dispute_reopen_rate'] },
        { key: 'ethical_risk_dial', title: 'Ethical Risk Dial', phase: 'phase_2', objective: 'موازنة الربحية والعدالة والسلامة', kpis: ['fairness_index', 'safety_incident_rate'] },
        { key: 'narrative_audit_lens', title: 'Narrative Audit Lens', phase: 'phase_3', objective: 'سرد سببي واضح لقرارات الإدارة', kpis: ['audit_trace_completeness'] },
        { key: 'admin_copilot_arena', title: 'Admin Copilot Arena', phase: 'phase_3', objective: 'تدريب الإدارة على سيناريوهات تشغيلية', kpis: ['training_readiness_score'] },
        { key: 'autonomous_hub_rebalancer', title: 'Autonomous Hub Rebalancer', phase: 'phase_2', objective: 'إعادة توزيع ديناميكية لنقاط الالتقاط', kpis: ['pending_assignment_time', 'pickup_coverage_score'] }
    ];

    try {
        for (const f of features) {
            await pool.query(
                `INSERT INTO admin_innovation_features (key, title, objective, phase, enabled, kpis_json)
                 VALUES ($1,$2,$3,$4,true,$5::jsonb)
                 ON CONFLICT (key) DO UPDATE
                 SET title = EXCLUDED.title,
                     objective = EXCLUDED.objective,
                     phase = EXCLUDED.phase,
                     kpis_json = EXCLUDED.kpis_json,
                     updated_at = CURRENT_TIMESTAMP`,
                [f.key, f.title, f.objective, f.phase, JSON.stringify(f.kpis || [])]
            );
        }
        console.log('✅ Default admin innovation features ensured');
    } catch (err) {
        console.error('❌ Failed to ensure default admin innovation features:', err.message);
    }
}

async function computeOpsBaseline(pool) {
    const [pendingRes, tripsRes, incidentsRes] = await Promise.all([
        pool.query(
            `SELECT COALESCE(AVG(EXTRACT(EPOCH FROM (NOW() - created_at))/60.0),0) AS avg_wait_minutes,
                    COUNT(*)::int AS pending_count
             FROM pending_ride_requests
             WHERE status IN ('waiting','accepted')
               AND created_at >= NOW() - INTERVAL '24 hours'`
        ),
        pool.query(
            `SELECT COUNT(*)::int AS trips_total,
                    COUNT(*) FILTER (WHERE LOWER(COALESCE(status, '')) IN ('cancelled','canceled'))::int AS trips_cancelled,
                    COALESCE(SUM(CASE WHEN LOWER(COALESCE(status, '')) = 'completed' THEN COALESCE(cost, 0) ELSE 0 END), 0) AS revenue_completed
             FROM trips
             WHERE created_at >= NOW() - INTERVAL '24 hours'`
        ),
        pool.query(
            `SELECT COUNT(*)::int AS incidents_count
             FROM trip_incident_packages
             WHERE created_at >= NOW() - INTERVAL '24 hours'`
        )
    ]);

    const tripsTotal = Number(tripsRes.rows?.[0]?.trips_total || 0);
    const tripsCancelled = Number(tripsRes.rows?.[0]?.trips_cancelled || 0);
    return {
        avg_wait_minutes: Number(Number(pendingRes.rows?.[0]?.avg_wait_minutes || 0).toFixed(2)),
        pending_count: Number(pendingRes.rows?.[0]?.pending_count || 0),
        trips_total: tripsTotal,
        trips_cancelled: tripsCancelled,
        cancel_rate: Number((tripsTotal > 0 ? tripsCancelled / tripsTotal : 0).toFixed(4)),
        revenue_completed: Number(Number(tripsRes.rows?.[0]?.revenue_completed || 0).toFixed(2)),
        incidents_count: Number(incidentsRes.rows?.[0]?.incidents_count || 0)
    };
}

function registerAdminInnovationRoutes(app, { pool, requirePermission, writeAdminAudit }) {
    app.get('/api/admin/innovations/features', requirePermission('admin.innovations.read'), async (req, res) => {
        try {
            const rows = await pool.query(
                `SELECT key, title, objective, phase, enabled, kpis_json, created_at, updated_at
                 FROM admin_innovation_features
                 ORDER BY key ASC`
            );
            res.json({ success: true, data: rows.rows });
        } catch (e) {
            res.status(500).json({ success: false, error: e.message });
        }
    });

    app.post('/api/admin/innovations/policy-twin/simulate', requirePermission('admin.innovations.simulate'), async (req, res) => {
        try {
            const policyName = String(req.body?.policy_name || 'generic_policy').trim().slice(0, 120);
            const pricingDeltaPct = pct(req.body?.pricing_delta_pct, 0);
            const driverSupplyDeltaPct = pct(req.body?.driver_supply_delta_pct, 0);
            const fairnessDeltaPct = pct(req.body?.fairness_delta_pct, 0);

            const baseline = await computeOpsBaseline(pool);
            const projectedWait = Math.max(1, baseline.avg_wait_minutes * (1 - (driverSupplyDeltaPct / 100) + (pricingDeltaPct / 200)));
            const projectedCancel = clamp(baseline.cancel_rate * (1 + (pricingDeltaPct / 250) - (driverSupplyDeltaPct / 200)), 0, 1, baseline.cancel_rate);
            const projectedIncidents = Math.max(0, baseline.incidents_count * (1 - (fairnessDeltaPct / 200) + (pricingDeltaPct / 300)));
            const projectedRevenue = Math.max(0, baseline.revenue_completed * (1 + pricingDeltaPct / 100) * (1 - projectedCancel * 0.18));

            const projected = {
                avg_wait_minutes: Number(projectedWait.toFixed(2)),
                cancel_rate: Number(projectedCancel.toFixed(4)),
                incidents_count: Number(projectedIncidents.toFixed(2)),
                revenue_completed: Number(projectedRevenue.toFixed(2)),
                fairness_pressure: Number((50 + fairnessDeltaPct).toFixed(2))
            };

            const run = await pool.query(
                `INSERT INTO admin_innovation_runs (feature_key, run_type, input_json, output_json, triggered_by_user_id, triggered_by_role)
                 VALUES ('policy_twin_simulator','simulate',$1::jsonb,$2::jsonb,$3,$4)
                 RETURNING *`,
                [
                    JSON.stringify({ policy_name: policyName, pricing_delta_pct: pricingDeltaPct, driver_supply_delta_pct: driverSupplyDeltaPct, fairness_delta_pct: fairnessDeltaPct }),
                    JSON.stringify({ baseline, projected }),
                    req.auth?.uid || null,
                    req.auth?.role || null
                ]
            );

            await writeAdminAudit(req, {
                action: 'innovations.policy_twin.simulate',
                entity_type: 'innovation_run',
                entity_id: String(run.rows?.[0]?.id || ''),
                meta: { policy_name: policyName }
            });

            res.json({ success: true, data: { run: run.rows[0], baseline, projected } });
        } catch (e) {
            res.status(500).json({ success: false, error: e.message });
        }
    });

    app.get('/api/admin/innovations/city-pulse/genome', requirePermission('admin.innovations.read'), async (req, res) => {
        try {
            const refresh = String(req.query.refresh || '').toLowerCase();
            const doRefresh = refresh === '1' || refresh === 'true';

            if (doRefresh) {
                const zones = await pool.query(
                    `SELECT zone_key,
                            COUNT(*)::int AS demand_count,
                            COALESCE(AVG(EXTRACT(EPOCH FROM (NOW() - created_at))/60.0),0) AS wait_min
                     FROM (
                        SELECT CASE
                            WHEN pickup_lat IS NULL OR pickup_lng IS NULL THEN 'citywide'
                            ELSE CONCAT(ROUND(CAST(pickup_lat AS numeric),1), ',', ROUND(CAST(pickup_lng AS numeric),1))
                        END AS zone_key,
                        created_at
                        FROM pending_ride_requests
                        WHERE created_at >= NOW() - INTERVAL '6 hours'
                     ) z
                     GROUP BY zone_key
                     ORDER BY demand_count DESC
                     LIMIT 40`
                );

                for (const row of zones.rows) {
                    const demand = Number(row.demand_count || 0);
                    const waitMin = Number(row.wait_min || 0);
                    const supply = Math.max(1, Math.round(demand * 0.85));
                    const stress = demand > 0 ? Number(((waitMin / 10) + ((demand - supply) / Math.max(demand, 1))).toFixed(2)) : 0;
                    const anomaly = Number((Math.max(0, stress) * 20).toFixed(2));

                    await pool.query(
                        `INSERT INTO admin_city_pulse_genome (zone_key, demand_index, supply_index, stress_index, anomaly_score, snapshot_json)
                         VALUES ($1,$2,$3,$4,$5,$6::jsonb)`,
                        [
                            normalizeZoneKey(row.zone_key),
                            demand,
                            supply,
                            stress,
                            anomaly,
                            JSON.stringify({ wait_minutes: Number(waitMin.toFixed(2)) })
                        ]
                    );
                }

                await writeAdminAudit(req, {
                    action: 'innovations.city_pulse.refresh',
                    entity_type: 'city_pulse',
                    entity_id: 'snapshot',
                    meta: { zones: zones.rows.length }
                });
            }

            const latest = await pool.query(
                `SELECT DISTINCT ON (zone_key)
                        id, zone_key, demand_index, supply_index, stress_index, anomaly_score, snapshot_json, created_at
                 FROM admin_city_pulse_genome
                 ORDER BY zone_key, created_at DESC`
            );

            res.json({ success: true, data: latest.rows });
        } catch (e) {
            res.status(500).json({ success: false, error: e.message });
        }
    });

    app.post('/api/admin/innovations/trust-route/rebuild', requirePermission('admin.innovations.simulate'), async (req, res) => {
        try {
            const windowDays = clamp(req.body?.window_days, 1, 60, 14);
            const trips = await pool.query(
                `SELECT t.id, t.pickup_lat, t.pickup_lng, t.dropoff_lat, t.dropoff_lng,
                        t.pickup_location, t.dropoff_location,
                        t.status, t.driver_rating, t.rating
                 FROM trips t
                 WHERE t.created_at >= NOW() - ($1 * INTERVAL '1 day')
                 ORDER BY t.created_at DESC
                 LIMIT 600`,
                [windowDays]
            );

            const incidents = await pool.query(
                `SELECT trip_id, COUNT(*)::int AS incidents
                 FROM trip_incident_packages
                 WHERE created_at >= NOW() - ($1 * INTERVAL '1 day')
                 GROUP BY trip_id`,
                [windowDays]
            );

            const incidentMap = new Map((incidents.rows || []).map(r => [String(r.trip_id), Number(r.incidents || 0)]));
            const agg = new Map();
            for (const row of trips.rows || []) {
                const key = routeKeyFromRow(row);
                const cur = agg.get(key) || { trips: 0, cancelled: 0, incidents: 0, ratingSum: 0, ratingCount: 0 };
                cur.trips += 1;
                const st = String(row.status || '').toLowerCase();
                if (st === 'cancelled' || st === 'canceled') cur.cancelled += 1;
                cur.incidents += incidentMap.get(String(row.id)) || 0;
                const r = Number(row.driver_rating || row.rating);
                if (Number.isFinite(r) && r > 0) {
                    cur.ratingSum += r;
                    cur.ratingCount += 1;
                }
                agg.set(key, cur);
            }

            let rebuilt = 0;
            for (const [key, cur] of agg.entries()) {
                const cancelRate = cur.trips > 0 ? cur.cancelled / cur.trips : 0;
                const avgRating = cur.ratingCount > 0 ? cur.ratingSum / cur.ratingCount : 4.5;
                const trustScore = clamp((avgRating * 20) - (cancelRate * 40) - (cur.incidents * 5), 0, 100, 50);
                const mode = trustScore >= 75 ? 'fast' : trustScore <= 45 ? 'safe' : 'balanced';

                await pool.query(
                    `INSERT INTO admin_route_trust_index (route_key, trust_score, trips_count, incidents_count, cancel_rate, match_mode, raw_json, updated_at)
                     VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,CURRENT_TIMESTAMP)
                     ON CONFLICT (route_key) DO UPDATE
                     SET trust_score = EXCLUDED.trust_score,
                         trips_count = EXCLUDED.trips_count,
                         incidents_count = EXCLUDED.incidents_count,
                         cancel_rate = EXCLUDED.cancel_rate,
                         match_mode = EXCLUDED.match_mode,
                         raw_json = EXCLUDED.raw_json,
                         updated_at = CURRENT_TIMESTAMP`,
                    [key, trustScore, cur.trips, cur.incidents, cancelRate, mode, JSON.stringify({ avg_rating: Number(avgRating.toFixed(2)) })]
                );
                rebuilt += 1;
            }

            await writeAdminAudit(req, {
                action: 'innovations.trust_route.rebuild',
                entity_type: 'route_trust',
                entity_id: 'bulk',
                meta: { rebuilt, window_days: windowDays }
            });

            res.json({ success: true, data: { rebuilt } });
        } catch (e) {
            res.status(500).json({ success: false, error: e.message });
        }
    });

    app.get('/api/admin/innovations/trust-route', requirePermission('admin.innovations.read'), async (req, res) => {
        try {
            const limit = clamp(req.query.limit, 1, 200, 50);
            const rows = await pool.query(
                `SELECT id, route_key, trust_score, trips_count, incidents_count, cancel_rate, match_mode, raw_json, updated_at
                 FROM admin_route_trust_index
                 ORDER BY trust_score ASC, trips_count DESC
                 LIMIT $1`,
                [limit]
            );
            res.json({ success: true, data: rows.rows });
        } catch (e) {
            res.status(500).json({ success: false, error: e.message });
        }
    });

    app.post('/api/admin/innovations/outcome-market/decision', requirePermission('admin.innovations.decide'), async (req, res) => {
        try {
            const title = String(req.body?.title || '').trim().slice(0, 180);
            const hypothesis = String(req.body?.hypothesis || '').trim().slice(0, 4000);
            const stakePoints = clamp(req.body?.stake_points, 1, 100, 10);
            const predicted = req.body?.predicted_impact && typeof req.body.predicted_impact === 'object' ? req.body.predicted_impact : {};

            if (!title || !hypothesis) {
                return res.status(400).json({ success: false, error: 'title and hypothesis are required' });
            }

            const ins = await pool.query(
                `INSERT INTO admin_outcome_market (title, hypothesis, predicted_impact_json, stake_points, status, created_by_user_id)
                 VALUES ($1,$2,$3::jsonb,$4,'open',$5)
                 RETURNING *`,
                [title, hypothesis, JSON.stringify(predicted), stakePoints, req.auth?.uid || null]
            );

            await writeAdminAudit(req, {
                action: 'innovations.outcome_market.create',
                entity_type: 'outcome_market',
                entity_id: String(ins.rows?.[0]?.id || ''),
                meta: { stake_points: stakePoints }
            });

            res.status(201).json({ success: true, data: ins.rows[0] });
        } catch (e) {
            res.status(500).json({ success: false, error: e.message });
        }
    });

    app.patch('/api/admin/innovations/outcome-market/:id/settle', requirePermission('admin.innovations.decide'), async (req, res) => {
        try {
            const id = Number(req.params.id);
            if (!Number.isFinite(id) || id <= 0) return res.status(400).json({ success: false, error: 'invalid_id' });

            const actual = req.body?.actual_impact && typeof req.body.actual_impact === 'object' ? req.body.actual_impact : {};
            const rowRes = await pool.query('SELECT * FROM admin_outcome_market WHERE id = $1 LIMIT 1', [id]);
            const row = rowRes.rows?.[0] || null;
            if (!row) return res.status(404).json({ success: false, error: 'not_found' });

            const predicted = row.predicted_impact_json || {};
            const keys = new Set([...Object.keys(predicted), ...Object.keys(actual)]);
            let scoreSum = 0;
            let scoreCount = 0;
            for (const k of keys) {
                const p = Number(predicted[k]);
                const a = Number(actual[k]);
                if (!Number.isFinite(p) || !Number.isFinite(a)) continue;
                const err = Math.abs(a - p);
                const denom = Math.max(1, Math.abs(p));
                const acc = Math.max(0, 100 - (err / denom) * 100);
                scoreSum += acc;
                scoreCount += 1;
            }
            const accuracy = scoreCount > 0 ? Number((scoreSum / scoreCount).toFixed(2)) : 0;

            const up = await pool.query(
                `UPDATE admin_outcome_market
                 SET actual_impact_json = $2::jsonb,
                     accuracy_score = $3,
                     status = 'settled',
                     settled_by_user_id = $4,
                     settled_at = CURRENT_TIMESTAMP
                 WHERE id = $1
                 RETURNING *`,
                [id, JSON.stringify(actual), accuracy, req.auth?.uid || null]
            );

            await writeAdminAudit(req, {
                action: 'innovations.outcome_market.settle',
                entity_type: 'outcome_market',
                entity_id: String(id),
                meta: { accuracy_score: accuracy }
            });

            res.json({ success: true, data: up.rows[0] });
        } catch (e) {
            res.status(500).json({ success: false, error: e.message });
        }
    });

    app.get('/api/admin/innovations/outcome-market', requirePermission('admin.innovations.read'), async (req, res) => {
        try {
            const rows = await pool.query(
                `SELECT *
                 FROM admin_outcome_market
                 ORDER BY created_at DESC
                 LIMIT 120`
            );
            res.json({ success: true, data: rows.rows });
        } catch (e) {
            res.status(500).json({ success: false, error: e.message });
        }
    });

    app.get('/api/admin/innovations/silent-crisis/predict', requirePermission('admin.innovations.read'), async (req, res) => {
        try {
            const baseline = await computeOpsBaseline(pool);
            const short = await pool.query(
                `SELECT
                    COUNT(*)::int AS incidents_count,
                    COALESCE(AVG(EXTRACT(EPOCH FROM (NOW() - created_at))/60.0),0) AS wait_minutes
                 FROM pending_ride_requests
                 WHERE status IN ('waiting','accepted')
                   AND created_at >= NOW() - INTERVAL '3 hours'`
            );
            const recentIncidents = await pool.query(
                `SELECT COUNT(*)::int AS incidents_count
                 FROM trip_incident_packages
                 WHERE created_at >= NOW() - INTERVAL '3 hours'`
            );

            const recentWait = Number(short.rows?.[0]?.wait_minutes || 0);
            const recentPending = Number(short.rows?.[0]?.incidents_count || 0);
            const recentIncCount = Number(recentIncidents.rows?.[0]?.incidents_count || 0);

            const waitSpike = baseline.avg_wait_minutes > 0 ? recentWait / baseline.avg_wait_minutes : 1;
            const incidentSpike = baseline.incidents_count > 0 ? recentIncCount / Math.max(1, baseline.incidents_count / 8) : recentIncCount > 0 ? 2 : 1;
            const score = Number((Math.max(0, (waitSpike - 1) * 35) + Math.max(0, (incidentSpike - 1) * 45) + Math.min(20, recentPending)).toFixed(2));
            const level = score >= 70 ? 'critical' : score >= 45 ? 'high' : score >= 20 ? 'medium' : 'low';

            const signals = {
                baseline,
                recent: { wait_minutes_3h: Number(recentWait.toFixed(2)), incidents_3h: recentIncCount, pending_proxy_3h: recentPending },
                spikes: { wait_spike: Number(waitSpike.toFixed(2)), incident_spike: Number(incidentSpike.toFixed(2)) }
            };

            const rec = level === 'critical'
                ? 'فعّل Crisis Playbook فورًا وارفع المراقبة على المناطق الساخنة.'
                : level === 'high'
                    ? 'ابدأ تدخل تشغيلي استباقي وزد مراقبة الحوادث خلال الساعة القادمة.'
                    : 'استمر بالمراقبة مع تحديث جديد خلال 30 دقيقة.';

            const ins = await pool.query(
                `INSERT INTO admin_silent_crisis_predictions (risk_level, score, signals_json, recommendation)
                 VALUES ($1,$2,$3::jsonb,$4)
                 RETURNING *`,
                [level, score, JSON.stringify(signals), rec]
            );

            await writeAdminAudit(req, {
                action: 'innovations.silent_crisis.predict',
                entity_type: 'silent_crisis',
                entity_id: String(ins.rows?.[0]?.id || ''),
                meta: { risk_level: level, score }
            });

            res.json({ success: true, data: ins.rows[0] });
        } catch (e) {
            res.status(500).json({ success: false, error: e.message });
        }
    });

    app.post('/api/admin/innovations/recovery-composer/compose', requirePermission('admin.innovations.write'), async (req, res) => {
        try {
            const caseType = String(req.body?.case_type || '').trim().slice(0, 40) || null;
            const caseId = String(req.body?.case_id || '').trim().slice(0, 80) || null;
            const severity = String(req.body?.severity || 'medium').trim().toLowerCase().slice(0, 20);
            const inconvenienceMinutes = clamp(req.body?.inconvenience_minutes, 0, 360, 30);
            const sentiment = clamp(req.body?.sentiment, 0, 100, 50);

            const sevWeight = severity === 'critical' ? 1.6 : severity === 'high' ? 1.25 : severity === 'low' ? 0.7 : 1;
            const baseComp = Math.max(10, Math.round((inconvenienceMinutes * 0.8 + (100 - sentiment) * 0.5) * sevWeight));
            const refundPct = Math.min(100, Math.round((baseComp / 2) * 0.8));
            const reopenReduction = Math.min(90, Number((25 + sevWeight * 20 + (100 - sentiment) * 0.2).toFixed(2)));

            const plan = {
                recovery_credit: baseComp,
                refund_percent: refundPct,
                priority_support_hours: severity === 'critical' ? 24 : severity === 'high' ? 12 : 4,
                follow_up_required: severity !== 'low',
                script: 'اعتذار رسمي + شرح سبب المشكلة + تعويض مخصص + متابعة بعد 24 ساعة'
            };

            const ins = await pool.query(
                `INSERT INTO admin_recovery_composer_plans
                    (case_type, case_id, severity, plan_json, estimated_cost, expected_reopen_reduction_pct, created_by_user_id)
                 VALUES ($1,$2,$3,$4::jsonb,$5,$6,$7)
                 RETURNING *`,
                [caseType, caseId, severity, JSON.stringify(plan), baseComp, reopenReduction, req.auth?.uid || null]
            );

            await writeAdminAudit(req, {
                action: 'innovations.recovery_composer.compose',
                entity_type: caseType || 'recovery_plan',
                entity_id: caseId || String(ins.rows?.[0]?.id || ''),
                meta: { severity, estimated_cost: baseComp }
            });

            res.status(201).json({ success: true, data: ins.rows[0] });
        } catch (e) {
            res.status(500).json({ success: false, error: e.message });
        }
    });

    app.get('/api/admin/innovations/recovery-composer', requirePermission('admin.innovations.read'), async (req, res) => {
        try {
            const limit = clamp(req.query.limit, 1, 200, 60);
            const rows = await pool.query(
                `SELECT *
                 FROM admin_recovery_composer_plans
                 ORDER BY created_at DESC
                 LIMIT $1`,
                [limit]
            );
            res.json({ success: true, data: rows.rows });
        } catch (e) {
            res.status(500).json({ success: false, error: e.message });
        }
    });

    app.get('/api/admin/innovations/ethical-dial', requirePermission('admin.innovations.read'), async (req, res) => {
        try {
            const rowRes = await pool.query('SELECT * FROM admin_ethical_risk_dial WHERE id = 1 LIMIT 1');
            const row = rowRes.rows?.[0] || null;
            const fairness = Number(row?.fairness_weight || 0);
            const safety = Number(row?.safety_weight || 0);
            const profit = Number(row?.profit_weight || 0);
            const bias = safety >= 0.45 ? 'safety-first' : fairness >= 0.45 ? 'fairness-first' : profit >= 0.45 ? 'profit-first' : 'balanced';
            res.json({ success: true, data: { ...row, policy_bias: bias } });
        } catch (e) {
            res.status(500).json({ success: false, error: e.message });
        }
    });

    app.patch('/api/admin/innovations/ethical-dial', requirePermission('admin.innovations.decide'), async (req, res) => {
        try {
            const p = clamp(req.body?.profit_weight, 0, 1, 0.33);
            const f = clamp(req.body?.fairness_weight, 0, 1, 0.34);
            const s = clamp(req.body?.safety_weight, 0, 1, 0.33);
            const total = p + f + s;
            if (total <= 0) return res.status(400).json({ success: false, error: 'invalid_weights' });

            const normP = Number((p / total).toFixed(4));
            const normF = Number((f / total).toFixed(4));
            const normS = Number((s / total).toFixed(4));

            const up = await pool.query(
                `UPDATE admin_ethical_risk_dial
                 SET profit_weight = $1,
                     fairness_weight = $2,
                     safety_weight = $3,
                     updated_by_user_id = $4,
                     updated_at = CURRENT_TIMESTAMP
                 WHERE id = 1
                 RETURNING *`,
                [normP, normF, normS, req.auth?.uid || null]
            );

            await writeAdminAudit(req, {
                action: 'innovations.ethical_dial.update',
                entity_type: 'ethical_risk_dial',
                entity_id: '1',
                meta: { profit_weight: normP, fairness_weight: normF, safety_weight: normS }
            });

            res.json({ success: true, data: up.rows[0] });
        } catch (e) {
            res.status(500).json({ success: false, error: e.message });
        }
    });

    app.post('/api/admin/innovations/narrative-audit/build', requirePermission('admin.innovations.read'), async (req, res) => {
        try {
            const title = String(req.body?.title || 'Narrative Audit').trim().slice(0, 180);
            const entityType = req.body?.entity_type ? String(req.body.entity_type).trim().slice(0, 60) : null;
            const entityId = req.body?.entity_id ? String(req.body.entity_id).trim().slice(0, 80) : null;
            const windowHours = clamp(req.body?.window_hours, 1, 168, 24);

            const params = [windowHours];
            let where = `WHERE created_at >= NOW() - ($1 * INTERVAL '1 hour')`;
            if (entityType) {
                params.push(entityType);
                where += ` AND entity_type = $${params.length}`;
            }
            if (entityId) {
                params.push(entityId);
                where += ` AND entity_id = $${params.length}`;
            }
            params.push(80);

            const logs = await pool.query(
                `SELECT actor_role, action, entity_type, entity_id, created_at, meta_json
                 FROM admin_audit_logs
                 ${where}
                 ORDER BY created_at DESC
                 LIMIT $${params.length}`,
                params
            );

            const rows = logs.rows || [];
            const actionCounts = {};
            for (const row of rows) {
                const action = String(row.action || 'unknown');
                actionCounts[action] = (actionCounts[action] || 0) + 1;
            }
            const topActions = Object.entries(actionCounts).sort((a, b) => b[1] - a[1]).slice(0, 5);

            const lines = [
                `سرد سببي للفترة آخر ${windowHours} ساعة:`,
                `- عدد الأحداث المسجلة: ${rows.length}.`,
                topActions.length ? `- أكثر الأفعال تكرارًا: ${topActions.map(([a, c]) => `${a}(${c})`).join('، ')}.` : '- لا توجد أفعال كافية للتحليل.',
                rows[0] ? `- آخر فعل: ${rows[0].action} بواسطة دور ${rows[0].actor_role || 'unknown'} عند ${new Date(rows[0].created_at).toLocaleString('ar-EG')}.` : '- لا يوجد حدث أخير.',
                'الاستنتاج: القرار الإداري مبني على تسلسل قابل للتتبع من الفعل إلى الأثر.'
            ].join('\n');

            const ins = await pool.query(
                `INSERT INTO admin_narrative_audits
                    (title, entity_type, entity_id, window_hours, narrative_text, stats_json, created_by_user_id)
                 VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7)
                 RETURNING *`,
                [title, entityType, entityId, windowHours, lines, JSON.stringify({ top_actions: topActions, events: rows.length }), req.auth?.uid || null]
            );

            await writeAdminAudit(req, {
                action: 'innovations.narrative_audit.build',
                entity_type: entityType || 'audit',
                entity_id: entityId || String(ins.rows?.[0]?.id || ''),
                meta: { window_hours: windowHours, events: rows.length }
            });

            res.status(201).json({ success: true, data: ins.rows[0] });
        } catch (e) {
            res.status(500).json({ success: false, error: e.message });
        }
    });

    app.get('/api/admin/innovations/narrative-audit', requirePermission('admin.innovations.read'), async (req, res) => {
        try {
            const limit = clamp(req.query.limit, 1, 120, 40);
            const rows = await pool.query(
                `SELECT *
                 FROM admin_narrative_audits
                 ORDER BY created_at DESC
                 LIMIT $1`,
                [limit]
            );
            res.json({ success: true, data: rows.rows });
        } catch (e) {
            res.status(500).json({ success: false, error: e.message });
        }
    });

    app.post('/api/admin/innovations/copilot-arena/session', requirePermission('admin.innovations.write'), async (req, res) => {
        try {
            const scenarioType = String(req.body?.scenario_type || 'operations').trim().slice(0, 80);
            const difficulty = String(req.body?.difficulty || 'normal').trim().toLowerCase().slice(0, 20);
            const baseline = await computeOpsBaseline(pool);

            const scenario = {
                context: baseline,
                prompt: `سيناريو ${scenarioType}: ارتفع الانتظار إلى ${baseline.avg_wait_minutes} دقيقة مع معدل إلغاء ${baseline.cancel_rate}. ما قرارك؟`,
                objectives: ['خفض زمن الانتظار', 'تقليل الإلغاءات', 'الحفاظ على السلامة'],
                generated_at: new Date().toISOString(),
                difficulty
            };

            const ins = await pool.query(
                `INSERT INTO admin_copilot_arena_sessions (scenario_type, difficulty, scenario_json, created_by_user_id)
                 VALUES ($1,$2,$3::jsonb,$4)
                 RETURNING *`,
                [scenarioType, difficulty, JSON.stringify(scenario), req.auth?.uid || null]
            );

            await writeAdminAudit(req, {
                action: 'innovations.copilot_arena.session_create',
                entity_type: 'copilot_session',
                entity_id: String(ins.rows?.[0]?.id || ''),
                meta: { scenario_type: scenarioType, difficulty }
            });

            res.status(201).json({ success: true, data: ins.rows[0] });
        } catch (e) {
            res.status(500).json({ success: false, error: e.message });
        }
    });

    app.patch('/api/admin/innovations/copilot-arena/session/:id/score', requirePermission('admin.innovations.decide'), async (req, res) => {
        try {
            const id = Number(req.params.id);
            if (!Number.isFinite(id) || id <= 0) return res.status(400).json({ success: false, error: 'invalid_id' });

            const submitted = req.body?.submitted_decision && typeof req.body.submitted_decision === 'object'
                ? req.body.submitted_decision
                : {};
            const actionSpeed = clamp(submitted.action_speed, 0, 100, 40);
            const safetyWeight = clamp(submitted.safety_weight, 0, 100, 40);
            const fairnessWeight = clamp(submitted.fairness_weight, 0, 100, 40);
            const score = Number((actionSpeed * 0.35 + safetyWeight * 0.4 + fairnessWeight * 0.25).toFixed(2));
            const feedback = score >= 80
                ? 'استجابة قوية ومتوازنة.'
                : score >= 60
                    ? 'أداء جيد، يحتاج تحسين في التوازن بين السرعة والسلامة.'
                    : 'التوصية: عزز أولويات السلامة والعدالة مع خطة تنفيذ أوضح.';

            const up = await pool.query(
                `UPDATE admin_copilot_arena_sessions
                 SET submitted_decision_json = $2::jsonb,
                     score = $3,
                     feedback = $4,
                     scored_by_user_id = $5,
                     scored_at = CURRENT_TIMESTAMP
                 WHERE id = $1
                 RETURNING *`,
                [id, JSON.stringify(submitted), score, feedback, req.auth?.uid || null]
            );

            if (!up.rows.length) return res.status(404).json({ success: false, error: 'not_found' });

            await writeAdminAudit(req, {
                action: 'innovations.copilot_arena.score',
                entity_type: 'copilot_session',
                entity_id: String(id),
                meta: { score }
            });

            res.json({ success: true, data: up.rows[0] });
        } catch (e) {
            res.status(500).json({ success: false, error: e.message });
        }
    });

    app.get('/api/admin/innovations/copilot-arena/sessions', requirePermission('admin.innovations.read'), async (req, res) => {
        try {
            const rows = await pool.query(
                `SELECT *
                 FROM admin_copilot_arena_sessions
                 ORDER BY created_at DESC
                 LIMIT 80`
            );
            res.json({ success: true, data: rows.rows });
        } catch (e) {
            res.status(500).json({ success: false, error: e.message });
        }
    });

    app.post('/api/admin/innovations/hub-rebalancer/rebalance', requirePermission('admin.innovations.simulate'), async (req, res) => {
        try {
            const zoneRows = await pool.query(
                `SELECT CASE
                            WHEN pickup_lat IS NULL OR pickup_lng IS NULL THEN 'citywide'
                            ELSE CONCAT(ROUND(CAST(pickup_lat AS numeric),1), ',', ROUND(CAST(pickup_lng AS numeric),1))
                        END AS zone_key,
                        COUNT(*)::int AS demand
                 FROM pending_ride_requests
                 WHERE status IN ('waiting','accepted')
                   AND created_at >= NOW() - INTERVAL '2 hours'
                 GROUP BY zone_key
                 ORDER BY demand DESC
                 LIMIT 8`
            );

            const hubs = await pool.query(
                `SELECT id, title, lat, lng, is_active
                 FROM pickup_hubs
                 WHERE is_active = true
                 ORDER BY id ASC
                 LIMIT 50`
            );

            const activeHubs = hubs.rows || [];
            const sourceHubId = activeHubs[0]?.id || null;
            let created = 0;
            for (const z of zoneRows.rows || []) {
                if (!activeHubs.length) break;
                const targetHub = activeHubs[created % activeHubs.length];
                const shift = Math.max(1, Math.min(10, Math.round(Number(z.demand || 0) / 4)));
                await pool.query(
                    `INSERT INTO admin_hub_rebalance_actions
                        (zone_key, source_hub_id, target_hub_id, suggested_shift, rationale, status, created_by_user_id)
                     VALUES ($1,$2,$3,$4,$5,'proposed',$6)`,
                    [normalizeZoneKey(z.zone_key), sourceHubId, targetHub.id, shift, `Demand spike detected (${z.demand})`, req.auth?.uid || null]
                );
                created += 1;
            }

            await writeAdminAudit(req, {
                action: 'innovations.hub_rebalancer.rebalance',
                entity_type: 'hub_rebalance',
                entity_id: 'batch',
                meta: { actions: created }
            });

            res.json({ success: true, data: { created_actions: created } });
        } catch (e) {
            res.status(500).json({ success: false, error: e.message });
        }
    });

    app.get('/api/admin/innovations/hub-rebalancer/actions', requirePermission('admin.innovations.read'), async (req, res) => {
        try {
            const rows = await pool.query(
                `SELECT a.*, hs.title AS source_hub_title, ht.title AS target_hub_title
                 FROM admin_hub_rebalance_actions a
                 LEFT JOIN pickup_hubs hs ON hs.id = a.source_hub_id
                 LEFT JOIN pickup_hubs ht ON ht.id = a.target_hub_id
                 ORDER BY a.created_at DESC
                 LIMIT 100`
            );
            res.json({ success: true, data: rows.rows });
        } catch (e) {
            res.status(500).json({ success: false, error: e.message });
        }
    });

    app.get('/api/admin/innovations/kpis/summary', requirePermission('admin.innovations.read'), async (req, res) => {
        try {
            const [crisisRes, reopenRes, outcomeRes, falseAlertRes, mttrRes] = await Promise.all([
                pool.query(`SELECT COUNT(*)::int AS total,
                                   COUNT(*) FILTER (WHERE risk_level IN ('high','critical'))::int AS high_risk
                            FROM admin_silent_crisis_predictions
                            WHERE created_at >= NOW() - INTERVAL '30 days'`),
                pool.query(`SELECT COALESCE(AVG(100 - expected_reopen_reduction_pct), 0)::numeric(10,2) AS reopen_rate_proxy
                            FROM admin_recovery_composer_plans
                            WHERE created_at >= NOW() - INTERVAL '30 days'`),
                pool.query(`SELECT COALESCE(AVG(accuracy_score), 0)::numeric(10,2) AS decision_accuracy
                            FROM admin_outcome_market
                            WHERE status = 'settled'
                              AND settled_at >= NOW() - INTERVAL '30 days'`),
                pool.query(`SELECT COUNT(*)::int AS total,
                                   COUNT(*) FILTER (WHERE score < 20)::int AS false_like
                            FROM admin_silent_crisis_predictions
                            WHERE created_at >= NOW() - INTERVAL '30 days'`),
                pool.query(`SELECT COALESCE(AVG(EXTRACT(EPOCH FROM (created_at - created_at))/60.0), 0)::numeric(10,2) AS mttr_minutes
                            FROM admin_innovation_runs
                            WHERE created_at >= NOW() - INTERVAL '30 days'`)
            ]);

            const crisisTotal = Number(crisisRes.rows?.[0]?.total || 0);
            const crisisHigh = Number(crisisRes.rows?.[0]?.high_risk || 0);
            const falseTotal = Number(falseAlertRes.rows?.[0]?.total || 0);
            const falseLike = Number(falseAlertRes.rows?.[0]?.false_like || 0);

            const kpis = {
                mttr_minutes: Number(mttrRes.rows?.[0]?.mttr_minutes || 0),
                crisis_prevention_rate: crisisTotal > 0 ? Number(((crisisHigh / crisisTotal) * 100).toFixed(2)) : 0,
                dispute_reopen_rate_proxy: Number(reopenRes.rows?.[0]?.reopen_rate_proxy || 0),
                decision_accuracy_vs_actual: Number(outcomeRes.rows?.[0]?.decision_accuracy || 0),
                false_alert_rate: falseTotal > 0 ? Number(((falseLike / falseTotal) * 100).toFixed(2)) : 0
            };

            res.json({ success: true, data: kpis });
        } catch (e) {
            res.status(500).json({ success: false, error: e.message });
        }
    });
}

module.exports = {
    ensureAdminInnovationTables,
    ensureDefaultAdminInnovationFeatures,
    registerAdminInnovationRoutes
};
