const pool = require('./db');

async function testAdminStats() {
    try {
        console.log('🔍 Testing Admin Dashboard Stats...\n');
        
        // Test 1: Total trips
        const totalResult = await pool.query('SELECT COUNT(*) FROM trips');
        console.log('✅ Total trips in DB:', totalResult.rows[0].count);
        
        // Test 2: Today's trips
        const today = new Date();
        today.setHours(0, 0, 0, 0);
        const tomorrow = new Date(today);
        tomorrow.setDate(tomorrow.getDate() + 1);
        
        const todayResult = await pool.query(
            'SELECT COUNT(*) FROM trips WHERE created_at >= $1 AND created_at < $2',
            [today, tomorrow]
        );
        console.log('✅ Today trips:', todayResult.rows[0].count);
        
        // Test 3: Active drivers
        const driversResult = await pool.query(
            "SELECT COUNT(*) FROM drivers WHERE status = 'online'"
        );
        console.log('✅ Active drivers:', driversResult.rows[0].count);
        
        // Test 4: Total earnings
        const earningsResult = await pool.query(
            "SELECT COALESCE(SUM(cost), 0) as total FROM trips WHERE status = 'completed'"
        );
        console.log('✅ Total earnings:', earningsResult.rows[0].total);
        
        // Test 5: Average rating
        const ratingResult = await pool.query(
            "SELECT COALESCE(AVG(rating), 0) as avg_rating FROM trips WHERE status = 'completed' AND rating IS NOT NULL"
        );
        console.log('✅ Average rating:', parseFloat(ratingResult.rows[0].avg_rating).toFixed(1));
        
        // Test API endpoint
        console.log('\n🔍 Testing API endpoint...');
        const response = await fetch('http://localhost:3000/api/admin/dashboard/stats');
        const data = await response.json();
        console.log('API Response:', JSON.stringify(data, null, 2));
        
        await pool.end();
        process.exit(0);
    } catch (err) {
        console.error('❌ Error:', err.message);
        await pool.end();
        process.exit(1);
    }
}

testAdminStats();
