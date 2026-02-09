const pool = require('./db');

async function testFixedAPI() {
    try {
        console.log('🧪 Testing Fixed Driver Profile API\n');
        console.log('='.repeat(70));
        
        // Test with driver ID 6 (محمد) who has actual data
        const userId = 6;
        
        console.log(`\n👤 Testing with user ID: ${userId}`);
        
        const result = await pool.query(
            'SELECT id, phone, name, email, role, car_type, car_plate, balance, points, rating, status, avatar, created_at, driver_id FROM users WHERE id = $1',
            [userId]
        );
        
        let userData = result.rows[0];
        console.log('\n📋 User data:', userData);
        
        if (userData.role === 'driver' && userData.driver_id) {
            console.log('\n🚗 User is a driver, fetching earnings...');
            console.log(`   driver_id: ${userData.driver_id}`);
            
            // Fetch the most recent earnings record (for cumulative totals)
            const latestEarningsResult = await pool.query(
                `SELECT today_trips, today_earnings, total_trips, total_earnings, date 
                 FROM driver_earnings 
                 WHERE driver_id = $1 
                 ORDER BY date DESC 
                 LIMIT 1`,
                [userData.driver_id]
            );
            
            console.log('\n📊 Latest earnings record:');
            console.log(latestEarningsResult.rows[0]);
            
            // Fetch today's specific data
            const todayEarningsResult = await pool.query(
                `SELECT today_trips, today_earnings 
                 FROM driver_earnings 
                 WHERE driver_id = $1 AND date = CURRENT_DATE 
                 LIMIT 1`,
                [userData.driver_id]
            );
            
            console.log('\n📅 Today\'s earnings record:');
            console.log(todayEarningsResult.rows[0] || 'No data for today');
            
            const latestData = latestEarningsResult.rows[0] || {};
            const todayData = todayEarningsResult.rows[0] || {};
            
            userData = {
                ...userData,
                today_trips: todayData.today_trips || 0,
                today_earnings: todayData.today_earnings || 0,
                total_trips: latestData.total_trips || 0,
                total_earnings: latestData.total_earnings || 0
            };
            
            console.log('\n✅ FINAL API RESPONSE DATA:');
            console.log('='.repeat(70));
            console.log(`Name: ${userData.name}`);
            console.log(`Balance: ${userData.balance} ر.س`);
            console.log(`Points: ${userData.points}`);
            console.log(`Rating: ${userData.rating}`);
            console.log(`\n🚗 Driver Earnings:`);
            console.log(`   رحلات اليوم (Today Trips): ${userData.today_trips}`);
            console.log(`   أرباح اليوم (Today Earnings): ${userData.today_earnings} ر.س`);
            console.log(`   إجمالي الرحلات (Total Trips): ${userData.total_trips}`);
            console.log(`   إجمالي الأرباح (Total Earnings): ${userData.total_earnings} ر.س`);
            console.log('='.repeat(70));
        }
        
        console.log('\n✅ Test completed successfully!');
        
        await pool.end();
        
    } catch (error) {
        console.error('\n❌ Error:', error);
        process.exit(1);
    }
}

testFixedAPI();
