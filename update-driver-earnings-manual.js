const pool = require('./db');

async function updateDriverEarningsManually() {
    const client = await pool.connect();
    
    try {
        console.log('📊 تحديث أرباح السائق يدوياً من قاعدة البيانات');
        console.log('=' .repeat(60));
        
        // Get driver ID from command line or use default
        const driverId = process.argv[2] || 1;
        const todayEarnings = process.argv[3] || 250.50;
        const todayTrips = process.argv[4] || 10;
        
        console.log(`\n🎯 السائق ID: ${driverId}`);
        console.log(`💰 أرباح اليوم الجديدة: ${todayEarnings} ر.س`);
        console.log(`🚗 رحلات اليوم الجديدة: ${todayTrips}`);
        
        // Get current data
        const current = await client.query(`
            SELECT name, today_earnings, today_trips_count, balance, total_earnings, total_trips
            FROM drivers
            WHERE id = $1
        `, [driverId]);
        
        if (current.rows.length === 0) {
            console.error(`❌ السائق ID ${driverId} غير موجود`);
            process.exit(1);
        }
        
        console.log('\n📋 البيانات الحالية:');
        console.table(current.rows);
        
        // Update the data
        await client.query(`
            UPDATE drivers
            SET 
                today_earnings = $1,
                today_trips_count = $2,
                updated_at = CURRENT_TIMESTAMP
            WHERE id = $3
        `, [todayEarnings, todayTrips, driverId]);
        
        console.log('\n✅ تم تحديث البيانات في قاعدة البيانات');
        
        // Get updated data
        const updated = await client.query(`
            SELECT name, today_earnings, today_trips_count, balance, total_earnings, total_trips
            FROM drivers
            WHERE id = $1
        `, [driverId]);
        
        console.log('\n📋 البيانات بعد التحديث:');
        console.table(updated.rows);
        
        console.log('\n🌐 الآن يمكنك:');
        console.log('   1. فتح صفحة earnings.html في المتصفح');
        console.log('   2. الضغط على زر "تحديث" 🔄');
        console.log('   3. سترى البيانات الجديدة تظهر فوراً!');
        console.log('\n📝 ملاحظة: الصفحة تحدث البيانات تلقائياً كل 10 ثواني');
        
    } catch (error) {
        console.error('❌ خطأ:', error.message);
        process.exit(1);
    } finally {
        client.release();
        await pool.end();
    }
}

console.log(`
╔═══════════════════════════════════════════════════════════════╗
║          تحديث أرباح السائق - أكوادرا تاكسي                  ║
╚═══════════════════════════════════════════════════════════════╝

الاستخدام:
  node update-driver-earnings-manual.js [driver_id] [today_earnings] [today_trips]

أمثلة:
  node update-driver-earnings-manual.js 1 500.75 15
  node update-driver-earnings-manual.js 2 1200 25
  node update-driver-earnings-manual.js 1 0 0

`);

updateDriverEarningsManually();
