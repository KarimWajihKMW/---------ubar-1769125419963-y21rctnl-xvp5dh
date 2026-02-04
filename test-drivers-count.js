// Test script to verify drivers count
const { Pool } = require('pg');

const pool = new Pool({
    connectionString: 'postgresql://postgres:gnQuusUxfjjvwiryBRkdvFjzBkXhEieJ@trolley.proxy.rlwy.net:47888/railway',
    ssl: false
});

async function testDriversCount() {
    try {
        console.log('🔍 Testing drivers count...\n');
        
        // Get total drivers count
        const totalResult = await pool.query('SELECT COUNT(*) as count FROM drivers');
        console.log('✅ Total drivers in database:', totalResult.rows[0].count);
        
        // Get online drivers count
        const onlineResult = await pool.query('SELECT COUNT(*) as count FROM drivers WHERE status = \'online\'');
        console.log('🟢 Online drivers:', onlineResult.rows[0].count);
        
        // Get drivers by status
        const statusResult = await pool.query('SELECT status, COUNT(*) as count FROM drivers GROUP BY status');
        console.log('\n📊 Drivers by status:');
        statusResult.rows.forEach(row => {
            console.log(`   ${row.status}: ${row.count}`);
        });
        
        console.log('\n✨ Done!');
        await pool.end();
    } catch (error) {
        console.error('❌ Error:', error.message);
        await pool.end();
        process.exit(1);
    }
}

testDriversCount();
