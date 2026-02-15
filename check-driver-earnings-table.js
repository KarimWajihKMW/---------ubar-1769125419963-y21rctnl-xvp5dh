const { Pool } = require('pg');

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
    console.error('❌ DATABASE_URL is not set. Export DATABASE_URL then re-run.');
    process.exit(1);
}

const pool = new Pool({
    connectionString,
    ssl: {
        rejectUnauthorized: false
    }
});

async function checkTable() {
    try {
        console.log('🔍 Checking driver_earnings table structure...\n');
        
        // Check columns
        const columnsResult = await pool.query(`
            SELECT column_name, data_type, is_nullable
            FROM information_schema.columns 
            WHERE table_name = 'driver_earnings' 
            ORDER BY ordinal_position
        `);
        
        if (columnsResult.rows.length > 0) {
            console.log('✅ Table exists with columns:');
            columnsResult.rows.forEach(col => {
                console.log(`   - ${col.column_name}: ${col.data_type} ${col.is_nullable === 'NO' ? '(NOT NULL)' : ''}`);
            });
        } else {
            console.log('❌ Table does not exist');
        }
        
        // Check sample data
        const dataResult = await pool.query('SELECT * FROM driver_earnings LIMIT 3');
        console.log(`\n📊 Sample data (${dataResult.rows.length} rows):`);
        dataResult.rows.forEach((row, i) => {
            console.log(`\n   Row ${i + 1}:`);
            Object.entries(row).forEach(([key, value]) => {
                console.log(`      ${key}: ${value}`);
            });
        });
        
    } catch (error) {
        console.error('❌ Error:', error.message);
    } finally {
        await pool.end();
    }
}

checkTable();
