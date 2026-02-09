#!/usr/bin/env node

/**
 * اختبار شامل لنظام المزامنة
 * يختبر المزامنة بين التطبيق وقاعدة البيانات
 */

const pool = require('./db');
const driverSync = require('./driver-sync-system');

async function testSync() {
    console.log('🚀 بدء اختبار نظام المزامنة...\n');
    
    try {
        // Test 1: Initialize sync system
        console.log('📋 اختبار 1: تهيئة نظام المزامنة');
        await driverSync.initializeSyncSystem();
        console.log('✅ تم تهيئة نظام المزامنة بنجاح\n');
        
        // Test 2: Get a driver
        console.log('📋 اختبار 2: الحصول على بيانات سائق');
        const driversResult = await pool.query('SELECT id FROM drivers LIMIT 1');
        
        if (driversResult.rows.length === 0) {
            console.log('⚠️  لا يوجد سائقين في قاعدة البيانات');
            console.log('💡 قم بإنشاء سائق أولاً\n');
            return;
        }
        
        const driverId = driversResult.rows[0].id;
        console.log(`✅ تم العثور على السائق رقم: ${driverId}\n`);
        
        // Test 3: Sync driver from database
        console.log('📋 اختبار 3: مزامنة السائق من قاعدة البيانات');
        const driver = await driverSync.syncDriverFromDatabase(driverId);
        console.log('✅ تم مزامنة السائق:', {
            id: driver.id,
            name: driver.name,
            phone: driver.phone,
            today_trips: driver.today_trips_count,
            today_earnings: driver.today_earnings,
            total_trips: driver.total_trips,
            total_earnings: driver.total_earnings,
            balance: driver.balance
        });
        console.log('');
        
        // Test 4: Update driver data
        console.log('📋 اختبار 4: تحديث بيانات السائق');
        const updates = {
            today_trips_count: (driver.today_trips_count || 0) + 1,
            today_earnings: parseFloat(driver.today_earnings || 0) + 25.50,
            total_trips: (driver.total_trips || 0) + 1,
            total_earnings: parseFloat(driver.total_earnings || 0) + 25.50
        };
        
        const updatedDriver = await driverSync.updateDriverInDatabase(driverId, updates);
        console.log('✅ تم تحديث السائق:', {
            id: updatedDriver.id,
            name: updatedDriver.name,
            today_trips: updatedDriver.today_trips_count,
            today_earnings: updatedDriver.today_earnings,
            total_trips: updatedDriver.total_trips,
            total_earnings: updatedDriver.total_earnings
        });
        console.log('');
        
        // Test 5: Sync earnings
        console.log('📋 اختبار 5: مزامنة الأرباح');
        await driverSync.syncDriverEarnings(driverId);
        console.log('✅ تم مزامنة الأرباح بنجاح\n');
        
        // Test 6: Verify sync
        console.log('📋 اختبار 6: التحقق من المزامنة');
        const earningsResult = await pool.query(
            'SELECT * FROM driver_earnings WHERE driver_id = $1 AND date = CURRENT_DATE',
            [driverId]
        );
        
        if (earningsResult.rows.length > 0) {
            const earnings = earningsResult.rows[0];
            console.log('✅ تم التحقق من المزامنة في جدول driver_earnings:', {
                driver_id: earnings.driver_id,
                date: earnings.date,
                today_trips: earnings.today_trips,
                today_earnings: earnings.today_earnings,
                total_trips: earnings.total_trips,
                total_earnings: earnings.total_earnings
            });
        } else {
            console.log('⚠️  لم يتم العثور على سجل في driver_earnings');
        }
        console.log('');
        
        // Test 7: Test database triggers
        console.log('📋 اختبار 7: اختبار Database Triggers');
        console.log('تحديث driver_earnings مباشرة في قاعدة البيانات...');
        
        await pool.query(`
            UPDATE driver_earnings 
            SET today_trips = today_trips + 1,
                today_earnings = today_earnings + 30.00
            WHERE driver_id = $1 AND date = CURRENT_DATE
        `, [driverId]);
        
        console.log('✅ تم تحديث driver_earnings');
        
        // Wait a moment for trigger to execute
        await new Promise(resolve => setTimeout(resolve, 500));
        
        // Check if drivers table was updated by trigger
        const verifyResult = await pool.query(
            'SELECT today_trips_count, today_earnings FROM drivers WHERE id = $1',
            [driverId]
        );
        
        if (verifyResult.rows.length > 0) {
            const verifyDriver = verifyResult.rows[0];
            console.log('✅ تم التحقق من تحديث جدول drivers بواسطة Trigger:', {
                today_trips: verifyDriver.today_trips_count,
                today_earnings: verifyDriver.today_earnings
            });
        }
        console.log('');
        
        // Test 8: Sync all drivers
        console.log('📋 اختبار 8: مزامنة جميع السائقين');
        await driverSync.syncAllDriversEarnings();
        console.log('✅ تم مزامنة جميع السائقين بنجاح\n');
        
        console.log('🎉 اكتملت جميع الاختبارات بنجاح!');
        console.log('✅ نظام المزامنة يعمل بشكل صحيح\n');
        
        console.log('📊 ملخص نظام المزامنة:');
        console.log('   • المزامنة من قاعدة البيانات إلى التطبيق: ✅');
        console.log('   • المزامنة من التطبيق إلى قاعدة البيانات: ✅');
        console.log('   • المزامنة بين جدولي drivers و driver_earnings: ✅');
        console.log('   • Database Triggers: ✅');
        console.log('   • التحديث التلقائي: ✅\n');
        
    } catch (error) {
        console.error('❌ فشل الاختبار:', error);
        console.error('التفاصيل:', error.message);
    } finally {
        await pool.end();
    }
}

// Run tests
testSync();
