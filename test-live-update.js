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

async function testLiveUpdate() {
    console.log('═══════════════════════════════════════════════════════');
    console.log('🧪 اختبار التحديث التلقائي - Live Update Test');
    console.log('═══════════════════════════════════════════════════════\n');

    try {
        // Get first driver
        const driversResult = await pool.query('SELECT * FROM drivers LIMIT 1');
        
        if (driversResult.rows.length === 0) {
            console.log('❌ لا يوجد سائقين في النظام');
            return;
        }
        
        const driver = driversResult.rows[0];
        console.log('📋 بيانات السائق الحالية:');
        console.log('─────────────────────────────────────────────────────');
        console.log(`   ID: ${driver.id}`);
        console.log(`   الاسم: ${driver.name}`);
        console.log(`   رحلات اليوم: ${driver.today_trips_count || 0}`);
        console.log(`   أرباح اليوم: ${driver.today_earnings || 0} ر.س`);
        console.log(`   إجمالي الرحلات: ${driver.total_trips || 0}`);
        console.log(`   إجمالي الأرباح: ${driver.total_earnings || 0} ر.س`);
        console.log(`   الرصيد: ${driver.balance || 0} ر.س`);
        
        // Update with test data
        console.log('\n🔄 تحديث البيانات...');
        console.log('─────────────────────────────────────────────────────');
        
        const newTodayEarnings = Math.floor(Math.random() * 1000);
        const newTodayTrips = Math.floor(Math.random() * 30) + 1;
        
        const updateResult = await pool.query(`
            UPDATE drivers
            SET 
                today_earnings = $1,
                today_trips_count = $2,
                updated_at = CURRENT_TIMESTAMP
            WHERE id = $3
            RETURNING *
        `, [newTodayEarnings, newTodayTrips, driver.id]);
        
        const updated = updateResult.rows[0];
        console.log('   ✅ تم التحديث بنجاح!');
        console.log(`   أرباح اليوم الجديدة: ${updated.today_earnings} ر.س`);
        console.log(`   رحلات اليوم الجديدة: ${updated.today_trips_count}`);
        
        console.log('\n🌐 افتح الصفحات التالية لرؤية التحديث:');
        console.log('─────────────────────────────────────────────────────');
        console.log('   1. صفحة الاختبار:');
        console.log('      http://localhost:3000/test-live-update.html');
        console.log('\n   2. صفحة الإدارة:');
        console.log('      http://localhost:3000/admin-driver-earnings.html');
        
        console.log('\n📝 ملاحظات:');
        console.log('─────────────────────────────────────────────────────');
        console.log('   ✓ التحديث التلقائي يعمل كل 5 ثواني');
        console.log('   ✓ سترى التغييرات تظهر تلقائياً في الصفحات');
        console.log('   ✓ يمكنك تعديل قاعدة البيانات يدوياً أيضاً');
        
        console.log('\n💡 لتعديل قاعدة البيانات يدوياً:');
        console.log('─────────────────────────────────────────────────────');
        console.log(`   UPDATE drivers SET today_earnings = 999.99 WHERE id = ${driver.id};`);
        console.log(`   UPDATE drivers SET today_trips_count = 25 WHERE id = ${driver.id};`);
        
        console.log('\n═══════════════════════════════════════════════════════');
        console.log('✅ الاختبار اكتمل بنجاح!');
        console.log('═══════════════════════════════════════════════════════');
        
    } catch (error) {
        console.error('\n❌ خطأ:', error.message);
    } finally {
        await pool.end();
    }
}

testLiveUpdate();
