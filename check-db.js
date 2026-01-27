const pool = require('./db');

async function checkTables() {
    try {
        // Check users table structure
        const usersCheck = await pool.query(`
            SELECT column_name, data_type 
            FROM information_schema.columns 
            WHERE table_name = 'users';
        `);
        console.log('Users table columns:', usersCheck.rows);
        
        // Check trips table structure
        const tripsCheck = await pool.query(`
            SELECT column_name, data_type 
            FROM information_schema.columns 
            WHERE table_name = 'trips';
        `);
        console.log('\nTrips table columns:', tripsCheck.rows);
        
        // Check if tables exist
        const tables = await pool.query(`
            SELECT table_name 
            FROM information_schema.tables 
            WHERE table_schema = 'public';
        `);
        console.log('\nExisting tables:', tables.rows.map(r => r.table_name));
        
    } catch (err) {
        console.error('Error:', err);
    } finally {
        process.exit(0);
    }
}

checkTables();
