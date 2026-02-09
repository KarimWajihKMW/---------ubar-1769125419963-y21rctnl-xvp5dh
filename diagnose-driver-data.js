const pool = require('./db');

async function diagnoseDriverData() {
    try {
        console.log('🔍 Diagnosing Driver Data Issue\n');
        console.log('='.repeat(70));
        
        // 1. Check driver_earnings table
        console.log('\n📊 Step 1: Checking driver_earnings table...');
        const earningsData = await pool.query(`
            SELECT * FROM driver_earnings ORDER BY date DESC LIMIT 5
        `);
        
        if (earningsData.rows.length === 0) {
            console.log('❌ No data found in driver_earnings table!');
        } else {
            console.log(`✅ Found ${earningsData.rows.length} records in driver_earnings:`);
            earningsData.rows.forEach((row, i) => {
                console.log(`\n   Record ${i + 1}:`);
                console.log(`   - driver_id: ${row.driver_id}`);
                console.log(`   - date: ${row.date}`);
                console.log(`   - today_trips: ${row.today_trips}`);
                console.log(`   - today_earnings: ${row.today_earnings}`);
                console.log(`   - total_trips: ${row.total_trips}`);
                console.log(`   - total_earnings: ${row.total_earnings}`);
            });
        }
        
        // 2. Check users with driver role
        console.log('\n👥 Step 2: Checking users with driver role...');
        const driverUsers = await pool.query(`
            SELECT id, name, phone, email, role, driver_id 
            FROM users 
            WHERE role = 'driver' 
            LIMIT 5
        `);
        
        if (driverUsers.rows.length === 0) {
            console.log('❌ No drivers found in users table!');
        } else {
            console.log(`✅ Found ${driverUsers.rows.length} driver users:`);
            driverUsers.rows.forEach((row, i) => {
                console.log(`\n   Driver ${i + 1}:`);
                console.log(`   - user_id: ${row.id}`);
                console.log(`   - name: ${row.name}`);
                console.log(`   - phone: ${row.phone}`);
                console.log(`   - driver_id: ${row.driver_id}`);
            });
        }
        
        // 3. Check the join between tables
        console.log('\n🔗 Step 3: Checking join between users and driver_earnings...');
        const joinedData = await pool.query(`
            SELECT 
                u.id as user_id, 
                u.name, 
                u.driver_id as user_driver_id, 
                de.driver_id as earnings_driver_id,
                de.today_trips,
                de.today_earnings,
                de.total_trips,
                de.total_earnings,
                de.date
            FROM users u
            LEFT JOIN driver_earnings de ON u.driver_id = de.driver_id
            WHERE u.role = 'driver'
            ORDER BY de.date DESC
            LIMIT 5
        `);
        
        console.log(`✅ Found ${joinedData.rows.length} joined records:`);
        joinedData.rows.forEach((row, i) => {
            console.log(`\n   Record ${i + 1}:`);
            console.log(`   - user_id: ${row.user_id}`);
            console.log(`   - name: ${row.name}`);
            console.log(`   - user_driver_id: ${row.user_driver_id}`);
            console.log(`   - earnings_driver_id: ${row.earnings_driver_id}`);
            console.log(`   - today_trips: ${row.today_trips}`);
            console.log(`   - today_earnings: ${row.today_earnings}`);
            console.log(`   - total_trips: ${row.total_trips}`);
            console.log(`   - total_earnings: ${row.total_earnings}`);
            console.log(`   - date: ${row.date}`);
        });
        
        // 4. Check for specific date
        console.log('\n📅 Step 4: Checking for TODAY\'S date specifically...');
        const todayData = await pool.query(`
            SELECT 
                u.id as user_id, 
                u.name, 
                u.driver_id,
                de.driver_id as earnings_driver_id,
                de.today_trips,
                de.today_earnings,
                de.total_trips,
                de.total_earnings,
                de.date,
                CURRENT_DATE as current_date
            FROM users u
            LEFT JOIN driver_earnings de ON u.driver_id = de.driver_id AND de.date = CURRENT_DATE
            WHERE u.role = 'driver'
            LIMIT 5
        `);
        
        console.log(`✅ Found ${todayData.rows.length} records for TODAY:`);
        todayData.rows.forEach((row, i) => {
            console.log(`\n   Record ${i + 1}:`);
            console.log(`   - user_id: ${row.user_id}`);
            console.log(`   - name: ${row.name}`);
            console.log(`   - user_driver_id: ${row.user_driver_id}`);
            console.log(`   - earnings_driver_id: ${row.earnings_driver_id || 'NULL (no record for today)'}`);
            console.log(`   - today_trips: ${row.today_trips || 0}`);
            console.log(`   - today_earnings: ${row.today_earnings || 0}`);
            console.log(`   - total_trips: ${row.total_trips || 0}`);
            console.log(`   - total_earnings: ${row.total_earnings || 0}`);
            console.log(`   - record_date: ${row.date || 'N/A'}`);
            console.log(`   - current_date: ${row.current_date}`);
        });
        
        console.log('\n' + '='.repeat(70));
        console.log('🔍 DIAGNOSIS COMPLETE\n');
        
        await pool.end();
        
    } catch (error) {
        console.error('\n❌ Error:', error);
        process.exit(1);
    }
}

diagnoseDriverData();
