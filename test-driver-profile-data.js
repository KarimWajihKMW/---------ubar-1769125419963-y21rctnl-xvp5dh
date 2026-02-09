const pool = require('./db');

async function testDriverProfileData() {
    try {
        console.log('🔍 Testing driver profile data...\n');
        
        // Get driver users
        const usersResult = await pool.query(`
            SELECT id, name, phone, email, role, balance, points, rating, driver_id
            FROM users
            WHERE role = 'driver'
            LIMIT 3
        `);
        
        console.log('👥 Driver Users from users table:');
        console.log(usersResult.rows);
        console.log('');
        
        // Get driver earnings
        const earningsResult = await pool.query(`
            SELECT driver_id, date, today_trips, today_earnings, total_trips, total_earnings
            FROM driver_earnings
            ORDER BY date DESC
            LIMIT 5
        `);
        
        console.log('💰 Driver Earnings from driver_earnings table:');
        console.log(earningsResult.rows);
        console.log('');
        
        // Get joined data
        const joinedResult = await pool.query(`
            SELECT 
                u.id, u.name, u.phone, u.email, u.role, u.balance, u.points, u.rating, u.driver_id,
                de.today_trips, de.today_earnings, de.total_trips, de.total_earnings, de.date
            FROM users u
            LEFT JOIN driver_earnings de ON u.driver_id = de.driver_id AND de.date = CURRENT_DATE
            WHERE u.role = 'driver'
            LIMIT 3
        `);
        
        console.log('🔗 Joined Data (users + driver_earnings):');
        console.log(joinedResult.rows);
        
        await pool.end();
    } catch (error) {
        console.error('❌ Error:', error);
        process.exit(1);
    }
}

testDriverProfileData();
