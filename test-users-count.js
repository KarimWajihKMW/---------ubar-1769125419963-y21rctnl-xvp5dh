// Test script to verify users/passengers count
const { Pool } = require('pg');

const pool = new Pool({
    connectionString: 'postgresql://postgres:gnQuusUxfjjvwiryBRkdvFjzBkXhEieJ@trolley.proxy.rlwy.net:47888/railway',
    ssl: false
});

async function testUsersCount() {
    try {
        console.log('🔍 Testing users/passengers count...\n');
        
        // Get total users count
        const totalResult = await pool.query('SELECT COUNT(*) as count FROM users');
        console.log('✅ Total users in database:', totalResult.rows[0].count);
        
        // Get users by role
        const roleResult = await pool.query('SELECT role, COUNT(*) as count FROM users GROUP BY role');
        console.log('\n📊 Users by role:');
        roleResult.rows.forEach(row => {
            console.log(`   ${row.role}: ${row.count}`);
        });
        
        // Get passengers only (users who are not admin or driver)
        const passengersResult = await pool.query(`
            SELECT COUNT(*) as count 
            FROM users 
            WHERE role = 'user' OR role IS NULL OR role = 'passenger'
        `);
        console.log('\n👥 Passengers (role=user/passenger/null):', passengersResult.rows[0].count);
        
        console.log('\n✨ Done!');
        await pool.end();
    } catch (error) {
        console.error('❌ Error:', error.message);
        await pool.end();
        process.exit(1);
    }
}

testUsersCount();
