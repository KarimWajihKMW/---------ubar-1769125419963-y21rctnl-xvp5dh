const pool = require('./db');

async function checkUsersTable() {
    try {
        // Check table structure
        const columns = await pool.query(`
            SELECT column_name, data_type, character_maximum_length 
            FROM information_schema.columns 
            WHERE table_name = 'users' 
            ORDER BY ordinal_position
        `);
        
        console.log('\n=== USERS TABLE STRUCTURE ===');
        columns.rows.forEach(col => {
            console.log(`${col.column_name}: ${col.data_type}${col.character_maximum_length ? `(${col.character_maximum_length})` : ''}`);
        });
        
        // Check current users
        const users = await pool.query('SELECT * FROM users LIMIT 10');
        console.log('\n=== CURRENT USERS IN DATABASE ===');
        console.log(`Total users: ${users.rows.length}`);
        users.rows.forEach((user, idx) => {
            console.log(`\nUser ${idx + 1}:`);
            console.log(JSON.stringify(user, null, 2));
        });
        
        await pool.end();
    } catch (err) {
        console.error('Error:', err);
        process.exit(1);
    }
}

checkUsersTable();
