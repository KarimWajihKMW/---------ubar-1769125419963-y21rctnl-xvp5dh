const express = require('express');
const promClient = require('prom-client');
const { Pool } = require('pg');

const app = express();
const PORT = Number(process.env.OPS_SERVICE_PORT || 4103);
const useDatabase = Boolean(process.env.DATABASE_URL);
const pool = useDatabase ? new Pool({ connectionString: process.env.DATABASE_URL }) : null;

const metricsRegistry = new promClient.Registry();
promClient.collectDefaultMetrics({ register: metricsRegistry, prefix: 'ubar_ops_service_' });
const requestCounter = new promClient.Counter({
    name: 'ubar_ops_service_http_requests_total',
    help: 'Total HTTP requests handled by ops service',
    labelNames: ['method', 'route', 'status_code'],
    registers: [metricsRegistry]
});

const memTickets = [];
const memAudit = [];
const memAssignments = [];
const memEscalations = [];

app.use(express.json({ limit: '1mb' }));

function getTenantId(req) {
    const tenantId = String(req.headers['x-tenant-id'] || 'public').trim();
    return tenantId || 'public';
}

function getRole(req) {
    return String(req.headers['x-role'] || 'system').trim().toLowerCase();
}

function requireRole(allowedRoles) {
    const normalized = new Set(allowedRoles.map((r) => String(r).toLowerCase()));
    return (req, res, next) => {
        const role = getRole(req);
        if (!normalized.has(role)) {
            return res.status(403).json({ success: false, error: 'forbidden', required_roles: Array.from(normalized) });
        }
        next();
    };
}

async function ensureSchema() {
    if (!pool) return;

    await pool.query(`
        CREATE TABLE IF NOT EXISTS ms_support_tickets (
            id BIGSERIAL PRIMARY KEY,
            tenant_id TEXT NOT NULL,
            rider_id TEXT,
            driver_id TEXT,
            category TEXT NOT NULL,
            priority TEXT NOT NULL DEFAULT 'normal',
            status TEXT NOT NULL DEFAULT 'open',
            summary TEXT NOT NULL,
            details TEXT,
            created_by_role TEXT NOT NULL DEFAULT 'system',
            assignee TEXT,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
    `);

    await pool.query(`
        CREATE TABLE IF NOT EXISTS ms_dispatch_assignments (
            id BIGSERIAL PRIMARY KEY,
            tenant_id TEXT NOT NULL,
            trip_id TEXT NOT NULL,
            driver_id TEXT NOT NULL,
            assigned_by TEXT NOT NULL,
            reason TEXT,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
    `);

    await pool.query(`
        CREATE TABLE IF NOT EXISTS ms_audit_logs (
            id BIGSERIAL PRIMARY KEY,
            tenant_id TEXT NOT NULL,
            actor_role TEXT NOT NULL,
            action TEXT NOT NULL,
            target_type TEXT,
            target_id TEXT,
            metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
    `);

    await pool.query(`
        CREATE TABLE IF NOT EXISTS ms_ticket_escalations (
            id BIGSERIAL PRIMARY KEY,
            tenant_id TEXT NOT NULL,
            ticket_id TEXT NOT NULL,
            escalated_by_role TEXT NOT NULL,
            level TEXT NOT NULL DEFAULT 'high',
            reason TEXT NOT NULL,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
    `);
}

