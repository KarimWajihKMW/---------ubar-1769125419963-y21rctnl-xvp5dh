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

async function checkTables() {
    try {
        console.log('═══════════════════════════════════════════════════════');
        console.log('🔍 Checking Database Tables');
        console.log('═══════════════════════════════════════════════════════\n');
        
        // Check drivers table
        console.log('📋 DRIVERS TABLE:');
        console.log('─────────────────────────────────────────────────────');
        const driversColumns = await pool.query(`
            SELECT column_name, data_type, is_nullable
            FROM information_schema.columns 
            WHERE table_name = 'drivers' 
            ORDER BY ordinal_position
        `);
        driversColumns.rows.forEach(col => {
            console.log(`   ${col.column_name}: ${col.data_type}`);
        });
        
        const driversCount = await pool.query('SELECT COUNT(*) FROM drivers');
        console.log(`\n   📊 Total drivers: ${driversCount.rows[0].count}`);
        
        // Check driver_earnings table
        console.log('\n📋 DRIVER_EARNINGS TABLE:');
        console.log('─────────────────────────────────────────────────────');
        const earningsColumns = await pool.query(`
            SELECT column_name, data_type, is_nullable
            FROM information_schema.columns 
            WHERE table_name = 'driver_earnings' 
            ORDER BY ordinal_position
        `);
        
        if (earningsColumns.rows.length > 0) {
            earningsColumns.rows.forEach(col => {
                console.log(`   ${col.column_name}: ${col.data_type}`);
            });
            
            const earningsCount = await pool.query('SELECT COUNT(*) FROM driver_earnings');
            console.log(`\n   📊 Total records: ${earningsCount.rows[0].count}`);
            
            // Sample data
            const sample = await pool.query(`
                SELECT * FROM driver_earnings 
                ORDER BY created_at DESC LIMIT 2
            `);
            if (sample.rows.length > 0) {
                console.log('\n   📝 Sample data:');
                sample.rows.forEach((row, i) => {
                    console.log(`\n      Record ${i + 1}:`);
                    console.log(`         driver_id: ${row.driver_id}`);
                    console.log(`         date: ${row.date}`);
                    console.log(`         today_trips: ${row.today_trips}`);
                    console.log(`         today_earnings: ${row.today_earnings}`);
                    console.log(`         total_trips: ${row.total_trips}`);
                    console.log(`         total_earnings: ${row.total_earnings}`);
                });
            }
        } else {
            console.log('   ❌ Table does not exist!');
        }
        
        console.log('\n═══════════════════════════════════════════════════════');
        console.log('✅ Check completed');
        console.log('═══════════════════════════════════════════════════════');
        
    } catch (error) {
        console.error('\n❌ Error:', error.message);
    } finally {
        await pool.end();
    }
}

checkTables();
