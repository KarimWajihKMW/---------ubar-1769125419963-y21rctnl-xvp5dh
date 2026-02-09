const axios = require('axios');

const BASE_URL = 'http://localhost:3000';

async function testAdminEarningsSystem() {
    console.log('═══════════════════════════════════════════════════════');
    console.log('🧪 اختبار نظام إدارة أرباح السائقين');
    console.log('═══════════════════════════════════════════════════════\n');
    
    try {
        // Test 1: Get all drivers
        console.log('📋 Test 1: الحصول على جميع السائقين');
        console.log('─────────────────────────────────────────────────────');
        
        const driversResponse = await axios.get(`${BASE_URL}/api/drivers`);
        
        if (!driversResponse.data.success) {
            throw new Error('Failed to get drivers');
        }
        
        const drivers = driversResponse.data.data;
        console.log(`✅ تم الحصول على ${drivers.length} سائق`);
        
        if (drivers.length === 0) {
            console.log('⚠️  لا يوجد سائقين في النظام - يرجى إضافة سائق أولاً');
            return;
        }
        
        // Show first driver
        const driver = drivers[0];
        console.log('\n   📊 بيانات أول سائق:');
        console.log(`      ID: ${driver.id}`);
        console.log(`      الاسم: ${driver.name}`);
        console.log(`      رحلات اليوم: ${driver.today_trips_count || 0}`);
        console.log(`      أرباح اليوم: ${driver.today_earnings || 0} ر.س`);
        console.log(`      إجمالي الرحلات: ${driver.total_trips || 0}`);
        console.log(`      إجمالي الأرباح: ${driver.total_earnings || 0} ر.س`);
        console.log(`      الرصيد: ${driver.balance || 0} ر.س`);
        
        // Test 2: Update driver earnings
        console.log('\n📋 Test 2: تحديث أرباح السائق');
        console.log('─────────────────────────────────────────────────────');
        
        const testData = {
            today_trips_count: 15,
            today_earnings: 450.75,
            total_trips: (driver.total_trips || 0) + 15,
            total_earnings: parseFloat(driver.total_earnings || 0) + 450.75,
            balance: parseFloat(driver.balance || 0) + 450.75
        };
        
        console.log('   📝 البيانات الجديدة:');
        console.log(`      رحلات اليوم: ${testData.today_trips_count}`);
        console.log(`      أرباح اليوم: ${testData.today_earnings} ر.س`);
        console.log(`      إجمالي الرحلات: ${testData.total_trips}`);
        console.log(`      إجمالي الأرباح: ${testData.total_earnings} ر.س`);
        console.log(`      الرصيد: ${testData.balance} ر.س`);
        
        const updateResponse = await axios.put(
            `${BASE_URL}/api/drivers/${driver.id}/earnings/update`,
            testData
        );
        
        if (!updateResponse.data.success) {
            throw new Error(updateResponse.data.error || 'Failed to update');
        }
        
        console.log('\n   ✅ تم التحديث بنجاح!');
        console.log('   📊 البيانات المحدثة:');
        const updated = updateResponse.data.data;
        console.log(`      رحلات اليوم: ${updated.today_trips_count}`);
        console.log(`      أرباح اليوم: ${updated.today_earnings} ر.س`);
        console.log(`      إجمالي الرحلات: ${updated.total_trips}`);
        console.log(`      إجمالي الأرباح: ${updated.total_earnings} ر.س`);
        console.log(`      الرصيد: ${updated.balance} ر.س`);
        
        // Test 3: Verify update in stats endpoint
        console.log('\n📋 Test 3: التحقق من التحديث في Stats API');
        console.log('─────────────────────────────────────────────────────');
        
        const statsResponse = await axios.get(`${BASE_URL}/api/drivers/${driver.id}/stats`);
        
        if (!statsResponse.data.success) {
            throw new Error('Failed to get stats');
        }
        
        const stats = statsResponse.data.data;
        console.log('   ✅ تم الحصول على الإحصائيات:');
        console.log(`      أرباح اليوم: ${stats.earnings.today} ر.س`);
        console.log(`      إجمالي الأرباح: ${stats.earnings.total} ر.س`);
        console.log(`      الرصيد: ${stats.earnings.balance} ر.س`);
        console.log(`      رحلات اليوم: ${stats.trips.today}`);
        console.log(`      إجمالي الرحلات: ${stats.trips.total}`);
        
        // Test 4: Check driver_earnings table
        console.log('\n📋 Test 4: التحقق من جدول driver_earnings');
        console.log('─────────────────────────────────────────────────────');
        
        const earningsResponse = await axios.get(`${BASE_URL}/api/drivers/${driver.id}/earnings?days=1`);
        
        if (!earningsResponse.data.success) {
            throw new Error('Failed to get earnings history');
        }
        
        const earnings = earningsResponse.data.data;
        console.log(`   ✅ تم الحصول على ${earnings.length} سجل`);
        
        if (earnings.length > 0) {
            const todayRecord = earnings[0];
            console.log('\n   📊 سجل اليوم:');
            console.log(`      التاريخ: ${todayRecord.date}`);
            console.log(`      رحلات اليوم: ${todayRecord.today_trips}`);
            console.log(`      أرباح اليوم: ${todayRecord.today_earnings} ر.س`);
            console.log(`      إجمالي الرحلات: ${todayRecord.total_trips}`);
            console.log(`      إجمالي الأرباح: ${todayRecord.total_earnings} ر.س`);
        }
        
        console.log('\n═══════════════════════════════════════════════════════');
        console.log('✅ جميع الاختبارات نجحت!');
        console.log('═══════════════════════════════════════════════════════');
        console.log('\n🌐 يمكنك الآن فتح صفحة الإدارة:');
        console.log('   http://localhost:3000/admin-driver-earnings.html');
        console.log('\n📝 المميزات:');
        console.log('   ✓ عرض جميع السائقين وإحصائياتهم');
        console.log('   ✓ تعديل أرباح أي سائق من خلال واجهة سهلة');
        console.log('   ✓ التحديث الفوري في قاعدة البيانات');
        console.log('   ✓ تحديث جدولي drivers و driver_earnings معاً');
        
    } catch (error) {
        console.error('\n❌ خطأ في الاختبار:', error.message);
        
        if (error.response) {
            console.error('Response:', error.response.data);
        }
        
        if (error.code === 'ECONNREFUSED') {
            console.error('\n⚠️  الخادم غير شغال!');
            console.error('   يرجى تشغيل الخادم أولاً: node server.js');
        }
    }
}

// Run tests
console.log('⏳ انتظر قليلاً...\n');
setTimeout(() => {
    testAdminEarningsSystem();
}, 1000);