async function writeAudit({ tenantId, actorRole, action, targetType, targetId, metadata }) {
    if (!pool) {
        memAudit.push({
            id: `audit-${Date.now()}-${Math.floor(Math.random() * 1000)}`,
            tenant_id: tenantId,
            actor_role: actorRole,
            action,
            target_type: targetType || null,
            target_id: targetId || null,
            metadata: metadata || {},
            created_at: new Date().toISOString()
        });
        return;
    }

    await pool.query(
        `INSERT INTO ms_audit_logs (tenant_id, actor_role, action, target_type, target_id, metadata)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [tenantId, actorRole, action, targetType || null, targetId || null, metadata || {}]
    );
}

app.use((req, res, next) => {
    res.on('finish', () => {
        const route = req.route && req.route.path ? String(req.route.path) : String(req.path || req.url || 'unknown');
        requestCounter.inc({ method: req.method, route, status_code: String(res.statusCode || 0) });
    });
    next();
});

app.get('/api/ops-service/health', (_req, res) => {
    return res.json({ success: true, service: 'ops-service', status: 'ok', database_mode: useDatabase ? 'postgres' : 'memory' });
});

app.get('/metrics', async (_req, res) => {
    res.set('Content-Type', metricsRegistry.contentType);
    res.end(await metricsRegistry.metrics());
});

app.get('/api/ops-service/dispatch/queue', async (req, res) => {
    const tenantId = getTenantId(req);
    const queueCounts = {
        waiting_requests: Math.floor(Math.random() * 20),
        nearby_available_drivers: Math.floor(Math.random() * 60) + 20,
        delayed_requests: Math.floor(Math.random() * 4)
    };

    let latestAssignments = [];
    if (pool) {
        const result = await pool.query(
            `SELECT id, tenant_id, trip_id, driver_id, assigned_by, reason, created_at
             FROM ms_dispatch_assignments
             WHERE tenant_id = $1
             ORDER BY id DESC
             LIMIT 10`,
            [tenantId]
        );
        latestAssignments = result.rows;
    } else {
        latestAssignments = memAssignments.filter((x) => x.tenant_id === tenantId).slice(-10).reverse();
    }

    return res.json({
        success: true,
        data: {
            tenant_id: tenantId,
            queue: queueCounts,
            latest_assignments: latestAssignments
        }
    });
});

app.post('/api/ops-service/dispatch/manual-assign', requireRole(['admin', 'dispatcher']), async (req, res) => {
    try {
        const tenantId = getTenantId(req);
        const actorRole = getRole(req);
        const tripId = String(req.body.trip_id || '').trim();
        const driverId = String(req.body.driver_id || '').trim();
        const reason = String(req.body.reason || 'manual_intervention').trim();

        if (!tripId || !driverId) {
            return res.status(400).json({ success: false, error: 'trip_id_and_driver_id_required' });
        }

        let assignment;
        if (pool) {
            const result = await pool.query(
                `INSERT INTO ms_dispatch_assignments (tenant_id, trip_id, driver_id, assigned_by, reason)
                 VALUES ($1, $2, $3, $4, $5)
                 RETURNING id, tenant_id, trip_id, driver_id, assigned_by, reason, created_at`,
                [tenantId, tripId, driverId, actorRole, reason]
            );
            assignment = result.rows[0];
        } else {
            assignment = {
                id: `assign-${Date.now()}`,
                tenant_id: tenantId,
                trip_id: tripId,
                driver_id: driverId,
                assigned_by: actorRole,
                reason,
                created_at: new Date().toISOString()
            };
            memAssignments.push(assignment);
        }

        await writeAudit({
            tenantId,
            actorRole,
            action: 'dispatcher_manual_assign',
            targetType: 'trip',
            targetId: tripId,
            metadata: { driver_id: driverId, reason }
        });

        return res.json({ success: true, data: assignment });
    } catch (error) {
        return res.status(500).json({ success: false, error: 'manual_assign_failed', message: error.message });
    }
});

app.post('/api/ops-service/support/tickets', async (req, res) => {
    try {
        const tenantId = getTenantId(req);
        const actorRole = getRole(req);
        const payload = {
            rider_id: req.body.rider_id ? String(req.body.rider_id).trim() : null,
            driver_id: req.body.driver_id ? String(req.body.driver_id).trim() : null,
            category: String(req.body.category || '').trim(),
            priority: String(req.body.priority || 'normal').trim().toLowerCase(),
            summary: String(req.body.summary || '').trim(),
            details: String(req.body.details || '').trim(),
            assignee: req.body.assignee ? String(req.body.assignee).trim() : null
        };

        if (!payload.category || !payload.summary) {
            return res.status(400).json({ success: false, error: 'category_and_summary_required' });
        }

        let ticket;
        if (pool) {
            const result = await pool.query(
                `INSERT INTO ms_support_tickets (tenant_id, rider_id, driver_id, category, priority, summary, details, created_by_role, assignee)
                 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
                 RETURNING id, tenant_id, rider_id, driver_id, category, priority, status, summary, details, created_by_role, assignee, created_at, updated_at`,
                [tenantId, payload.rider_id, payload.driver_id, payload.category, payload.priority, payload.summary, payload.details, actorRole, payload.assignee]
            );
            ticket = result.rows[0];
        } else {
            ticket = {
                id: `ticket-${Date.now()}`,
                tenant_id: tenantId,
                rider_id: payload.rider_id,
                driver_id: payload.driver_id,
                category: payload.category,
                priority: payload.priority,
                status: 'open',
                summary: payload.summary,
                details: payload.details,
                created_by_role: actorRole,
                assignee: payload.assignee,
                created_at: new Date().toISOString(),
                updated_at: new Date().toISOString()
            };
            memTickets.push(ticket);
        }

        await writeAudit({
            tenantId,
            actorRole,
            action: 'support_ticket_created',
            targetType: 'ticket',
            targetId: String(ticket.id),
            metadata: { category: payload.category, priority: payload.priority }
        });

        return res.json({ success: true, data: ticket });
    } catch (error) {
        return res.status(500).json({ success: false, error: 'ticket_create_failed', message: error.message });
    }
});

app.get('/api/ops-service/support/tickets', async (req, res) => {
    try {
        const tenantId = getTenantId(req);
        const status = req.query.status ? String(req.query.status).trim().toLowerCase() : null;
        const limit = Math.max(1, Math.min(100, Number(req.query.limit || 25)));

        if (pool) {
            const values = [tenantId, limit];
            let query = `
                SELECT id, tenant_id, rider_id, driver_id, category, priority, status, summary, details, created_by_role, assignee, created_at, updated_at
                FROM ms_support_tickets
                WHERE tenant_id = $1
            `;
            if (status) {
                query += ' AND status = $3';
                values.push(status);
            }
            query += ' ORDER BY id DESC LIMIT $2';

            const result = await pool.query(query, values);
            return res.json({ success: true, data: result.rows });
        }

        let items = memTickets.filter((x) => x.tenant_id === tenantId);
        if (status) items = items.filter((x) => x.status === status);
        return res.json({ success: true, data: items.slice(-limit).reverse() });
    } catch (error) {
        return res.status(500).json({ success: false, error: 'ticket_list_failed', message: error.message });
    }
});

app.patch('/api/ops-service/support/tickets/:id', requireRole(['admin', 'support', 'dispatcher']), async (req, res) => {
    try {
        const tenantId = getTenantId(req);
        const actorRole = getRole(req);
        const id = String(req.params.id || '').trim();
        const status = req.body.status ? String(req.body.status).trim().toLowerCase() : null;
        const assignee = req.body.assignee ? String(req.body.assignee).trim() : null;

        if (!status && !assignee) {
            return res.status(400).json({ success: false, error: 'status_or_assignee_required' });
        }

        let ticket;
        if (pool) {
            const result = await pool.query(
                `UPDATE ms_support_tickets
                 SET status = COALESCE($3, status),
                     assignee = COALESCE($4, assignee),
                     updated_at = NOW()
                 WHERE tenant_id = $1 AND id::text = $2
                 RETURNING id, tenant_id, rider_id, driver_id, category, priority, status, summary, details, created_by_role, assignee, created_at, updated_at`,
                [tenantId, id, status, assignee]
            );
            ticket = result.rows[0];
        } else {
            const idx = memTickets.findIndex((x) => x.tenant_id === tenantId && String(x.id) === id);
            if (idx >= 0) {
                if (status) memTickets[idx].status = status;
                if (assignee) memTickets[idx].assignee = assignee;
                memTickets[idx].updated_at = new Date().toISOString();
                ticket = memTickets[idx];
            }
        }

        if (!ticket) {
            return res.status(404).json({ success: false, error: 'ticket_not_found' });
        }

        await writeAudit({
            tenantId,
            actorRole,
            action: 'support_ticket_updated',
            targetType: 'ticket',
            targetId: String(ticket.id),
            metadata: { status, assignee }
        });

        return res.json({ success: true, data: ticket });
    } catch (error) {
        return res.status(500).json({ success: false, error: 'ticket_update_failed', message: error.message });
    }
});

app.post('/api/ops-service/support/tickets/:id/escalate', requireRole(['admin', 'support', 'compliance']), async (req, res) => {
    try {
        const tenantId = getTenantId(req);
        const actorRole = getRole(req);
        const id = String(req.params.id || '').trim();
        const level = String(req.body.level || 'high').trim().toLowerCase();
        const reason = String(req.body.reason || '').trim();

        if (!reason) {
            return res.status(400).json({ success: false, error: 'reason_required' });
        }

        let ticket = null;
        if (pool) {
            const ticketResult = await pool.query(
                `SELECT id, tenant_id, rider_id, driver_id, category, priority, status, summary, details, created_by_role, assignee, created_at, updated_at
                 FROM ms_support_tickets
                 WHERE tenant_id = $1 AND id::text = $2`,
                [tenantId, id]
            );
            ticket = ticketResult.rows[0] || null;
        } else {
            ticket = memTickets.find((x) => x.tenant_id === tenantId && String(x.id) === id) || null;
        }

        if (!ticket) {
            return res.status(404).json({ success: false, error: 'ticket_not_found' });
        }

        let escalation;
        if (pool) {
            const escalationResult = await pool.query(
                `INSERT INTO ms_ticket_escalations (tenant_id, ticket_id, escalated_by_role, level, reason)
                 VALUES ($1, $2, $3, $4, $5)
                 RETURNING id, tenant_id, ticket_id, escalated_by_role, level, reason, created_at`,
                [tenantId, id, actorRole, level, reason]
            );
            escalation = escalationResult.rows[0];

            const ticketUpdate = await pool.query(
                `UPDATE ms_support_tickets
                 SET priority = 'critical',
                     status = CASE WHEN status = 'closed' THEN status ELSE 'escalated' END,
                     updated_at = NOW()
                 WHERE tenant_id = $1 AND id::text = $2
                 RETURNING id, tenant_id, rider_id, driver_id, category, priority, status, summary, details, created_by_role, assignee, created_at, updated_at`,
                [tenantId, id]
            );
            ticket = ticketUpdate.rows[0] || ticket;
        } else {
            escalation = {
                id: `esc-${Date.now()}-${Math.floor(Math.random() * 1000)}`,
                tenant_id: tenantId,
                ticket_id: id,
                escalated_by_role: actorRole,
                level,
                reason,
                created_at: new Date().toISOString()
            };
            memEscalations.push(escalation);

            const idx = memTickets.findIndex((x) => x.tenant_id === tenantId && String(x.id) === id);
            if (idx >= 0) {
                memTickets[idx].priority = 'critical';
                if (memTickets[idx].status !== 'closed') {
                    memTickets[idx].status = 'escalated';
                }
                memTickets[idx].updated_at = new Date().toISOString();
                ticket = memTickets[idx];
            }
        }

        await writeAudit({
            tenantId,
            actorRole,
            action: 'support_ticket_escalated',
            targetType: 'ticket',
            targetId: id,
            metadata: { level, reason }
        });

        return res.json({ success: true, data: { escalation, ticket } });
    } catch (error) {
        return res.status(500).json({ success: false, error: 'ticket_escalation_failed', message: error.message });
    }
});

app.get('/api/ops-service/support/escalations', requireRole(['admin', 'support', 'compliance']), async (req, res) => {
    try {
        const tenantId = getTenantId(req);
        const limit = Math.max(1, Math.min(100, Number(req.query.limit || 25)));

        if (pool) {
            const result = await pool.query(
                `SELECT id, tenant_id, ticket_id, escalated_by_role, level, reason, created_at
                 FROM ms_ticket_escalations
                 WHERE tenant_id = $1
                 ORDER BY id DESC
                 LIMIT $2`,
                [tenantId, limit]
            );
            return res.json({ success: true, data: result.rows });
        }

        const items = memEscalations.filter((x) => x.tenant_id === tenantId).slice(-limit).reverse();
        return res.json({ success: true, data: items });
    } catch (error) {
        return res.status(500).json({ success: false, error: 'escalation_list_failed', message: error.message });
    }
});

app.get('/api/ops-service/support/sla/breaches', requireRole(['admin', 'support', 'compliance']), async (req, res) => {
    try {
        const tenantId = getTenantId(req);
        const limit = Math.max(1, Math.min(100, Number(req.query.limit || 25)));
        const maxOpenMinutes = Math.max(0, Number(req.query.max_open_minutes || 30));

        if (pool) {
            const result = await pool.query(
                `SELECT id, tenant_id, rider_id, driver_id, category, priority, status, summary, details, created_by_role, assignee, created_at, updated_at,
                        ROUND(EXTRACT(EPOCH FROM (NOW() - created_at)) / 60.0, 2) AS age_minutes
                 FROM ms_support_tickets
                 WHERE tenant_id = $1
                   AND status IN ('open', 'escalated', 'in_progress')
                   AND EXTRACT(EPOCH FROM (NOW() - created_at)) / 60.0 >= $2
                 ORDER BY created_at ASC
                 LIMIT $3`,
                [tenantId, maxOpenMinutes, limit]
            );

            return res.json({
                success: true,
                data: {
                    tenant_id: tenantId,
                    max_open_minutes: maxOpenMinutes,
                    breach_count: result.rows.length,
                    tickets: result.rows
                }
            });
        }

        const now = Date.now();
        const tickets = memTickets
            .filter((x) => x.tenant_id === tenantId)
            .filter((x) => ['open', 'escalated', 'in_progress'].includes(String(x.status || '').toLowerCase()))
            .map((x) => {
                const createdAtMs = Date.parse(x.created_at || new Date().toISOString());
                const ageMinutes = Math.max(0, (now - createdAtMs) / (1000 * 60));
                return {
                    ...x,
                    age_minutes: Number(ageMinutes.toFixed(2))
                };
            })
            .filter((x) => x.age_minutes >= maxOpenMinutes)
            .sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at))
            .slice(0, limit);

        return res.json({
            success: true,
            data: {
                tenant_id: tenantId,
                max_open_minutes: maxOpenMinutes,
                breach_count: tickets.length,
                tickets
            }
        });
    } catch (error) {
        return res.status(500).json({ success: false, error: 'sla_breach_list_failed', message: error.message });
    }
});

app.get('/api/ops-service/support/kpis', requireRole(['admin', 'support', 'compliance']), async (req, res) => {
    try {
        const tenantId = getTenantId(req);
        const windowMinutes = Math.max(1, Math.min(7 * 24 * 60, Number(req.query.window_minutes || 1440)));

        if (pool) {
            const totalsRes = await pool.query(
                `SELECT
                    COUNT(*)::int AS total_tickets,
                    COUNT(*) FILTER (WHERE status = 'open')::int AS open_tickets,
                    COUNT(*) FILTER (WHERE status = 'escalated')::int AS escalated_tickets,
                    COUNT(*) FILTER (WHERE status = 'closed')::int AS closed_tickets,
                    COUNT(*) FILTER (WHERE priority = 'critical')::int AS critical_tickets,
                    ROUND(AVG(EXTRACT(EPOCH FROM (NOW() - created_at)) / 60.0) FILTER (WHERE status IN ('open', 'escalated', 'in_progress')), 2) AS avg_open_age_minutes
                 FROM ms_support_tickets
                 WHERE tenant_id = $1`,
                [tenantId]
            );

            const breachesRes = await pool.query(
                `SELECT COUNT(*)::int AS breach_count
                 FROM ms_support_tickets
                 WHERE tenant_id = $1
                   AND status IN ('open', 'escalated', 'in_progress')
                   AND EXTRACT(EPOCH FROM (NOW() - created_at)) / 60.0 >= 30`,
                [tenantId]
            );

            const escalationsWindowRes = await pool.query(
                `SELECT COUNT(*)::int AS escalations_in_window
                 FROM ms_ticket_escalations
                 WHERE tenant_id = $1
                   AND created_at >= NOW() - ($2::text || ' minutes')::interval`,
                [tenantId, windowMinutes]
            );

            const t = totalsRes.rows[0] || {};
            const b = breachesRes.rows[0] || {};
            const ew = escalationsWindowRes.rows[0] || {};

            return res.json({
                success: true,
                data: {
                    tenant_id: tenantId,
                    window_minutes: windowMinutes,
                    total_tickets: Number(t.total_tickets || 0),
                    open_tickets: Number(t.open_tickets || 0),
                    escalated_tickets: Number(t.escalated_tickets || 0),
                    closed_tickets: Number(t.closed_tickets || 0),
                    critical_tickets: Number(t.critical_tickets || 0),
                    avg_open_age_minutes: Number(t.avg_open_age_minutes || 0),
                    sla_breach_count: Number(b.breach_count || 0),
                    escalations_in_window: Number(ew.escalations_in_window || 0)
                }
            });
        }

        const now = Date.now();
        const windowMs = windowMinutes * 60 * 1000;
        const ticketSet = memTickets.filter((x) => x.tenant_id === tenantId);
        const openStatuses = new Set(['open', 'escalated', 'in_progress']);

        const openTickets = ticketSet.filter((x) => String(x.status || '').toLowerCase() === 'open').length;
        const escalatedTickets = ticketSet.filter((x) => String(x.status || '').toLowerCase() === 'escalated').length;
        const closedTickets = ticketSet.filter((x) => String(x.status || '').toLowerCase() === 'closed').length;
        const criticalTickets = ticketSet.filter((x) => String(x.priority || '').toLowerCase() === 'critical').length;

        const openAges = ticketSet
            .filter((x) => openStatuses.has(String(x.status || '').toLowerCase()))
            .map((x) => {
                const createdAtMs = Date.parse(x.created_at || new Date().toISOString());
                return Math.max(0, (now - createdAtMs) / (1000 * 60));
            });

        const avgOpenAgeMinutes = openAges.length
            ? Number((openAges.reduce((sum, v) => sum + v, 0) / openAges.length).toFixed(2))
            : 0;

        const slaBreachCount = ticketSet
            .filter((x) => openStatuses.has(String(x.status || '').toLowerCase()))
            .filter((x) => {
                const createdAtMs = Date.parse(x.created_at || new Date().toISOString());
                const ageMinutes = Math.max(0, (now - createdAtMs) / (1000 * 60));
                return ageMinutes >= 30;
            }).length;

        const escalationsInWindow = memEscalations
            .filter((x) => x.tenant_id === tenantId)
            .filter((x) => {
                const createdAtMs = Date.parse(x.created_at || new Date().toISOString());
                return now - createdAtMs <= windowMs;
            }).length;

        return res.json({
            success: true,
            data: {
                tenant_id: tenantId,
                window_minutes: windowMinutes,
                total_tickets: ticketSet.length,
                open_tickets: openTickets,
                escalated_tickets: escalatedTickets,
                closed_tickets: closedTickets,
                critical_tickets: criticalTickets,
                avg_open_age_minutes: avgOpenAgeMinutes,
                sla_breach_count: slaBreachCount,
                escalations_in_window: escalationsInWindow
            }
        });
    } catch (error) {
        return res.status(500).json({ success: false, error: 'support_kpis_failed', message: error.message });
    }
});

app.get('/api/ops-service/support/alerts', requireRole(['admin', 'support', 'compliance']), async (req, res) => {
    try {
        const tenantId = getTenantId(req);
        const maxOpenMinutes = Math.max(0, Number(req.query.max_open_minutes || 30));
        const breachThreshold = Math.max(1, Number(req.query.breach_threshold || 1));
        const escalationThreshold = Math.max(1, Number(req.query.escalation_threshold || 1));
        const criticalThreshold = Math.max(1, Number(req.query.critical_threshold || 1));
        const windowMinutes = Math.max(1, Math.min(7 * 24 * 60, Number(req.query.window_minutes || 60)));

        let totalTickets = 0;
        let escalatedTickets = 0;
        let criticalTickets = 0;
        let slaBreachCount = 0;
        let escalationsInWindow = 0;

        if (pool) {
            const totalsRes = await pool.query(
                `SELECT
                    COUNT(*)::int AS total_tickets,
                    COUNT(*) FILTER (WHERE status = 'escalated')::int AS escalated_tickets,
                    COUNT(*) FILTER (WHERE priority = 'critical')::int AS critical_tickets
                 FROM ms_support_tickets
                 WHERE tenant_id = $1`,
                [tenantId]
            );

            const breachesRes = await pool.query(
                `SELECT COUNT(*)::int AS breach_count
                 FROM ms_support_tickets
                 WHERE tenant_id = $1
                   AND status IN ('open', 'escalated', 'in_progress')
                   AND EXTRACT(EPOCH FROM (NOW() - created_at)) / 60.0 >= $2`,
                [tenantId, maxOpenMinutes]
            );

            const escalationsWindowRes = await pool.query(
                `SELECT COUNT(*)::int AS escalations_in_window
                 FROM ms_ticket_escalations
                 WHERE tenant_id = $1
                   AND created_at >= NOW() - ($2::text || ' minutes')::interval`,
                [tenantId, windowMinutes]
            );

            const t = totalsRes.rows[0] || {};
            const b = breachesRes.rows[0] || {};
            const e = escalationsWindowRes.rows[0] || {};

            totalTickets = Number(t.total_tickets || 0);
            escalatedTickets = Number(t.escalated_tickets || 0);
            criticalTickets = Number(t.critical_tickets || 0);
            slaBreachCount = Number(b.breach_count || 0);
            escalationsInWindow = Number(e.escalations_in_window || 0);
        } else {
            const now = Date.now();
            const windowMs = windowMinutes * 60 * 1000;
            const openStatuses = new Set(['open', 'escalated', 'in_progress']);
            const ticketSet = memTickets.filter((x) => x.tenant_id === tenantId);

            totalTickets = ticketSet.length;
            escalatedTickets = ticketSet.filter((x) => String(x.status || '').toLowerCase() === 'escalated').length;
            criticalTickets = ticketSet.filter((x) => String(x.priority || '').toLowerCase() === 'critical').length;
            slaBreachCount = ticketSet
                .filter((x) => openStatuses.has(String(x.status || '').toLowerCase()))
                .filter((x) => {
                    const createdAtMs = Date.parse(x.created_at || new Date().toISOString());
                    const ageMinutes = Math.max(0, (now - createdAtMs) / (1000 * 60));
                    return ageMinutes >= maxOpenMinutes;
                }).length;
            escalationsInWindow = memEscalations
                .filter((x) => x.tenant_id === tenantId)
                .filter((x) => {
                    const createdAtMs = Date.parse(x.created_at || new Date().toISOString());
                    return now - createdAtMs <= windowMs;
                }).length;
        }

        const alerts = [];
        if (slaBreachCount >= breachThreshold) {
            alerts.push({
                code: 'sla_breach_spike',
                severity: slaBreachCount >= breachThreshold * 2 ? 'high' : 'medium',
                message: `Detected ${slaBreachCount} ticket(s) above ${maxOpenMinutes} minutes open time.`,
                recommended_actions: ['increase_support_capacity', 'prioritize_oldest_tickets']
            });
        }
        if (escalationsInWindow >= escalationThreshold) {
            alerts.push({
                code: 'escalation_activity_high',
                severity: escalationsInWindow >= escalationThreshold * 2 ? 'high' : 'medium',
                message: `Detected ${escalationsInWindow} escalation(s) in the last ${windowMinutes} minutes.`,
                recommended_actions: ['assign_senior_reviewers', 'audit_high_risk_cases']
            });
        }
        if (criticalTickets >= criticalThreshold) {
            alerts.push({
                code: 'critical_backlog_present',
                severity: criticalTickets >= criticalThreshold * 2 ? 'high' : 'medium',
                message: `Detected ${criticalTickets} critical ticket(s) currently active.`,
                recommended_actions: ['trigger_incident_bridge', 'notify_ops_lead']
            });
        }

        if (!alerts.length && totalTickets > 0) {
            alerts.push({
                code: 'support_operating_normally',
                severity: 'info',
                message: 'No support risk thresholds were exceeded for the configured window.',
                recommended_actions: ['continue_monitoring']
            });
        }

        return res.json({
            success: true,
            data: {
                tenant_id: tenantId,
                config: {
                    max_open_minutes: maxOpenMinutes,
                    breach_threshold: breachThreshold,
                    escalation_threshold: escalationThreshold,
                    critical_threshold: criticalThreshold,
                    window_minutes: windowMinutes
                },
                metrics: {
                    total_tickets: totalTickets,
                    escalated_tickets: escalatedTickets,
                    critical_tickets: criticalTickets,
                    sla_breach_count: slaBreachCount,
                    escalations_in_window: escalationsInWindow
                },
                alerts
            }
        });
    } catch (error) {
        return res.status(500).json({ success: false, error: 'support_alerts_failed', message: error.message });
    }
});

app.get('/api/ops-service/audit/logs', requireRole(['admin', 'compliance']), async (req, res) => {
    try {
        const tenantId = getTenantId(req);
        const limit = Math.max(1, Math.min(100, Number(req.query.limit || 50)));

        if (pool) {
            const result = await pool.query(
                `SELECT id, tenant_id, actor_role, action, target_type, target_id, metadata, created_at
                 FROM ms_audit_logs
                 WHERE tenant_id = $1
                 ORDER BY id DESC
                 LIMIT $2`,
                [tenantId, limit]
            );
            return res.json({ success: true, data: result.rows });
        }

        return res.json({
            success: true,
            data: memAudit.filter((x) => x.tenant_id === tenantId).slice(-limit).reverse()
        });
    } catch (error) {
        return res.status(500).json({ success: false, error: 'audit_list_failed', message: error.message });
    }
});

ensureSchema()
    .catch((error) => {
        console.error('⚠️ Ops schema init failed, service will continue:', error.message);
    })
    .finally(() => {
        app.listen(PORT, () => {
            console.log(`🛠️ Ops service listening on ${PORT}`);
        });
    });
