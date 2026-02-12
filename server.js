const express = require('express');
const cors = require('cors');
const pool = require('./db');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
require('dotenv').config();

// Import driver sync system
const driverSync = require('./driver-sync-system');

const app = express();
const PORT = process.env.PORT || 3000;

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
            const existing = await pool.query('SELECT id FROM users WHERE email = $1', [admin.email]);
            if (existing.rows.length > 0) continue;

            await pool.query(
                `INSERT INTO users (phone, name, email, password, role)
                 VALUES ($1, $2, $3, $4, $5)`,
                [admin.phone, admin.name, admin.email, admin.password, admin.role]
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

async function ensureTripSourceColumn() {
    try {
        await pool.query(`ALTER TABLE trips ADD COLUMN IF NOT EXISTS source VARCHAR(40);`);
        console.log('✅ Trip source column ensured');
    } catch (err) {
        console.error('❌ Failed to ensure trip source column:', err.message);
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
app.get('/api/trips', async (req, res) => {
    try {
        const { status, user_id, source, limit = 50, offset = 0 } = req.query;
        
        let query = 'SELECT * FROM trips WHERE 1=1';
        const params = [];
        let paramCount = 0;
        
        if (status && status !== 'all') {
            paramCount++;
            query += ` AND status = $${paramCount}`;
            params.push(status);
        }
        
        if (user_id) {
            paramCount++;
            query += ` AND user_id = $${paramCount}`;
            params.push(user_id);
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
        
        if (user_id) {
            countParamIndex++;
            countQuery += ` AND user_id = $${countParamIndex}`;
            countParams.push(user_id);
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
app.get('/api/trips/completed', async (req, res) => {
    try {
        const { user_id, source, limit = 50, offset = 0 } = req.query;
        
        let query = `
            SELECT * FROM trips 
            WHERE status = 'completed'
        `;
        const params = [];
        
        if (user_id) {
            query += ' AND user_id = $1';
            params.push(user_id);
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

// Get cancelled trips
app.get('/api/trips/cancelled', async (req, res) => {
    try {
        const { user_id, source, limit = 50, offset = 0 } = req.query;
        
        let query = `
            SELECT * FROM trips 
            WHERE status = 'cancelled'
        `;
        const params = [];
        
        if (user_id) {
            query += ' AND user_id = $1';
            params.push(user_id);
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
app.get('/api/trips/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const result = await pool.query('SELECT * FROM trips WHERE id = $1', [id]);
        
        if (result.rows.length === 0) {
            return res.status(404).json({ success: false, error: 'Trip not found' });
        }
        
        res.json({
            success: true,
            data: result.rows[0]
        });
    } catch (err) {
        console.error('Error fetching trip:', err);
        res.status(500).json({ success: false, error: err.message });
    }
});

// Create new trip
app.post('/api/trips', async (req, res) => {
    try {
        const {
            id,
            user_id,
            driver_id,
            pickup_location,
            dropoff_location,
            pickup_lat,
            pickup_lng,
            dropoff_lat,
            dropoff_lng,
            car_type = 'economy',
            cost,
            distance,
            duration,
            payment_method = 'cash',
            status = 'pending',
            driver_name,
            source = 'passenger_app'
        } = req.body;

        // Validation: Require core trip fields
        if (!user_id || !pickup_location || !dropoff_location || cost === undefined || cost === null || isNaN(cost)) {
            return res.status(400).json({
                success: false,
                error: 'Missing or invalid required fields.'
            });
        }

        const pickupLat = pickup_lat !== undefined && pickup_lat !== null ? Number(pickup_lat) : null;
        const pickupLng = pickup_lng !== undefined && pickup_lng !== null ? Number(pickup_lng) : null;
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

        const tripId = id || 'TR-' + Date.now();

        const result = await pool.query(`
            INSERT INTO trips (
                id, user_id, driver_id, pickup_location, dropoff_location,
                pickup_lat, pickup_lng, dropoff_lat, dropoff_lng,
                car_type, cost, distance, duration, payment_method, status, driver_name, source
            ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17)
            RETURNING *
        `, [
            tripId, user_id, driver_id, pickup_location, dropoff_location,
            pickupLat, pickupLng, dropoffLat, dropoffLng,
            car_type, cost, distance, duration, payment_method, status, driver_name, source
        ]);

        res.status(201).json({
            success: true,
            data: result.rows[0]
        });
    } catch (err) {
        console.error('Error creating trip:', err);
        res.status(500).json({ success: false, error: err.message });
    }
});

// Update trip status
app.patch('/api/trips/:id/status', async (req, res) => {
    try {
        const { id } = req.params;
        const {
            status,
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

        const effectivePassengerRating = passenger_rating !== undefined ? passenger_rating : rating;
        const effectivePassengerReview = passenger_review !== undefined ? passenger_review : review;
        
        let query = 'UPDATE trips SET status = $1, updated_at = CURRENT_TIMESTAMP';
        const params = [status];
        let paramCount = 1;
        
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
        }

        if (distance !== undefined) {
            paramCount++;
            query += `, distance = $${paramCount}`;
            params.push(distance);
        }

        if (duration !== undefined) {
            paramCount++;
            query += `, duration = $${paramCount}`;
            params.push(duration);
        } else if (status === 'completed') {
            query += `, duration = COALESCE(duration, GREATEST(1, ROUND(EXTRACT(EPOCH FROM (CURRENT_TIMESTAMP - COALESCE(started_at, created_at))) / 60)))`;
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
        
        // Update driver earnings if trip completed
        if (status === 'completed' && result.rows[0].driver_id && cost) {
            try {
                const driverId = result.rows[0].driver_id;
                const tripCost = parseFloat(cost);
                
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
            } catch (driverErr) {
                console.error('Error updating driver earnings:', driverErr);
            }
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

// Get next pending trip (optionally by car type)
app.get('/api/trips/pending/next', async (req, res) => {
    try {
        const { car_type, driver_id, lat, lng } = req.query;

        let driverLat = null;
        let driverLng = null;

        const latVal = lat !== undefined && lat !== null ? Number(lat) : null;
        const lngVal = lng !== undefined && lng !== null ? Number(lng) : null;

        if (Number.isFinite(latVal) && Number.isFinite(lngVal)) {
            driverLat = latVal;
            driverLng = lngVal;
        } else if (driver_id) {
            const driverResult = await pool.query(
                `SELECT last_lat, last_lng
                 FROM drivers
                 WHERE id = $1`,
                [driver_id]
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
            return res.status(400).json({
                success: false,
                error: 'Driver location required to find nearest trips.'
            });
        }

        const params = [driverLat, driverLng];
        const distanceSelect = `,
            (6371 * acos(
                cos(radians($1)) * cos(radians(t.pickup_lat)) * cos(radians(t.pickup_lng) - radians($2)) +
                sin(radians($1)) * sin(radians(t.pickup_lat))
            )) AS distance_km
        `;
        let orderClause = ' ORDER BY distance_km ASC, t.created_at ASC';

        let query = `
            SELECT t.*, u.name AS passenger_name, u.phone AS passenger_phone${distanceSelect}
            FROM trips t
            LEFT JOIN users u ON t.user_id = u.id
            WHERE t.status = 'pending' AND (t.driver_id IS NULL)
        `;

        query += " AND t.pickup_lat IS NOT NULL AND t.pickup_lng IS NOT NULL";
        query += " AND t.source = 'passenger_app'";

        if (car_type) {
            params.push(car_type);
            query += ` AND t.car_type = $${params.length}`;
        }

        query += `${orderClause} LIMIT 1`;

        const result = await pool.query(query, params);

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
app.patch('/api/trips/:id/assign', async (req, res) => {
    try {
        const { id } = req.params;
        const { driver_id, driver_name } = req.body;

        if (!driver_id) {
            return res.status(400).json({ success: false, error: 'driver_id is required' });
        }

        const result = await pool.query(
            `UPDATE trips
             SET driver_id = $1, driver_name = $2, status = 'assigned', updated_at = CURRENT_TIMESTAMP
             WHERE id = $3 AND status = 'pending'
             RETURNING *`,
            [driver_id, driver_name || null, id]
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
app.patch('/api/trips/:id/reject', async (req, res) => {
    try {
        const { id } = req.params;

        const result = await pool.query(
            `UPDATE trips
             SET status = 'cancelled', cancelled_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
             WHERE id = $1 AND status = 'pending'
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
app.get('/api/trips/stats/summary', async (req, res) => {
    try {
        const { user_id, source } = req.query;
        
        let whereClause = '';
        const params = [];
        
        if (user_id) {
            whereClause = 'WHERE user_id = $1';
            params.push(user_id);
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
app.get('/api/admin/dashboard/stats', async (req, res) => {
    try {
        // Get today's date range (start and end of day)
        const today = new Date();
        today.setHours(0, 0, 0, 0);
        const tomorrow = new Date(today);
        tomorrow.setDate(tomorrow.getDate() + 1);
        
        // Get ALL trips count from database (not just today)
        const todayTripsResult = await pool.query(`
            SELECT COUNT(*) as count
            FROM trips
            WHERE source = 'passenger_app'
        `);
        
        // Get ALL drivers count from database (not just online)
        const activeDriversResult = await pool.query(`
            SELECT COUNT(*) as count
            FROM drivers
        `);
        
        // Get passengers count (users with role 'passenger', 'user' or NULL)
        const passengersResult = await pool.query(`
            SELECT COUNT(*) as count
            FROM users
            WHERE role = 'passenger' OR role = 'user' OR role IS NULL
        `);
        
        // Get total earnings (completed trips)
        const earningsResult = await pool.query(`
            SELECT COALESCE(SUM(cost), 0) as total
            FROM trips
            WHERE status = 'completed' AND source = 'passenger_app'
        `);
        
        // Get average rating
        const ratingResult = await pool.query(`
            SELECT COALESCE(AVG(COALESCE(passenger_rating, rating)), 0) as avg_rating
            FROM trips
            WHERE status = 'completed'
              AND source = 'passenger_app'
              AND COALESCE(passenger_rating, rating) IS NOT NULL
        `);
        
        res.json({
            success: true,
            data: {
                today_trips: parseInt(todayTripsResult.rows[0].count),
                active_drivers: parseInt(activeDriversResult.rows[0].count),
                total_passengers: parseInt(passengersResult.rows[0].count),
                total_earnings: parseFloat(earningsResult.rows[0].total),
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
app.get('/api/drivers', async (req, res) => {
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
app.patch('/api/drivers/:id/location', async (req, res) => {
    try {
        const { id } = req.params;
        const { lat, lng } = req.body;

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
app.get('/api/drivers/:id/location', async (req, res) => {
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
app.get('/api/drivers/nearest', async (req, res) => {
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
               ${carFilter}
             ORDER BY distance_km ASC
             LIMIT 1`,
            params
        );

        res.json({ success: true, data: result.rows[0] || null });
    } catch (err) {
        console.error('Error fetching nearest driver:', err);
        res.status(500).json({ success: false, error: err.message });
    }
});

// Resolve driver profile by email or phone
app.get('/api/drivers/resolve', async (req, res) => {
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
        `, [name, phone, email, password, car_type || 'economy', car_plate || '',
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
app.get('/api/drivers/pending', async (req, res) => {
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
app.patch('/api/drivers/:id/approval', async (req, res) => {
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
            await pool.query(`
                INSERT INTO users (phone, name, email, password, role)
                VALUES ($1, $2, $3, $4, 'driver')
                ON CONFLICT (phone) DO UPDATE 
                SET role = 'driver', email = $3, name = $2
            `, [driver.phone, driver.name, driver.email, driver.password]);
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
app.get('/api/drivers/:id/stats', async (req, res) => {
    try {
        const { id } = req.params;
        
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
app.get('/api/drivers/:id/earnings', async (req, res) => {
    try {
        const { id } = req.params;
        const { days = 30 } = req.query;
        
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
app.put('/api/drivers/:id/earnings/update', async (req, res) => {
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
app.put('/api/drivers/:id/update', async (req, res) => {
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
app.get('/api/users', async (req, res) => {
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
app.get('/api/users/:id', async (req, res) => {
    try {
        const { id } = req.params;

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
app.put('/api/users/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const { phone, name, email, password, car_type, car_plate, balance, points, rating, status, avatar } = req.body;

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
            paramCount++;
            updates.push(`password = $${paramCount}`);
            params.push(String(password).trim());
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
app.get('/api/passengers', async (req, res) => {
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
app.get('/api/passengers/:id', async (req, res) => {
    try {
        const { id } = req.params;

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
app.post('/api/passengers', async (req, res) => {
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
            [normalizedPhone, normalizedName, normalizedEmail, normalizedPassword]
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
app.put('/api/passengers/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const { phone, name, email, password, car_type, car_plate, balance, points, rating, status, avatar } = req.body;

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
            paramCount++;
            updates.push(`password = $${paramCount}`);
            params.push(String(password).trim());
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
app.delete('/api/passengers/:id', async (req, res) => {
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
app.get('/api/passengers/:id/trips', async (req, res) => {
    try {
        const { id } = req.params;
        const { status, limit = 50, offset = 0 } = req.query;

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
        
        // Check if user exists with email and password
        const result = await pool.query(
            'SELECT id, phone, name, email, role, created_at FROM users WHERE email = $1 AND password = $2',
            [trimmedEmail, trimmedPassword]
        );
        
        if (result.rows.length === 0) {
            const emailCheck = await pool.query('SELECT id, role FROM users WHERE email = $1', [trimmedEmail]);
            if (emailCheck.rows.length > 0) {
                return res.status(401).json({ 
                    success: false, 
                    error: 'Invalid email or password' 
                });
            }

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

                let createdUser = null;
                for (let attempt = 0; attempt < 3; attempt++) {
                    const guestPhone = buildGuestPhone();
                    const insert = await pool.query(
                        `INSERT INTO users (phone, name, email, password, role)
                         VALUES ($1, $2, $3, $4, 'passenger')
                         ON CONFLICT (phone) DO NOTHING
                         RETURNING id, phone, name, email, role, created_at`,
                        [guestPhone, baseName, trimmedEmail, trimmedPassword]
                    );
                    if (insert.rows.length > 0) {
                        createdUser = insert.rows[0];
                        break;
                    }
                }

                if (!createdUser) {
                    return res.status(500).json({
                        success: false,
                        error: 'Failed to create passenger account'
                    });
                }

                return res.json({
                    success: true,
                    data: createdUser,
                    created: true
                });
            }

            return res.status(401).json({ 
                success: false, 
                error: 'Invalid email or password' 
            });
        }
        
        res.json({
            success: true,
            data: result.rows[0]
        });
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
        let result = await pool.query('SELECT * FROM users WHERE phone = ANY($1)', [phoneCandidates]);
        
        if (result.rows.length === 0) {
            // Create new user
            result = await pool.query(`
                INSERT INTO users (phone, name, email, password, role)
                VALUES ($1, $2, $3, '12345678', 'passenger')
                RETURNING *
            `, [normalizedPhone, normalizedName, normalizedEmail]);
        }
        
        res.json({
            success: true,
            data: result.rows[0]
        });
    } catch (err) {
        console.error('Error logging in user:', err);
        res.status(500).json({ success: false, error: err.message });
    }
});

// Start server
ensureDefaultAdmins()
    .then(() => ensureDefaultOffers())
    .then(() => ensureUserProfileColumns())
    .then(() => ensureTripRatingColumns())
    .then(() => ensureTripTimeColumns())
    .then(() => ensureTripSourceColumn())
    .then(() => ensureDriverLocationColumns())
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
        app.listen(PORT, () => {
            console.log(`🚀 Server running on port ${PORT}`);
            console.log(`📍 API available at http://localhost:${PORT}/api`);
        });
    });
