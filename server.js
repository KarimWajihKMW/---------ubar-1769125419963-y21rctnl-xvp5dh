const express = require('express');
const cors = require('cors');
const pool = require('./db');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const http = require('http');
const crypto = require('crypto');
const { Server: SocketIOServer } = require('socket.io');
const cron = require('node-cron');
const QRCode = require('qrcode');
const nodemailer = require('nodemailer');
const { Issuer, generators } = require('openid-client');
const jwt = require('jsonwebtoken');
require('dotenv').config();

const secureAudioDir = path.join(__dirname, 'secure-audio');
try {
    if (!fs.existsSync(secureAudioDir)) {
        fs.mkdirSync(secureAudioDir, { recursive: true });
    }
} catch (e) {
    // ignore
}

const oauthStateStore = new Map();
function oauthPutState(state, record) {
    oauthStateStore.set(state, record);
}
function oauthTakeState(state) {
    const rec = oauthStateStore.get(state);
    oauthStateStore.delete(state);
    return rec || null;
}
function oauthPruneStates() {
    const now = Date.now();
    for (const [k, v] of oauthStateStore.entries()) {
        if (!v || !v.expiresAtMs || v.expiresAtMs <= now) {
            oauthStateStore.delete(k);
        }
    }
}

let twilioClient = null;
try {
    const sid = process.env.TWILIO_ACCOUNT_SID;
    const token = process.env.TWILIO_AUTH_TOKEN;
    if (sid && token) {
        const twilio = require('twilio');
        twilioClient = twilio(sid, token);
    }
} catch (e) {
    twilioClient = null;
}

const {
    looksLikeBcryptHash,
    hashPassword,
    verifyPassword,
    signAccessToken,
    verifyAccessToken,
    authMiddleware,
    requireAuth,
    requireRole
} = require('./auth');

// Import driver sync system
const driverSync = require('./driver-sync-system');

const app = express();
app.set('trust proxy', 1);
const PORT = process.env.PORT || 3000;
const DRIVER_LOCATION_TTL_MINUTES = 5;
const MAX_ASSIGN_DISTANCE_KM = 30;
const PENDING_TRIP_TTL_MINUTES = 20;
const ASSIGNED_TRIP_TTL_MINUTES = 120;
const AUTO_ASSIGN_TRIPS = false;

// Night Safety Policy (defaults)
const NIGHT_POLICY_START_HOUR = process.env.NIGHT_POLICY_START_HOUR !== undefined ? Number(process.env.NIGHT_POLICY_START_HOUR) : 22;
const NIGHT_POLICY_END_HOUR = process.env.NIGHT_POLICY_END_HOUR !== undefined ? Number(process.env.NIGHT_POLICY_END_HOUR) : 6;
const NIGHT_POLICY_MIN_RATING = process.env.NIGHT_POLICY_MIN_RATING !== undefined ? Number(process.env.NIGHT_POLICY_MIN_RATING) : 4.7;
const NIGHT_POLICY_MAX_LOCATION_AGE_MIN = process.env.NIGHT_POLICY_MAX_LOCATION_AGE_MIN !== undefined ? Number(process.env.NIGHT_POLICY_MAX_LOCATION_AGE_MIN) : 10;

function isNightNow(d = new Date()) {
    const hour = d.getHours();
    const start = Number.isFinite(NIGHT_POLICY_START_HOUR) ? NIGHT_POLICY_START_HOUR : 22;
    const end = Number.isFinite(NIGHT_POLICY_END_HOUR) ? NIGHT_POLICY_END_HOUR : 6;
    // Wrap-around window (e.g. 22 -> 6)
    if (start === end) return false;
    if (start < end) {
        return hour >= start && hour < end;
    }
    return hour >= start || hour < end;
}

function isDriverEligibleForNightPolicy(driverRow) {
    if (!driverRow) return false;
    const approval = driverRow.approval_status ? String(driverRow.approval_status).toLowerCase() : '';
    if (approval && approval !== 'approved') return false;

    const rating = driverRow.rating !== undefined && driverRow.rating !== null ? Number(driverRow.rating) : null;
    const minRating = Number.isFinite(NIGHT_POLICY_MIN_RATING) ? NIGHT_POLICY_MIN_RATING : 4.7;
    if (Number.isFinite(rating) && Number.isFinite(minRating) && rating < minRating) return false;

    const lastAt = driverRow.last_location_at ? new Date(driverRow.last_location_at) : null;
    const maxAgeMin = Number.isFinite(NIGHT_POLICY_MAX_LOCATION_AGE_MIN) ? NIGHT_POLICY_MAX_LOCATION_AGE_MIN : 10;
    if (lastAt && Number.isFinite(lastAt.getTime()) && Number.isFinite(maxAgeMin) && maxAgeMin > 0) {
        const ageMs = Date.now() - lastAt.getTime();
        if (ageMs > maxAgeMin * 60 * 1000) return false;
    }

    return true;
}

let cachedMailer = null;
function getMailer() {
    try {
        if (cachedMailer) return cachedMailer;

        const url = process.env.SMTP_URL;
        if (url) {
            cachedMailer = nodemailer.createTransport(url);
            return cachedMailer;
        }

        const host = process.env.SMTP_HOST;
        const port = process.env.SMTP_PORT ? Number(process.env.SMTP_PORT) : 587;
        const user = process.env.SMTP_USER;
        const pass = process.env.SMTP_PASS;
        if (!host || !user || !pass) return null;

        cachedMailer = nodemailer.createTransport({
            host,
            port: Number.isFinite(port) ? port : 587,
            secure: String(process.env.SMTP_SECURE || '').toLowerCase() === 'true',
            auth: { user, pass }
        });
        return cachedMailer;
    } catch (e) {
        return null;
    }
}

function normalizePhoneNumber(input) {
    const raw = String(input || '').trim();
    if (!raw) return null;
    const digits = raw.replace(/[\s\-()]/g, '');
    if (!digits) return null;
    if (digits.startsWith('+')) return digits;
    // Best-effort: treat as already E.164-less; prepend '+'
    if (/^\d{6,}$/.test(digits)) return `+${digits}`;
    return null;
}

function buildGuardianMessage({ tripId, shareUrl }) {
    const safeTripId = String(tripId);
    const safeUrl = String(shareUrl);
    return `🧑‍🤝‍🧑 Guardian Check-In\nالراكب لم يؤكد (أنا بخير) في الوقت المحدد للرحلة ${safeTripId}.\nتابع الرحلة هنا: ${safeUrl}`;
}

async function deliverGuardianNotification({ contact, message, subject }) {
    const channel = String(contact?.channel || '').toLowerCase();
    const value = String(contact?.value || '').trim();
    const name = contact?.name ? String(contact.name) : null;

    if (!value) {
        return { ok: false, channel, name, error: 'missing_value' };
    }

    if (channel === 'email') {
        const mailer = getMailer();
        if (!mailer) return { ok: false, channel, name, error: 'smtp_not_configured' };
        const from = process.env.SMTP_FROM || process.env.SMTP_USER;
        await mailer.sendMail({ from, to: value, subject: subject || 'Guardian Check-In', text: message });
        return { ok: true, channel, name, delivered: true };
    }

    if (channel === 'sms') {
        const to = normalizePhoneNumber(value);
        const from = process.env.TWILIO_FROM_NUMBER;
        if (!to) return { ok: false, channel, name, error: 'invalid_phone' };
        if (!twilioClient || !from) return { ok: false, channel, name, error: 'twilio_not_configured' };
        const resp = await twilioClient.messages.create({ from, to, body: message });
        return { ok: true, channel, name, delivered: true, provider: 'twilio', message_sid: resp.sid };
    }

    if (channel === 'whatsapp') {
        const to = normalizePhoneNumber(value);
        const waFrom = process.env.TWILIO_WHATSAPP_FROM;
        if (to && twilioClient && waFrom) {
            const resp = await twilioClient.messages.create({
                from: String(waFrom).startsWith('whatsapp:') ? waFrom : `whatsapp:${waFrom}`,
                to: `whatsapp:${to}`,
                body: message
            });
            return { ok: true, channel, name, delivered: true, provider: 'twilio', message_sid: resp.sid };
        }

        // Fallback: provide a ready WhatsApp link (client can open)
        const clean = to ? to.replace(/^\+/, '') : null;
        const actionUrl = clean ? `https://wa.me/${encodeURIComponent(clean)}?text=${encodeURIComponent(message)}` : null;
        return { ok: true, channel, name, delivered: false, prepared: true, action_url: actionUrl };
    }

    return { ok: false, channel: channel || 'unknown', name, error: 'unsupported_channel' };
}

function haversineKm(a, b) {
    const R = 6371;
    const toRad = (d) => (d * Math.PI) / 180;
    const dLat = toRad(b.lat - a.lat);
    const dLng = toRad(b.lng - a.lng);
    const lat1 = toRad(a.lat);
    const lat2 = toRad(b.lat);
    const sinDLat = Math.sin(dLat / 2);
    const sinDLng = Math.sin(dLng / 2);
    const c = 2 * Math.asin(Math.sqrt(sinDLat * sinDLat + Math.cos(lat1) * Math.cos(lat2) * sinDLng * sinDLng));
    return Math.max(0, R * c);
}

function monthKeyFromDate(d) {
    const year = d.getFullYear();
    const month = String(d.getMonth() + 1).padStart(2, '0');
    return `${year}-${month}`;
}

function safeNumber(v) {
    if (v === undefined || v === null) return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
}

function withinBox(lat, lng, box) {
    const minLat = safeNumber(box?.min_lat);
    const maxLat = safeNumber(box?.max_lat);
    const minLng = safeNumber(box?.min_lng);
    const maxLng = safeNumber(box?.max_lng);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) return false;
    if (!Number.isFinite(minLat) || !Number.isFinite(maxLat) || !Number.isFinite(minLng) || !Number.isFinite(maxLng)) return false;
    const loLat = Math.min(minLat, maxLat);
    const hiLat = Math.max(minLat, maxLat);
    const loLng = Math.min(minLng, maxLng);
    const hiLng = Math.max(minLng, maxLng);
    return lat >= loLat && lat <= hiLat && lng >= loLng && lng <= hiLng;
}

function computeProfitabilityIndicator({ fare, pickupDistanceKm, tripDurationMin }) {
    const f = safeNumber(fare);
    const d = safeNumber(pickupDistanceKm);
    const t = safeNumber(tripDurationMin);
    if (!Number.isFinite(f) || f <= 0) return { level: 'unknown', score: null, reasons: ['missing_fare'] };

    const pickupMin = Number.isFinite(d) && d >= 0 ? d * 2.0 : 6; // rough ETA to pickup
    const driveMin = Number.isFinite(t) && t > 0 ? t : 15;
    const totalMin = Math.max(1, pickupMin + driveMin);
    const sarPerMin = f / totalMin;

    // Heuristic thresholds (no sensitive inputs)
    if (sarPerMin >= 2.2) return { level: 'good', score: Math.round(sarPerMin * 100) / 100, reasons: [] };
    if (sarPerMin >= 1.3) return { level: 'medium', score: Math.round(sarPerMin * 100) / 100, reasons: [] };
    return { level: 'bad', score: Math.round(sarPerMin * 100) / 100, reasons: ['low_return_per_time'] };
}

function computeRiskIndicator({ passengerVerifiedLevel, passengerCancelRate30d, pickupDistanceKm, rejectionCount }) {
    const lvl = String(passengerVerifiedLevel || 'none').toLowerCase();
    const cancelRate = safeNumber(passengerCancelRate30d);
    const dist = safeNumber(pickupDistanceKm);
    const rej = safeNumber(rejectionCount) || 0;

    let score = 0;
    const reasons = [];

    if (lvl === 'none') {
        score += 2;
        reasons.push('unverified_passenger');
    } else if (lvl === 'basic') {
        score += 1;
    }

    if (Number.isFinite(cancelRate)) {
        if (cancelRate >= 0.35) {
            score += 2;
            reasons.push('higher_cancel_probability');
        } else if (cancelRate >= 0.2) {
            score += 1;
            reasons.push('moderate_cancel_probability');
        }
    }

    if (Number.isFinite(dist) && dist >= 10) {
        score += 1;
        reasons.push('far_pickup');
    }

    if (rej >= 3) {
        score += 1;
        reasons.push('many_driver_rejections');
    }

    if (score >= 4) return { level: 'high', score, reasons };
    if (score >= 2) return { level: 'medium', score, reasons };
    return { level: 'low', score, reasons };
}

function bearingDeg(fromLat, fromLng, toLat, toLng) {
    if (![fromLat, fromLng, toLat, toLng].every(Number.isFinite)) return null;
    const toRad = (d) => (d * Math.PI) / 180;
    const toDeg = (r) => (r * 180) / Math.PI;
    const lat1 = toRad(fromLat);
    const lat2 = toRad(toLat);
    const dLng = toRad(toLng - fromLng);
    const y = Math.sin(dLng) * Math.cos(lat2);
    const x = Math.cos(lat1) * Math.sin(lat2) - Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLng);
    const brng = toDeg(Math.atan2(y, x));
    return (brng + 360) % 360;
}

function angleDiffDeg(a, b) {
    if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
    const d = Math.abs(a - b) % 360;
    return d > 180 ? 360 - d : d;
}

function deriveAudioKey() {
    const envKey = process.env.CAPTAIN_AUDIO_KEY || process.env.AUDIO_ENCRYPTION_KEY;
    if (envKey) {
        try {
            // Accept base64 or hex
            const trimmed = String(envKey).trim();
            const asBuf = /^[0-9a-fA-F]{64}$/.test(trimmed)
                ? Buffer.from(trimmed, 'hex')
                : Buffer.from(trimmed, 'base64');
            if (asBuf.length === 32) return asBuf;
        } catch (e) {
            // ignore
        }
    }

    const fallback = process.env.JWT_SECRET || process.env.DATABASE_URL || 'akwadra_fallback_key';
    return crypto.createHash('sha256').update(String(fallback)).digest();
}

function encryptBufferAesGcm(plaintextBuffer) {
    const key = deriveAudioKey();
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
    const ciphertext = Buffer.concat([cipher.update(plaintextBuffer), cipher.final()]);
    const tag = cipher.getAuthTag();
    return { iv, tag, ciphertext, algo: 'aes-256-gcm' };
}

function decryptBufferAesGcm({ iv, tag, ciphertext }) {
    const key = deriveAudioKey();
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}

// ------------------------------
// Realtime (Socket.io)
// ------------------------------
const httpServer = http.createServer(app);
const io = new SocketIOServer(httpServer, {
    cors: {
        origin: '*',
        methods: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE']
    }
});

function tripRoom(tripId) {
    return `trip:${String(tripId)}`;
}

function userRoom(userId) {
    return `user:${String(userId)}`;
}

const lastTripDriverWriteAt = new Map();
const lastTripSafetyCheckAt = new Map();
const lastTripDeviationEventAt = new Map();
const tripStopState = new Map();

async function checkTripSafetyFromDriverLocationUpdate(tripId, coords) {
    try {
        const now = Date.now();
        const key = String(tripId);
        const last = lastTripSafetyCheckAt.get(key) || 0;
        if (now - last < 10000) return; // throttle safety checks
        lastTripSafetyCheckAt.set(key, now);

        const tripRes = await pool.query(
            `SELECT id, status, driver_id,
                    pickup_lat, pickup_lng, dropoff_lat, dropoff_lng
             FROM trips
             WHERE id = $1
             LIMIT 1`,
            [tripId]
        );
        const trip = tripRes.rows[0] || null;
        if (!trip) return;
        if (String(trip.status || '').toLowerCase() !== 'ongoing') return;

        const pickupLat = trip.pickup_lat !== null && trip.pickup_lat !== undefined ? Number(trip.pickup_lat) : null;
        const pickupLng = trip.pickup_lng !== null && trip.pickup_lng !== undefined ? Number(trip.pickup_lng) : null;
        const dropoffLat = trip.dropoff_lat !== null && trip.dropoff_lat !== undefined ? Number(trip.dropoff_lat) : null;
        const dropoffLng = trip.dropoff_lng !== null && trip.dropoff_lng !== undefined ? Number(trip.dropoff_lng) : null;
        if (!Number.isFinite(pickupLat) || !Number.isFinite(pickupLng) || !Number.isFinite(dropoffLat) || !Number.isFinite(dropoffLng)) {
            return;
        }

        let cfg = null;
        try {
            const cfgRes = await pool.query(
                `SELECT enabled, deviation_threshold_km, stop_minutes_threshold
                 FROM trip_route_deviation_configs
                 WHERE trip_id = $1
                 LIMIT 1`,
                [tripId]
            );
            cfg = cfgRes.rows[0] || null;
        } catch (e) {
            cfg = null;
        }

        const enabled = cfg?.enabled === undefined || cfg?.enabled === null ? true : Boolean(cfg.enabled);
        if (!enabled) return;

        const tripDistanceKm = haversineKm({ lat: pickupLat, lng: pickupLng }, { lat: dropoffLat, lng: dropoffLng });
        let thresholdKm = cfg?.deviation_threshold_km !== undefined && cfg?.deviation_threshold_km !== null
            ? Number(cfg.deviation_threshold_km)
            : (tripDistanceKm <= 6 ? 1.2 : 2.0);
        if (!Number.isFinite(thresholdKm) || thresholdKm <= 0) thresholdKm = 1.5;
        thresholdKm = Math.max(0.5, Math.min(10, thresholdKm));

        const deviationKm = pointToSegmentDistanceKm(
            { lat: Number(coords.lat), lng: Number(coords.lng) },
            { lat: pickupLat, lng: pickupLng },
            { lat: dropoffLat, lng: dropoffLng }
        );

        if (Number.isFinite(deviationKm) && deviationKm > thresholdKm) {
            const lastEvent = lastTripDeviationEventAt.get(key) || 0;
            if (now - lastEvent > 5 * 60 * 1000) {
                lastTripDeviationEventAt.set(key, now);
                const msg = `deviation_km=${deviationKm.toFixed(2)} threshold_km=${thresholdKm.toFixed(2)}`;
                const insert = await pool.query(
                    `INSERT INTO trip_safety_events (trip_id, created_by_role, created_by_user_id, created_by_driver_id, event_type, message)
                     VALUES ($1,'system',NULL,$2,'route_deviation_detected',$3)
                     RETURNING *`,
                    [tripId, trip.driver_id || null, msg]
                );
                try {
                    io.to(tripRoom(tripId)).emit('safety_event', { trip_id: String(tripId), event: insert.rows[0] });
                } catch (e) {
                    // ignore
                }
            }
        }

        const stopThresholdMinutes = cfg?.stop_minutes_threshold !== undefined && cfg?.stop_minutes_threshold !== null
            ? Number(cfg.stop_minutes_threshold)
            : 5;
        const stopMins = Number.isFinite(stopThresholdMinutes) ? Math.max(2, Math.min(60, stopThresholdMinutes)) : 5;

        const state = tripStopState.get(key) || {
            lastCoords: { lat: Number(coords.lat), lng: Number(coords.lng) },
            lastMovedAt: now,
            lastStopEventAt: 0
        };

        const movedKm = haversineKm(
            { lat: state.lastCoords.lat, lng: state.lastCoords.lng },
            { lat: Number(coords.lat), lng: Number(coords.lng) }
        );

        if (Number.isFinite(movedKm) && movedKm >= 0.05) {
            state.lastCoords = { lat: Number(coords.lat), lng: Number(coords.lng) };
            state.lastMovedAt = now;
        }

        if (now - state.lastMovedAt > stopMins * 60 * 1000 && now - (state.lastStopEventAt || 0) > stopMins * 60 * 1000) {
            state.lastStopEventAt = now;
            const msg = `stop_minutes>=${stopMins}`;
            const insert = await pool.query(
                `INSERT INTO trip_safety_events (trip_id, created_by_role, created_by_user_id, created_by_driver_id, event_type, message)
                 VALUES ($1,'system',NULL,$2,'unexpected_stop_detected',$3)
                 RETURNING *`,
                [tripId, trip.driver_id || null, msg]
            );
            try {
                io.to(tripRoom(tripId)).emit('safety_event', { trip_id: String(tripId), event: insert.rows[0] });
            } catch (e) {
                // ignore
            }
        }

        tripStopState.set(key, state);
    } catch (err) {
        // Non-blocking
        console.warn('⚠️ checkTripSafetyFromDriverLocationUpdate failed:', err.message);
    }
}

io.on('connection', (socket) => {
    socket.on('subscribe_trip', (payload) => {
        const tripId = payload?.trip_id;
        if (!tripId) return;
        socket.join(tripRoom(tripId));
        socket.emit('subscribed_trip', { trip_id: String(tripId) });
    });

    // Subscribe to user room using JWT (for match timeline updates before trip rooms exist)
    socket.on('subscribe_user', (payload) => {
        try {
            const token = payload?.token ? String(payload.token) : '';
            const claims = verifyAccessToken(token);
            const uid = claims?.uid;
            if (!uid) {
                socket.emit('subscribed_user_error', { error: 'invalid_token' });
                return;
            }
            socket.join(userRoom(uid));
            socket.emit('subscribed_user', { user_id: String(uid), role: claims?.role || null });
        } catch (e) {
            socket.emit('subscribed_user_error', { error: 'invalid_token' });
        }
    });

    socket.on('unsubscribe_user', (payload) => {
        try {
            const userId = payload?.user_id;
            if (!userId) return;
            socket.leave(userRoom(userId));
        } catch (e) {
            // ignore
        }
    });

    socket.on('unsubscribe_trip', (payload) => {
        const tripId = payload?.trip_id;
        if (!tripId) return;
        socket.leave(tripRoom(tripId));
        socket.emit('unsubscribed_trip', { trip_id: String(tripId) });
    });

    // Driver sends live GPS during trip
    socket.on('driver_location_update', async (payload) => {
        try {
            const tripId = payload?.trip_id;
            const lat = payload?.driver_lat !== undefined && payload?.driver_lat !== null ? Number(payload.driver_lat) : null;
            const lng = payload?.driver_lng !== undefined && payload?.driver_lng !== null ? Number(payload.driver_lng) : null;
            if (!tripId || !Number.isFinite(lat) || !Number.isFinite(lng)) return;

            io.to(tripRoom(tripId)).emit('driver_live_location', {
                trip_id: String(tripId),
                driver_lat: lat,
                driver_lng: lng,
                timestamp: payload?.timestamp || Date.now()
            });

            // Optional: persist to drivers.last_lat/last_lng (throttled)
            const now = Date.now();
            const key = String(tripId);
            const last = lastTripDriverWriteAt.get(key) || 0;
            if (now - last < 5000) return;
            lastTripDriverWriteAt.set(key, now);

            const tripRes = await pool.query('SELECT driver_id FROM trips WHERE id = $1 LIMIT 1', [tripId]);
            const driverId = tripRes.rows?.[0]?.driver_id || null;
            if (!driverId) return;
            await pool.query(
                `UPDATE drivers
                 SET last_lat = $1, last_lng = $2, last_location_at = CURRENT_TIMESTAMP
                 WHERE id = $3`,
                [lat, lng, driverId]
            );

            // Route deviation guardian checks (non-blocking/throttled)
            checkTripSafetyFromDriverLocationUpdate(String(tripId), { lat, lng });
        } catch (err) {
            console.warn('⚠️ driver_location_update failed:', err.message);
        }
    });
});

// Create uploads directory if it doesn't exist
const uploadsDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadsDir)) {
    fs.mkdirSync(uploadsDir, { recursive: true });
}

// Secure uploads (NOT served statically) for sensitive opt-in documents
const secureUploadsDir = path.join(__dirname, 'secure_uploads');
if (!fs.existsSync(secureUploadsDir)) {
    fs.mkdirSync(secureUploadsDir, { recursive: true });
}

// Configure multer for file uploads
const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        cb(null, uploadsDir);
    },
    filename: (req, file, cb) => {
        const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
        cb(null, file.fieldname + '-' + uniqueSuffix + path.extname(file.originalname));
    }
});

const upload = multer({
    storage: storage,
    limits: { fileSize: 5 * 1024 * 1024 }, // 5MB limit
    fileFilter: (req, file, cb) => {
        const allowedTypes = /jpeg|jpg|png|pdf/;
        const extname = allowedTypes.test(path.extname(file.originalname).toLowerCase());
        const mimetype = allowedTypes.test(file.mimetype);
        
        if (mimetype && extname) {
            return cb(null, true);
        } else {
            cb(new Error('Only .png, .jpg, .jpeg and .pdf files are allowed!'));
        }
    }
});

const secureStorage = multer.diskStorage({
    destination: (req, file, cb) => {
        cb(null, secureUploadsDir);
    },
    filename: (req, file, cb) => {
        const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
        cb(null, file.fieldname + '-' + uniqueSuffix + path.extname(file.originalname));
    }
});

const secureUpload = multer({
    storage: secureStorage,
    limits: { fileSize: 5 * 1024 * 1024 },
    fileFilter: (req, file, cb) => {
        const allowedTypes = /jpeg|jpg|png|pdf/;
        const extname = allowedTypes.test(path.extname(file.originalname).toLowerCase());
        const mimetype = allowedTypes.test(file.mimetype);

        if (mimetype && extname) {
            return cb(null, true);
        } else {
            cb(new Error('Only .png, .jpg, .jpeg and .pdf files are allowed!'));
        }
    }
});

const audioUpload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 15 * 1024 * 1024 }, // 15MB
    fileFilter: (req, file, cb) => {
        const mime = String(file.mimetype || '').toLowerCase();
        // Common audio types from browsers
        const ok = mime.startsWith('audio/') || mime === 'application/octet-stream';
        if (ok) return cb(null, true);
        cb(new Error('Only audio uploads are allowed'));
    }
});

function normalizePhoneCandidates(input) {
    const raw = String(input || '').trim();
    const digits = raw.replace(/\D/g, '');
    const candidates = new Set();

    if (raw) candidates.add(raw);
    if (digits) {
        candidates.add(digits);
        const withoutZeros = digits.replace(/^0+/, '');
        if (withoutZeros) {
            candidates.add(withoutZeros);
            candidates.add(`0${withoutZeros}`);
        }
        if (digits.startsWith('20') && digits.length > 2) {
            const local = digits.slice(2).replace(/^0+/, '');
            if (local) {
                candidates.add(local);
                candidates.add(`0${local}`);
            }
        }
        if (digits.startsWith('966') && digits.length > 3) {
            const local = digits.slice(3).replace(/^0+/, '');
            if (local) {
                candidates.add(local);
                candidates.add(`0${local}`);
            }
        }
    }

    return Array.from(candidates);
}

function normalizePhoneForStore(input) {
    const digits = String(input || '').trim().replace(/\D/g, '');
    if (!digits) return String(input || '').trim();
    if (digits.startsWith('20')) {
        const local = digits.slice(2).replace(/^0+/, '');
        return local ? `0${local}` : digits;
    }
    if (digits.startsWith('966')) {
        const local = digits.slice(3).replace(/^0+/, '');
        return local ? `0${local}` : digits;
    }
    if (!digits.startsWith('0') && digits.length <= 10) {
        return `0${digits}`;
    }
    return digits;
}

// Middleware
app.use(cors());
app.use(express.json());
// Needed for Apple OAuth when using response_mode=form_post
app.use(express.urlencoded({ extended: true }));

// Prevent stale frontend assets in production (Railway/Chrome can keep old JS and mask fixes)
app.use((req, res, next) => {
    try {
        if (req.method === 'GET') {
            const p = String(req.path || '');
            if (
                p === '/' ||
                p.endsWith('.html') ||
                p.endsWith('.js') ||
                p.endsWith('.css')
            ) {
                res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
                res.setHeader('Pragma', 'no-cache');
                res.setHeader('Expires', '0');
            }
        }
    } catch (e) {
        // ignore
    }
    next();
});

app.use(express.static('.'));
app.use('/uploads', express.static(uploadsDir));

// Attach decoded JWT (if present) to req.auth for all routes (including non-/api aliases)
app.use(authMiddleware);

const DEFAULT_ADMIN_USERS = [
    {
        phone: '0555678901',
        name: 'عبدالرحمن إبراهيم',
        email: 'admin@ubar.sa',
        password: '12345678',
        role: 'admin'
    },
    {
        phone: '0556789012',
        name: 'هند خالد',
        email: 'admin2@ubar.sa',
        password: '12345678',
        role: 'admin'
    }
];

// Ensure core schema exists (fresh DB safety)
async function ensureCoreSchema() {
    const client = await pool.connect();
    try {
        // Enum type used by trips.trip_status
        await client.query(`
            DO $$
            BEGIN
                CREATE TYPE trip_status_enum AS ENUM ('pending', 'accepted', 'arrived', 'started', 'completed', 'rated');
            EXCEPTION
                WHEN duplicate_object THEN NULL;
            END $$;
        `);

        await client.query(`
            CREATE TABLE IF NOT EXISTS users (
                id SERIAL PRIMARY KEY,
                phone VARCHAR(20) UNIQUE NOT NULL,
                name VARCHAR(100),
                email VARCHAR(100) UNIQUE NOT NULL,
                password VARCHAR(255) NOT NULL,
                role VARCHAR(20) DEFAULT 'passenger',
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
        `);

        await client.query(`
            CREATE TABLE IF NOT EXISTS drivers (
                id SERIAL PRIMARY KEY,
                name VARCHAR(100) NOT NULL,
                phone VARCHAR(20) UNIQUE NOT NULL,
                email VARCHAR(100) UNIQUE,
                password VARCHAR(255),
                car_type VARCHAR(50) DEFAULT 'economy',
                car_plate VARCHAR(20),
                approval_status VARCHAR(20) DEFAULT 'pending',
                approved_by INTEGER,
                approved_at TIMESTAMP,
                rejection_reason TEXT,
                rating DECIMAL(3, 2) DEFAULT 5.00,
                total_trips INTEGER DEFAULT 0,
                total_earnings DECIMAL(10, 2) DEFAULT 0.00,
                balance DECIMAL(10, 2) DEFAULT 0.00,
                today_earnings DECIMAL(10, 2) DEFAULT 0.00,
                today_trips_count INTEGER DEFAULT 0,
                last_earnings_update DATE DEFAULT CURRENT_DATE,
                status VARCHAR(20) DEFAULT 'offline',
                last_lat DECIMAL(10, 8),
                last_lng DECIMAL(11, 8),
                last_location_at TIMESTAMP,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
        `);

        await client.query(`
            CREATE TABLE IF NOT EXISTS driver_earnings (
                id SERIAL PRIMARY KEY,
                driver_id INTEGER REFERENCES drivers(id) ON DELETE CASCADE,
                date DATE NOT NULL DEFAULT CURRENT_DATE,
                today_trips INTEGER DEFAULT 0,
                today_earnings DECIMAL(10, 2) DEFAULT 0.00,
                total_trips INTEGER DEFAULT 0,
                total_earnings DECIMAL(10, 2) DEFAULT 0.00,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                UNIQUE(driver_id, date)
            );
        `);

        await client.query(`
            CREATE TABLE IF NOT EXISTS trips (
                id VARCHAR(50) PRIMARY KEY,
                user_id INTEGER REFERENCES users(id),
                rider_id INTEGER REFERENCES users(id),
                driver_id INTEGER REFERENCES drivers(id),
                pickup_location VARCHAR(255) NOT NULL,
                dropoff_location VARCHAR(255) NOT NULL,
                pickup_lat DECIMAL(10, 8),
                pickup_lng DECIMAL(11, 8),
                pickup_accuracy DOUBLE PRECISION,
                pickup_timestamp BIGINT,
                dropoff_lat DECIMAL(10, 8),
                dropoff_lng DECIMAL(11, 8),
                car_type VARCHAR(50) DEFAULT 'economy',
                cost DECIMAL(10, 2) NOT NULL,
                price DECIMAL(10, 2),
                distance DECIMAL(10, 2),
                distance_km DECIMAL(10, 2),
                duration INTEGER,
                duration_minutes INTEGER,
                payment_method VARCHAR(20) DEFAULT 'cash',
                status VARCHAR(20) DEFAULT 'pending',
                trip_status trip_status_enum DEFAULT 'pending',
                source VARCHAR(40) DEFAULT 'passenger_app',
                rating INTEGER,
                review TEXT,
                passenger_rating INTEGER,
                rider_rating INTEGER,
                driver_rating INTEGER,
                passenger_review TEXT,
                driver_review TEXT,
                driver_name VARCHAR(100),
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                started_at TIMESTAMP,
                completed_at TIMESTAMP,
                cancelled_at TIMESTAMP
            );
        `);

        await client.query(`
            CREATE TABLE IF NOT EXISTS pending_ride_requests (
                id SERIAL PRIMARY KEY,
                request_id VARCHAR(50) UNIQUE NOT NULL,
                trip_id VARCHAR(50),
                source VARCHAR(40) DEFAULT 'manual',
                user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
                passenger_name VARCHAR(100),
                passenger_phone VARCHAR(20),
                pickup_location VARCHAR(255) NOT NULL,
                dropoff_location VARCHAR(255) NOT NULL,
                pickup_lat DECIMAL(10, 8),
                pickup_lng DECIMAL(11, 8),
                pickup_accuracy DOUBLE PRECISION,
                pickup_timestamp BIGINT,
                dropoff_lat DECIMAL(10, 8),
                dropoff_lng DECIMAL(11, 8),
                car_type VARCHAR(50) DEFAULT 'economy',
                estimated_cost DECIMAL(10, 2),
                estimated_distance DECIMAL(10, 2),
                estimated_duration INTEGER,
                payment_method VARCHAR(20) DEFAULT 'cash',
                status VARCHAR(20) DEFAULT 'waiting',
                assigned_driver_id INTEGER REFERENCES drivers(id) ON DELETE SET NULL,
                assigned_at TIMESTAMP,
                rejected_by INTEGER[] DEFAULT ARRAY[]::INTEGER[],
                rejection_count INTEGER DEFAULT 0,
                expires_at TIMESTAMP,
                notes TEXT,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
        `);

        await client.query('CREATE INDEX IF NOT EXISTS idx_trips_user_id ON trips(user_id);');
        await client.query('CREATE INDEX IF NOT EXISTS idx_trips_driver_id ON trips(driver_id);');
        await client.query('CREATE INDEX IF NOT EXISTS idx_trips_status ON trips(status);');
        await client.query('CREATE INDEX IF NOT EXISTS idx_trips_created_at ON trips(created_at DESC);');
        await client.query('CREATE INDEX IF NOT EXISTS idx_pending_rides_status ON pending_ride_requests(status);');
        await client.query('CREATE INDEX IF NOT EXISTS idx_pending_rides_created_at ON pending_ride_requests(created_at DESC);');

        console.log('✅ Core schema ensured');
    } catch (err) {
        console.error('❌ Failed to ensure core schema:', err.message);
    } finally {
        client.release();
    }
}

async function ensureDefaultAdmins() {
    try {
        for (const admin of DEFAULT_ADMIN_USERS) {
            const existing = await pool.query('SELECT id FROM users WHERE LOWER(email) = $1', [String(admin.email).trim().toLowerCase()]);
            if (existing.rows.length > 0) continue;

            const hashed = await hashPassword(admin.password);
            await pool.query(
                `INSERT INTO users (phone, name, email, password, role)
                 VALUES ($1, $2, $3, $4, $5)`,
                [admin.phone, admin.name, String(admin.email).trim().toLowerCase(), hashed, admin.role]
            );
        }
        console.log('✅ Default admin users ensured');
    } catch (err) {
        console.error('❌ Failed to ensure default admins:', err.message);
    }
}

async function ensureOffersTable() {
    try {
        await pool.query(`
            CREATE TABLE IF NOT EXISTS offers (
                id SERIAL PRIMARY KEY,
                code VARCHAR(30) UNIQUE NOT NULL,
                title VARCHAR(150) NOT NULL,
                description TEXT,
                badge VARCHAR(50),
                discount_type VARCHAR(20) NOT NULL DEFAULT 'percent',
                discount_value DECIMAL(10, 2) NOT NULL DEFAULT 0,
                is_active BOOLEAN NOT NULL DEFAULT true,
                eligibility_metric VARCHAR(40),
                eligibility_min INTEGER,
                starts_at TIMESTAMP,
                ends_at TIMESTAMP,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
        `);
        await pool.query('ALTER TABLE offers ADD COLUMN IF NOT EXISTS eligibility_metric VARCHAR(40);');
        await pool.query('ALTER TABLE offers ADD COLUMN IF NOT EXISTS eligibility_min INTEGER;');
        await pool.query('CREATE INDEX IF NOT EXISTS idx_offers_active ON offers(is_active);');
        await pool.query('CREATE INDEX IF NOT EXISTS idx_offers_code ON offers(code);');
        console.log('✅ Offers table ensured');
    } catch (err) {
        console.error('❌ Failed to ensure offers table:', err.message);
    }
}

async function ensureWalletTables() {
    try {
        await pool.query(`
            CREATE TABLE IF NOT EXISTS wallet_transactions (
                id BIGSERIAL PRIMARY KEY,
                owner_type VARCHAR(10) NOT NULL,
                owner_id INTEGER NOT NULL,
                amount DECIMAL(12, 2) NOT NULL,
                currency VARCHAR(8) NOT NULL DEFAULT 'SAR',
                reason TEXT,
                reference_type VARCHAR(40),
                reference_id VARCHAR(80),
                created_by_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
                created_by_role VARCHAR(20),
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
        `);

        await pool.query(`
            CREATE INDEX IF NOT EXISTS idx_wallet_tx_owner_created
            ON wallet_transactions(owner_type, owner_id, created_at DESC);
        `);

        console.log('✅ Wallet tables ensured');
    } catch (err) {
        console.error('❌ Failed to ensure wallet tables:', err.message);
    }
}

async function ensureCaptainFeatureTables() {
    try {
        await pool.query(`
            CREATE TABLE IF NOT EXISTS driver_acceptance_rules (
                driver_id INTEGER PRIMARY KEY REFERENCES drivers(id) ON DELETE CASCADE,
                min_fare DECIMAL(12, 2),
                max_pickup_distance_km DECIMAL(10, 2),
                excluded_zones_json JSONB,
                preferred_axis_json JSONB,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
        `);

        await pool.query(`
            CREATE TABLE IF NOT EXISTS driver_go_home_settings (
                driver_id INTEGER PRIMARY KEY REFERENCES drivers(id) ON DELETE CASCADE,
                enabled BOOLEAN NOT NULL DEFAULT false,
                home_lat DECIMAL(10, 8),
                home_lng DECIMAL(11, 8),
                max_detour_km DECIMAL(10, 2) DEFAULT 2,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
        `);

        await pool.query(`
            CREATE TABLE IF NOT EXISTS driver_earnings_goals (
                driver_id INTEGER PRIMARY KEY REFERENCES drivers(id) ON DELETE CASCADE,
                daily_target DECIMAL(12, 2),
                weekly_target DECIMAL(12, 2),
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
        `);

        await pool.query(`
            CREATE TABLE IF NOT EXISTS driver_expenses (
                id BIGSERIAL PRIMARY KEY,
                driver_id INTEGER NOT NULL REFERENCES drivers(id) ON DELETE CASCADE,
                category VARCHAR(30) NOT NULL,
                amount DECIMAL(12, 2) NOT NULL,
                note TEXT,
                expense_date DATE NOT NULL DEFAULT CURRENT_DATE,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
        `);
        await pool.query('CREATE INDEX IF NOT EXISTS idx_driver_expenses_driver_date ON driver_expenses(driver_id, expense_date DESC);');

        await pool.query(`
            CREATE TABLE IF NOT EXISTS driver_fatigue_settings (
                driver_id INTEGER PRIMARY KEY REFERENCES drivers(id) ON DELETE CASCADE,
                enabled BOOLEAN NOT NULL DEFAULT true,
                safe_limit_minutes INTEGER NOT NULL DEFAULT 480,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
        `);

        await pool.query(`
            CREATE TABLE IF NOT EXISTS driver_favorite_passengers (
                driver_id INTEGER NOT NULL REFERENCES drivers(id) ON DELETE CASCADE,
                user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                PRIMARY KEY (driver_id, user_id)
            );
        `);
        await pool.query('CREATE INDEX IF NOT EXISTS idx_driver_fav_passenger_driver ON driver_favorite_passengers(driver_id, created_at DESC);');

        await pool.query(`
            CREATE TABLE IF NOT EXISTS trip_wait_proofs (
                trip_id VARCHAR(50) PRIMARY KEY REFERENCES trips(id) ON DELETE CASCADE,
                driver_id INTEGER REFERENCES drivers(id) ON DELETE SET NULL,
                arrived_at TIMESTAMP,
                arrived_lat DECIMAL(10, 8),
                arrived_lng DECIMAL(11, 8),
                wait_end_at TIMESTAMP,
                wait_seconds INTEGER,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
        `);

        await pool.query(`
            CREATE TABLE IF NOT EXISTS driver_road_reports (
                id BIGSERIAL PRIMARY KEY,
                driver_id INTEGER REFERENCES drivers(id) ON DELETE SET NULL,
                report_type VARCHAR(30) NOT NULL,
                lat DECIMAL(10, 8) NOT NULL,
                lng DECIMAL(11, 8) NOT NULL,
                note TEXT,
                confirms_count INTEGER NOT NULL DEFAULT 0,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                expires_at TIMESTAMP
            );
        `);
        await pool.query('CREATE INDEX IF NOT EXISTS idx_driver_road_reports_geo ON driver_road_reports(lat, lng, created_at DESC);');

        await pool.query(`
            CREATE TABLE IF NOT EXISTS driver_road_report_votes (
                report_id BIGINT NOT NULL REFERENCES driver_road_reports(id) ON DELETE CASCADE,
                driver_id INTEGER NOT NULL REFERENCES drivers(id) ON DELETE CASCADE,
                vote VARCHAR(10) NOT NULL,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                PRIMARY KEY (report_id, driver_id)
            );
        `);
        await pool.query('CREATE INDEX IF NOT EXISTS idx_driver_road_votes_report ON driver_road_report_votes(report_id, updated_at DESC);');
        await pool.query('CREATE INDEX IF NOT EXISTS idx_driver_road_votes_driver ON driver_road_report_votes(driver_id, updated_at DESC);');

        await pool.query(`
            CREATE TABLE IF NOT EXISTS driver_map_error_reports (
                id BIGSERIAL PRIMARY KEY,
                driver_id INTEGER REFERENCES drivers(id) ON DELETE SET NULL,
                error_type VARCHAR(40) NOT NULL,
                lat DECIMAL(10, 8) NOT NULL,
                lng DECIMAL(11, 8) NOT NULL,
                title TEXT,
                details TEXT,
                status VARCHAR(20) NOT NULL DEFAULT 'open',
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
        `);
        await pool.query('CREATE INDEX IF NOT EXISTS idx_driver_map_errors_geo ON driver_map_error_reports(lat, lng, created_at DESC);');

        await pool.query(`
            CREATE TABLE IF NOT EXISTS driver_emergency_profiles (
                driver_id INTEGER PRIMARY KEY REFERENCES drivers(id) ON DELETE CASCADE,
                opt_in BOOLEAN NOT NULL DEFAULT false,
                contact_name TEXT,
                contact_channel VARCHAR(20) NOT NULL DEFAULT 'phone',
                contact_value TEXT,
                medical_note TEXT,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
        `);

        await pool.query(`
            CREATE TABLE IF NOT EXISTS driver_sos_events (
                id BIGSERIAL PRIMARY KEY,
                driver_id INTEGER REFERENCES drivers(id) ON DELETE SET NULL,
                trip_id VARCHAR(50),
                message TEXT,
                lat DECIMAL(10, 8),
                lng DECIMAL(11, 8),
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
        `);
        await pool.query('CREATE INDEX IF NOT EXISTS idx_driver_sos_driver_created ON driver_sos_events(driver_id, created_at DESC);');

        await pool.query(`
            CREATE TABLE IF NOT EXISTS trip_driver_audio_recordings (
                id BIGSERIAL PRIMARY KEY,
                trip_id VARCHAR(50) NOT NULL REFERENCES trips(id) ON DELETE CASCADE,
                driver_id INTEGER REFERENCES drivers(id) ON DELETE SET NULL,
                file_mime TEXT,
                file_size_bytes BIGINT,
                algo VARCHAR(30) NOT NULL DEFAULT 'aes-256-gcm',
                iv_hex TEXT NOT NULL,
                tag_hex TEXT NOT NULL,
                encrypted_rel_path TEXT NOT NULL,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
        `);
        await pool.query('CREATE INDEX IF NOT EXISTS idx_trip_driver_audio_trip ON trip_driver_audio_recordings(trip_id, created_at DESC);');

        console.log('✅ Captain-only tables ensured');
    } catch (err) {
        console.error('❌ Failed to ensure captain-only tables:', err.message);
    }
}

async function ensureDefaultOffers() {
    try {
        await ensureOffersTable();
        const existing = await pool.query('SELECT COUNT(*)::int AS count FROM offers');
        if (existing.rows[0].count > 0) return;

        await pool.query(`
            INSERT INTO offers (code, title, description, badge, discount_type, discount_value, is_active)
            VALUES
                ('WELCOME20', '🎉 خصم 20% على أول رحلة', 'استخدم الكود WELCOME20 على أول طلب لك واحصل على خصم فوري.', 'جديد', 'percent', 20, true),
                ('2FOR1', '🚗 رحلتان بسعر 1', 'رحلتك الثانية مجاناً عند الدفع بالبطاقة خلال هذا الأسبوع.', 'محدود', 'percent', 50, true),
                ('DOUBLEPTS', '⭐ نقاط مضاعفة', 'اكسب ضعف النقاط على الرحلات المكتملة في عطلة نهاية الأسبوع.', 'نقاط', 'points', 2, true)
        `);
        await pool.query("UPDATE offers SET discount_type = 'points', discount_value = 2 WHERE code = 'DOUBLEPTS'");
        console.log('✅ Default offers inserted');
    } catch (err) {
        console.error('❌ Failed to ensure default offers:', err.message);
    }
}

async function ensureUserProfileColumns() {
    try {
        await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS car_type VARCHAR(50);`);
        await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS car_plate VARCHAR(20);`);
        await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS balance DECIMAL(10, 2) DEFAULT 0.00;`);
        await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS points INTEGER DEFAULT 0;`);
        await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS rating DECIMAL(3, 2) DEFAULT 5.00;`);
        await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS status VARCHAR(50) DEFAULT 'عضو جديد';`);
        await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS avatar TEXT;`);
        
        // Update existing users to have default values where NULL
        await pool.query(`
            UPDATE users 
            SET 
                balance = COALESCE(balance, 0.00),
                points = COALESCE(points, 0),
                rating = COALESCE(rating, 5.00),
                status = COALESCE(status, 'عضو جديد'),
                avatar = COALESCE(avatar, 'https://api.dicebear.com/7.x/avataaars/svg?seed=' || COALESCE(name, 'User'))
            WHERE balance IS NULL OR points IS NULL OR rating IS NULL OR status IS NULL OR avatar IS NULL;
        `);
        
        console.log('✅ User profile columns ensured with all user data fields');
    } catch (err) {
        console.error('❌ Failed to ensure user profile columns:', err.message);
    }
}

async function ensureTripRatingColumns() {
    try {
        await pool.query(`ALTER TABLE trips ADD COLUMN IF NOT EXISTS passenger_rating INTEGER;`);
        await pool.query(`ALTER TABLE trips ADD COLUMN IF NOT EXISTS driver_rating INTEGER;`);
        await pool.query(`ALTER TABLE trips ADD COLUMN IF NOT EXISTS passenger_review TEXT;`);
        await pool.query(`ALTER TABLE trips ADD COLUMN IF NOT EXISTS driver_review TEXT;`);

        console.log('✅ Trip rating columns ensured');
    } catch (err) {
        console.error('❌ Failed to ensure trip rating columns:', err.message);
    }
}

async function ensureTripTimeColumns() {
    try {
        await pool.query(`ALTER TABLE trips ADD COLUMN IF NOT EXISTS started_at TIMESTAMP;`);
        console.log('✅ Trip time columns ensured');
    } catch (err) {
        console.error('❌ Failed to ensure trip time columns:', err.message);
    }
}

async function ensureTripStatusColumn() {
    try {
        // Create enum type once (Postgres has no CREATE TYPE IF NOT EXISTS for all versions)
        await pool.query(`
            DO $$
            BEGIN
                CREATE TYPE trip_status_enum AS ENUM ('pending', 'accepted', 'arrived', 'started', 'completed', 'rated');
            EXCEPTION
                WHEN duplicate_object THEN NULL;
            END $$;
        `);

        await pool.query(`
            ALTER TABLE trips
            ADD COLUMN IF NOT EXISTS trip_status trip_status_enum DEFAULT 'pending';
        `);

        // Backfill for existing rows
        await pool.query(`
            UPDATE trips
            SET trip_status = CASE
                WHEN status = 'pending' THEN 'pending'::trip_status_enum
                WHEN status = 'assigned' THEN 'accepted'::trip_status_enum
                WHEN status = 'ongoing' THEN 'started'::trip_status_enum
                WHEN status = 'completed' AND COALESCE(passenger_rating, rating) IS NOT NULL THEN 'rated'::trip_status_enum
                WHEN status = 'completed' THEN 'completed'::trip_status_enum
                ELSE 'pending'::trip_status_enum
            END
            WHERE trip_status IS NULL
               OR (trip_status = 'pending'::trip_status_enum AND status IS NOT NULL AND status <> 'pending');
        `);

        console.log('✅ Trip trip_status column ensured');
    } catch (err) {
        console.error('❌ Failed to ensure trip_status column:', err.message);
    }
}

async function ensureTripSourceColumn() {
    try {
        await pool.query(`ALTER TABLE trips ADD COLUMN IF NOT EXISTS source VARCHAR(40);`);
        console.log('✅ Trip source column ensured');
    } catch (err) {
        console.error('❌ Failed to ensure trip source column:', err.message);
    }
}

async function ensureTripsRequiredColumns() {
    try {
        // Required-by-spec columns (keep legacy columns for backward compatibility)
        await pool.query(`ALTER TABLE trips ADD COLUMN IF NOT EXISTS rider_id INTEGER;`);
        await pool.query(`ALTER TABLE trips ADD COLUMN IF NOT EXISTS price DECIMAL(10, 2);`);
        await pool.query(`ALTER TABLE trips ADD COLUMN IF NOT EXISTS distance_km DECIMAL(10, 2);`);
        await pool.query(`ALTER TABLE trips ADD COLUMN IF NOT EXISTS duration_minutes INTEGER;`);
        await pool.query(`ALTER TABLE trips ADD COLUMN IF NOT EXISTS rider_rating INTEGER;`);

        // Backfill from legacy fields
        await pool.query(`
            UPDATE trips
            SET rider_id = COALESCE(rider_id, user_id)
            WHERE rider_id IS NULL AND user_id IS NOT NULL
        `);
        await pool.query(`
            UPDATE trips
            SET price = COALESCE(price, cost)
            WHERE price IS NULL AND cost IS NOT NULL
        `);
        await pool.query(`
            UPDATE trips
            SET distance_km = COALESCE(distance_km, distance)
            WHERE distance_km IS NULL AND distance IS NOT NULL
        `);
        await pool.query(`
            UPDATE trips
            SET duration_minutes = COALESCE(duration_minutes, duration)
            WHERE duration_minutes IS NULL AND duration IS NOT NULL
        `);
        await pool.query(`
            UPDATE trips
            SET rider_rating = COALESCE(rider_rating, passenger_rating, rating)
            WHERE rider_rating IS NULL AND (passenger_rating IS NOT NULL OR rating IS NOT NULL)
        `);

        // Helpful indexes
        await pool.query(`CREATE INDEX IF NOT EXISTS idx_trips_rider_id ON trips(rider_id);`);
        await pool.query(`CREATE INDEX IF NOT EXISTS idx_trips_driver_id ON trips(driver_id);`);
        await pool.query(`CREATE INDEX IF NOT EXISTS idx_trips_completed_at ON trips(completed_at DESC);`);

        console.log('✅ Trips required columns ensured');
    } catch (err) {
        console.error('❌ Failed to ensure trips required columns:', err.message);
    }
}

async function ensurePickupMetaColumns() {
    try {
        await pool.query(`ALTER TABLE trips ADD COLUMN IF NOT EXISTS pickup_accuracy DOUBLE PRECISION;`);
        await pool.query(`ALTER TABLE trips ADD COLUMN IF NOT EXISTS pickup_timestamp BIGINT;`);

        await pool.query(`ALTER TABLE pending_ride_requests ADD COLUMN IF NOT EXISTS pickup_accuracy DOUBLE PRECISION;`);
        await pool.query(`ALTER TABLE pending_ride_requests ADD COLUMN IF NOT EXISTS pickup_timestamp BIGINT;`);

        console.log('✅ Pickup meta columns ensured (accuracy/timestamp)');
    } catch (err) {
        console.error('❌ Failed to ensure pickup meta columns:', err.message);
    }
}

async function ensurePendingRideColumns() {
    try {
        await pool.query(`ALTER TABLE pending_ride_requests ADD COLUMN IF NOT EXISTS trip_id VARCHAR(50);`);
        await pool.query(`ALTER TABLE pending_ride_requests ADD COLUMN IF NOT EXISTS source VARCHAR(40) DEFAULT 'manual';`);
        await pool.query(`CREATE INDEX IF NOT EXISTS idx_pending_rides_trip_id ON pending_ride_requests(trip_id);`);
        await pool.query(`CREATE INDEX IF NOT EXISTS idx_pending_rides_source_status ON pending_ride_requests(source, status);`);

        await pool.query(`
            UPDATE pending_ride_requests
            SET source = COALESCE(NULLIF(source, ''), 'manual')
            WHERE source IS NULL OR source = ''
        `);

        console.log('✅ Pending rides columns ensured');
    } catch (err) {
        console.error('❌ Failed to ensure pending rides columns:', err.message);
    }
}

async function ensureDriverLocationColumns() {
    try {
        await pool.query(`ALTER TABLE drivers ADD COLUMN IF NOT EXISTS last_lat DECIMAL(10, 8);`);
        await pool.query(`ALTER TABLE drivers ADD COLUMN IF NOT EXISTS last_lng DECIMAL(11, 8);`);
        await pool.query(`ALTER TABLE drivers ADD COLUMN IF NOT EXISTS last_location_at TIMESTAMP;`);
        await pool.query(`CREATE INDEX IF NOT EXISTS idx_drivers_location ON drivers(last_lat, last_lng);`);
        console.log('✅ Driver location columns ensured');
    } catch (err) {
        console.error('❌ Failed to ensure driver location columns:', err.message);
    }
}

async function ensureAdminTripCountersTables() {
    try {
        await pool.query(`
            CREATE TABLE IF NOT EXISTS admin_daily_counters (
                day DATE PRIMARY KEY,
                daily_trips INTEGER NOT NULL DEFAULT 0,
                daily_revenue DECIMAL(12, 2) NOT NULL DEFAULT 0.00,
                daily_distance DECIMAL(12, 2) NOT NULL DEFAULT 0.00,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
        `);

        await pool.query(`
            CREATE TABLE IF NOT EXISTS admin_monthly_counters (
                month_key VARCHAR(7) PRIMARY KEY,
                monthly_trips INTEGER NOT NULL DEFAULT 0,
                monthly_revenue DECIMAL(12, 2) NOT NULL DEFAULT 0.00,
                monthly_distance DECIMAL(12, 2) NOT NULL DEFAULT 0.00,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
        `);

        console.log('✅ Admin daily/monthly counters tables ensured');
    } catch (err) {
        console.error('❌ Failed to ensure admin counters tables:', err.message);
    }
}

async function ensurePassengerFeatureTables() {
    try {
        // --- Pickup hubs (Smart Pickup Hubs) ---
        await pool.query(`
            CREATE TABLE IF NOT EXISTS pickup_hubs (
                id SERIAL PRIMARY KEY,
                title TEXT NOT NULL,
                category VARCHAR(60),
                lat DECIMAL(10, 8) NOT NULL,
                lng DECIMAL(11, 8) NOT NULL,
                is_active BOOLEAN NOT NULL DEFAULT true,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
        `);

        // Accessibility ranking metadata (v2)
        await pool.query('ALTER TABLE pickup_hubs ADD COLUMN IF NOT EXISTS wheelchair_accessible BOOLEAN NOT NULL DEFAULT false;');
        await pool.query('ALTER TABLE pickup_hubs ADD COLUMN IF NOT EXISTS ramp_available BOOLEAN NOT NULL DEFAULT false;');
        await pool.query('ALTER TABLE pickup_hubs ADD COLUMN IF NOT EXISTS low_traffic BOOLEAN NOT NULL DEFAULT false;');
        await pool.query('ALTER TABLE pickup_hubs ADD COLUMN IF NOT EXISTS good_lighting BOOLEAN NOT NULL DEFAULT false;');
        await pool.query('CREATE INDEX IF NOT EXISTS idx_pickup_hubs_active ON pickup_hubs(is_active);');
        await pool.query('CREATE INDEX IF NOT EXISTS idx_pickup_hubs_coords ON pickup_hubs(lat, lng);');

        // Seed a few default hubs (only if empty)
        try {
            const existing = await pool.query('SELECT COUNT(*)::int AS count FROM pickup_hubs');
            const count = existing.rows?.[0]?.count || 0;
            if (count === 0) {
                await pool.query(`
                    INSERT INTO pickup_hubs (title, category, lat, lng, is_active)
                    VALUES
                        ('محطة الرمل (نقطة تجمع)', 'مترو/محطة', 31.1999, 29.9183, true),
                        ('مكتبة الإسكندرية (بوابة)', 'معلم', 31.2089, 29.9092, true),
                        ('محطة سيدي جابر (مخرج رئيسي)', 'مترو/محطة', 31.2165, 29.9420, true),
                        ('مول سان ستيفانو (المدخل)', 'مول', 31.2453, 29.9675, true),
                        ('كورنيش الإسكندرية (نقطة واضحة)', 'كورنيش', 31.2156, 29.9553, true)
                `);
                console.log('✅ Default pickup hubs inserted');
            }
        } catch (e) {
            // non-blocking
        }

        // Link trip -> hub
        await pool.query('ALTER TABLE trips ADD COLUMN IF NOT EXISTS pickup_hub_id INTEGER REFERENCES pickup_hubs(id) ON DELETE SET NULL;');

        // --- Accessibility profile (v2) ---
        await pool.query(`
            CREATE TABLE IF NOT EXISTS passenger_accessibility_profiles (
                user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
                voice_prompts BOOLEAN NOT NULL DEFAULT false,
                text_first BOOLEAN NOT NULL DEFAULT false,
                no_calls BOOLEAN NOT NULL DEFAULT false,
                wheelchair BOOLEAN NOT NULL DEFAULT false,
                extra_time BOOLEAN NOT NULL DEFAULT false,
                simple_language BOOLEAN NOT NULL DEFAULT false,
                notes TEXT,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
        `);

        // --- Emergency info card (opt-in, v2) ---
        await pool.query(`
            CREATE TABLE IF NOT EXISTS passenger_emergency_profiles (
                user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
                opt_in BOOLEAN NOT NULL DEFAULT false,
                contact_name TEXT,
                contact_channel VARCHAR(20) NOT NULL DEFAULT 'phone',
                contact_value TEXT,
                medical_note TEXT,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
        `);

        // Trip snapshot + driver acknowledgement (v2)
        await pool.query('ALTER TABLE trips ADD COLUMN IF NOT EXISTS accessibility_snapshot_json JSONB;');
        await pool.query('ALTER TABLE trips ADD COLUMN IF NOT EXISTS accessibility_snapshot_at TIMESTAMP;');
        await pool.query('ALTER TABLE trips ADD COLUMN IF NOT EXISTS accessibility_ack_at TIMESTAMP;');
        await pool.query('ALTER TABLE trips ADD COLUMN IF NOT EXISTS accessibility_ack_by_driver_id INTEGER REFERENCES drivers(id) ON DELETE SET NULL;');
        await pool.query('CREATE INDEX IF NOT EXISTS idx_trips_accessibility_ack ON trips(accessibility_ack_at DESC);');

        // --- Trip messaging board (v2) ---
        await pool.query(`
            CREATE TABLE IF NOT EXISTS trip_messages (
                id BIGSERIAL PRIMARY KEY,
                trip_id VARCHAR(50) REFERENCES trips(id) ON DELETE CASCADE,
                sender_role VARCHAR(20) NOT NULL,
                sender_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
                sender_driver_id INTEGER REFERENCES drivers(id) ON DELETE SET NULL,
                template_key VARCHAR(40),
                message TEXT NOT NULL,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
        `);
        await pool.query('CREATE INDEX IF NOT EXISTS idx_trip_messages_trip ON trip_messages(trip_id, created_at DESC);');

        // --- Accessibility feedback after trip (v2) ---
        await pool.query(`
            CREATE TABLE IF NOT EXISTS trip_accessibility_feedback (
                id BIGSERIAL PRIMARY KEY,
                trip_id VARCHAR(50) REFERENCES trips(id) ON DELETE CASCADE,
                user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
                respected BOOLEAN NOT NULL,
                reason TEXT,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                UNIQUE (trip_id, user_id)
            );
        `);
        await pool.query('CREATE INDEX IF NOT EXISTS idx_trip_accessibility_feedback_trip ON trip_accessibility_feedback(trip_id, created_at DESC);');

        // Driver suggestions for pickup hub/location
        await pool.query(`
            CREATE TABLE IF NOT EXISTS trip_pickup_suggestions (
                id BIGSERIAL PRIMARY KEY,
                trip_id VARCHAR(50) REFERENCES trips(id) ON DELETE CASCADE,
                suggested_by_role VARCHAR(20) NOT NULL,
                suggested_by_driver_id INTEGER REFERENCES drivers(id) ON DELETE SET NULL,
                hub_id INTEGER REFERENCES pickup_hubs(id) ON DELETE SET NULL,
                suggested_title TEXT,
                suggested_lat DECIMAL(10, 8),
                suggested_lng DECIMAL(11, 8),
                status VARCHAR(20) NOT NULL DEFAULT 'pending',
                passenger_decision_at TIMESTAMP,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
        `);
        await pool.query('CREATE INDEX IF NOT EXISTS idx_trip_pickup_suggestions_trip ON trip_pickup_suggestions(trip_id, created_at DESC);');
        await pool.query('CREATE INDEX IF NOT EXISTS idx_trip_pickup_suggestions_status ON trip_pickup_suggestions(status);');

        // --- ETA + delay reason ---
        await pool.query('ALTER TABLE trips ADD COLUMN IF NOT EXISTS eta_minutes INTEGER;');
        await pool.query('ALTER TABLE trips ADD COLUMN IF NOT EXISTS eta_reason TEXT;');
        await pool.query('ALTER TABLE trips ADD COLUMN IF NOT EXISTS eta_updated_at TIMESTAMP;');

        // --- Favorite captain ---
        await pool.query(`
            CREATE TABLE IF NOT EXISTS passenger_favorite_drivers (
                user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
                driver_id INTEGER REFERENCES drivers(id) ON DELETE CASCADE,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                PRIMARY KEY (user_id, driver_id)
            );
        `);
        await pool.query('CREATE INDEX IF NOT EXISTS idx_passenger_fav_driver ON passenger_favorite_drivers(driver_id);');

        // --- Loyalty tiers ---
        await pool.query(`
            CREATE TABLE IF NOT EXISTS passenger_loyalty_stats (
                user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
                completed_trips INTEGER NOT NULL DEFAULT 0,
                cancelled_trips INTEGER NOT NULL DEFAULT 0,
                hub_compliance_trips INTEGER NOT NULL DEFAULT 0,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
        `);

        // --- Passenger notes (templates + per-trip note) ---
        await pool.query('ALTER TABLE trips ADD COLUMN IF NOT EXISTS passenger_note TEXT;');
        await pool.query(`
            CREATE TABLE IF NOT EXISTS passenger_note_templates (
                id BIGSERIAL PRIMARY KEY,
                user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
                title VARCHAR(80),
                note TEXT NOT NULL,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
        `);
        await pool.query('CREATE INDEX IF NOT EXISTS idx_passenger_note_templates_user ON passenger_note_templates(user_id, created_at DESC);');

        // --- Family / Group ---
        await pool.query(`
            CREATE TABLE IF NOT EXISTS passenger_family_members (
                id BIGSERIAL PRIMARY KEY,
                owner_user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
                name VARCHAR(120) NOT NULL,
                phone VARCHAR(30),
                daily_limit DECIMAL(12, 2),
                weekly_limit DECIMAL(12, 2),
                is_active BOOLEAN NOT NULL DEFAULT true,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
        `);
        await pool.query('CREATE INDEX IF NOT EXISTS idx_passenger_family_owner ON passenger_family_members(owner_user_id, is_active);');
        await pool.query('ALTER TABLE trips ADD COLUMN IF NOT EXISTS booked_for_family_member_id BIGINT REFERENCES passenger_family_members(id) ON DELETE SET NULL;');

        // --- Trip quiet mode (Comfort) ---
        await pool.query('ALTER TABLE trips ADD COLUMN IF NOT EXISTS quiet_mode BOOLEAN NOT NULL DEFAULT false;');

        // --- Trip budget envelope (Smart saving) ---
        await pool.query(`
            CREATE TABLE IF NOT EXISTS passenger_budget_envelopes (
                user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
                enabled BOOLEAN NOT NULL DEFAULT true,
                daily_limit DECIMAL(12, 2),
                weekly_limit DECIMAL(12, 2),
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
        `);

        // --- Scheduled rides ---
        await pool.query(`
            CREATE TABLE IF NOT EXISTS scheduled_rides (
                id BIGSERIAL PRIMARY KEY,
                user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
                pickup_location VARCHAR(255) NOT NULL,
                dropoff_location VARCHAR(255) NOT NULL,
                pickup_lat DECIMAL(10, 8) NOT NULL,
                pickup_lng DECIMAL(11, 8) NOT NULL,
                dropoff_lat DECIMAL(10, 8) NOT NULL,
                dropoff_lng DECIMAL(11, 8) NOT NULL,
                car_type VARCHAR(50) DEFAULT 'economy',
                estimated_price DECIMAL(10, 2),
                payment_method VARCHAR(20) DEFAULT 'cash',
                scheduled_at TIMESTAMP NOT NULL,
                status VARCHAR(30) NOT NULL DEFAULT 'pending_confirmation',
                confirmed_at TIMESTAMP,
                created_trip_id VARCHAR(50) REFERENCES trips(id) ON DELETE SET NULL,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
        `);
        await pool.query('CREATE INDEX IF NOT EXISTS idx_scheduled_rides_user ON scheduled_rides(user_id, scheduled_at DESC);');
        await pool.query('CREATE INDEX IF NOT EXISTS idx_scheduled_rides_status ON scheduled_rides(status, scheduled_at);');

        // --- Price lock ---
        await pool.query(`
            CREATE TABLE IF NOT EXISTS price_locks (
                id BIGSERIAL PRIMARY KEY,
                user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
                pickup_lat DECIMAL(10, 8) NOT NULL,
                pickup_lng DECIMAL(11, 8) NOT NULL,
                dropoff_lat DECIMAL(10, 8) NOT NULL,
                dropoff_lng DECIMAL(11, 8) NOT NULL,
                car_type VARCHAR(50) DEFAULT 'economy',
                price DECIMAL(10, 2) NOT NULL,
                currency VARCHAR(8) NOT NULL DEFAULT 'SAR',
                expires_at TIMESTAMP NOT NULL,
                used_trip_id VARCHAR(50) REFERENCES trips(id) ON DELETE SET NULL,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
        `);
        await pool.query('CREATE INDEX IF NOT EXISTS idx_price_locks_user_expires ON price_locks(user_id, expires_at DESC);');
        await pool.query('ALTER TABLE trips ADD COLUMN IF NOT EXISTS price_lock_id BIGINT REFERENCES price_locks(id) ON DELETE SET NULL;');

        // --- Multi-stop trip ---
        await pool.query(`
            CREATE TABLE IF NOT EXISTS trip_stops (
                id BIGSERIAL PRIMARY KEY,
                trip_id VARCHAR(50) REFERENCES trips(id) ON DELETE CASCADE,
                stop_order INTEGER NOT NULL,
                label VARCHAR(255),
                lat DECIMAL(10, 8) NOT NULL,
                lng DECIMAL(11, 8) NOT NULL,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                UNIQUE (trip_id, stop_order)
            );
        `);
        await pool.query('CREATE INDEX IF NOT EXISTS idx_trip_stops_trip ON trip_stops(trip_id, stop_order);');

        // --- Split fare ---
        await pool.query(`
            CREATE TABLE IF NOT EXISTS trip_split_payments (
                id BIGSERIAL PRIMARY KEY,
                trip_id VARCHAR(50) REFERENCES trips(id) ON DELETE CASCADE,
                payer_user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
                amount DECIMAL(12, 2) NOT NULL,
                method VARCHAR(20) NOT NULL DEFAULT 'wallet',
                status VARCHAR(20) NOT NULL DEFAULT 'pending',
                paid_at TIMESTAMP,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                UNIQUE (trip_id, payer_user_id)
            );
        `);
        await pool.query('CREATE INDEX IF NOT EXISTS idx_trip_split_payments_trip ON trip_split_payments(trip_id);');

        // --- Safety pack ---
        await pool.query(`
            CREATE TABLE IF NOT EXISTS trip_shares (
                id BIGSERIAL PRIMARY KEY,
                trip_id VARCHAR(50) REFERENCES trips(id) ON DELETE CASCADE,
                share_token VARCHAR(80) UNIQUE NOT NULL,
                created_by_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
                expires_at TIMESTAMP,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
        `);
        await pool.query('CREATE INDEX IF NOT EXISTS idx_trip_shares_trip ON trip_shares(trip_id, created_at DESC);');

        await pool.query(`
            CREATE TABLE IF NOT EXISTS trip_safety_events (
                id BIGSERIAL PRIMARY KEY,
                trip_id VARCHAR(50) REFERENCES trips(id) ON DELETE CASCADE,
                created_by_role VARCHAR(20) NOT NULL,
                created_by_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
                created_by_driver_id INTEGER REFERENCES drivers(id) ON DELETE SET NULL,
                event_type VARCHAR(40) NOT NULL,
                message TEXT,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
        `);
        await pool.query('CREATE INDEX IF NOT EXISTS idx_trip_safety_events_trip ON trip_safety_events(trip_id, created_at DESC);');

        // --- Safety & trust ---

        // Basic verification state (opt-in tokens are handled at API level)
        await pool.query('ALTER TABLE users ADD COLUMN IF NOT EXISTS email_verified_at TIMESTAMP;');
        await pool.query('ALTER TABLE users ADD COLUMN IF NOT EXISTS phone_verified_at TIMESTAMP;');

        await pool.query(`
            CREATE TABLE IF NOT EXISTS user_verification_tokens (
                id BIGSERIAL PRIMARY KEY,
                user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
                token_type VARCHAR(20) NOT NULL,
                token VARCHAR(120) NOT NULL,
                expires_at TIMESTAMP NOT NULL,
                consumed_at TIMESTAMP,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
        `);
        await pool.query('CREATE INDEX IF NOT EXISTS idx_user_verification_tokens_user ON user_verification_tokens(user_id, token_type, created_at DESC);');
        await pool.query('CREATE INDEX IF NOT EXISTS idx_user_verification_tokens_token ON user_verification_tokens(token_type, token);');

        // Optional OAuth identities (Google/Apple): link provider account to existing user
        await pool.query(`
            CREATE TABLE IF NOT EXISTS user_oauth_identities (
                id BIGSERIAL PRIMARY KEY,
                user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
                provider VARCHAR(20) NOT NULL,
                provider_sub TEXT NOT NULL,
                email TEXT,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                UNIQUE (provider, provider_sub)
            );
        `);
        await pool.query('CREATE INDEX IF NOT EXISTS idx_user_oauth_identities_user ON user_oauth_identities(user_id, provider, created_at DESC);');
        await pool.query('CREATE INDEX IF NOT EXISTS idx_user_oauth_identities_email ON user_oauth_identities(provider, email);');

        // Strong verification requests (manual admin review)
        await pool.query(`
            CREATE TABLE IF NOT EXISTS passenger_verifications (
                id BIGSERIAL PRIMARY KEY,
                user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
                level VARCHAR(10) NOT NULL DEFAULT 'strong',
                status VARCHAR(20) NOT NULL DEFAULT 'pending',
                submitted_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                reviewed_at TIMESTAMP,
                reviewed_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
                reject_reason TEXT,
                id_document_path TEXT,
                selfie_path TEXT
            );
        `);
        await pool.query('CREATE INDEX IF NOT EXISTS idx_passenger_verifications_user ON passenger_verifications(user_id, submitted_at DESC);');
        await pool.query('CREATE INDEX IF NOT EXISTS idx_passenger_verifications_status ON passenger_verifications(status, submitted_at ASC);');

        // Trusted contacts (guardian)
        await pool.query(`
            CREATE TABLE IF NOT EXISTS passenger_trusted_contacts (
                id BIGSERIAL PRIMARY KEY,
                user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
                name VARCHAR(120) NOT NULL,
                channel VARCHAR(20) NOT NULL DEFAULT 'whatsapp',
                value TEXT NOT NULL,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
        `);
        await pool.query('CREATE INDEX IF NOT EXISTS idx_passenger_trusted_contacts_user ON passenger_trusted_contacts(user_id, created_at DESC);');

        // Scheduled guardian check-ins per trip
        await pool.query(`
            CREATE TABLE IF NOT EXISTS trip_guardian_checkins (
                id BIGSERIAL PRIMARY KEY,
                trip_id VARCHAR(50) REFERENCES trips(id) ON DELETE CASCADE,
                user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
                due_at TIMESTAMP NOT NULL,
                status VARCHAR(20) NOT NULL DEFAULT 'scheduled',
                sent_at TIMESTAMP,
                delivery_result JSONB,
                last_error TEXT,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
        `);
        await pool.query('ALTER TABLE trip_guardian_checkins ADD COLUMN IF NOT EXISTS sent_at TIMESTAMP;');
        await pool.query('ALTER TABLE trip_guardian_checkins ADD COLUMN IF NOT EXISTS delivery_result JSONB;');
        await pool.query('ALTER TABLE trip_guardian_checkins ADD COLUMN IF NOT EXISTS last_error TEXT;');
        await pool.query('CREATE INDEX IF NOT EXISTS idx_trip_guardian_checkins_due ON trip_guardian_checkins(status, due_at ASC);');
        await pool.query('CREATE INDEX IF NOT EXISTS idx_trip_guardian_checkins_trip ON trip_guardian_checkins(trip_id, created_at DESC);');

        // Route deviation guardian (optional per-trip config)
        await pool.query(`
            CREATE TABLE IF NOT EXISTS trip_route_deviation_configs (
                trip_id VARCHAR(50) PRIMARY KEY REFERENCES trips(id) ON DELETE CASCADE,
                enabled BOOLEAN NOT NULL DEFAULT true,
                deviation_threshold_km DECIMAL(10, 3),
                stop_minutes_threshold INTEGER,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
        `);

        // Pickup handshake fields on trips
        await pool.query('ALTER TABLE trips ADD COLUMN IF NOT EXISTS pickup_code_hash TEXT;');
        await pool.query('ALTER TABLE trips ADD COLUMN IF NOT EXISTS pickup_code_expires_at TIMESTAMP;');
        await pool.query('ALTER TABLE trips ADD COLUMN IF NOT EXISTS pickup_verified_at TIMESTAMP;');
        await pool.query('ALTER TABLE trips ADD COLUMN IF NOT EXISTS pickup_verified_by INTEGER REFERENCES drivers(id) ON DELETE SET NULL;');

        // --- In-app support ---
        await pool.query(`
            CREATE TABLE IF NOT EXISTS support_tickets (
                id BIGSERIAL PRIMARY KEY,
                trip_id VARCHAR(50) REFERENCES trips(id) ON DELETE SET NULL,
                user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
                category VARCHAR(60) NOT NULL,
                description TEXT,
                attachment_path TEXT,
                status VARCHAR(20) NOT NULL DEFAULT 'open',
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
        `);
        await pool.query('CREATE INDEX IF NOT EXISTS idx_support_tickets_user ON support_tickets(user_id, created_at DESC);');
        await pool.query('CREATE INDEX IF NOT EXISTS idx_support_tickets_status ON support_tickets(status, created_at DESC);');
        await pool.query('CREATE INDEX IF NOT EXISTS idx_support_tickets_trip ON support_tickets(trip_id);');

        // --- Anti-fraud / anti-abuse (idempotency for rewards/payments) ---
        await pool.query(`
            CREATE TABLE IF NOT EXISTS trip_reward_events (
                id BIGSERIAL PRIMARY KEY,
                user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
                trip_id VARCHAR(50) REFERENCES trips(id) ON DELETE CASCADE,
                points_awarded INTEGER NOT NULL DEFAULT 0,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                UNIQUE (trip_id)
            );
        `);
        await pool.query(`
            CREATE UNIQUE INDEX IF NOT EXISTS uq_wallet_trip_payment
            ON wallet_transactions(owner_type, owner_id, reference_type, reference_id)
            WHERE reference_type IS NOT NULL AND reference_id IS NOT NULL;
        `);

        // ==================== PASSENGER FEATURES (v3) ====================

        // (A) Saved Places
        await pool.query(`
            CREATE TABLE IF NOT EXISTS passenger_saved_places (
                id BIGSERIAL PRIMARY KEY,
                user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
                label VARCHAR(20) NOT NULL,
                name VARCHAR(120) NOT NULL,
                lat DECIMAL(10, 8) NOT NULL,
                lng DECIMAL(11, 8) NOT NULL,
                notes TEXT,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
        `);
        await pool.query('CREATE INDEX IF NOT EXISTS idx_passenger_saved_places_user ON passenger_saved_places(user_id, created_at DESC);');
        // Enforce one home/work place per user (custom can be multiple)
        await pool.query(`
            CREATE UNIQUE INDEX IF NOT EXISTS uq_passenger_saved_places_home_work
            ON passenger_saved_places(user_id, label)
            WHERE label IN ('home', 'work');
        `);

        // (B) Trip Templates
        await pool.query(`
            CREATE TABLE IF NOT EXISTS passenger_trip_templates (
                id BIGSERIAL PRIMARY KEY,
                user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
                title VARCHAR(120) NOT NULL,
                payload_json JSONB NOT NULL,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
        `);
        await pool.query('CREATE INDEX IF NOT EXISTS idx_passenger_trip_templates_user ON passenger_trip_templates(user_id, created_at DESC);');

        // (C) Lost & Found
        await pool.query(`
            CREATE TABLE IF NOT EXISTS lost_items (
                id BIGSERIAL PRIMARY KEY,
                trip_id VARCHAR(50) REFERENCES trips(id) ON DELETE CASCADE,
                user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
                description TEXT NOT NULL,
                contact_method VARCHAR(60),
                status VARCHAR(20) NOT NULL DEFAULT 'open',
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
        `);
        await pool.query('CREATE INDEX IF NOT EXISTS idx_lost_items_user ON lost_items(user_id, created_at DESC);');
        await pool.query('CREATE INDEX IF NOT EXISTS idx_lost_items_trip ON lost_items(trip_id, created_at DESC);');
        await pool.query('CREATE INDEX IF NOT EXISTS idx_lost_items_status ON lost_items(status, created_at DESC);');

        // (D) Tipping
        await pool.query(`
            CREATE TABLE IF NOT EXISTS trip_tips (
                id BIGSERIAL PRIMARY KEY,
                trip_id VARCHAR(50) REFERENCES trips(id) ON DELETE CASCADE,
                user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
                driver_id INTEGER REFERENCES drivers(id) ON DELETE SET NULL,
                amount DECIMAL(12, 2) NOT NULL,
                method VARCHAR(20) NOT NULL DEFAULT 'cash',
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                UNIQUE (trip_id, user_id)
            );
        `);
        await pool.query('CREATE INDEX IF NOT EXISTS idx_trip_tips_trip ON trip_tips(trip_id, created_at DESC);');
        await pool.query('CREATE INDEX IF NOT EXISTS idx_trip_tips_driver ON trip_tips(driver_id, created_at DESC);');

        // (E) Ride Pass / Subscription
        await pool.query(`
            CREATE TABLE IF NOT EXISTS passenger_ride_passes (
                id BIGSERIAL PRIMARY KEY,
                user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
                type VARCHAR(60) NOT NULL,
                rules_json JSONB,
                valid_from TIMESTAMP,
                valid_to TIMESTAMP,
                status VARCHAR(20) NOT NULL DEFAULT 'active',
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
        `);
        await pool.query('CREATE INDEX IF NOT EXISTS idx_passenger_ride_passes_user ON passenger_ride_passes(user_id, status, valid_to DESC);');

        // Store pass effect on trip
        await pool.query('ALTER TABLE trips ADD COLUMN IF NOT EXISTS ride_pass_id BIGINT REFERENCES passenger_ride_passes(id) ON DELETE SET NULL;');
        await pool.query('ALTER TABLE trips ADD COLUMN IF NOT EXISTS fare_before_discount DECIMAL(12, 2);');
        await pool.query('ALTER TABLE trips ADD COLUMN IF NOT EXISTS discount_amount DECIMAL(12, 2);');
        await pool.query('ALTER TABLE trips ADD COLUMN IF NOT EXISTS discount_meta_json JSONB;');

        // (F) Fare Review / Refund Request
        await pool.query(`
            CREATE TABLE IF NOT EXISTS refund_requests (
                id BIGSERIAL PRIMARY KEY,
                trip_id VARCHAR(50) REFERENCES trips(id) ON DELETE CASCADE,
                user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
                reason TEXT NOT NULL,
                amount_requested DECIMAL(12, 2),
                status VARCHAR(20) NOT NULL DEFAULT 'pending',
                resolution_note TEXT,
                reviewed_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                UNIQUE (trip_id, user_id)
            );
        `);
        await pool.query('CREATE INDEX IF NOT EXISTS idx_refund_requests_user ON refund_requests(user_id, created_at DESC);');
        await pool.query('CREATE INDEX IF NOT EXISTS idx_refund_requests_status ON refund_requests(status, created_at DESC);');

        // (G) Smart Rebook - no table required

        console.log('✅ Passenger feature tables ensured');
    } catch (err) {
        console.error('❌ Failed to ensure passenger feature tables:', err.message);
    }
}

async function findNearestAvailableDriver({ pickupLat, pickupLng, carType, riderId = null }) {
    if (!Number.isFinite(pickupLat) || !Number.isFinite(pickupLng)) return null;

    const normalizedRiderId = riderId !== undefined && riderId !== null ? Number(riderId) : null;

    // Favorites-first (if riderId exists)
    if (Number.isFinite(normalizedRiderId) && normalizedRiderId > 0) {
        const paramsFav = [pickupLat, pickupLng, normalizedRiderId];
        let carFilterFav = '';
        if (carType) {
            paramsFav.push(String(carType));
            carFilterFav = ` AND d.car_type = $${paramsFav.length}`;
        }

        const favRes = await pool.query(
            `SELECT d.id, d.name,
                    (6371 * acos(
                        cos(radians($1)) * cos(radians(d.last_lat)) * cos(radians(d.last_lng) - radians($2)) +
                        sin(radians($1)) * sin(radians(d.last_lat))
                    )) AS distance_km
             FROM passenger_favorite_drivers f
             JOIN drivers d ON d.id = f.driver_id
             LEFT JOIN trips t
               ON t.driver_id = d.id AND t.status IN ('assigned', 'ongoing')
             WHERE f.user_id = $3
               AND d.status = 'online'
               AND d.approval_status = 'approved'
               AND d.last_lat IS NOT NULL
               AND d.last_lng IS NOT NULL
               AND d.last_location_at >= NOW() - ($${paramsFav.length + 1} * INTERVAL '1 minute')
               AND t.id IS NULL
               ${carFilterFav}
             ORDER BY distance_km ASC
             LIMIT 1`,
            [...paramsFav, DRIVER_LOCATION_TTL_MINUTES]
        );
        if (favRes.rows.length > 0) return favRes.rows[0];
    }

    const params = [pickupLat, pickupLng];
    let carFilter = '';
    if (carType) {
        params.push(String(carType));
        carFilter = ` AND d.car_type = $${params.length}`;
    }

    const result = await pool.query(
        `SELECT d.id, d.name,
                (6371 * acos(
                    cos(radians($1)) * cos(radians(d.last_lat)) * cos(radians(d.last_lng) - radians($2)) +
                    sin(radians($1)) * sin(radians(d.last_lat))
                )) AS distance_km
         FROM drivers d
         LEFT JOIN trips t
           ON t.driver_id = d.id AND t.status IN ('assigned', 'ongoing')
         WHERE d.status = 'online'
           AND d.approval_status = 'approved'
           AND d.last_lat IS NOT NULL
           AND d.last_lng IS NOT NULL
                     AND d.last_location_at >= NOW() - ($${params.length + 1} * INTERVAL '1 minute')
           AND t.id IS NULL
           ${carFilter}
         ORDER BY distance_km ASC
         LIMIT 1`,
                [...params, DRIVER_LOCATION_TTL_MINUTES]
    );

    return result.rows[0] || null;
}

// Health check
app.get('/api/health', (req, res) => {
    res.json({ status: 'OK', message: 'Server is running' });
});

// Database health check
app.get('/api/db/health', async (req, res) => {
    try {
        await pool.query('SELECT 1');
        res.json({ status: 'OK', message: 'Database is connected' });
    } catch (err) {
        console.error('Database health check failed:', err);
        res.status(500).json({ status: 'ERROR', message: 'Database connection failed' });
    }
});

// ==================== PASSENGER FEATURES (Haged-uber.md) ====================

function requireTripAccess({ tripRow, authRole, authUserId, authDriverId }) {
    if (!tripRow) return { ok: false, status: 404, error: 'Trip not found' };

    if (authRole === 'passenger') {
        if (!authUserId) return { ok: false, status: 401, error: 'Unauthorized' };
        if (String(tripRow.user_id) !== String(authUserId)) {
            return { ok: false, status: 403, error: 'Forbidden' };
        }
        return { ok: true };
    }

    if (authRole === 'driver') {
        if (!authDriverId) return { ok: false, status: 403, error: 'Driver profile not linked to this account' };
        if (String(tripRow.driver_id || '') !== String(authDriverId)) {
            return { ok: false, status: 403, error: 'Forbidden' };
        }
        return { ok: true };
    }

    // admin or other roles
    return { ok: true };
}

function getLoyaltyTier({ completedTrips, cancelledTrips, hubComplianceTrips }) {
    const completed = Math.max(0, Number(completedTrips) || 0);
    const cancelled = Math.max(0, Number(cancelledTrips) || 0);
    const compliance = Math.max(0, Number(hubComplianceTrips) || 0);
    const cancelRate = completed > 0 ? cancelled / completed : 0;

    if (completed >= 30 && cancelRate <= 0.10 && compliance >= 10) {
        return {
            tier: 'Gold',
            benefits: ['أولوية مطابقة أعلى', 'خصومات/عروض أفضل', 'دعم أسرع']
        };
    }
    if (completed >= 10 && cancelRate <= 0.20) {
        return {
            tier: 'Silver',
            benefits: ['أولوية مطابقة', 'عروض دورية', 'دعم أسرع']
        };
    }
    return {
        tier: 'Bronze',
        benefits: ['عروض ترحيبية', 'نقاط على الرحلات المكتملة']
    };
}

function makeShareToken() {
    return crypto.randomBytes(24).toString('hex');
}

function sha256Hex(input) {
    return crypto.createHash('sha256').update(String(input)).digest('hex');
}

function computePassengerVerifiedLevel({ email_verified_at, phone_verified_at, strong_verification_status }) {
    const strong = String(strong_verification_status || '').toLowerCase();
    if (strong === 'approved') return 'strong';
    if (email_verified_at && phone_verified_at) return 'basic';
    return 'none';
}

function pickupHandshakeWindowStartMs(nowMs, windowMinutes) {
    const w = Math.max(1, Number(windowMinutes) || 10) * 60 * 1000;
    return Math.floor(nowMs / w) * w;
}

function computePickupHandshakeCode({ tripId, windowStartMs, digits = 6 }) {
    const secret = process.env.PICKUP_HANDSHAKE_SECRET || process.env.JWT_SECRET || 'pickup_handshake_secret';
    const msg = `${String(tripId)}:${String(windowStartMs)}`;
    const h = crypto.createHmac('sha256', secret).update(msg).digest();

    // Take 4 bytes -> uint32 -> mod 10^digits
    const n = h.readUInt32BE(0);
    const mod = Math.pow(10, Math.max(4, Math.min(8, Number(digits) || 6)));
    const code = String(n % mod).padStart(Math.round(Math.log10(mod)), '0');
    return code;
}

// Equirectangular projection helpers for small-distance calculations
function degToRad(d) {
    return (Number(d) * Math.PI) / 180;
}

function pointToSegmentDistanceKm(p, a, b) {
    // Approximate on a plane around point A
    const lat0 = degToRad(a.lat);
    const x = (lng) => degToRad(lng) * Math.cos(lat0) * 6371;
    const y = (lat) => degToRad(lat) * 6371;

    const ax = x(a.lng);
    const ay = y(a.lat);
    const bx = x(b.lng);
    const by = y(b.lat);
    const px = x(p.lng);
    const py = y(p.lat);

    const abx = bx - ax;
    const aby = by - ay;
    const apx = px - ax;
    const apy = py - ay;

    const abLen2 = abx * abx + aby * aby;
    if (abLen2 <= 1e-12) {
        const dx = px - ax;
        const dy = py - ay;
        return Math.sqrt(dx * dx + dy * dy);
    }

    let t = (apx * abx + apy * aby) / abLen2;
    t = Math.max(0, Math.min(1, t));
    const cx = ax + t * abx;
    const cy = ay + t * aby;
    const dx = px - cx;
    const dy = py - cy;
    return Math.sqrt(dx * dx + dy * dy);
}

function computeSimplePrice({ pickupLat, pickupLng, dropoffLat, dropoffLng, carType }) {
    const km = haversineKm({ lat: pickupLat, lng: pickupLng }, { lat: dropoffLat, lng: dropoffLng });
    const baseFare = 8; // minimal default (no extra UX)
    const perKm = carType === 'vip' ? 4 : carType === 'family' ? 3.2 : 2.6;
    const price = Math.max(10, Math.round((baseFare + km * perKm) * 100) / 100);
    return { distance_km: Math.round(km * 100) / 100, price };
}

async function getWalletBalance(client, { owner_type, owner_id }) {
    const sum = await client.query(
        `SELECT COALESCE(SUM(amount), 0) AS balance
         FROM wallet_transactions
         WHERE owner_type = $1 AND owner_id = $2`,
        [owner_type, owner_id]
    );
    return Number(sum.rows[0]?.balance || 0);
}

async function getTodayWalletDebitsTotal(client, { owner_type, owner_id, referenceType = null }) {
    const params = [owner_type, owner_id];
    let refFilter = '';
    if (referenceType) {
        params.push(referenceType);
        refFilter = ` AND reference_type = $${params.length}`;
    }

    const res = await client.query(
        `SELECT COALESCE(ABS(SUM(amount)), 0) AS total
         FROM wallet_transactions
         WHERE owner_type = $1
           AND owner_id = $2
           AND amount < 0
           ${refFilter}
           AND created_at >= date_trunc('day', NOW())`,
        params
    );
    return Number(res.rows[0]?.total || 0);
}

// --- Smart Pickup Hubs ---

app.get('/api/pickup-hubs/suggest', async (req, res) => {
    try {
        const lat = req.query.lat !== undefined ? Number(req.query.lat) : null;
        const lng = req.query.lng !== undefined ? Number(req.query.lng) : null;
        const limit = Number.isFinite(Number(req.query.limit)) ? Math.min(Math.max(Number(req.query.limit), 1), 20) : 8;
        const preference = req.query.preference ? String(req.query.preference).toLowerCase() : 'clear';

        // Optional accessibility ranking (v2): default to enabled if passenger has any accessibility needs
        const accessibilityQueryFlag = String(req.query.accessibility || '').toLowerCase();
        let accessibility = null;
        let preferAccessibilityRanking = accessibilityQueryFlag === '1' || accessibilityQueryFlag === 'true';
        try {
            const authRole = String(req.auth?.role || '').toLowerCase();
            const authUserId = req.auth?.uid;
            if ((authRole === 'passenger' || authRole === 'admin') && authUserId) {
                const profRes = await pool.query(
                    `SELECT voice_prompts, text_first, no_calls, wheelchair, extra_time, simple_language
                     FROM passenger_accessibility_profiles
                     WHERE user_id = $1
                     LIMIT 1`,
                    [authUserId]
                );
                accessibility = profRes.rows[0] || null;
                if (!preferAccessibilityRanking && accessibility) {
                    preferAccessibilityRanking =
                        !!accessibility.wheelchair ||
                        !!accessibility.extra_time ||
                        !!accessibility.simple_language ||
                        !!accessibility.text_first ||
                        !!accessibility.no_calls ||
                        !!accessibility.voice_prompts;
                }
            }
        } catch (e) {
            accessibility = null;
        }

        const needsWheelchair = !!accessibility?.wheelchair;
        const wantsLowTraffic = !!accessibility?.extra_time;
        const wantsGoodLighting = !!accessibility?.simple_language;

        if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
            return res.status(400).json({ success: false, error: 'lat and lng are required' });
        }

        const safePref = preference === 'safe' || preference === 'safer' || preference === 'secure';

        const result = await pool.query(
            `SELECT id, title, category, lat, lng,
                    wheelchair_accessible, ramp_available, low_traffic, good_lighting,
                    (6371 * acos(
                        cos(radians($1)) * cos(radians(lat)) * cos(radians(lng) - radians($2)) +
                        sin(radians($1)) * sin(radians(lat))
                    )) AS distance_km
             FROM pickup_hubs
             WHERE is_active = true
             ORDER BY
                CASE
                    WHEN $4::boolean = true AND COALESCE(category,'') ILIKE ANY(ARRAY['%محطة%','%مترو%','%مول%','%معلم%','%بوابة%']) THEN 0
                    WHEN $4::boolean = true THEN 1
                    ELSE 0
                END ASC,
                CASE
                    WHEN $5::boolean = true AND $6::boolean = true AND wheelchair_accessible = true THEN 0
                    WHEN $5::boolean = true AND $6::boolean = true THEN 1
                    ELSE 0
                END ASC,
                CASE
                    WHEN $5::boolean = true AND $7::boolean = true AND low_traffic = true THEN 0
                    WHEN $5::boolean = true AND $7::boolean = true THEN 1
                    ELSE 0
                END ASC,
                CASE
                    WHEN $5::boolean = true AND $8::boolean = true AND good_lighting = true THEN 0
                    WHEN $5::boolean = true AND $8::boolean = true THEN 1
                    ELSE 0
                END ASC,
                distance_km ASC
             LIMIT $3`,
            [lat, lng, limit, safePref, preferAccessibilityRanking, needsWheelchair, wantsLowTraffic, wantsGoodLighting]
        );

        res.json({ success: true, data: result.rows });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// --- Passenger Accessibility Profile (v2) ---

app.get('/api/passengers/me/accessibility', requireRole('passenger', 'admin'), async (req, res) => {
    try {
        const authRole = String(req.auth?.role || '').toLowerCase();
        const userId = authRole === 'passenger' ? req.auth?.uid : Number(req.query.user_id);
        if (!userId) return res.status(400).json({ success: false, error: 'user_id is required' });

        const result = await pool.query(
            `SELECT user_id, voice_prompts, text_first, no_calls, wheelchair, extra_time, simple_language, notes, created_at, updated_at
             FROM passenger_accessibility_profiles
             WHERE user_id = $1
             LIMIT 1`,
            [userId]
        );
        const row = result.rows[0] || null;
        if (!row) {
            return res.json({
                success: true,
                data: {
                    user_id: Number(userId),
                    voice_prompts: false,
                    text_first: false,
                    no_calls: false,
                    wheelchair: false,
                    extra_time: false,
                    simple_language: false,
                    notes: null,
                    created_at: null,
                    updated_at: null
                }
            });
        }

        res.json({ success: true, data: row });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

app.put('/api/passengers/me/accessibility', requireRole('passenger', 'admin'), async (req, res) => {
    try {
        const authRole = String(req.auth?.role || '').toLowerCase();
        const userId = authRole === 'passenger' ? req.auth?.uid : Number(req.body?.user_id);
        if (!userId) return res.status(400).json({ success: false, error: 'user_id is required' });

        const payload = req.body || {};
        const notes = payload.notes !== undefined && payload.notes !== null ? String(payload.notes) : null;
        if (notes !== null && notes.length > 800) {
            return res.status(400).json({ success: false, error: 'notes is too long' });
        }

        const voicePrompts = payload.voice_prompts !== undefined ? !!payload.voice_prompts : false;
        const textFirst = payload.text_first !== undefined ? !!payload.text_first : false;
        const noCalls = payload.no_calls !== undefined ? !!payload.no_calls : false;
        const wheelchair = payload.wheelchair !== undefined ? !!payload.wheelchair : false;
        const extraTime = payload.extra_time !== undefined ? !!payload.extra_time : false;
        const simpleLanguage = payload.simple_language !== undefined ? !!payload.simple_language : false;

        const upsert = await pool.query(
            `INSERT INTO passenger_accessibility_profiles (
                user_id, voice_prompts, text_first, no_calls, wheelchair, extra_time, simple_language, notes, created_at, updated_at
             ) VALUES ($1,$2,$3,$4,$5,$6,$7, NULLIF($8,''), CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
             ON CONFLICT (user_id) DO UPDATE SET
                voice_prompts = EXCLUDED.voice_prompts,
                text_first = EXCLUDED.text_first,
                no_calls = EXCLUDED.no_calls,
                wheelchair = EXCLUDED.wheelchair,
                extra_time = EXCLUDED.extra_time,
                simple_language = EXCLUDED.simple_language,
                notes = EXCLUDED.notes,
                updated_at = CURRENT_TIMESTAMP
             RETURNING user_id, voice_prompts, text_first, no_calls, wheelchair, extra_time, simple_language, notes, created_at, updated_at`,
            [userId, voicePrompts, textFirst, noCalls, wheelchair, extraTime, simpleLanguage, notes || '']
        );

        res.json({ success: true, data: upsert.rows[0] });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// --- Passenger Emergency Info Card (Opt-in, v2) ---

app.get('/api/passengers/me/emergency-profile', requireRole('passenger', 'admin'), async (req, res) => {
    try {
        const authRole = String(req.auth?.role || '').toLowerCase();
        const userId = authRole === 'passenger' ? req.auth?.uid : Number(req.query.user_id);
        if (!userId) return res.status(400).json({ success: false, error: 'user_id is required' });

        const result = await pool.query(
            `SELECT user_id, opt_in, contact_name, contact_channel, contact_value, medical_note, created_at, updated_at
             FROM passenger_emergency_profiles
             WHERE user_id = $1
             LIMIT 1`,
            [userId]
        );
        const row = result.rows[0] || null;
        if (!row) {
            return res.json({
                success: true,
                data: {
                    user_id: Number(userId),
                    opt_in: false,
                    contact_name: null,
                    contact_channel: 'phone',
                    contact_value: null,
                    medical_note: null,
                    created_at: null,
                    updated_at: null
                }
            });
        }
        res.json({ success: true, data: row });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

app.put('/api/passengers/me/emergency-profile', requireRole('passenger', 'admin'), async (req, res) => {
    try {
        const authRole = String(req.auth?.role || '').toLowerCase();
        const userId = authRole === 'passenger' ? req.auth?.uid : Number(req.body?.user_id);
        if (!userId) return res.status(400).json({ success: false, error: 'user_id is required' });

        const payload = req.body || {};
        const optIn = payload.opt_in !== undefined ? !!payload.opt_in : false;

        const contactName = payload.contact_name !== undefined && payload.contact_name !== null ? String(payload.contact_name) : '';
        const contactChannel = payload.contact_channel !== undefined && payload.contact_channel !== null ? String(payload.contact_channel).toLowerCase() : 'phone';
        const contactValue = payload.contact_value !== undefined && payload.contact_value !== null ? String(payload.contact_value) : '';
        const medicalNote = payload.medical_note !== undefined && payload.medical_note !== null ? String(payload.medical_note) : '';

        if (contactName.length > 120) return res.status(400).json({ success: false, error: 'contact_name is too long' });
        if (contactChannel.length > 20) return res.status(400).json({ success: false, error: 'contact_channel is too long' });
        if (contactValue.length > 200) return res.status(400).json({ success: false, error: 'contact_value is too long' });
        if (medicalNote.length > 400) return res.status(400).json({ success: false, error: 'medical_note is too long' });

        const normalizedChannel = ['phone', 'sms', 'email', 'whatsapp'].includes(contactChannel) ? contactChannel : 'phone';

        const upsert = await pool.query(
            `INSERT INTO passenger_emergency_profiles (
                user_id, opt_in, contact_name, contact_channel, contact_value, medical_note, created_at, updated_at
             ) VALUES ($1,$2, NULLIF($3,''), $4, NULLIF($5,''), NULLIF($6,''), CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
             ON CONFLICT (user_id) DO UPDATE SET
                opt_in = EXCLUDED.opt_in,
                contact_name = EXCLUDED.contact_name,
                contact_channel = EXCLUDED.contact_channel,
                contact_value = EXCLUDED.contact_value,
                medical_note = EXCLUDED.medical_note,
                updated_at = CURRENT_TIMESTAMP
             RETURNING user_id, opt_in, contact_name, contact_channel, contact_value, medical_note, created_at, updated_at`,
            [
                userId,
                optIn,
                optIn ? contactName : '',
                normalizedChannel,
                optIn ? contactValue : '',
                optIn ? medicalNote : ''
            ]
        );

        res.json({ success: true, data: upsert.rows[0] });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// --- Trip Messaging Board (v2) ---

const TRIP_MESSAGE_TEMPLATE_KEYS = new Set([
    'pickup',
    'accessibility',
    'location',
    'arrival',
    'wait',
    'other'
]);

app.get('/api/trips/:id/messages', requireAuth, async (req, res) => {
    try {
        const tripId = String(req.params.id);
        const tripRes = await pool.query('SELECT * FROM trips WHERE id = $1 LIMIT 1', [tripId]);
        const tripRow = tripRes.rows[0] || null;
        const authRole = String(req.auth?.role || '').toLowerCase();
        const authUserId = req.auth?.uid;
        const authDriverId = req.auth?.driver_id;
        const access = requireTripAccess({ tripRow, authRole, authUserId, authDriverId });
        if (!access.ok) return res.status(access.status).json({ success: false, error: access.error });

        const limit = Number.isFinite(Number(req.query.limit)) ? Math.min(Math.max(Number(req.query.limit), 1), 100) : 50;
        const msgs = await pool.query(
            `SELECT id, trip_id, sender_role, sender_user_id, sender_driver_id, template_key, message, created_at
             FROM trip_messages
             WHERE trip_id = $1
             ORDER BY created_at ASC
             LIMIT $2`,
            [tripId, limit]
        );
        res.json({ success: true, data: msgs.rows });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

app.post('/api/trips/:id/messages', requireAuth, async (req, res) => {
    try {
        const tripId = String(req.params.id);
        const tripRes = await pool.query('SELECT * FROM trips WHERE id = $1 LIMIT 1', [tripId]);
        const tripRow = tripRes.rows[0] || null;
        const authRole = String(req.auth?.role || '').toLowerCase();
        const authUserId = req.auth?.uid;
        const authDriverId = req.auth?.driver_id;
        const access = requireTripAccess({ tripRow, authRole, authUserId, authDriverId });
        if (!access.ok) return res.status(access.status).json({ success: false, error: access.error });

        const templateKeyRaw = req.body?.template_key !== undefined && req.body?.template_key !== null ? String(req.body.template_key) : '';
        const templateKey = templateKeyRaw ? templateKeyRaw.toLowerCase() : null;
        if (templateKey && !TRIP_MESSAGE_TEMPLATE_KEYS.has(templateKey)) {
            return res.status(400).json({ success: false, error: 'Invalid template_key' });
        }

        const messageRaw = req.body?.message !== undefined && req.body?.message !== null ? String(req.body.message) : '';
        const message = messageRaw.trim();
        if (!message) return res.status(400).json({ success: false, error: 'message is required' });
        if (message.length > 200) return res.status(400).json({ success: false, error: 'message is too long' });

        const senderRole = authRole || 'unknown';
        const senderUserId = senderRole === 'passenger' || senderRole === 'admin' ? (authUserId || null) : null;
        const senderDriverId = senderRole === 'driver' ? (authDriverId || null) : null;

        const insert = await pool.query(
            `INSERT INTO trip_messages (trip_id, sender_role, sender_user_id, sender_driver_id, template_key, message)
             VALUES ($1,$2,$3,$4, NULLIF($5,''), $6)
             RETURNING id, trip_id, sender_role, sender_user_id, sender_driver_id, template_key, message, created_at`,
            [tripId, senderRole, senderUserId, senderDriverId, templateKey || '', message]
        );

        try {
            io.to(tripRoom(tripId)).emit('trip_message', { trip_id: String(tripId), message: insert.rows[0] });
        } catch (e) {
            // ignore
        }

        res.status(201).json({ success: true, data: insert.rows[0] });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// --- Driver Accessibility Acknowledgement (v2) ---

app.post('/api/trips/:id/accessibility-ack', requireRole('driver', 'admin'), async (req, res) => {
    try {
        const tripId = String(req.params.id);
        const tripRes = await pool.query('SELECT * FROM trips WHERE id = $1 LIMIT 1', [tripId]);
        const tripRow = tripRes.rows[0] || null;
        if (!tripRow) return res.status(404).json({ success: false, error: 'Trip not found' });

        const authRole = String(req.auth?.role || '').toLowerCase();
        const authDriverId = req.auth?.driver_id;
        if (authRole === 'driver') {
            if (!authDriverId) return res.status(403).json({ success: false, error: 'Driver profile not linked to this account' });
            if (String(tripRow.driver_id || '') !== String(authDriverId)) {
                return res.status(403).json({ success: false, error: 'Forbidden' });
            }
        }

        const effectiveDriverId = authRole === 'driver'
            ? authDriverId
            : (req.body?.driver_id !== undefined && req.body?.driver_id !== null ? Number(req.body.driver_id) : (tripRow.driver_id ? Number(tripRow.driver_id) : null));

        const updated = await pool.query(
            `UPDATE trips
             SET accessibility_ack_at = COALESCE(accessibility_ack_at, CURRENT_TIMESTAMP),
                 accessibility_ack_by_driver_id = COALESCE(accessibility_ack_by_driver_id, $1),
                 updated_at = CURRENT_TIMESTAMP
             WHERE id = $2
             RETURNING id, accessibility_ack_at, accessibility_ack_by_driver_id, accessibility_snapshot_json, accessibility_snapshot_at`,
            [effectiveDriverId, tripId]
        );

        try {
            io.to(tripRoom(tripId)).emit('trip_accessibility_ack', {
                trip_id: String(tripId),
                ack: updated.rows[0]
            });

            if (tripRow?.user_id) {
                io.to(userRoom(tripRow.user_id)).emit('trip_accessibility_ack', {
                    trip_id: String(tripId),
                    ack: updated.rows[0]
                });
            }
        } catch (e) {
            // ignore
        }

        res.status(201).json({ success: true, data: updated.rows[0] });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// --- Accessibility Feedback (v2) ---

app.post('/api/trips/:id/accessibility-feedback', requireRole('passenger', 'admin'), async (req, res) => {
    try {
        const tripId = String(req.params.id);
        const tripRes = await pool.query('SELECT * FROM trips WHERE id = $1 LIMIT 1', [tripId]);
        const tripRow = tripRes.rows[0] || null;
        const authRole = String(req.auth?.role || '').toLowerCase();
        const authUserId = req.auth?.uid;
        const access = requireTripAccess({ tripRow, authRole, authUserId, authDriverId: null });
        if (!access.ok) return res.status(access.status).json({ success: false, error: access.error });

        const status = String(tripRow?.status || '').toLowerCase();
        const tripStatus = String(tripRow?.trip_status || '').toLowerCase();
        const isEnded = status === 'completed' || status === 'rated' || tripStatus === 'completed' || tripStatus === 'rated';
        if (!isEnded) {
            return res.status(409).json({ success: false, error: 'Trip is not completed yet' });
        }

        const respected = req.body?.respected;
        if (typeof respected !== 'boolean') {
            return res.status(400).json({ success: false, error: 'respected must be boolean' });
        }

        const reason = req.body?.reason !== undefined && req.body?.reason !== null ? String(req.body.reason).trim() : '';
        if (reason.length > 300) return res.status(400).json({ success: false, error: 'reason is too long' });

        const userId = authRole === 'passenger' ? authUserId : (req.body?.user_id !== undefined && req.body?.user_id !== null ? Number(req.body.user_id) : authUserId);
        if (!userId) return res.status(400).json({ success: false, error: 'user_id is required' });

        const upsert = await pool.query(
            `INSERT INTO trip_accessibility_feedback (trip_id, user_id, respected, reason)
             VALUES ($1,$2,$3, NULLIF($4,''))
             ON CONFLICT (trip_id, user_id) DO UPDATE SET
                respected = EXCLUDED.respected,
                reason = EXCLUDED.reason
             RETURNING id, trip_id, user_id, respected, reason, created_at`,
            [tripId, userId, respected, reason]
        );

        res.status(201).json({ success: true, data: upsert.rows[0] });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

app.post('/api/admin/pickup-hubs', requireRole('admin'), async (req, res) => {
    try {
        const { title, category = null, lat, lng, is_active = true } = req.body || {};
        const latitude = Number(lat);
        const longitude = Number(lng);
        if (!title || !Number.isFinite(latitude) || !Number.isFinite(longitude)) {
            return res.status(400).json({ success: false, error: 'title, lat, lng are required' });
        }
        const insert = await pool.query(
            `INSERT INTO pickup_hubs (title, category, lat, lng, is_active)
             VALUES ($1, NULLIF($2, ''), $3, $4, $5)
             RETURNING *`,
            [String(title), category !== null && category !== undefined ? String(category) : '', latitude, longitude, !!is_active]
        );
        res.status(201).json({ success: true, data: insert.rows[0] });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// Driver suggests alternative pickup hub/location; passenger accepts/rejects
app.post('/api/trips/:id/pickup-suggestions', requireRole('driver', 'admin'), async (req, res) => {
    try {
        const tripId = String(req.params.id);
        const { hub_id, suggested_title, suggested_lat, suggested_lng } = req.body || {};

        const hubId = hub_id !== undefined && hub_id !== null ? Number(hub_id) : null;
        const lat = suggested_lat !== undefined && suggested_lat !== null ? Number(suggested_lat) : null;
        const lng = suggested_lng !== undefined && suggested_lng !== null ? Number(suggested_lng) : null;

        if (!hubId && (!Number.isFinite(lat) || !Number.isFinite(lng))) {
            return res.status(400).json({ success: false, error: 'hub_id or suggested_lat/suggested_lng is required' });
        }

        const tripRes = await pool.query('SELECT id, user_id, driver_id FROM trips WHERE id = $1 LIMIT 1', [tripId]);
        const tripRow = tripRes.rows[0] || null;

        const authRole = String(req.auth?.role || '').toLowerCase();
        const authDriverId = req.auth?.driver_id;
        if (authRole === 'driver') {
            if (!authDriverId) return res.status(403).json({ success: false, error: 'Driver profile not linked to this account' });
            if (String(tripRow?.driver_id || '') !== String(authDriverId)) {
                return res.status(403).json({ success: false, error: 'Forbidden' });
            }
        }

        let hubData = null;
        if (hubId) {
            const hub = await pool.query('SELECT id, title, lat, lng FROM pickup_hubs WHERE id = $1 AND is_active = true LIMIT 1', [hubId]);
            hubData = hub.rows[0] || null;
            if (!hubData) {
                return res.status(404).json({ success: false, error: 'Hub not found' });
            }
        }

        const insert = await pool.query(
            `INSERT INTO trip_pickup_suggestions (
                trip_id, suggested_by_role, suggested_by_driver_id, hub_id, suggested_title, suggested_lat, suggested_lng
             ) VALUES ($1, $2, $3, $4, NULLIF($5, ''), $6, $7)
             RETURNING *`,
            [
                tripId,
                String(req.auth?.role || 'driver'),
                authDriverId || null,
                hubData ? hubData.id : null,
                hubData ? hubData.title : (suggested_title !== undefined && suggested_title !== null ? String(suggested_title) : ''),
                hubData ? Number(hubData.lat) : lat,
                hubData ? Number(hubData.lng) : lng
            ]
        );

        try {
            io.to(tripRoom(tripId)).emit('pickup_suggestion_created', { trip_id: String(tripId), suggestion: insert.rows[0] });
        } catch (e) {
            // ignore
        }

        res.status(201).json({ success: true, data: insert.rows[0] });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

app.get('/api/trips/:id/pickup-suggestions', requireAuth, async (req, res) => {
    try {
        const tripId = String(req.params.id);
        const tripRes = await pool.query('SELECT * FROM trips WHERE id = $1 LIMIT 1', [tripId]);
        const tripRow = tripRes.rows[0] || null;

        const authRole = String(req.auth?.role || '').toLowerCase();
        const authUserId = req.auth?.uid;
        const authDriverId = req.auth?.driver_id;
        const access = requireTripAccess({ tripRow, authRole, authUserId, authDriverId });
        if (!access.ok) return res.status(access.status).json({ success: false, error: access.error });

        const result = await pool.query(
            `SELECT s.*,
                    h.title AS hub_title,
                    h.category AS hub_category
             FROM trip_pickup_suggestions s
             LEFT JOIN pickup_hubs h ON h.id = s.hub_id
             WHERE s.trip_id = $1
             ORDER BY s.created_at DESC
             LIMIT 20`,
            [tripId]
        );
        res.json({ success: true, data: result.rows });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

app.patch('/api/trips/:id/pickup-suggestions/:sid/decision', requireRole('passenger', 'admin'), async (req, res) => {
    const client = await pool.connect();
    try {
        const tripId = String(req.params.id);
        const suggestionId = Number(req.params.sid);
        const decision = String(req.body?.decision || '').toLowerCase();
        if (!Number.isFinite(suggestionId) || suggestionId <= 0) {
            return res.status(400).json({ success: false, error: 'Invalid suggestion id' });
        }
        if (!['accepted', 'rejected'].includes(decision)) {
            return res.status(400).json({ success: false, error: "decision must be 'accepted' or 'rejected'" });
        }

        await client.query('BEGIN');
        const tripRes = await client.query('SELECT * FROM trips WHERE id = $1 LIMIT 1 FOR UPDATE', [tripId]);
        const tripRow = tripRes.rows[0] || null;

        const authRole = String(req.auth?.role || '').toLowerCase();
        const authUserId = req.auth?.uid;
        const access = requireTripAccess({ tripRow, authRole, authUserId, authDriverId: null });
        if (!access.ok) {
            await client.query('ROLLBACK');
            return res.status(access.status).json({ success: false, error: access.error });
        }

        const sugRes = await client.query(
            `SELECT * FROM trip_pickup_suggestions
             WHERE id = $1 AND trip_id = $2
             LIMIT 1
             FOR UPDATE`,
            [suggestionId, tripId]
        );
        const suggestion = sugRes.rows[0] || null;
        if (!suggestion) {
            await client.query('ROLLBACK');
            return res.status(404).json({ success: false, error: 'Suggestion not found' });
        }
        if (suggestion.status !== 'pending') {
            await client.query('ROLLBACK');
            return res.status(409).json({ success: false, error: 'Suggestion already decided' });
        }

        const updatedSug = await client.query(
            `UPDATE trip_pickup_suggestions
             SET status = $1,
                 passenger_decision_at = CURRENT_TIMESTAMP
             WHERE id = $2
             RETURNING *`,
            [decision, suggestionId]
        );

        let updatedTrip = tripRow;
        if (decision === 'accepted') {
            const newLat = suggestion.suggested_lat !== null && suggestion.suggested_lat !== undefined ? Number(suggestion.suggested_lat) : null;
            const newLng = suggestion.suggested_lng !== null && suggestion.suggested_lng !== undefined ? Number(suggestion.suggested_lng) : null;
            if (Number.isFinite(newLat) && Number.isFinite(newLng)) {
                const title = suggestion.suggested_title ? String(suggestion.suggested_title) : tripRow.pickup_location;
                const updateTripRes = await client.query(
                    `UPDATE trips
                     SET pickup_lat = $1,
                         pickup_lng = $2,
                         pickup_location = $3,
                         pickup_hub_id = $4,
                         updated_at = CURRENT_TIMESTAMP
                     WHERE id = $5
                     RETURNING *`,
                    [newLat, newLng, title, suggestion.hub_id || null, tripId]
                );
                updatedTrip = updateTripRes.rows[0] || updatedTrip;

                // Keep pending_ride_requests in sync (if still waiting)
                try {
                    await client.query(
                        `UPDATE pending_ride_requests
                         SET pickup_lat = $1,
                             pickup_lng = $2,
                             pickup_location = $3,
                             updated_at = CURRENT_TIMESTAMP
                         WHERE trip_id = $4
                           AND status IN ('waiting', 'accepted')`,
                        [newLat, newLng, title, tripId]
                    );
                } catch (e) {
                    // non-blocking
                }
            }
        }

        await client.query('COMMIT');

        try {
            io.to(tripRoom(tripId)).emit('pickup_suggestion_decided', {
                trip_id: String(tripId),
                suggestion_id: suggestionId,
                decision,
                trip: updatedTrip
            });
        } catch (e) {
            // ignore
        }

        res.json({ success: true, data: updatedSug.rows[0], trip: updatedTrip });
    } catch (err) {
        try {
            await client.query('ROLLBACK');
        } catch (e) {
            // ignore
        }
        res.status(500).json({ success: false, error: err.message });
    } finally {
        client.release();
    }
});

// --- ETA + delay reason ---

app.get('/api/trips/:id/eta', requireAuth, async (req, res) => {
    try {
        const tripId = String(req.params.id);
        const tripRes = await pool.query('SELECT * FROM trips WHERE id = $1 LIMIT 1', [tripId]);
        const tripRow = tripRes.rows[0] || null;
        const authRole = String(req.auth?.role || '').toLowerCase();
        const authUserId = req.auth?.uid;
        const authDriverId = req.auth?.driver_id;
        const access = requireTripAccess({ tripRow, authRole, authUserId, authDriverId });
        if (!access.ok) return res.status(access.status).json({ success: false, error: access.error });

        res.json({
            success: true,
            data: {
                trip_id: String(tripId),
                eta_minutes: tripRow.eta_minutes !== null && tripRow.eta_minutes !== undefined ? Number(tripRow.eta_minutes) : null,
                eta_reason: tripRow.eta_reason || null,
                eta_updated_at: tripRow.eta_updated_at || null
            }
        });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

app.patch('/api/trips/:id/eta', requireRole('driver', 'admin'), async (req, res) => {
    try {
        const tripId = String(req.params.id);
        const { eta_minutes, eta_reason } = req.body || {};
        const eta = eta_minutes !== undefined && eta_minutes !== null ? Number(eta_minutes) : null;
        if (eta !== null && (!Number.isFinite(eta) || eta < 0 || eta > 360)) {
            return res.status(400).json({ success: false, error: 'eta_minutes must be a valid number of minutes' });
        }

        const tripRes = await pool.query('SELECT * FROM trips WHERE id = $1 LIMIT 1', [tripId]);
        const tripRow = tripRes.rows[0] || null;
        const authRole = String(req.auth?.role || '').toLowerCase();
        const authDriverId = req.auth?.driver_id;
        if (authRole === 'driver') {
            if (!authDriverId) return res.status(403).json({ success: false, error: 'Driver profile not linked to this account' });
            if (String(tripRow?.driver_id || '') !== String(authDriverId)) {
                return res.status(403).json({ success: false, error: 'Forbidden' });
            }
        }

        const updated = await pool.query(
            `UPDATE trips
             SET eta_minutes = $1,
                 eta_reason = NULLIF($2, ''),
                 eta_updated_at = CURRENT_TIMESTAMP,
                 updated_at = CURRENT_TIMESTAMP
             WHERE id = $3
             RETURNING id, eta_minutes, eta_reason, eta_updated_at`,
            [eta, eta_reason !== undefined && eta_reason !== null ? String(eta_reason) : '', tripId]
        );

        try {
            io.to(tripRoom(tripId)).emit('trip_eta_update', { trip_id: String(tripId), ...updated.rows[0] });
        } catch (e) {
            // ignore
        }

        res.json({ success: true, data: updated.rows[0] });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// --- Favorite captain ---

app.get('/api/passengers/me/favorites', requireRole('passenger', 'admin'), async (req, res) => {
    try {
        const authRole = String(req.auth?.role || '').toLowerCase();
        const userId = authRole === 'passenger' ? req.auth?.uid : Number(req.query.user_id);
        if (!userId) return res.status(400).json({ success: false, error: 'user_id is required' });

        const result = await pool.query(
            `SELECT f.driver_id, f.created_at, d.name, d.phone, d.email, d.car_type, d.rating, d.total_trips
             FROM passenger_favorite_drivers f
             JOIN drivers d ON d.id = f.driver_id
             WHERE f.user_id = $1
             ORDER BY f.created_at DESC`,
            [userId]
        );
        res.json({ success: true, data: result.rows });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

app.post('/api/passengers/me/favorites', requireRole('passenger', 'admin'), async (req, res) => {
    try {
        const authRole = String(req.auth?.role || '').toLowerCase();
        const userId = authRole === 'passenger' ? req.auth?.uid : Number(req.body?.user_id);
        const driverId = Number(req.body?.driver_id);
        if (!userId || !Number.isFinite(driverId) || driverId <= 0) {
            return res.status(400).json({ success: false, error: 'driver_id is required' });
        }

        await pool.query(
            `INSERT INTO passenger_favorite_drivers (user_id, driver_id)
             VALUES ($1, $2)
             ON CONFLICT (user_id, driver_id) DO NOTHING`,
            [userId, driverId]
        );

        res.status(201).json({ success: true });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

app.delete('/api/passengers/me/favorites/:driverId', requireRole('passenger', 'admin'), async (req, res) => {
    try {
        const authRole = String(req.auth?.role || '').toLowerCase();
        const userId = authRole === 'passenger' ? req.auth?.uid : Number(req.query.user_id);
        const driverId = Number(req.params.driverId);
        if (!userId || !Number.isFinite(driverId) || driverId <= 0) {
            return res.status(400).json({ success: false, error: 'Invalid request' });
        }

        await pool.query('DELETE FROM passenger_favorite_drivers WHERE user_id = $1 AND driver_id = $2', [userId, driverId]);
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// --- Passenger note templates ---

app.get('/api/passengers/me/note-templates', requireRole('passenger', 'admin'), async (req, res) => {
    try {
        const authRole = String(req.auth?.role || '').toLowerCase();
        const userId = authRole === 'passenger' ? req.auth?.uid : Number(req.query.user_id);
        if (!userId) return res.status(400).json({ success: false, error: 'user_id is required' });
        const result = await pool.query(
            `SELECT id, title, note, created_at
             FROM passenger_note_templates
             WHERE user_id = $1
             ORDER BY created_at DESC
             LIMIT 50`,
            [userId]
        );
        res.json({ success: true, data: result.rows });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

app.post('/api/passengers/me/note-templates', requireRole('passenger', 'admin'), async (req, res) => {
    try {
        const authRole = String(req.auth?.role || '').toLowerCase();
        const userId = authRole === 'passenger' ? req.auth?.uid : Number(req.body?.user_id);
        const { title = null, note } = req.body || {};
        if (!userId || !note) return res.status(400).json({ success: false, error: 'note is required' });

        const insert = await pool.query(
            `INSERT INTO passenger_note_templates (user_id, title, note)
             VALUES ($1, NULLIF($2, ''), $3)
             RETURNING id, title, note, created_at`,
            [userId, title !== null && title !== undefined ? String(title) : '', String(note)]
        );
        res.status(201).json({ success: true, data: insert.rows[0] });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

app.delete('/api/passengers/me/note-templates/:id', requireRole('passenger', 'admin'), async (req, res) => {
    try {
        const templateId = Number(req.params.id);
        const authRole = String(req.auth?.role || '').toLowerCase();
        const userId = authRole === 'passenger' ? req.auth?.uid : Number(req.query.user_id);
        if (!userId || !Number.isFinite(templateId) || templateId <= 0) {
            return res.status(400).json({ success: false, error: 'Invalid request' });
        }
        await pool.query('DELETE FROM passenger_note_templates WHERE id = $1 AND user_id = $2', [templateId, userId]);
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// --- Loyalty tiers ---

app.get('/api/passengers/me/loyalty', requireRole('passenger', 'admin'), async (req, res) => {
    try {
        const authRole = String(req.auth?.role || '').toLowerCase();
        const userId = authRole === 'passenger' ? req.auth?.uid : Number(req.query.user_id);
        if (!userId) return res.status(400).json({ success: false, error: 'user_id is required' });

        // Ensure row exists
        await pool.query(
            `INSERT INTO passenger_loyalty_stats (user_id)
             VALUES ($1)
             ON CONFLICT (user_id) DO NOTHING`,
            [userId]
        );

        // Recompute quickly from canonical trips (keeps accuracy even if server restarted)
        const completedRes = await pool.query(
            `SELECT COUNT(*)::int AS count
             FROM trips
             WHERE COALESCE(rider_id, user_id) = $1
               AND status = 'completed'`,
            [userId]
        );
        const cancelledRes = await pool.query(
            `SELECT COUNT(*)::int AS count
             FROM trips
             WHERE COALESCE(rider_id, user_id) = $1
               AND status = 'cancelled'`,
            [userId]
        );
        const hubRes = await pool.query(
            `SELECT COUNT(*)::int AS count
             FROM trips
             WHERE COALESCE(rider_id, user_id) = $1
               AND status = 'completed'
               AND pickup_hub_id IS NOT NULL`,
            [userId]
        );

        const completedTrips = completedRes.rows[0]?.count || 0;
        const cancelledTrips = cancelledRes.rows[0]?.count || 0;
        const hubComplianceTrips = hubRes.rows[0]?.count || 0;

        await pool.query(
            `UPDATE passenger_loyalty_stats
             SET completed_trips = $2,
                 cancelled_trips = $3,
                 hub_compliance_trips = $4,
                 updated_at = CURRENT_TIMESTAMP
             WHERE user_id = $1`,
            [userId, completedTrips, cancelledTrips, hubComplianceTrips]
        );

        const tierInfo = getLoyaltyTier({ completedTrips, cancelledTrips, hubComplianceTrips });
        res.json({
            success: true,
            data: {
                user_id: userId,
                completed_trips: completedTrips,
                cancelled_trips: cancelledTrips,
                hub_compliance_trips: hubComplianceTrips,
                ...tierInfo
            }
        });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// ==================== SAFETY & TRUST ====================

// --- Basic verification (email/phone) ---

app.post('/api/users/me/verify/email/request', requireAuth, async (req, res) => {
    try {
        const authUserId = req.auth?.uid;
        if (!authUserId) return res.status(401).json({ success: false, error: 'Unauthorized' });

        const userRes = await pool.query('SELECT id, email, email_verified_at FROM users WHERE id = $1 LIMIT 1', [authUserId]);
        const user = userRes.rows[0] || null;
        if (!user) return res.status(404).json({ success: false, error: 'User not found' });
        if (!user.email) return res.status(400).json({ success: false, error: 'Email is required' });

        const token = crypto.randomBytes(16).toString('hex');
        const expiresAt = new Date(Date.now() + 30 * 60 * 1000);
        await pool.query(
            `INSERT INTO user_verification_tokens (user_id, token_type, token, expires_at)
             VALUES ($1,'email',$2,$3)`,
            [authUserId, token, expiresAt]
        );

        // Dev/MVP: return token directly (replace with email sending later)
        res.status(201).json({ success: true, data: { token, expires_at: expiresAt } });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

app.post('/api/users/me/verify/email/confirm', requireAuth, async (req, res) => {
    try {
        const authUserId = req.auth?.uid;
        const token = String(req.body?.token || '').trim();
        if (!authUserId) return res.status(401).json({ success: false, error: 'Unauthorized' });
        if (!token) return res.status(400).json({ success: false, error: 'token is required' });

        const tokRes = await pool.query(
            `SELECT id, expires_at, consumed_at
             FROM user_verification_tokens
             WHERE user_id = $1 AND token_type = 'email' AND token = $2
             ORDER BY created_at DESC
             LIMIT 1`,
            [authUserId, token]
        );
        const row = tokRes.rows[0] || null;
        if (!row) return res.status(400).json({ success: false, error: 'Invalid token' });
        if (row.consumed_at) return res.status(409).json({ success: false, error: 'Token already used' });
        if (row.expires_at && new Date(row.expires_at).getTime() < Date.now()) {
            return res.status(410).json({ success: false, error: 'Token expired' });
        }

        await pool.query('UPDATE user_verification_tokens SET consumed_at = CURRENT_TIMESTAMP WHERE id = $1', [row.id]);
        await pool.query('UPDATE users SET email_verified_at = CURRENT_TIMESTAMP WHERE id = $1', [authUserId]);
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

app.post('/api/users/me/verify/phone/request', requireAuth, async (req, res) => {
    try {
        const authUserId = req.auth?.uid;
        if (!authUserId) return res.status(401).json({ success: false, error: 'Unauthorized' });

        const userRes = await pool.query('SELECT id, phone FROM users WHERE id = $1 LIMIT 1', [authUserId]);
        const user = userRes.rows[0] || null;
        if (!user) return res.status(404).json({ success: false, error: 'User not found' });
        if (!user.phone) return res.status(400).json({ success: false, error: 'Phone is required' });

        const otp = String(Math.floor(Math.random() * 900000) + 100000);
        const expiresAt = new Date(Date.now() + 10 * 60 * 1000);
        await pool.query(
            `INSERT INTO user_verification_tokens (user_id, token_type, token, expires_at)
             VALUES ($1,'phone',$2,$3)`,
            [authUserId, otp, expiresAt]
        );

        // Dev/MVP: return otp directly (replace with SMS sending later)
        res.status(201).json({ success: true, data: { otp, expires_at: expiresAt } });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

app.post('/api/users/me/verify/phone/confirm', requireAuth, async (req, res) => {
    try {
        const authUserId = req.auth?.uid;
        const otp = String(req.body?.otp || '').trim();
        if (!authUserId) return res.status(401).json({ success: false, error: 'Unauthorized' });
        if (!otp) return res.status(400).json({ success: false, error: 'otp is required' });

        const tokRes = await pool.query(
            `SELECT id, expires_at, consumed_at
             FROM user_verification_tokens
             WHERE user_id = $1 AND token_type = 'phone' AND token = $2
             ORDER BY created_at DESC
             LIMIT 1`,
            [authUserId, otp]
        );
        const row = tokRes.rows[0] || null;
        if (!row) return res.status(400).json({ success: false, error: 'Invalid otp' });
        if (row.consumed_at) return res.status(409).json({ success: false, error: 'OTP already used' });
        if (row.expires_at && new Date(row.expires_at).getTime() < Date.now()) {
            return res.status(410).json({ success: false, error: 'OTP expired' });
        }

        await pool.query('UPDATE user_verification_tokens SET consumed_at = CURRENT_TIMESTAMP WHERE id = $1', [row.id]);
        await pool.query('UPDATE users SET phone_verified_at = CURRENT_TIMESTAMP WHERE id = $1', [authUserId]);
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// --- Strong verification (opt-in) ---

app.get('/api/passengers/me/verification/status', requireRole('passenger', 'admin'), async (req, res) => {
    try {
        const authRole = String(req.auth?.role || '').toLowerCase();
        const userId = authRole === 'passenger' ? req.auth?.uid : Number(req.query.user_id);
        if (!userId) return res.status(400).json({ success: false, error: 'user_id is required' });

        const userRes = await pool.query(
            `SELECT id, email, phone, email_verified_at, phone_verified_at
             FROM users WHERE id = $1 LIMIT 1`,
            [userId]
        );
        const user = userRes.rows[0] || null;
        if (!user) return res.status(404).json({ success: false, error: 'User not found' });

        const strongRes = await pool.query(
            `SELECT id, level, status, submitted_at, reviewed_at, reviewed_by, reject_reason
             FROM passenger_verifications
             WHERE user_id = $1
             ORDER BY submitted_at DESC
             LIMIT 1`,
            [userId]
        );
        const strong = strongRes.rows[0] || null;

        const verifiedLevel = computePassengerVerifiedLevel({
            email_verified_at: user.email_verified_at,
            phone_verified_at: user.phone_verified_at,
            strong_verification_status: strong?.status
        });

        res.json({
            success: true,
            data: {
                user_id: userId,
                verified_level: verifiedLevel,
                basic: {
                    email_verified_at: user.email_verified_at || null,
                    phone_verified_at: user.phone_verified_at || null
                },
                strong: strong
                    ? {
                        id: strong.id,
                        level: strong.level,
                        status: strong.status,
                        submitted_at: strong.submitted_at,
                        reviewed_at: strong.reviewed_at,
                        reviewed_by: strong.reviewed_by,
                        reject_reason: strong.reject_reason || null
                    }
                    : null
            }
        });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

app.post('/api/passengers/me/verification/request', requireRole('passenger', 'admin'), async (req, res) => {
    try {
        const authRole = String(req.auth?.role || '').toLowerCase();
        const userId = authRole === 'passenger' ? req.auth?.uid : Number(req.body?.user_id);
        const level = String(req.body?.level || 'strong').toLowerCase();
        if (!userId) return res.status(400).json({ success: false, error: 'user_id is required' });
        if (!['strong', 'basic'].includes(level)) {
            return res.status(400).json({ success: false, error: 'level must be basic or strong' });
        }

        const insert = await pool.query(
            `INSERT INTO passenger_verifications (user_id, level, status)
             VALUES ($1, $2, 'pending')
             RETURNING id, user_id, level, status, submitted_at`,
            [userId, level]
        );
        res.status(201).json({ success: true, data: insert.rows[0] });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

app.post(
    '/api/passengers/me/verification/upload',
    requireRole('passenger', 'admin'),
    secureUpload.fields([
        { name: 'id_document', maxCount: 1 },
        { name: 'selfie', maxCount: 1 }
    ]),
    async (req, res) => {
        try {
            const authRole = String(req.auth?.role || '').toLowerCase();
            const userId = authRole === 'passenger' ? req.auth?.uid : Number(req.body?.user_id);
            if (!userId) return res.status(400).json({ success: false, error: 'user_id is required' });

            const verificationId = req.body?.verification_id ? Number(req.body.verification_id) : null;
            let target = null;

            if (verificationId) {
                const v = await pool.query(
                    `SELECT id, user_id, status FROM passenger_verifications WHERE id = $1 LIMIT 1`,
                    [verificationId]
                );
                target = v.rows[0] || null;
                if (!target) return res.status(404).json({ success: false, error: 'Verification not found' });
                if (String(target.user_id) !== String(userId)) {
                    return res.status(403).json({ success: false, error: 'Forbidden' });
                }
            } else {
                const v = await pool.query(
                    `SELECT id, user_id, status
                     FROM passenger_verifications
                     WHERE user_id = $1
                     ORDER BY submitted_at DESC
                     LIMIT 1`,
                    [userId]
                );
                target = v.rows[0] || null;
                if (!target) return res.status(404).json({ success: false, error: 'No verification request found' });
            }

            if (String(target.status || '').toLowerCase() !== 'pending') {
                return res.status(409).json({ success: false, error: 'Verification is not pending' });
            }

            const idDoc = req.files?.id_document?.[0] || null;
            const selfie = req.files?.selfie?.[0] || null;
            if (!idDoc && !selfie) {
                return res.status(400).json({ success: false, error: 'No files uploaded' });
            }

            const idPath = idDoc ? idDoc.path : null;
            const selfiePath = selfie ? selfie.path : null;

            const updated = await pool.query(
                `UPDATE passenger_verifications
                 SET id_document_path = COALESCE($2, id_document_path),
                     selfie_path = COALESCE($3, selfie_path)
                 WHERE id = $1
                 RETURNING id, user_id, level, status, submitted_at`,
                [target.id, idPath, selfiePath]
            );

            res.json({ success: true, data: updated.rows[0] });
        } catch (err) {
            res.status(500).json({ success: false, error: err.message });
        }
    }
);

// Admin review
app.get('/api/admin/passenger-verifications', requireRole('admin'), async (req, res) => {
    try {
        const status = req.query?.status ? String(req.query.status).toLowerCase() : 'pending';
        const allowed = new Set(['pending', 'approved', 'rejected']);
        const effective = allowed.has(status) ? status : 'pending';

        const result = await pool.query(
            `SELECT pv.id, pv.user_id, pv.level, pv.status, pv.submitted_at, pv.reviewed_at, pv.reviewed_by, pv.reject_reason,
                    u.name AS user_name, u.email AS user_email, u.phone AS user_phone
             FROM passenger_verifications pv
             LEFT JOIN users u ON u.id = pv.user_id
             WHERE pv.status = $1
             ORDER BY pv.submitted_at ASC
             LIMIT 200`,
            [effective]
        );

        res.json({ success: true, count: result.rows.length, data: result.rows });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

app.patch('/api/admin/passenger-verifications/:id', requireRole('admin'), async (req, res) => {
    try {
        const id = Number(req.params.id);
        const nextStatus = String(req.body?.status || '').toLowerCase();
        const rejectReason = req.body?.reject_reason !== undefined && req.body?.reject_reason !== null ? String(req.body.reject_reason) : null;
        if (!Number.isFinite(id) || id <= 0) return res.status(400).json({ success: false, error: 'Invalid id' });
        if (!['approved', 'rejected'].includes(nextStatus)) {
            return res.status(400).json({ success: false, error: 'status must be approved or rejected' });
        }

        const updated = await pool.query(
            `UPDATE passenger_verifications
             SET status = $2::varchar,
                 reviewed_at = CURRENT_TIMESTAMP,
                 reviewed_by = $3,
                 reject_reason = CASE WHEN $2::varchar = 'rejected' THEN NULLIF($4,'') ELSE NULL END
             WHERE id = $1
             RETURNING id, user_id, level, status, submitted_at, reviewed_at, reviewed_by, reject_reason`,
            [id, nextStatus, req.auth?.uid || null, rejectReason || '']
        );

        if (updated.rows.length === 0) return res.status(404).json({ success: false, error: 'Not found' });
        res.json({ success: true, data: updated.rows[0] });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

app.get('/api/admin/passenger-verifications/:id/file/:kind', requireRole('admin'), async (req, res) => {
    try {
        const id = Number(req.params.id);
        const kind = String(req.params.kind || '').toLowerCase();
        if (!Number.isFinite(id) || id <= 0) return res.status(400).json({ success: false, error: 'Invalid id' });
        if (!['id_document', 'selfie'].includes(kind)) {
            return res.status(400).json({ success: false, error: 'Invalid kind' });
        }

        const rowRes = await pool.query(
            `SELECT id_document_path, selfie_path
             FROM passenger_verifications
             WHERE id = $1
             LIMIT 1`,
            [id]
        );
        const row = rowRes.rows[0] || null;
        if (!row) return res.status(404).json({ success: false, error: 'Not found' });
        const filePath = kind === 'id_document' ? row.id_document_path : row.selfie_path;
        if (!filePath) return res.status(404).json({ success: false, error: 'File not found' });

        const resolved = path.resolve(filePath);
        const base = path.resolve(secureUploadsDir);
        if (!resolved.startsWith(base)) {
            return res.status(400).json({ success: false, error: 'Invalid file path' });
        }
        if (!fs.existsSync(resolved)) {
            return res.status(404).json({ success: false, error: 'File missing on disk' });
        }

        res.sendFile(resolved);
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// --- Trusted contacts (Guardian) ---

app.get('/api/passengers/me/trusted-contacts', requireRole('passenger', 'admin'), async (req, res) => {
    try {
        const authRole = String(req.auth?.role || '').toLowerCase();
        const userId = authRole === 'passenger' ? req.auth?.uid : Number(req.query.user_id);
        if (!userId) return res.status(400).json({ success: false, error: 'user_id is required' });

        const result = await pool.query(
            `SELECT id, name, channel, value, created_at
             FROM passenger_trusted_contacts
             WHERE user_id = $1
             ORDER BY created_at DESC
             LIMIT 100`,
            [userId]
        );
        res.json({ success: true, data: result.rows, count: result.rows.length });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

app.post('/api/passengers/me/trusted-contacts', requireRole('passenger', 'admin'), async (req, res) => {
    try {
        const authRole = String(req.auth?.role || '').toLowerCase();
        const userId = authRole === 'passenger' ? req.auth?.uid : Number(req.body?.user_id);
        const name = String(req.body?.name || '').trim();
        const channel = String(req.body?.channel || 'whatsapp').trim().toLowerCase();
        const value = String(req.body?.value || '').trim();
        if (!userId) return res.status(400).json({ success: false, error: 'user_id is required' });
        if (!name || !value) return res.status(400).json({ success: false, error: 'name and value are required' });
        if (!['whatsapp', 'email', 'sms'].includes(channel)) {
            return res.status(400).json({ success: false, error: 'channel must be whatsapp/email/sms' });
        }

        const insert = await pool.query(
            `INSERT INTO passenger_trusted_contacts (user_id, name, channel, value)
             VALUES ($1,$2,$3,$4)
             RETURNING id, name, channel, value, created_at`,
            [userId, name, channel, value]
        );
        res.status(201).json({ success: true, data: insert.rows[0] });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

app.delete('/api/passengers/me/trusted-contacts/:id', requireRole('passenger', 'admin'), async (req, res) => {
    try {
        const contactId = Number(req.params.id);
        const authRole = String(req.auth?.role || '').toLowerCase();
        const userId = authRole === 'passenger' ? req.auth?.uid : Number(req.query.user_id);
        if (!userId || !Number.isFinite(contactId) || contactId <= 0) {
            return res.status(400).json({ success: false, error: 'Invalid request' });
        }

        await pool.query('DELETE FROM passenger_trusted_contacts WHERE id = $1 AND user_id = $2', [contactId, userId]);
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// --- Guardian check-in (schedule + confirm) ---

app.post('/api/trips/:id/guardian/checkin', requireRole('passenger', 'admin'), async (req, res) => {
    try {
        const tripId = String(req.params.id);
        const tripRes = await pool.query('SELECT * FROM trips WHERE id = $1 LIMIT 1', [tripId]);
        const tripRow = tripRes.rows[0] || null;

        const authRole = String(req.auth?.role || '').toLowerCase();
        const authUserId = req.auth?.uid;
        const userId = authRole === 'passenger' ? authUserId : Number(tripRow?.user_id);
        const access = requireTripAccess({ tripRow, authRole, authUserId, authDriverId: null });
        if (!access.ok) return res.status(access.status).json({ success: false, error: access.error });

        const minutesFromNowRaw = req.body?.minutes_from_now !== undefined && req.body?.minutes_from_now !== null ? Number(req.body.minutes_from_now) : null;
        const dueAtRaw = req.body?.due_at ? new Date(req.body.due_at) : null;

        let dueAt = null;
        if (dueAtRaw && !isNaN(dueAtRaw.getTime())) {
            dueAt = dueAtRaw;
        } else {
            const mins = minutesFromNowRaw !== null ? minutesFromNowRaw : 15;
            if (!Number.isFinite(mins) || mins < 1 || mins > 24 * 60) {
                return res.status(400).json({ success: false, error: 'minutes_from_now must be between 1 and 1440' });
            }
            dueAt = new Date(Date.now() + mins * 60 * 1000);
        }

        const insert = await pool.query(
            `INSERT INTO trip_guardian_checkins (trip_id, user_id, due_at, status)
             VALUES ($1,$2,$3,'scheduled')
             RETURNING id, trip_id, user_id, due_at, status, created_at`,
            [tripId, userId, dueAt]
        );

        try {
            await pool.query(
                `INSERT INTO trip_safety_events (trip_id, created_by_role, created_by_user_id, event_type, message)
                 VALUES ($1,$2,$3,'guardian_checkin_scheduled',NULL)`,
                [tripId, 'passenger', userId]
            );
        } catch (e) {
            // ignore
        }

        res.status(201).json({ success: true, data: insert.rows[0] });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

app.post('/api/trips/:id/guardian/confirm', requireRole('passenger', 'admin'), async (req, res) => {
    try {
        const tripId = String(req.params.id);
        const tripRes = await pool.query('SELECT * FROM trips WHERE id = $1 LIMIT 1', [tripId]);
        const tripRow = tripRes.rows[0] || null;

        const authRole = String(req.auth?.role || '').toLowerCase();
        const authUserId = req.auth?.uid;
        const userId = authRole === 'passenger' ? authUserId : Number(tripRow?.user_id);
        const access = requireTripAccess({ tripRow, authRole, authUserId, authDriverId: null });
        if (!access.ok) return res.status(access.status).json({ success: false, error: access.error });

        const updated = await pool.query(
            `UPDATE trip_guardian_checkins
             SET status = 'confirmed'
             WHERE trip_id = $1 AND user_id = $2 AND status IN ('scheduled','sent')
             RETURNING id`,
            [tripId, userId]
        );

        try {
            await pool.query(
                `INSERT INTO trip_safety_events (trip_id, created_by_role, created_by_user_id, event_type, message)
                 VALUES ($1,$2,$3,'guardian_checkin_confirmed',NULL)`,
                [tripId, 'passenger', userId]
            );
        } catch (e) {
            // ignore
        }

        res.json({ success: true, count: updated.rows.length });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

const GUARDIAN_CHECKINS_ADVISORY_LOCK_KEY = 90133701;

async function processGuardianCheckins({ limit = 50, triggeredBy = 'admin' } = {}) {
    const effectiveLimit = Number.isFinite(Number(limit)) ? Math.min(Math.max(Number(limit), 1), 200) : 50;
    const client = await pool.connect();
    let locked = false;
    try {
        const lockRes = await client.query('SELECT pg_try_advisory_lock($1) AS ok', [GUARDIAN_CHECKINS_ADVISORY_LOCK_KEY]);
        locked = Boolean(lockRes.rows?.[0]?.ok);
        if (!locked) {
            return { ok: true, skipped: true, reason: 'lock_not_acquired', processed: [] };
        }

        await client.query('BEGIN');

        const due = await client.query(
            `SELECT id, trip_id, user_id, due_at
             FROM trip_guardian_checkins
             WHERE status = 'scheduled' AND due_at <= NOW()
             ORDER BY due_at ASC
             LIMIT $1
             FOR UPDATE SKIP LOCKED`,
            [effectiveLimit]
        );

        const processed = [];
        for (const row of due.rows) {
            const tripId = String(row.trip_id);
            const userId = row.user_id;

            // Ensure active share exists
            let token = null;
            try {
                const existing = await client.query(
                    `SELECT share_token
                     FROM trip_shares
                     WHERE trip_id = $1 AND (expires_at IS NULL OR expires_at > NOW())
                     ORDER BY created_at DESC
                     LIMIT 1`,
                    [tripId]
                );
                token = existing.rows?.[0]?.share_token || null;
            } catch (e) {
                token = null;
            }

            if (!token) {
                token = makeShareToken();
                const expiresAt = new Date(Date.now() + 24 * 3600 * 1000);
                try {
                    await client.query(
                        `INSERT INTO trip_shares (trip_id, share_token, created_by_user_id, expires_at)
                         VALUES ($1,$2,$3,$4)`,
                        [tripId, token, userId || null, expiresAt]
                    );
                } catch (e) {
                    const existing = await client.query(
                        `SELECT share_token
                         FROM trip_shares
                         WHERE trip_id = $1 AND (expires_at IS NULL OR expires_at > NOW())
                         ORDER BY created_at DESC
                         LIMIT 1`,
                        [tripId]
                    );
                    token = existing.rows?.[0]?.share_token || token;
                }

                try {
                    await client.query(
                        `INSERT INTO trip_safety_events (trip_id, created_by_role, created_by_user_id, event_type, message)
                         VALUES ($1,'passenger',$2,'share_created','auto:guardian_checkin')`,
                        [tripId, userId || null]
                    );
                } catch (e) {
                    // ignore
                }
            }

            const shareUrl = `/api/share/${token}`;
            const message = buildGuardianMessage({ tripId, shareUrl });
            const subject = `Guardian Check-In (Trip ${tripId})`;

            let contacts = [];
            try {
                const cRes = await client.query(
                    `SELECT id, name, channel, value
                     FROM passenger_trusted_contacts
                     WHERE user_id = $1
                     ORDER BY created_at DESC
                     LIMIT 20`,
                    [userId]
                );
                contacts = cRes.rows || [];
            } catch (e) {
                contacts = [];
            }

            const deliveries = [];
            let lastError = null;
            for (const c of contacts) {
                try {
                    const r = await deliverGuardianNotification({ contact: c, message, subject });
                    deliveries.push({ contact_id: c.id, ...r });
                    if (!r.ok && !lastError) lastError = r.error || 'delivery_failed';
                } catch (e) {
                    lastError = lastError || e.message;
                    deliveries.push({ contact_id: c.id, ok: false, channel: c.channel, error: e.message });
                }
            }

            if (contacts.length === 0) {
                lastError = 'no_trusted_contacts';
                deliveries.push({ ok: false, channel: null, error: 'no_trusted_contacts' });
            }

            await client.query(
                `UPDATE trip_guardian_checkins
                 SET status = 'sent',
                     sent_at = NOW(),
                     delivery_result = $2::jsonb,
                     last_error = $3
                 WHERE id = $1 AND status = 'scheduled'`,
                [row.id, JSON.stringify({ triggered_by: triggeredBy, share_url: shareUrl, message, deliveries }), lastError]
            );

            try {
                await client.query(
                    `INSERT INTO trip_safety_events (trip_id, created_by_role, created_by_user_id, event_type, message)
                     VALUES ($1,'system',$2,'guardian_checkin_sent',$3)`,
                    [tripId, userId || null, lastError ? `delivery_issue:${lastError}` : null]
                );
            } catch (e) {
                // ignore
            }

            processed.push({ checkin_id: row.id, trip_id: tripId, share_url: shareUrl, contacts: contacts.length, last_error: lastError });
        }

        await client.query('COMMIT');
        return { ok: true, skipped: false, processed };
    } catch (err) {
        try { await client.query('ROLLBACK'); } catch (e) {}
        return { ok: false, error: err.message, processed: [] };
    } finally {
        try {
            if (locked) await client.query('SELECT pg_advisory_unlock($1)', [GUARDIAN_CHECKINS_ADVISORY_LOCK_KEY]);
        } catch (e) {
            // ignore
        }
        client.release();
    }
}

// Admin job: process due check-ins (cron substitute)
app.post('/api/admin/jobs/guardian-checkins/process', requireRole('admin'), async (req, res) => {
    try {
        const limit = req.body?.limit !== undefined && req.body?.limit !== null ? Number(req.body.limit) : 50;
        const result = await processGuardianCheckins({ limit, triggeredBy: 'admin' });
        if (!result.ok) return res.status(500).json({ success: false, error: result.error || 'guardian_job_failed' });
        res.json({
            success: true,
            skipped: Boolean(result.skipped),
            reason: result.reason || null,
            processed: result.processed.length,
            data: result.processed
        });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// --- Family / group ---

app.get('/api/passengers/me/family', requireRole('passenger', 'admin'), async (req, res) => {
    try {
        const authRole = String(req.auth?.role || '').toLowerCase();
        const userId = authRole === 'passenger' ? req.auth?.uid : Number(req.query.user_id);
        if (!userId) return res.status(400).json({ success: false, error: 'user_id is required' });
        const result = await pool.query(
            `SELECT id, name, phone, daily_limit, weekly_limit, is_active, created_at
             FROM passenger_family_members
             WHERE owner_user_id = $1
             ORDER BY created_at DESC`,
            [userId]
        );
        res.json({ success: true, data: result.rows });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// Family spending budget remaining (daily/weekly) for UI warnings
app.get('/api/passengers/me/family/:id/budget', requireRole('passenger', 'admin'), async (req, res) => {
    try {
        const memberId = Number(req.params.id);
        const authRole = String(req.auth?.role || '').toLowerCase();
        const userId = authRole === 'passenger' ? req.auth?.uid : Number(req.query.user_id);
        if (!userId || !Number.isFinite(memberId) || memberId <= 0) {
            return res.status(400).json({ success: false, error: 'Invalid request' });
        }

        const famRes = await pool.query(
            `SELECT id, daily_limit, weekly_limit
             FROM passenger_family_members
             WHERE id = $1 AND owner_user_id = $2 AND is_active = true
             LIMIT 1`,
            [memberId, userId]
        );
        const fam = famRes.rows[0] || null;
        if (!fam) return res.status(404).json({ success: false, error: 'Family member not found' });

        const daySpentRes = await pool.query(
            `SELECT COALESCE(SUM(COALESCE(cost, price, 0)), 0) AS total
             FROM trips
             WHERE booked_for_family_member_id = $1
               AND status <> 'cancelled'
               AND created_at >= date_trunc('day', NOW())`,
            [memberId]
        );
        const weekSpentRes = await pool.query(
            `SELECT COALESCE(SUM(COALESCE(cost, price, 0)), 0) AS total
             FROM trips
             WHERE booked_for_family_member_id = $1
               AND status <> 'cancelled'
               AND created_at >= date_trunc('week', NOW())`,
            [memberId]
        );

        const dailyLimit = fam.daily_limit !== null && fam.daily_limit !== undefined ? Number(fam.daily_limit) : null;
        const weeklyLimit = fam.weekly_limit !== null && fam.weekly_limit !== undefined ? Number(fam.weekly_limit) : null;
        const dailySpent = Number(daySpentRes.rows?.[0]?.total || 0);
        const weeklySpent = Number(weekSpentRes.rows?.[0]?.total || 0);

        const dailyRemaining = Number.isFinite(dailyLimit) ? Math.max(0, dailyLimit - dailySpent) : null;
        const weeklyRemaining = Number.isFinite(weeklyLimit) ? Math.max(0, weeklyLimit - weeklySpent) : null;

        return res.json({
            success: true,
            data: {
                member_id: memberId,
                daily_limit: dailyLimit,
                weekly_limit: weeklyLimit,
                daily_spent: dailySpent,
                weekly_spent: weeklySpent,
                daily_remaining: dailyRemaining,
                weekly_remaining: weeklyRemaining
            }
        });
    } catch (err) {
        return res.status(500).json({ success: false, error: err.message });
    }
});

// --- Trip Budget Envelope (per passenger) ---
app.get('/api/passengers/me/budget-envelope', requireRole('passenger', 'admin'), async (req, res) => {
    try {
        const authRole = String(req.auth?.role || '').toLowerCase();
        const userId = authRole === 'passenger' ? req.auth?.uid : Number(req.query.user_id);
        if (!userId) return res.status(400).json({ success: false, error: 'user_id is required' });

        const rowRes = await pool.query(
            `SELECT user_id, enabled, daily_limit, weekly_limit, updated_at
             FROM passenger_budget_envelopes
             WHERE user_id = $1
             LIMIT 1`,
            [userId]
        );
        const row = rowRes.rows[0] || null;
        return res.json({ success: true, data: row });
    } catch (err) {
        return res.status(500).json({ success: false, error: err.message });
    }
});

app.post('/api/passengers/me/budget-envelope', requireRole('passenger', 'admin'), async (req, res) => {
    try {
        const authRole = String(req.auth?.role || '').toLowerCase();
        const userId = authRole === 'passenger' ? req.auth?.uid : Number(req.body?.user_id);
        if (!userId) return res.status(400).json({ success: false, error: 'user_id is required' });

        const enabled = req.body?.enabled !== undefined ? Boolean(req.body.enabled) : true;
        const dailyLimit = req.body?.daily_limit !== undefined && req.body?.daily_limit !== null ? Number(req.body.daily_limit) : null;
        const weeklyLimit = req.body?.weekly_limit !== undefined && req.body?.weekly_limit !== null ? Number(req.body.weekly_limit) : null;

        if (dailyLimit !== null && (!Number.isFinite(dailyLimit) || dailyLimit < 0)) {
            return res.status(400).json({ success: false, error: 'daily_limit must be >= 0' });
        }
        if (weeklyLimit !== null && (!Number.isFinite(weeklyLimit) || weeklyLimit < 0)) {
            return res.status(400).json({ success: false, error: 'weekly_limit must be >= 0' });
        }

        const up = await pool.query(
            `INSERT INTO passenger_budget_envelopes (user_id, enabled, daily_limit, weekly_limit, updated_at)
             VALUES ($1,$2,$3,$4,CURRENT_TIMESTAMP)
             ON CONFLICT (user_id) DO UPDATE
               SET enabled = EXCLUDED.enabled,
                   daily_limit = EXCLUDED.daily_limit,
                   weekly_limit = EXCLUDED.weekly_limit,
                   updated_at = CURRENT_TIMESTAMP
             RETURNING user_id, enabled, daily_limit, weekly_limit, updated_at`,
            [userId, enabled, dailyLimit, weeklyLimit]
        );

        return res.json({ success: true, data: up.rows[0] });
    } catch (err) {
        return res.status(500).json({ success: false, error: err.message });
    }
});

// Check if wallet payment fits inside budget envelope. If not -> suggest switching to cash.
app.post('/api/passengers/me/budget-envelope/check', requireRole('passenger', 'admin'), async (req, res) => {
    try {
        const authRole = String(req.auth?.role || '').toLowerCase();
        const userId = authRole === 'passenger' ? req.auth?.uid : Number(req.body?.user_id);
        const amount = req.body?.amount !== undefined && req.body?.amount !== null ? Number(req.body.amount) : null;
        if (!userId || !Number.isFinite(amount) || amount <= 0) {
            return res.status(400).json({ success: false, error: 'amount is required' });
        }

        const envRes = await pool.query(
            `SELECT enabled, daily_limit, weekly_limit
             FROM passenger_budget_envelopes
             WHERE user_id = $1
             LIMIT 1`,
            [userId]
        );
        const env = envRes.rows[0] || null;
        if (!env || env.enabled === false) {
            return res.json({ success: true, allowed: true, force_method: null });
        }

        const dailyLimit = env.daily_limit !== null && env.daily_limit !== undefined ? Number(env.daily_limit) : null;
        const weeklyLimit = env.weekly_limit !== null && env.weekly_limit !== undefined ? Number(env.weekly_limit) : null;

        const dailySpentRes = await pool.query(
            `SELECT COALESCE(SUM(COALESCE(cost, price, 0)), 0) AS total
             FROM trips
             WHERE user_id = $1
               AND payment_method = 'wallet'
               AND status <> 'cancelled'
               AND created_at >= date_trunc('day', NOW())`,
            [userId]
        );
        const weeklySpentRes = await pool.query(
            `SELECT COALESCE(SUM(COALESCE(cost, price, 0)), 0) AS total
             FROM trips
             WHERE user_id = $1
               AND payment_method = 'wallet'
               AND status <> 'cancelled'
               AND created_at >= date_trunc('week', NOW())`,
            [userId]
        );

        const dailySpent = Number(dailySpentRes.rows?.[0]?.total || 0);
        const weeklySpent = Number(weeklySpentRes.rows?.[0]?.total || 0);

        const dailyRemaining = Number.isFinite(dailyLimit) ? Math.max(0, dailyLimit - dailySpent) : null;
        const weeklyRemaining = Number.isFinite(weeklyLimit) ? Math.max(0, weeklyLimit - weeklySpent) : null;

        const dailyOk = dailyRemaining === null ? true : amount <= dailyRemaining;
        const weeklyOk = weeklyRemaining === null ? true : amount <= weeklyRemaining;
        const allowed = dailyOk && weeklyOk;

        return res.json({
            success: true,
            allowed,
            force_method: allowed ? null : 'cash',
            data: {
                daily_limit: Number.isFinite(dailyLimit) ? dailyLimit : null,
                weekly_limit: Number.isFinite(weeklyLimit) ? weeklyLimit : null,
                daily_spent: dailySpent,
                weekly_spent: weeklySpent,
                daily_remaining: dailyRemaining,
                weekly_remaining: weeklyRemaining
            }
        });
    } catch (err) {
        return res.status(500).json({ success: false, error: err.message });
    }
});

app.post('/api/passengers/me/family', requireRole('passenger', 'admin'), async (req, res) => {
    try {
        const authRole = String(req.auth?.role || '').toLowerCase();
        const userId = authRole === 'passenger' ? req.auth?.uid : Number(req.body?.user_id);
        const { name, phone = null, daily_limit = null, weekly_limit = null } = req.body || {};
        if (!userId || !name) return res.status(400).json({ success: false, error: 'name is required' });
        const insert = await pool.query(
            `INSERT INTO passenger_family_members (owner_user_id, name, phone, daily_limit, weekly_limit)
             VALUES ($1, $2, NULLIF($3, ''), $4, $5)
             RETURNING id, name, phone, daily_limit, weekly_limit, is_active, created_at`,
            [
                userId,
                String(name),
                phone !== null && phone !== undefined ? String(phone) : '',
                daily_limit !== null && daily_limit !== undefined ? Number(daily_limit) : null,
                weekly_limit !== null && weekly_limit !== undefined ? Number(weekly_limit) : null
            ]
        );
        res.status(201).json({ success: true, data: insert.rows[0] });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

app.delete('/api/passengers/me/family/:id', requireRole('passenger', 'admin'), async (req, res) => {
    try {
        const memberId = Number(req.params.id);
        const authRole = String(req.auth?.role || '').toLowerCase();
        const userId = authRole === 'passenger' ? req.auth?.uid : Number(req.query.user_id);
        if (!userId || !Number.isFinite(memberId) || memberId <= 0) {
            return res.status(400).json({ success: false, error: 'Invalid request' });
        }
        await pool.query('DELETE FROM passenger_family_members WHERE id = $1 AND owner_user_id = $2', [memberId, userId]);
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// --- Scheduled rides ---

app.post('/api/scheduled-rides', requireRole('passenger', 'admin'), async (req, res) => {
    try {
        const authRole = String(req.auth?.role || '').toLowerCase();
        const userId = authRole === 'passenger' ? req.auth?.uid : Number(req.body?.user_id);
        const {
            pickup_location,
            dropoff_location,
            pickup_lat,
            pickup_lng,
            dropoff_lat,
            dropoff_lng,
            car_type = 'economy',
            payment_method = 'cash',
            scheduled_at
        } = req.body || {};

        const pickupLat = Number(pickup_lat);
        const pickupLng = Number(pickup_lng);
        const dropoffLat = Number(dropoff_lat);
        const dropoffLng = Number(dropoff_lng);
        const scheduledAt = scheduled_at ? new Date(scheduled_at) : null;
        if (!userId || !pickup_location || !dropoff_location) {
            return res.status(400).json({ success: false, error: 'Missing required fields' });
        }
        if (!Number.isFinite(pickupLat) || !Number.isFinite(pickupLng) || !Number.isFinite(dropoffLat) || !Number.isFinite(dropoffLng)) {
            return res.status(400).json({ success: false, error: 'Invalid coordinates' });
        }
        if (!scheduledAt || isNaN(scheduledAt.getTime())) {
            return res.status(400).json({ success: false, error: 'scheduled_at is required' });
        }
        if (scheduledAt.getTime() < Date.now() + 5 * 60 * 1000) {
            return res.status(400).json({ success: false, error: 'scheduled_at must be at least 5 minutes in the future' });
        }

        const { price } = computeSimplePrice({ pickupLat, pickupLng, dropoffLat, dropoffLng, carType: car_type });

        const insert = await pool.query(
            `INSERT INTO scheduled_rides (
                user_id, pickup_location, dropoff_location,
                pickup_lat, pickup_lng, dropoff_lat, dropoff_lng,
                car_type, estimated_price, payment_method, scheduled_at
             ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
             RETURNING *`,
            [userId, pickup_location, dropoff_location, pickupLat, pickupLng, dropoffLat, dropoffLng, car_type, price, payment_method, scheduledAt]
        );

        res.status(201).json({ success: true, data: insert.rows[0] });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

app.get('/api/scheduled-rides/me', requireRole('passenger', 'admin'), async (req, res) => {
    try {
        const authRole = String(req.auth?.role || '').toLowerCase();
        const userId = authRole === 'passenger' ? req.auth?.uid : Number(req.query.user_id);
        if (!userId) return res.status(400).json({ success: false, error: 'user_id is required' });
        const result = await pool.query(
            `SELECT *
             FROM scheduled_rides
             WHERE user_id = $1
             ORDER BY scheduled_at DESC
             LIMIT 100`,
            [userId]
        );
        res.json({ success: true, data: result.rows });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

app.post('/api/scheduled-rides/:id/confirm', requireRole('passenger', 'admin'), async (req, res) => {
    try {
        const scheduledId = Number(req.params.id);
        if (!Number.isFinite(scheduledId) || scheduledId <= 0) {
            return res.status(400).json({ success: false, error: 'Invalid scheduled ride id' });
        }
        const authRole = String(req.auth?.role || '').toLowerCase();
        const userId = authRole === 'passenger' ? req.auth?.uid : Number(req.body?.user_id);
        if (!userId) return res.status(400).json({ success: false, error: 'Unauthorized' });

        const updated = await pool.query(
            `UPDATE scheduled_rides
             SET status = 'confirmed', confirmed_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
             WHERE id = $1 AND user_id = $2 AND status = 'pending_confirmation'
             RETURNING *`,
            [scheduledId, userId]
        );
        if (updated.rows.length === 0) {
            return res.status(409).json({ success: false, error: 'Scheduled ride cannot be confirmed' });
        }
        res.json({ success: true, data: updated.rows[0] });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// Admin/cron helper: create real trips for scheduled rides near time window
app.post('/api/scheduled-rides/process', requireRole('admin'), async (req, res) => {
    const client = await pool.connect();
    try {
        const windowMinutes = Number.isFinite(Number(req.body?.window_minutes)) ? Math.min(Math.max(Number(req.body.window_minutes), 1), 180) : 15;
        await client.query('BEGIN');

        const due = await client.query(
            `SELECT *
             FROM scheduled_rides
             WHERE status = 'confirmed'
               AND scheduled_at <= NOW() + ($1 * INTERVAL '1 minute')
               AND created_trip_id IS NULL
             ORDER BY scheduled_at ASC
             LIMIT 25
             FOR UPDATE SKIP LOCKED`,
            [windowMinutes]
        );

        const created = [];
        for (const ride of due.rows) {
            const tripId = 'SCH-' + Date.now() + '-' + Math.floor(Math.random() * 1000);
            const tripInsert = await client.query(
                `INSERT INTO trips (
                    id, user_id, rider_id,
                    pickup_location, dropoff_location,
                    pickup_lat, pickup_lng, dropoff_lat, dropoff_lng,
                    car_type, cost, price, payment_method, status, source
                 ) VALUES ($1,$2,$2,$3,$4,$5,$6,$7,$8,$9,$10,$10,$11,'pending','scheduled')
                 RETURNING *`,
                [
                    tripId,
                    ride.user_id,
                    ride.pickup_location,
                    ride.dropoff_location,
                    Number(ride.pickup_lat),
                    Number(ride.pickup_lng),
                    Number(ride.dropoff_lat),
                    Number(ride.dropoff_lng),
                    ride.car_type || 'economy',
                    Number(ride.estimated_price || 0),
                    ride.payment_method || 'cash'
                ]
            );

            await client.query(
                `UPDATE scheduled_rides
                 SET status = 'driver_assignment',
                     created_trip_id = $2,
                     updated_at = CURRENT_TIMESTAMP
                 WHERE id = $1`,
                [ride.id, tripId]
            );
            created.push(tripInsert.rows[0]);
        }

        await client.query('COMMIT');
        res.json({ success: true, created_count: created.length, data: created });
    } catch (err) {
        try { await client.query('ROLLBACK'); } catch (e) { /* ignore */ }
        res.status(500).json({ success: false, error: err.message });
    } finally {
        client.release();
    }
});

// --- Price lock ---

app.post('/api/pricing/lock', requireRole('passenger', 'admin'), async (req, res) => {
    try {
        const authRole = String(req.auth?.role || '').toLowerCase();
        const userId = authRole === 'passenger' ? req.auth?.uid : Number(req.body?.user_id);
        const { pickup_lat, pickup_lng, dropoff_lat, dropoff_lng, car_type = 'economy' } = req.body || {};
        const pickupLat = Number(pickup_lat);
        const pickupLng = Number(pickup_lng);
        const dropoffLat = Number(dropoff_lat);
        const dropoffLng = Number(dropoff_lng);
        if (!userId || !Number.isFinite(pickupLat) || !Number.isFinite(pickupLng) || !Number.isFinite(dropoffLat) || !Number.isFinite(dropoffLng)) {
            return res.status(400).json({ success: false, error: 'Invalid coordinates' });
        }

        const ttlSeconds = Number.isFinite(Number(req.body?.ttl_seconds)) ? Math.min(Math.max(Number(req.body.ttl_seconds), 30), 600) : 120;
        const expiresAt = new Date(Date.now() + ttlSeconds * 1000);
        const { price, distance_km } = computeSimplePrice({ pickupLat, pickupLng, dropoffLat, dropoffLng, carType: car_type });

        const insert = await pool.query(
            `INSERT INTO price_locks (
                user_id, pickup_lat, pickup_lng, dropoff_lat, dropoff_lng, car_type, price, expires_at
             ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
             RETURNING id, user_id, price, currency, expires_at, created_at`,
            [userId, pickupLat, pickupLng, dropoffLat, dropoffLng, car_type, price, expiresAt]
        );
        res.status(201).json({ success: true, data: insert.rows[0], quote: { distance_km, price } });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// --- Multi-stop trip ---

app.get('/api/trips/:id/stops', requireAuth, async (req, res) => {
    try {
        const tripId = String(req.params.id);
        const tripRes = await pool.query('SELECT * FROM trips WHERE id = $1 LIMIT 1', [tripId]);
        const tripRow = tripRes.rows[0] || null;
        const authRole = String(req.auth?.role || '').toLowerCase();
        const authUserId = req.auth?.uid;
        const authDriverId = req.auth?.driver_id;
        const access = requireTripAccess({ tripRow, authRole, authUserId, authDriverId });
        if (!access.ok) return res.status(access.status).json({ success: false, error: access.error });

        const stops = await pool.query(
            `SELECT stop_order, label, lat, lng, created_at
             FROM trip_stops
             WHERE trip_id = $1
             ORDER BY stop_order ASC`,
            [tripId]
        );

        res.json({ success: true, data: stops.rows });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

app.post('/api/trips/:id/stops', requireRole('passenger', 'admin'), async (req, res) => {
    const client = await pool.connect();
    try {
        const tripId = String(req.params.id);
        const stops = Array.isArray(req.body?.stops) ? req.body.stops : [];
        if (stops.length > 5) {
            return res.status(400).json({ success: false, error: 'Maximum 5 stops' });
        }

        await client.query('BEGIN');
        const tripRes = await client.query('SELECT * FROM trips WHERE id = $1 LIMIT 1 FOR UPDATE', [tripId]);
        const tripRow = tripRes.rows[0] || null;
        const authRole = String(req.auth?.role || '').toLowerCase();
        const authUserId = req.auth?.uid;
        const access = requireTripAccess({ tripRow, authRole, authUserId, authDriverId: null });
        if (!access.ok) {
            await client.query('ROLLBACK');
            return res.status(access.status).json({ success: false, error: access.error });
        }

        await client.query('DELETE FROM trip_stops WHERE trip_id = $1', [tripId]);
        let order = 1;
        for (const s of stops) {
            const lat = Number(s?.lat);
            const lng = Number(s?.lng);
            if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
                await client.query('ROLLBACK');
                return res.status(400).json({ success: false, error: 'Invalid stop coordinates' });
            }
            const label = s?.label !== undefined && s?.label !== null ? String(s.label) : null;
            await client.query(
                `INSERT INTO trip_stops (trip_id, stop_order, label, lat, lng)
                 VALUES ($1,$2,NULLIF($3,''),$4,$5)`,
                [tripId, order, label || '', lat, lng]
            );
            order += 1;
        }

        // Reprice (simple) using segments
        const pickupLat = Number(tripRow.pickup_lat);
        const pickupLng = Number(tripRow.pickup_lng);
        const dropoffLat = Number(tripRow.dropoff_lat);
        const dropoffLng = Number(tripRow.dropoff_lng);
        let last = { lat: pickupLat, lng: pickupLng };
        let totalKm = 0;
        for (const s of stops) {
            const seg = haversineKm(last, { lat: Number(s.lat), lng: Number(s.lng) });
            totalKm += seg;
            last = { lat: Number(s.lat), lng: Number(s.lng) };
        }
        totalKm += haversineKm(last, { lat: dropoffLat, lng: dropoffLng });
        const carType = tripRow.car_type || 'economy';
        const baseFare = 8;
        const perKm = carType === 'vip' ? 4 : carType === 'family' ? 3.2 : 2.6;
        const newPrice = Math.max(10, Math.round((baseFare + totalKm * perKm) * 100) / 100);

        const updatedTripRes = await client.query(
            `UPDATE trips
             SET price = $2,
                 cost = $2,
                 distance_km = $3,
                 distance = $3,
                 updated_at = CURRENT_TIMESTAMP
             WHERE id = $1
             RETURNING *`,
            [tripId, newPrice, Math.round(totalKm * 100) / 100]
        );

        await client.query('COMMIT');
        res.json({ success: true, trip: updatedTripRes.rows[0] });
    } catch (err) {
        try { await client.query('ROLLBACK'); } catch (e) { /* ignore */ }
        res.status(500).json({ success: false, error: err.message });
    } finally {
        client.release();
    }
});

// --- Split fare ---

app.post('/api/trips/:id/split-fare', requireRole('passenger', 'admin'), async (req, res) => {
    const client = await pool.connect();
    try {
        const tripId = String(req.params.id);
        const splits = Array.isArray(req.body?.splits) ? req.body.splits : [];
        if (splits.length < 2 || splits.length > 5) {
            return res.status(400).json({ success: false, error: 'splits must have 2-5 participants' });
        }

        await client.query('BEGIN');
        const tripRes = await client.query('SELECT * FROM trips WHERE id = $1 LIMIT 1 FOR UPDATE', [tripId]);
        const tripRow = tripRes.rows[0] || null;
        const authRole = String(req.auth?.role || '').toLowerCase();
        const authUserId = req.auth?.uid;
        const access = requireTripAccess({ tripRow, authRole, authUserId, authDriverId: null });
        if (!access.ok) {
            await client.query('ROLLBACK');
            return res.status(access.status).json({ success: false, error: access.error });
        }

        const tripPrice = Number(tripRow.price !== null && tripRow.price !== undefined ? tripRow.price : tripRow.cost || 0);
        if (!Number.isFinite(tripPrice) || tripPrice <= 0) {
            await client.query('ROLLBACK');
            return res.status(409).json({ success: false, error: 'Trip price is not set' });
        }

        let total = 0;
        for (const s of splits) {
            const payerUserId = Number(s?.user_id);
            const amount = Number(s?.amount);
            const method = String(s?.method || 'wallet').toLowerCase();
            if (!Number.isFinite(payerUserId) || payerUserId <= 0 || !Number.isFinite(amount) || amount <= 0) {
                await client.query('ROLLBACK');
                return res.status(400).json({ success: false, error: 'Invalid split entry' });
            }
            if (!['wallet', 'cash'].includes(method)) {
                await client.query('ROLLBACK');
                return res.status(400).json({ success: false, error: 'method must be wallet or cash' });
            }
            total += amount;
        }

        const rounded = Math.round(total * 100) / 100;
        if (Math.abs(rounded - tripPrice) > 0.5) {
            await client.query('ROLLBACK');
            return res.status(400).json({ success: false, error: 'Split total must match trip price' });
        }

        await client.query('DELETE FROM trip_split_payments WHERE trip_id = $1', [tripId]);
        for (const s of splits) {
            const payerUserId = Number(s.user_id);
            const amount = Math.round(Number(s.amount) * 100) / 100;
            const method = String(s.method || 'wallet').toLowerCase();
            await client.query(
                `INSERT INTO trip_split_payments (trip_id, payer_user_id, amount, method)
                 VALUES ($1,$2,$3,$4)`,
                [tripId, payerUserId, amount, method]
            );
        }

        await client.query(
            `UPDATE trips
             SET payment_method = 'split', updated_at = CURRENT_TIMESTAMP
             WHERE id = $1`,
            [tripId]
        );

        await client.query('COMMIT');
        res.json({ success: true });
    } catch (err) {
        try { await client.query('ROLLBACK'); } catch (e) { /* ignore */ }
        res.status(500).json({ success: false, error: err.message });
    } finally {
        client.release();
    }
});

app.get('/api/trips/:id/split-fare', requireAuth, async (req, res) => {
    try {
        const tripId = String(req.params.id);
        const tripRes = await pool.query('SELECT * FROM trips WHERE id = $1 LIMIT 1', [tripId]);
        const tripRow = tripRes.rows[0] || null;
        const authRole = String(req.auth?.role || '').toLowerCase();
        const authUserId = req.auth?.uid;
        const authDriverId = req.auth?.driver_id;
        const access = requireTripAccess({ tripRow, authRole, authUserId, authDriverId });
        if (!access.ok) return res.status(access.status).json({ success: false, error: access.error });

        const result = await pool.query(
            `SELECT payer_user_id AS user_id, amount, method, status, paid_at, created_at
             FROM trip_split_payments
             WHERE trip_id = $1
             ORDER BY created_at ASC`,
            [tripId]
        );
        res.json({ success: true, data: result.rows });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

app.post('/api/trips/:id/split-fare/cash-collected', requireRole('driver', 'admin'), async (req, res) => {
    try {
        const tripId = String(req.params.id);
        const tripRes = await pool.query('SELECT * FROM trips WHERE id = $1 LIMIT 1', [tripId]);
        const tripRow = tripRes.rows[0] || null;
        const authRole = String(req.auth?.role || '').toLowerCase();
        const authDriverId = req.auth?.driver_id;
        if (authRole === 'driver') {
            if (!authDriverId) return res.status(403).json({ success: false, error: 'Driver profile not linked to this account' });
            if (String(tripRow?.driver_id || '') !== String(authDriverId)) {
                return res.status(403).json({ success: false, error: 'Forbidden' });
            }
        }

        const updated = await pool.query(
            `UPDATE trip_split_payments
             SET status = 'paid', paid_at = CURRENT_TIMESTAMP
             WHERE trip_id = $1 AND method = 'cash'
             RETURNING *`,
            [tripId]
        );
        res.json({ success: true, count: updated.rows.length, data: updated.rows });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// --- Safety pack (share + emergency + event log) ---

app.post('/api/trips/:id/share', requireRole('passenger', 'admin'), async (req, res) => {
    try {
        const tripId = String(req.params.id);
        const tripRes = await pool.query('SELECT * FROM trips WHERE id = $1 LIMIT 1', [tripId]);
        const tripRow = tripRes.rows[0] || null;
        const authRole = String(req.auth?.role || '').toLowerCase();
        const authUserId = req.auth?.uid;
        const access = requireTripAccess({ tripRow, authRole, authUserId, authDriverId: null });
        if (!access.ok) return res.status(access.status).json({ success: false, error: access.error });

        const ttlHours = Number.isFinite(Number(req.body?.ttl_hours)) ? Math.min(Math.max(Number(req.body.ttl_hours), 1), 168) : 24;
        const expiresAt = new Date(Date.now() + ttlHours * 3600 * 1000);
        const token = makeShareToken();

        const insert = await pool.query(
            `INSERT INTO trip_shares (trip_id, share_token, created_by_user_id, expires_at)
             VALUES ($1,$2,$3,$4)
             RETURNING id, trip_id, share_token, expires_at, created_at`,
            [tripId, token, authUserId || null, expiresAt]
        );

        try {
            await pool.query(
                `INSERT INTO trip_safety_events (trip_id, created_by_role, created_by_user_id, event_type, message)
                 VALUES ($1,$2,$3,'share_created',NULL)`,
                [tripId, String(req.auth?.role || 'passenger'), authUserId || null]
            );
        } catch (e) {
            // ignore
        }

        res.status(201).json({ success: true, data: insert.rows[0], url: `/api/share/${token}` });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

app.get('/api/share/:token', async (req, res) => {
    try {
        const token = String(req.params.token);
        const shareRes = await pool.query(
            `SELECT *
             FROM trip_shares
             WHERE share_token = $1
             LIMIT 1`,
            [token]
        );
        const share = shareRes.rows[0] || null;
        if (!share) return res.status(404).json({ success: false, error: 'Share not found' });
        if (share.expires_at && new Date(share.expires_at).getTime() < Date.now()) {
            return res.status(410).json({ success: false, error: 'Share expired' });
        }

        const tripRes = await pool.query(
            `SELECT t.id, t.pickup_location, t.dropoff_location, t.pickup_lat, t.pickup_lng, t.dropoff_lat, t.dropoff_lng,
                    t.status, t.trip_status, t.driver_id, COALESCE(t.driver_name, d.name) AS driver_name,
                    d.last_lat AS driver_lat, d.last_lng AS driver_lng, d.last_location_at
             FROM trips t
             LEFT JOIN drivers d ON d.id = t.driver_id
             WHERE t.id = $1
             LIMIT 1`,
            [share.trip_id]
        );
        if (tripRes.rows.length === 0) return res.status(404).json({ success: false, error: 'Trip not found' });
        res.json({ success: true, data: tripRes.rows[0] });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

app.post('/api/trips/:id/safety/emergency', requireAuth, async (req, res) => {
    try {
        const tripId = String(req.params.id);
        const tripRes = await pool.query('SELECT * FROM trips WHERE id = $1 LIMIT 1', [tripId]);
        const tripRow = tripRes.rows[0] || null;
        const authRole = String(req.auth?.role || '').toLowerCase();
        const authUserId = req.auth?.uid;
        const authDriverId = req.auth?.driver_id;
        const access = requireTripAccess({ tripRow, authRole, authUserId, authDriverId });
        if (!access.ok) return res.status(access.status).json({ success: false, error: access.error });

        const msg = req.body?.message !== undefined && req.body?.message !== null ? String(req.body.message) : null;
        const insert = await pool.query(
            `INSERT INTO trip_safety_events (trip_id, created_by_role, created_by_user_id, created_by_driver_id, event_type, message)
             VALUES ($1,$2,$3,$4,'emergency_pressed',NULLIF($5,''))
             RETURNING *`,
            [tripId, String(req.auth?.role || ''), authUserId || null, authDriverId || null, msg || '']
        );

        try {
            io.to(tripRoom(tripId)).emit('safety_event', { trip_id: String(tripId), event: insert.rows[0] });
        } catch (e) {
            // ignore
        }

        // Emergency Info Card (opt-in): only return to passenger/admin (do not broadcast)
        let emergencyCard = null;
        try {
            if (authRole === 'passenger' || authRole === 'admin') {
                const userId = tripRow?.user_id ? Number(tripRow.user_id) : null;
                if (userId) {
                    const em = await pool.query(
                        `SELECT opt_in, contact_name, contact_channel, contact_value, medical_note, updated_at
                         FROM passenger_emergency_profiles
                         WHERE user_id = $1
                         LIMIT 1`,
                        [userId]
                    );
                    const row = em.rows[0] || null;
                    if (row && row.opt_in) {
                        emergencyCard = {
                            contact_name: row.contact_name || null,
                            contact_channel: row.contact_channel || 'phone',
                            contact_value: row.contact_value || null,
                            medical_note: row.medical_note || null,
                            updated_at: row.updated_at || null
                        };
                    }
                }
            }
        } catch (e) {
            emergencyCard = null;
        }

        res.status(201).json({ success: true, data: insert.rows[0], emergency_card: emergencyCard });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

app.get('/api/trips/:id/safety/events', requireAuth, async (req, res) => {
    try {
        const tripId = String(req.params.id);
        const tripRes = await pool.query('SELECT * FROM trips WHERE id = $1 LIMIT 1', [tripId]);
        const tripRow = tripRes.rows[0] || null;
        const authRole = String(req.auth?.role || '').toLowerCase();
        const authUserId = req.auth?.uid;
        const authDriverId = req.auth?.driver_id;
        const access = requireTripAccess({ tripRow, authRole, authUserId, authDriverId });
        if (!access.ok) return res.status(access.status).json({ success: false, error: access.error });

        const events = await pool.query(
            `SELECT id, event_type, message, created_by_role, created_at
             FROM trip_safety_events
             WHERE trip_id = $1
             ORDER BY created_at DESC
             LIMIT 50`,
            [tripId]
        );
        res.json({ success: true, data: events.rows });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// Safety Capsule (aggregate share + handshake + guardian check-ins + deviation config + safety events)
app.get('/api/trips/:id/safety/capsule', requireRole('passenger', 'admin'), async (req, res) => {
    try {
        const tripId = String(req.params.id);
        const authRole = String(req.auth?.role || '').toLowerCase();
        const authUserId = req.auth?.uid;

        const tripRes = await pool.query(
            `SELECT id, status, driver_id, user_id, pickup_verified_at, pickup_verified_by
             FROM trips
             WHERE id = $1
             LIMIT 1`,
            [tripId]
        );
        const trip = tripRes.rows[0] || null;
        if (!trip) return res.status(404).json({ success: false, error: 'Trip not found' });

        if (authRole === 'passenger' && String(trip.user_id) !== String(authUserId)) {
            return res.status(403).json({ success: false, error: 'Forbidden' });
        }

        let share = null;
        try {
            const shareRes = await pool.query(
                `SELECT share_token, expires_at, created_at
                 FROM trip_shares
                 WHERE trip_id = $1
                 ORDER BY created_at DESC
                 LIMIT 1`,
                [tripId]
            );
            const row = shareRes.rows[0] || null;
            if (row?.share_token) {
                share = {
                    url: `/api/share/${row.share_token}`,
                    expires_at: row.expires_at,
                    created_at: row.created_at
                };
            }
        } catch (e) {
            share = null;
        }

        let deviationConfig = null;
        try {
            const cfgRes = await pool.query(
                `SELECT enabled, deviation_threshold_km, stop_minutes_threshold, updated_at
                 FROM trip_route_deviation_configs
                 WHERE trip_id = $1
                 LIMIT 1`,
                [tripId]
            );
            deviationConfig = cfgRes.rows[0] || null;
        } catch (e) {
            deviationConfig = null;
        }

        const safetyEventsRes = await pool.query(
            `SELECT id, event_type, message, created_by_role, created_at
             FROM trip_safety_events
             WHERE trip_id = $1
             ORDER BY created_at ASC
             LIMIT 200`,
            [tripId]
        );

        let guardianRes = { rows: [] };
        try {
            guardianRes = await pool.query(
                `SELECT id, status, due_at, sent_at, created_at
                 FROM trip_guardian_checkins
                 WHERE trip_id = $1
                 ORDER BY created_at ASC
                 LIMIT 200`,
                [tripId]
            );
        } catch (e) {
            guardianRes = { rows: [] };
        }

        const timeline = [];
        for (const ev of safetyEventsRes.rows || []) {
            timeline.push({
                type: 'safety_event',
                event_type: ev.event_type,
                message: ev.message,
                created_by_role: ev.created_by_role,
                created_at: ev.created_at
            });
        }

        for (const gc of guardianRes.rows || []) {
            timeline.push({
                type: 'guardian_checkin',
                status: gc.status,
                due_at: gc.due_at,
                sent_at: gc.sent_at,
                created_at: gc.created_at
            });
        }

        timeline.sort((a, b) => {
            const ta = new Date(a.created_at || a.sent_at || a.due_at || 0).getTime();
            const tb = new Date(b.created_at || b.sent_at || b.due_at || 0).getTime();
            return ta - tb;
        });

        return res.json({
            success: true,
            data: {
                trip: { id: trip.id, status: trip.status, driver_id: trip.driver_id },
                handshake: { verified_at: trip.pickup_verified_at, verified_by: trip.pickup_verified_by },
                share,
                deviation_config: deviationConfig,
                timeline
            }
        });
    } catch (err) {
        return res.status(500).json({ success: false, error: err.message });
    }
});

// --- Route deviation guardian ---

app.post('/api/trips/:id/safety/deviation-config', requireRole('passenger', 'admin'), async (req, res) => {
    try {
        const tripId = String(req.params.id);
        const tripRes = await pool.query('SELECT * FROM trips WHERE id = $1 LIMIT 1', [tripId]);
        const tripRow = tripRes.rows[0] || null;
        const authRole = String(req.auth?.role || '').toLowerCase();
        const authUserId = req.auth?.uid;
        const access = requireTripAccess({ tripRow, authRole, authUserId, authDriverId: null });
        if (!access.ok) return res.status(access.status).json({ success: false, error: access.error });

        const enabled = req.body?.enabled !== undefined ? Boolean(req.body.enabled) : true;
        const deviationThresholdKm = req.body?.deviation_threshold_km !== undefined && req.body?.deviation_threshold_km !== null
            ? Number(req.body.deviation_threshold_km)
            : null;
        const stopMinutesThreshold = req.body?.stop_minutes_threshold !== undefined && req.body?.stop_minutes_threshold !== null
            ? Number(req.body.stop_minutes_threshold)
            : null;

        if (deviationThresholdKm !== null && (!Number.isFinite(deviationThresholdKm) || deviationThresholdKm <= 0 || deviationThresholdKm > 50)) {
            return res.status(400).json({ success: false, error: 'deviation_threshold_km must be between 0 and 50' });
        }
        if (stopMinutesThreshold !== null && (!Number.isFinite(stopMinutesThreshold) || stopMinutesThreshold < 1 || stopMinutesThreshold > 120)) {
            return res.status(400).json({ success: false, error: 'stop_minutes_threshold must be between 1 and 120' });
        }

        const upsert = await pool.query(
            `INSERT INTO trip_route_deviation_configs (trip_id, enabled, deviation_threshold_km, stop_minutes_threshold, updated_at)
             VALUES ($1,$2,$3,$4,CURRENT_TIMESTAMP)
             ON CONFLICT (trip_id) DO UPDATE
               SET enabled = EXCLUDED.enabled,
                   deviation_threshold_km = EXCLUDED.deviation_threshold_km,
                   stop_minutes_threshold = EXCLUDED.stop_minutes_threshold,
                   updated_at = CURRENT_TIMESTAMP
             RETURNING *`,
            [tripId, enabled, deviationThresholdKm, stopMinutesThreshold]
        );

        res.json({ success: true, data: upsert.rows[0] });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

app.post('/api/trips/:id/safety/ok', requireRole('passenger', 'admin'), async (req, res) => {
    try {
        const tripId = String(req.params.id);
        const tripRes = await pool.query('SELECT * FROM trips WHERE id = $1 LIMIT 1', [tripId]);
        const tripRow = tripRes.rows[0] || null;
        const authRole = String(req.auth?.role || '').toLowerCase();
        const authUserId = req.auth?.uid;
        const access = requireTripAccess({ tripRow, authRole, authUserId, authDriverId: null });
        if (!access.ok) return res.status(access.status).json({ success: false, error: access.error });

        const insert = await pool.query(
            `INSERT INTO trip_safety_events (trip_id, created_by_role, created_by_user_id, event_type, message)
             VALUES ($1,$2,$3,'rider_ok_confirmed',NULL)
             RETURNING *`,
            [tripId, authRole, authUserId || null]
        );

        try {
            io.to(tripRoom(tripId)).emit('safety_event', { trip_id: String(tripId), event: insert.rows[0] });
        } catch (e) {
            // ignore
        }

        res.status(201).json({ success: true, data: insert.rows[0] });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

app.post('/api/trips/:id/safety/help', requireRole('passenger', 'admin'), async (req, res) => {
    try {
        const tripId = String(req.params.id);
        const tripRes = await pool.query('SELECT * FROM trips WHERE id = $1 LIMIT 1', [tripId]);
        const tripRow = tripRes.rows[0] || null;
        const authRole = String(req.auth?.role || '').toLowerCase();
        const authUserId = req.auth?.uid;
        const access = requireTripAccess({ tripRow, authRole, authUserId, authDriverId: null });
        if (!access.ok) return res.status(access.status).json({ success: false, error: access.error });

        // Ensure share link
        let token = null;
        const existing = await pool.query(
            `SELECT share_token
             FROM trip_shares
             WHERE trip_id = $1 AND (expires_at IS NULL OR expires_at > NOW())
             ORDER BY created_at DESC
             LIMIT 1`,
            [tripId]
        );
        token = existing.rows?.[0]?.share_token || null;
        if (!token) {
            token = makeShareToken();
            const expiresAt = new Date(Date.now() + 24 * 3600 * 1000);
            await pool.query(
                `INSERT INTO trip_shares (trip_id, share_token, created_by_user_id, expires_at)
                 VALUES ($1,$2,$3,$4)`,
                [tripId, token, authUserId || null, expiresAt]
            );
        }

        const insert = await pool.query(
            `INSERT INTO trip_safety_events (trip_id, created_by_role, created_by_user_id, event_type, message)
             VALUES ($1,$2,$3,'rider_help_requested',NULL)
             RETURNING *`,
            [tripId, authRole, authUserId || null]
        );

        try {
            io.to(tripRoom(tripId)).emit('safety_event', { trip_id: String(tripId), event: insert.rows[0] });
        } catch (e) {
            // ignore
        }

        const shareUrl = `/api/share/${token}`;
        const message = `⚠️ محتاج مساعدة في الرحلة ${tripId}\nتابع الرحلة هنا: ${shareUrl}`;
        res.status(201).json({ success: true, data: insert.rows[0], share_url: shareUrl, message });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// --- Pickup Handshake (phrase/code before ride start) ---

app.get('/api/trips/:id/pickup-handshake', requireRole('passenger', 'admin'), async (req, res) => {
    try {
        const tripId = String(req.params.id);
        const tripRes = await pool.query('SELECT * FROM trips WHERE id = $1 LIMIT 1', [tripId]);
        const tripRow = tripRes.rows[0] || null;
        const authRole = String(req.auth?.role || '').toLowerCase();
        const authUserId = req.auth?.uid;
        const access = requireTripAccess({ tripRow, authRole, authUserId, authDriverId: null });
        if (!access.ok) return res.status(access.status).json({ success: false, error: access.error });

        const now = Date.now();
        const windowStart = pickupHandshakeWindowStartMs(now, 10);
        const expiresAt = new Date(windowStart + 10 * 60 * 1000);
        const code = computePickupHandshakeCode({ tripId, windowStartMs: windowStart, digits: 6 });
        const codeHash = sha256Hex(`${code}:${windowStart}`);

        await pool.query(
            `UPDATE trips
             SET pickup_code_hash = $2,
                 pickup_code_expires_at = $3,
                 updated_at = CURRENT_TIMESTAMP
             WHERE id = $1`,
            [tripId, codeHash, expiresAt]
        );

        let qrPngDataUrl = null;
        try {
            qrPngDataUrl = await QRCode.toDataURL(String(code), {
                errorCorrectionLevel: 'M',
                margin: 1,
                scale: 6
            });
        } catch (e) {
            qrPngDataUrl = null;
        }

        res.json({
            success: true,
            data: {
                trip_id: tripId,
                pickup_phrase: code,
                expires_at: expiresAt,
                qr_png_data_url: qrPngDataUrl
            }
        });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

app.post('/api/trips/:id/pickup-handshake/verify', requireRole('driver', 'admin'), async (req, res) => {
    try {
        const tripId = String(req.params.id);
        const code = String(req.body?.code || '').trim();
        if (!code) return res.status(400).json({ success: false, error: 'code is required' });

        const tripRes = await pool.query('SELECT * FROM trips WHERE id = $1 LIMIT 1', [tripId]);
        const tripRow = tripRes.rows[0] || null;
        if (!tripRow) return res.status(404).json({ success: false, error: 'Trip not found' });

        const authRole = String(req.auth?.role || '').toLowerCase();
        const authDriverId = req.auth?.driver_id;

        if (authRole === 'driver') {
            if (!authDriverId) return res.status(403).json({ success: false, error: 'Driver profile not linked to this account' });
            if (String(tripRow.driver_id || '') !== String(authDriverId)) {
                return res.status(403).json({ success: false, error: 'Forbidden' });
            }
        }

        const now = Date.now();
        const windowStart = pickupHandshakeWindowStartMs(now, 10);
        const candidates = [windowStart, windowStart - 10 * 60 * 1000];
        let ok = false;
        let matchedWindow = windowStart;
        for (const ws of candidates) {
            const expected = computePickupHandshakeCode({ tripId, windowStartMs: ws, digits: 6 });
            if (String(expected) === String(code)) {
                ok = true;
                matchedWindow = ws;
                break;
            }
        }

        if (!ok) return res.status(400).json({ success: false, error: 'Invalid code' });

        const expiresAt = new Date(matchedWindow + 10 * 60 * 1000);
        const codeHash = sha256Hex(`${code}:${matchedWindow}`);
        const verifiedBy = authRole === 'driver' ? authDriverId : (tripRow.driver_id || null);

        const updated = await pool.query(
            `UPDATE trips
             SET pickup_verified_at = CURRENT_TIMESTAMP,
                 pickup_verified_by = $2,
                 pickup_code_hash = $3,
                 pickup_code_expires_at = $4,
                 updated_at = CURRENT_TIMESTAMP
             WHERE id = $1
             RETURNING id, pickup_verified_at, pickup_verified_by`,
            [tripId, verifiedBy, codeHash, expiresAt]
        );

        res.json({ success: true, data: updated.rows[0] });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// --- In-app support tickets (with optional attachment) ---

app.post('/api/support/tickets', requireAuth, upload.single('attachment'), async (req, res) => {
    try {
        const authRole = String(req.auth?.role || '').toLowerCase();
        const authUserId = req.auth?.uid;

        const tripId = req.body?.trip_id ? String(req.body.trip_id) : null;
        const category = req.body?.category ? String(req.body.category) : null;
        const description = req.body?.description !== undefined && req.body?.description !== null ? String(req.body.description) : null;

        if (!category) return res.status(400).json({ success: false, error: 'category is required' });

        if (tripId) {
            const tripRes = await pool.query('SELECT id, user_id, driver_id FROM trips WHERE id = $1 LIMIT 1', [tripId]);
            const tripRow = tripRes.rows[0] || null;
            const access = requireTripAccess({
                tripRow,
                authRole,
                authUserId,
                authDriverId: req.auth?.driver_id
            });
            if (!access.ok) return res.status(access.status).json({ success: false, error: access.error });
        }

        const attachmentPath = req.file ? `/uploads/${req.file.filename}` : null;
        const insert = await pool.query(
            `INSERT INTO support_tickets (trip_id, user_id, category, description, attachment_path)
             VALUES ($1,$2,$3,NULLIF($4,''),NULLIF($5,''))
             RETURNING *`,
            [tripId, authUserId || null, category, description || '', attachmentPath || '']
        );

        res.status(201).json({ success: true, data: insert.rows[0] });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

app.get('/api/support/me/tickets', requireRole('passenger', 'admin'), async (req, res) => {
    try {
        const authRole = String(req.auth?.role || '').toLowerCase();
        const userId = authRole === 'passenger' ? req.auth?.uid : Number(req.query.user_id);
        if (!userId) return res.status(400).json({ success: false, error: 'user_id is required' });
        const result = await pool.query(
            `SELECT st.*,
                    u.name AS user_name,
                    u.phone AS user_phone,
                    CASE
                        WHEN COALESCE(pv.status, '') = 'approved' THEN 'strong'
                        WHEN u.email_verified_at IS NOT NULL AND u.phone_verified_at IS NOT NULL THEN 'basic'
                        ELSE 'none'
                    END AS verified_level
             FROM support_tickets st
             LEFT JOIN users u ON u.id = st.user_id
             LEFT JOIN LATERAL (
                 SELECT status
                 FROM passenger_verifications
                 WHERE user_id = st.user_id
                 ORDER BY submitted_at DESC
                 LIMIT 1
             ) pv ON true
             WHERE st.user_id = $1
             ORDER BY st.created_at DESC
             LIMIT 100`,
            [userId]
        );
        res.json({ success: true, data: result.rows });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

app.get('/api/admin/support/tickets', requireRole('admin'), async (req, res) => {
    try {
        const status = req.query.status ? String(req.query.status) : null;
        const params = [];
        let where = '';
        if (status) {
            params.push(status);
            where = `WHERE status = $${params.length}`;
        }
        const result = await pool.query(
            `SELECT st.*,
                    u.name AS user_name,
                    u.phone AS user_phone,
                    u.email AS user_email,
                    CASE
                        WHEN COALESCE(pv.status, '') = 'approved' THEN 'strong'
                        WHEN u.email_verified_at IS NOT NULL AND u.phone_verified_at IS NOT NULL THEN 'basic'
                        ELSE 'none'
                    END AS verified_level
             FROM support_tickets st
             LEFT JOIN users u ON u.id = st.user_id
             LEFT JOIN LATERAL (
                 SELECT status
                 FROM passenger_verifications
                 WHERE user_id = st.user_id
                 ORDER BY submitted_at DESC
                 LIMIT 1
             ) pv ON true
             ${where}
             ORDER BY st.created_at DESC
             LIMIT 200`,
            params
        );
        res.json({ success: true, data: result.rows });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

app.patch('/api/admin/support/tickets/:id', requireRole('admin'), async (req, res) => {
    try {
        const id = Number(req.params.id);
        const nextStatus = req.body?.status ? String(req.body.status) : null;
        if (!Number.isFinite(id) || id <= 0) return res.status(400).json({ success: false, error: 'Invalid id' });
        if (!nextStatus) return res.status(400).json({ success: false, error: 'status is required' });
        const updated = await pool.query(
            `UPDATE support_tickets
             SET status = $2,
                 updated_at = CURRENT_TIMESTAMP
             WHERE id = $1
             RETURNING *`,
            [id, nextStatus]
        );
        if (updated.rows.length === 0) return res.status(404).json({ success: false, error: 'Ticket not found' });
        res.json({ success: true, data: updated.rows[0] });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// ==================== PASSENGER FEATURES (v3) ====================

// --- Saved Places ---

app.get('/api/passengers/me/places', requireRole('passenger', 'admin'), async (req, res) => {
    try {
        const authRole = String(req.auth?.role || '').toLowerCase();
        const userId = authRole === 'passenger' ? req.auth?.uid : (req.query.user_id ? Number(req.query.user_id) : null);
        if (!userId) return res.status(400).json({ success: false, error: 'user_id is required' });

        const result = await pool.query(
            `SELECT *
             FROM passenger_saved_places
             WHERE user_id = $1
             ORDER BY created_at DESC
             LIMIT 200`,
            [userId]
        );

        res.json({ success: true, data: result.rows });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

app.post('/api/passengers/me/places', requireRole('passenger', 'admin'), async (req, res) => {
    const client = await pool.connect();
    try {
        const authRole = String(req.auth?.role || '').toLowerCase();
        const userId = authRole === 'passenger' ? req.auth?.uid : (req.body?.user_id ? Number(req.body.user_id) : null);
        if (!userId) return res.status(400).json({ success: false, error: 'user_id is required' });

        const label = req.body?.label ? String(req.body.label).toLowerCase().trim() : null;
        const name = req.body?.name ? String(req.body.name).trim() : null;
        const lat = req.body?.lat !== undefined && req.body?.lat !== null ? Number(req.body.lat) : null;
        const lng = req.body?.lng !== undefined && req.body?.lng !== null ? Number(req.body.lng) : null;
        const notes = req.body?.notes !== undefined && req.body?.notes !== null ? String(req.body.notes) : null;

        if (!label || !['home', 'work', 'custom'].includes(label)) {
            return res.status(400).json({ success: false, error: 'label must be home/work/custom' });
        }
        if (!name) return res.status(400).json({ success: false, error: 'name is required' });
        if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
            return res.status(400).json({ success: false, error: 'Invalid coordinates' });
        }

        await client.query('BEGIN');

        // Home/work: replace existing row to keep one per user
        if (label === 'home' || label === 'work') {
            await client.query(
                `DELETE FROM passenger_saved_places
                 WHERE user_id = $1 AND label = $2`,
                [userId, label]
            );
        }

        const insert = await client.query(
            `INSERT INTO passenger_saved_places (user_id, label, name, lat, lng, notes)
             VALUES ($1,$2,$3,$4,$5,NULLIF($6,''))
             RETURNING *`,
            [userId, label, name, lat, lng, notes || '']
        );

        await client.query('COMMIT');
        res.status(201).json({ success: true, data: insert.rows[0] });
    } catch (err) {
        try { await client.query('ROLLBACK'); } catch (e) {}
        res.status(500).json({ success: false, error: err.message });
    } finally {
        client.release();
    }
});

app.delete('/api/passengers/me/places/:id', requireRole('passenger', 'admin'), async (req, res) => {
    try {
        const authRole = String(req.auth?.role || '').toLowerCase();
        const userId = authRole === 'passenger' ? req.auth?.uid : (req.query.user_id ? Number(req.query.user_id) : null);
        const id = Number(req.params.id);
        if (!Number.isFinite(id) || id <= 0) return res.status(400).json({ success: false, error: 'Invalid id' });
        if (authRole === 'passenger' && !userId) return res.status(401).json({ success: false, error: 'Unauthorized' });

        const params = [id];
        let where = 'WHERE id = $1';
        if (authRole === 'passenger') {
            params.push(userId);
            where += ` AND user_id = $2`;
        }

        const del = await pool.query(
            `DELETE FROM passenger_saved_places
             ${where}
             RETURNING *`,
            params
        );

        if (del.rows.length === 0) return res.status(404).json({ success: false, error: 'Place not found' });
        res.json({ success: true, data: del.rows[0] });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// --- Trip Templates ---

app.get('/api/passengers/me/trip-templates', requireRole('passenger', 'admin'), async (req, res) => {
    try {
        const authRole = String(req.auth?.role || '').toLowerCase();
        const userId = authRole === 'passenger' ? req.auth?.uid : (req.query.user_id ? Number(req.query.user_id) : null);
        if (!userId) return res.status(400).json({ success: false, error: 'user_id is required' });

        const result = await pool.query(
            `SELECT *
             FROM passenger_trip_templates
             WHERE user_id = $1
             ORDER BY created_at DESC
             LIMIT 200`,
            [userId]
        );
        res.json({ success: true, data: result.rows });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

app.post('/api/passengers/me/trip-templates', requireRole('passenger', 'admin'), async (req, res) => {
    try {
        const authRole = String(req.auth?.role || '').toLowerCase();
        const userId = authRole === 'passenger' ? req.auth?.uid : (req.body?.user_id ? Number(req.body.user_id) : null);
        if (!userId) return res.status(400).json({ success: false, error: 'user_id is required' });

        const title = req.body?.title ? String(req.body.title).trim() : null;
        const payload = req.body?.payload_json !== undefined ? req.body.payload_json : req.body?.payload;
        if (!title) return res.status(400).json({ success: false, error: 'title is required' });
        if (!payload || typeof payload !== 'object') return res.status(400).json({ success: false, error: 'payload_json must be an object' });

        const insert = await pool.query(
            `INSERT INTO passenger_trip_templates (user_id, title, payload_json)
             VALUES ($1,$2,$3::jsonb)
             RETURNING *`,
            [userId, title, JSON.stringify(payload)]
        );
        res.status(201).json({ success: true, data: insert.rows[0] });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

app.delete('/api/passengers/me/trip-templates/:id', requireRole('passenger', 'admin'), async (req, res) => {
    try {
        const authRole = String(req.auth?.role || '').toLowerCase();
        const userId = authRole === 'passenger' ? req.auth?.uid : (req.query.user_id ? Number(req.query.user_id) : null);
        const id = Number(req.params.id);
        if (!Number.isFinite(id) || id <= 0) return res.status(400).json({ success: false, error: 'Invalid id' });
        if (authRole === 'passenger' && !userId) return res.status(401).json({ success: false, error: 'Unauthorized' });

        const params = [id];
        let where = 'WHERE id = $1';
        if (authRole === 'passenger') {
            params.push(userId);
            where += ` AND user_id = $2`;
        }

        const del = await pool.query(
            `DELETE FROM passenger_trip_templates
             ${where}
             RETURNING *`,
            params
        );
        if (del.rows.length === 0) return res.status(404).json({ success: false, error: 'Template not found' });
        res.json({ success: true, data: del.rows[0] });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// --- Ride Passes ---

app.get('/api/passengers/me/passes', requireRole('passenger', 'admin'), async (req, res) => {
    try {
        const authRole = String(req.auth?.role || '').toLowerCase();
        const userId = authRole === 'passenger' ? req.auth?.uid : (req.query.user_id ? Number(req.query.user_id) : null);
        if (!userId) return res.status(400).json({ success: false, error: 'user_id is required' });

        const includeInactive = String(req.query.include_inactive || '').toLowerCase() === '1' || String(req.query.include_inactive || '').toLowerCase() === 'true';
        const params = [userId];
        let where = 'WHERE user_id = $1';
        if (!includeInactive) {
            where += " AND status = 'active'";
        }

        const result = await pool.query(
            `SELECT *
             FROM passenger_ride_passes
             ${where}
             ORDER BY COALESCE(valid_to, NOW() + INTERVAL '10 years') DESC, created_at DESC
             LIMIT 200`,
            params
        );
        res.json({ success: true, data: result.rows });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

app.post('/api/passengers/me/passes', requireRole('passenger', 'admin'), async (req, res) => {
    try {
        const authRole = String(req.auth?.role || '').toLowerCase();
        const userId = authRole === 'passenger' ? req.auth?.uid : (req.body?.user_id ? Number(req.body.user_id) : null);
        if (!userId) return res.status(400).json({ success: false, error: 'user_id is required' });

        const type = req.body?.type ? String(req.body.type).trim() : null;
        const rules = req.body?.rules_json !== undefined ? req.body.rules_json : req.body?.rules;
        const status = req.body?.status ? String(req.body.status).trim() : 'active';
        const validFrom = req.body?.valid_from ? new Date(req.body.valid_from) : null;
        const validTo = req.body?.valid_to ? new Date(req.body.valid_to) : null;

        if (!type) return res.status(400).json({ success: false, error: 'type is required' });
        if (rules !== null && rules !== undefined && typeof rules !== 'object') {
            return res.status(400).json({ success: false, error: 'rules_json must be an object' });
        }

        const insert = await pool.query(
            `INSERT INTO passenger_ride_passes (user_id, type, rules_json, valid_from, valid_to, status)
             VALUES ($1,$2,$3::jsonb,$4,$5,$6)
             RETURNING *`,
            [
                userId,
                type,
                rules ? JSON.stringify(rules) : null,
                validFrom && Number.isFinite(validFrom.getTime()) ? validFrom.toISOString() : null,
                validTo && Number.isFinite(validTo.getTime()) ? validTo.toISOString() : null,
                status
            ]
        );
        res.status(201).json({ success: true, data: insert.rows[0] });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// --- Lost & Found ---

app.post('/api/trips/:id/lost-items', requireRole('passenger', 'admin'), async (req, res) => {
    try {
        const tripId = String(req.params.id);
        const description = req.body?.description ? String(req.body.description).trim() : null;
        const contactMethod = req.body?.contact_method !== undefined && req.body?.contact_method !== null ? String(req.body.contact_method).trim() : null;
        if (!description) return res.status(400).json({ success: false, error: 'description is required' });

        const tripRes = await pool.query('SELECT id, user_id, driver_id FROM trips WHERE id = $1 LIMIT 1', [tripId]);
        const tripRow = tripRes.rows[0] || null;
        const authRole = String(req.auth?.role || '').toLowerCase();
        const authUserId = req.auth?.uid;
        const access = requireTripAccess({ tripRow, authRole, authUserId, authDriverId: null });
        if (!access.ok) return res.status(access.status).json({ success: false, error: access.error });

        const insert = await pool.query(
            `INSERT INTO lost_items (trip_id, user_id, description, contact_method)
             VALUES ($1,$2,$3,NULLIF($4,''))
             RETURNING *`,
            [tripId, tripRow.user_id || authUserId || null, description, contactMethod || '']
        );
        res.status(201).json({ success: true, data: insert.rows[0] });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

app.get('/api/support/me/lost-items', requireRole('passenger', 'admin'), async (req, res) => {
    try {
        const authRole = String(req.auth?.role || '').toLowerCase();
        const userId = authRole === 'passenger' ? req.auth?.uid : (req.query.user_id ? Number(req.query.user_id) : null);
        if (!userId) return res.status(400).json({ success: false, error: 'user_id is required' });

        const result = await pool.query(
            `SELECT li.*, t.pickup_location, t.dropoff_location, t.status AS trip_status
             FROM lost_items li
             LEFT JOIN trips t ON t.id = li.trip_id
             WHERE li.user_id = $1
             ORDER BY li.created_at DESC
             LIMIT 200`,
            [userId]
        );
        res.json({ success: true, data: result.rows });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

app.get('/api/admin/lost-items', requireRole('admin'), async (req, res) => {
    try {
        const status = req.query.status ? String(req.query.status) : null;
        const params = [];
        let where = '';
        if (status) {
            params.push(status);
            where = `WHERE li.status = $${params.length}`;
        }

        const result = await pool.query(
            `SELECT li.*, u.name AS user_name, u.phone AS user_phone, u.email AS user_email,
                    t.pickup_location, t.dropoff_location, t.status AS trip_status
             FROM lost_items li
             LEFT JOIN users u ON u.id = li.user_id
             LEFT JOIN trips t ON t.id = li.trip_id
             ${where}
             ORDER BY li.created_at DESC
             LIMIT 500`,
            params
        );
        res.json({ success: true, data: result.rows });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

app.patch('/api/admin/lost-items/:id', requireRole('admin'), async (req, res) => {
    try {
        const id = Number(req.params.id);
        const nextStatus = req.body?.status ? String(req.body.status) : null;
        if (!Number.isFinite(id) || id <= 0) return res.status(400).json({ success: false, error: 'Invalid id' });
        if (!nextStatus) return res.status(400).json({ success: false, error: 'status is required' });

        const updated = await pool.query(
            `UPDATE lost_items
             SET status = $2,
                 updated_at = CURRENT_TIMESTAMP
             WHERE id = $1
             RETURNING *`,
            [id, nextStatus]
        );
        if (updated.rows.length === 0) return res.status(404).json({ success: false, error: 'Lost item not found' });
        res.json({ success: true, data: updated.rows[0] });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// --- Refund Requests ---

app.post('/api/trips/:id/refund-request', requireRole('passenger', 'admin'), async (req, res) => {
    try {
        const tripId = String(req.params.id);
        const reason = req.body?.reason ? String(req.body.reason).trim() : null;
        const amountRequested = req.body?.amount_requested !== undefined && req.body?.amount_requested !== null ? Number(req.body.amount_requested) : null;
        if (!reason) return res.status(400).json({ success: false, error: 'reason is required' });
        if (amountRequested !== null && (!Number.isFinite(amountRequested) || amountRequested < 0)) {
            return res.status(400).json({ success: false, error: 'Invalid amount_requested' });
        }

        const tripRes = await pool.query('SELECT id, user_id, driver_id FROM trips WHERE id = $1 LIMIT 1', [tripId]);
        const tripRow = tripRes.rows[0] || null;
        const authRole = String(req.auth?.role || '').toLowerCase();
        const authUserId = req.auth?.uid;
        const access = requireTripAccess({ tripRow, authRole, authUserId, authDriverId: null });
        if (!access.ok) return res.status(access.status).json({ success: false, error: access.error });

        const insert = await pool.query(
            `INSERT INTO refund_requests (trip_id, user_id, reason, amount_requested)
             VALUES ($1,$2,$3,$4)
             ON CONFLICT (trip_id, user_id)
             DO UPDATE SET
                reason = EXCLUDED.reason,
                amount_requested = EXCLUDED.amount_requested,
                updated_at = CURRENT_TIMESTAMP
             RETURNING *`,
            [tripId, tripRow.user_id || authUserId || null, reason, amountRequested]
        );
        res.status(201).json({ success: true, data: insert.rows[0] });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

app.get('/api/support/me/refund-requests', requireRole('passenger', 'admin'), async (req, res) => {
    try {
        const authRole = String(req.auth?.role || '').toLowerCase();
        const userId = authRole === 'passenger' ? req.auth?.uid : (req.query.user_id ? Number(req.query.user_id) : null);
        if (!userId) return res.status(400).json({ success: false, error: 'user_id is required' });

        const result = await pool.query(
            `SELECT rr.*, t.pickup_location, t.dropoff_location, t.status AS trip_status
             FROM refund_requests rr
             LEFT JOIN trips t ON t.id = rr.trip_id
             WHERE rr.user_id = $1
             ORDER BY rr.created_at DESC
             LIMIT 200`,
            [userId]
        );
        res.json({ success: true, data: result.rows });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

app.get('/api/admin/refund-requests', requireRole('admin'), async (req, res) => {
    try {
        const status = req.query.status ? String(req.query.status) : null;
        const params = [];
        let where = '';
        if (status) {
            params.push(status);
            where = `WHERE rr.status = $${params.length}`;
        }

        const result = await pool.query(
            `SELECT rr.*, u.name AS user_name, u.phone AS user_phone, u.email AS user_email,
                    t.pickup_location, t.dropoff_location, t.status AS trip_status
             FROM refund_requests rr
             LEFT JOIN users u ON u.id = rr.user_id
             LEFT JOIN trips t ON t.id = rr.trip_id
             ${where}
             ORDER BY rr.created_at DESC
             LIMIT 500`,
            params
        );
        res.json({ success: true, data: result.rows });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

app.patch('/api/admin/refund-requests/:id', requireRole('admin'), async (req, res) => {
    const client = await pool.connect();
    try {
        const id = Number(req.params.id);
        const nextStatus = req.body?.status ? String(req.body.status).toLowerCase() : null;
        const resolutionNote = req.body?.resolution_note !== undefined && req.body?.resolution_note !== null ? String(req.body.resolution_note) : null;
        const approvedAmount = req.body?.amount_approved !== undefined && req.body?.amount_approved !== null ? Number(req.body.amount_approved) : null;

        if (!Number.isFinite(id) || id <= 0) return res.status(400).json({ success: false, error: 'Invalid id' });
        if (!nextStatus || !['pending', 'approved', 'rejected'].includes(nextStatus)) {
            return res.status(400).json({ success: false, error: 'status must be pending/approved/rejected' });
        }

        await client.query('BEGIN');

        const rrRes = await client.query(
            `SELECT *
             FROM refund_requests
             WHERE id = $1
             FOR UPDATE`,
            [id]
        );
        const rr = rrRes.rows[0] || null;
        if (!rr) {
            await client.query('ROLLBACK');
            return res.status(404).json({ success: false, error: 'Refund request not found' });
        }

        const userId = rr.user_id ? Number(rr.user_id) : null;
        const amountBase = rr.amount_requested !== null && rr.amount_requested !== undefined ? Number(rr.amount_requested) : null;
        const amountToCredit = nextStatus === 'approved'
            ? (approvedAmount !== null && approvedAmount !== undefined ? approvedAmount : amountBase)
            : null;

        if (nextStatus === 'approved') {
            if (!userId) {
                throw new Error('refund_request_missing_user');
            }
            if (!Number.isFinite(amountToCredit) || amountToCredit <= 0) {
                throw new Error('invalid_approved_amount');
            }

            await client.query(
                `INSERT INTO wallet_transactions (
                    owner_type, owner_id, amount, currency, reason, reference_type, reference_id, created_by_user_id, created_by_role
                 ) VALUES ('user', $1, $2, 'SAR', $3, 'refund', $4, $5, 'admin')
                 ON CONFLICT DO NOTHING`,
                [
                    userId,
                    Math.abs(amountToCredit),
                    `Refund for trip ${String(rr.trip_id || '')}`,
                    `refund:${String(id)}`,
                    req.auth?.uid || null
                ]
            );

            // Backward-compat cached balance
            await client.query(
                `UPDATE users
                 SET balance = COALESCE(balance, 0) + $1,
                     updated_at = CURRENT_TIMESTAMP
                 WHERE id = $2`,
                [Math.abs(amountToCredit), userId]
            );
        }

        const updated = await client.query(
            `UPDATE refund_requests
             SET status = $2,
                 resolution_note = NULLIF($3,''),
                 reviewed_by = $4,
                 updated_at = CURRENT_TIMESTAMP
             WHERE id = $1
             RETURNING *`,
            [id, nextStatus, resolutionNote || '', req.auth?.uid || null]
        );

        await client.query('COMMIT');
        res.json({ success: true, data: updated.rows[0] });
    } catch (err) {
        try { await client.query('ROLLBACK'); } catch (e) {}
        res.status(500).json({ success: false, error: err.message });
    } finally {
        client.release();
    }
});

// --- Tipping (after trip) ---

app.post('/api/trips/:id/tip', requireRole('passenger', 'admin'), async (req, res) => {
    const client = await pool.connect();
    try {
        const tripId = String(req.params.id);
        const authRole = String(req.auth?.role || '').toLowerCase();
        const authUserId = req.auth?.uid;

        const amount = req.body?.amount !== undefined && req.body?.amount !== null ? Number(req.body.amount) : null;
        const method = req.body?.method ? String(req.body.method).toLowerCase() : 'cash';
        if (!Number.isFinite(amount) || amount <= 0) return res.status(400).json({ success: false, error: 'amount must be > 0' });
        if (!['cash', 'wallet'].includes(method)) return res.status(400).json({ success: false, error: 'method must be cash/wallet' });

        const tripRes = await client.query(
            `SELECT id, user_id, driver_id, status
             FROM trips
             WHERE id = $1
             LIMIT 1
             FOR UPDATE`,
            [tripId]
        );
        const tripRow = tripRes.rows[0] || null;
        const access = requireTripAccess({ tripRow, authRole, authUserId, authDriverId: null });
        if (!access.ok) return res.status(access.status).json({ success: false, error: access.error });
        if (!tripRow) return res.status(404).json({ success: false, error: 'Trip not found' });
        if (String(tripRow.status || '').toLowerCase() !== 'completed') {
            return res.status(409).json({ success: false, error: 'Tip is allowed after trip completion only' });
        }
        if (!tripRow.driver_id) {
            return res.status(409).json({ success: false, error: 'Trip has no driver' });
        }

        await client.query('BEGIN');

        const inserted = await client.query(
            `INSERT INTO trip_tips (trip_id, user_id, driver_id, amount, method)
             VALUES ($1,$2,$3,$4,$5)
             ON CONFLICT (trip_id, user_id)
             DO NOTHING
             RETURNING *`,
            [tripId, tripRow.user_id || authUserId, tripRow.driver_id, amount, method]
        );

        // If already tipped, return existing
        let tipRow = inserted.rows[0] || null;
        if (!tipRow) {
            const existing = await client.query(
                `SELECT * FROM trip_tips WHERE trip_id = $1 AND user_id = $2 LIMIT 1`,
                [tripId, tripRow.user_id || authUserId]
            );
            tipRow = existing.rows[0] || null;
            await client.query('ROLLBACK');
            return res.status(200).json({ success: true, data: tipRow, meta: { deduped: true } });
        }

        if (method === 'wallet') {
            const owner = { owner_type: 'user', owner_id: Number(tripRow.user_id || authUserId) };
            const balance = await getWalletBalance(client, owner);
            if (balance < amount) {
                throw new Error('Insufficient wallet balance');
            }

            await client.query(
                `INSERT INTO wallet_transactions (
                    owner_type, owner_id, amount, currency, reason, reference_type, reference_id, created_by_user_id, created_by_role
                 ) VALUES ('user', $1, $2, 'SAR', $3, 'tip', $4, $5, $6)
                 ON CONFLICT DO NOTHING`,
                [
                    owner.owner_id,
                    -Math.abs(amount),
                    `Tip for trip ${tripId}`,
                    `tip:${tripId}`,
                    owner.owner_id,
                    authRole
                ]
            );

            // Backward-compat cached balance
            await client.query(
                `UPDATE users
                 SET balance = COALESCE(balance, 0) - $1,
                     updated_at = CURRENT_TIMESTAMP
                 WHERE id = $2`,
                [Math.abs(amount), owner.owner_id]
            );
        }

        // Credit driver earnings/balance (best-effort)
        await client.query(
            `UPDATE drivers
             SET total_earnings = COALESCE(total_earnings, 0) + $1,
                 balance = COALESCE(balance, 0) + $1,
                 today_earnings = COALESCE(today_earnings, 0) + $1,
                 updated_at = CURRENT_TIMESTAMP
             WHERE id = $2`,
            [Math.abs(amount), tripRow.driver_id]
        );

        await client.query('COMMIT');
        res.status(201).json({ success: true, data: tipRow });
    } catch (err) {
        try { await client.query('ROLLBACK'); } catch (e) {}
        res.status(500).json({ success: false, error: err.message });
    } finally {
        client.release();
    }
});

// --- Smart Rebook ---

app.post('/api/trips/:id/rebook', requireRole('passenger', 'admin'), async (req, res) => {
    try {
        const tripId = String(req.params.id);
        const tripRes = await pool.query('SELECT * FROM trips WHERE id = $1 LIMIT 1', [tripId]);
        const tripRow = tripRes.rows[0] || null;

        const authRole = String(req.auth?.role || '').toLowerCase();
        const authUserId = req.auth?.uid;
        const access = requireTripAccess({ tripRow, authRole, authUserId, authDriverId: null });
        if (!access.ok) return res.status(access.status).json({ success: false, error: access.error });
        if (!tripRow) return res.status(404).json({ success: false, error: 'Trip not found' });

        const st = String(tripRow.status || '').toLowerCase();
        if (!(st === 'cancelled' || st === 'pending')) {
            return res.status(409).json({ success: false, error: 'Rebook is allowed for cancelled/timeout trips only' });
        }

        const newTripId = `TR-${Date.now()}`;
        const baseCost = tripRow.cost !== undefined && tripRow.cost !== null ? Number(tripRow.cost) : 0;

        const created = await pool.query(
            `INSERT INTO trips (
                id, user_id, rider_id, driver_id,
                pickup_location, dropoff_location,
                pickup_lat, pickup_lng, pickup_accuracy, pickup_timestamp,
                dropoff_lat, dropoff_lng,
                car_type, cost, price,
                distance, distance_km, duration, duration_minutes,
                payment_method, status, driver_name, source,
                pickup_hub_id, passenger_note, booked_for_family_member_id, price_lock_id, quiet_mode
            ) VALUES (
                $1,$2,$3,NULL,
                $4,$5,
                $6,$7,NULL,NULL,
                $8,$9,
                $10,$11,$11,
                $12,$12,$13,$13,
                $14,'pending',NULL,'rebook',
                $15,$16,$17,NULL,$18
            )
            RETURNING *`,
            [
                newTripId,
                tripRow.user_id,
                tripRow.user_id,
                tripRow.pickup_location,
                tripRow.dropoff_location,
                tripRow.pickup_lat,
                tripRow.pickup_lng,
                tripRow.dropoff_lat,
                tripRow.dropoff_lng,
                tripRow.car_type || 'economy',
                Number.isFinite(baseCost) ? baseCost : 0,
                tripRow.distance_km !== undefined && tripRow.distance_km !== null ? Number(tripRow.distance_km) : (tripRow.distance !== undefined && tripRow.distance !== null ? Number(tripRow.distance) : null),
                tripRow.duration_minutes !== undefined && tripRow.duration_minutes !== null ? Number(tripRow.duration_minutes) : (tripRow.duration !== undefined && tripRow.duration !== null ? Number(tripRow.duration) : null),
                tripRow.payment_method || 'cash',
                tripRow.pickup_hub_id || null,
                tripRow.passenger_note || null,
                tripRow.booked_for_family_member_id || null,
                !!tripRow.quiet_mode
            ]
        );

        const newTrip = created.rows[0];

        // Realtime: notify passenger room
        try {
            if (newTrip?.user_id) {
                io.to(userRoom(newTrip.user_id)).emit('trip_rebooked', {
                    old_trip_id: tripId,
                    new_trip_id: String(newTrip.id),
                    status: 'pending'
                });
            }
        } catch (e) {
            // ignore
        }

        res.status(201).json({ success: true, data: newTrip });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// --- Receipts ---

app.get('/api/trips/:id/receipt', requireAuth, async (req, res) => {
    try {
        const tripId = String(req.params.id);
        const tripRes = await pool.query(
            `SELECT t.*, u.name AS passenger_name, u.phone AS passenger_phone, COALESCE(t.driver_name, d.name) AS driver_name
             FROM trips t
             LEFT JOIN users u ON u.id = t.user_id
             LEFT JOIN drivers d ON d.id = t.driver_id
             WHERE t.id = $1
             LIMIT 1`,
            [tripId]
        );
        const tripRow = tripRes.rows[0] || null;
        const authRole = String(req.auth?.role || '').toLowerCase();
        const authUserId = req.auth?.uid;
        const authDriverId = req.auth?.driver_id;
        const access = requireTripAccess({ tripRow, authRole, authUserId, authDriverId });
        if (!access.ok) return res.status(access.status).json({ success: false, error: access.error });

        const split = await pool.query(
            `SELECT payer_user_id, amount, method, status, paid_at
             FROM trip_split_payments
             WHERE trip_id = $1
             ORDER BY created_at ASC`,
            [tripId]
        );

        const tips = await pool.query(
            `SELECT id, user_id, driver_id, amount, method, created_at
             FROM trip_tips
             WHERE trip_id = $1
             ORDER BY created_at ASC`,
            [tripId]
        );

        res.json({
            success: true,
            data: {
                trip: tripRow,
                split_fare: split.rows,
                tips: tips.rows,
                discount: {
                    ride_pass_id: tripRow.ride_pass_id || null,
                    fare_before_discount: tripRow.fare_before_discount !== undefined ? tripRow.fare_before_discount : null,
                    discount_amount: tripRow.discount_amount !== undefined ? tripRow.discount_amount : null,
                    discount_meta: tripRow.discount_meta_json || null
                }
            }
        });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// ==================== OFFERS ENDPOINTS ====================

app.get('/api/offers', async (req, res) => {
    try {
        const { active = '1' } = req.query;
        const params = [];
        let query = 'SELECT * FROM offers';

        if (active === '1' || active === 'true') {
            query += ' WHERE is_active = true';
        }

        query += ' ORDER BY created_at DESC';
        const result = await pool.query(query, params);
        res.json({ success: true, data: result.rows, count: result.rows.length });
    } catch (err) {
        console.error('Error fetching offers:', err);
        res.status(500).json({ success: false, error: err.message });
    }
});

app.get('/api/offers/validate', async (req, res) => {
    try {
        const code = (req.query.code || '').toString().trim().toUpperCase();
        if (!code) {
            return res.status(400).json({ success: false, error: 'Offer code is required' });
        }

        const result = await pool.query(
            `SELECT * FROM offers
             WHERE UPPER(code) = $1 AND is_active = true
             LIMIT 1`,
            [code]
        );

        if (result.rows.length === 0) {
            return res.status(404).json({ success: false, error: 'Offer not found or inactive' });
        }

        const offer = result.rows[0];

        // Optional: eligibility rules (Offer Eligibility linked to behavior)
        const metric = offer.eligibility_metric ? String(offer.eligibility_metric) : '';
        const min = offer.eligibility_min !== undefined && offer.eligibility_min !== null ? Number(offer.eligibility_min) : null;

        if (metric && Number.isFinite(min) && min > 0) {
            const authRole = String(req.auth?.role || '').toLowerCase();
            const uid = req.auth?.uid;
            if (!uid || authRole !== 'passenger') {
                return res.status(401).json({ success: false, error: 'Unauthorized', code: 'offer_eligibility_requires_auth' });
            }

            let current = 0;
            if (metric === 'hub_compliance_trips') {
                const stats = await pool.query(
                    `SELECT hub_compliance_trips
                     FROM passenger_loyalty_stats
                     WHERE user_id = $1
                     LIMIT 1`,
                    [uid]
                );
                current = Number(stats.rows?.[0]?.hub_compliance_trips || 0);
            } else {
                return res.status(400).json({ success: false, error: 'Unsupported eligibility metric', code: 'unsupported_eligibility_metric' });
            }

            if (!Number.isFinite(current)) current = 0;
            if (current < min) {
                return res.status(403).json({
                    success: false,
                    error: 'Not eligible for this offer',
                    code: 'offer_not_eligible',
                    required: { metric, min },
                    current
                });
            }
        }

        res.json({ success: true, data: offer });
    } catch (err) {
        console.error('Error validating offer:', err);
        res.status(500).json({ success: false, error: err.message });
    }
});

// ==================== TRIPS ENDPOINTS ====================

// Get all trips with filtering
app.get('/api/trips', requireAuth, async (req, res) => {
    try {
        const { status, user_id, source, limit = 50, offset = 0 } = req.query;

        const authRole = String(req.auth?.role || '').toLowerCase();
        const authUserId = req.auth?.uid;
        const authDriverId = req.auth?.driver_id;

        const effectiveUserId = authRole === 'passenger' ? authUserId : user_id;
        const effectiveDriverId = authRole === 'driver' ? authDriverId : null;

        if (authRole === 'driver' && !effectiveDriverId) {
            return res.status(403).json({ success: false, error: 'Driver profile not linked to this account' });
        }
        
        let query = 'SELECT * FROM trips WHERE 1=1';
        const params = [];
        let paramCount = 0;
        
        if (status && status !== 'all') {
            paramCount++;
            query += ` AND status = $${paramCount}`;
            params.push(status);
        }
        
        if (effectiveUserId) {
            paramCount++;
            query += ` AND user_id = $${paramCount}`;
            params.push(effectiveUserId);
        }

        if (effectiveDriverId) {
            paramCount++;
            query += ` AND driver_id = $${paramCount}`;
            params.push(effectiveDriverId);
        }

        if (source && source !== 'all') {
            paramCount++;
            query += ` AND source = $${paramCount}`;
            params.push(source);
        }
        
        query += ' ORDER BY created_at DESC';
        
        paramCount++;
        query += ` LIMIT $${paramCount}`;
        params.push(limit);
        
        paramCount++;
        query += ` OFFSET $${paramCount}`;
        params.push(offset);
        
        const result = await pool.query(query, params);
        
        // Get total count
        let countQuery = 'SELECT COUNT(*) FROM trips WHERE 1=1';
        const countParams = [];
        let countParamIndex = 0;
        
        if (status && status !== 'all') {
            countParamIndex++;
            countQuery += ` AND status = $${countParamIndex}`;
            countParams.push(status);
        }
        
        if (effectiveUserId) {
            countParamIndex++;
            countQuery += ` AND user_id = $${countParamIndex}`;
            countParams.push(effectiveUserId);
        }

        if (effectiveDriverId) {
            countParamIndex++;
            countQuery += ` AND driver_id = $${countParamIndex}`;
            countParams.push(effectiveDriverId);
        }

        if (source && source !== 'all') {
            countParamIndex++;
            countQuery += ` AND source = $${countParamIndex}`;
            countParams.push(source);
        }
        
        const countResult = await pool.query(countQuery, countParams);
        const total = parseInt(countResult.rows[0].count);
        
        res.json({
            success: true,
            data: result.rows,
            total: total,
            limit: parseInt(limit),
            offset: parseInt(offset)
        });
    } catch (err) {
        console.error('Error fetching trips:', err);
        res.status(500).json({ success: false, error: err.message });
    }
});

// Get completed trips
app.get('/api/trips/completed', requireAuth, async (req, res) => {
    try {
        const { user_id, source, limit = 50, offset = 0 } = req.query;

        const authRole = String(req.auth?.role || '').toLowerCase();
        const authUserId = req.auth?.uid;
        const authDriverId = req.auth?.driver_id;

        const effectiveUserId = authRole === 'passenger' ? authUserId : user_id;
        const effectiveDriverId = authRole === 'driver' ? authDriverId : null;

        if (authRole === 'driver' && !effectiveDriverId) {
            return res.status(403).json({ success: false, error: 'Driver profile not linked to this account' });
        }
        
        let query = `
            SELECT * FROM trips 
            WHERE status = 'completed'
        `;
        const params = [];
        
        if (effectiveUserId) {
            query += ' AND user_id = $1';
            params.push(effectiveUserId);
        }

        if (effectiveDriverId) {
            query += ` AND driver_id = $${params.length + 1}`;
            params.push(effectiveDriverId);
        }

        if (source && source !== 'all') {
            query += ` AND source = $${params.length + 1}`;
            params.push(source);
        }
        
        query += ' ORDER BY completed_at DESC LIMIT $' + (params.length + 1) + ' OFFSET $' + (params.length + 2);
        params.push(limit, offset);
        
        const result = await pool.query(query, params);
        
        res.json({
            success: true,
            data: result.rows,
            count: result.rows.length
        });
    } catch (err) {
        console.error('Error fetching completed trips:', err);
        res.status(500).json({ success: false, error: err.message });
    }
});

// Get live trip snapshot (trip + driver's last known location)
app.get('/api/trips/:id/live', requireAuth, async (req, res) => {
    try {
        const { id } = req.params;

        const result = await pool.query(
            `SELECT
                t.*,
                d.last_lat AS driver_last_lat,
                d.last_lng AS driver_last_lng,
                d.last_location_at AS driver_last_location_at,
                d.name AS driver_live_name,
                d.status AS driver_live_status
             FROM trips t
             LEFT JOIN drivers d ON d.id = t.driver_id
             WHERE t.id = $1
             LIMIT 1`,
            [id]
        );

        if (result.rows.length === 0) {
            return res.status(404).json({ success: false, error: 'Trip not found' });
        }

        const trip = result.rows[0];
        const authRole = String(req.auth?.role || '').toLowerCase();
        const authUserId = req.auth?.uid;
        const authDriverId = req.auth?.driver_id;

        if (authRole === 'passenger' && String(trip.user_id) !== String(authUserId)) {
            return res.status(403).json({ success: false, error: 'Forbidden' });
        }
        if (authRole === 'driver') {
            if (!authDriverId) return res.status(403).json({ success: false, error: 'Driver profile not linked to this account' });
            if (String(trip.driver_id || '') !== String(authDriverId)) {
                return res.status(403).json({ success: false, error: 'Forbidden' });
            }
        }

        res.json({ success: true, data: trip });
    } catch (err) {
        console.error('Error fetching live trip:', err);
        res.status(500).json({ success: false, error: err.message });
    }
});

// Get cancelled trips
app.get('/api/trips/cancelled', requireAuth, async (req, res) => {
    try {
        const { user_id, source, limit = 50, offset = 0 } = req.query;

        const authRole = String(req.auth?.role || '').toLowerCase();
        const authUserId = req.auth?.uid;
        const authDriverId = req.auth?.driver_id;

        const effectiveUserId = authRole === 'passenger' ? authUserId : user_id;
        const effectiveDriverId = authRole === 'driver' ? authDriverId : null;

        if (authRole === 'driver' && !effectiveDriverId) {
            return res.status(403).json({ success: false, error: 'Driver profile not linked to this account' });
        }
        
        let query = `
            SELECT * FROM trips 
            WHERE status = 'cancelled'
        `;
        const params = [];
        
        if (effectiveUserId) {
            query += ' AND user_id = $1';
            params.push(effectiveUserId);
        }

        if (effectiveDriverId) {
            query += ` AND driver_id = $${params.length + 1}`;
            params.push(effectiveDriverId);
        }

        if (source && source !== 'all') {
            query += ` AND source = $${params.length + 1}`;
            params.push(source);
        }
        
        query += ' ORDER BY cancelled_at DESC LIMIT $' + (params.length + 1) + ' OFFSET $' + (params.length + 2);
        params.push(limit, offset);
        
        const result = await pool.query(query, params);
        
        res.json({
            success: true,
            data: result.rows,
            count: result.rows.length
        });
    } catch (err) {
        console.error('Error fetching cancelled trips:', err);
        res.status(500).json({ success: false, error: err.message });
    }
});

// Get single trip by ID
app.get('/api/trips/:id', requireAuth, async (req, res) => {
    try {
        const { id } = req.params;
        const result = await pool.query('SELECT * FROM trips WHERE id = $1', [id]);
        
        if (result.rows.length === 0) {
            return res.status(404).json({ success: false, error: 'Trip not found' });
        }
        
        const trip = result.rows[0];
        const authRole = String(req.auth?.role || '').toLowerCase();
        const authUserId = req.auth?.uid;
        const authDriverId = req.auth?.driver_id;

        if (authRole === 'passenger' && String(trip.user_id) !== String(authUserId)) {
            return res.status(403).json({ success: false, error: 'Forbidden' });
        }
        if (authRole === 'driver') {
            if (!authDriverId) return res.status(403).json({ success: false, error: 'Driver profile not linked to this account' });
            if (String(trip.driver_id || '') !== String(authDriverId)) {
                return res.status(403).json({ success: false, error: 'Forbidden' });
            }
        }

        res.json({ success: true, data: trip });
    } catch (err) {
        console.error('Error fetching trip:', err);
        res.status(500).json({ success: false, error: err.message });
    }
});

// Create new trip
app.post('/api/trips', requireRole('passenger', 'admin'), async (req, res) => {
    try {
        const {
            id,
            user_id,
            rider_id,
            driver_id,
            pickup_location,
            dropoff_location,
            pickup_lat,
            pickup_lng,
            pickup_accuracy,
            pickup_timestamp,
            dropoff_lat,
            dropoff_lng,
            pickup_hub_id,
            passenger_note,
            passenger_note_template_id,
            booked_for_family_member_id,
            price_lock_id,
            quiet_mode,
            car_type = 'economy',
            cost,
            price,
            distance,
            distance_km,
            duration,
            duration_minutes,
            payment_method = 'cash',
            status = 'pending',
            driver_name,
            source = 'passenger_app'
        } = req.body;

        const authRole = String(req.auth?.role || '').toLowerCase();
        const authUserId = req.auth?.uid;

        if (authRole === 'passenger') {
            // Prevent creating trips on behalf of another user
            if (user_id && String(user_id) !== String(authUserId)) {
                return res.status(403).json({ success: false, error: 'Forbidden' });
            }
        }

        const effectiveRiderId = authRole === 'passenger' ? authUserId : (rider_id || user_id);

        // Accessibility Snapshot (v2): copy profile state into trip at creation
        let accessibilitySnapshot = null;
        try {
            if (effectiveRiderId) {
                const profRes = await pool.query(
                    `SELECT voice_prompts, text_first, no_calls, wheelchair, extra_time, simple_language, notes, updated_at
                     FROM passenger_accessibility_profiles
                     WHERE user_id = $1
                     LIMIT 1`,
                    [effectiveRiderId]
                );
                const prof = profRes.rows[0] || null;
                if (prof) {
                    const snapshot = {
                        voice_prompts: !!prof.voice_prompts,
                        text_first: !!prof.text_first,
                        no_calls: !!prof.no_calls,
                        wheelchair: !!prof.wheelchair,
                        extra_time: !!prof.extra_time,
                        simple_language: !!prof.simple_language,
                        notes: prof.notes ? String(prof.notes) : null,
                        source: 'passenger_accessibility_profiles',
                        profile_updated_at: prof.updated_at || null
                    };
                    const hasAny =
                        snapshot.voice_prompts || snapshot.text_first || snapshot.no_calls ||
                        snapshot.wheelchair || snapshot.extra_time || snapshot.simple_language ||
                        (snapshot.notes && snapshot.notes.trim());
                    accessibilitySnapshot = hasAny ? snapshot : null;
                }
            }
        } catch (e) {
            accessibilitySnapshot = null;
        }

        // Optional: passenger note from template
        let effectivePassengerNote = passenger_note !== undefined && passenger_note !== null ? String(passenger_note) : null;
        if (!effectivePassengerNote && passenger_note_template_id !== undefined && passenger_note_template_id !== null) {
            const tplId = Number(passenger_note_template_id);
            if (Number.isFinite(tplId) && tplId > 0) {
                const tplRes = await pool.query(
                    `SELECT note
                     FROM passenger_note_templates
                     WHERE id = $1 AND user_id = $2
                     LIMIT 1`,
                    [tplId, effectiveRiderId]
                );
                if (tplRes.rows.length > 0) {
                    effectivePassengerNote = tplRes.rows[0].note ? String(tplRes.rows[0].note) : null;
                }
            }
        }

        // Optional: family member booking
        let familyMember = null;
        const familyMemberId = booked_for_family_member_id !== undefined && booked_for_family_member_id !== null
            ? Number(booked_for_family_member_id)
            : null;
        if (Number.isFinite(familyMemberId) && familyMemberId > 0) {
            const famRes = await pool.query(
                `SELECT id, name, phone, daily_limit, weekly_limit
                 FROM passenger_family_members
                 WHERE id = $1 AND owner_user_id = $2 AND is_active = true
                 LIMIT 1`,
                [familyMemberId, effectiveRiderId]
            );
            familyMember = famRes.rows[0] || null;
            if (!familyMember) {
                return res.status(404).json({ success: false, error: 'Family member not found' });
            }
        }

        const quietModeEnabled = quiet_mode !== undefined ? Boolean(quiet_mode) : false;

        // Comfort: Quiet Mode auto-note (if user didn't provide any note/template)
        if (quietModeEnabled && !effectivePassengerNote) {
            effectivePassengerNote = 'Quiet Mode: من فضلك بدون مكالمات/رسائل إلا للطوارئ.';
        }

        // Optional: price lock validation
        let effectiveCost = price !== undefined && price !== null ? price : cost;
        const priceLockId = price_lock_id !== undefined && price_lock_id !== null ? Number(price_lock_id) : null;
        let lockedPriceRow = null;
        if (Number.isFinite(priceLockId) && priceLockId > 0) {
            const lockRes = await pool.query(
                `SELECT *
                 FROM price_locks
                 WHERE id = $1 AND user_id = $2
                 LIMIT 1`,
                [priceLockId, effectiveRiderId]
            );
            lockedPriceRow = lockRes.rows[0] || null;
            if (!lockedPriceRow) {
                return res.status(404).json({ success: false, error: 'Price lock not found' });
            }
            if (lockedPriceRow.used_trip_id) {
                return res.status(409).json({ success: false, error: 'Price lock already used' });
            }
            if (lockedPriceRow.expires_at && new Date(lockedPriceRow.expires_at).getTime() < Date.now()) {
                return res.status(410).json({ success: false, error: 'Price lock expired' });
            }
            effectiveCost = Number(lockedPriceRow.price);
        }

        // Enforce family member spending limits (daily/weekly)
        if (familyMember) {
            const dailyLimit = familyMember.daily_limit !== null && familyMember.daily_limit !== undefined ? Number(familyMember.daily_limit) : null;
            const weeklyLimit = familyMember.weekly_limit !== null && familyMember.weekly_limit !== undefined ? Number(familyMember.weekly_limit) : null;
            const tripCost = effectiveCost !== undefined && effectiveCost !== null ? Number(effectiveCost) : null;

            if (Number.isFinite(tripCost) && tripCost > 0 && (Number.isFinite(dailyLimit) || Number.isFinite(weeklyLimit))) {
                const daySpentRes = await pool.query(
                    `SELECT COALESCE(SUM(COALESCE(cost, price, 0)), 0) AS total
                     FROM trips
                     WHERE booked_for_family_member_id = $1
                       AND status <> 'cancelled'
                       AND created_at >= date_trunc('day', NOW())`,
                    [Number(familyMember.id)]
                );
                const weekSpentRes = await pool.query(
                    `SELECT COALESCE(SUM(COALESCE(cost, price, 0)), 0) AS total
                     FROM trips
                     WHERE booked_for_family_member_id = $1
                       AND status <> 'cancelled'
                       AND created_at >= date_trunc('week', NOW())`,
                    [Number(familyMember.id)]
                );

                const dailySpent = Number(daySpentRes.rows?.[0]?.total || 0);
                const weeklySpent = Number(weekSpentRes.rows?.[0]?.total || 0);

                const dailyRemaining = Number.isFinite(dailyLimit) ? Math.max(0, dailyLimit - dailySpent) : null;
                const weeklyRemaining = Number.isFinite(weeklyLimit) ? Math.max(0, weeklyLimit - weeklySpent) : null;

                const dailyOk = dailyRemaining === null ? true : tripCost <= dailyRemaining;
                const weeklyOk = weeklyRemaining === null ? true : tripCost <= weeklyRemaining;

                if (!dailyOk || !weeklyOk) {
                    return res.status(409).json({
                        success: false,
                        error: 'Family member budget exceeded',
                        code: 'family_budget_exceeded',
                        data: {
                            member_id: Number(familyMember.id),
                            trip_cost: tripCost,
                            daily_limit: Number.isFinite(dailyLimit) ? dailyLimit : null,
                            weekly_limit: Number.isFinite(weeklyLimit) ? weeklyLimit : null,
                            daily_spent: dailySpent,
                            weekly_spent: weeklySpent,
                            daily_remaining: dailyRemaining,
                            weekly_remaining: weeklyRemaining
                        }
                    });
                }
            }
        }

        // Optional: pickup hub overrides pickup coords + location
        const pickupHubId = pickup_hub_id !== undefined && pickup_hub_id !== null ? Number(pickup_hub_id) : null;
        let pickupHub = null;
        if (Number.isFinite(pickupHubId) && pickupHubId > 0) {
            const hubRes = await pool.query(
                `SELECT id, title, lat, lng
                 FROM pickup_hubs
                 WHERE id = $1 AND is_active = true
                 LIMIT 1`,
                [pickupHubId]
            );
            pickupHub = hubRes.rows[0] || null;
            if (!pickupHub) {
                return res.status(404).json({ success: false, error: 'Pickup hub not found' });
            }
        }

        // Validation: Require core trip fields
        if (!effectiveRiderId || !pickup_location || !dropoff_location || effectiveCost === undefined || effectiveCost === null || isNaN(effectiveCost)) {
            return res.status(400).json({
                success: false,
                error: 'Missing or invalid required fields.'
            });
        }

        const pickupLat = pickupHub ? Number(pickupHub.lat) : (pickup_lat !== undefined && pickup_lat !== null ? Number(pickup_lat) : null);
        const pickupLng = pickupHub ? Number(pickupHub.lng) : (pickup_lng !== undefined && pickup_lng !== null ? Number(pickup_lng) : null);
        const pickupAccuracy = pickup_accuracy !== undefined && pickup_accuracy !== null ? Number(pickup_accuracy) : null;
        const pickupTimestamp = pickup_timestamp !== undefined && pickup_timestamp !== null ? Number(pickup_timestamp) : null;
        const dropoffLat = dropoff_lat !== undefined && dropoff_lat !== null ? Number(dropoff_lat) : null;
        const dropoffLng = dropoff_lng !== undefined && dropoff_lng !== null ? Number(dropoff_lng) : null;

        if (
            !Number.isFinite(pickupLat) || !Number.isFinite(pickupLng) ||
            !Number.isFinite(dropoffLat) || !Number.isFinite(dropoffLng)
        ) {
            return res.status(400).json({
                success: false,
                error: 'Invalid coordinates.'
            });
        }

        if (pickupAccuracy !== null && !Number.isFinite(pickupAccuracy)) {
            return res.status(400).json({ success: false, error: 'Invalid pickup_accuracy.' });
        }

        if (pickupTimestamp !== null && !Number.isFinite(pickupTimestamp)) {
            return res.status(400).json({ success: false, error: 'Invalid pickup_timestamp.' });
        }

        console.log('📥 Trip create received pickup coords:', {
            trip_id: id || null,
            user_id,
            raw: {
                pickup_lat,
                pickup_lng,
                pickup_accuracy,
                pickup_timestamp
            },
            parsed: {
                pickup_lat: pickupLat,
                pickup_lng: pickupLng,
                pickup_accuracy: pickupAccuracy,
                pickup_timestamp: pickupTimestamp
            },
            source
        });

        const tripId = id || 'TR-' + Date.now();

        const effectivePickupLocation = pickupHub ? String(pickupHub.title) : pickup_location;

        const effectiveDistance = distance_km !== undefined && distance_km !== null ? distance_km : distance;
        const effectiveDuration = duration_minutes !== undefined && duration_minutes !== null ? duration_minutes : duration;

        // (v3) Ride Pass / Subscription discount (skip when a price lock is used)
        let ridePassRow = null;
        let fareBeforeDiscount = null;
        let discountAmount = null;
        let discountMeta = null;
        try {
            const base = effectiveCost !== undefined && effectiveCost !== null ? Number(effectiveCost) : null;
            const riderIdNum = effectiveRiderId !== undefined && effectiveRiderId !== null ? Number(effectiveRiderId) : null;

            if (!lockedPriceRow && Number.isFinite(riderIdNum) && riderIdNum > 0 && Number.isFinite(base) && base > 0) {
                const passRes = await pool.query(
                    `SELECT *
                     FROM passenger_ride_passes
                     WHERE user_id = $1
                       AND status = 'active'
                       AND (valid_from IS NULL OR valid_from <= NOW())
                       AND (valid_to IS NULL OR valid_to >= NOW())
                     ORDER BY COALESCE(valid_to, NOW() + INTERVAL '10 years') DESC, created_at DESC
                     LIMIT 1`,
                    [riderIdNum]
                );
                ridePassRow = passRes.rows[0] || null;

                const rules = ridePassRow && ridePassRow.rules_json ? ridePassRow.rules_json : null;
                if (ridePassRow && rules && typeof rules === 'object') {
                    const discountType = rules.discount_type ? String(rules.discount_type).toLowerCase() : 'percent';
                    const value = rules.value !== undefined && rules.value !== null ? Number(rules.value) : null;
                    const maxDiscount = rules.max_discount !== undefined && rules.max_discount !== null ? Number(rules.max_discount) : null;
                    const minFare = rules.min_fare !== undefined && rules.min_fare !== null ? Number(rules.min_fare) : null;

                    if ((!Number.isFinite(minFare) || base >= minFare) && Number.isFinite(value) && value > 0) {
                        let raw = 0;
                        if (discountType === 'fixed') {
                            raw = value;
                        } else {
                            // default percent
                            raw = (base * value) / 100;
                        }
                        let applied = Math.max(0, Math.min(base, Math.round(raw * 100) / 100));
                        if (Number.isFinite(maxDiscount) && maxDiscount > 0) {
                            applied = Math.min(applied, maxDiscount);
                        }

                        if (applied > 0.001) {
                            fareBeforeDiscount = Math.round(base * 100) / 100;
                            discountAmount = Math.round(applied * 100) / 100;
                            discountMeta = {
                                source: 'ride_pass',
                                ride_pass_id: ridePassRow.id,
                                ride_pass_type: ridePassRow.type || null,
                                rules_applied: {
                                    discount_type: discountType,
                                    value,
                                    max_discount: Number.isFinite(maxDiscount) ? maxDiscount : null,
                                    min_fare: Number.isFinite(minFare) ? minFare : null
                                }
                            };
                            effectiveCost = Math.max(0, Math.round((base - discountAmount) * 100) / 100);
                        }
                    }
                }
            }
        } catch (e) {
            // non-blocking
            ridePassRow = null;
            fareBeforeDiscount = null;
            discountAmount = null;
            discountMeta = null;
        }

        const result = await pool.query(`
            INSERT INTO trips (
                id, user_id, rider_id, driver_id, pickup_location, dropoff_location,
                pickup_lat, pickup_lng, pickup_accuracy, pickup_timestamp, dropoff_lat, dropoff_lng,
                car_type,
                cost, price,
                distance, distance_km,
                duration, duration_minutes,
                payment_method, status, driver_name, source,
                pickup_hub_id, passenger_note, booked_for_family_member_id, price_lock_id, quiet_mode,
                accessibility_snapshot_json, accessibility_snapshot_at,
                ride_pass_id, fare_before_discount, discount_amount, discount_meta_json
            ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23, $24, $25, $26, $27, $28, $29::jsonb, $30, $31, $32, $33, $34::jsonb)
            RETURNING *
        `, [
            tripId, effectiveRiderId, effectiveRiderId, driver_id, effectivePickupLocation, dropoff_location,
            pickupLat, pickupLng, pickupAccuracy, pickupTimestamp, dropoffLat, dropoffLng,
            car_type,
            effectiveCost, effectiveCost,
            effectiveDistance, effectiveDistance,
            effectiveDuration, effectiveDuration,
            payment_method, status, driver_name, source,
            pickupHub ? pickupHub.id : null,
            effectivePassengerNote ? String(effectivePassengerNote) : null,
            familyMember ? Number(familyMember.id) : null,
            lockedPriceRow ? Number(lockedPriceRow.id) : null,
            quietModeEnabled,
            accessibilitySnapshot ? JSON.stringify(accessibilitySnapshot) : null,
            accessibilitySnapshot ? new Date().toISOString() : null,
            ridePassRow ? Number(ridePassRow.id) : null,
            fareBeforeDiscount !== null ? fareBeforeDiscount : null,
            discountAmount !== null ? discountAmount : null,
            discountMeta ? JSON.stringify(discountMeta) : null
        ]);

        let createdTrip = result.rows[0];

        if (lockedPriceRow) {
            try {
                await pool.query(
                    `UPDATE price_locks
                     SET used_trip_id = $2
                     WHERE id = $1 AND used_trip_id IS NULL`,
                    [lockedPriceRow.id, createdTrip.id]
                );
            } catch (e) {
                // non-blocking
            }
        }

        // ✨ إضافة الطلب إلى جدول pending_ride_requests إذا كان في حالة pending
        if (createdTrip.status === 'pending' && !createdTrip.driver_id) {
            try {
                // الحصول على معلومات الراكب
            const userResult = await pool.query('SELECT name, phone FROM users WHERE id = $1', [effectiveRiderId]);
            const user = userResult.rows[0];
            const effectivePassengerName = familyMember ? String(familyMember.name) : (user?.name || 'راكب');
            const effectivePassengerPhone = familyMember ? (familyMember.phone || '') : (user?.phone || '');
                
                const requestId = `REQ-${Date.now()}-${Math.floor(Math.random() * 1000)}`;
                const expiresAt = new Date(Date.now() + PENDING_TRIP_TTL_MINUTES * 60 * 1000);

                await pool.query(`
                    INSERT INTO pending_ride_requests (
                        trip_id, source,
                        request_id, user_id, passenger_name, passenger_phone,
                        pickup_location, dropoff_location,
                        pickup_lat, pickup_lng, pickup_accuracy, pickup_timestamp, dropoff_lat, dropoff_lng,
                        car_type, estimated_cost, estimated_distance, estimated_duration,
                        payment_method, status, expires_at
                    )
                    VALUES ($1, 'passenger_app', $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, 'waiting', $19)
                `, [
                    tripId,
                    requestId, effectiveRiderId, effectivePassengerName, effectivePassengerPhone,
                    effectivePickupLocation, dropoff_location,
                    pickupLat, pickupLng, pickupAccuracy, pickupTimestamp, dropoffLat, dropoffLng,
                    car_type, cost, distance, duration,
                    payment_method, expiresAt
                ]);

                // Store passenger notes (if present)
                if (effectivePassengerNote) {
                    try {
                        await pool.query(
                            `UPDATE pending_ride_requests
                             SET notes = $1,
                                 updated_at = CURRENT_TIMESTAMP
                             WHERE trip_id = $2 AND request_id = $3`,
                            [String(effectivePassengerNote), tripId, requestId]
                        );
                    } catch (e) {
                        // non-blocking
                    }
                }

                console.log(`✅ تم إضافة الطلب ${requestId} إلى pending_ride_requests للرحلة ${tripId}`);

                // Live Match Timeline (Socket.io)
                try {
                    io.to(userRoom(effectiveRiderId)).emit('pending_request_update', {
                        trip_id: String(tripId),
                        request_id: String(requestId),
                        stage: 'request_sent',
                        message: 'تم إرسال الطلب للسائقين القريبين',
                        created_at: new Date().toISOString()
                    });
                } catch (e) {
                    // ignore
                }
            } catch (pendingErr) {
                console.error('⚠️ خطأ في إضافة الطلب إلى pending_ride_requests:', pendingErr.message);
                // لا نوقف العملية، فقط نسجل الخطأ
            }
        }

        if (AUTO_ASSIGN_TRIPS && !createdTrip.driver_id && createdTrip.status === 'pending') {
            try {
                const nearest = await findNearestAvailableDriver({
                    pickupLat,
                    pickupLng,
                    carType: createdTrip.car_type,
                    riderId: effectiveRiderId
                });

                if (nearest && Number(nearest.distance_km) <= MAX_ASSIGN_DISTANCE_KM) {
                    const assignResult = await pool.query(
                        `UPDATE trips
                         SET driver_id = $1, driver_name = $2, status = 'assigned', updated_at = CURRENT_TIMESTAMP
                         WHERE id = $3 AND status = 'pending'
                         RETURNING *`,
                        [nearest.id, nearest.name || null, createdTrip.id]
                    );
                    if (assignResult.rows.length > 0) {
                        createdTrip = assignResult.rows[0];
                    }
                }
            } catch (assignErr) {
                console.error('Error auto-assigning nearest driver:', assignErr);
            }
        }

        res.status(201).json({
            success: true,
            data: createdTrip
        });
    } catch (err) {
        console.error('Error creating trip:', err);
        res.status(500).json({ success: false, error: err.message });
    }
});

// Update pickup location for a trip (GPS coordinates are the source of truth)
app.patch('/api/trips/:id/pickup', requireRole('passenger', 'admin'), async (req, res) => {
    try {
        const { id } = req.params;
        const { pickup_lat, pickup_lng, pickup_accuracy, pickup_timestamp, source } = req.body || {};

        const authRole = String(req.auth?.role || '').toLowerCase();
        const authUserId = req.auth?.uid;
        if (authRole === 'passenger') {
            const ownerCheck = await pool.query('SELECT user_id FROM trips WHERE id = $1 LIMIT 1', [id]);
            if (ownerCheck.rows.length === 0) {
                return res.status(404).json({ success: false, error: 'Trip not found' });
            }
            if (String(ownerCheck.rows[0].user_id) !== String(authUserId)) {
                return res.status(403).json({ success: false, error: 'Forbidden' });
            }
        }

        const pickupLat = pickup_lat !== undefined && pickup_lat !== null ? Number(pickup_lat) : null;
        const pickupLng = pickup_lng !== undefined && pickup_lng !== null ? Number(pickup_lng) : null;
        const pickupAccuracy = pickup_accuracy !== undefined && pickup_accuracy !== null ? Number(pickup_accuracy) : null;
        const pickupTimestamp = pickup_timestamp !== undefined && pickup_timestamp !== null ? Number(pickup_timestamp) : null;

        if (!Number.isFinite(pickupLat) || !Number.isFinite(pickupLng)) {
            return res.status(400).json({ success: false, error: 'Invalid pickup coordinates.' });
        }

        if (pickupAccuracy !== null && !Number.isFinite(pickupAccuracy)) {
            return res.status(400).json({ success: false, error: 'Invalid pickup_accuracy.' });
        }

        if (pickupTimestamp !== null && !Number.isFinite(pickupTimestamp)) {
            return res.status(400).json({ success: false, error: 'Invalid pickup_timestamp.' });
        }

        console.log('📥 Trip pickup update received:', {
            trip_id: id,
            raw: { pickup_lat, pickup_lng, pickup_accuracy, pickup_timestamp },
            parsed: {
                pickup_lat: pickupLat,
                pickup_lng: pickupLng,
                pickup_accuracy: pickupAccuracy,
                pickup_timestamp: pickupTimestamp
            },
            source: source || null
        });

        const tripResult = await pool.query(
            `UPDATE trips
             SET pickup_lat = $1,
                 pickup_lng = $2,
                 pickup_accuracy = $3,
                 pickup_timestamp = $4,
                 updated_at = CURRENT_TIMESTAMP
             WHERE id = $5
             RETURNING id, pickup_lat, pickup_lng, pickup_accuracy, pickup_timestamp`,
            [pickupLat, pickupLng, pickupAccuracy, pickupTimestamp, id]
        );

        if (tripResult.rows.length === 0) {
            return res.status(404).json({ success: false, error: 'Trip not found' });
        }

        // Propagate to pending ride requests (waiting/accepted)
        try {
            await pool.query(
                `UPDATE pending_ride_requests
                 SET pickup_lat = $1,
                     pickup_lng = $2,
                     pickup_accuracy = $3,
                     pickup_timestamp = $4,
                     updated_at = CURRENT_TIMESTAMP
                 WHERE trip_id = $5 AND status IN ('waiting', 'accepted')`,
                [pickupLat, pickupLng, pickupAccuracy, pickupTimestamp, id]
            );
        } catch (err) {
            console.warn('⚠️ Failed to propagate pickup update to pending_ride_requests:', err.message);
        }

        res.json({ success: true, data: tripResult.rows[0] });
    } catch (err) {
        console.error('Error updating trip pickup location:', err);
        res.status(500).json({ success: false, error: err.message });
    }
});

// Update trip status
app.patch('/api/trips/:id/status', requireAuth, async (req, res) => {
    try {
        const { id } = req.params;
        const {
            status,
            trip_status,
            rating,
            review,
            passenger_rating,
            driver_rating,
            passenger_review,
            driver_review,
            cost,
            distance,
            duration,
            payment_method
        } = req.body;

        const authRole = String(req.auth?.role || '').toLowerCase();
        const authUserId = req.auth?.uid;
        const authDriverId = req.auth?.driver_id;

        // Fetch current status for state-machine transition checks + event dedupe
        // Also load trip coords/timestamps for completion calculations.
        let beforeTripStatus = null;
        let beforeStatus = null;
        let beforeTripRow = null;
        try {
            const before = await pool.query(
                `SELECT
                    status,
                    trip_status,
                    pickup_lat,
                    pickup_lng,
                    dropoff_lat,
                    dropoff_lng,
                    started_at,
                    created_at,
                    completed_at,
                    distance,
                    duration,
                    cost,
                    driver_id,
                    user_id,
                    pickup_verified_at,
                    pickup_verified_by,
                    pickup_code_expires_at
                 FROM trips
                 WHERE id = $1
                 LIMIT 1`,
                [id]
            );
            if (before.rows.length > 0) {
                beforeStatus = before.rows[0].status || null;
                beforeTripStatus = before.rows[0].trip_status || null;
                beforeTripRow = before.rows[0];
            }
        } catch (err) {
            // Non-blocking
            beforeTripStatus = null;
            beforeStatus = null;
            beforeTripRow = null;
        }

        if (!beforeTripRow) {
            return res.status(404).json({ success: false, error: 'Trip not found' });
        }

        if (authRole === 'passenger') {
            if (String(beforeTripRow.user_id) !== String(authUserId)) {
                return res.status(403).json({ success: false, error: 'Forbidden' });
            }
            if (status !== 'cancelled') {
                return res.status(403).json({ success: false, error: 'Passengers can only cancel their trips' });
            }
        }

        if (authRole === 'driver') {
            if (!authDriverId) {
                return res.status(403).json({ success: false, error: 'Driver profile not linked to this account' });
            }
            if (String(beforeTripRow.driver_id || '') !== String(authDriverId)) {
                return res.status(403).json({ success: false, error: 'Forbidden' });
            }
            const allowed = new Set(['assigned', 'ongoing', 'completed', 'cancelled']);
            if (!allowed.has(String(status || '').toLowerCase())) {
                return res.status(403).json({ success: false, error: 'Drivers cannot set this status' });
            }

            // Pickup Handshake: require verification before starting the ride
            if (String(status || '').toLowerCase() === 'ongoing' && !beforeTripRow.pickup_verified_at) {
                return res.status(409).json({
                    success: false,
                    error: 'Pickup handshake required before starting the trip',
                    code: 'pickup_handshake_required'
                });
            }
        }

        const effectivePassengerRating = passenger_rating !== undefined ? passenger_rating : rating;
        const effectivePassengerReview = passenger_review !== undefined ? passenger_review : review;

        // Compute next trip_status (shared state machine) while keeping legacy `status`
        let nextTripStatus = trip_status || null;
        if (!nextTripStatus && effectivePassengerRating !== undefined) {
            nextTripStatus = 'rated';
        }
        if (!nextTripStatus && status === 'ongoing') {
            nextTripStatus = 'started';
        }
        if (!nextTripStatus && status === 'completed') {
            nextTripStatus = 'completed';
        }

        // Budget envelope: if wallet payment exceeds envelope, auto-switch to cash
        let paymentMeta = null;
        let effectivePaymentMethod = payment_method !== undefined && payment_method !== null ? String(payment_method) : null;
        if (
            String(status || '').toLowerCase() === 'completed' &&
            effectivePaymentMethod &&
            String(effectivePaymentMethod).toLowerCase() === 'wallet'
        ) {
            try {
                const passengerId = beforeTripRow.user_id ? Number(beforeTripRow.user_id) : null;
                const amount = cost !== undefined && cost !== null
                    ? Number(cost)
                    : (beforeTripRow.cost !== undefined && beforeTripRow.cost !== null ? Number(beforeTripRow.cost) : null);

                if (passengerId && Number.isFinite(amount) && amount > 0) {
                    const envRes = await pool.query(
                        `SELECT enabled, daily_limit, weekly_limit
                         FROM passenger_budget_envelopes
                         WHERE user_id = $1
                         LIMIT 1`,
                        [passengerId]
                    );
                    const env = envRes.rows[0] || null;
                    if (env && env.enabled !== false) {
                        const dailyLimit = env.daily_limit !== null && env.daily_limit !== undefined ? Number(env.daily_limit) : null;
                        const weeklyLimit = env.weekly_limit !== null && env.weekly_limit !== undefined ? Number(env.weekly_limit) : null;

                        const dailySpentRes = await pool.query(
                            `SELECT COALESCE(SUM(COALESCE(cost, price, 0)), 0) AS total
                             FROM trips
                             WHERE user_id = $1
                               AND payment_method = 'wallet'
                               AND status <> 'cancelled'
                               AND created_at >= date_trunc('day', NOW())`,
                            [passengerId]
                        );
                        const weeklySpentRes = await pool.query(
                            `SELECT COALESCE(SUM(COALESCE(cost, price, 0)), 0) AS total
                             FROM trips
                             WHERE user_id = $1
                               AND payment_method = 'wallet'
                               AND status <> 'cancelled'
                               AND created_at >= date_trunc('week', NOW())`,
                            [passengerId]
                        );

                        const dailySpent = Number(dailySpentRes.rows?.[0]?.total || 0);
                        const weeklySpent = Number(weeklySpentRes.rows?.[0]?.total || 0);
                        const dailyRemaining = Number.isFinite(dailyLimit) ? Math.max(0, dailyLimit - dailySpent) : null;
                        const weeklyRemaining = Number.isFinite(weeklyLimit) ? Math.max(0, weeklyLimit - weeklySpent) : null;

                        const dailyOk = dailyRemaining === null ? true : amount <= dailyRemaining;
                        const weeklyOk = weeklyRemaining === null ? true : amount <= weeklyRemaining;
                        if (!dailyOk || !weeklyOk) {
                            effectivePaymentMethod = 'cash';
                            paymentMeta = { switched_from: 'wallet', switched_to: 'cash', reason: 'budget_exceeded' };
                        }
                    }
                }
            } catch (e) {
                // non-blocking
            }
        }
        
        let query = 'UPDATE trips SET status = $1, updated_at = CURRENT_TIMESTAMP';
        const params = [status];
        let paramCount = 1;

        if (nextTripStatus) {
            paramCount++;
            query += `, trip_status = $${paramCount}::trip_status_enum`;
            params.push(nextTripStatus);
        }
        
        if (status === 'completed') {
            query += ', completed_at = CASE WHEN completed_at IS NULL THEN CURRENT_TIMESTAMP ELSE completed_at END';
        } else if (status === 'cancelled') {
            query += ', cancelled_at = CASE WHEN cancelled_at IS NULL THEN CURRENT_TIMESTAMP ELSE cancelled_at END';
        } else if (status === 'ongoing') {
            query += ', started_at = CASE WHEN started_at IS NULL THEN CURRENT_TIMESTAMP ELSE started_at END';
        }

        if (cost !== undefined) {
            paramCount++;
            query += `, cost = $${paramCount}`;
            params.push(cost);

            // Keep spec field in sync
            query += `, price = $${paramCount}`;
        }

        // If trip is being completed, compute distance from coordinates when caller didn't provide it.
        let computedDistance = null;
        if (status === 'completed' && distance === undefined) {
            const existingDistance = beforeTripRow?.distance !== undefined && beforeTripRow?.distance !== null ? Number(beforeTripRow.distance) : null;
            if (!Number.isFinite(existingDistance)) {
                const pl = beforeTripRow?.pickup_lat !== undefined && beforeTripRow?.pickup_lat !== null ? Number(beforeTripRow.pickup_lat) : null;
                const pg = beforeTripRow?.pickup_lng !== undefined && beforeTripRow?.pickup_lng !== null ? Number(beforeTripRow.pickup_lng) : null;
                const dl = beforeTripRow?.dropoff_lat !== undefined && beforeTripRow?.dropoff_lat !== null ? Number(beforeTripRow.dropoff_lat) : null;
                const dg = beforeTripRow?.dropoff_lng !== undefined && beforeTripRow?.dropoff_lng !== null ? Number(beforeTripRow.dropoff_lng) : null;
                if (Number.isFinite(pl) && Number.isFinite(pg) && Number.isFinite(dl) && Number.isFinite(dg)) {
                    computedDistance = Math.round(haversineKm({ lat: pl, lng: pg }, { lat: dl, lng: dg }) * 10) / 10;
                }
            }
        }

        if (distance !== undefined) {
            paramCount++;
            query += `, distance = $${paramCount}`;
            params.push(distance);

            query += `, distance_km = $${paramCount}`;
        } else if (computedDistance !== null) {
            paramCount++;
            query += `, distance = $${paramCount}`;
            params.push(computedDistance);

            query += `, distance_km = $${paramCount}`;
        }

        if (duration !== undefined) {
            paramCount++;
            query += `, duration = $${paramCount}`;
            params.push(duration);

            query += `, duration_minutes = $${paramCount}`;
        } else if (status === 'completed') {
            query += `, duration = COALESCE(duration, GREATEST(1, ROUND(EXTRACT(EPOCH FROM (CURRENT_TIMESTAMP - COALESCE(started_at, created_at))) / 60)))`;
            query += `, duration_minutes = COALESCE(duration_minutes, duration, GREATEST(1, ROUND(EXTRACT(EPOCH FROM (CURRENT_TIMESTAMP - COALESCE(started_at, created_at))) / 60)))`;
        }

        if (effectivePaymentMethod !== null) {
            paramCount++;
            query += `, payment_method = $${paramCount}`;
            params.push(effectivePaymentMethod);
        }
        
        if (effectivePassengerRating !== undefined) {
            paramCount++;
            query += `, passenger_rating = $${paramCount}`;
            params.push(effectivePassengerRating);

            paramCount++;
            query += `, rating = $${paramCount}`;
            params.push(effectivePassengerRating);

            // Keep spec field in sync
            query += `, rider_rating = $${paramCount}`;
        }

        if (driver_rating !== undefined) {
            paramCount++;
            query += `, driver_rating = $${paramCount}`;
            params.push(driver_rating);
        }

        if (effectivePassengerReview) {
            paramCount++;
            query += `, passenger_review = $${paramCount}`;
            params.push(effectivePassengerReview);

            paramCount++;
            query += `, review = $${paramCount}`;
            params.push(effectivePassengerReview);
        }

        if (driver_review) {
            paramCount++;
            query += `, driver_review = $${paramCount}`;
            params.push(driver_review);
        }
        
        paramCount++;
        query += ` WHERE id = $${paramCount} RETURNING *`;
        params.push(id);
        
        const result = await pool.query(query, params);
        
        if (result.rows.length === 0) {
            return res.status(404).json({ success: false, error: 'Trip not found' });
        }

        // Loyalty stats (cancel count) - anti-abuse: only on first transition to cancelled
        if (status === 'cancelled' && beforeStatus !== 'cancelled') {
            try {
                const passengerId = result.rows[0].user_id ? Number(result.rows[0].user_id) : null;
                if (passengerId) {
                    await pool.query(
                        `INSERT INTO passenger_loyalty_stats (user_id)
                         VALUES ($1)
                         ON CONFLICT (user_id) DO NOTHING`,
                        [passengerId]
                    );
                    await pool.query(
                        `UPDATE passenger_loyalty_stats
                         SET cancelled_trips = cancelled_trips + 1,
                             updated_at = CURRENT_TIMESTAMP
                         WHERE user_id = $1`,
                        [passengerId]
                    );
                }
            } catch (e) {
                // non-blocking
            }
        }

        // Realtime events
        try {
            const updatedTrip = result.rows[0];
            const updatedTripStatus = updatedTrip.trip_status || nextTripStatus || null;

            if (updatedTripStatus === 'started' && beforeTripStatus !== 'started') {
                io.to(tripRoom(id)).emit('trip_started', {
                    trip_id: String(id),
                    trip_status: 'started'
                });
            }

            if (updatedTripStatus === 'completed' && beforeTripStatus !== 'completed') {
                io.to(tripRoom(id)).emit('trip_completed', {
                    trip_id: String(id),
                    trip_status: 'completed',
                    duration: updatedTrip.duration !== undefined && updatedTrip.duration !== null ? Number(updatedTrip.duration) : null,
                    distance: updatedTrip.distance !== undefined && updatedTrip.distance !== null ? Number(updatedTrip.distance) : null,
                    price: updatedTrip.cost !== undefined && updatedTrip.cost !== null ? Number(updatedTrip.cost) : null
                });
            }

            if (updatedTripStatus === 'rated' && beforeTripStatus !== 'rated') {
                io.to(tripRoom(id)).emit('trip_rated', {
                    trip_id: String(id),
                    trip_status: 'rated'
                });
            }
        } catch (err) {
            console.warn('⚠️ Failed to emit trip realtime event:', err.message);
        }
        
        // Update driver earnings if trip completed (once per trip completion)
        if (status === 'completed' && beforeStatus !== 'completed' && result.rows[0].driver_id) {
            try {
                const driverId = result.rows[0].driver_id;
                const tripCost = parseFloat(cost !== undefined ? cost : result.rows[0].cost);
                if (!Number.isFinite(tripCost) || tripCost <= 0) {
                    // Nothing to add
                } else {
                
                // Update drivers table
                await pool.query(`
                    UPDATE drivers 
                    SET total_earnings = COALESCE(total_earnings, 0) + $1,
                        balance = COALESCE(balance, 0) + $1,
                        today_earnings = COALESCE(today_earnings, 0) + $1,
                        today_trips_count = COALESCE(today_trips_count, 0) + 1,
                        total_trips = COALESCE(total_trips, 0) + 1
                    WHERE id = $2
                `, [tripCost, driverId]);
                
                // Update or insert into driver_earnings table
                await pool.query(`
                    INSERT INTO driver_earnings (driver_id, date, today_trips, today_earnings, total_trips, total_earnings)
                    VALUES ($1, CURRENT_DATE, 1, $2, 1, $2)
                    ON CONFLICT (driver_id, date) 
                    DO UPDATE SET 
                        today_trips = driver_earnings.today_trips + 1,
                        today_earnings = driver_earnings.today_earnings + $2,
                        updated_at = CURRENT_TIMESTAMP
                `, [driverId, tripCost]);
                
                // Update total_trips and total_earnings for the driver in driver_earnings
                const totalResult = await pool.query(`
                    SELECT COUNT(*) as total_trips, COALESCE(SUM(cost), 0) as total_earnings
                    FROM trips
                    WHERE driver_id = $1 AND status = 'completed'
                `, [driverId]);
                
                if (totalResult.rows.length > 0) {
                    await pool.query(`
                        UPDATE driver_earnings 
                        SET total_trips = $1, total_earnings = $2
                        WHERE driver_id = $3 AND date = CURRENT_DATE
                    `, [
                        parseInt(totalResult.rows[0].total_trips),
                        parseFloat(totalResult.rows[0].total_earnings),
                        driverId
                    ]);
                }
                }
            } catch (driverErr) {
                console.error('Error updating driver earnings:', driverErr);
            }
        }

        // Daily/Monthly counters (increment on completion transition)
        if (status === 'completed' && beforeStatus !== 'completed') {
            try {
                await ensureAdminTripCountersTables();
                const updatedTrip = result.rows[0];
                const completedAt = updatedTrip.completed_at ? new Date(updatedTrip.completed_at) : new Date();
                const dayKey = completedAt.toISOString().slice(0, 10);
                const monthKey = monthKeyFromDate(completedAt);

                const tripRevenue = Number(updatedTrip.cost || 0);
                const tripDistance = Number(updatedTrip.distance || 0);

                await pool.query(
                    `INSERT INTO admin_daily_counters (day, daily_trips, daily_revenue, daily_distance, updated_at)
                     VALUES ($1, 1, $2, $3, CURRENT_TIMESTAMP)
                     ON CONFLICT (day)
                     DO UPDATE SET
                        daily_trips = admin_daily_counters.daily_trips + 1,
                        daily_revenue = admin_daily_counters.daily_revenue + EXCLUDED.daily_revenue,
                        daily_distance = admin_daily_counters.daily_distance + EXCLUDED.daily_distance,
                        updated_at = CURRENT_TIMESTAMP`,
                    [dayKey, tripRevenue, tripDistance]
                );

                await pool.query(
                    `INSERT INTO admin_monthly_counters (month_key, monthly_trips, monthly_revenue, monthly_distance, updated_at)
                     VALUES ($1, 1, $2, $3, CURRENT_TIMESTAMP)
                     ON CONFLICT (month_key)
                     DO UPDATE SET
                        monthly_trips = admin_monthly_counters.monthly_trips + 1,
                        monthly_revenue = admin_monthly_counters.monthly_revenue + EXCLUDED.monthly_revenue,
                        monthly_distance = admin_monthly_counters.monthly_distance + EXCLUDED.monthly_distance,
                        updated_at = CURRENT_TIMESTAMP`,
                    [monthKey, tripRevenue, tripDistance]
                );
            } catch (err) {
                console.warn('⚠️ Failed to update admin counters:', err.message);
            }
        }

        // ✨ تحديث حالة الطلب في pending_ride_requests
        try {
            // تحديث حالة الطلب بناءً على حالة الرحلة
            if (status === 'assigned' && result.rows[0].driver_id) {
                // عند تعيين سائق، نحدث الحالة إلى accepted
                await pool.query(
                    `WITH target AS (
                        SELECT id
                        FROM pending_ride_requests
                        WHERE user_id = $2
                          AND status = 'waiting'
                          AND pickup_lat = $3
                          AND pickup_lng = $4
                          AND created_at >= CURRENT_TIMESTAMP - INTERVAL '30 minutes'
                        ORDER BY created_at DESC
                        LIMIT 1
                    )
                    UPDATE pending_ride_requests pr
                    SET status = 'accepted',
                        assigned_driver_id = $1,
                        assigned_at = CURRENT_TIMESTAMP,
                        updated_at = CURRENT_TIMESTAMP
                    FROM target
                    WHERE pr.id = target.id`,
                    [
                        result.rows[0].driver_id,
                        result.rows[0].user_id,
                        result.rows[0].pickup_lat,
                        result.rows[0].pickup_lng
                    ]
                );
            } else if (status === 'cancelled') {
                // عند إلغاء الرحلة، نحدث الحالة إلى cancelled
                await pool.query(
                    `WITH target AS (
                        SELECT id
                        FROM pending_ride_requests
                        WHERE user_id = $1
                          AND status = 'waiting'
                          AND pickup_lat = $2
                          AND pickup_lng = $3
                          AND created_at >= CURRENT_TIMESTAMP - INTERVAL '30 minutes'
                        ORDER BY created_at DESC
                        LIMIT 1
                    )
                    UPDATE pending_ride_requests pr
                    SET status = 'cancelled',
                        updated_at = CURRENT_TIMESTAMP
                    FROM target
                    WHERE pr.id = target.id`,
                    [result.rows[0].user_id, result.rows[0].pickup_lat, result.rows[0].pickup_lng]
                );
            } else if (status === 'completed') {
                // عند إكمال الرحلة، يمكن تحديث الحالة أو تركها كما هي
                await pool.query(
                    `WITH target AS (
                        SELECT id
                        FROM pending_ride_requests
                        WHERE user_id = $1
                          AND status = 'accepted'
                          AND pickup_lat = $2
                          AND pickup_lng = $3
                          AND created_at >= CURRENT_TIMESTAMP - INTERVAL '2 hours'
                        ORDER BY created_at DESC
                        LIMIT 1
                    )
                    UPDATE pending_ride_requests pr
                    SET status = 'completed',
                        updated_at = CURRENT_TIMESTAMP
                    FROM target
                    WHERE pr.id = target.id`,
                    [result.rows[0].user_id, result.rows[0].pickup_lat, result.rows[0].pickup_lng]
                );
            }
        } catch (pendingUpdateErr) {
            console.error('⚠️ خطأ في تحديث pending_ride_requests:', pendingUpdateErr.message);
        }
        
        res.json({
            success: true,
            data: result.rows[0],
            meta: paymentMeta
        });
    } catch (err) {
        console.error('Error updating trip status:', err);
        res.status(500).json({ success: false, error: err.message });
    }
});

// Driver ends trip (server-side completion)
async function endTripHandler(req, res) {
    const client = await pool.connect();
    try {
        const tripId = req.body?.trip_id ? String(req.body.trip_id) : null;
        const driverId = req.body?.driver_id !== undefined && req.body?.driver_id !== null ? Number(req.body.driver_id) : null;

        const bodyDistanceKm = req.body?.distance_km !== undefined && req.body?.distance_km !== null ? Number(req.body.distance_km) : null;
        const bodyPrice = req.body?.price !== undefined && req.body?.price !== null ? Number(req.body.price) : (req.body?.cost !== undefined && req.body?.cost !== null ? Number(req.body.cost) : null);
        const bodyDropoffLat = req.body?.dropoff_lat !== undefined && req.body?.dropoff_lat !== null ? Number(req.body.dropoff_lat) : null;
        const bodyDropoffLng = req.body?.dropoff_lng !== undefined && req.body?.dropoff_lng !== null ? Number(req.body.dropoff_lng) : null;

        if (!tripId && !Number.isFinite(driverId)) {
            return res.status(400).json({ success: false, error: 'trip_id or driver_id is required' });
        }

        await client.query('BEGIN');

        let tripRow = null;
        if (tripId) {
            const found = await client.query(
                `SELECT *
                 FROM trips
                 WHERE id = $1
                 LIMIT 1
                 FOR UPDATE`,
                [tripId]
            );
            tripRow = found.rows[0] || null;
        } else {
            const found = await client.query(
                `SELECT *
                 FROM trips
                 WHERE driver_id = $1
                   AND (trip_status = 'started'::trip_status_enum OR status = 'ongoing')
                 ORDER BY COALESCE(started_at, created_at) DESC
                 LIMIT 1
                 FOR UPDATE`,
                [driverId]
            );
            tripRow = found.rows[0] || null;
        }

        if (!tripRow) {
            await client.query('ROLLBACK');
            return res.status(404).json({ success: false, error: 'Active started trip not found' });
        }

        const beforeStatus = tripRow.status || null;
        const beforeTripStatus = tripRow.trip_status || null;
        const isStarted = beforeTripStatus === 'started' || beforeStatus === 'ongoing';
        if (!isStarted) {
            await client.query('ROLLBACK');
            return res.status(409).json({
                success: false,
                error: `Trip is not started (trip_status=${beforeTripStatus || 'null'}, status=${beforeStatus || 'null'})`
            });
        }

        const now = new Date();
        const startedAt = tripRow.started_at ? new Date(tripRow.started_at) : (tripRow.created_at ? new Date(tripRow.created_at) : null);
        const durationMinutes = startedAt
            ? Math.max(1, Math.round((now.getTime() - startedAt.getTime()) / 60000))
            : (tripRow.duration_minutes !== null && tripRow.duration_minutes !== undefined ? Number(tripRow.duration_minutes) : (tripRow.duration !== null && tripRow.duration !== undefined ? Number(tripRow.duration) : 1));

        let distanceKm = Number.isFinite(bodyDistanceKm) && bodyDistanceKm >= 0 ? bodyDistanceKm : null;
        if (distanceKm === null) {
            const pickupLat = tripRow.pickup_lat !== undefined && tripRow.pickup_lat !== null ? Number(tripRow.pickup_lat) : null;
            const pickupLng = tripRow.pickup_lng !== undefined && tripRow.pickup_lng !== null ? Number(tripRow.pickup_lng) : null;
            const dropoffLat = Number.isFinite(bodyDropoffLat) ? bodyDropoffLat : (tripRow.dropoff_lat !== undefined && tripRow.dropoff_lat !== null ? Number(tripRow.dropoff_lat) : null);
            const dropoffLng = Number.isFinite(bodyDropoffLng) ? bodyDropoffLng : (tripRow.dropoff_lng !== undefined && tripRow.dropoff_lng !== null ? Number(tripRow.dropoff_lng) : null);

            if (Number.isFinite(pickupLat) && Number.isFinite(pickupLng) && Number.isFinite(dropoffLat) && Number.isFinite(dropoffLng)) {
                distanceKm = Math.round(haversineKm({ lat: pickupLat, lng: pickupLng }, { lat: dropoffLat, lng: dropoffLng }) * 10) / 10;
            } else {
                const existing = tripRow.distance_km !== undefined && tripRow.distance_km !== null ? Number(tripRow.distance_km) : (tripRow.distance !== undefined && tripRow.distance !== null ? Number(tripRow.distance) : 0);
                distanceKm = Number.isFinite(existing) ? existing : 0;
            }
        }

        const finalPrice = Number.isFinite(bodyPrice) ? bodyPrice : (
            tripRow.price !== undefined && tripRow.price !== null
                ? Number(tripRow.price)
                : (tripRow.cost !== undefined && tripRow.cost !== null ? Number(tripRow.cost) : 0)
        );

        const update = await client.query(
            `UPDATE trips
             SET status = 'completed',
                 trip_status = 'completed'::trip_status_enum,
                 completed_at = CURRENT_TIMESTAMP,
                 duration = $2,
                 duration_minutes = $2,
                 distance = $3,
                 distance_km = $3,
                 cost = $4,
                 price = $4,
                 dropoff_lat = COALESCE($5, dropoff_lat),
                 dropoff_lng = COALESCE($6, dropoff_lng),
                 updated_at = CURRENT_TIMESTAMP
             WHERE id = $1
             RETURNING *`,
            [tripRow.id, durationMinutes, distanceKm, finalPrice, Number.isFinite(bodyDropoffLat) ? bodyDropoffLat : null, Number.isFinite(bodyDropoffLng) ? bodyDropoffLng : null]
        );

        const updatedTrip = update.rows[0];

        // Side effects (only on first completion transition)
        if (beforeStatus !== 'completed') {
            // Passenger wallet payment (ledger) + anti-fraud safeguards
            try {
                const tripCost = Number(updatedTrip.cost || updatedTrip.price || 0);
                const passengerId = updatedTrip.user_id ? Number(updatedTrip.user_id) : null;
                const paymentMethod = String(updatedTrip.payment_method || '').toLowerCase();

                const dailyLimit = process.env.PASSENGER_WALLET_DAILY_DEBIT_LIMIT
                    ? Number(process.env.PASSENGER_WALLET_DAILY_DEBIT_LIMIT)
                    : 5000;

                async function debitUserWalletOnce({ ownerId, amount, referenceType, referenceId, reason }) {
                    if (!Number.isFinite(ownerId) || ownerId <= 0) throw new Error('Invalid owner id');
                    if (!Number.isFinite(amount) || amount <= 0) throw new Error('Invalid amount');

                    const owner = { owner_type: 'user', owner_id: ownerId };
                    const balance = await getWalletBalance(client, owner);
                    if (balance < amount) {
                        throw new Error('Insufficient wallet balance');
                    }

                    if (Number.isFinite(dailyLimit) && dailyLimit > 0) {
                        const today = await getTodayWalletDebitsTotal(client, { ...owner, referenceType: null });
                        if (today + amount > dailyLimit) {
                            throw new Error('Daily wallet limit exceeded');
                        }
                    }

                    await client.query(
                        `INSERT INTO wallet_transactions (
                            owner_type, owner_id, amount, currency, reason, reference_type, reference_id, created_by_user_id, created_by_role
                         ) VALUES ('user', $1, $2, 'SAR', NULLIF($3,''), $4, $5, NULL, 'system')
                         ON CONFLICT DO NOTHING`,
                        [ownerId, -Math.abs(amount), reason || '', referenceType, referenceId]
                    );

                    // Best-effort cached balance update for backward compatibility
                    try {
                        await client.query(
                            `UPDATE users
                             SET balance = COALESCE(balance, 0) - $1,
                                 updated_at = CURRENT_TIMESTAMP
                             WHERE id = $2`,
                            [Math.abs(amount), ownerId]
                        );
                    } catch (e) {
                        // ignore
                    }
                }

                if (passengerId && Number.isFinite(tripCost) && tripCost > 0) {
                    if (paymentMethod === 'wallet') {
                        await debitUserWalletOnce({
                            ownerId: passengerId,
                            amount: tripCost,
                            referenceType: 'trip_payment',
                            referenceId: String(updatedTrip.id),
                            reason: `Trip payment ${String(updatedTrip.id)}`
                        });
                    }

                    if (paymentMethod === 'split') {
                        const splits = await client.query(
                            `SELECT id, payer_user_id, amount, method, status
                             FROM trip_split_payments
                             WHERE trip_id = $1
                             ORDER BY created_at ASC
                             FOR UPDATE`,
                            [updatedTrip.id]
                        );

                        if (splits.rows.length > 0) {
                            // Validate totals (best-effort)
                            const sum = splits.rows.reduce((acc, r) => acc + Number(r.amount || 0), 0);
                            if (Math.abs((Math.round(sum * 100) / 100) - (Math.round(tripCost * 100) / 100)) > 0.5) {
                                throw new Error('Split fare total mismatch');
                            }

                            for (const sp of splits.rows) {
                                const method = String(sp.method || 'wallet').toLowerCase();
                                const amount = Number(sp.amount || 0);
                                const payerId = Number(sp.payer_user_id);

                                if (!Number.isFinite(amount) || amount <= 0) continue;
                                if (!Number.isFinite(payerId) || payerId <= 0) continue;
                                if (String(sp.status || 'pending').toLowerCase() !== 'pending') continue;

                                if (method === 'wallet') {
                                    await debitUserWalletOnce({
                                        ownerId: payerId,
                                        amount,
                                        referenceType: 'split_trip_payment',
                                        referenceId: `${String(updatedTrip.id)}:${String(payerId)}`,
                                        reason: `Split trip payment ${String(updatedTrip.id)}`
                                    });

                                    await client.query(
                                        `UPDATE trip_split_payments
                                         SET status = 'paid', paid_at = CURRENT_TIMESTAMP
                                         WHERE id = $1`,
                                        [sp.id]
                                    );
                                }
                            }
                        }
                    }
                }
            } catch (e) {
                // If wallet payment fails, rollback trip completion (safety) only when wallet/split is required
                const pm = String(updatedTrip.payment_method || '').toLowerCase();
                if (pm === 'wallet' || pm === 'split') {
                    throw e;
                }
            }

            // Loyalty stats + points (award once per trip)
            try {
                const passengerId = updatedTrip.user_id ? Number(updatedTrip.user_id) : null;
                if (passengerId) {
                    await client.query(
                        `INSERT INTO passenger_loyalty_stats (user_id)
                         VALUES ($1)
                         ON CONFLICT (user_id) DO NOTHING`,
                        [passengerId]
                    );
                    await client.query(
                        `UPDATE passenger_loyalty_stats
                         SET completed_trips = completed_trips + 1,
                             hub_compliance_trips = hub_compliance_trips + CASE WHEN $2::int IS NOT NULL THEN 1 ELSE 0 END,
                             updated_at = CURRENT_TIMESTAMP
                         WHERE user_id = $1`,
                        [passengerId, updatedTrip.pickup_hub_id ? 1 : null]
                    );

                    const tripCost = Number(updatedTrip.cost || updatedTrip.price || 0);
                    const points = Number.isFinite(tripCost) && tripCost > 0 ? Math.max(1, Math.floor(tripCost / 10)) : 0;
                    if (points > 0) {
                        const reward = await client.query(
                            `INSERT INTO trip_reward_events (user_id, trip_id, points_awarded)
                             VALUES ($1,$2,$3)
                             ON CONFLICT (trip_id) DO NOTHING
                             RETURNING id`,
                            [passengerId, String(updatedTrip.id), points]
                        );
                        if (reward.rows.length > 0) {
                            await client.query(
                                `UPDATE users
                                 SET points = COALESCE(points, 0) + $1,
                                     updated_at = CURRENT_TIMESTAMP
                                 WHERE id = $2`,
                                [points, passengerId]
                            );
                        }
                    }
                }
            } catch (e) {
                // non-blocking
            }

            // Driver earnings
            if (updatedTrip.driver_id) {
                const tripCost = Number(updatedTrip.cost || 0);
                if (Number.isFinite(tripCost) && tripCost > 0) {
                    await client.query(
                        `UPDATE drivers 
                         SET total_earnings = COALESCE(total_earnings, 0) + $1,
                             balance = COALESCE(balance, 0) + $1,
                             today_earnings = COALESCE(today_earnings, 0) + $1,
                             today_trips_count = COALESCE(today_trips_count, 0) + 1,
                             total_trips = COALESCE(total_trips, 0) + 1
                         WHERE id = $2`,
                        [tripCost, updatedTrip.driver_id]
                    );

                    await client.query(
                        `INSERT INTO driver_earnings (driver_id, date, today_trips, today_earnings, total_trips, total_earnings)
                         VALUES ($1, CURRENT_DATE, 1, $2, 1, $2)
                         ON CONFLICT (driver_id, date)
                         DO UPDATE SET
                            today_trips = driver_earnings.today_trips + 1,
                            today_earnings = driver_earnings.today_earnings + $2,
                            updated_at = CURRENT_TIMESTAMP`,
                        [updatedTrip.driver_id, tripCost]
                    );

                    const totalResult = await client.query(
                        `SELECT COUNT(*) as total_trips, COALESCE(SUM(cost), 0) as total_earnings
                         FROM trips
                         WHERE driver_id = $1 AND status = 'completed'`,
                        [updatedTrip.driver_id]
                    );
                    if (totalResult.rows.length > 0) {
                        await client.query(
                            `UPDATE driver_earnings
                             SET total_trips = $1, total_earnings = $2
                             WHERE driver_id = $3 AND date = CURRENT_DATE`,
                            [
                                parseInt(totalResult.rows[0].total_trips),
                                parseFloat(totalResult.rows[0].total_earnings),
                                updatedTrip.driver_id
                            ]
                        );
                    }
                }
            }

            // Admin counters
            try {
                await ensureAdminTripCountersTables();
                const completedAt = updatedTrip.completed_at ? new Date(updatedTrip.completed_at) : now;
                const dayKey = completedAt.toISOString().slice(0, 10);
                const monthKey = monthKeyFromDate(completedAt);

                const tripRevenue = Number(updatedTrip.cost || 0);
                const tripDistance = Number(updatedTrip.distance || 0);

                await client.query(
                    `INSERT INTO admin_daily_counters (day, daily_trips, daily_revenue, daily_distance, updated_at)
                     VALUES ($1, 1, $2, $3, CURRENT_TIMESTAMP)
                     ON CONFLICT (day)
                     DO UPDATE SET
                        daily_trips = admin_daily_counters.daily_trips + 1,
                        daily_revenue = admin_daily_counters.daily_revenue + EXCLUDED.daily_revenue,
                        daily_distance = admin_daily_counters.daily_distance + EXCLUDED.daily_distance,
                        updated_at = CURRENT_TIMESTAMP`,
                    [dayKey, tripRevenue, tripDistance]
                );

                await client.query(
                    `INSERT INTO admin_monthly_counters (month_key, monthly_trips, monthly_revenue, monthly_distance, updated_at)
                     VALUES ($1, 1, $2, $3, CURRENT_TIMESTAMP)
                     ON CONFLICT (month_key)
                     DO UPDATE SET
                        monthly_trips = admin_monthly_counters.monthly_trips + 1,
                        monthly_revenue = admin_monthly_counters.monthly_revenue + EXCLUDED.monthly_revenue,
                        monthly_distance = admin_monthly_counters.monthly_distance + EXCLUDED.monthly_distance,
                        updated_at = CURRENT_TIMESTAMP`,
                    [monthKey, tripRevenue, tripDistance]
                );
            } catch (e) {
                // Non-blocking
            }

            // Pending ride request status
            try {
                await client.query(
                    `WITH target AS (
                        SELECT id
                        FROM pending_ride_requests
                        WHERE user_id = $1
                          AND status = 'accepted'
                          AND pickup_lat = $2
                          AND pickup_lng = $3
                          AND created_at >= CURRENT_TIMESTAMP - INTERVAL '2 hours'
                        ORDER BY created_at DESC
                        LIMIT 1
                    )
                    UPDATE pending_ride_requests pr
                    SET status = 'completed',
                        updated_at = CURRENT_TIMESTAMP
                    FROM target
                    WHERE pr.id = target.id`,
                    [updatedTrip.user_id, updatedTrip.pickup_lat, updatedTrip.pickup_lng]
                );
            } catch (e) {
                // Non-blocking
            }
        }

        await client.query('COMMIT');

        // Realtime emit (after commit)
        try {
            if (beforeTripStatus !== 'completed') {
                io.to(tripRoom(updatedTrip.id)).emit('trip_completed', {
                    trip_id: String(updatedTrip.id),
                    trip_status: 'completed',
                    duration: updatedTrip.duration_minutes !== undefined && updatedTrip.duration_minutes !== null ? Number(updatedTrip.duration_minutes) : (updatedTrip.duration !== undefined && updatedTrip.duration !== null ? Number(updatedTrip.duration) : null),
                    distance: updatedTrip.distance_km !== undefined && updatedTrip.distance_km !== null ? Number(updatedTrip.distance_km) : (updatedTrip.distance !== undefined && updatedTrip.distance !== null ? Number(updatedTrip.distance) : null),
                    price: updatedTrip.price !== undefined && updatedTrip.price !== null ? Number(updatedTrip.price) : (updatedTrip.cost !== undefined && updatedTrip.cost !== null ? Number(updatedTrip.cost) : null)
                });
            }
        } catch (e) {
            // ignore
        }

        return res.json({
            success: true,
            data: {
                trip_id: String(updatedTrip.id),
                price: updatedTrip.price !== undefined && updatedTrip.price !== null ? Number(updatedTrip.price) : Number(updatedTrip.cost || 0),
                duration: updatedTrip.duration_minutes !== undefined && updatedTrip.duration_minutes !== null ? Number(updatedTrip.duration_minutes) : Number(updatedTrip.duration || durationMinutes),
                distance: updatedTrip.distance_km !== undefined && updatedTrip.distance_km !== null ? Number(updatedTrip.distance_km) : Number(updatedTrip.distance || distanceKm),
                payment_method: updatedTrip.payment_method || null
            },
            trip: updatedTrip
        });
    } catch (err) {
        try {
            await client.query('ROLLBACK');
        } catch (e) {
            // ignore
        }
        console.error('Error ending trip:', err);
        return res.status(500).json({ success: false, error: err.message });
    } finally {
        client.release();
    }
}

app.post('/trips/end', requireRole('driver', 'admin'), endTripHandler);
app.post('/api/trips/end', requireRole('driver', 'admin'), endTripHandler);

// Rate driver (Passenger -> Driver)
// Required by rider completion flow: POST /rate-driver { trip_id, rating, comment }
async function rateDriverHandler(req, res) {
    try {
        const { trip_id, rating, comment } = req.body || {};

        const authRole = String(req.auth?.role || '').toLowerCase();
        const authUserId = req.auth?.uid;

        const tripId = trip_id ? String(trip_id) : '';
        const normalizedRating = Number(rating);
        const normalizedComment = comment !== undefined && comment !== null ? String(comment) : '';

        if (!tripId) {
            return res.status(400).json({ success: false, error: 'trip_id is required' });
        }
        if (!Number.isFinite(normalizedRating) || normalizedRating < 1 || normalizedRating > 5) {
            return res.status(400).json({ success: false, error: 'rating must be between 1 and 5' });
        }

        const before = await pool.query('SELECT trip_status, user_id FROM trips WHERE id = $1 LIMIT 1', [tripId]);
        const beforeTripStatus = before.rows.length ? (before.rows[0].trip_status || null) : null;

        if (before.rows.length === 0) {
            return res.status(404).json({ success: false, error: 'Trip not found' });
        }

        if (authRole === 'passenger' && String(before.rows[0].user_id) !== String(authUserId)) {
            return res.status(403).json({ success: false, error: 'Forbidden' });
        }

        const result = await pool.query(
            `UPDATE trips
             SET passenger_rating = $1,
                 rating = $1,
                 passenger_review = NULLIF($2, ''),
                 review = NULLIF($2, ''),
                 trip_status = 'rated'::trip_status_enum,
                 updated_at = CURRENT_TIMESTAMP
             WHERE id = $3
             RETURNING *`,
            [Math.trunc(normalizedRating), normalizedComment, tripId]
        );

        if (result.rows.length === 0) {
            return res.status(404).json({ success: false, error: 'Trip not found' });
        }

        try {
            if (beforeTripStatus !== 'rated') {
                io.to(tripRoom(tripId)).emit('trip_rated', {
                    trip_id: String(tripId),
                    trip_status: 'rated'
                });
            }
        } catch (err) {
            console.warn('⚠️ Failed to emit trip_rated:', err.message);
        }

        res.json({ success: true, data: result.rows[0] });
    } catch (err) {
        console.error('Error rating driver:', err);
        res.status(500).json({ success: false, error: err.message });
    }
}

app.post('/rate-driver', requireRole('passenger', 'admin'), rateDriverHandler);
app.post('/api/rate-driver', requireRole('passenger', 'admin'), rateDriverHandler);

// Rider trip history
async function riderTripsHandler(req, res) {
    try {
        const riderId = req.query.rider_id || req.query.user_id;
        if (!riderId) {
            return res.status(400).json({ success: false, error: 'rider_id is required' });
        }

        const authRole = String(req.auth?.role || '').toLowerCase();
        const authUserId = req.auth?.uid;

        if (authRole === 'passenger' && String(riderId) !== String(authUserId)) {
            return res.status(403).json({ success: false, error: 'Forbidden' });
        }
        if (authRole === 'driver') {
            return res.status(403).json({ success: false, error: 'Forbidden' });
        }

        const result = await pool.query(
            `SELECT
                t.*,
                COALESCE(t.driver_name, d.name) AS driver_name
             FROM trips t
             LEFT JOIN drivers d ON d.id = t.driver_id
                         WHERE COALESCE(t.rider_id, t.user_id) = $1
                             AND t.trip_status IN ('completed'::trip_status_enum, 'rated'::trip_status_enum)
                         ORDER BY t.completed_at DESC NULLS LAST`,
            [riderId]
        );

        res.json({ success: true, data: result.rows });
    } catch (err) {
        console.error('Error fetching rider trips:', err);
        res.status(500).json({ success: false, error: err.message });
    }
}

// Driver trip history
async function driverTripsHandler(req, res) {
    try {
        const driverId = req.query.driver_id;
        if (!driverId) {
            return res.status(400).json({ success: false, error: 'driver_id is required' });
        }

        const authRole = String(req.auth?.role || '').toLowerCase();
        const authDriverId = req.auth?.driver_id;

        if (authRole === 'driver') {
            if (!authDriverId) return res.status(403).json({ success: false, error: 'Driver profile not linked to this account' });
            if (String(driverId) !== String(authDriverId)) {
                return res.status(403).json({ success: false, error: 'Forbidden' });
            }
        }
        if (authRole === 'passenger') {
            return res.status(403).json({ success: false, error: 'Forbidden' });
        }

        const result = await pool.query(
            `SELECT
                t.*,
                u.name AS passenger_name,
                u.phone AS passenger_phone
             FROM trips t
             LEFT JOIN users u ON u.id = t.user_id
             WHERE t.driver_id = $1
                             AND t.trip_status IN ('completed'::trip_status_enum, 'rated'::trip_status_enum)
                         ORDER BY t.completed_at DESC NULLS LAST`,
            [driverId]
        );

        res.json({ success: true, data: result.rows });
    } catch (err) {
        console.error('Error fetching driver trips:', err);
        res.status(500).json({ success: false, error: err.message });
    }
}

app.get('/rider/trips', requireAuth, riderTripsHandler);
app.get('/api/rider/trips', requireAuth, riderTripsHandler);
app.get('/driver/trips', requireAuth, driverTripsHandler);
app.get('/api/driver/trips', requireAuth, driverTripsHandler);

// Get next pending trip (optionally by car type)
app.get('/api/trips/pending/next', requireRole('driver', 'admin'), async (req, res) => {
    try {
        const { car_type, driver_id, lat, lng, limit } = req.query;

        const authRole = String(req.auth?.role || '').toLowerCase();
        const authDriverId = req.auth?.driver_id;

        const effectiveDriverId = authRole === 'driver' ? authDriverId : driver_id;
        if (authRole === 'driver' && !effectiveDriverId) {
            return res.status(403).json({ success: false, error: 'Driver profile not linked to this account' });
        }

        const requestedLimit = Number(limit);
        const listLimit = Number.isFinite(requestedLimit)
            ? Math.min(Math.max(Math.trunc(requestedLimit), 1), 20)
            : 1;

        await pool.query(
            `UPDATE trips
             SET status = 'cancelled', cancelled_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
             WHERE status = 'pending'
               AND driver_id IS NULL
               AND source = 'passenger_app'
               AND created_at < NOW() - ($1 * INTERVAL '1 minute')`,
            [PENDING_TRIP_TTL_MINUTES]
        );

        if (effectiveDriverId) {
            const assignedResult = await pool.query(
                `SELECT t.*, u.name AS passenger_name, u.phone AS passenger_phone
                 FROM trips t
                 LEFT JOIN users u ON t.user_id = u.id
                 WHERE t.status = 'assigned'
                   AND t.driver_id = $1
                   AND t.source = 'passenger_app'
                   AND (u.role IS NULL OR u.role IN ('passenger', 'user'))
                   AND t.created_at >= NOW() - ($2 * INTERVAL '1 minute')
                 ORDER BY t.created_at DESC
                 LIMIT 1`,
                [effectiveDriverId, ASSIGNED_TRIP_TTL_MINUTES]
            );

            if (assignedResult.rows.length > 0) {
                const assignedTrip = assignedResult.rows[0];
                if (listLimit > 1) {
                    return res.json({
                        success: true,
                        data: [assignedTrip],
                        count: 1,
                        meta: { assigned: true }
                    });
                }
                return res.json({ success: true, data: assignedTrip, meta: { assigned: true } });
            }
        }

        let driverLat = null;
        let driverLng = null;

        const latVal = lat !== undefined && lat !== null ? Number(lat) : null;
        const lngVal = lng !== undefined && lng !== null ? Number(lng) : null;

        if (Number.isFinite(latVal) && Number.isFinite(lngVal)) {
            driverLat = latVal;
            driverLng = lngVal;
        } else if (effectiveDriverId) {
            const driverResult = await pool.query(
                `SELECT last_lat, last_lng
                 FROM drivers
                 WHERE id = $1`,
                [effectiveDriverId]
            );
            if (driverResult.rows.length > 0) {
                const row = driverResult.rows[0];
                const lastLat = row.last_lat !== null ? Number(row.last_lat) : null;
                const lastLng = row.last_lng !== null ? Number(row.last_lng) : null;
                if (Number.isFinite(lastLat) && Number.isFinite(lastLng)) {
                    driverLat = lastLat;
                    driverLng = lastLng;
                }
            }
        }

        if (!Number.isFinite(driverLat) || !Number.isFinite(driverLng)) {
            const fallbackParams = [];
            let fallbackQuery = `
                SELECT t.*, u.name AS passenger_name, u.phone AS passenger_phone, NULL::numeric AS pickup_distance_km
                FROM trips t
                LEFT JOIN users u ON t.user_id = u.id
                WHERE t.status = 'pending' AND (t.driver_id IS NULL)
            `;

            fallbackQuery += " AND t.source = 'passenger_app'";
            fallbackQuery += " AND (u.role IS NULL OR u.role IN ('passenger', 'user'))";
            fallbackParams.push(PENDING_TRIP_TTL_MINUTES);
            fallbackQuery += ` AND t.created_at >= NOW() - ($${fallbackParams.length} * INTERVAL '1 minute')`;

            if (car_type) {
                fallbackParams.push(car_type);
                fallbackQuery += ` AND t.car_type = $${fallbackParams.length}`;
            }

            fallbackQuery += ' ORDER BY t.created_at ASC';
            fallbackQuery += ` LIMIT $${fallbackParams.length + 1}`;
            fallbackParams.push(listLimit);

            const fallbackResult = await pool.query(fallbackQuery, fallbackParams);

            if (listLimit > 1) {
                return res.json({
                    success: true,
                    data: fallbackResult.rows,
                    count: fallbackResult.rows.length,
                    meta: { location_fallback: true }
                });
            }

            return res.json({
                success: true,
                data: fallbackResult.rows[0] || null,
                meta: { location_fallback: true }
            });
        }

        const params = [driverLat, driverLng];
        const distanceSelect = `,
            (6371 * acos(
                cos(radians($1)) * cos(radians(t.pickup_lat)) * cos(radians(t.pickup_lng) - radians($2)) +
                sin(radians($1)) * sin(radians(t.pickup_lat))
            )) AS pickup_distance_km
        `;
        let orderClause = ' ORDER BY pickup_distance_km ASC, t.created_at ASC';

        let query = `
            SELECT t.*, u.name AS passenger_name, u.phone AS passenger_phone${distanceSelect}
            FROM trips t
            LEFT JOIN users u ON t.user_id = u.id
            WHERE t.status = 'pending' AND (t.driver_id IS NULL)
        `;

        query += " AND t.pickup_lat IS NOT NULL AND t.pickup_lng IS NOT NULL";
        query += " AND t.source = 'passenger_app'";
        query += " AND (u.role IS NULL OR u.role IN ('passenger', 'user'))";
        params.push(PENDING_TRIP_TTL_MINUTES);
        query += ` AND t.created_at >= NOW() - ($${params.length} * INTERVAL '1 minute')`;

        if (car_type) {
            params.push(car_type);
            query += ` AND t.car_type = $${params.length}`;
        }

        query += `${orderClause} LIMIT $${params.length + 1}`;
        params.push(listLimit);

        const result = await pool.query(query, params);

        if (listLimit > 1) {
            return res.json({
                success: true,
                data: result.rows,
                count: result.rows.length
            });
        }

        res.json({
            success: true,
            data: result.rows[0] || null
        });
    } catch (err) {
        console.error('Error fetching pending trip:', err);
        res.status(500).json({ success: false, error: err.message });
    }
});

// Assign driver to trip
app.patch('/api/trips/:id/assign', requireRole('driver', 'admin'), async (req, res) => {
    try {
        const { id } = req.params;
        const { driver_id, driver_name } = req.body;

        const authRole = String(req.auth?.role || '').toLowerCase();
        const authDriverId = req.auth?.driver_id;

        if (authRole === 'driver' && !authDriverId) {
            return res.status(403).json({ success: false, error: 'Driver profile not linked to this account' });
        }

        const effectiveDriverId = authRole === 'driver' ? authDriverId : driver_id;
        if (!effectiveDriverId) {
            return res.status(400).json({ success: false, error: 'driver_id is required' });
        }

        // Night Safety Policy (driver only; admin override allowed)
        if (authRole === 'driver' && isNightNow()) {
            const dRes = await pool.query(
                `SELECT approval_status, rating, last_location_at
                 FROM drivers
                 WHERE id = $1
                 LIMIT 1`,
                [effectiveDriverId]
            );
            const dRow = dRes.rows[0] || null;
            if (!isDriverEligibleForNightPolicy(dRow)) {
                return res.status(403).json({ success: false, error: 'Night safety policy: driver not eligible', code: 'night_policy_not_eligible' });
            }
        }

        if (authRole === 'driver' && String(driver_id || effectiveDriverId) !== String(effectiveDriverId)) {
            return res.status(403).json({ success: false, error: 'Forbidden' });
        }

        const result = await pool.query(
            `UPDATE trips
             SET driver_id = $1, driver_name = $2, status = 'assigned', updated_at = CURRENT_TIMESTAMP
             WHERE id = $3 AND (status = 'pending' OR (status = 'assigned' AND driver_id = $1))
             RETURNING *`,
            [effectiveDriverId, driver_name || null, id]
        );

        if (result.rows.length === 0) {
            return res.status(404).json({ success: false, error: 'Trip not found or already assigned' });
        }

        const trip = result.rows[0];

        // Keep pending_ride_requests in sync
        try {
            await pool.query(
                `UPDATE pending_ride_requests
                 SET status = 'accepted',
                     assigned_driver_id = $1,
                     assigned_at = COALESCE(assigned_at, CURRENT_TIMESTAMP),
                     updated_at = CURRENT_TIMESTAMP
                 WHERE trip_id = $2 AND status = 'waiting'`,
                [trip.driver_id || null, trip.id]
            );
        } catch (e) {
            // non-blocking
        }

        // Live Match Timeline (Socket.io)
        try {
            if (trip.user_id) {
                io.to(userRoom(trip.user_id)).emit('pending_request_update', {
                    trip_id: String(trip.id),
                    stage: 'driver_accepted',
                    message: 'سائق قبل الطلب',
                    created_at: new Date().toISOString()
                });
                io.to(userRoom(trip.user_id)).emit('trip_assigned', {
                    trip_id: String(trip.id),
                    trip
                });
            }
        } catch (e) {
            // ignore
        }

        res.json({ success: true, data: trip });
    } catch (err) {
        console.error('Error assigning driver:', err);
        res.status(500).json({ success: false, error: err.message });
    }
});

// Reject trip (driver rejects)
app.patch('/api/trips/:id/reject', requireRole('driver', 'admin'), async (req, res) => {
    try {
        const { id } = req.params;

        const authRole = String(req.auth?.role || '').toLowerCase();
        const authDriverId = req.auth?.driver_id;

        if (authRole === 'driver' && !authDriverId) {
            return res.status(403).json({ success: false, error: 'Driver profile not linked to this account' });
        }

        const result = authRole === 'driver'
            ? await pool.query(
                `UPDATE trips
                 SET status = 'pending', driver_id = NULL, driver_name = NULL,
                     updated_at = CURRENT_TIMESTAMP
                 WHERE id = $1 AND status IN ('pending', 'assigned') AND driver_id = $2
                 RETURNING *`,
                [id, authDriverId]
            )
            : await pool.query(
                `UPDATE trips
                 SET status = 'pending', driver_id = NULL, driver_name = NULL,
                     updated_at = CURRENT_TIMESTAMP
                 WHERE id = $1 AND status IN ('pending', 'assigned')
                 RETURNING *`,
                [id]
            );

        if (result.rows.length === 0) {
            return res.status(404).json({ success: false, error: 'Trip not found or not pending' });
        }

        const trip = result.rows[0];

        // Keep pending_ride_requests in sync (return to waiting)
        try {
            await pool.query(
                `UPDATE pending_ride_requests
                 SET status = 'waiting',
                     assigned_driver_id = NULL,
                     assigned_at = NULL,
                     updated_at = CURRENT_TIMESTAMP
                 WHERE trip_id = $1 AND status IN ('accepted','waiting')`,
                [trip.id]
            );
        } catch (e) {
            // non-blocking
        }

        // Live Match Timeline (Socket.io)
        try {
            if (trip.user_id) {
                io.to(userRoom(trip.user_id)).emit('pending_request_update', {
                    trip_id: String(trip.id),
                    stage: 'driver_rejected',
                    message: 'سائق رفض الطلب',
                    created_at: new Date().toISOString()
                });
            }
        } catch (e) {
            // ignore
        }

        res.json({ success: true, data: trip });
    } catch (err) {
        console.error('Error rejecting trip:', err);
        res.status(500).json({ success: false, error: err.message });
    }
});

// Get trip statistics
app.get('/api/trips/stats/summary', requireAuth, async (req, res) => {
    try {
        const { user_id, source } = req.query;

        const authRole = String(req.auth?.role || '').toLowerCase();
        const authUserId = req.auth?.uid;
        const authDriverId = req.auth?.driver_id;

        const effectiveUserId = authRole === 'passenger' ? authUserId : user_id;
        const effectiveDriverId = authRole === 'driver' ? authDriverId : null;

        if (authRole === 'driver' && !effectiveDriverId) {
            return res.status(403).json({ success: false, error: 'Driver profile not linked to this account' });
        }
        
        let whereClause = '';
        const params = [];
        
        if (effectiveUserId) {
            whereClause = 'WHERE user_id = $1';
            params.push(effectiveUserId);
        }

        if (effectiveDriverId) {
            const conjunction = whereClause ? ' AND' : 'WHERE';
            params.push(effectiveDriverId);
            whereClause += `${conjunction} driver_id = $${params.length}`;
        }

        if (source && source !== 'all') {
            const conjunction = whereClause ? ' AND' : 'WHERE';
            whereClause += `${conjunction} source = $${params.length + 1}`;
            params.push(source);
        }
        
        const result = await pool.query(`
            SELECT 
                COUNT(*) as total_trips,
                COUNT(*) FILTER (WHERE status = 'completed') as completed_trips,
                COUNT(*) FILTER (WHERE status = 'cancelled') as cancelled_trips,
                COALESCE(SUM(cost) FILTER (WHERE status = 'completed'), 0) as total_spent,
                COALESCE(AVG(COALESCE(passenger_rating, rating)) FILTER (WHERE status = 'completed' AND COALESCE(passenger_rating, rating) IS NOT NULL), 0) as avg_rating,
                COALESCE(SUM(distance) FILTER (WHERE status = 'completed'), 0) as total_distance
            FROM trips
            ${whereClause}
        `, params);
        
        res.json({
            success: true,
            data: result.rows[0]
        });
    } catch (err) {
        console.error('Error fetching trip stats:', err);
        res.status(500).json({ success: false, error: err.message });
    }
});

// Get admin dashboard statistics
app.get('/api/admin/dashboard/stats', requireRole('admin'), async (req, res) => {
    try {
        const now = new Date();
        const monthKey = monthKeyFromDate(now);

        const totalTripsResult = await pool.query(`
            SELECT COUNT(*)::int AS count
            FROM trips
            WHERE status = 'completed'
        `);

        const totalRevenueResult = await pool.query(`
            SELECT COALESCE(SUM(cost), 0) AS total
            FROM trips
            WHERE status = 'completed'
        `);

        const totalDistanceResult = await pool.query(`
            SELECT COALESCE(SUM(distance), 0) AS total
            FROM trips
            WHERE status = 'completed'
        `);

        const tripsTodayResult = await pool.query(`
            SELECT COUNT(*)::int AS count
            FROM trips
            WHERE status = 'completed'
              AND completed_at::date = CURRENT_DATE
        `);

        const tripsThisMonthResult = await pool.query(`
            SELECT COUNT(*)::int AS count
            FROM trips
            WHERE status = 'completed'
              AND DATE_TRUNC('month', completed_at) = DATE_TRUNC('month', CURRENT_DATE)
        `);

        const driversEarningsResult = await pool.query(`
            SELECT COALESCE(SUM(total_earnings), 0) AS total
            FROM drivers
        `);

        const ratingResult = await pool.query(`
            SELECT COALESCE(AVG(COALESCE(passenger_rating, rating)), 0) as avg_rating
            FROM trips
            WHERE status = 'completed'
              AND COALESCE(passenger_rating, rating) IS NOT NULL
        `);

        // Optional (legacy UI)
        const activeDriversResult = await pool.query(`SELECT COUNT(*)::int as count FROM drivers`);
        const passengersResult = await pool.query(`
            SELECT COUNT(*)::int as count
            FROM users
            WHERE role = 'passenger' OR role = 'user' OR role IS NULL
        `);

        // Counters (incremented on completion)
        let dailyCounters = null;
        let monthlyCounters = null;
        try {
            await ensureAdminTripCountersTables();
            const daily = await pool.query('SELECT * FROM admin_daily_counters WHERE day = CURRENT_DATE LIMIT 1');
            dailyCounters = daily.rows[0] || null;
            const monthly = await pool.query('SELECT * FROM admin_monthly_counters WHERE month_key = $1 LIMIT 1', [monthKey]);
            monthlyCounters = monthly.rows[0] || null;
        } catch (e) {
            dailyCounters = null;
            monthlyCounters = null;
        }
        
        res.json({
            success: true,
            data: {
                // Required metrics
                total_trips: totalTripsResult.rows[0].count,
                total_revenue: parseFloat(totalRevenueResult.rows[0].total),
                total_drivers_earnings: parseFloat(driversEarningsResult.rows[0].total),
                total_distance: parseFloat(totalDistanceResult.rows[0].total),
                trips_today: tripsTodayResult.rows[0].count,
                trips_this_month: tripsThisMonthResult.rows[0].count,
                // Counters
                daily_trips: dailyCounters ? Number(dailyCounters.daily_trips) : tripsTodayResult.rows[0].count,
                daily_revenue: dailyCounters ? Number(dailyCounters.daily_revenue) : parseFloat(totalRevenueResult.rows[0].total),
                monthly_trips: monthlyCounters ? Number(monthlyCounters.monthly_trips) : tripsThisMonthResult.rows[0].count,
                monthly_revenue: monthlyCounters ? Number(monthlyCounters.monthly_revenue) : parseFloat(totalRevenueResult.rows[0].total),
                // Backward-compatible fields
                today_trips: tripsTodayResult.rows[0].count,
                active_drivers: activeDriversResult.rows[0].count,
                total_passengers: passengersResult.rows[0].count,
                total_earnings: parseFloat(totalRevenueResult.rows[0].total),
                avg_rating: parseFloat(ratingResult.rows[0].avg_rating).toFixed(1)
            }
        });
    } catch (err) {
        console.error('Error fetching admin dashboard stats:', err);
        res.status(500).json({ success: false, error: err.message });
    }
});

// ==================== DRIVERS ENDPOINTS ====================

// Get all available drivers
app.get('/api/drivers', requireAuth, async (req, res) => {
    try {
        // Add no-cache headers to always get fresh data
        res.set({
            'Cache-Control': 'no-store, no-cache, must-revalidate, proxy-revalidate',
            'Pragma': 'no-cache',
            'Expires': '0',
            'Surrogate-Control': 'no-store'
        });
        
        const { status } = req.query;
        
        let query = 'SELECT * FROM drivers';
        let params = [];
        
        if (status && status !== 'all') {
            query += ' WHERE status = $1';
            params.push(status);
        }
        
        query += ' ORDER BY id DESC';
        
        const result = await pool.query(query, params);
        
        res.json({
            success: true,
            data: result.rows
        });
    } catch (err) {
        console.error('Error fetching drivers:', err);
        res.status(500).json({ success: false, error: err.message });
    }
});

// Update driver live location
app.patch('/api/drivers/:id/location', requireRole('driver', 'admin'), async (req, res) => {
    try {
        const { id } = req.params;
        const { lat, lng } = req.body;

        const authRole = String(req.auth?.role || '').toLowerCase();
        const authDriverId = req.auth?.driver_id;

        if (authRole === 'driver') {
            if (!authDriverId) {
                return res.status(403).json({ success: false, error: 'Driver profile not linked to this account' });
            }
            if (String(id) !== String(authDriverId)) {
                return res.status(403).json({ success: false, error: 'Forbidden' });
            }
        }

        const latitude = lat !== undefined && lat !== null ? Number(lat) : null;
        const longitude = lng !== undefined && lng !== null ? Number(lng) : null;

        if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) {
            return res.status(400).json({ success: false, error: 'Invalid coordinates.' });
        }

        const result = await pool.query(
            `UPDATE drivers
             SET last_lat = $1, last_lng = $2, last_location_at = CURRENT_TIMESTAMP, status = 'online', updated_at = CURRENT_TIMESTAMP
             WHERE id = $3
             RETURNING id, name, status, last_lat, last_lng, last_location_at`,
            [latitude, longitude, id]
        );

        if (result.rows.length === 0) {
            return res.status(404).json({ success: false, error: 'Driver not found' });
        }

        res.json({ success: true, data: result.rows[0] });
    } catch (err) {
        console.error('Error updating driver location:', err);
        res.status(500).json({ success: false, error: err.message });
    }
});

// Get driver last known location
app.get('/api/drivers/:id/location', requireAuth, async (req, res) => {
    try {
        const { id } = req.params;
        const result = await pool.query(
            `SELECT id, name, status, car_type, last_lat, last_lng, last_location_at
             FROM drivers
             WHERE id = $1`,
            [id]
        );

        if (result.rows.length === 0) {
            return res.status(404).json({ success: false, error: 'Driver not found' });
        }

        res.json({ success: true, data: result.rows[0] });
    } catch (err) {
        console.error('Error fetching driver location:', err);
        res.status(500).json({ success: false, error: err.message });
    }
});

// Get nearest driver by coordinates
app.get('/api/drivers/nearest', requireAuth, async (req, res) => {
    try {
        const { lat, lng, car_type } = req.query;
        const latitude = lat !== undefined && lat !== null ? Number(lat) : null;
        const longitude = lng !== undefined && lng !== null ? Number(lng) : null;

        if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) {
            return res.status(400).json({ success: false, error: 'Invalid coordinates.' });
        }

        const params = [latitude, longitude];
        let carFilter = '';
        if (car_type) {
            params.push(String(car_type));
            carFilter = ` AND car_type = $${params.length}`;
        }

        const result = await pool.query(
            `SELECT id, name, status, car_type, last_lat, last_lng, last_location_at,
                    (6371 * acos(
                        cos(radians($1)) * cos(radians(last_lat)) * cos(radians(last_lng) - radians($2)) +
                        sin(radians($1)) * sin(radians(last_lat))
                    )) AS distance_km
             FROM drivers
             WHERE status = 'online'
               AND approval_status = 'approved'
               AND last_lat IS NOT NULL
               AND last_lng IS NOT NULL
               AND last_location_at >= NOW() - ($${params.length + 1} * INTERVAL '1 minute')
               ${carFilter}
             ORDER BY distance_km ASC
             LIMIT 1`,
            [...params, DRIVER_LOCATION_TTL_MINUTES]
        );

        res.json({ success: true, data: result.rows[0] || null });
    } catch (err) {
        console.error('Error fetching nearest driver:', err);
        res.status(500).json({ success: false, error: err.message });
    }
});

// Resolve driver profile by email or phone
app.get('/api/drivers/resolve', requireRole('driver', 'admin'), async (req, res) => {
    try {
        const { email, phone, auto_create } = req.query;

        if (!email && !phone) {
            return res.status(400).json({ success: false, error: 'email or phone is required' });
        }

        const params = [];
        const conditions = [];
        let query = 'SELECT id, name, phone, email, car_type, status, approval_status, rating, total_trips FROM drivers';

        if (email) {
            params.push(String(email).trim().toLowerCase());
            conditions.push(`LOWER(email) = $${params.length}`);
        }

        if (phone) {
            params.push(String(phone).trim());
            conditions.push(`phone = $${params.length}`);
        }

        if (conditions.length) {
            query += ` WHERE ${conditions.join(' OR ')}`;
        }

        const result = await pool.query(query, params);

        if (result.rows.length === 0) {
            if (String(auto_create) !== '1') {
                return res.status(404).json({ success: false, error: 'Driver not found' });
            }

            const userLookup = await pool.query(
                `SELECT id, name, phone, email
                 FROM users
                 WHERE (email = $1 OR phone = $2)
                 LIMIT 1`,
                [email ? String(email).trim().toLowerCase() : null, phone ? String(phone).trim() : null]
            );

            const fallbackName = userLookup.rows[0]?.name || 'كابتن جديد';
            const fallbackPhone = userLookup.rows[0]?.phone || (phone ? String(phone).trim() : `05${Date.now().toString().slice(-8)}`);
            const fallbackEmail = userLookup.rows[0]?.email || (email ? String(email).trim().toLowerCase() : `driver_${Date.now()}@ubar.sa`);

            const insert = await pool.query(
                `INSERT INTO drivers (name, phone, email, car_type, status, approval_status, rating, total_trips)
                 VALUES ($1, $2, $3, 'economy', 'online', 'approved', 5.0, 0)
                 RETURNING id, name, phone, email, car_type, status, approval_status, rating, total_trips`,
                [fallbackName, fallbackPhone, fallbackEmail]
            );

            return res.json({ success: true, data: insert.rows[0], created: true });
        }

        res.json({ success: true, data: result.rows[0] });
    } catch (err) {
        console.error('Error resolving driver:', err);
        res.status(500).json({ success: false, error: err.message });
    }
});

// Register new driver
app.post('/api/drivers/register', upload.fields([
    { name: 'id_card_photo', maxCount: 1 },
    { name: 'drivers_license', maxCount: 1 },
    { name: 'vehicle_license', maxCount: 1 }
]), async (req, res) => {
    try {
        const { name, phone, email, password, car_type, car_plate } = req.body;
        
        // Validate required fields
        if (!name || !phone || !email || !password) {
            return res.status(400).json({ 
                success: false, 
                error: 'Name, phone, email, and password are required' 
            });
        }
        
        // Validate required documents
        if (!req.files || !req.files.id_card_photo || !req.files.drivers_license || !req.files.vehicle_license) {
            return res.status(400).json({ 
                success: false, 
                error: 'All three documents (ID card, driver\'s license, vehicle license) are required' 
            });
        }
        
        // Check if driver already exists
        const existingDriver = await pool.query(
            'SELECT * FROM drivers WHERE phone = $1 OR email = $2',
            [phone, email]
        );
        
        if (existingDriver.rows.length > 0) {
            return res.status(400).json({ 
                success: false, 
                error: 'Driver with this phone or email already exists' 
            });
        }
        
        // Get file paths
        const id_card_photo = `/uploads/${req.files.id_card_photo[0].filename}`;
        const drivers_license = `/uploads/${req.files.drivers_license[0].filename}`;
        const vehicle_license = `/uploads/${req.files.vehicle_license[0].filename}`;

        const hashedPassword = await hashPassword(password);
        
        // Insert new driver
        const result = await pool.query(`
            INSERT INTO drivers (
                name, phone, email, password, car_type, car_plate,
                id_card_photo, drivers_license, vehicle_license,
                approval_status, status
            ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'pending', 'offline')
            RETURNING id, name, phone, email, car_type, car_plate, 
                      id_card_photo, drivers_license, vehicle_license,
                      approval_status, created_at
        `, [name, phone, email, hashedPassword, car_type || 'economy', car_plate || '',
            id_card_photo, drivers_license, vehicle_license]);
        
        res.status(201).json({
            success: true,
            message: 'Driver registration submitted. Waiting for admin approval.',
            data: result.rows[0]
        });
    } catch (err) {
        console.error('Error registering driver:', err);
        res.status(500).json({ success: false, error: err.message });
    }
});

// Get driver registration status
app.get('/api/drivers/status/:phone', async (req, res) => {
    try {
        const { phone } = req.params;
        
        const result = await pool.query(
            `SELECT id, name, phone, email, car_type, car_plate, 
                    approval_status, rejection_reason, created_at, approved_at
             FROM drivers WHERE phone = $1`,
            [phone]
        );
        
        if (result.rows.length === 0) {
            return res.status(404).json({ 
                success: false, 
                error: 'Driver not found' 
            });
        }
        
        res.json({
            success: true,
            data: result.rows[0]
        });
    } catch (err) {
        console.error('Error fetching driver status:', err);
        res.status(500).json({ success: false, error: err.message });
    }
});

// Get pending driver registrations (admin only)
app.get('/api/drivers/pending', requireRole('admin'), async (req, res) => {
    try {
        const result = await pool.query(
            `SELECT id, name, phone, email, car_type, car_plate,
                    id_card_photo, drivers_license, vehicle_license,
                    approval_status, created_at
             FROM drivers 
             WHERE approval_status = 'pending'
             ORDER BY created_at DESC`
        );
        
        res.json({
            success: true,
            data: result.rows
        });
    } catch (err) {
        console.error('Error fetching pending drivers:', err);
        res.status(500).json({ success: false, error: err.message });
    }
});

// Approve or reject driver registration (admin only)
app.patch('/api/drivers/:id/approval', requireRole('admin'), async (req, res) => {
    try {
        const { id } = req.params;
        const { approval_status, rejection_reason, approved_by } = req.body;
        
        if (!['approved', 'rejected'].includes(approval_status)) {
            return res.status(400).json({ 
                success: false, 
                error: 'Invalid approval status. Must be "approved" or "rejected"' 
            });
        }
        
        let query = `
            UPDATE drivers 
            SET approval_status = $1, 
                updated_at = CURRENT_TIMESTAMP
        `;
        const params = [approval_status];
        let paramCount = 1;
        
        if (approval_status === 'approved') {
            query += `, approved_at = CURRENT_TIMESTAMP, status = 'offline'`;
            if (approved_by) {
                paramCount++;
                query += `, approved_by = $${paramCount}`;
                params.push(approved_by);
            }
        } else if (approval_status === 'rejected' && rejection_reason) {
            paramCount++;
            query += `, rejection_reason = $${paramCount}`;
            params.push(rejection_reason);
        }
        
        paramCount++;
        query += ` WHERE id = $${paramCount} RETURNING *`;
        params.push(parseInt(id));
        
        const result = await pool.query(query, params);
        
        if (result.rows.length === 0) {
            return res.status(404).json({ 
                success: false, 
                error: 'Driver not found' 
            });
        }
        
        // Also create/update user account if approved
        if (approval_status === 'approved') {
            const driver = result.rows[0];

            const passwordToStore = looksLikeBcryptHash(driver.password)
                ? driver.password
                : await hashPassword(driver.password || '12345678');

            await pool.query(`
                INSERT INTO users (phone, name, email, password, role)
                VALUES ($1, $2, $3, $4, 'driver')
                ON CONFLICT (phone) DO UPDATE 
                SET role = 'driver', email = $3, name = $2
            `, [driver.phone, driver.name, driver.email, passwordToStore]);
        }
        
        res.json({
            success: true,
            message: `Driver ${approval_status === 'approved' ? 'approved' : 'rejected'} successfully`,
            data: result.rows[0]
        });
    } catch (err) {
        console.error('Error updating driver approval:', err);
        res.status(500).json({ success: false, error: err.message });
    }
});

// Get driver statistics (earnings, trips, etc.)
app.get('/api/drivers/:id/stats', requireRole('driver', 'admin'), async (req, res) => {
    try {
        const { id } = req.params;

        const authRole = String(req.auth?.role || '').toLowerCase();
        const authDriverId = req.auth?.driver_id;
        if (authRole === 'driver') {
            if (!authDriverId) {
                return res.status(403).json({ success: false, error: 'Driver profile not linked to this account' });
            }
            if (String(id) !== String(authDriverId)) {
                return res.status(403).json({ success: false, error: 'Forbidden' });
            }
        }
        
        // Add no-cache headers to ensure fresh data
        res.set({
            'Cache-Control': 'no-store, no-cache, must-revalidate, proxy-revalidate',
            'Pragma': 'no-cache',
            'Expires': '0',
            'Surrogate-Control': 'no-store'
        });
        
        // Get driver info from drivers table (always read from database)
        const driverResult = await pool.query(`
            SELECT 
                id, name, phone, email, rating,
                COALESCE(total_earnings, 0) as total_earnings,
                COALESCE(balance, 0) as balance,
                COALESCE(today_earnings, 0) as today_earnings,
                COALESCE(today_trips_count, 0) as today_trips_count,
                COALESCE(total_trips, 0) as total_trips
            FROM drivers
            WHERE id = $1
        `, [id]);
        
        if (driverResult.rows.length === 0) {
            return res.status(404).json({ success: false, error: 'Driver not found' });
        }
        
        const driver = driverResult.rows[0];
        
        // Use data directly from drivers table for real-time updates
        // This ensures that manual database changes are immediately reflected
        const todayData = {
            today_trips: parseInt(driver.today_trips_count) || 0,
            today_earnings: parseFloat(driver.today_earnings) || 0
        };
        
        const totalData = {
            total_trips: parseInt(driver.total_trips) || 0,
            total_earnings: parseFloat(driver.total_earnings) || 0
        };
        
        // Get recent trips (last 10)
        const recentTripsResult = await pool.query(`
            SELECT 
                t.*,
                u.name as passenger_name,
                u.phone as passenger_phone
            FROM trips t
            LEFT JOIN users u ON t.user_id = u.id
            WHERE t.driver_id = $1 AND t.status = 'completed'
            ORDER BY t.completed_at DESC
            LIMIT 10
        `, [id]);
        
        res.json({
            success: true,
            data: {
                driver: {
                    id: driver.id,
                    name: driver.name,
                    phone: driver.phone,
                    email: driver.email,
                    rating: parseFloat(driver.rating || 0)
                },
                earnings: {
                    total: totalData.total_earnings,
                    balance: parseFloat(driver.balance),
                    today: todayData.today_earnings
                },
                trips: {
                    total: totalData.total_trips,
                    today: todayData.today_trips,
                    completed: totalData.total_trips
                },
                recent_trips: recentTripsResult.rows
            }
        });
    } catch (err) {
        console.error('Error fetching driver stats:', err);
        res.status(500).json({ success: false, error: err.message });
    }
});

// Get driver earnings history from driver_earnings table
app.get('/api/drivers/:id/earnings', requireRole('driver', 'admin'), async (req, res) => {
    try {
        const { id } = req.params;
        const { days = 30 } = req.query;

        const authRole = String(req.auth?.role || '').toLowerCase();
        const authDriverId = req.auth?.driver_id;
        if (authRole === 'driver') {
            if (!authDriverId) {
                return res.status(403).json({ success: false, error: 'Driver profile not linked to this account' });
            }
            if (String(id) !== String(authDriverId)) {
                return res.status(403).json({ success: false, error: 'Forbidden' });
            }
        }
        
        // Get earnings history
        const earningsResult = await pool.query(`
            SELECT 
                date,
                today_trips,
                today_earnings,
                total_trips,
                total_earnings,
                created_at,
                updated_at
            FROM driver_earnings
            WHERE driver_id = $1
            AND date >= CURRENT_DATE - INTERVAL '1 day' * $2
            ORDER BY date DESC
        `, [id, parseInt(days)]);
        
        res.json({
            success: true,
            data: earningsResult.rows
        });
    } catch (err) {
        console.error('Error fetching driver earnings:', err);
        res.status(500).json({ success: false, error: err.message });
    }
});

// Update driver earnings (Admin)
app.put('/api/drivers/:id/earnings/update', requireRole('admin'), async (req, res) => {
    try {
        const { id } = req.params;
        const { today_trips_count, today_earnings, total_trips, total_earnings, balance } = req.body;
        
        // Validate input
        if (today_trips_count === undefined || today_earnings === undefined || 
            total_trips === undefined || total_earnings === undefined || balance === undefined) {
            return res.status(400).json({ 
                success: false, 
                error: 'Missing required fields' 
            });
        }
        
        // Update drivers table
        const updateQuery = `
            UPDATE drivers 
            SET 
                today_trips_count = $1,
                today_earnings = $2,
                total_trips = $3,
                total_earnings = $4,
                balance = $5,
                last_earnings_update = CURRENT_DATE,
                updated_at = CURRENT_TIMESTAMP
            WHERE id = $6
            RETURNING id, name, today_trips_count, today_earnings, total_trips, total_earnings, balance
        `;
        
        const result = await pool.query(updateQuery, [
            today_trips_count,
            today_earnings,
            total_trips,
            total_earnings,
            balance,
            id
        ]);
        
        if (result.rows.length === 0) {
            return res.status(404).json({ 
                success: false, 
                error: 'Driver not found' 
            });
        }
        
        // Update or create today's record in driver_earnings table
        const earningsUpdateQuery = `
            INSERT INTO driver_earnings (
                driver_id, 
                date, 
                today_trips, 
                today_earnings, 
                total_trips, 
                total_earnings
            )
            VALUES ($1, CURRENT_DATE, $2, $3, $4, $5)
            ON CONFLICT (driver_id, date) 
            DO UPDATE SET
                today_trips = $2,
                today_earnings = $3,
                total_trips = $4,
                total_earnings = $5,
                updated_at = CURRENT_TIMESTAMP
        `;
        
        await pool.query(earningsUpdateQuery, [
            id,
            today_trips_count,
            today_earnings,
            total_trips,
            total_earnings
        ]);
        
        res.json({
            success: true,
            data: result.rows[0],
            message: 'Driver earnings updated successfully'
        });
        
        console.log(`✅ Updated earnings for driver ${id}:`, result.rows[0]);
        
    } catch (err) {
        console.error('Error updating driver earnings:', err);
        res.status(500).json({ success: false, error: err.message });
    }
});

// Update driver profile (comprehensive update with sync)
app.put('/api/drivers/:id/update', requireRole('admin'), async (req, res) => {
    try {
        const { id } = req.params;
        const updates = req.body;
        
        // Use sync system to update driver
        const updatedDriver = await driverSync.updateDriverInDatabase(id, updates);
        
        // Sync earnings if earnings-related fields were updated
        if (updates.today_trips_count !== undefined || 
            updates.today_earnings !== undefined || 
            updates.total_trips !== undefined || 
            updates.total_earnings !== undefined) {
            await driverSync.syncDriverEarnings(id);
        }
        
        res.json({
            success: true,
            data: updatedDriver,
            message: 'Driver updated and synced successfully'
        });
        
        console.log(`✅ Driver ${id} updated and synced`);
        
    } catch (err) {
        console.error('Error updating driver:', err);
        res.status(500).json({ success: false, error: err.message });
    }
});

// Force sync driver data from database
app.post('/api/drivers/:id/sync', async (req, res) => {
    try {
        const { id } = req.params;
        
        // Sync from database
        const driver = await driverSync.syncDriverFromDatabase(id);
        
        // Sync earnings
        await driverSync.syncDriverEarnings(id);
        
        res.json({
            success: true,
            data: driver,
            message: 'Driver synced successfully'
        });
        
        console.log(`✅ Driver ${id} synced from database`);
        
    } catch (err) {
        console.error('Error syncing driver:', err);
        res.status(500).json({ success: false, error: err.message });
    }
});

// Sync all drivers
app.post('/api/drivers/sync-all', async (req, res) => {
    try {
        await driverSync.syncAllDriversEarnings();
        
        res.json({
            success: true,
            message: 'All drivers synced successfully'
        });
        
        console.log(`✅ All drivers synced`);
        
    } catch (err) {
        console.error('Error syncing all drivers:', err);
        res.status(500).json({ success: false, error: err.message });
    }
});

// ==================== USERS ENDPOINTS ====================

// Get users with optional filtering
app.get('/api/users', requireRole('admin'), async (req, res) => {
    try {
        const { role, limit = 50, offset = 0 } = req.query;

        let query = 'SELECT id, phone, name, email, role, car_type, car_plate, balance, points, rating, status, avatar, created_at FROM users WHERE 1=1';
        const params = [];
        let paramCount = 0;

        if (role && role !== 'all') {
            paramCount++;
            query += ` AND role = $${paramCount}`;
            params.push(role);
        }

        query += ' ORDER BY created_at DESC';

        paramCount++;
        query += ` LIMIT $${paramCount}`;
        params.push(limit);

        paramCount++;
        query += ` OFFSET $${paramCount}`;
        params.push(offset);

        const result = await pool.query(query, params);

        let countQuery = 'SELECT COUNT(*) FROM users WHERE 1=1';
        const countParams = [];
        let countParamIndex = 0;

        if (role && role !== 'all') {
            countParamIndex++;
            countQuery += ` AND role = $${countParamIndex}`;
            countParams.push(role);
        }

        const countResult = await pool.query(countQuery, countParams);

        res.json({
            success: true,
            data: result.rows,
            total: parseInt(countResult.rows[0].count, 10),
            limit: parseInt(limit, 10),
            offset: parseInt(offset, 10)
        });
    } catch (err) {
        console.error('Error fetching users:', err);
        res.status(500).json({ success: false, error: err.message });
    }
});

// Get single user by ID
app.get('/api/users/:id', requireAuth, async (req, res) => {
    try {
        const { id } = req.params;

        const authRole = String(req.auth?.role || '').toLowerCase();
        const authUserId = req.auth?.uid;
        if (authRole !== 'admin' && String(id) !== String(authUserId)) {
            return res.status(403).json({ success: false, error: 'Forbidden' });
        }

        const result = await pool.query(
            'SELECT id, phone, name, email, role, car_type, car_plate, balance, points, rating, status, avatar, created_at, driver_id FROM users WHERE id = $1',
            [id]
        );

        if (result.rows.length === 0) {
            return res.status(404).json({
                success: false,
                error: 'User not found'
            });
        }

        let userData = result.rows[0];

        // If user is a driver, also fetch driver earnings data
        if (userData.role === 'driver' && userData.driver_id) {
            try {
                // Fetch the most recent earnings record (for cumulative totals)
                const latestEarningsResult = await pool.query(
                    `SELECT today_trips, today_earnings, total_trips, total_earnings, date 
                     FROM driver_earnings 
                     WHERE driver_id = $1 
                     ORDER BY date DESC 
                     LIMIT 1`,
                    [userData.driver_id]
                );

                // Fetch today's specific data
                const todayEarningsResult = await pool.query(
                    `SELECT today_trips, today_earnings 
                     FROM driver_earnings 
                     WHERE driver_id = $1 AND date = CURRENT_DATE 
                     LIMIT 1`,
                    [userData.driver_id]
                );

                // Use latest record for total_trips and total_earnings (cumulative)
                // Use today's record for today_trips and today_earnings
                const latestData = latestEarningsResult.rows[0] || {};
                const todayData = todayEarningsResult.rows[0] || {};

                userData = {
                    ...userData,
                    today_trips: todayData.today_trips || 0,
                    today_earnings: todayData.today_earnings || 0,
                    total_trips: latestData.total_trips || 0,
                    total_earnings: latestData.total_earnings || 0
                };
            } catch (earningsErr) {
                console.error('Error fetching driver earnings:', earningsErr);
                // Continue without earnings data
                userData = {
                    ...userData,
                    today_trips: 0,
                    today_earnings: 0,
                    total_trips: 0,
                    total_earnings: 0
                };
            }
        }

        res.json({
            success: true,
            data: userData
        });
    } catch (err) {
        console.error('Error fetching user:', err);
        res.status(500).json({ success: false, error: err.message });
    }
});

// Update user by ID
app.put('/api/users/:id', requireAuth, async (req, res) => {
    try {
        const { id } = req.params;
        const { phone, name, email, password, car_type, car_plate, balance, points, rating, status, avatar } = req.body;

        const authRole = String(req.auth?.role || '').toLowerCase();
        const authUserId = req.auth?.uid;
        if (authRole !== 'admin' && String(id) !== String(authUserId)) {
            return res.status(403).json({ success: false, error: 'Forbidden' });
        }

        // Check if user exists
        const existing = await pool.query(
            'SELECT id FROM users WHERE id = $1',
            [id]
        );

        if (existing.rows.length === 0) {
            return res.status(404).json({
                success: false,
                error: 'User not found'
            });
        }

        const updates = [];
        const params = [];
        let paramCount = 0;

        if (phone !== undefined && String(phone).trim()) {
            const normalizedPhone = normalizePhoneForStore(phone);
            paramCount++;
            updates.push(`phone = $${paramCount}`);
            params.push(normalizedPhone);
        }

        if (name !== undefined && String(name).trim()) {
            paramCount++;
            updates.push(`name = $${paramCount}`);
            params.push(String(name).trim());
        }

        if (email !== undefined && String(email).trim()) {
            paramCount++;
            updates.push(`email = $${paramCount}`);
            params.push(String(email).trim().toLowerCase());
        }

        if (car_type !== undefined && String(car_type).trim()) {
            paramCount++;
            updates.push(`car_type = $${paramCount}`);
            params.push(String(car_type).trim());
        }

        if (car_plate !== undefined && String(car_plate).trim()) {
            paramCount++;
            updates.push(`car_plate = $${paramCount}`);
            params.push(String(car_plate).trim());
        }

        if (balance !== undefined) {
            paramCount++;
            updates.push(`balance = $${paramCount}`);
            params.push(parseFloat(balance) || 0);
        }

        if (points !== undefined) {
            paramCount++;
            updates.push(`points = $${paramCount}`);
            params.push(parseInt(points, 10) || 0);
        }

        if (rating !== undefined) {
            paramCount++;
            updates.push(`rating = $${paramCount}`);
            params.push(parseFloat(rating) || 5.0);
        }

        if (status !== undefined && String(status).trim()) {
            paramCount++;
            updates.push(`status = $${paramCount}`);
            params.push(String(status).trim());
        }

        if (avatar !== undefined && String(avatar).trim()) {
            paramCount++;
            updates.push(`avatar = $${paramCount}`);
            params.push(String(avatar).trim());
        }

        if (password !== undefined && String(password).trim()) {
            const hashed = await hashPassword(String(password).trim());
            paramCount++;
            updates.push(`password = $${paramCount}`);
            params.push(hashed);
        }

        if (updates.length === 0) {
            return res.status(400).json({
                success: false,
                error: 'No valid fields to update'
            });
        }

        paramCount++;
        updates.push(`updated_at = CURRENT_TIMESTAMP`);
        params.push(id);

        const query = `UPDATE users SET ${updates.join(', ')} WHERE id = $${paramCount} RETURNING id, phone, name, email, role, car_type, car_plate, balance, points, rating, status, avatar, created_at, updated_at`;

        const result = await pool.query(query, params);

        res.json({
            success: true,
            data: result.rows[0]
        });
    } catch (err) {
        console.error('Error updating user:', err);
        if (err.code === '23505') {
            return res.status(400).json({
                success: false,
                error: 'Phone or email already in use'
            });
        }
        res.status(500).json({ success: false, error: err.message });
    }
});

// ==================== PASSENGERS ENDPOINTS ====================

// Get all passengers with filtering and search
app.get('/api/passengers', requireRole('admin'), async (req, res) => {
    try {
        const { search, limit = 50, offset = 0 } = req.query;

        let query = 'SELECT id, phone, name, email, role, car_type, car_plate, balance, points, rating, status, avatar, created_at, updated_at FROM users WHERE role = $1';
        const params = ['passenger'];
        let paramCount = 1;

        if (search && search.trim()) {
            paramCount++;
            query += ` AND (name ILIKE $${paramCount} OR phone ILIKE $${paramCount} OR email ILIKE $${paramCount})`;
            params.push(`%${search.trim()}%`);
        }

        query += ' ORDER BY created_at DESC';

        paramCount++;
        query += ` LIMIT $${paramCount}`;
        params.push(limit);

        paramCount++;
        query += ` OFFSET $${paramCount}`;
        params.push(offset);

        const result = await pool.query(query, params);

        let countQuery = 'SELECT COUNT(*) FROM users WHERE role = $1';
        const countParams = ['passenger'];
        let countParamIndex = 1;

        if (search && search.trim()) {
            countParamIndex++;
            countQuery += ` AND (name ILIKE $${countParamIndex} OR phone ILIKE $${countParamIndex} OR email ILIKE $${countParamIndex})`;
            countParams.push(`%${search.trim()}%`);
        }

        const countResult = await pool.query(countQuery, countParams);

        res.json({
            success: true,
            data: result.rows,
            total: parseInt(countResult.rows[0].count, 10),
            limit: parseInt(limit, 10),
            offset: parseInt(offset, 10)
        });
    } catch (err) {
        console.error('Error fetching passengers:', err);
        res.status(500).json({ success: false, error: err.message });
    }
});

// Get single passenger by ID
app.get('/api/passengers/:id', requireAuth, async (req, res) => {
    try {
        const { id } = req.params;

        const authRole = String(req.auth?.role || '').toLowerCase();
        const authUserId = req.auth?.uid;
        if (authRole === 'driver') {
            return res.status(403).json({ success: false, error: 'Forbidden' });
        }
        if (authRole !== 'admin' && String(id) !== String(authUserId)) {
            return res.status(403).json({ success: false, error: 'Forbidden' });
        }

        const result = await pool.query(
            'SELECT id, phone, name, email, role, car_type, car_plate, balance, points, rating, status, avatar, created_at, updated_at FROM users WHERE id = $1 AND role = $2',
            [id, 'passenger']
        );

        if (result.rows.length === 0) {
            return res.status(404).json({
                success: false,
                error: 'Passenger not found'
            });
        }

        // Get passenger statistics
        const tripsStats = await pool.query(
            `SELECT 
                COUNT(*) as total_trips,
                COUNT(CASE WHEN status = 'completed' THEN 1 END) as completed_trips,
                COUNT(CASE WHEN status = 'cancelled' THEN 1 END) as cancelled_trips,
                COALESCE(SUM(CASE WHEN status = 'completed' THEN cost ELSE 0 END), 0) as total_spent
             FROM trips 
             WHERE user_id = $1`,
            [id]
        );

        const passengerData = {
            ...result.rows[0],
            stats: tripsStats.rows[0]
        };

        res.json({
            success: true,
            data: passengerData
        });
    } catch (err) {
        console.error('Error fetching passenger:', err);
        res.status(500).json({ success: false, error: err.message });
    }
});

// Create new passenger
app.post('/api/passengers', requireRole('admin'), async (req, res) => {
    try {
        const { phone, name, email, password } = req.body;

        if (!phone || !name) {
            return res.status(400).json({
                success: false,
                error: 'Phone and name are required'
            });
        }

        const normalizedPhone = String(phone).trim();
        const normalizedName = String(name).trim();
        const normalizedEmail = email && String(email).trim() 
            ? String(email).trim().toLowerCase() 
            : `passenger_${normalizedPhone.replace(/\D/g, '') || Date.now()}@ubar.sa`;
        const normalizedPassword = password && String(password).trim()
            ? String(password).trim()
            : '12345678';
        const hashedPassword = await hashPassword(normalizedPassword);

        // Check if phone already exists
        const existingPhone = await pool.query(
            'SELECT id FROM users WHERE phone = $1',
            [normalizedPhone]
        );

        if (existingPhone.rows.length > 0) {
            return res.status(400).json({
                success: false,
                error: 'Phone number already registered'
            });
        }

        // Check if email already exists
        const existingEmail = await pool.query(
            'SELECT id FROM users WHERE email = $1',
            [normalizedEmail]
        );

        if (existingEmail.rows.length > 0) {
            return res.status(400).json({
                success: false,
                error: 'Email already registered'
            });
        }

        const result = await pool.query(
            `INSERT INTO users (phone, name, email, password, role, updated_at)
             VALUES ($1, $2, $3, $4, 'passenger', CURRENT_TIMESTAMP)
             RETURNING id, phone, name, email, role, created_at, updated_at`,
            [normalizedPhone, normalizedName, normalizedEmail, hashedPassword]
        );

        res.status(201).json({
            success: true,
            data: result.rows[0]
        });
    } catch (err) {
        console.error('Error creating passenger:', err);
        res.status(500).json({ success: false, error: err.message });
    }
});

// Update passenger
app.put('/api/passengers/:id', requireAuth, async (req, res) => {
    try {
        const { id } = req.params;
        const { phone, name, email, password, car_type, car_plate, balance, points, rating, status, avatar } = req.body;

        const authRole = String(req.auth?.role || '').toLowerCase();
        const authUserId = req.auth?.uid;
        if (authRole === 'driver') {
            return res.status(403).json({ success: false, error: 'Forbidden' });
        }
        if (authRole !== 'admin' && String(id) !== String(authUserId)) {
            return res.status(403).json({ success: false, error: 'Forbidden' });
        }

        // Check if passenger exists
        const existing = await pool.query(
            'SELECT id FROM users WHERE id = $1 AND role = $2',
            [id, 'passenger']
        );

        if (existing.rows.length === 0) {
            return res.status(404).json({
                success: false,
                error: 'Passenger not found'
            });
        }

        const updates = [];
        const params = [];
        let paramCount = 0;

        if (phone !== undefined && String(phone).trim()) {
            const normalizedPhone = normalizePhoneForStore(phone);
            paramCount++;
            updates.push(`phone = $${paramCount}`);
            params.push(normalizedPhone);
        }

        if (name !== undefined && String(name).trim()) {
            paramCount++;
            updates.push(`name = $${paramCount}`);
            params.push(String(name).trim());
        }

        if (email !== undefined && String(email).trim()) {
            paramCount++;
            updates.push(`email = $${paramCount}`);
            params.push(String(email).trim().toLowerCase());
        }

        if (car_type !== undefined && String(car_type).trim()) {
            paramCount++;
            updates.push(`car_type = $${paramCount}`);
            params.push(String(car_type).trim());
        }

        if (car_plate !== undefined && String(car_plate).trim()) {
            paramCount++;
            updates.push(`car_plate = $${paramCount}`);
            params.push(String(car_plate).trim());
        }

        if (balance !== undefined) {
            paramCount++;
            updates.push(`balance = $${paramCount}`);
            params.push(parseFloat(balance) || 0);
        }

        if (points !== undefined) {
            paramCount++;
            updates.push(`points = $${paramCount}`);
            params.push(parseInt(points, 10) || 0);
        }

        if (rating !== undefined) {
            paramCount++;
            updates.push(`rating = $${paramCount}`);
            params.push(parseFloat(rating) || 5.0);
        }

        if (status !== undefined && String(status).trim()) {
            paramCount++;
            updates.push(`status = $${paramCount}`);
            params.push(String(status).trim());
        }

        if (avatar !== undefined && String(avatar).trim()) {
            paramCount++;
            updates.push(`avatar = $${paramCount}`);
            params.push(String(avatar).trim());
        }

        if (password !== undefined && String(password).trim()) {
            const hashed = await hashPassword(String(password).trim());
            paramCount++;
            updates.push(`password = $${paramCount}`);
            params.push(hashed);
        }

        if (updates.length === 0) {
            return res.status(400).json({
                success: false,
                error: 'No valid fields to update'
            });
        }

        paramCount++;
        updates.push(`updated_at = CURRENT_TIMESTAMP`);
        params.push(id);

        const query = `UPDATE users SET ${updates.join(', ')} WHERE id = $${paramCount} AND role = 'passenger' RETURNING id, phone, name, email, role, car_type, car_plate, balance, points, rating, status, avatar, created_at, updated_at`;

        const result = await pool.query(query, params);

        res.json({
            success: true,
            data: result.rows[0]
        });
    } catch (err) {
        console.error('Error updating passenger:', err);
        if (err.code === '23505') {
            return res.status(400).json({
                success: false,
                error: 'Phone or email already in use'
            });
        }
        res.status(500).json({ success: false, error: err.message });
    }
});

// Delete passenger
app.delete('/api/passengers/:id', requireRole('admin'), async (req, res) => {
    try {
        const { id } = req.params;

        // Check if passenger exists
        const existing = await pool.query(
            'SELECT id FROM users WHERE id = $1 AND role = $2',
            [id, 'passenger']
        );

        if (existing.rows.length === 0) {
            return res.status(404).json({
                success: false,
                error: 'Passenger not found'
            });
        }

        // Check if passenger has active trips
        const activeTrips = await pool.query(
            `SELECT COUNT(*) as count FROM trips 
             WHERE user_id = $1 AND status NOT IN ('completed', 'cancelled')`,
            [id]
        );

        if (parseInt(activeTrips.rows[0].count) > 0) {
            return res.status(400).json({
                success: false,
                error: 'Cannot delete passenger with active trips'
            });
        }

        await pool.query(
            'DELETE FROM users WHERE id = $1 AND role = $2',
            [id, 'passenger']
        );

        res.json({
            success: true,
            message: 'Passenger deleted successfully'
        });
    } catch (err) {
        console.error('Error deleting passenger:', err);
        res.status(500).json({ success: false, error: err.message });
    }
});

// Get passenger trips
app.get('/api/passengers/:id/trips', requireAuth, async (req, res) => {
    try {
        const { id } = req.params;
        const { status, limit = 50, offset = 0 } = req.query;

        const authRole = String(req.auth?.role || '').toLowerCase();
        const authUserId = req.auth?.uid;
        if (authRole === 'driver') {
            return res.status(403).json({ success: false, error: 'Forbidden' });
        }
        if (authRole !== 'admin' && String(id) !== String(authUserId)) {
            return res.status(403).json({ success: false, error: 'Forbidden' });
        }

        // Check if passenger exists
        const passengerCheck = await pool.query(
            'SELECT id FROM users WHERE id = $1 AND role = $2',
            [id, 'passenger']
        );

        if (passengerCheck.rows.length === 0) {
            return res.status(404).json({
                success: false,
                error: 'Passenger not found'
            });
        }

        let query = 'SELECT * FROM trips WHERE user_id = $1';
        const params = [id];
        let paramCount = 1;

        if (status && status !== 'all') {
            paramCount++;
            query += ` AND status = $${paramCount}`;
            params.push(status);
        }

        query += ' ORDER BY created_at DESC';

        paramCount++;
        query += ` LIMIT $${paramCount}`;
        params.push(limit);

        paramCount++;
        query += ` OFFSET $${paramCount}`;
        params.push(offset);

        const result = await pool.query(query, params);

        let countQuery = 'SELECT COUNT(*) FROM trips WHERE user_id = $1';
        const countParams = [id];
        let countParamIndex = 1;

        if (status && status !== 'all') {
            countParamIndex++;
            countQuery += ` AND status = $${countParamIndex}`;
            countParams.push(status);
        }

        const countResult = await pool.query(countQuery, countParams);

        res.json({
            success: true,
            data: result.rows,
            total: parseInt(countResult.rows[0].count, 10),
            limit: parseInt(limit, 10),
            offset: parseInt(offset, 10)
        });
    } catch (err) {
        console.error('Error fetching passenger trips:', err);
        res.status(500).json({ success: false, error: err.message });
    }
});

// ==================== OPTIONAL OAUTH (Google / Apple) ====================
// Enabled only when env vars are provided. When not configured, endpoints return 501.

function oauthPopupErrorHtml(provider, error, extra = {}) {
    return makeOAuthPopupHtml({ success: false, provider, error, ...extra });
}

function oauthNotConfiguredPayload(provider, req) {
    const p = String(provider || '').toLowerCase();
    const info = oauthMissingParts(p, req);
    const missing = Array.isArray(info?.missing) ? info.missing : [];
    return { success: false, provider: p, error: 'oauth_not_configured', missing };
}

function oauthNotConfiguredHtml(provider, req) {
    return makeOAuthPopupHtml(oauthNotConfiguredPayload(provider, req));
}

function getRequestBaseUrl(req) {
    const envBase = process.env.PUBLIC_BASE_URL || process.env.APP_BASE_URL || process.env.BASE_URL || process.env.APP_URL;
    if (envBase && String(envBase).trim()) {
        return String(envBase).trim().replace(/\/+$/, '');
    }

    const xfProto = req?.headers?.['x-forwarded-proto'];
    const xfHost = req?.headers?.['x-forwarded-host'];
    const proto = xfProto ? String(xfProto).split(',')[0].trim() : (req?.protocol || 'http');
    const host = xfHost ? String(xfHost).split(',')[0].trim() : (req?.headers?.host ? String(req.headers.host).trim() : '');
    if (!host) return null;
    return `${proto}://${host}`.replace(/\/+$/, '');
}

let cachedAppleClientSecret = null;
let cachedAppleClientSecretExp = 0;
function getAppleOAuthClientSecret() {
    const staticSecret = process.env.APPLE_OAUTH_CLIENT_SECRET;
    if (staticSecret && String(staticSecret).trim()) return String(staticSecret).trim();

    const teamId = process.env.APPLE_OAUTH_TEAM_ID || process.env.APPLE_TEAM_ID;
    const keyId = process.env.APPLE_OAUTH_KEY_ID || process.env.APPLE_KEY_ID;
    const rawPrivateKey = process.env.APPLE_OAUTH_PRIVATE_KEY || process.env.APPLE_PRIVATE_KEY;
    const clientId = process.env.APPLE_OAUTH_CLIENT_ID;
    if (!teamId || !keyId || !rawPrivateKey || !clientId) return null;

    const now = Math.floor(Date.now() / 1000);
    if (cachedAppleClientSecret && cachedAppleClientSecretExp - now > 60) {
        return cachedAppleClientSecret;
    }

    const privateKey = String(rawPrivateKey).includes('\\n')
        ? String(rawPrivateKey).replace(/\\n/g, '\n')
        : String(rawPrivateKey);

    // Apple allows up to 6 months; use 30 days to keep rotation simple.
    const exp = now + 30 * 24 * 60 * 60;
    cachedAppleClientSecret = jwt.sign(
        {
            iss: String(teamId),
            iat: now,
            exp,
            aud: 'https://appleid.apple.com',
            sub: String(clientId)
        },
        privateKey,
        {
            algorithm: 'ES256',
            header: { kid: String(keyId) }
        }
    );
    cachedAppleClientSecretExp = exp;
    return cachedAppleClientSecret;
}

function getOAuthProviderConfig(provider, req) {
    const p = String(provider || '').toLowerCase();
    if (p === 'google') {
        const baseUrl = getRequestBaseUrl(req);
        const redirectUri = process.env.GOOGLE_OAUTH_REDIRECT_URI || (baseUrl ? `${baseUrl}/api/oauth/google/callback` : null);
        return {
            provider: 'google',
            issuerUrl: 'https://accounts.google.com',
            clientId: process.env.GOOGLE_OAUTH_CLIENT_ID,
            clientSecret: process.env.GOOGLE_OAUTH_CLIENT_SECRET,
            redirectUri
        };
    }
    if (p === 'apple') {
        const baseUrl = getRequestBaseUrl(req);
        const redirectUri = process.env.APPLE_OAUTH_REDIRECT_URI || (baseUrl ? `${baseUrl}/api/oauth/apple/callback` : null);
        return {
            provider: 'apple',
            issuerUrl: 'https://appleid.apple.com',
            clientId: process.env.APPLE_OAUTH_CLIENT_ID,
            clientSecret: getAppleOAuthClientSecret(),
            redirectUri
        };
    }
    return null;
}

function isOAuthConfigured(provider, req) {
    const cfg = getOAuthProviderConfig(provider, req);
    return Boolean(cfg?.clientId && cfg?.clientSecret && cfg?.redirectUri);
}

function oauthMissingParts(provider, req) {
    const p = String(provider || '').toLowerCase();
    const cfg = getOAuthProviderConfig(p, req);
    if (!cfg) return { supported: false, missing: ['unsupported_provider'] };

    const missing = [];
    if (!cfg.clientId) missing.push(`${p.toUpperCase()}_OAUTH_CLIENT_ID`);

    // Apple secret can be either static secret or generated from team/key/private_key
    if (p === 'apple') {
        const hasStatic = Boolean(process.env.APPLE_OAUTH_CLIENT_SECRET && String(process.env.APPLE_OAUTH_CLIENT_SECRET).trim());
        const hasGen = Boolean(
            (process.env.APPLE_OAUTH_TEAM_ID || process.env.APPLE_TEAM_ID) &&
            (process.env.APPLE_OAUTH_KEY_ID || process.env.APPLE_KEY_ID) &&
            (process.env.APPLE_OAUTH_PRIVATE_KEY || process.env.APPLE_PRIVATE_KEY)
        );
        if (!hasStatic && !hasGen) {
            missing.push('APPLE_OAUTH_CLIENT_SECRET (or APPLE_OAUTH_TEAM_ID + APPLE_OAUTH_KEY_ID + APPLE_OAUTH_PRIVATE_KEY)');
        }
    } else {
        if (!cfg.clientSecret) missing.push(`${p.toUpperCase()}_OAUTH_CLIENT_SECRET`);
    }

    if (!cfg.redirectUri) missing.push(`${p.toUpperCase()}_OAUTH_REDIRECT_URI or PUBLIC_BASE_URL`);
    return { supported: true, missing };
}

const oauthClientPromises = new Map();
async function getOAuthClient(provider, req) {
    const p = String(provider || '').toLowerCase();
    const cfg = getOAuthProviderConfig(p, req);
    if (!cfg) throw new Error('Unsupported provider');
    if (!isOAuthConfigured(p, req)) throw new Error('OAuth not configured');

    const cacheKey = `${p}|${cfg.clientId}|${cfg.redirectUri}`;
    if (!oauthClientPromises.has(cacheKey)) {
        oauthClientPromises.set(cacheKey, (async () => {
            const issuer = await Issuer.discover(cfg.issuerUrl);
            const client = new issuer.Client({
                client_id: cfg.clientId,
                client_secret: cfg.clientSecret,
                redirect_uris: [cfg.redirectUri],
                response_types: ['code']
            });
            return client;
        })());
    }

    const client = await oauthClientPromises.get(cacheKey);

    // Ensure Apple client_secret stays fresh if it's generated.
    if (p === 'apple') {
        const fresh = getAppleOAuthClientSecret();
        if (fresh) client.client_secret = fresh;
    }

    return client;
}

function makeOAuthPopupHtml(payload) {
    const safe = JSON.stringify(payload || {});
    return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>OAuth Complete</title>
  </head>
  <body style="font-family: system-ui, sans-serif; padding: 16px;">
    <p>OAuth completed. You can close this window.</p>
    <script>
      (function() {
        var payload = ${safe};
        try {
          if (window.opener && typeof window.opener.postMessage === 'function') {
            window.opener.postMessage({ type: 'oauth_result', payload: payload }, '*');
            window.close();
            return;
          }
        } catch (e) {}
        try {
          document.body.innerText = JSON.stringify(payload);
        } catch (e) {}
      })();
    </script>
  </body>
</html>`;
}

function makeOAuthRedirectHtml({ token, user, provider, created }) {
        const safeToken = JSON.stringify(String(token || ''));
        const safeUser = JSON.stringify(user || null);
        const safeProvider = JSON.stringify(String(provider || ''));
        const safeCreated = JSON.stringify(Boolean(created));
        return `<!doctype html>
<html lang="en">
    <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>OAuth Complete</title>
    </head>
    <body style="font-family: system-ui, sans-serif; padding: 16px;">
        <p>OAuth completed. Redirecting…</p>
        <script>
            (function() {
                try {
                    var token = ${safeToken};
                    var user = ${safeUser};
                    var provider = ${safeProvider};
                    var created = ${safeCreated};

                    if (token) {
                        localStorage.setItem('akwadra_token', token);
                    }
                    if (user) {
                        try { localStorage.setItem('akwadra_user', JSON.stringify(user)); } catch (e) {}
                    }
                    localStorage.setItem('akwadra_session_active', 'true');
                    localStorage.setItem('akwadra_last_oauth_provider', provider || '');
                    localStorage.setItem('akwadra_last_oauth_created', created ? '1' : '0');
                } catch (e) {
                    // ignore
                }
                try {
                    window.location.replace('/index.html');
                } catch (e) {
                    window.location.href = '/index.html';
                }
            })();
        </script>
    </body>
</html>`;
}

async function findOrCreateUserFromOAuth({ provider, providerSub, email, name, linkUserId = null }) {
    const p = String(provider || '').toLowerCase();
    const sub = String(providerSub || '').trim();
    const normEmail = email ? String(email).trim().toLowerCase() : null;
    const displayName = name && String(name).trim() ? String(name).trim() : 'راكب جديد';
    if (!sub) throw new Error('Missing provider_sub');

    // 1) Existing identity
    const existingIdentity = await pool.query(
        `SELECT user_id
         FROM user_oauth_identities
         WHERE provider = $1 AND provider_sub = $2
         LIMIT 1`,
        [p, sub]
    );
    if (existingIdentity.rows.length > 0) {
        const userId = existingIdentity.rows[0].user_id;
        const userRes = await pool.query('SELECT id, phone, name, email, role, created_at FROM users WHERE id = $1 LIMIT 1', [userId]);
        const user = userRes.rows[0] || null;
        if (!user) throw new Error('Linked user not found');
        if (String(user.role || '').toLowerCase() !== 'passenger') throw new Error('OAuth is supported for passenger only');
        // Mark email as verified if present
        if (user.email) {
            try { await pool.query('UPDATE users SET email_verified_at = COALESCE(email_verified_at, NOW()) WHERE id = $1', [user.id]); } catch (e) {}
        }
        return { user, created: false, linked: true };
    }

    // 2) Link to an existing logged-in user
    if (linkUserId) {
        const userRes = await pool.query('SELECT id, phone, name, email, role, created_at FROM users WHERE id = $1 LIMIT 1', [linkUserId]);
        const user = userRes.rows[0] || null;
        if (!user) throw new Error('User not found');
        if (String(user.role || '').toLowerCase() !== 'passenger') throw new Error('OAuth link is supported for passenger only');
        if (normEmail) {
            try {
                await pool.query('UPDATE users SET email = COALESCE(email, $1), email_verified_at = COALESCE(email_verified_at, NOW()) WHERE id = $2', [normEmail, user.id]);
            } catch (e) {
                // ignore
            }
        }
        await pool.query(
            `INSERT INTO user_oauth_identities (user_id, provider, provider_sub, email)
             VALUES ($1,$2,$3,$4)
             ON CONFLICT (provider, provider_sub) DO NOTHING`,
            [user.id, p, sub, normEmail]
        );
        return { user: { ...user, email: user.email || normEmail }, created: false, linked: true };
    }

    // 3) Try match by email
    if (normEmail) {
        const userRes = await pool.query(
            'SELECT id, phone, name, email, role, created_at FROM users WHERE LOWER(email) = $1 LIMIT 1',
            [normEmail]
        );
        if (userRes.rows.length > 0) {
            const user = userRes.rows[0];
            if (String(user.role || '').toLowerCase() !== 'passenger') throw new Error('OAuth is supported for passenger only');
            try {
                await pool.query('UPDATE users SET email_verified_at = COALESCE(email_verified_at, NOW()) WHERE id = $1', [user.id]);
            } catch (e) {}
            await pool.query(
                `INSERT INTO user_oauth_identities (user_id, provider, provider_sub, email)
                 VALUES ($1,$2,$3,$4)
                 ON CONFLICT (provider, provider_sub) DO NOTHING`,
                [user.id, p, sub, normEmail]
            );
            return { user, created: false, linked: true };
        }
    }

    // 4) Create a new passenger
    const digits = Date.now().toString().slice(-9);
    const phone = `9${digits}${Math.floor(Math.random() * 90 + 10)}`;
    const password = await hashPassword(crypto.randomBytes(12).toString('hex'));
    const created = await pool.query(
        `INSERT INTO users (phone, name, email, password, role, email_verified_at)
         VALUES ($1,$2,$3,$4,'passenger', NOW())
         RETURNING id, phone, name, email, role, created_at`,
        [phone, displayName, normEmail || `oauth_${p}_${Date.now()}@ubar.sa`, password]
    );
    const user = created.rows[0];
    await pool.query(
        `INSERT INTO user_oauth_identities (user_id, provider, provider_sub, email)
         VALUES ($1,$2,$3,$4)
         ON CONFLICT (provider, provider_sub) DO NOTHING`,
        [user.id, p, sub, normEmail]
    );
    return { user, created: true, linked: true };
}

async function oauthStartLogin(provider, req, res) {
    if (!isOAuthConfigured(provider, req)) {
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        return res.status(501).send(oauthNotConfiguredHtml(provider, req));
    }
    oauthPruneStates();
    const client = await getOAuthClient(provider, req);
    const cfg = getOAuthProviderConfig(provider, req);
    const state = crypto.randomBytes(16).toString('hex');
    const codeVerifier = generators.codeVerifier();
    const codeChallenge = generators.codeChallenge(codeVerifier);
    oauthPutState(state, {
        provider: String(provider).toLowerCase(),
        mode: 'login',
        flow: String(req.query?.flow || '').toLowerCase() === 'redirect' ? 'redirect' : 'popup',
        userId: null,
        codeVerifier,
        createdAtMs: Date.now(),
        expiresAtMs: Date.now() + 10 * 60 * 1000
    });
    const scope = String(provider).toLowerCase() === 'apple' ? 'openid email name' : 'openid email profile';
    const url = client.authorizationUrl({
        scope,
        state,
        code_challenge: codeChallenge,
        code_challenge_method: 'S256',
        redirect_uri: cfg.redirectUri,
        ...(String(provider).toLowerCase() === 'apple' ? { response_mode: 'form_post' } : {})
    });
    return res.redirect(url);
}

async function oauthStartLink(provider, req, res) {
    if (!isOAuthConfigured(provider, req)) {
        const payload = oauthNotConfiguredPayload(provider, req);
        return res.status(501).json(payload);
    }
    const userId = req.auth?.uid;
    if (!userId) return res.status(401).json({ success: false, error: 'Unauthorized' });
    oauthPruneStates();
    const client = await getOAuthClient(provider, req);
    const cfg = getOAuthProviderConfig(provider, req);
    const state = crypto.randomBytes(16).toString('hex');
    const codeVerifier = generators.codeVerifier();
    const codeChallenge = generators.codeChallenge(codeVerifier);
    oauthPutState(state, {
        provider: String(provider).toLowerCase(),
        mode: 'link',
        flow: String(req.query?.flow || '').toLowerCase() === 'redirect' ? 'redirect' : 'popup',
        userId,
        codeVerifier,
        createdAtMs: Date.now(),
        expiresAtMs: Date.now() + 10 * 60 * 1000
    });
    const scope = String(provider).toLowerCase() === 'apple' ? 'openid email name' : 'openid email profile';
    const url = client.authorizationUrl({
        scope,
        state,
        code_challenge: codeChallenge,
        code_challenge_method: 'S256',
        redirect_uri: cfg.redirectUri,
        ...(String(provider).toLowerCase() === 'apple' ? { response_mode: 'form_post' } : {})
    });
    return res.json({ success: true, url });
}

async function oauthCallback(provider, req, res) {
    try {
        if (!isOAuthConfigured(provider, req)) {
            res.setHeader('Content-Type', 'text/html; charset=utf-8');
            return res.status(501).send(oauthNotConfiguredHtml(provider, req));
        }
        const client = await getOAuthClient(provider, req);
        const cfg = getOAuthProviderConfig(provider, req);

        const params = String(req.method || 'GET').toUpperCase() === 'POST'
            ? (req.body || {})
            : client.callbackParams(req);
        const state = params?.state ? String(params.state) : '';
        const st = oauthTakeState(state);
        if (!st) {
            return res.status(400).send(makeOAuthPopupHtml({ success: false, error: 'invalid_state' }));
        }
        if (st.provider !== String(provider).toLowerCase()) {
            return res.status(400).send(makeOAuthPopupHtml({ success: false, error: 'state_provider_mismatch' }));
        }
        if (st.expiresAtMs && st.expiresAtMs <= Date.now()) {
            return res.status(400).send(makeOAuthPopupHtml({ success: false, error: 'state_expired' }));
        }

        const tokenSet = await client.callback(cfg.redirectUri, params, { state, code_verifier: st.codeVerifier });
        const claims = tokenSet.claims();
        const email = claims?.email ? String(claims.email) : null;
        const sub = claims?.sub ? String(claims.sub) : null;
        const name = claims?.name ? String(claims.name) : (claims?.given_name ? String(claims.given_name) : null);
        if (!sub) {
            return res.status(400).send(makeOAuthPopupHtml({ success: false, error: 'missing_sub' }));
        }

        const linkUserId = st.mode === 'link' ? st.userId : null;
        const { user, created } = await findOrCreateUserFromOAuth({ provider, providerSub: sub, email, name, linkUserId });

        const token = signAccessToken({
            sub: String(user.id),
            uid: user.id,
            role: user.role,
            email: user.email,
            phone: user.phone,
            name: user.name
        });

        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        if (String(st.flow || '').toLowerCase() === 'redirect') {
            return res.status(200).send(makeOAuthRedirectHtml({ provider, created, user, token }));
        }
        return res.status(200).send(makeOAuthPopupHtml({ success: true, provider, created, data: user, token }));
    } catch (err) {
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        return res.status(500).send(makeOAuthPopupHtml({ success: false, error: err.message }));
    }
}

app.get('/api/oauth/google/login', (req, res) => oauthStartLogin('google', req, res));
app.get('/api/oauth/google/callback', (req, res) => oauthCallback('google', req, res));
app.post('/api/oauth/google/link', requireAuth, (req, res) => oauthStartLink('google', req, res));

app.get('/api/oauth/apple/login', (req, res) => oauthStartLogin('apple', req, res));
app.get('/api/oauth/apple/callback', (req, res) => oauthCallback('apple', req, res));
app.post('/api/oauth/apple/callback', (req, res) => oauthCallback('apple', req, res));
app.post('/api/oauth/apple/link', requireAuth, (req, res) => oauthStartLink('apple', req, res));

// Config status helper for UI/debugging
app.get('/api/oauth/:provider/status', (req, res) => {
    try {
        const provider = String(req.params.provider || '').toLowerCase();
        const info = oauthMissingParts(provider, req);
        if (!info.supported) {
            return res.status(400).json({ success: false, error: 'unsupported_provider' });
        }
        const configured = info.missing.length === 0;
        return res.json({ success: true, provider, configured, missing: info.missing });
    } catch (e) {
        return res.status(500).json({ success: false, error: e.message });
    }
});

// Login with email and password
app.post('/api/auth/login', async (req, res) => {
    try {
        const { email, password, role, name, phone } = req.body;
        
        if (!email || !password) {
            return res.status(400).json({ 
                success: false, 
                error: 'Email and password are required' 
            });
        }

        const trimmedEmail = String(email).trim().toLowerCase();
        const trimmedPassword = String(password).trim();
        const requestedRole = role ? String(role).trim().toLowerCase() : null;
        
        // Load user by email and verify password (supports legacy plaintext and bcrypt hashes)
        const result = await pool.query(
            'SELECT id, phone, name, email, role, password, created_at FROM users WHERE LOWER(email) = $1 LIMIT 1',
            [trimmedEmail]
        );
        
        if (result.rows.length === 0) {
            if (requestedRole === 'passenger') {
                const baseName = name && String(name).trim() ? String(name).trim() : 'راكب جديد';
                const rawPhone = phone ? String(phone) : '';
                const digits = rawPhone.replace(/\D/g, '');
                const buildGuestPhone = () => {
                    if (digits.length >= 8) return digits;
                    const stamp = Date.now().toString().slice(-9);
                    const rand = Math.floor(Math.random() * 90 + 10);
                    return `9${stamp}${rand}`;
                };

                const hashed = await hashPassword(trimmedPassword);

                let createdUser = null;
                for (let attempt = 0; attempt < 3; attempt++) {
                    const guestPhone = buildGuestPhone();
                    const insert = await pool.query(
                        `INSERT INTO users (phone, name, email, password, role)
                         VALUES ($1, $2, $3, $4, 'passenger')
                         ON CONFLICT (phone) DO NOTHING
                         RETURNING id, phone, name, email, role, created_at`,
                        [guestPhone, baseName, trimmedEmail, hashed]
                    );
                    if (insert.rows.length > 0) {
                        createdUser = insert.rows[0];
                        break;
                    }
                }

                if (!createdUser) {
                    return res.status(500).json({ success: false, error: 'Failed to create passenger account' });
                }

                const token = signAccessToken({
                    sub: String(createdUser.id),
                    uid: createdUser.id,
                    role: createdUser.role,
                    email: createdUser.email,
                    phone: createdUser.phone,
                    name: createdUser.name
                });

                return res.json({ success: true, data: createdUser, token, created: true });
            }

            return res.status(401).json({ success: false, error: 'Invalid email or password' });
        }

        const user = result.rows[0];
        const ok = await verifyPassword(user.password, trimmedPassword);
        if (!ok) {
            return res.status(401).json({ success: false, error: 'Invalid email or password' });
        }

        // Upgrade legacy plaintext passwords to bcrypt on successful login
        if (!looksLikeBcryptHash(user.password)) {
            try {
                const upgraded = await hashPassword(trimmedPassword);
                await pool.query('UPDATE users SET password = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2', [upgraded, user.id]);
            } catch (e) {
                // non-blocking
            }
        }

        const safeUser = {
            id: user.id,
            phone: user.phone,
            name: user.name,
            email: user.email,
            role: user.role,
            created_at: user.created_at
        };

        let driverId = null;
        if (String(user.role).toLowerCase() === 'driver') {
            try {
                const driverRes = await pool.query(
                    `SELECT id FROM drivers WHERE (email IS NOT NULL AND LOWER(email) = $1) OR (phone IS NOT NULL AND phone = $2) LIMIT 1`,
                    [String(user.email || '').toLowerCase(), String(user.phone || '').trim()]
                );
                driverId = driverRes.rows[0]?.id || null;
            } catch (e) {
                driverId = null;
            }
        }

        const tokenClaims = {
            sub: String(user.id),
            uid: user.id,
            role: user.role,
            email: user.email,
            phone: user.phone,
            name: user.name,
            ...(driverId ? { driver_id: driverId } : {})
        };

        const token = signAccessToken(tokenClaims);

        res.json({ success: true, data: safeUser, token });
    } catch (err) {
        console.error('Error logging in:', err);
        res.status(500).json({ success: false, error: err.message });
    }
});

// Get or create user (for phone-based login)
app.post('/api/users/login', async (req, res) => {
    try {
        const { phone, name, email } = req.body;

        if (!phone) {
            return res.status(400).json({
                success: false,
                error: 'Phone is required'
            });
        }

        const normalizedPhone = normalizePhoneForStore(phone);
        const normalizedEmail = email && String(email).trim() ? String(email).trim().toLowerCase() : `passenger_${normalizedPhone.replace(/\D/g, '') || Date.now()}@ubar.sa`;
        const normalizedName = name && String(name).trim() ? String(name).trim() : 'راكب جديد';
        const phoneCandidates = normalizePhoneCandidates(phone);

        // Check if user exists
        let result = await pool.query('SELECT id, phone, name, email, role, password, created_at, updated_at FROM users WHERE phone = ANY($1) LIMIT 1', [phoneCandidates]);
        
        if (result.rows.length === 0) {
            // Create new user
            const hashed = await hashPassword('12345678');
            result = await pool.query(`
                INSERT INTO users (phone, name, email, password, role)
                VALUES ($1, $2, $3, $4, 'passenger')
                RETURNING id, phone, name, email, role, created_at, updated_at
            `, [normalizedPhone, normalizedName, normalizedEmail, hashed]);
        }

        const user = result.rows[0];

        // Optional: upgrade legacy default password if it's still plaintext "12345678"
        if (user && user.password && !looksLikeBcryptHash(user.password) && String(user.password) === '12345678') {
            try {
                const upgraded = await hashPassword('12345678');
                await pool.query('UPDATE users SET password = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2', [upgraded, user.id]);
            } catch (e) {
                // non-blocking
            }
        }

        const token = signAccessToken({
            sub: String(user.id),
            uid: user.id,
            role: user.role,
            email: user.email,
            phone: user.phone,
            name: user.name
        });
        
        res.json({
            success: true,
            data: {
                id: user.id,
                phone: user.phone,
                name: user.name,
                email: user.email,
                role: user.role,
                created_at: user.created_at,
                updated_at: user.updated_at
            },
            token
        });
    } catch (err) {
        console.error('Error logging in user:', err);
        res.status(500).json({ success: false, error: err.message });
    }
});

// Return current user from JWT
app.get('/api/auth/me', requireAuth, async (req, res) => {
    try {
        const userId = req.auth?.uid;
        const result = await pool.query('SELECT id, phone, name, email, role, created_at, updated_at FROM users WHERE id = $1 LIMIT 1', [userId]);
        if (result.rows.length === 0) {
            return res.status(404).json({ success: false, error: 'User not found' });
        }
        res.json({ success: true, data: result.rows[0], auth: req.auth });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// ==================== WALLET (LEDGER) ENDPOINTS ====================

function walletOwnerFromAuth(req) {
    const role = String(req.auth?.role || '').toLowerCase();
    if (role === 'passenger') {
        return { owner_type: 'user', owner_id: req.auth?.uid };
    }
    if (role === 'driver') {
        return { owner_type: 'driver', owner_id: req.auth?.driver_id };
    }
    return null;
}

app.get('/api/wallet/me/balance', requireAuth, async (req, res) => {
    try {
        const owner = walletOwnerFromAuth(req);
        if (!owner || !owner.owner_id) {
            return res.status(400).json({ success: false, error: 'Wallet owner not available for this role' });
        }

        const sum = await pool.query(
            `SELECT COALESCE(SUM(amount), 0) AS balance
             FROM wallet_transactions
             WHERE owner_type = $1 AND owner_id = $2`,
            [owner.owner_type, owner.owner_id]
        );

        res.json({
            success: true,
            data: {
                owner_type: owner.owner_type,
                owner_id: owner.owner_id,
                balance: Number(sum.rows[0]?.balance || 0)
            }
        });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

app.get('/api/wallet/me/transactions', requireAuth, async (req, res) => {
    try {
        const owner = walletOwnerFromAuth(req);
        if (!owner || !owner.owner_id) {
            return res.status(400).json({ success: false, error: 'Wallet owner not available for this role' });
        }

        const limit = Number.isFinite(Number(req.query.limit)) ? Math.min(Math.max(Number(req.query.limit), 1), 100) : 50;
        const offset = Number.isFinite(Number(req.query.offset)) ? Math.max(Number(req.query.offset), 0) : 0;

        const result = await pool.query(
            `SELECT id, owner_type, owner_id, amount, currency, reason, reference_type, reference_id, created_by_user_id, created_by_role, created_at
             FROM wallet_transactions
             WHERE owner_type = $1 AND owner_id = $2
             ORDER BY created_at DESC
             LIMIT $3 OFFSET $4`,
            [owner.owner_type, owner.owner_id, limit, offset]
        );

        res.json({ success: true, data: result.rows, limit, offset, count: result.rows.length });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// Admin creates wallet ledger entry (credit/debit)
app.post('/api/admin/wallet/transaction', requireRole('admin'), async (req, res) => {
    try {
        const {
            owner_type,
            owner_id,
            amount,
            currency = 'SAR',
            reason,
            reference_type,
            reference_id
        } = req.body || {};

        const normalizedOwnerType = String(owner_type || '').toLowerCase();
        const normalizedOwnerId = Number.parseInt(owner_id, 10);
        const normalizedAmount = Number(amount);

        if (!['user', 'driver'].includes(normalizedOwnerType)) {
            return res.status(400).json({ success: false, error: 'owner_type must be user or driver' });
        }
        if (!Number.isFinite(normalizedOwnerId) || normalizedOwnerId <= 0) {
            return res.status(400).json({ success: false, error: 'owner_id is required' });
        }
        if (!Number.isFinite(normalizedAmount) || normalizedAmount === 0) {
            return res.status(400).json({ success: false, error: 'amount must be a non-zero number' });
        }

        const insert = await pool.query(
            `INSERT INTO wallet_transactions (
                owner_type, owner_id, amount, currency, reason, reference_type, reference_id, created_by_user_id, created_by_role
             ) VALUES ($1, $2, $3, $4, NULLIF($5, ''), NULLIF($6, ''), NULLIF($7, ''), $8, $9)
             RETURNING *`,
            [
                normalizedOwnerType,
                normalizedOwnerId,
                normalizedAmount,
                String(currency || 'SAR').toUpperCase(),
                reason !== undefined && reason !== null ? String(reason) : '',
                reference_type !== undefined && reference_type !== null ? String(reference_type) : '',
                reference_id !== undefined && reference_id !== null ? String(reference_id) : '',
                req.auth?.uid || null,
                String(req.auth?.role || 'admin')
            ]
        );

        // Update cached balances for backward compatibility
        try {
            if (normalizedOwnerType === 'user') {
                await pool.query(
                    `UPDATE users SET balance = COALESCE(balance, 0) + $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2`,
                    [normalizedAmount, normalizedOwnerId]
                );
            }
            if (normalizedOwnerType === 'driver') {
                await pool.query(
                    `UPDATE drivers SET balance = COALESCE(balance, 0) + $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2`,
                    [normalizedAmount, normalizedOwnerId]
                );
            }
        } catch (e) {
            // non-blocking
        }

        res.status(201).json({ success: true, data: insert.rows[0] });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// ═══════════════════════════════════════════════════════════
// PENDING RIDE REQUESTS API - طلبات الرحلات في قائمة الانتظار
// ═══════════════════════════════════════════════════════════

// Create new ride request
app.post('/api/pending-rides', requireRole('passenger', 'admin'), async (req, res) => {
    try {
        const {
            user_id,
            passenger_name,
            passenger_phone,
            pickup_location,
            dropoff_location,
            pickup_lat,
            pickup_lng,
            pickup_accuracy,
            pickup_timestamp,
            dropoff_lat,
            dropoff_lng,
            car_type,
            estimated_cost,
            estimated_distance,
            estimated_duration,
            payment_method,
            notes
        } = req.body;

        const authRole = String(req.auth?.role || '').toLowerCase();
        const authUserId = req.auth?.uid;
        const effectiveUserId = authRole === 'passenger' ? authUserId : user_id;

        if (!effectiveUserId) {
            return res.status(400).json({ success: false, error: 'user_id is required' });
        }

        if (!pickup_location || !dropoff_location) {
            return res.status(400).json({
                success: false,
                error: 'Pickup and dropoff locations are required'
            });
        }

        const request_id = `REQ-${Date.now()}-${Math.floor(Math.random() * 1000)}`;
        const expires_at = new Date(Date.now() + 20 * 60 * 1000); // expires in 20 minutes

        const pickupLat = pickup_lat !== undefined && pickup_lat !== null ? Number(pickup_lat) : null;
        const pickupLng = pickup_lng !== undefined && pickup_lng !== null ? Number(pickup_lng) : null;
        const pickupAccuracy = pickup_accuracy !== undefined && pickup_accuracy !== null ? Number(pickup_accuracy) : null;
        const pickupTimestamp = pickup_timestamp !== undefined && pickup_timestamp !== null ? Number(pickup_timestamp) : null;
        const dropoffLat = dropoff_lat !== undefined && dropoff_lat !== null ? Number(dropoff_lat) : null;
        const dropoffLng = dropoff_lng !== undefined && dropoff_lng !== null ? Number(dropoff_lng) : null;

        if (!Number.isFinite(pickupLat) || !Number.isFinite(pickupLng) || !Number.isFinite(dropoffLat) || !Number.isFinite(dropoffLng)) {
            return res.status(400).json({ success: false, error: 'Invalid coordinates.' });
        }

        console.log('📥 Pending ride create received pickup coords:', {
            request_id,
            user_id: effectiveUserId,
            raw: { pickup_lat, pickup_lng, pickup_accuracy, pickup_timestamp },
            parsed: {
                pickup_lat: pickupLat,
                pickup_lng: pickupLng,
                pickup_accuracy: pickupAccuracy,
                pickup_timestamp: pickupTimestamp
            }
        });

        const result = await pool.query(`
            INSERT INTO pending_ride_requests (
                request_id, user_id, passenger_name, passenger_phone,
                pickup_location, dropoff_location,
                pickup_lat, pickup_lng, pickup_accuracy, pickup_timestamp, dropoff_lat, dropoff_lng,
                car_type, estimated_cost, estimated_distance, estimated_duration,
                payment_method, status, expires_at, notes
            )
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, 'waiting', $18, $19)
            RETURNING *
        `, [
            request_id, effectiveUserId, passenger_name, passenger_phone,
            pickup_location, dropoff_location,
            pickupLat, pickupLng, pickupAccuracy, pickupTimestamp, dropoffLat, dropoffLng,
            car_type || 'economy', estimated_cost, estimated_distance, estimated_duration,
            payment_method || 'cash', expires_at, notes
        ]);

        res.json({
            success: true,
            message: 'تم إنشاء طلب الرحلة بنجاح',
            data: result.rows[0]
        });
    } catch (err) {
        console.error('Error creating ride request:', err);
        res.status(500).json({ success: false, error: err.message });
    }
});

// Get all pending ride requests
app.get('/api/pending-rides', requireRole('admin'), async (req, res) => {
    try {
        const { status, car_type, limit } = req.query;
        
        let query = `
            SELECT 
                pr.*,
                u.name as user_name,
                u.phone as user_phone,
                d.name as assigned_driver_name,
                d.phone as assigned_driver_phone
            FROM pending_ride_requests pr
            LEFT JOIN users u ON pr.user_id = u.id
            LEFT JOIN drivers d ON pr.assigned_driver_id = d.id
            WHERE 1=1
        `;
        const params = [];
        let paramCount = 0;

        if (status) {
            paramCount++;
            query += ` AND pr.status = $${paramCount}`;
            params.push(status);
        }

        if (car_type) {
            paramCount++;
            query += ` AND pr.car_type = $${paramCount}`;
            params.push(car_type);
        }

        query += ` ORDER BY pr.created_at DESC`;

        if (limit) {
            paramCount++;
            query += ` LIMIT $${paramCount}`;
            params.push(parseInt(limit, 10));
        }

        const result = await pool.query(query, params);

        res.json({
            success: true,
            count: result.rows.length,
            data: result.rows
        });
    } catch (err) {
        console.error('Error fetching pending rides:', err);
        res.status(500).json({ success: false, error: err.message });
    }
});

// Get pending ride request by ID
app.get('/api/pending-rides/:request_id', requireAuth, async (req, res) => {
    try {
        const { request_id } = req.params;

        const result = await pool.query(`
            SELECT 
                pr.*,
                u.name as user_name,
                u.phone as user_phone,
                CASE
                    WHEN COALESCE(pv.status, '') = 'approved' THEN 'strong'
                    WHEN u.email_verified_at IS NOT NULL AND u.phone_verified_at IS NOT NULL THEN 'basic'
                    ELSE 'none'
                END AS passenger_verified_level,
                d.name as assigned_driver_name,
                d.phone as assigned_driver_phone
            FROM pending_ride_requests pr
            LEFT JOIN users u ON pr.user_id = u.id
            LEFT JOIN LATERAL (
                SELECT status
                FROM passenger_verifications
                WHERE user_id = u.id
                ORDER BY submitted_at DESC
                LIMIT 1
            ) pv ON true
            LEFT JOIN drivers d ON pr.assigned_driver_id = d.id
            WHERE pr.request_id = $1
        `, [request_id]);

        if (result.rows.length === 0) {
            return res.status(404).json({
                success: false,
                error: 'Ride request not found'
            });
        }

        const authRole = String(req.auth?.role || '').toLowerCase();
        const authUserId = req.auth?.uid;
        const authDriverId = req.auth?.driver_id;

        const row = result.rows[0];
        if (authRole === 'passenger' && String(row.user_id) !== String(authUserId)) {
            return res.status(403).json({ success: false, error: 'Forbidden' });
        }
        if (authRole === 'driver') {
            if (!authDriverId) return res.status(403).json({ success: false, error: 'Driver profile not linked to this account' });
            // Driver can see a request if it is accepted by them or still waiting (in their feed). We allow both.
            if (row.assigned_driver_id && String(row.assigned_driver_id) !== String(authDriverId)) {
                return res.status(403).json({ success: false, error: 'Forbidden' });
            }
        }

        res.json({ success: true, data: row });
    } catch (err) {
        console.error('Error fetching ride request:', err);
        res.status(500).json({ success: false, error: err.message });
    }
});

// Driver accepts ride request
app.post('/api/pending-rides/:request_id/accept', requireRole('driver', 'admin'), async (req, res) => {
    try {
        const { request_id } = req.params;
        const { driver_id } = req.body;

        const authRole = String(req.auth?.role || '').toLowerCase();
        const authDriverId = req.auth?.driver_id;
        const effectiveDriverId = authRole === 'driver' ? authDriverId : driver_id;

        if (authRole === 'driver' && !effectiveDriverId) {
            return res.status(403).json({ success: false, error: 'Driver profile not linked to this account' });
        }

        if (!effectiveDriverId) {
            return res.status(400).json({
                success: false,
                error: 'Driver ID is required'
            });
        }

        // Night Safety Policy (driver only; admin override allowed)
        if (authRole === 'driver' && isNightNow()) {
            const dRes = await pool.query(
                `SELECT approval_status, rating, last_location_at
                 FROM drivers
                 WHERE id = $1
                 LIMIT 1`,
                [effectiveDriverId]
            );
            const dRow = dRes.rows[0] || null;
            if (!isDriverEligibleForNightPolicy(dRow)) {
                return res.status(403).json({
                    success: false,
                    error: 'Night safety policy: driver not eligible',
                    code: 'night_policy_not_eligible'
                });
            }
        }

        // Check if request exists and is still waiting
        const checkResult = await pool.query(`
            SELECT * FROM pending_ride_requests
            WHERE request_id = $1 AND status = 'waiting'
        `, [request_id]);

        if (checkResult.rows.length === 0) {
            return res.status(404).json({
                success: false,
                error: 'Ride request not found or already processed'
            });
        }

        // Update request status to accepted
        const result = await pool.query(`
            UPDATE pending_ride_requests
            SET status = 'accepted',
                assigned_driver_id = $1,
                assigned_at = CURRENT_TIMESTAMP,
                updated_at = CURRENT_TIMESTAMP
            WHERE request_id = $2
            RETURNING *
        `, [effectiveDriverId, request_id]);

        const pendingRequest = result.rows[0];

        let assignedTripId = null;

        // ✨ إنشاء أو تحديث الرحلة في جدول trips
        try {
            // البحث عن رحلة مطابقة للطلب
            const existingTripResult = await pool.query(`
                SELECT id FROM trips
                WHERE user_id = $1
                    AND pickup_lat = $2
                    AND pickup_lng = $3
                    AND status = 'pending'
                    AND created_at >= CURRENT_TIMESTAMP - INTERVAL '30 minutes'
                ORDER BY created_at DESC
                LIMIT 1
            `, [pendingRequest.user_id, pendingRequest.pickup_lat, pendingRequest.pickup_lng]);

            if (existingTripResult.rows.length > 0) {
                // تحديث الرحلة الموجودة بتعيين السائق
                const tripId = existingTripResult.rows[0].id;
                assignedTripId = tripId;
                
                // الحصول على معلومات السائق
                const driverResult = await pool.query('SELECT name FROM drivers WHERE id = $1', [effectiveDriverId]);
                const driverName = driverResult.rows[0]?.name || null;

                await pool.query(`
                    UPDATE trips
                    SET driver_id = $1,
                        driver_name = $2,
                        status = 'assigned',
                        updated_at = CURRENT_TIMESTAMP
                    WHERE id = $3
                `, [effectiveDriverId, driverName, tripId]);

                console.log(`✅ تم تحديث الرحلة ${tripId} بتعيين السائق ${effectiveDriverId}`);
            } else {
                // إنشاء رحلة جديدة إذا لم توجد
                const tripId = 'TR-' + Date.now();
                assignedTripId = tripId;
                
                // الحصول على معلومات السائق
                const driverResult = await pool.query('SELECT name FROM drivers WHERE id = $1', [effectiveDriverId]);
                const driverName = driverResult.rows[0]?.name || null;

                await pool.query(`
                    INSERT INTO trips (
                        id, user_id, driver_id, driver_name,
                        pickup_location, dropoff_location,
                        pickup_lat, pickup_lng, dropoff_lat, dropoff_lng,
                        car_type, cost, distance, duration,
                        payment_method, status, source
                    )
                    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, 'assigned', 'pending_rides')
                `, [
                    tripId, pendingRequest.user_id, effectiveDriverId, driverName,
                    pendingRequest.pickup_location, pendingRequest.dropoff_location,
                    pendingRequest.pickup_lat, pendingRequest.pickup_lng,
                    pendingRequest.dropoff_lat, pendingRequest.dropoff_lng,
                    pendingRequest.car_type, pendingRequest.estimated_cost,
                    pendingRequest.estimated_distance, pendingRequest.estimated_duration,
                    pendingRequest.payment_method
                ]);

                console.log(`✅ تم إنشاء رحلة جديدة ${tripId} للطلب ${request_id}`);
            }
        } catch (tripErr) {
            console.error('⚠️ خطأ في تحديث/إنشاء الرحلة في trips:', tripErr.message);
        }

        // Live Match Timeline (Socket.io)
        try {
            io.to(userRoom(pendingRequest.user_id)).emit('pending_request_update', {
                trip_id: pendingRequest.trip_id ? String(pendingRequest.trip_id) : (assignedTripId ? String(assignedTripId) : null),
                request_id: String(request_id),
                stage: 'driver_accepted',
                message: 'سائق قبل الطلب',
                created_at: new Date().toISOString()
            });

            if (assignedTripId) {
                const tripRow = await pool.query('SELECT * FROM trips WHERE id = $1 LIMIT 1', [assignedTripId]);
                const trip = tripRow.rows[0] || null;
                if (trip) {
                    io.to(userRoom(pendingRequest.user_id)).emit('trip_assigned', { trip_id: String(trip.id), trip });
                }
            }
        } catch (e) {
            // ignore
        }

        res.json({
            success: true,
            message: 'تم قبول الطلب بنجاح',
            data: result.rows[0]
        });
    } catch (err) {
        console.error('Error accepting ride request:', err);
        res.status(500).json({ success: false, error: err.message });
    }
});

// Driver rejects ride request
app.post('/api/pending-rides/:request_id/reject', requireRole('driver', 'admin'), async (req, res) => {
    try {
        const { request_id } = req.params;
        const { driver_id } = req.body;

        const authRole = String(req.auth?.role || '').toLowerCase();
        const authDriverId = req.auth?.driver_id;
        const effectiveDriverId = authRole === 'driver' ? authDriverId : driver_id;

        if (authRole === 'driver' && !effectiveDriverId) {
            return res.status(403).json({ success: false, error: 'Driver profile not linked to this account' });
        }

        if (!effectiveDriverId) {
            return res.status(400).json({
                success: false,
                error: 'Driver ID is required'
            });
        }

        // Check if request exists
        const checkResult = await pool.query(`
            SELECT * FROM pending_ride_requests
            WHERE request_id = $1 AND status = 'waiting'
        `, [request_id]);

        if (checkResult.rows.length === 0) {
            return res.status(404).json({
                success: false,
                error: 'Ride request not found or already processed'
            });
        }

        // Add driver to rejected_by array and increment rejection count
        const result = await pool.query(`
            UPDATE pending_ride_requests
            SET rejected_by = array_append(rejected_by, $1),
                rejection_count = rejection_count + 1,
                updated_at = CURRENT_TIMESTAMP
            WHERE request_id = $2
            RETURNING *
        `, [effectiveDriverId, request_id]);

        // Live Match Timeline (Socket.io)
        try {
            const row = result.rows[0] || null;
            if (row?.user_id) {
                io.to(userRoom(row.user_id)).emit('pending_request_update', {
                    trip_id: row.trip_id ? String(row.trip_id) : null,
                    request_id: String(request_id),
                    stage: 'driver_rejected',
                    message: 'سائق رفض الطلب',
                    created_at: new Date().toISOString(),
                    rejection_count: row.rejection_count
                });
            }
        } catch (e) {
            // ignore
        }

        res.json({
            success: true,
            message: 'تم رفض الطلب',
            data: result.rows[0]
        });
    } catch (err) {
        console.error('Error rejecting ride request:', err);
        res.status(500).json({ success: false, error: err.message });
    }
});

// Cancel ride request
app.post('/api/pending-rides/:request_id/cancel', requireRole('passenger', 'admin'), async (req, res) => {
    try {
        const { request_id } = req.params;

        const authRole = String(req.auth?.role || '').toLowerCase();
        const authUserId = req.auth?.uid;

        const result = authRole === 'passenger'
            ? await pool.query(`
                UPDATE pending_ride_requests
                SET status = 'cancelled',
                    updated_at = CURRENT_TIMESTAMP
                WHERE request_id = $1 AND status = 'waiting' AND user_id = $2
                RETURNING *
            `, [request_id, authUserId])
            : await pool.query(`
                UPDATE pending_ride_requests
                SET status = 'cancelled',
                    updated_at = CURRENT_TIMESTAMP
                WHERE request_id = $1 AND status = 'waiting'
                RETURNING *
            `, [request_id]);

        if (result.rows.length === 0) {
            return res.status(404).json({
                success: false,
                error: 'Ride request not found or already processed'
            });
        }

        res.json({
            success: true,
            message: 'تم إلغاء الطلب',
            data: result.rows[0]
        });
    } catch (err) {
        console.error('Error cancelling ride request:', err);
        res.status(500).json({ success: false, error: err.message });
    }
});

// ==================== CAPTAIN-ONLY (DRIVER) FEATURES ====================

function ensureDriverSelfOrAdmin(req, res, driverId) {
    const authRole = String(req.auth?.role || '').toLowerCase();
    const authDriverId = req.auth?.driver_id;
    if (authRole === 'driver') {
        if (!authDriverId) return { ok: false, status: 403, error: 'Driver profile not linked to this account' };
        if (String(driverId) !== String(authDriverId)) return { ok: false, status: 403, error: 'Forbidden' };
    }
    return { ok: true };
}

app.get('/api/drivers/:id/captain/acceptance-rules', requireRole('driver', 'admin'), async (req, res) => {
    try {
        const driverId = Number(req.params.id);
        if (!Number.isFinite(driverId) || driverId <= 0) return res.status(400).json({ success: false, error: 'invalid_driver_id' });
        const access = ensureDriverSelfOrAdmin(req, res, driverId);
        if (!access.ok) return res.status(access.status).json({ success: false, error: access.error });

        const r = await pool.query(
            `SELECT driver_id, min_fare, max_pickup_distance_km, excluded_zones_json, preferred_axis_json, updated_at
             FROM driver_acceptance_rules
             WHERE driver_id = $1
             LIMIT 1`,
            [driverId]
        );
        res.json({ success: true, data: r.rows[0] || null });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

app.put('/api/drivers/:id/captain/acceptance-rules', requireRole('driver', 'admin'), async (req, res) => {
    try {
        const driverId = Number(req.params.id);
        if (!Number.isFinite(driverId) || driverId <= 0) return res.status(400).json({ success: false, error: 'invalid_driver_id' });
        const access = ensureDriverSelfOrAdmin(req, res, driverId);
        if (!access.ok) return res.status(access.status).json({ success: false, error: access.error });

        const minFare = safeNumber(req.body?.min_fare);
        const maxPickup = safeNumber(req.body?.max_pickup_distance_km);
        const excludedZones = req.body?.excluded_zones_json !== undefined ? req.body.excluded_zones_json : req.body?.excluded_zones;
        const preferredAxis = req.body?.preferred_axis_json !== undefined ? req.body.preferred_axis_json : req.body?.preferred_axis;

        const upsert = await pool.query(
            `INSERT INTO driver_acceptance_rules (driver_id, min_fare, max_pickup_distance_km, excluded_zones_json, preferred_axis_json, updated_at)
             VALUES ($1, $2, $3, $4::jsonb, $5::jsonb, CURRENT_TIMESTAMP)
             ON CONFLICT (driver_id) DO UPDATE SET
                min_fare = EXCLUDED.min_fare,
                max_pickup_distance_km = EXCLUDED.max_pickup_distance_km,
                excluded_zones_json = EXCLUDED.excluded_zones_json,
                preferred_axis_json = EXCLUDED.preferred_axis_json,
                updated_at = CURRENT_TIMESTAMP
             RETURNING driver_id, min_fare, max_pickup_distance_km, excluded_zones_json, preferred_axis_json, updated_at`,
            [
                driverId,
                Number.isFinite(minFare) && minFare >= 0 ? minFare : null,
                Number.isFinite(maxPickup) && maxPickup > 0 ? Math.min(Math.max(maxPickup, 1), 100) : null,
                excludedZones !== undefined ? JSON.stringify(excludedZones) : null,
                preferredAxis !== undefined ? JSON.stringify(preferredAxis) : null
            ]
        );

        res.json({ success: true, data: upsert.rows[0] });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

app.get('/api/drivers/:id/captain/go-home', requireRole('driver', 'admin'), async (req, res) => {
    try {
        const driverId = Number(req.params.id);
        if (!Number.isFinite(driverId) || driverId <= 0) return res.status(400).json({ success: false, error: 'invalid_driver_id' });
        const access = ensureDriverSelfOrAdmin(req, res, driverId);
        if (!access.ok) return res.status(access.status).json({ success: false, error: access.error });

        const r = await pool.query(
            `SELECT driver_id, enabled, home_lat, home_lng, max_detour_km, updated_at
             FROM driver_go_home_settings
             WHERE driver_id = $1
             LIMIT 1`,
            [driverId]
        );
        res.json({ success: true, data: r.rows[0] || null });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

app.put('/api/drivers/:id/captain/go-home', requireRole('driver', 'admin'), async (req, res) => {
    try {
        const driverId = Number(req.params.id);
        if (!Number.isFinite(driverId) || driverId <= 0) return res.status(400).json({ success: false, error: 'invalid_driver_id' });
        const access = ensureDriverSelfOrAdmin(req, res, driverId);
        if (!access.ok) return res.status(access.status).json({ success: false, error: access.error });

        const enabled = !!req.body?.enabled;
        const homeLat = safeNumber(req.body?.home_lat);
        const homeLng = safeNumber(req.body?.home_lng);
        const maxDetour = safeNumber(req.body?.max_detour_km);

        const upsert = await pool.query(
            `INSERT INTO driver_go_home_settings (driver_id, enabled, home_lat, home_lng, max_detour_km, updated_at)
             VALUES ($1, $2, $3, $4, $5, CURRENT_TIMESTAMP)
             ON CONFLICT (driver_id) DO UPDATE SET
                enabled = EXCLUDED.enabled,
                home_lat = EXCLUDED.home_lat,
                home_lng = EXCLUDED.home_lng,
                max_detour_km = EXCLUDED.max_detour_km,
                updated_at = CURRENT_TIMESTAMP
             RETURNING driver_id, enabled, home_lat, home_lng, max_detour_km, updated_at`,
            [
                driverId,
                enabled,
                Number.isFinite(homeLat) ? homeLat : null,
                Number.isFinite(homeLng) ? homeLng : null,
                Number.isFinite(maxDetour) && maxDetour >= 0 ? Math.min(Math.max(maxDetour, 0), 30) : 2
            ]
        );

        res.json({ success: true, data: upsert.rows[0] });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

app.get('/api/drivers/:id/captain/goals', requireRole('driver', 'admin'), async (req, res) => {
    try {
        const driverId = Number(req.params.id);
        if (!Number.isFinite(driverId) || driverId <= 0) return res.status(400).json({ success: false, error: 'invalid_driver_id' });
        const access = ensureDriverSelfOrAdmin(req, res, driverId);
        if (!access.ok) return res.status(access.status).json({ success: false, error: access.error });

        const r = await pool.query(
            `SELECT driver_id, daily_target, weekly_target, updated_at
             FROM driver_earnings_goals
             WHERE driver_id = $1
             LIMIT 1`,
            [driverId]
        );
        res.json({ success: true, data: r.rows[0] || null });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

app.put('/api/drivers/:id/captain/goals', requireRole('driver', 'admin'), async (req, res) => {
    try {
        const driverId = Number(req.params.id);
        if (!Number.isFinite(driverId) || driverId <= 0) return res.status(400).json({ success: false, error: 'invalid_driver_id' });
        const access = ensureDriverSelfOrAdmin(req, res, driverId);
        if (!access.ok) return res.status(access.status).json({ success: false, error: access.error });

        const daily = safeNumber(req.body?.daily_target);
        const weekly = safeNumber(req.body?.weekly_target);

        const upsert = await pool.query(
            `INSERT INTO driver_earnings_goals (driver_id, daily_target, weekly_target, updated_at)
             VALUES ($1, $2, $3, CURRENT_TIMESTAMP)
             ON CONFLICT (driver_id) DO UPDATE SET
                daily_target = EXCLUDED.daily_target,
                weekly_target = EXCLUDED.weekly_target,
                updated_at = CURRENT_TIMESTAMP
             RETURNING driver_id, daily_target, weekly_target, updated_at`,
            [
                driverId,
                Number.isFinite(daily) && daily >= 0 ? daily : null,
                Number.isFinite(weekly) && weekly >= 0 ? weekly : null
            ]
        );
        res.json({ success: true, data: upsert.rows[0] });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

app.get('/api/drivers/:id/captain/fatigue/today', requireRole('driver', 'admin'), async (req, res) => {
    try {
        const driverId = Number(req.params.id);
        if (!Number.isFinite(driverId) || driverId <= 0) return res.status(400).json({ success: false, error: 'invalid_driver_id' });
        const access = ensureDriverSelfOrAdmin(req, res, driverId);
        if (!access.ok) return res.status(access.status).json({ success: false, error: access.error });

        const settingsRes = await pool.query(
            `SELECT enabled, safe_limit_minutes
             FROM driver_fatigue_settings
             WHERE driver_id = $1
             LIMIT 1`,
            [driverId]
        );
        const s = settingsRes.rows[0] || { enabled: true, safe_limit_minutes: 480 };
        const sumRes = await pool.query(
            `SELECT
                 COALESCE(SUM(COALESCE(duration_minutes, duration, 0)), 0)::int AS minutes
             FROM trips
             WHERE driver_id = $1
               AND status = 'completed'
               AND completed_at >= DATE_TRUNC('day', NOW())`,
            [driverId]
        );
        const minutes = Number(sumRes.rows[0]?.minutes || 0);
        const limit = Number(s.safe_limit_minutes || 480);
        const warn = !!s.enabled && minutes >= limit;
        res.json({ success: true, data: { enabled: !!s.enabled, safe_limit_minutes: limit, driving_minutes_today: minutes, warning: warn } });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

app.put('/api/drivers/:id/captain/fatigue/settings', requireRole('driver', 'admin'), async (req, res) => {
    try {
        const driverId = Number(req.params.id);
        if (!Number.isFinite(driverId) || driverId <= 0) return res.status(400).json({ success: false, error: 'invalid_driver_id' });
        const access = ensureDriverSelfOrAdmin(req, res, driverId);
        if (!access.ok) return res.status(access.status).json({ success: false, error: access.error });

        const enabled = req.body?.enabled !== undefined ? !!req.body.enabled : true;
        const limit = safeNumber(req.body?.safe_limit_minutes);
        const safeLimit = Number.isFinite(limit) ? Math.max(60, Math.min(24 * 60, Math.round(limit))) : 480;

        const upsert = await pool.query(
            `INSERT INTO driver_fatigue_settings (driver_id, enabled, safe_limit_minutes, updated_at)
             VALUES ($1, $2, $3, CURRENT_TIMESTAMP)
             ON CONFLICT (driver_id) DO UPDATE SET
                enabled = EXCLUDED.enabled,
                safe_limit_minutes = EXCLUDED.safe_limit_minutes,
                updated_at = CURRENT_TIMESTAMP
             RETURNING driver_id, enabled, safe_limit_minutes, updated_at`,
            [driverId, enabled, safeLimit]
        );
        res.json({ success: true, data: upsert.rows[0] });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

app.post('/api/drivers/:id/captain/expenses', requireRole('driver', 'admin'), async (req, res) => {
    try {
        const driverId = Number(req.params.id);
        if (!Number.isFinite(driverId) || driverId <= 0) return res.status(400).json({ success: false, error: 'invalid_driver_id' });
        const access = ensureDriverSelfOrAdmin(req, res, driverId);
        if (!access.ok) return res.status(access.status).json({ success: false, error: access.error });

        const category = String(req.body?.category || '').trim().toLowerCase();
        const allowed = new Set(['fuel', 'maintenance', 'oil', 'cards', 'other', 'بنزين', 'صيانة', 'زيوت', 'كروت', 'أخرى']);
        if (!category || !allowed.has(category)) return res.status(400).json({ success: false, error: 'invalid_category' });
        const amount = safeNumber(req.body?.amount);
        if (!Number.isFinite(amount) || amount <= 0) return res.status(400).json({ success: false, error: 'invalid_amount' });
        const note = req.body?.note ? String(req.body.note).slice(0, 500) : null;
        const expenseDate = req.body?.expense_date ? String(req.body.expense_date) : null;

        const insert = await pool.query(
            `INSERT INTO driver_expenses (driver_id, category, amount, note, expense_date)
             VALUES ($1, $2, $3, $4, COALESCE($5::date, CURRENT_DATE))
             RETURNING id, driver_id, category, amount, note, expense_date, created_at`,
            [driverId, category, amount, note, expenseDate]
        );
        res.status(201).json({ success: true, data: insert.rows[0] });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

app.get('/api/drivers/:id/captain/expenses', requireRole('driver', 'admin'), async (req, res) => {
    try {
        const driverId = Number(req.params.id);
        if (!Number.isFinite(driverId) || driverId <= 0) return res.status(400).json({ success: false, error: 'invalid_driver_id' });
        const access = ensureDriverSelfOrAdmin(req, res, driverId);
        if (!access.ok) return res.status(access.status).json({ success: false, error: access.error });

        const from = req.query?.from ? String(req.query.from) : null;
        const to = req.query?.to ? String(req.query.to) : null;
        const q = await pool.query(
            `SELECT id, category, amount, note, expense_date, created_at
             FROM driver_expenses
             WHERE driver_id = $1
               AND ($2::date IS NULL OR expense_date >= $2::date)
               AND ($3::date IS NULL OR expense_date <= $3::date)
             ORDER BY expense_date DESC, created_at DESC
             LIMIT 200`,
            [driverId, from, to]
        );
        res.json({ success: true, count: q.rows.length, data: q.rows });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

app.get('/api/drivers/:id/captain/net-profit/today', requireRole('driver', 'admin'), async (req, res) => {
    try {
        const driverId = Number(req.params.id);
        if (!Number.isFinite(driverId) || driverId <= 0) return res.status(400).json({ success: false, error: 'invalid_driver_id' });
        const access = ensureDriverSelfOrAdmin(req, res, driverId);
        if (!access.ok) return res.status(access.status).json({ success: false, error: access.error });

        const incomeRes = await pool.query(
            `SELECT COALESCE(SUM(COALESCE(cost, price, 0)), 0)::numeric AS income
             FROM trips
             WHERE driver_id = $1
               AND status = 'completed'
               AND completed_at >= DATE_TRUNC('day', NOW())`,
            [driverId]
        );
        const expRes = await pool.query(
            `SELECT COALESCE(SUM(amount), 0)::numeric AS expenses
             FROM driver_expenses
             WHERE driver_id = $1
               AND expense_date = CURRENT_DATE`,
            [driverId]
        );
        const income = Number(incomeRes.rows[0]?.income || 0);
        const expenses = Number(expRes.rows[0]?.expenses || 0);
        res.json({ success: true, data: { income, expenses, net: Math.round((income - expenses) * 100) / 100 } });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

app.get('/api/drivers/:id/captain/favorites', requireRole('driver', 'admin'), async (req, res) => {
    try {
        const driverId = Number(req.params.id);
        if (!Number.isFinite(driverId) || driverId <= 0) return res.status(400).json({ success: false, error: 'invalid_driver_id' });
        const access = ensureDriverSelfOrAdmin(req, res, driverId);
        if (!access.ok) return res.status(access.status).json({ success: false, error: access.error });

        const q = await pool.query(
            `SELECT f.user_id, f.created_at, u.name, u.phone
             FROM driver_favorite_passengers f
             JOIN users u ON u.id = f.user_id
             WHERE f.driver_id = $1
             ORDER BY f.created_at DESC
             LIMIT 200`,
            [driverId]
        );
        res.json({ success: true, count: q.rows.length, data: q.rows });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

app.post('/api/drivers/:id/captain/favorites', requireRole('driver', 'admin'), async (req, res) => {
    try {
        const driverId = Number(req.params.id);
        const userId = Number(req.body?.user_id);
        if (!Number.isFinite(driverId) || driverId <= 0) return res.status(400).json({ success: false, error: 'invalid_driver_id' });
        if (!Number.isFinite(userId) || userId <= 0) return res.status(400).json({ success: false, error: 'invalid_user_id' });
        const access = ensureDriverSelfOrAdmin(req, res, driverId);
        if (!access.ok) return res.status(access.status).json({ success: false, error: access.error });

        // Guardrail: allow only if driver had a completed trip with that passenger (last 90 days)
        const okTrip = await pool.query(
            `SELECT 1
             FROM trips
             WHERE driver_id = $1 AND rider_id = $2 AND status = 'completed'
               AND completed_at >= NOW() - INTERVAL '90 days'
             LIMIT 1`,
            [driverId, userId]
        );
        if (okTrip.rows.length === 0) {
            return res.status(400).json({ success: false, error: 'favorite_requires_completed_trip' });
        }

        const insert = await pool.query(
            `INSERT INTO driver_favorite_passengers (driver_id, user_id)
             VALUES ($1, $2)
             ON CONFLICT (driver_id, user_id) DO NOTHING
             RETURNING driver_id, user_id, created_at`,
            [driverId, userId]
        );
        res.status(201).json({ success: true, data: insert.rows[0] || { driver_id: driverId, user_id: userId } });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

app.delete('/api/drivers/:id/captain/favorites/:userId', requireRole('driver', 'admin'), async (req, res) => {
    try {
        const driverId = Number(req.params.id);
        const userId = Number(req.params.userId);
        if (!Number.isFinite(driverId) || driverId <= 0) return res.status(400).json({ success: false, error: 'invalid_driver_id' });
        if (!Number.isFinite(userId) || userId <= 0) return res.status(400).json({ success: false, error: 'invalid_user_id' });
        const access = ensureDriverSelfOrAdmin(req, res, driverId);
        if (!access.ok) return res.status(access.status).json({ success: false, error: access.error });

        await pool.query('DELETE FROM driver_favorite_passengers WHERE driver_id = $1 AND user_id = $2', [driverId, userId]);
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

app.get('/api/drivers/:id/captain/earnings-assistant', requireRole('driver', 'admin'), async (req, res) => {
    try {
        const driverId = Number(req.params.id);
        const access = ensureDriverSelfOrAdmin(req, res, driverId);
        if (!access.ok) return res.status(access.status).json({ success: false, error: access.error });
        const windowDays = Number.isFinite(Number(req.query?.window_days)) ? Math.max(7, Math.min(180, Number(req.query.window_days))) : 30;

        const byHour = await pool.query(
            `SELECT EXTRACT(HOUR FROM completed_at)::int AS hour,
                    COUNT(*)::int AS trips,
                    COALESCE(SUM(COALESCE(cost, price, 0)), 0)::numeric AS earnings
             FROM trips
             WHERE driver_id = $1 AND status = 'completed'
               AND completed_at >= NOW() - ($2::int || ' days')::interval
             GROUP BY 1
             ORDER BY earnings DESC
             LIMIT 6`,
            [driverId, windowDays]
        );

        // Simple geo clustering by rounding coords (no new libs)
        const byZone = await pool.query(
            `SELECT
                ROUND(COALESCE(pickup_lat, 0)::numeric, 2) AS lat2,
                ROUND(COALESCE(pickup_lng, 0)::numeric, 2) AS lng2,
                COUNT(*)::int AS trips,
                COALESCE(SUM(COALESCE(cost, price, 0)), 0)::numeric AS earnings
             FROM trips
             WHERE driver_id = $1 AND status = 'completed'
               AND pickup_lat IS NOT NULL AND pickup_lng IS NOT NULL
               AND completed_at >= NOW() - ($2::int || ' days')::interval
             GROUP BY 1,2
             ORDER BY earnings DESC
             LIMIT 6`,
            [driverId, windowDays]
        );

        const goalsRes = await pool.query('SELECT daily_target, weekly_target FROM driver_earnings_goals WHERE driver_id = $1 LIMIT 1', [driverId]);
        const goals = goalsRes.rows[0] || null;

        const todayIncomeRes = await pool.query(
            `SELECT COALESCE(SUM(COALESCE(cost, price, 0)), 0)::numeric AS income
             FROM trips
             WHERE driver_id = $1 AND status = 'completed'
               AND completed_at >= DATE_TRUNC('day', NOW())`,
            [driverId]
        );
        const todayIncome = Number(todayIncomeRes.rows[0]?.income || 0);

        // week starts Monday in Postgres by default for date_trunc('week')? It's ISO week (Monday). Good.
        const weekIncomeRes = await pool.query(
            `SELECT COALESCE(SUM(COALESCE(cost, price, 0)), 0)::numeric AS income
             FROM trips
             WHERE driver_id = $1 AND status = 'completed'
               AND completed_at >= DATE_TRUNC('week', NOW())`,
            [driverId]
        );
        const weekIncome = Number(weekIncomeRes.rows[0]?.income || 0);

        const dailyTarget = goals?.daily_target !== undefined && goals?.daily_target !== null ? Number(goals.daily_target) : null;
        const weeklyTarget = goals?.weekly_target !== undefined && goals?.weekly_target !== null ? Number(goals.weekly_target) : null;

        res.json({
            success: true,
            data: {
                window_days: windowDays,
                best_hours: byHour.rows,
                best_zones: byZone.rows,
                goals: goals,
                progress: {
                    today_income: todayIncome,
                    today_remaining: Number.isFinite(dailyTarget) ? Math.max(0, Math.round((dailyTarget - todayIncome) * 100) / 100) : null,
                    week_income: weekIncome,
                    week_remaining: Number.isFinite(weeklyTarget) ? Math.max(0, Math.round((weeklyTarget - weekIncome) * 100) / 100) : null
                }
            }
        });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

app.get('/api/drivers/me/emergency-profile', requireRole('driver', 'admin'), async (req, res) => {
    try {
        const driverId = req.auth?.driver_id;
        if (!driverId) return res.status(403).json({ success: false, error: 'Driver profile not linked to this account' });
        const r = await pool.query(
            `SELECT driver_id, opt_in, contact_name, contact_channel, contact_value, medical_note, updated_at
             FROM driver_emergency_profiles
             WHERE driver_id = $1
             LIMIT 1`,
            [driverId]
        );
        res.json({ success: true, data: r.rows[0] || null });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

app.put('/api/drivers/me/emergency-profile', requireRole('driver', 'admin'), async (req, res) => {
    try {
        const driverId = req.auth?.driver_id;
        if (!driverId) return res.status(403).json({ success: false, error: 'Driver profile not linked to this account' });

        const optIn = !!req.body?.opt_in;
        const contactName = req.body?.contact_name ? String(req.body.contact_name).slice(0, 120) : null;
        const channel = req.body?.contact_channel ? String(req.body.contact_channel).toLowerCase() : 'phone';
        const value = req.body?.contact_value ? String(req.body.contact_value).slice(0, 180) : null;
        const medical = req.body?.medical_note ? String(req.body.medical_note).slice(0, 500) : null;
        const allowed = new Set(['phone', 'sms', 'whatsapp', 'email']);
        if (!allowed.has(channel)) return res.status(400).json({ success: false, error: 'invalid_contact_channel' });

        const upsert = await pool.query(
            `INSERT INTO driver_emergency_profiles (driver_id, opt_in, contact_name, contact_channel, contact_value, medical_note, updated_at)
             VALUES ($1,$2,$3,$4,$5,$6,CURRENT_TIMESTAMP)
             ON CONFLICT (driver_id) DO UPDATE SET
                opt_in = EXCLUDED.opt_in,
                contact_name = EXCLUDED.contact_name,
                contact_channel = EXCLUDED.contact_channel,
                contact_value = EXCLUDED.contact_value,
                medical_note = EXCLUDED.medical_note,
                updated_at = CURRENT_TIMESTAMP
             RETURNING driver_id, opt_in, contact_name, contact_channel, contact_value, medical_note, updated_at`,
            [driverId, optIn, contactName, channel, value, medical]
        );
        res.json({ success: true, data: upsert.rows[0] });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

app.post('/api/drivers/me/sos', requireRole('driver', 'admin'), async (req, res) => {
    try {
        const driverId = req.auth?.driver_id;
        if (!driverId) return res.status(403).json({ success: false, error: 'Driver profile not linked to this account' });

        const lat = safeNumber(req.body?.lat);
        const lng = safeNumber(req.body?.lng);
        const tripId = req.body?.trip_id ? String(req.body.trip_id) : null;
        const message = req.body?.message ? String(req.body.message).slice(0, 300) : null;

        await pool.query(`UPDATE drivers SET status = 'offline', updated_at = CURRENT_TIMESTAMP WHERE id = $1`, [driverId]);

        const insert = await pool.query(
            `INSERT INTO driver_sos_events (driver_id, trip_id, message, lat, lng)
             VALUES ($1, $2, NULLIF($3,''), $4, $5)
             RETURNING *`,
            [driverId, tripId, message || '', Number.isFinite(lat) ? lat : null, Number.isFinite(lng) ? lng : null]
        );

        // Optional: also log into trip safety events when a trip is provided
        if (tripId) {
            try {
                await pool.query(
                    `INSERT INTO trip_safety_events (trip_id, created_by_role, created_by_user_id, created_by_driver_id, event_type, message)
                     VALUES ($1, 'driver', NULL, $2, 'driver_sos', NULLIF($3,''))`,
                    [tripId, driverId, message || '']
                );
                try { io.to(tripRoom(tripId)).emit('safety_event', { trip_id: String(tripId), event: { event_type: 'driver_sos', created_at: new Date().toISOString() } }); } catch (e) {}
            } catch (e) {
                // ignore
            }
        }

        // Notify driver's emergency contact (opt-in)
        let delivery = null;
        try {
            const profRes = await pool.query(
                `SELECT opt_in, contact_name, contact_channel, contact_value
                 FROM driver_emergency_profiles
                 WHERE driver_id = $1
                 LIMIT 1`,
                [driverId]
            );
            const prof = profRes.rows[0] || null;
            if (prof && prof.opt_in && prof.contact_value) {
                const text = `🆘 SOS من الكابتن\nDriver: ${driverId}\n${tripId ? `Trip: ${tripId}\n` : ''}${Number.isFinite(lat) && Number.isFinite(lng) ? `Location: ${lat},${lng}\n` : ''}${message ? `Note: ${message}` : ''}`;
                delivery = await deliverGuardianNotification({
                    contact: { channel: prof.contact_channel, value: prof.contact_value, name: prof.contact_name },
                    message: text,
                    subject: 'SOS (Driver)'
                });
            }
        } catch (e) {
            delivery = null;
        }

        res.status(201).json({ success: true, data: insert.rows[0], contact_delivery: delivery });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

app.post('/api/drivers/me/stop-receiving', requireRole('driver', 'admin'), async (req, res) => {
    try {
        const driverId = req.auth?.driver_id;
        if (!driverId) return res.status(403).json({ success: false, error: 'Driver profile not linked to this account' });

        const result = await pool.query(
            `UPDATE drivers
             SET status = 'offline', updated_at = CURRENT_TIMESTAMP
             WHERE id = $1
             RETURNING id, status, updated_at`,
            [driverId]
        );
        res.json({ success: true, data: result.rows[0] || null });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

app.post('/api/drivers/me/road-reports', requireRole('driver', 'admin'), async (req, res) => {
    try {
        const driverId = req.auth?.driver_id;
        if (!driverId) return res.status(403).json({ success: false, error: 'Driver profile not linked to this account' });
        const type = String(req.body?.report_type || '').toLowerCase();
        const allowed = new Set(['traffic', 'checkpoint', 'closure', 'other']);
        if (!allowed.has(type)) return res.status(400).json({ success: false, error: 'invalid_report_type' });
        const lat = safeNumber(req.body?.lat);
        const lng = safeNumber(req.body?.lng);
        if (!Number.isFinite(lat) || !Number.isFinite(lng)) return res.status(400).json({ success: false, error: 'invalid_coordinates' });
        const note = req.body?.note ? String(req.body.note).slice(0, 300) : null;
        const ttlMin = Number.isFinite(Number(req.body?.ttl_minutes)) ? Math.max(5, Math.min(12 * 60, Number(req.body.ttl_minutes))) : 60;
        const expiresAt = new Date(Date.now() + ttlMin * 60 * 1000);

        const insert = await pool.query(
            `INSERT INTO driver_road_reports (driver_id, report_type, lat, lng, note, expires_at)
             VALUES ($1,$2,$3,$4,$5,$6)
             RETURNING *`,
            [driverId, type, lat, lng, note, expiresAt.toISOString()]
        );
        res.status(201).json({ success: true, data: insert.rows[0] });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

app.post('/api/drivers/me/road-reports/:id/vote', requireRole('driver', 'admin'), async (req, res) => {
    try {
        const voterDriverId = req.auth?.driver_id;
        if (!voterDriverId) return res.status(403).json({ success: false, error: 'Driver profile not linked to this account' });
        const reportId = Number(req.params.id);
        if (!Number.isFinite(reportId) || reportId <= 0) return res.status(400).json({ success: false, error: 'invalid_report_id' });
        const vote = String(req.body?.vote || '').toLowerCase();
        const allowed = new Set(['confirm', 'deny']);
        if (!allowed.has(vote)) return res.status(400).json({ success: false, error: 'invalid_vote' });

        const repRes = await pool.query(
            `SELECT id, driver_id, expires_at
             FROM driver_road_reports
             WHERE id = $1
             LIMIT 1`,
            [reportId]
        );
        const rep = repRes.rows[0] || null;
        if (!rep) return res.status(404).json({ success: false, error: 'not_found' });
        if (rep.expires_at && new Date(rep.expires_at).getTime() <= Date.now()) {
            return res.status(400).json({ success: false, error: 'expired' });
        }
        if (String(rep.driver_id || '') === String(voterDriverId)) {
            return res.status(400).json({ success: false, error: 'cannot_vote_own_report' });
        }

        await pool.query(
            `INSERT INTO driver_road_report_votes (report_id, driver_id, vote, created_at, updated_at)
             VALUES ($1, $2, $3, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
             ON CONFLICT (report_id, driver_id) DO UPDATE SET
                vote = EXCLUDED.vote,
                updated_at = CURRENT_TIMESTAMP`,
            [reportId, voterDriverId, vote]
        );

        await pool.query(
            `UPDATE driver_road_reports r
             SET confirms_count = (
                 SELECT COUNT(*)::int
                 FROM driver_road_report_votes v
                 WHERE v.report_id = r.id AND v.vote = 'confirm'
             )
             WHERE r.id = $1`,
            [reportId]
        );

        const out = await pool.query('SELECT * FROM driver_road_reports WHERE id = $1 LIMIT 1', [reportId]);
        res.json({ success: true, data: out.rows[0] || null });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

app.get('/api/drivers/me/road-reports/nearby', requireRole('driver', 'admin'), async (req, res) => {
    try {
        const lat = safeNumber(req.query?.lat);
        const lng = safeNumber(req.query?.lng);
        const radius = Number.isFinite(Number(req.query?.radius_km)) ? Math.max(1, Math.min(30, Number(req.query.radius_km))) : 6;
        if (!Number.isFinite(lat) || !Number.isFinite(lng)) return res.status(400).json({ success: false, error: 'invalid_coordinates' });

        const q = await pool.query(
            `SELECT r.*,
                    rel.confirmed_votes::int AS reliability_confirmed,
                    rel.denied_votes::int AS reliability_denied,
                    rel.total_votes::int AS reliability_total,
                    rel.score::numeric AS reliability_score,
                    (6371 * acos(
                        cos(radians($1)) * cos(radians(r.lat)) * cos(radians(r.lng) - radians($2)) +
                        sin(radians($1)) * sin(radians(r.lat))
                    )) AS distance_km
             FROM driver_road_reports r
             LEFT JOIN LATERAL (
                 SELECT
                     COALESCE(SUM(CASE WHEN v.vote = 'confirm' THEN 1 ELSE 0 END), 0) AS confirmed_votes,
                     COALESCE(SUM(CASE WHEN v.vote = 'deny' THEN 1 ELSE 0 END), 0) AS denied_votes,
                     COALESCE(COUNT(*), 0) AS total_votes,
                     CASE
                         WHEN COUNT(*) > 0 THEN
                             (COALESCE(SUM(CASE WHEN v.vote = 'confirm' THEN 1 ELSE 0 END), 0)::float / COUNT(*)::float)
                         ELSE NULL
                     END AS score
                 FROM driver_road_report_votes v
                 JOIN driver_road_reports rr ON rr.id = v.report_id
                 WHERE rr.driver_id = r.driver_id
             ) rel ON true
             WHERE (r.expires_at IS NULL OR r.expires_at > NOW())
               AND (6371 * acos(
                        cos(radians($1)) * cos(radians(r.lat)) * cos(radians(r.lng) - radians($2)) +
                        sin(radians($1)) * sin(radians(r.lat))
                    )) <= $3
             ORDER BY distance_km ASC, r.created_at DESC
             LIMIT 60`,
            [lat, lng, radius]
        );
        res.json({ success: true, count: q.rows.length, data: q.rows });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

app.post('/api/drivers/me/map-errors', requireRole('driver', 'admin'), async (req, res) => {
    try {
        const driverId = req.auth?.driver_id;
        if (!driverId) return res.status(403).json({ success: false, error: 'Driver profile not linked to this account' });
        const type = String(req.body?.error_type || '').toLowerCase();
        const allowed = new Set(['wrong_entrance', 'closed_gate', 'better_meeting_point', 'other']);
        if (!allowed.has(type)) return res.status(400).json({ success: false, error: 'invalid_error_type' });
        const lat = safeNumber(req.body?.lat);
        const lng = safeNumber(req.body?.lng);
        if (!Number.isFinite(lat) || !Number.isFinite(lng)) return res.status(400).json({ success: false, error: 'invalid_coordinates' });
        const title = req.body?.title ? String(req.body.title).slice(0, 120) : null;
        const details = req.body?.details ? String(req.body.details).slice(0, 500) : null;

        const insert = await pool.query(
            `INSERT INTO driver_map_error_reports (driver_id, error_type, lat, lng, title, details)
             VALUES ($1,$2,$3,$4,$5,$6)
             RETURNING *`,
            [driverId, type, lat, lng, title, details]
        );
        res.status(201).json({ success: true, data: insert.rows[0] });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

app.get('/api/drivers/:id/captain/next-trip-suggestion', requireRole('driver', 'admin'), async (req, res) => {
    try {
        const driverId = Number(req.params.id);
        const access = ensureDriverSelfOrAdmin(req, res, driverId);
        if (!access.ok) return res.status(access.status).json({ success: false, error: access.error });

        const driverRes = await pool.query('SELECT last_lat, last_lng, last_location_at FROM drivers WHERE id = $1 LIMIT 1', [driverId]);
        const d = driverRes.rows[0] || null;
        if (!d || !d.last_lat || !d.last_lng) return res.json({ success: true, data: null });

        const lat = Number(d.last_lat);
        const lng = Number(d.last_lng);
        const radius = Number.isFinite(Number(req.query?.radius_km)) ? Math.max(1, Math.min(20, Number(req.query.radius_km))) : 3;

        const q = await pool.query(
            `SELECT pr.*,
                    (6371 * acos(
                        cos(radians($1)) * cos(radians(pr.pickup_lat)) * cos(radians(pr.pickup_lng) - radians($2)) +
                        sin(radians($1)) * sin(radians(pr.pickup_lat))
                    )) AS distance_km
             FROM pending_ride_requests pr
             WHERE pr.status = 'waiting'
               AND pr.expires_at > NOW()
               AND pr.pickup_lat IS NOT NULL AND pr.pickup_lng IS NOT NULL
               AND (6371 * acos(
                        cos(radians($1)) * cos(radians(pr.pickup_lat)) * cos(radians(pr.pickup_lng) - radians($2)) +
                        sin(radians($1)) * sin(radians(pr.pickup_lat))
                    )) <= $3
             ORDER BY distance_km ASC, pr.created_at ASC
             LIMIT 1`,
            [lat, lng, radius]
        );
        const row = q.rows[0] || null;
        res.json({ success: true, data: row });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

// Smart waiting proof (arrive + end waiting)
app.post('/api/trips/:id/waiting/arrive', requireRole('driver', 'admin'), async (req, res) => {
    try {
        const tripId = String(req.params.id);
        const authRole = String(req.auth?.role || '').toLowerCase();
        const authDriverId = req.auth?.driver_id;

        const tripRes = await pool.query('SELECT id, driver_id FROM trips WHERE id = $1 LIMIT 1', [tripId]);
        const trip = tripRes.rows[0] || null;
        if (!trip) return res.status(404).json({ success: false, error: 'Trip not found' });
        if (authRole === 'driver') {
            if (!authDriverId) return res.status(403).json({ success: false, error: 'Driver profile not linked to this account' });
            if (String(trip.driver_id || '') !== String(authDriverId)) return res.status(403).json({ success: false, error: 'Forbidden' });
        }

        const lat = safeNumber(req.body?.lat);
        const lng = safeNumber(req.body?.lng);
        if (!Number.isFinite(lat) || !Number.isFinite(lng)) return res.status(400).json({ success: false, error: 'invalid_coordinates' });

        const upsert = await pool.query(
            `INSERT INTO trip_wait_proofs (trip_id, driver_id, arrived_at, arrived_lat, arrived_lng, updated_at)
             VALUES ($1, $2, CURRENT_TIMESTAMP, $3, $4, CURRENT_TIMESTAMP)
             ON CONFLICT (trip_id) DO UPDATE SET
                driver_id = COALESCE(trip_wait_proofs.driver_id, EXCLUDED.driver_id),
                arrived_at = COALESCE(trip_wait_proofs.arrived_at, EXCLUDED.arrived_at),
                arrived_lat = COALESCE(trip_wait_proofs.arrived_lat, EXCLUDED.arrived_lat),
                arrived_lng = COALESCE(trip_wait_proofs.arrived_lng, EXCLUDED.arrived_lng),
                updated_at = CURRENT_TIMESTAMP
             RETURNING *`,
            [tripId, trip.driver_id || authDriverId || null, lat, lng]
        );
        res.status(201).json({ success: true, data: upsert.rows[0] });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

app.post('/api/trips/:id/waiting/end', requireRole('driver', 'admin'), async (req, res) => {
    try {
        const tripId = String(req.params.id);
        const authRole = String(req.auth?.role || '').toLowerCase();
        const authDriverId = req.auth?.driver_id;

        const tripRes = await pool.query('SELECT id, driver_id FROM trips WHERE id = $1 LIMIT 1', [tripId]);
        const trip = tripRes.rows[0] || null;
        if (!trip) return res.status(404).json({ success: false, error: 'Trip not found' });
        if (authRole === 'driver') {
            if (!authDriverId) return res.status(403).json({ success: false, error: 'Driver profile not linked to this account' });
            if (String(trip.driver_id || '') !== String(authDriverId)) return res.status(403).json({ success: false, error: 'Forbidden' });
        }

        const rowRes = await pool.query('SELECT arrived_at FROM trip_wait_proofs WHERE trip_id = $1 LIMIT 1', [tripId]);
        const arrivedAt = rowRes.rows[0]?.arrived_at ? new Date(rowRes.rows[0].arrived_at) : null;
        const seconds = arrivedAt && Number.isFinite(arrivedAt.getTime()) ? Math.max(0, Math.round((Date.now() - arrivedAt.getTime()) / 1000)) : null;

        const up = await pool.query(
            `UPDATE trip_wait_proofs
             SET wait_end_at = CURRENT_TIMESTAMP,
                 wait_seconds = COALESCE(wait_seconds, $2),
                 updated_at = CURRENT_TIMESTAMP
             WHERE trip_id = $1
             RETURNING *`,
            [tripId, seconds]
        );
        if (up.rows.length === 0) return res.status(404).json({ success: false, error: 'waiting_not_started' });
        res.json({ success: true, data: up.rows[0] });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

// Encrypted optional driver voice recording upload (trip-only)
app.post('/api/trips/:id/driver-audio', requireRole('driver', 'admin'), audioUpload.single('audio'), async (req, res) => {
    try {
        const tripId = String(req.params.id);
        const authRole = String(req.auth?.role || '').toLowerCase();
        const authDriverId = req.auth?.driver_id;
        const tripRes = await pool.query('SELECT id, driver_id, status FROM trips WHERE id = $1 LIMIT 1', [tripId]);
        const trip = tripRes.rows[0] || null;
        if (!trip) return res.status(404).json({ success: false, error: 'Trip not found' });
        if (authRole === 'driver') {
            if (!authDriverId) return res.status(403).json({ success: false, error: 'Driver profile not linked to this account' });
            if (String(trip.driver_id || '') !== String(authDriverId)) return res.status(403).json({ success: false, error: 'Forbidden' });
        }

        // Restrict to in-trip contexts (assigned/ongoing/started)
        const st = String(trip.status || '').toLowerCase();
        if (!['assigned', 'ongoing', 'started'].includes(st)) {
            return res.status(400).json({ success: false, error: 'audio_allowed_during_trip_only' });
        }

        const file = req.file;
        if (!file || !file.buffer || !file.size) return res.status(400).json({ success: false, error: 'missing_audio_file' });

        const enc = encryptBufferAesGcm(file.buffer);
        const name = `trip-${tripId}-${Date.now()}-${crypto.randomBytes(6).toString('hex')}.bin`;
        const relPath = name;
        const full = path.join(secureAudioDir, name);
        await fs.promises.writeFile(full, enc.ciphertext);

        const insert = await pool.query(
            `INSERT INTO trip_driver_audio_recordings (trip_id, driver_id, file_mime, file_size_bytes, algo, iv_hex, tag_hex, encrypted_rel_path)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
             RETURNING id, trip_id, driver_id, file_mime, file_size_bytes, algo, created_at`,
            [tripId, trip.driver_id || authDriverId || null, String(file.mimetype || ''), Number(file.size || 0), enc.algo, enc.iv.toString('hex'), enc.tag.toString('hex'), relPath]
        );

        res.status(201).json({ success: true, data: insert.rows[0] });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

app.get('/api/admin/trips/:tripId/driver-audio/:recId/download', requireRole('admin'), async (req, res) => {
    try {
        const tripId = String(req.params.tripId);
        const recId = Number(req.params.recId);
        if (!Number.isFinite(recId) || recId <= 0) return res.status(400).json({ success: false, error: 'invalid_recording_id' });

        const q = await pool.query(
            `SELECT *
             FROM trip_driver_audio_recordings
             WHERE id = $1 AND trip_id = $2
             LIMIT 1`,
            [recId, tripId]
        );
        const row = q.rows[0] || null;
        if (!row) return res.status(404).json({ success: false, error: 'not_found' });

        const full = path.join(secureAudioDir, String(row.encrypted_rel_path));
        const ciphertext = await fs.promises.readFile(full);
        const plaintext = decryptBufferAesGcm({
            iv: Buffer.from(String(row.iv_hex), 'hex'),
            tag: Buffer.from(String(row.tag_hex), 'hex'),
            ciphertext
        });

        res.setHeader('Content-Type', row.file_mime || 'audio/webm');
        res.setHeader('Content-Disposition', `attachment; filename="trip-${tripId}-audio-${recId}.webm"`);
        res.status(200).send(plaintext);
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

// Get pending rides for a specific driver (based on location and car type)
app.get('/api/drivers/:driver_id/pending-rides', requireRole('driver', 'admin'), async (req, res) => {
    try {
        const { driver_id } = req.params;
        const { max_distance } = req.query;

        const authRole = String(req.auth?.role || '').toLowerCase();
        const authDriverId = req.auth?.driver_id;
        if (authRole === 'driver') {
            if (!authDriverId) return res.status(403).json({ success: false, error: 'Driver profile not linked to this account' });
            if (String(driver_id) !== String(authDriverId)) {
                return res.status(403).json({ success: false, error: 'Forbidden' });
            }
        }

        // Get driver info
        const driverResult = await pool.query(`
            SELECT car_type, last_lat, last_lng, last_location_at, approval_status, rating
            FROM drivers
            WHERE id = $1
        `, [driver_id]);

        if (driverResult.rows.length === 0) {
            return res.status(404).json({
                success: false,
                error: 'Driver not found'
            });
        }

        const driver = driverResult.rows[0];

        // Night Safety Policy: block non-eligible drivers from night assignments
        if (isNightNow() && !isDriverEligibleForNightPolicy(driver)) {
            return res.json({
                success: true,
                count: 0,
                data: [],
                meta: {
                    night_policy_blocked: true,
                    min_rating: Number.isFinite(NIGHT_POLICY_MIN_RATING) ? NIGHT_POLICY_MIN_RATING : 4.7,
                    max_location_age_min: Number.isFinite(NIGHT_POLICY_MAX_LOCATION_AGE_MIN) ? NIGHT_POLICY_MAX_LOCATION_AGE_MIN : 10
                }
            });
        }

        if (!driver.last_lat || !driver.last_lng || !driver.last_location_at) {
            return res.json({
                success: true,
                count: 0,
                data: []
            });
        }

        // Captain rules (optional)
        const rulesRes = await pool.query(
            `SELECT min_fare, max_pickup_distance_km, excluded_zones_json, preferred_axis_json
             FROM driver_acceptance_rules
             WHERE driver_id = $1
             LIMIT 1`,
            [driver_id]
        );
        const rules = rulesRes.rows[0] || null;

        const goHomeRes = await pool.query(
            `SELECT enabled, home_lat, home_lng, max_detour_km
             FROM driver_go_home_settings
             WHERE driver_id = $1
             LIMIT 1`,
            [driver_id]
        );
        const goHome = goHomeRes.rows[0] || null;

        const maxFromQuery = Number.isFinite(Number(max_distance))
            ? Math.max(1, Math.min(Number(max_distance), 100))
            : MAX_ASSIGN_DISTANCE_KM;
        const maxFromRules = rules?.max_pickup_distance_km !== undefined && rules?.max_pickup_distance_km !== null
            ? Math.max(1, Math.min(Number(rules.max_pickup_distance_km), 100))
            : null;
        const maxDistanceKm = Number.isFinite(maxFromRules) ? Math.min(maxFromQuery, maxFromRules) : maxFromQuery;

        const queryBase = `
            SELECT
                pr.*,
                u.name as user_name,
                u.phone as user_phone,
                CASE
                    WHEN COALESCE(pv.status, '') = 'approved' THEN 'strong'
                    WHEN u.email_verified_at IS NOT NULL AND u.phone_verified_at IS NOT NULL THEN 'basic'
                    ELSE 'none'
                END AS passenger_verified_level,
                t.id as trip_ref,
                (6371 * acos(
                    cos(radians($2)) * cos(radians(pr.pickup_lat)) * cos(radians(pr.pickup_lng) - radians($3)) +
                    sin(radians($2)) * sin(radians(pr.pickup_lat))
                )) AS distance_km
            FROM pending_ride_requests pr
            LEFT JOIN users u ON pr.user_id = u.id
            LEFT JOIN LATERAL (
                SELECT status
                FROM passenger_verifications
                WHERE user_id = u.id
                ORDER BY submitted_at DESC
                LIMIT 1
            ) pv ON true
            INNER JOIN trips t ON t.id = pr.trip_id
            WHERE pr.status = 'waiting'
                AND pr.source = 'passenger_app'
                AND NOT ($1 = ANY(pr.rejected_by))
                AND pr.expires_at > CURRENT_TIMESTAMP
                AND t.status = 'pending'
                AND t.driver_id IS NULL
                AND COALESCE(t.source, 'passenger_app') = 'passenger_app'
                AND pr.pickup_lat IS NOT NULL
                AND pr.pickup_lng IS NOT NULL
                AND (6371 * acos(
                    cos(radians($2)) * cos(radians(pr.pickup_lat)) * cos(radians(pr.pickup_lng) - radians($3)) +
                    sin(radians($2)) * sin(radians(pr.pickup_lat))
                )) <= $4
        `;

        const withCarTypeResult = await pool.query(`
            ${queryBase}
            AND pr.car_type = $5
            ORDER BY distance_km ASC, pr.created_at ASC
            LIMIT 30
        `, [driver_id, Number(driver.last_lat), Number(driver.last_lng), maxDistanceKm, driver.car_type]);

        const result = withCarTypeResult.rows.length > 0
            ? withCarTypeResult
            : await pool.query(`
                ${queryBase}
                ORDER BY distance_km ASC, pr.created_at ASC
                LIMIT 30
            `, [driver_id, Number(driver.last_lat), Number(driver.last_lng), maxDistanceKm]);

        const rows = result.rows || [];
        const userIds = [...new Set(rows.map(r => r.user_id).filter(Boolean).map(Number).filter(n => Number.isFinite(n) && n > 0))];
        const cancelMap = new Map();
        if (userIds.length) {
            try {
                const canc = await pool.query(
                    `SELECT rider_id::int AS user_id,
                            COUNT(*)::int AS total,
                            SUM(CASE WHEN status = 'cancelled' THEN 1 ELSE 0 END)::int AS cancelled
                     FROM trips
                     WHERE rider_id = ANY($1)
                       AND created_at >= NOW() - INTERVAL '30 days'
                     GROUP BY 1`,
                    [userIds]
                );
                for (const r of canc.rows || []) {
                    const total = Number(r.total || 0);
                    const cancelled = Number(r.cancelled || 0);
                    const rate = total > 0 ? cancelled / total : null;
                    cancelMap.set(String(r.user_id), rate);
                }
            } catch (e) {
                // ignore
            }
        }

        const favSet = new Set();
        try {
            const fav = await pool.query('SELECT user_id FROM driver_favorite_passengers WHERE driver_id = $1', [driver_id]);
            for (const f of fav.rows || []) {
                if (f.user_id !== undefined && f.user_id !== null) favSet.add(String(f.user_id));
            }
        } catch (e) {
            // ignore
        }

        const minFare = rules?.min_fare !== undefined && rules?.min_fare !== null ? Number(rules.min_fare) : null;
        const excludedZones = rules?.excluded_zones_json && typeof rules.excluded_zones_json === 'object' ? rules.excluded_zones_json : null;
        const boxes = Array.isArray(excludedZones) ? excludedZones : [];

        const preferredAxis = rules?.preferred_axis_json && typeof rules.preferred_axis_json === 'object' ? rules.preferred_axis_json : null;
        const prefBearingRaw = safeNumber(preferredAxis?.bearing_deg !== undefined ? preferredAxis.bearing_deg : preferredAxis?.bearing);
        const prefTolRaw = safeNumber(preferredAxis?.tolerance_deg !== undefined ? preferredAxis.tolerance_deg : preferredAxis?.tolerance);
        const axisBearing = Number.isFinite(prefBearingRaw) ? ((prefBearingRaw % 360) + 360) % 360 : null;
        const axisTolerance = Number.isFinite(prefTolRaw) ? Math.max(5, Math.min(180, prefTolRaw)) : 45;

        const goHomeEnabled = !!goHome?.enabled;
        const homeLat = goHome?.home_lat !== undefined && goHome?.home_lat !== null ? Number(goHome.home_lat) : null;
        const homeLng = goHome?.home_lng !== undefined && goHome?.home_lng !== null ? Number(goHome.home_lng) : null;
        const maxDetour = goHome?.max_detour_km !== undefined && goHome?.max_detour_km !== null ? Number(goHome.max_detour_km) : 2;

        // Prefetch nearby road reports for simple congestion signal
        let nearbyReports = [];
        try {
            const rr = await pool.query(
                `SELECT id, report_type, lat, lng
                 FROM driver_road_reports
                 WHERE (expires_at IS NULL OR expires_at > NOW())
                   AND (6371 * acos(
                        cos(radians($1)) * cos(radians(lat)) * cos(radians(lng) - radians($2)) +
                        sin(radians($1)) * sin(radians(lat))
                   )) <= $3
                 ORDER BY created_at DESC
                 LIMIT 120`,
                [Number(driver.last_lat), Number(driver.last_lng), Math.max(3, maxDistanceKm + 2)]
            );
            nearbyReports = rr.rows || [];
        } catch (e) {
            nearbyReports = [];
        }

        const enriched = [];
        for (const r of rows) {
            const fare = r.estimated_cost !== undefined && r.estimated_cost !== null ? Number(r.estimated_cost) : null;
            if (Number.isFinite(minFare) && Number.isFinite(fare) && fare < minFare) {
                continue;
            }

            const pLat = r.pickup_lat !== undefined && r.pickup_lat !== null ? Number(r.pickup_lat) : null;
            const pLng = r.pickup_lng !== undefined && r.pickup_lng !== null ? Number(r.pickup_lng) : null;
            if (boxes.length && Number.isFinite(pLat) && Number.isFinite(pLng)) {
                const excluded = boxes.some((b) => withinBox(pLat, pLng, b));
                if (excluded) continue;
            }

            let goHomeMeta = null;
            if (goHomeEnabled && Number.isFinite(homeLat) && Number.isFinite(homeLng)) {
                const dPickup = haversineKm({ lat: pLat, lng: pLng }, { lat: homeLat, lng: homeLng });
                const dLat = r.dropoff_lat !== undefined && r.dropoff_lat !== null ? Number(r.dropoff_lat) : null;
                const dLng = r.dropoff_lng !== undefined && r.dropoff_lng !== null ? Number(r.dropoff_lng) : null;
                const dDrop = haversineKm({ lat: dLat, lng: dLng }, { lat: homeLat, lng: homeLng });
                const detour = Number.isFinite(maxDetour) ? maxDetour : 2;
                const ok = Number.isFinite(dPickup) && Number.isFinite(dDrop) ? (dDrop <= dPickup + detour) : false;
                if (!ok) continue;
                goHomeMeta = {
                    enabled: true,
                    dropoff_to_home_km: Number.isFinite(dDrop) ? Math.round(dDrop * 100) / 100 : null
                };
            }

            const cancelRate = cancelMap.has(String(r.user_id)) ? cancelMap.get(String(r.user_id)) : null;
            const profitability = computeProfitabilityIndicator({
                fare: fare,
                pickupDistanceKm: r.distance_km,
                tripDurationMin: r.estimated_duration
            });
            let risk = computeRiskIndicator({
                passengerVerifiedLevel: r.passenger_verified_level,
                passengerCancelRate30d: cancelRate,
                pickupDistanceKm: r.distance_km,
                rejectionCount: r.rejection_count
            });

            // Community road reports signal: traffic report near pickup
            let trafficNearPickup = false;
            if (nearbyReports.length && Number.isFinite(pLat) && Number.isFinite(pLng)) {
                trafficNearPickup = nearbyReports.some((rep) => {
                    if (!rep) return false;
                    const t = String(rep.report_type || '').toLowerCase();
                    if (t !== 'traffic') return false;
                    const rl = rep.lat !== undefined && rep.lat !== null ? Number(rep.lat) : null;
                    const rg = rep.lng !== undefined && rep.lng !== null ? Number(rep.lng) : null;
                    const dk = haversineKm({ lat: pLat, lng: pLng }, { lat: rl, lng: rg });
                    return Number.isFinite(dk) && dk <= 1.2;
                });
            }
            if (trafficNearPickup) {
                const reasons = Array.isArray(risk?.reasons) ? risk.reasons.slice() : [];
                if (!reasons.includes('congestion_report_nearby')) reasons.push('congestion_report_nearby');
                const score = Number.isFinite(risk?.score) ? Number(risk.score) + 1 : 1;
                const level = score >= 4 ? 'high' : score >= 2 ? 'medium' : 'low';
                risk = { level, score, reasons };
            }

            // Preferred axis (direction) - preference only (sorting boost)
            let axisMeta = null;
            if (Number.isFinite(axisBearing) && Number.isFinite(pLat) && Number.isFinite(pLng)) {
                const dLat = r.dropoff_lat !== undefined && r.dropoff_lat !== null ? Number(r.dropoff_lat) : null;
                const dLng = r.dropoff_lng !== undefined && r.dropoff_lng !== null ? Number(r.dropoff_lng) : null;
                const br = bearingDeg(pLat, pLng, dLat, dLng);
                const diff = angleDiffDeg(br, axisBearing);
                if (Number.isFinite(br) && Number.isFinite(diff)) {
                    axisMeta = {
                        preferred_bearing_deg: axisBearing,
                        tolerance_deg: axisTolerance,
                        trip_bearing_deg: Math.round(br * 10) / 10,
                        diff_deg: Math.round(diff * 10) / 10,
                        aligned: diff <= axisTolerance
                    };
                }
            }

            enriched.push({
                ...r,
                is_favorite: favSet.has(String(r.user_id)) ? true : false,
                captain_profitability: profitability,
                captain_risk: risk,
                captain_go_home: goHomeMeta,
                captain_axis: axisMeta,
                passenger_cancel_rate_30d: cancelRate
            });
        }

        enriched.sort((a, b) => {
            const favA = a.is_favorite ? 1 : 0;
            const favB = b.is_favorite ? 1 : 0;
            if (favA !== favB) return favB - favA;
            const ghA = a.captain_go_home?.dropoff_to_home_km;
            const ghB = b.captain_go_home?.dropoff_to_home_km;
            if (goHomeEnabled && Number.isFinite(ghA) && Number.isFinite(ghB) && ghA !== ghB) return ghA - ghB;

            const axA = a.captain_axis;
            const axB = b.captain_axis;
            const alA = axA && axA.aligned ? 1 : 0;
            const alB = axB && axB.aligned ? 1 : 0;
            if (alA !== alB) return alB - alA;
            const diffA = safeNumber(axA?.diff_deg);
            const diffB = safeNumber(axB?.diff_deg);
            if (Number.isFinite(diffA) && Number.isFinite(diffB) && diffA !== diffB) return diffA - diffB;

            const dA = safeNumber(a.distance_km);
            const dB = safeNumber(b.distance_km);
            if (Number.isFinite(dA) && Number.isFinite(dB) && dA !== dB) return dA - dB;
            return new Date(a.created_at).getTime() - new Date(b.created_at).getTime();
        });

        res.json({
            success: true,
            count: enriched.length,
            data: enriched
        });
    } catch (err) {
        console.error('Error fetching driver pending rides:', err);
        res.status(500).json({ success: false, error: err.message });
    }
});

// Cleanup expired ride requests (can be called periodically)
app.post('/api/pending-rides/cleanup', requireRole('admin'), async (req, res) => {
    try {
        const result = await pool.query(`
            UPDATE pending_ride_requests
            SET status = 'expired',
                updated_at = CURRENT_TIMESTAMP
            WHERE status = 'waiting'
                AND expires_at < CURRENT_TIMESTAMP
            RETURNING request_id
        `);

        res.json({
            success: true,
            message: `تم تحديث ${result.rows.length} طلب منتهي الصلاحية`,
            expired_count: result.rows.length,
            expired_requests: result.rows
        });
    } catch (err) {
        console.error('Error cleaning up expired rides:', err);
        res.status(500).json({ success: false, error: err.message });
    }
});

function startGuardianCron() {
    const disabled = String(process.env.DISABLE_GUARDIAN_CRON || '').toLowerCase() === 'true';
    const env = String(process.env.NODE_ENV || '').toLowerCase();
    if (disabled) return;
    if (env === 'test') return;

    try {
        cron.schedule('* * * * *', async () => {
            try {
                const result = await processGuardianCheckins({ limit: 50, triggeredBy: 'cron' });
                if (!result?.ok) {
                    console.error('⚠️  Guardian cron failed:', result?.error || 'unknown');
                }
            } catch (e) {
                console.error('⚠️  Guardian cron error:', e.message);
            }
        });
        console.log('⏱️  Guardian cron enabled (every 1 minute)');
    } catch (e) {
        console.error('⚠️  Guardian cron setup failed:', e.message);
    }
}

// Start server
ensureCoreSchema()
    .then(() => ensureDefaultAdmins())
    .then(() => ensureDefaultOffers())
    .then(() => ensureWalletTables())
    .then(() => ensureUserProfileColumns())
    .then(() => ensureTripRatingColumns())
    .then(() => ensureTripTimeColumns())
    .then(() => ensureTripStatusColumn())
    .then(() => ensureTripsRequiredColumns())
    .then(() => ensureTripSourceColumn())
    .then(() => ensurePickupMetaColumns())
    .then(() => ensurePendingRideColumns())
    .then(() => ensureDriverLocationColumns())
    .then(() => ensureAdminTripCountersTables())
    .then(() => ensurePassengerFeatureTables())
    .then(() => ensureCaptainFeatureTables())
    .then(() => {
        console.log('🔄 Initializing Driver Sync System...');
        return driverSync.initializeSyncSystem();
    })
    .then(() => {
        console.log('✅ Driver Sync System initialized');
    })
    .catch(err => {
        console.error('⚠️  Warning: Driver Sync System initialization failed:', err.message);
        console.log('⏭️  Server will continue without sync system');
    })
    .finally(() => {
        httpServer.listen(PORT, () => {
            console.log(`🚀 Server running on port ${PORT}`);
            console.log(`📍 API available at http://localhost:${PORT}/api`);
            startGuardianCron();
        });
    });
