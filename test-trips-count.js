// Test script to verify trips count
const { Pool } = require('pg');

const pool = new Pool({
    connectionString: 'postgresql://postgres:gnQuusUxfjjvwiryBRkdvFjzBkXhEieJ@trolley.proxy.rlwy.net:47888/railway',
    ssl: false
});

async function testTripsCount() {
    try {
        console.log('🔍 Testing trips count...\n');
        
        // Get total trips count
        const totalResult = await pool.query('SELECT COUNT(*) as count FROM trips');
        console.log('✅ Total trips in database:', totalResult.rows[0].count);
        
        // Get today's trips count
        const today = new Date();
        today.setHours(0, 0, 0, 0);
        const tomorrow = new Date(today);
        tomorrow.setDate(tomorrow.getDate() + 1);
        
        const todayResult = await pool.query(
            'SELECT COUNT(*) as count FROM trips WHERE created_at >= $1 AND created_at < $2',
            [today, tomorrow]
        );
        console.log('📅 Today\'s trips only:', todayResult.rows[0].count);
        
        // Get all trips with pagination (12 pages x 10 trips)
        const paginatedResult = await pool.query('SELECT COUNT(*) as count FROM trips LIMIT 120');
        console.log('📄 Trips in 12 pages (10 per page):', Math.min(parseInt(totalResult.rows[0].count), 120));
        
        console.log('\n✨ Done!');
        await pool.end();
    } catch (error) {
        console.error('❌ Error:', error.message);
        await pool.end();
        process.exit(1);
    }
}

testTripsCount();
