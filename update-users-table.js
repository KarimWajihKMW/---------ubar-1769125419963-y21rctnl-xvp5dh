const pool = require('./db');

async function ensureUsersTableUpdated() {
    const client = await pool.connect();
    
    try {
        console.log('📊 Checking and updating users table...');
        
        // Check if updated_at column exists
        const columnCheck = await client.query(`
            SELECT column_name 
            FROM information_schema.columns 
            WHERE table_name = 'users' AND column_name = 'updated_at'
        `);

        if (columnCheck.rows.length === 0) {
            console.log('Adding updated_at column to users table...');
            await client.query(`
                ALTER TABLE users 
                ADD COLUMN updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            `);
            console.log('✅ Updated users table with updated_at column');
        } else {
            console.log('✅ Users table already has updated_at column');
        }

        // Create an index on role for faster queries
        const indexCheck = await client.query(`
            SELECT indexname 
            FROM pg_indexes 
            WHERE tablename = 'users' AND indexname = 'idx_users_role'
        `);

        if (indexCheck.rows.length === 0) {
            console.log('Creating index on role column...');
            await client.query(`CREATE INDEX idx_users_role ON users(role)`);
            console.log('✅ Created index on role column');
        } else {
            console.log('✅ Index on role column already exists');
        }

        // Update existing records to have updated_at if null
        await client.query(`
            UPDATE users 
            SET updated_at = created_at 
            WHERE updated_at IS NULL
        `);

        console.log('✅ Users table is up to date');
        
    } catch (err) {
        console.error('❌ Error updating users table:', err);
        throw err;
    } finally {
        client.release();
    }
}

// Run the update
ensureUsersTableUpdated()
    .then(() => {
        console.log('✅ Database update completed successfully');
        process.exit(0);
    })
    .catch(err => {
        console.error('❌ Database update failed:', err);
        process.exit(1);
    });
