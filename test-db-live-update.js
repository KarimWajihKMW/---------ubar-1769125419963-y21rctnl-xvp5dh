const axios = require('axios');
const pool = require('./db');

const BASE_URL = process.env.BASE_URL || 'http://localhost:3003';

async function testDirectDatabaseUpdate() {
    console.log('🧪 اختبار تحديث البيانات مباشرة من قاعدة البيانات\n');
    
    try {
        const driverId = 1;
        
        // Step 1: Get current stats from API
        console.log('📊 الخطوة 1: جلب البيانات الحالية من API...');
        const response1 = await axios.get(`${BASE_URL}/api/drivers/${driverId}/stats`);
        const currentStats = response1.data.data;
        
        console.log('البيانات الحالية:');
        console.log(`   إجمالي الأرباح: ${currentStats.earnings.total}`);
        console.log(`   الرصيد: ${currentStats.earnings.balance}`);
        console.log(`   أرباح اليوم: ${currentStats.earnings.today}`);
        console.log(`   رحلات اليوم: ${currentStats.trips.today}`);
        console.log(`   إجمالي الرحلات: ${currentStats.trips.total}`);
        
        // Step 2: Update database directly
        console.log('\n💾 الخطوة 2: تحديث البيانات مباشرة في قاعدة البيانات...');
        const newTodayEarnings = 500.75;
        const newTodayTrips = 15;
        const newBalance = parseFloat(currentStats.earnings.balance) + 100;
        
        await pool.query(`
            UPDATE drivers
            SET 
                today_earnings = $1,
                today_trips_count = $2,
                balance = $3
            WHERE id = $4
        `, [newTodayEarnings, newTodayTrips, newBalance, driverId]);
        
        console.log('✅ تم تحديث البيانات في قاعدة البيانات');
        console.log(`   أرباح اليوم الجديدة: ${newTodayEarnings}`);
        console.log(`   رحلات اليوم الجديدة: ${newTodayTrips}`);
        console.log(`   الرصيد الجديد: ${newBalance}`);
        
        // Step 3: Verify data in database
        console.log('\n🔍 الخطوة 3: التحقق من البيانات في قاعدة البيانات...');
        const dbResult = await pool.query(`
            SELECT today_earnings, today_trips_count, balance, total_earnings, total_trips
            FROM drivers
            WHERE id = $1
        `, [driverId]);
        
        console.log('البيانات في قاعدة البيانات:');
        console.table(dbResult.rows);
        
        // Step 4: Get stats from API again (should show updated values)
        console.log('\n📡 الخطوة 4: جلب البيانات من API مرة أخرى...');
        
        // Wait a moment to ensure no caching
        await new Promise(resolve => setTimeout(resolve, 100));
        
        const response2 = await axios.get(`${BASE_URL}/api/drivers/${driverId}/stats?t=${Date.now()}`, {
            headers: {
                'Cache-Control': 'no-cache',
                'Pragma': 'no-cache'
            }
        });
        const updatedStats = response2.data.data;
        
        console.log('البيانات من API بعد التحديث:');
        console.log(`   إجمالي الأرباح: ${updatedStats.earnings.total}`);
        console.log(`   الرصيد: ${updatedStats.earnings.balance}`);
        console.log(`   أرباح اليوم: ${updatedStats.earnings.today}`);
        console.log(`   رحلات اليوم: ${updatedStats.trips.today}`);
        console.log(`   إجمالي الرحلات: ${updatedStats.trips.total}`);
        
        // Step 5: Verify the changes
        console.log('\n✅ الخطوة 5: التحقق من التحديثات...');
        
        const balanceMatches = Math.abs(updatedStats.earnings.balance - newBalance) < 0.01;
        const todayEarningsMatches = Math.abs(updatedStats.earnings.today - newTodayEarnings) < 0.01;
        const todayTripsMatches = updatedStats.trips.today === newTodayTrips;
        
        console.log(`   الرصيد متطابق: ${balanceMatches ? '✅' : '❌'} (متوقع: ${newBalance}, فعلي: ${updatedStats.earnings.balance})`);
        console.log(`   أرباح اليوم متطابقة: ${todayEarningsMatches ? '✅' : '❌'} (متوقع: ${newTodayEarnings}, فعلي: ${updatedStats.earnings.today})`);
        console.log(`   رحلات اليوم متطابقة: ${todayTripsMatches ? '✅' : '❌'} (متوقع: ${newTodayTrips}, فعلي: ${updatedStats.trips.today})`);
        
        if (balanceMatches && todayEarningsMatches && todayTripsMatches) {
            console.log('\n✅✅✅ نجح الاختبار! التحديثات من قاعدة البيانات تظهر فوراً في API ✅✅✅');
        } else {
            console.log('\n❌ فشل الاختبار! بعض التحديثات لم تظهر بشكل صحيح');
        }
        
        // Step 6: Restore original values
        console.log('\n🔄 الخطوة 6: استعادة القيم الأصلية...');
        await pool.query(`
            UPDATE drivers
            SET 
                today_earnings = $1,
                today_trips_count = $2,
                balance = $3
            WHERE id = $4
        `, [currentStats.earnings.today, currentStats.trips.today, currentStats.earnings.balance, driverId]);
        
        console.log('✅ تم استعادة القيم الأصلية');
        
    } catch (error) {
        console.error('❌ خطأ في الاختبار:', error.message);
        if (error.response) {
            console.error('   Status:', error.response.status);
            console.error('   Data:', error.response.data);
        }
        process.exit(1);
    } finally {
        await pool.end();
    }
}

// Run test
testDirectDatabaseUpdate();
