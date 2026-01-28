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

// Health check
app.get('/api/health', (req, res) => {
    res.json({ status: 'OK', message: 'Server is running' });
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
app.listen(PORT, () => {
    console.log(`🚀 Server running on port ${PORT}`);
    console.log(`📍 API available at http://localhost:${PORT}/api`);
});
