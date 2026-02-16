const express = require('express');
const cors = require('cors');
const pool = require('./db');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const http = require('http');
const { Server: SocketIOServer } = require('socket.io');
require('dotenv').config();

const {
    looksLikeBcryptHash,
    hashPassword,
    verifyPassword,
    signAccessToken,
    authMiddleware,
    requireAuth,
    requireRole
} = require('./auth');

// Import driver sync system
const driverSync = require('./driver-sync-system');

const app = express();
const PORT = process.env.PORT || 3000;
const DRIVER_LOCATION_TTL_MINUTES = 5;
const MAX_ASSIGN_DISTANCE_KM = 30;
const PENDING_TRIP_TTL_MINUTES = 20;
const ASSIGNED_TRIP_TTL_MINUTES = 120;
const AUTO_ASSIGN_TRIPS = false;

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

const lastTripDriverWriteAt = new Map();

io.on('connection', (socket) => {
    socket.on('subscribe_trip', (payload) => {
        const tripId = payload?.trip_id;
        if (!tripId) return;
        socket.join(tripRoom(tripId));
        socket.emit('subscribed_trip', { trip_id: String(tripId) });
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
                starts_at TIMESTAMP,
                ends_at TIMESTAMP,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
        `);
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

async function findNearestAvailableDriver({ pickupLat, pickupLng, carType }) {
    if (!Number.isFinite(pickupLat) || !Number.isFinite(pickupLng)) return null;

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

        res.json({ success: true, data: result.rows[0] });
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
        const effectiveCost = price !== undefined && price !== null ? price : cost;

        // Validation: Require core trip fields
        if (!effectiveRiderId || !pickup_location || !dropoff_location || effectiveCost === undefined || effectiveCost === null || isNaN(effectiveCost)) {
            return res.status(400).json({
                success: false,
                error: 'Missing or invalid required fields.'
            });
        }

        const pickupLat = pickup_lat !== undefined && pickup_lat !== null ? Number(pickup_lat) : null;
        const pickupLng = pickup_lng !== undefined && pickup_lng !== null ? Number(pickup_lng) : null;
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

        const effectiveDistance = distance_km !== undefined && distance_km !== null ? distance_km : distance;
        const effectiveDuration = duration_minutes !== undefined && duration_minutes !== null ? duration_minutes : duration;

        const result = await pool.query(`
            INSERT INTO trips (
                id, user_id, rider_id, driver_id, pickup_location, dropoff_location,
                pickup_lat, pickup_lng, pickup_accuracy, pickup_timestamp, dropoff_lat, dropoff_lng,
                car_type,
                cost, price,
                distance, distance_km,
                duration, duration_minutes,
                payment_method, status, driver_name, source
            ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23)
            RETURNING *
        `, [
            tripId, effectiveRiderId, effectiveRiderId, driver_id, pickup_location, dropoff_location,
            pickupLat, pickupLng, pickupAccuracy, pickupTimestamp, dropoffLat, dropoffLng,
            car_type,
            effectiveCost, effectiveCost,
            effectiveDistance, effectiveDistance,
            effectiveDuration, effectiveDuration,
            payment_method, status, driver_name, source
        ]);

        let createdTrip = result.rows[0];

        // ✨ إضافة الطلب إلى جدول pending_ride_requests إذا كان في حالة pending
        if (createdTrip.status === 'pending' && !createdTrip.driver_id) {
            try {
                // الحصول على معلومات الراكب
                const userResult = await pool.query('SELECT name, phone FROM users WHERE id = $1', [effectiveRiderId]);
                const user = userResult.rows[0];
                
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
                    requestId, effectiveRiderId, user?.name || 'راكب', user?.phone || '',
                    pickup_location, dropoff_location,
                    pickupLat, pickupLng, pickupAccuracy, pickupTimestamp, dropoffLat, dropoffLng,
                    car_type, cost, distance, duration,
                    payment_method, expiresAt
                ]);

                console.log(`✅ تم إضافة الطلب ${requestId} إلى pending_ride_requests للرحلة ${tripId}`);
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
                    carType: createdTrip.car_type
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
                    user_id
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

        if (payment_method !== undefined) {
            paramCount++;
            query += `, payment_method = $${paramCount}`;
            params.push(payment_method);
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
            data: result.rows[0]
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

        res.json({ success: true, data: result.rows[0] });
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

        res.json({ success: true, data: result.rows[0] });
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
                d.name as assigned_driver_name,
                d.phone as assigned_driver_phone
            FROM pending_ride_requests pr
            LEFT JOIN users u ON pr.user_id = u.id
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
                `, [driver_id, driverName, tripId]);

                console.log(`✅ تم تحديث الرحلة ${tripId} بتعيين السائق ${effectiveDriverId}`);
            } else {
                // إنشاء رحلة جديدة إذا لم توجد
                const tripId = 'TR-' + Date.now();
                
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
            SELECT car_type, last_lat, last_lng, last_location_at
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

        if (!driver.last_lat || !driver.last_lng || !driver.last_location_at) {
            return res.json({
                success: true,
                count: 0,
                data: []
            });
        }

        const maxDistanceKm = Number.isFinite(Number(max_distance))
            ? Math.max(1, Math.min(Number(max_distance), 100))
            : MAX_ASSIGN_DISTANCE_KM;

        const queryBase = `
            SELECT
                pr.*,
                u.name as user_name,
                u.phone as user_phone,
                t.id as trip_ref,
                (6371 * acos(
                    cos(radians($2)) * cos(radians(pr.pickup_lat)) * cos(radians(pr.pickup_lng) - radians($3)) +
                    sin(radians($2)) * sin(radians(pr.pickup_lat))
                )) AS distance_km
            FROM pending_ride_requests pr
            LEFT JOIN users u ON pr.user_id = u.id
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

        res.json({
            success: true,
            count: result.rows.length,
            data: result.rows
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

// Start server
ensureDefaultAdmins()
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
        });
    });
