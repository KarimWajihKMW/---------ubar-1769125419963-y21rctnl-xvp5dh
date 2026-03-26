const express = require('express');
const promClient = require('prom-client');
const { Pool } = require('pg');

const app = express();
const PORT = Number(process.env.EVENTS_SERVICE_PORT || 4106);
const useDatabase = Boolean(process.env.DATABASE_URL);
const pool = useDatabase ? new Pool({ connectionString: process.env.DATABASE_URL }) : null;

const metricsRegistry = new promClient.Registry();
promClient.collectDefaultMetrics({ register: metricsRegistry, prefix: 'ubar_events_service_' });
const requestCounter = new promClient.Counter({
    name: 'ubar_events_service_http_requests_total',
    help: 'Total HTTP requests handled by events service',
    labelNames: ['method', 'route', 'status_code'],
    registers: [metricsRegistry]
});

app.use(express.json({ limit: '1mb' }));

const memEvents = [];
const memAcks = [];

function getTenantId(req) {
    const tenantId = String(req.headers['x-tenant-id'] || 'public').trim();
    return tenantId || 'public';
}

function getRole(req) {
    return String(req.headers['x-role'] || 'system').trim().toLowerCase();
}

function requireRole(allowed) {
    const allowedSet = new Set(allowed.map((x) => String(x).toLowerCase()));
    return (req, res, next) => {
        const role = getRole(req);
        if (!allowedSet.has(role)) {
            return res.status(403).json({ success: false, error: 'forbidden', required_roles: Array.from(allowedSet) });
        }
        next();
    };
}

async function ensureSchema() {
    if (!pool) return;

    await pool.query(`
        CREATE TABLE IF NOT EXISTS ms_events (
            id BIGSERIAL PRIMARY KEY,
            tenant_id TEXT NOT NULL,
            topic TEXT NOT NULL,
            event_type TEXT NOT NULL,
            producer TEXT NOT NULL,
            payload JSONB NOT NULL DEFAULT '{}'::jsonb,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
    `);

    await pool.query(`
        CREATE TABLE IF NOT EXISTS ms_event_consumer_acks (
            id BIGSERIAL PRIMARY KEY,
            tenant_id TEXT NOT NULL,
            consumer_group TEXT NOT NULL,
            event_id BIGINT NOT NULL,
            acknowledged_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            UNIQUE (tenant_id, consumer_group, event_id)
        )
    `);
}

app.use((req, res, next) => {
    res.on('finish', () => {
        const route = req.route && req.route.path ? String(req.route.path) : String(req.path || req.url || 'unknown');
        requestCounter.inc({ method: req.method, route, status_code: String(res.statusCode || 0) });
    });
    next();
});

app.get('/api/events-service/health', (_req, res) => {
    return res.json({ success: true, service: 'events-service', status: 'ok', database_mode: useDatabase ? 'postgres' : 'memory' });
});

app.get('/metrics', async (_req, res) => {
    res.set('Content-Type', metricsRegistry.contentType);
    res.end(await metricsRegistry.metrics());
});

app.post('/api/events-service/publish', requireRole(['system', 'admin', 'service']), async (req, res) => {
    try {
        const tenantId = getTenantId(req);
        const topic = String(req.body.topic || '').trim().toLowerCase();
        const eventType = String(req.body.event_type || '').trim().toLowerCase();
        const producer = String(req.body.producer || 'unknown').trim();
        const payload = req.body.payload && typeof req.body.payload === 'object' ? req.body.payload : {};

        if (!topic || !eventType) {
            return res.status(400).json({ success: false, error: 'topic_and_event_type_required' });
        }

        if (pool) {
            const result = await pool.query(
                `INSERT INTO ms_events (tenant_id, topic, event_type, producer, payload)
                 VALUES ($1, $2, $3, $4, $5)
                 RETURNING id, tenant_id, topic, event_type, producer, payload, created_at`,
                [tenantId, topic, eventType, producer, payload]
            );
            return res.json({ success: true, data: result.rows[0] });
        }

        const event = {
            id: memEvents.length + 1,
            tenant_id: tenantId,
            topic,
            event_type: eventType,
            producer,
            payload,
            created_at: new Date().toISOString()
        };
        memEvents.push(event);
        return res.json({ success: true, data: event });
    } catch (error) {
        return res.status(500).json({ success: false, error: 'event_publish_failed', message: error.message });
    }
});

app.get('/api/events-service/events', requireRole(['system', 'admin', 'service', 'dispatcher']), async (req, res) => {
    try {
        const tenantId = getTenantId(req);
        const topic = req.query.topic ? String(req.query.topic).trim().toLowerCase() : null;
        const sinceId = Math.max(0, Number(req.query.since_id || 0));
        const limit = Math.max(1, Math.min(200, Number(req.query.limit || 50)));

        if (pool) {
            const values = [tenantId, limit, sinceId];
            let query = `
                SELECT id, tenant_id, topic, event_type, producer, payload, created_at
                FROM ms_events
                WHERE tenant_id = $1 AND id > $3
            `;
            if (topic) {
                query += ' AND topic = $4';
                values.push(topic);
            }
            query += ' ORDER BY id ASC LIMIT $2';

            const result = await pool.query(query, values);
            return res.json({ success: true, data: result.rows });
        }

        let events = memEvents.filter((x) => x.tenant_id === tenantId && Number(x.id) > sinceId);
        if (topic) events = events.filter((x) => x.topic === topic);
        return res.json({ success: true, data: events.slice(0, limit) });
    } catch (error) {
        return res.status(500).json({ success: false, error: 'event_list_failed', message: error.message });
    }
});

app.post('/api/events-service/consume/ack', requireRole(['system', 'service']), async (req, res) => {
    try {
        const tenantId = getTenantId(req);
        const consumerGroup = String(req.body.consumer_group || '').trim().toLowerCase();
        const eventId = Math.max(1, Number(req.body.event_id || 0));

        if (!consumerGroup || !eventId) {
            return res.status(400).json({ success: false, error: 'consumer_group_and_event_id_required' });
        }

        if (pool) {
            const result = await pool.query(
                `INSERT INTO ms_event_consumer_acks (tenant_id, consumer_group, event_id)
                 VALUES ($1, $2, $3)
                 ON CONFLICT (tenant_id, consumer_group, event_id) DO UPDATE SET acknowledged_at = NOW()
                 RETURNING id, tenant_id, consumer_group, event_id, acknowledged_at`,
                [tenantId, consumerGroup, eventId]
            );
            return res.json({ success: true, data: result.rows[0] });
        }

        const existing = memAcks.find((x) => x.tenant_id === tenantId && x.consumer_group === consumerGroup && x.event_id === eventId);
        if (existing) {
            existing.acknowledged_at = new Date().toISOString();
            return res.json({ success: true, data: existing });
        }

        const ack = {
            id: memAcks.length + 1,
            tenant_id: tenantId,
            consumer_group: consumerGroup,
            event_id: eventId,
            acknowledged_at: new Date().toISOString()
        };
        memAcks.push(ack);
        return res.json({ success: true, data: ack });
    } catch (error) {
        return res.status(500).json({ success: false, error: 'event_ack_failed', message: error.message });
    }
});

ensureSchema()
    .catch((error) => {
        console.error('⚠️ Events schema init failed, service will continue:', error.message);
    })
    .finally(() => {
        app.listen(PORT, () => {
            console.log(`📨 Events service listening on ${PORT}`);
        });
    });
