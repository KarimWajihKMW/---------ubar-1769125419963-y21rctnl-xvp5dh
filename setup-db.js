const pool = require('./db');

async function setupDatabase() {
    const client = await pool.connect();
    
    try {
        console.log('📊 Setting up database schema...');
        
        // Drop existing tables to start fresh
        console.log('🗑️ Dropping existing tables...');
        await client.query(`DROP TABLE IF EXISTS trips CASCADE;`);
        await client.query(`DROP TABLE IF EXISTS drivers CASCADE;`);
        await client.query(`DROP TABLE IF EXISTS users CASCADE;`);
        
        // Create users table
        await client.query(`
            CREATE TABLE users (
                id SERIAL PRIMARY KEY,
                phone VARCHAR(20) UNIQUE NOT NULL,
                name VARCHAR(100),
                email VARCHAR(100),
                role VARCHAR(20) DEFAULT 'passenger',
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
        `);
        console.log('✅ Users table created');
        
        // Create drivers table
        await client.query(`
            CREATE TABLE drivers (
                id SERIAL PRIMARY KEY,
                name VARCHAR(100) NOT NULL,
                phone VARCHAR(20) UNIQUE NOT NULL,
                car_type VARCHAR(50) DEFAULT 'economy',
                car_plate VARCHAR(20),
                rating DECIMAL(3, 2) DEFAULT 5.00,
                total_trips INTEGER DEFAULT 0,
                status VARCHAR(20) DEFAULT 'offline',
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
        `);
        console.log('✅ Drivers table created');
        
        // Create trips table with all necessary fields
        await client.query(`
            CREATE TABLE trips (
                id VARCHAR(50) PRIMARY KEY,
                user_id INTEGER REFERENCES users(id),
                driver_id INTEGER REFERENCES drivers(id),
                pickup_location VARCHAR(255) NOT NULL,
                dropoff_location VARCHAR(255) NOT NULL,
                pickup_lat DECIMAL(10, 8),
                pickup_lng DECIMAL(11, 8),
                dropoff_lat DECIMAL(10, 8),
                dropoff_lng DECIMAL(11, 8),
                car_type VARCHAR(50) DEFAULT 'economy',
                cost DECIMAL(10, 2) NOT NULL,
                distance DECIMAL(10, 2),
                duration INTEGER,
                payment_method VARCHAR(20) DEFAULT 'cash',
                status VARCHAR(20) DEFAULT 'pending',
                rating INTEGER,
                review TEXT,
                driver_name VARCHAR(100),
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                completed_at TIMESTAMP,
                cancelled_at TIMESTAMP
            );
        `);
        console.log('✅ Trips table created');
        
        // Create indexes for better performance
        try {
            await client.query(`CREATE INDEX IF NOT EXISTS idx_trips_user_id ON trips(user_id);`);
            await client.query(`CREATE INDEX IF NOT EXISTS idx_trips_status ON trips(status);`);
            await client.query(`CREATE INDEX IF NOT EXISTS idx_trips_created_at ON trips(created_at DESC);`);
            console.log('✅ Indexes created');
        } catch (err) {
            console.log('⚠️ Some indexes may already exist');
        }
        
        // Insert sample drivers
        await client.query(`
            INSERT INTO drivers (name, phone, car_type, car_plate, rating, total_trips, status)
            VALUES 
                ('أحمد محمد', '0501234567', 'economy', 'ABC 1234', 4.8, 150, 'online'),
                ('محمد علي', '0507654321', 'family', 'XYZ 5678', 4.9, 200, 'online'),
                ('خالد أحمد', '0509876543', 'luxury', 'LMN 9012', 4.7, 100, 'offline'),
                ('عمر يوسف', '0502345678', 'economy', 'PQR 3456', 4.6, 80, 'online')
            ON CONFLICT (phone) DO NOTHING;
        `);
        console.log('✅ Sample drivers inserted');
        
        // Insert sample user
        await client.query(`
            INSERT INTO users (phone, name, email, role)
            VALUES ('0500000000', 'مستخدم تجريبي', 'test@example.com', 'passenger')
            ON CONFLICT (phone) DO NOTHING;
        `);
        console.log('✅ Sample user inserted');
        
        // Insert sample trips (completed and cancelled)
        const sampleTrips = [
            {
                id: 'TR-' + Date.now() + '-1',
                user_id: 1,
                driver_id: 1,
                pickup_location: 'شارع الملك فهد، الرياض',
                dropoff_location: 'حي العليا، الرياض',
                car_type: 'economy',
                cost: 35.00,
                distance: 8.5,
                duration: 15,
                payment_method: 'cash',
                status: 'completed',
                rating: 5,
                driver_name: 'أحمد محمد',
                completed_at: new Date(Date.now() - 86400000) // 1 day ago
            },
            {
                id: 'TR-' + Date.now() + '-2',
                user_id: 1,
                driver_id: 2,
                pickup_location: 'مطار الملك خالد',
                dropoff_location: 'برج المملكة',
                car_type: 'family',
                cost: 85.00,
                distance: 35.0,
                duration: 30,
                payment_method: 'card',
                status: 'completed',
                rating: 4,
                driver_name: 'محمد علي',
                completed_at: new Date(Date.now() - 172800000) // 2 days ago
            },
            {
                id: 'TR-' + Date.now() + '-3',
                user_id: 1,
                driver_id: 3,
                pickup_location: 'حي النخيل',
                dropoff_location: 'الرياض بارك',
                car_type: 'luxury',
                cost: 125.00,
                distance: 22.0,
                duration: 25,
                payment_method: 'wallet',
                status: 'cancelled',
                driver_name: 'خالد أحمد',
                cancelled_at: new Date(Date.now() - 259200000) // 3 days ago
            },
            {
                id: 'TR-' + Date.now() + '-4',
                user_id: 1,
                driver_id: 4,
                pickup_location: 'الرياض غاليري',
                dropoff_location: 'النخيل مول',
                car_type: 'economy',
                cost: 28.00,
                distance: 6.5,
                duration: 12,
                payment_method: 'cash',
                status: 'completed',
                rating: 5,
                driver_name: 'عمر يوسف',
                completed_at: new Date(Date.now() - 345600000) // 4 days ago
            },
            {
                id: 'TR-' + Date.now() + '-5',
                user_id: 1,
                driver_id: 1,
                pickup_location: 'جامعة الملك سعود',
                dropoff_location: 'حي السفارات',
                car_type: 'economy',
                cost: 42.00,
                distance: 12.0,
                duration: 18,
                payment_method: 'card',
                status: 'cancelled',
                driver_name: 'أحمد محمد',
                cancelled_at: new Date(Date.now() - 432000000) // 5 days ago
            }
        ];
        
        for (const trip of sampleTrips) {
            await client.query(`
                INSERT INTO trips (id, user_id, driver_id, pickup_location, dropoff_location, 
                    car_type, cost, distance, duration, payment_method, status, rating, 
                    driver_name, created_at, completed_at, cancelled_at)
                VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)
                ON CONFLICT (id) DO NOTHING;
            `, [
                trip.id, trip.user_id, trip.driver_id, trip.pickup_location, 
                trip.dropoff_location, trip.car_type, trip.cost, trip.distance, 
                trip.duration, trip.payment_method, trip.status, trip.rating, 
                trip.driver_name, trip.completed_at || trip.cancelled_at || new Date(),
                trip.completed_at, trip.cancelled_at
            ]);
        }
        
        console.log('✅ Sample trips inserted');
        console.log('🎉 Database setup completed successfully!');
        
    } catch (err) {
        console.error('❌ Error setting up database:', err);
        throw err;
    } finally {
        client.release();
    }
}

// Run setup
setupDatabase()
    .then(() => {
        console.log('✅ Setup complete');
        process.exit(0);
    })
    .catch(err => {
        console.error('❌ Setup failed:', err);
        process.exit(1);
    });
