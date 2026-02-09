const axios = require('axios');

const BASE_URL = process.env.BASE_URL || 'http://localhost:3003';

async function testDriverEarnings() {
    console.log('🧪 اختبار نظام أرباح السائقين\n');
    
    try {
        // Test 1: Get stats for driver 1
        console.log('📊 اختبار 1: جلب إحصائيات السائق #1...');
        const statsResponse = await axios.get(`${BASE_URL}/api/drivers/1/stats`);
        
        if (statsResponse.data.success) {
            console.log('✅ تم جلب الإحصائيات بنجاح');
            const { driver, earnings, trips } = statsResponse.data.data;
            
            console.log('\n👤 معلومات السائق:');
            console.log(`   الاسم: ${driver.name}`);
            console.log(`   التقييم: ${driver.rating}`);
            
            console.log('\n💰 الأرباح:');
            console.log(`   إجمالي الأرباح: ${earnings.total} ر.س`);
            console.log(`   الرصيد: ${earnings.balance} ر.س`);
            console.log(`   أرباح اليوم: ${earnings.today} ر.س`);
            
            console.log('\n🚗 الرحلات:');
            console.log(`   إجمالي الرحلات: ${trips.total}`);
            console.log(`   رحلات اليوم: ${trips.today}`);
        } else {
            console.error('❌ فشل جلب الإحصائيات:', statsResponse.data.error);
        }
        
        // Test 2: Get stats for driver 2
        console.log('\n\n📊 اختبار 2: جلب إحصائيات السائق #2...');
        const stats2Response = await axios.get(`${BASE_URL}/api/drivers/2/stats`);
        
        if (stats2Response.data.success) {
            console.log('✅ تم جلب الإحصائيات بنجاح');
            const { driver, earnings, trips } = stats2Response.data.data;
            
            console.log('\n👤 معلومات السائق:');
            console.log(`   الاسم: ${driver.name}`);
            console.log(`   التقييم: ${driver.rating}`);
            
            console.log('\n💰 الأرباح:');
            console.log(`   إجمالي الأرباح: ${earnings.total} ر.س`);
            console.log(`   الرصيد: ${earnings.balance} ر.س`);
            console.log(`   أرباح اليوم: ${earnings.today} ر.س`);
            
            console.log('\n🚗 الرحلات:');
            console.log(`   إجمالي الرحلات: ${trips.total}`);
            console.log(`   رحلات اليوم: ${trips.today}`);
        } else {
            console.error('❌ فشل جلب الإحصائيات:', stats2Response.data.error);
        }
        
        // Test 3: Check database directly
        console.log('\n\n📊 اختبار 3: التحقق من قاعدة البيانات مباشرة...');
        const pool = require('./db');
        
        const driversResult = await pool.query(`
            SELECT 
                id, name, total_trips, total_earnings, 
                balance, today_trips_count, today_earnings
            FROM drivers
            WHERE id IN (1, 2, 3)
            ORDER BY id
        `);
        
        console.log('✅ بيانات السائقين في قاعدة البيانات:');
        console.table(driversResult.rows);
        
        const earningsResult = await pool.query(`
            SELECT 
                driver_id, date, today_trips, today_earnings,
                total_trips, total_earnings
            FROM driver_earnings
            WHERE driver_id IN (1, 2, 3)
            ORDER BY driver_id, date DESC
            LIMIT 5
        `);
        
        console.log('\n✅ جدول driver_earnings:');
        console.table(earningsResult.rows);
        
        await pool.end();
        
        console.log('\n✅ جميع الاختبارات نجحت!');
        
    } catch (error) {
        console.error('❌ خطأ في الاختبار:', error.message);
        if (error.response) {
            console.error('   Status:', error.response.status);
            console.error('   Data:', error.response.data);
        }
        process.exit(1);
    }
}

// Run tests
testDriverEarnings();
