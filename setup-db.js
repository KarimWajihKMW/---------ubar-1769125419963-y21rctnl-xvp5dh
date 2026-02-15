const pool = require('./db');

async function setupDatabase() {
    const client = await pool.connect();
    
    try {
        console.log('📊 Setting up database schema...');
        
        // Drop existing tables to start fresh
        console.log('🗑️ Dropping existing tables...');
        await client.query(`DROP TABLE IF EXISTS pending_ride_requests CASCADE;`);
        await client.query(`DROP TABLE IF EXISTS driver_earnings CASCADE;`);
        await client.query(`DROP TABLE IF EXISTS offers CASCADE;`);
        await client.query(`DROP TABLE IF EXISTS trips CASCADE;`);
        await client.query(`DROP TABLE IF EXISTS drivers CASCADE;`);
        await client.query(`DROP TABLE IF EXISTS users CASCADE;`);

        // Drop enum types created by the app (optional)
        await client.query(`DROP TYPE IF EXISTS trip_status_enum CASCADE;`);

        // Create enum types required by schema
        await client.query(`
            DO $$
            BEGIN
                CREATE TYPE trip_status_enum AS ENUM ('pending', 'accepted', 'arrived', 'started', 'completed', 'rated');
            EXCEPTION
                WHEN duplicate_object THEN NULL;
            END $$;
        `);
        
        // Create users table
        await client.query(`
            CREATE TABLE users (
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
        console.log('✅ Users table created');
        
        // Create drivers table
        await client.query(`
            CREATE TABLE drivers (
                id SERIAL PRIMARY KEY,
                name VARCHAR(100) NOT NULL,
                phone VARCHAR(20) UNIQUE NOT NULL,
                email VARCHAR(100) UNIQUE,
                password VARCHAR(255),
                car_type VARCHAR(50) DEFAULT 'economy',
                car_plate VARCHAR(20),
                id_card_photo TEXT,
                drivers_license TEXT,
                vehicle_license TEXT,
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
        console.log('✅ Drivers table created');
        
        // Create driver_earnings table for daily earnings tracking
        await client.query(`
            CREATE TABLE driver_earnings (
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
        console.log('✅ Driver earnings table created');
        
        // Create offers table
        await client.query(`
            CREATE TABLE offers (
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
        console.log('✅ Offers table created');

        // Create trips table with all necessary fields
        await client.query(`
            CREATE TABLE trips (
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
        console.log('✅ Trips table created');

        // Create pending_ride_requests table (required by server pending rides flow)
        await client.query(`
            CREATE TABLE pending_ride_requests (
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
        console.log('✅ Pending ride requests table created');

        // Admin counters tables (daily/monthly)
        await client.query(`
            CREATE TABLE IF NOT EXISTS admin_daily_counters (
                day DATE PRIMARY KEY,
                daily_trips INTEGER NOT NULL DEFAULT 0,
                daily_revenue DECIMAL(12, 2) NOT NULL DEFAULT 0.00,
                daily_distance DECIMAL(12, 2) NOT NULL DEFAULT 0.00,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
        `);
        await client.query(`
            CREATE TABLE IF NOT EXISTS admin_monthly_counters (
                month_key VARCHAR(7) PRIMARY KEY,
                monthly_trips INTEGER NOT NULL DEFAULT 0,
                monthly_revenue DECIMAL(12, 2) NOT NULL DEFAULT 0.00,
                monthly_distance DECIMAL(12, 2) NOT NULL DEFAULT 0.00,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
        `);
        console.log('✅ Admin counters tables created');
        
        // Create indexes for better performance
        try {
            await client.query(`CREATE INDEX IF NOT EXISTS idx_trips_user_id ON trips(user_id);`);
            await client.query(`CREATE INDEX IF NOT EXISTS idx_trips_rider_id ON trips(rider_id);`);
            await client.query(`CREATE INDEX IF NOT EXISTS idx_trips_status ON trips(status);`);
            await client.query(`CREATE INDEX IF NOT EXISTS idx_trips_created_at ON trips(created_at DESC);`);
            await client.query(`CREATE INDEX IF NOT EXISTS idx_trips_completed_at ON trips(completed_at DESC);`);
            await client.query(`CREATE INDEX IF NOT EXISTS idx_trips_pickup_coords ON trips(pickup_lat, pickup_lng);`);

            await client.query(`CREATE INDEX IF NOT EXISTS idx_pending_rides_trip_id ON pending_ride_requests(trip_id);`);
            await client.query(`CREATE INDEX IF NOT EXISTS idx_pending_rides_source_status ON pending_ride_requests(source, status);`);
            await client.query(`CREATE INDEX IF NOT EXISTS idx_pending_rides_status ON pending_ride_requests(status);`);
            await client.query(`CREATE INDEX IF NOT EXISTS idx_pending_rides_user_id ON pending_ride_requests(user_id);`);
            await client.query(`CREATE INDEX IF NOT EXISTS idx_pending_rides_created_at ON pending_ride_requests(created_at DESC);`);
            await client.query(`CREATE INDEX IF NOT EXISTS idx_pending_rides_pickup_coords ON pending_ride_requests(pickup_lat, pickup_lng);`);
            await client.query(`CREATE INDEX IF NOT EXISTS idx_pending_rides_expires_at ON pending_ride_requests(expires_at);`);

            await client.query(`CREATE INDEX IF NOT EXISTS idx_driver_earnings_driver_date ON driver_earnings(driver_id, date DESC);`);
            await client.query(`CREATE INDEX IF NOT EXISTS idx_drivers_location ON drivers(last_lat, last_lng);`);
            console.log('✅ Indexes created');
        } catch (err) {
            console.log('⚠️ Some indexes may already exist');
        }
        
        // Insert sample offers
        await client.query(`
            INSERT INTO offers (code, title, description, badge, discount_type, discount_value, is_active)
            VALUES
                ('WELCOME20', '🎉 خصم 20% على أول رحلة', 'استخدم الكود WELCOME20 على أول طلب لك واحصل على خصم فوري.', 'جديد', 'percent', 20, true),
                ('2FOR1', '🚗 رحلتان بسعر 1', 'رحلتك الثانية مجاناً عند الدفع بالبطاقة خلال هذا الأسبوع.', 'محدود', 'percent', 50, true),
                ('DOUBLEPTS', '⭐ نقاط مضاعفة', 'اكسب ضعف النقاط على الرحلات المكتملة في عطلة نهاية الأسبوع.', 'نقاط', 'points', 2, true)
            ON CONFLICT (code) DO NOTHING;
        `);
        console.log('✅ Sample offers inserted');

        // Insert sample drivers with realistic data
        await client.query(`
            INSERT INTO drivers (name, phone, email, password, car_type, car_plate, rating, total_trips, status, approval_status, approved_at)
            VALUES 
                ('أحمد عبدالله المالكي', '0501234567', 'driver1@ubar.sa', '12345678', 'economy', 'أ ب ج 1234', 4.85, 342, 'online', 'approved', CURRENT_TIMESTAMP - INTERVAL '30 days'),
                ('محمد علي الشهري', '0507654321', 'driver2@ubar.sa', '12345678', 'family', 'س ع د 5678', 4.92, 587, 'online', 'approved', CURRENT_TIMESTAMP - INTERVAL '60 days'),
                ('خالد أحمد القحطاني', '0509876543', 'driver3@ubar.sa', '12345678', 'luxury', 'ت ك م 9012', 4.78, 215, 'offline', 'approved', CURRENT_TIMESTAMP - INTERVAL '90 days'),
                ('عمر يوسف الدوسري', '0502345678', 'driver4@ubar.sa', '12345678', 'economy', 'ن ه و 3456', 4.65, 158, 'online', 'approved', CURRENT_TIMESTAMP - INTERVAL '45 days'),
                ('سعيد حسن العتيبي', '0508765432', 'driver5@ubar.sa', '12345678', 'family', 'ل م ر 7890', 4.88, 423, 'online', 'approved', CURRENT_TIMESTAMP - INTERVAL '75 days'),
                ('فهد سعد الزهراني', '0503456789', 'driver6@ubar.sa', '12345678', 'luxury', 'ط ي ك 2345', 4.95, 672, 'offline', 'approved', CURRENT_TIMESTAMP - INTERVAL '120 days'),
                ('ناصر عبدالرحمن الغامدي', '0506789012', 'driver7@ubar.sa', '12345678', 'economy', 'ف ص ق 6789', 4.72, 289, 'online', 'approved', CURRENT_TIMESTAMP - INTERVAL '20 days'),
                ('ياسر محمود السبيعي', '0509012345', 'driver8@ubar.sa', '12345678', 'family', 'ش ض ظ 0123', 4.81, 394, 'offline', 'approved', CURRENT_TIMESTAMP - INTERVAL '50 days')
            ON CONFLICT (phone) DO NOTHING;
        `);
        console.log('✅ Sample drivers inserted');
        
        // Insert different user types: passenger, driver, admin
        await client.query(`
            INSERT INTO users (phone, name, email, password, role)
            VALUES 
                ('0551234567', 'عبدالعزيز أحمد', 'passenger1@ubar.sa', '12345678', 'passenger'),
                ('0552345678', 'نورة محمد', 'passenger2@ubar.sa', '12345678', 'passenger'),
                ('0553456789', 'فاطمة سعيد', 'passenger3@ubar.sa', '12345678', 'passenger'),
                ('0554567890', 'سارة عبدالله', 'passenger4@ubar.sa', '12345678', 'passenger'),
                ('0501234567', 'أحمد عبدالله المالكي', 'driver1@ubar.sa', '12345678', 'driver'),
                ('0507654321', 'محمد علي الشهري', 'driver2@ubar.sa', '12345678', 'driver'),
                ('0509876543', 'خالد أحمد القحطاني', 'driver3@ubar.sa', '12345678', 'driver'),
                ('0555678901', 'عبدالرحمن إبراهيم', 'admin@ubar.sa', '12345678', 'admin'),
                ('0556789012', 'هند خالد', 'admin2@ubar.sa', '12345678', 'admin')
            ON CONFLICT (phone) DO NOTHING;
        `);
        console.log('✅ Sample users inserted');
        
        // Insert realistic trip data
        const sampleTrips = [
            // Completed trips
            {
                id: 'TR-' + (Date.now() - 86400000) + '-1',
                user_id: 1,
                driver_id: 1,
                pickup_location: 'شارع الملك فهد، الرياض',
                dropoff_location: 'حي العليا، الرياض',
                pickup_lat: 24.7136,
                pickup_lng: 46.6753,
                dropoff_lat: 24.7110,
                dropoff_lng: 46.6760,
                car_type: 'economy',
                cost: 35.50,
                distance: 8.5,
                duration: 15,
                payment_method: 'cash',
                status: 'completed',
                rating: 5,
                review: 'سائق ممتاز، سيارة نظيفة',
                driver_name: 'أحمد عبدالله المالكي',
                completed_at: new Date(Date.now() - 86400000)
            },
            {
                id: 'TR-' + (Date.now() - 172800000) + '-2',
                user_id: 2,
                driver_id: 2,
                pickup_location: 'مطار الملك خالد الدولي',
                dropoff_location: 'برج المملكة',
                pickup_lat: 24.9577,
                pickup_lng: 46.6988,
                dropoff_lat: 24.7119,
                dropoff_lng: 46.6750,
                car_type: 'family',
                cost: 95.00,
                distance: 35.2,
                duration: 32,
                payment_method: 'card',
                status: 'completed',
                rating: 5,
                review: 'رحلة رائعة ومريحة',
                driver_name: 'محمد علي الشهري',
                completed_at: new Date(Date.now() - 172800000)
            },
            {
                id: 'TR-' + (Date.now() - 259200000) + '-3',
                user_id: 1,
                driver_id: 3,
                pickup_location: 'حي النخيل',
                dropoff_location: 'الرياض بارك',
                pickup_lat: 24.7243,
                pickup_lng: 46.6511,
                dropoff_lat: 24.8142,
                dropoff_lng: 46.6374,
                car_type: 'luxury',
                cost: 125.00,
                distance: 22.0,
                duration: 25,
                payment_method: 'wallet',
                status: 'completed',
                rating: 4,
                review: 'جيد جداً',
                driver_name: 'خالد أحمد القحطاني',
                completed_at: new Date(Date.now() - 259200000)
            },
            {
                id: 'TR-' + (Date.now() - 345600000) + '-4',
                user_id: 3,
                driver_id: 4,
                pickup_location: 'الرياض غاليري',
                dropoff_location: 'النخيل مول',
                pickup_lat: 24.7744,
                pickup_lng: 46.7385,
                dropoff_lat: 24.7853,
                dropoff_lng: 46.6018,
                car_type: 'economy',
                cost: 32.00,
                distance: 12.8,
                duration: 18,
                payment_method: 'cash',
                status: 'completed',
                rating: 5,
                review: 'وقت ممتاز وسريع',
                driver_name: 'عمر يوسف الدوسري',
                completed_at: new Date(Date.now() - 345600000)
            },
            {
                id: 'TR-' + (Date.now() - 432000000) + '-5',
                user_id: 4,
                driver_id: 5,
                pickup_location: 'جامعة الملك سعود',
                dropoff_location: 'حي الملز',
                pickup_lat: 24.7243,
                pickup_lng: 46.6189,
                dropoff_lat: 24.6742,
                dropoff_lng: 46.7081,
                car_type: 'family',
                cost: 45.50,
                distance: 15.3,
                duration: 22,
                payment_method: 'card',
                status: 'completed',
                rating: 5,
                review: 'خدمة ممتازة',
                driver_name: 'سعيد حسن العتيبي',
                completed_at: new Date(Date.now() - 432000000)
            },
            {
                id: 'TR-' + (Date.now() - 518400000) + '-6',
                user_id: 2,
                driver_id: 1,
                pickup_location: 'حي السفارات',
                dropoff_location: 'مستشفى الملك فيصل التخصصي',
                pickup_lat: 24.6905,
                pickup_lng: 46.6863,
                dropoff_lat: 24.6977,
                dropoff_lng: 46.7010,
                car_type: 'economy',
                cost: 28.00,
                distance: 7.2,
                duration: 13,
                payment_method: 'cash',
                status: 'completed',
                rating: 4,
                review: 'جيد',
                driver_name: 'أحمد عبدالله المالكي',
                completed_at: new Date(Date.now() - 518400000)
            },
            {
                id: 'TR-' + (Date.now() - 604800000) + '-7',
                user_id: 1,
                driver_id: 6,
                pickup_location: 'مركز المملكة',
                dropoff_location: 'الرياض فرونت',
                pickup_lat: 24.7119,
                pickup_lng: 46.6750,
                dropoff_lat: 24.7477,
                dropoff_lng: 46.6289,
                car_type: 'luxury',
                cost: 155.00,
                distance: 28.5,
                duration: 30,
                payment_method: 'card',
                status: 'completed',
                rating: 5,
                review: 'سائق محترف جداً، سيارة فخمة',
                driver_name: 'فهد سعد الزهراني',
                completed_at: new Date(Date.now() - 604800000)
            },
            // Cancelled trips
            {
                id: 'TR-' + (Date.now() - 691200000) + '-8',
                user_id: 3,
                driver_id: 2,
                pickup_location: 'حي الياسمين',
                dropoff_location: 'النخيل مول',
                pickup_lat: 24.8073,
                pickup_lng: 46.6683,
                dropoff_lat: 24.7853,
                dropoff_lng: 46.6018,
                car_type: 'family',
                cost: 38.00,
                distance: 11.2,
                duration: 16,
                payment_method: 'cash',
                status: 'cancelled',
                driver_name: 'محمد علي الشهري',
                cancelled_at: new Date(Date.now() - 691200000)
            },
            {
                id: 'TR-' + (Date.now() - 777600000) + '-9',
                user_id: 4,
                driver_id: 7,
                pickup_location: 'حي العزيزية',
                dropoff_location: 'الرياض بارك',
                pickup_lat: 24.6951,
                pickup_lng: 46.6887,
                dropoff_lat: 24.8142,
                dropoff_lng: 46.6374,
                car_type: 'economy',
                cost: 42.00,
                distance: 14.8,
                duration: 20,
                payment_method: 'wallet',
                status: 'cancelled',
                driver_name: 'ناصر عبدالرحمن الغامدي',
                cancelled_at: new Date(Date.now() - 777600000)
            },
            // Recent completed trips
            {
                id: 'TR-' + (Date.now() - 43200000) + '-10',
                user_id: 1,
                driver_id: 2,
                pickup_location: 'برج الفيصلية',
                dropoff_location: 'منتزه الملك عبدالله',
                pickup_lat: 24.6898,
                pickup_lng: 46.6855,
                dropoff_lat: 24.8073,
                dropoff_lng: 46.7260,
                car_type: 'family',
                cost: 52.00,
                distance: 18.4,
                duration: 24,
                payment_method: 'card',
                status: 'completed',
                rating: 5,
                review: 'ممتاز كالعادة',
                driver_name: 'محمد علي الشهري',
                completed_at: new Date(Date.now() - 43200000)
            }
        ];
        
        for (const trip of sampleTrips) {
            await client.query(`
                INSERT INTO trips (id, user_id, driver_id, pickup_location, dropoff_location,
                    pickup_lat, pickup_lng, dropoff_lat, dropoff_lng,
                    car_type, cost, distance, duration, payment_method, status, rating, 
                    review, driver_name, created_at, completed_at, cancelled_at)
                VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21)
                ON CONFLICT (id) DO NOTHING;
            `, [
                trip.id, trip.user_id, trip.driver_id, trip.pickup_location, 
                trip.dropoff_location, trip.pickup_lat, trip.pickup_lng,
                trip.dropoff_lat, trip.dropoff_lng, trip.car_type, trip.cost, 
                trip.distance, trip.duration, trip.payment_method, trip.status, 
                trip.rating, trip.review, trip.driver_name, 
                trip.completed_at || trip.cancelled_at || new Date(),
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
