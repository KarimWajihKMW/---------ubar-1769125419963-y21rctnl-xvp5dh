const pool = require('./db');

async function migrateDriverEarnings() {
    const client = await pool.connect();
    
    try {
        console.log('🔄 بدء تحديث جدول السائقين...');
        
        // إضافة الأعمدة الجديدة لجدول drivers
        console.log('📊 إضافة أعمدة الأرباح...');
        
        // إضافة عمود total_earnings (إجمالي الأرباح)
        await client.query(`
            ALTER TABLE drivers 
            ADD COLUMN IF NOT EXISTS total_earnings DECIMAL(10, 2) DEFAULT 0.00;
        `);
        console.log('✅ عمود total_earnings تم إضافته');
        
        // إضافة عمود balance (الرصيد)
        await client.query(`
            ALTER TABLE drivers 
            ADD COLUMN IF NOT EXISTS balance DECIMAL(10, 2) DEFAULT 0.00;
        `);
        console.log('✅ عمود balance تم إضافته');
        
        // إضافة عمود today_earnings (أرباح اليوم)
        await client.query(`
            ALTER TABLE drivers 
            ADD COLUMN IF NOT EXISTS today_earnings DECIMAL(10, 2) DEFAULT 0.00;
        `);
        console.log('✅ عمود today_earnings تم إضافته');
        
        // إضافة عمود today_trips_count (عدد رحلات اليوم)
        await client.query(`
            ALTER TABLE drivers 
            ADD COLUMN IF NOT EXISTS today_trips_count INTEGER DEFAULT 0;
        `);
        console.log('✅ عمود today_trips_count تم إضافته');
        
        // إضافة عمود last_earnings_update (آخر تحديث للأرباح)
        await client.query(`
            ALTER TABLE drivers 
            ADD COLUMN IF NOT EXISTS last_earnings_update DATE DEFAULT CURRENT_DATE;
        `);
        console.log('✅ عمود last_earnings_update تم إضافته');
        
        // إنشاء جدول driver_earnings لتتبع الأرباح اليومية
        console.log('📊 إنشاء جدول driver_earnings...');
        await client.query(`
            CREATE TABLE IF NOT EXISTS driver_earnings (
                id SERIAL PRIMARY KEY,
                driver_id INTEGER REFERENCES drivers(id) ON DELETE CASCADE,
                date DATE NOT NULL DEFAULT CURRENT_DATE,
                today_trips INTEGER DEFAULT 0,
                today_earnings DECIMAL(10, 2) DEFAULT 0.00,
                total_trips INTEGER DEFAULT 0,
                total_earnings DECIMAL(10, 2) DEFAULT 0.00,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                UNIQUE(driver_id, date)
            );
        `);
        console.log('✅ جدول driver_earnings تم إنشاؤه');
        
        // إنشاء index لتحسين الأداء
        await client.query(`
            CREATE INDEX IF NOT EXISTS idx_driver_earnings_driver_date 
            ON driver_earnings(driver_id, date DESC);
        `);
        console.log('✅ Index تم إنشاؤه');
        
        // حساب الأرباح الحالية من جدول trips
        console.log('💰 حساب الأرباح الحالية من الرحلات المكتملة...');
        
        await client.query(`
            UPDATE drivers d
            SET 
                total_earnings = COALESCE((
                    SELECT SUM(cost) 
                    FROM trips 
                    WHERE driver_id = d.id AND status = 'completed'
                ), 0),
                balance = COALESCE((
                    SELECT SUM(cost) 
                    FROM trips 
                    WHERE driver_id = d.id AND status = 'completed'
                ), 0),
                today_earnings = COALESCE((
                    SELECT SUM(cost) 
                    FROM trips 
                    WHERE driver_id = d.id 
                    AND status = 'completed'
                    AND DATE(completed_at) = CURRENT_DATE
                ), 0),
                today_trips_count = COALESCE((
                    SELECT COUNT(*) 
                    FROM trips 
                    WHERE driver_id = d.id 
                    AND status = 'completed'
                    AND DATE(completed_at) = CURRENT_DATE
                ), 0)
        `);
        console.log('✅ تم حساب الأرباح لجميع السائقين');
        
        // ملء جدول driver_earnings بالبيانات الحالية
        console.log('📝 ملء جدول driver_earnings...');
        await client.query(`
            INSERT INTO driver_earnings (driver_id, date, today_trips, today_earnings, total_trips, total_earnings)
            SELECT 
                id as driver_id,
                CURRENT_DATE as date,
                today_trips_count as today_trips,
                today_earnings,
                total_trips,
                total_earnings
            FROM drivers
            ON CONFLICT (driver_id, date) 
            DO UPDATE SET
                today_trips = EXCLUDED.today_trips,
                today_earnings = EXCLUDED.today_earnings,
                total_trips = EXCLUDED.total_trips,
                total_earnings = EXCLUDED.total_earnings,
                updated_at = CURRENT_TIMESTAMP
        `);
        console.log('✅ جدول driver_earnings تم ملؤه');
        
        // عرض ملخص للسائقين
        const driversResult = await client.query(`
            SELECT 
                id, 
                name, 
                total_trips,
                total_earnings,
                today_trips_count,
                today_earnings,
                balance
            FROM drivers
            ORDER BY id
            LIMIT 10
        `);
        
        console.log('\n📊 ملخص السائقين:');
        console.table(driversResult.rows);
        
        console.log('\n✅ تم تحديث قاعدة البيانات بنجاح!');
        
    } catch (error) {
        console.error('❌ خطأ في التحديث:', error);
        throw error;
    } finally {
        client.release();
        await pool.end();
    }
}

// تشغيل التحديث
migrateDriverEarnings().catch(err => {
    console.error('❌ فشل التحديث:', err);
    process.exit(1);
});
