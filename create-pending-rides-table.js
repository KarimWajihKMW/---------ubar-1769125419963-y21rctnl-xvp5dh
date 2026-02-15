const pool = require('./db');

async function createPendingRidesTable() {
    const client = await pool.connect();
    
    try {
        console.log('📊 Creating pending_ride_requests table...');
        
        // Create pending_ride_requests table
        await client.query(`
            CREATE TABLE IF NOT EXISTS pending_ride_requests (
                id SERIAL PRIMARY KEY,
                request_id VARCHAR(50) UNIQUE NOT NULL,
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
        console.log('✅ pending_ride_requests table created');
        
        // Create indexes for better performance
        await client.query(`
            CREATE INDEX IF NOT EXISTS idx_pending_rides_status 
            ON pending_ride_requests(status);
        `);
        await client.query(`
            CREATE INDEX IF NOT EXISTS idx_pending_rides_user_id 
            ON pending_ride_requests(user_id);
        `);
        await client.query(`
            CREATE INDEX IF NOT EXISTS idx_pending_rides_created_at 
            ON pending_ride_requests(created_at DESC);
        `);
        await client.query(`
            CREATE INDEX IF NOT EXISTS idx_pending_rides_pickup_coords 
            ON pending_ride_requests(pickup_lat, pickup_lng);
        `);
        await client.query(`
            CREATE INDEX IF NOT EXISTS idx_pending_rides_expires_at 
            ON pending_ride_requests(expires_at);
        `);
        console.log('✅ Indexes created');
        
        // Insert sample pending ride requests
        const sampleRequests = [
            {
                request_id: `REQ-${Date.now()}-1`,
                user_id: 1,
                passenger_name: 'عبدالعزيز أحمد',
                passenger_phone: '0551234567',
                pickup_location: 'شارع الملك فهد، الرياض',
                dropoff_location: 'حي العليا، الرياض',
                pickup_lat: 24.7136,
                pickup_lng: 46.6753,
                dropoff_lat: 24.7418,
                dropoff_lng: 46.6767,
                car_type: 'economy',
                estimated_cost: 35.00,
                estimated_distance: 8.5,
                estimated_duration: 15,
                payment_method: 'cash',
                status: 'waiting',
                expires_at: new Date(Date.now() + 20 * 60 * 1000) // expires in 20 minutes
            },
            {
                request_id: `REQ-${Date.now()}-2`,
                user_id: 2,
                passenger_name: 'نورة محمد',
                passenger_phone: '0552345678',
                pickup_location: 'مطار الملك خالد الدولي',
                dropoff_location: 'مجمع العرب مول، جدة',
                pickup_lat: 24.9576,
                pickup_lng: 46.6988,
                dropoff_lat: 21.6258,
                dropoff_lng: 39.1567,
                car_type: 'family',
                estimated_cost: 125.00,
                estimated_distance: 45.2,
                estimated_duration: 55,
                payment_method: 'card',
                status: 'waiting',
                expires_at: new Date(Date.now() + 15 * 60 * 1000)
            },
            {
                request_id: `REQ-${Date.now()}-3`,
                user_id: 3,
                passenger_name: 'فاطمة سعيد',
                passenger_phone: '0553456789',
                pickup_location: 'برج المملكة، الرياض',
                dropoff_location: 'الدرعية التاريخية',
                pickup_lat: 24.7110,
                pickup_lng: 46.6750,
                dropoff_lat: 24.7347,
                dropoff_lng: 46.5767,
                car_type: 'luxury',
                estimated_cost: 85.00,
                estimated_distance: 22.8,
                estimated_duration: 30,
                payment_method: 'cash',
                status: 'waiting',
                rejected_by: [3, 5], // rejected by driver IDs 3 and 5
                rejection_count: 2,
                expires_at: new Date(Date.now() + 10 * 60 * 1000)
            }
        ];
        
        for (const req of sampleRequests) {
            await client.query(`
                INSERT INTO pending_ride_requests (
                    request_id, user_id, passenger_name, passenger_phone,
                    pickup_location, dropoff_location, 
                    pickup_lat, pickup_lng, dropoff_lat, dropoff_lng,
                    car_type, estimated_cost, estimated_distance, estimated_duration,
                    payment_method, status, rejected_by, rejection_count, expires_at
                )
                VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19)
                ON CONFLICT (request_id) DO NOTHING
            `, [
                req.request_id, req.user_id, req.passenger_name, req.passenger_phone,
                req.pickup_location, req.dropoff_location,
                req.pickup_lat, req.pickup_lng, req.dropoff_lat, req.dropoff_lng,
                req.car_type, req.estimated_cost, req.estimated_distance, req.estimated_duration,
                req.payment_method, req.status, req.rejected_by || [], req.rejection_count || 0,
                req.expires_at
            ]);
        }
        console.log('✅ Sample pending ride requests inserted');
        
        // Display current pending requests
        const result = await client.query(`
            SELECT 
                request_id,
                passenger_name,
                pickup_location,
                dropoff_location,
                car_type,
                estimated_cost,
                status,
                rejection_count,
                TO_CHAR(created_at, 'YYYY-MM-DD HH24:MI:SS') as created_at,
                TO_CHAR(expires_at, 'YYYY-MM-DD HH24:MI:SS') as expires_at
            FROM pending_ride_requests
            WHERE status = 'waiting'
            ORDER BY created_at DESC
        `);
        
        console.log('\n📋 Current pending ride requests:');
        console.table(result.rows);
        
        console.log('\n✅ Setup completed successfully!');
        
    } catch (error) {
        console.error('❌ Error creating table:', error);
        throw error;
    } finally {
        client.release();
        await pool.end();
    }
}

// Run if executed directly
if (require.main === module) {
    createPendingRidesTable()
        .then(() => process.exit(0))
        .catch(err => {
            console.error(err);
            process.exit(1);
        });
}

module.exports = createPendingRidesTable;
