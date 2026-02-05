const pool = require('./db');

async function migrateUsersTable() {
    const client = await pool.connect();
    
    try {
        console.log('📊 Migrating users table to include all user data fields...');
        
        // Add missing columns to users table
        console.log('Adding missing columns...');
        
        await client.query(`
            ALTER TABLE users 
            ADD COLUMN IF NOT EXISTS car_type VARCHAR(50),
            ADD COLUMN IF NOT EXISTS car_plate VARCHAR(20),
            ADD COLUMN IF NOT EXISTS balance DECIMAL(10, 2) DEFAULT 0.00,
            ADD COLUMN IF NOT EXISTS points INTEGER DEFAULT 0,
            ADD COLUMN IF NOT EXISTS rating DECIMAL(3, 2) DEFAULT 5.00,
            ADD COLUMN IF NOT EXISTS status VARCHAR(50) DEFAULT 'عضو جديد',
            ADD COLUMN IF NOT EXISTS avatar TEXT;
        `);
        
        console.log('✅ All user data columns added successfully');
        
        // Update existing users to have default values
        console.log('Updating existing users with default values...');
        
        await client.query(`
            UPDATE users 
            SET 
                balance = COALESCE(balance, 0.00),
                points = COALESCE(points, 0),
                rating = COALESCE(rating, 5.00),
                status = COALESCE(status, 'عضو جديد'),
                avatar = COALESCE(avatar, 'https://api.dicebear.com/7.x/avataaars/svg?seed=' || COALESCE(name, 'User'))
            WHERE balance IS NULL OR points IS NULL OR rating IS NULL OR status IS NULL OR avatar IS NULL;
        `);
        
        console.log('✅ Existing users updated with default values');
        
        // Check current table structure
        const columns = await client.query(`
            SELECT column_name, data_type, column_default
            FROM information_schema.columns 
            WHERE table_name = 'users' 
            ORDER BY ordinal_position
        `);
        
        console.log('\n=== USERS TABLE STRUCTURE ===');
        columns.rows.forEach(col => {
            console.log(`  ${col.column_name}: ${col.data_type} (default: ${col.column_default || 'none'})`);
        });
        
        // Check users count
        const count = await client.query('SELECT COUNT(*) as total FROM users');
        console.log(`\n✅ Total users in database: ${count.rows[0].total}`);
        
    } catch (err) {
        console.error('❌ Migration failed:', err);
        throw err;
    } finally {
        client.release();
    }
}

// Run migration
migrateUsersTable()
    .then(() => {
        console.log('\n✅ Migration completed successfully');
        process.exit(0);
    })
    .catch(err => {
        console.error('\n❌ Migration failed:', err);
        process.exit(1);
    });
