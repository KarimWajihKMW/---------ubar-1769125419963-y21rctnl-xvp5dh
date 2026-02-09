const pool = require('./db');

async function testDriverProfileAPI() {
    try {
        console.log('🧪 Testing Driver Profile API Integration\n');
        console.log('='.repeat(60));
        
        // Step 1: Get a driver user from the database
        console.log('\n📋 Step 1: Fetching driver users...');
        const driversQuery = await pool.query(`
            SELECT id, name, phone, email, role, balance, points, rating, driver_id
            FROM users
            WHERE role = 'driver'
            LIMIT 1
        `);
        
        if (driversQuery.rows.length === 0) {
            console.log('⚠️ No drivers found in database. Creating a test driver...');
            
            // Create a test driver
            const createDriver = await pool.query(`
                INSERT INTO users (phone, name, email, role, balance, points, rating, status, driver_id)
                VALUES ('0501234567', 'أحمد محمد', 'ahmed@test.com', 'driver', 500.00, 100, 4.8, 'نشط', 1)
                RETURNING id, name, phone, email, role, balance, points, rating, driver_id
            `);
            
            console.log('✅ Test driver created:', createDriver.rows[0]);
            
            // Create earnings record
            await pool.query(`
                INSERT INTO driver_earnings (driver_id, date, today_trips, today_earnings, total_trips, total_earnings)
                VALUES (1, CURRENT_DATE, 5, 150.00, 50, 2500.00)
                ON CONFLICT (driver_id, date) DO UPDATE 
                SET today_trips = 5, today_earnings = 150.00, total_trips = 50, total_earnings = 2500.00
            `);
            
            console.log('✅ Earnings record created');
        } else {
            console.log('✅ Found driver:', driversQuery.rows[0]);
        }
        
        // Get the first driver
        const driverResult = await pool.query(`
            SELECT id, name, phone, email, role, balance, points, rating, driver_id
            FROM users
            WHERE role = 'driver'
            LIMIT 1
        `);
        
        const driver = driverResult.rows[0];
        console.log('\n👤 Testing with driver:', driver.name, '(ID:', driver.id + ')');
        
        // Step 2: Simulate the API endpoint
        console.log('\n📋 Step 2: Simulating /api/users/:id endpoint...');
        
        const userQuery = await pool.query(
            'SELECT id, phone, name, email, role, car_type, car_plate, balance, points, rating, status, avatar, created_at, driver_id FROM users WHERE id = $1',
            [driver.id]
        );
        
        let userData = userQuery.rows[0];
        console.log('✅ User data fetched:', userData);
        
        // Step 3: Fetch driver earnings if user is a driver
        if (userData.role === 'driver' && userData.driver_id) {
            console.log('\n📋 Step 3: Fetching driver earnings...');
            
            const earningsResult = await pool.query(
                `SELECT today_trips, today_earnings, total_trips, total_earnings, date 
                 FROM driver_earnings 
                 WHERE driver_id = $1 AND date = CURRENT_DATE 
                 ORDER BY date DESC 
                 LIMIT 1`,
                [userData.driver_id]
            );
            
            if (earningsResult.rows.length > 0) {
                console.log('✅ Earnings data found:', earningsResult.rows[0]);
                
                userData = {
                    ...userData,
                    today_trips: earningsResult.rows[0].today_trips || 0,
                    today_earnings: earningsResult.rows[0].today_earnings || 0,
                    total_trips: earningsResult.rows[0].total_trips || 0,
                    total_earnings: earningsResult.rows[0].total_earnings || 0
                };
            } else {
                console.log('⚠️ No earnings data for today, using defaults');
                userData = {
                    ...userData,
                    today_trips: 0,
                    today_earnings: 0,
                    total_trips: 0,
                    total_earnings: 0
                };
            }
        }
        
        // Step 4: Display final combined data
        console.log('\n📋 Step 4: Final combined user data:');
        console.log('='.repeat(60));
        console.log('ID:', userData.id);
        console.log('Name:', userData.name);
        console.log('Phone:', userData.phone);
        console.log('Email:', userData.email);
        console.log('Role:', userData.role);
        console.log('Balance:', userData.balance);
        console.log('Points:', userData.points);
        console.log('Rating:', userData.rating);
        console.log('Status:', userData.status);
        if (userData.role === 'driver') {
            console.log('\n🚗 Driver Earnings:');
            console.log('Today Trips:', userData.today_trips);
            console.log('Today Earnings:', userData.today_earnings);
            console.log('Total Trips:', userData.total_trips);
            console.log('Total Earnings:', userData.total_earnings);
        }
        console.log('='.repeat(60));
        
        console.log('\n✅ Test completed successfully!');
        console.log('📝 The API should now return driver earnings data for driver users.');
        
        await pool.end();
        
    } catch (error) {
        console.error('\n❌ Test failed:', error);
        process.exit(1);
    }
}

testDriverProfileAPI();
