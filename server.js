const express = require('express');
const cors = require('cors');
const pool = require('./db');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
require('dotenv').config();

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
                ('DOUBLEPTS', '⭐ نقاط مضاعفة', 'اكسب ضعف النقاط على الرحلات المكتملة في عطلة نهاية الأسبوع.', 'نقاط', 'percent', 0, true)
        `);
        console.log('✅ Default offers inserted');
    } catch (err) {
        console.error('❌ Failed to ensure default offers:', err.message);
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
        const { status, user_id, limit = 50, offset = 0 } = req.query;
        
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
        const { user_id, limit = 50, offset = 0 } = req.query;
        
        let query = `
            SELECT * FROM trips 
            WHERE status = 'completed'
        `;
        const params = [];
        
        if (user_id) {
            query += ' AND user_id = $1';
            params.push(user_id);
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
        const { user_id, limit = 50, offset = 0 } = req.query;
        
        let query = `
            SELECT * FROM trips 
            WHERE status = 'cancelled'
        `;
        const params = [];
        
        if (user_id) {
            query += ' AND user_id = $1';
            params.push(user_id);
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
            user_id = 1,
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
            driver_name
        } = req.body;
        
        const tripId = id || 'TR-' + Date.now();
        
        const result = await pool.query(`
            INSERT INTO trips (
                id, user_id, driver_id, pickup_location, dropoff_location,
                pickup_lat, pickup_lng, dropoff_lat, dropoff_lng,
                car_type, cost, distance, duration, payment_method, status, driver_name
            ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)
            RETURNING *
        `, [
            tripId, user_id, driver_id, pickup_location, dropoff_location,
            pickup_lat, pickup_lng, dropoff_lat, dropoff_lng,
            car_type, cost, distance, duration, payment_method, status, driver_name
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
        const { status, rating, review } = req.body;
        
        let query = 'UPDATE trips SET status = $1, updated_at = CURRENT_TIMESTAMP';
        const params = [status];
        let paramCount = 1;
        
        if (status === 'completed') {
            query += ', completed_at = CURRENT_TIMESTAMP';
        } else if (status === 'cancelled') {
            query += ', cancelled_at = CURRENT_TIMESTAMP';
        }
        
        if (rating !== undefined) {
            paramCount++;
            query += `, rating = $${paramCount}`;
            params.push(rating);
        }
        
        if (review) {
            paramCount++;
            query += `, review = $${paramCount}`;
            params.push(review);
        }
        
        paramCount++;
        query += ` WHERE id = $${paramCount} RETURNING *`;
        params.push(id);
        
        const result = await pool.query(query, params);
        
        if (result.rows.length === 0) {
            return res.status(404).json({ success: false, error: 'Trip not found' });
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
        const { car_type, auto_demo } = req.query;

        let query = `
            SELECT t.*, u.name AS passenger_name, u.phone AS passenger_phone
            FROM trips t
            LEFT JOIN users u ON t.user_id = u.id
            WHERE t.status = 'pending' AND (t.driver_id IS NULL)
        `;
        const params = [];

        if (car_type) {
            params.push(car_type);
            query += ` AND t.car_type = $${params.length}`;
        }

        query += ' ORDER BY t.created_at ASC LIMIT 1';

        const result = await pool.query(query, params);

        if (result.rows.length === 0 && String(auto_demo) === '1') {
            const demoId = `TR-${Date.now()}`;
            const demoCarType = car_type || 'economy';
            const demoTrips = [
                {
                    pickup: 'شارع طلعت حرب، القاهرة',
                    dropoff: 'ميدان التحرير، القاهرة',
                    pickup_lat: 30.0522,
                    pickup_lng: 31.2437,
                    dropoff_lat: 30.0444,
                    dropoff_lng: 31.2357,
                    cost: 38.5,
                    distance: 6.4,
                    duration: 14
                },
                {
                    pickup: 'مدينة نصر، القاهرة',
                    dropoff: 'العباسية، القاهرة',
                    pickup_lat: 30.0561,
                    pickup_lng: 31.3301,
                    dropoff_lat: 30.0664,
                    dropoff_lng: 31.2775,
                    cost: 42.0,
                    distance: 7.9,
                    duration: 18
                },
                {
                    pickup: 'المعادي، القاهرة',
                    dropoff: 'كورنيش المعادي',
                    pickup_lat: 29.9602,
                    pickup_lng: 31.2569,
                    dropoff_lat: 29.9506,
                    dropoff_lng: 31.2623,
                    cost: 26.0,
                    distance: 4.1,
                    duration: 10
                }
            ];
            const demo = demoTrips[Math.floor(Math.random() * demoTrips.length)];

            const insert = await pool.query(
                `INSERT INTO trips (
                    id, user_id, driver_id, pickup_location, dropoff_location,
                    pickup_lat, pickup_lng, dropoff_lat, dropoff_lng,
                    car_type, cost, distance, duration, payment_method, status
                ) VALUES ($1, $2, NULL, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, 'cash', 'pending')
                RETURNING *`,
                [
                    demoId,
                    1,
                    demo.pickup,
                    demo.dropoff,
                    demo.pickup_lat,
                    demo.pickup_lng,
                    demo.dropoff_lat,
                    demo.dropoff_lng,
                    demoCarType,
                    demo.cost,
                    demo.distance,
                    demo.duration
                ]
            );

            const demoTrip = insert.rows[0];
            const passenger = await pool.query('SELECT name, phone FROM users WHERE id = $1', [demoTrip.user_id]);
            const passengerRow = passenger.rows[0] || {};

            return res.json({
                success: true,
                data: {
                    ...demoTrip,
                    passenger_name: passengerRow.name || 'راكب جديد',
                    passenger_phone: passengerRow.phone || null
                }
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
        const { user_id } = req.query;
        
        let whereClause = '';
        const params = [];
        
        if (user_id) {
            whereClause = 'WHERE user_id = $1';
            params.push(user_id);
        }
        
        const result = await pool.query(`
            SELECT 
                COUNT(*) as total_trips,
                COUNT(*) FILTER (WHERE status = 'completed') as completed_trips,
                COUNT(*) FILTER (WHERE status = 'cancelled') as cancelled_trips,
                COALESCE(SUM(cost) FILTER (WHERE status = 'completed'), 0) as total_spent,
                COALESCE(AVG(rating) FILTER (WHERE status = 'completed' AND rating IS NOT NULL), 0) as avg_rating,
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
            WHERE status = 'completed'
        `);
        
        // Get average rating
        const ratingResult = await pool.query(`
            SELECT COALESCE(AVG(rating), 0) as avg_rating
            FROM trips
            WHERE status = 'completed' AND rating IS NOT NULL
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
        const { status = 'online' } = req.query;
        
        const result = await pool.query(
            'SELECT * FROM drivers WHERE status = $1 ORDER BY rating DESC',
            [status]
        );
        
        res.json({
            success: true,
            data: result.rows
        });
    } catch (err) {
        console.error('Error fetching drivers:', err);
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

// ==================== USERS ENDPOINTS ====================

// Get users with optional filtering
app.get('/api/users', async (req, res) => {
    try {
        const { role, limit = 50, offset = 0 } = req.query;

        let query = 'SELECT id, phone, name, email, role, created_at FROM users WHERE 1=1';
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

        const normalizedPhone = String(phone).trim();
        const normalizedEmail = email && String(email).trim() ? String(email).trim().toLowerCase() : `passenger_${normalizedPhone.replace(/\D/g, '') || Date.now()}@ubar.sa`;
        const normalizedName = name && String(name).trim() ? String(name).trim() : 'راكب جديد';
        
        // Check if user exists
        let result = await pool.query('SELECT * FROM users WHERE phone = $1', [normalizedPhone]);
        
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
    .finally(() => {
        app.listen(PORT, () => {
            console.log(`🚀 Server running on port ${PORT}`);
            console.log(`📍 API available at http://localhost:${PORT}/api`);
        });
    });
