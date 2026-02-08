const axios = require('axios');

const BASE_URL = 'http://localhost:3000';

async function testDriverEarnings() {
    console.log('🧪 اختبار نظام أرباح السائقين المحدّث\n');
    
    try {
        // 1. Get driver stats
        console.log('1️⃣ اختبار الحصول على إحصائيات السائق...');
        const statsResponse = await axios.get(`${BASE_URL}/api/drivers/2/stats`);
        
        if (statsResponse.data.success) {
            console.log('✅ نجح الحصول على الإحصائيات');
            console.log(`   الرصيد: ${statsResponse.data.data.earnings.balance} SAR`);
            console.log(`   أرباح اليوم: ${statsResponse.data.data.earnings.today} SAR`);
            console.log(`   إجمالي الأرباح: ${statsResponse.data.data.earnings.total} SAR`);
            console.log(`   إجمالي الرحلات: ${statsResponse.data.data.trips.total}`);
            console.log(`   رحلات اليوم: ${statsResponse.data.data.trips.today}`);
        } else {
            console.log('❌ فشل الحصول على الإحصائيات');
            return;
        }
        
        // 2. Check driver_earnings table
        console.log('\n2️⃣ فحص جدول driver_earnings...');
        const earningsResponse = await axios.get(`${BASE_URL}/api/drivers/2/earnings?days=30`);
        
        if (earningsResponse.data.success) {
            console.log(`✅ عدد السجلات في جدول الأرباح: ${earningsResponse.data.data.length}`);
            if (earningsResponse.data.data.length > 0) {
                console.log('\n   آخر 3 سجلات:');
                earningsResponse.data.data.slice(0, 3).forEach((record, index) => {
                    console.log(`   ${index + 1}. التاريخ: ${record.date}`);
                    console.log(`      رحلات اليوم: ${record.today_trips}`);
                    console.log(`      أرباح اليوم: ${record.today_earnings}`);
                    console.log(`      إجمالي الرحلات: ${record.total_trips}`);
                    console.log(`      إجمالي الأرباح: ${record.total_earnings}`);
                });
            }
        }
        
        // 3. Create a test trip
        console.log('\n3️⃣ إنشاء رحلة اختبارية...');
        const tripData = {
            user_id: 6,
            driver_id: 2,
            pickup_location: 'موقع الاختبار - البداية',
            dropoff_location: 'موقع الاختبار - النهاية',
            pickup_lat: 30.0444,
            pickup_lng: 31.2357,
            dropoff_lat: 30.0626,
            dropoff_lng: 31.2497,
            car_type: 'economy',
            cost: 95.25,
            distance: 15.3,
            duration: 24,
            payment_method: 'cash',
            status: 'pending'
        };
        
        const createResponse = await axios.post(`${BASE_URL}/api/trips`, tripData);
        
        if (createResponse.data.success) {
            const tripId = createResponse.data.data.id;
            console.log(`✅ تم إنشاء رحلة جديدة: ${tripId}`);
            
            // 4. Complete the trip
            console.log('\n4️⃣ إكمال الرحلة...');
            const completeResponse = await axios.patch(`${BASE_URL}/api/trips/${tripId}/status`, {
                status: 'completed',
                cost: 95.25
            });
            
            if (completeResponse.data.success) {
                console.log('✅ تم إكمال الرحلة بنجاح');
                
                // 5. Check updated stats and earnings table
                console.log('\n5️⃣ التحقق من تحديث الإحصائيات...');
                await new Promise(resolve => setTimeout(resolve, 1000)); // Wait 1 second
                
                const updatedStatsResponse = await axios.get(`${BASE_URL}/api/drivers/2/stats`);
                const updatedEarningsResponse = await axios.get(`${BASE_URL}/api/drivers/2/earnings?days=1`);
                
                if (updatedStatsResponse.data.success) {
                    const newEarnings = updatedStatsResponse.data.data.earnings;
                    const oldEarnings = statsResponse.data.data.earnings;
                    
                    console.log('✅ تم تحديث الإحصائيات:');
                    console.log(`   الرصيد السابق: ${oldEarnings.balance} SAR`);
                    console.log(`   الرصيد الجديد: ${newEarnings.balance} SAR`);
                    console.log(`   الفرق: +${(newEarnings.balance - oldEarnings.balance).toFixed(2)} SAR`);
                    console.log(`   أرباح اليوم: ${newEarnings.today} SAR`);
                    
                    if (updatedEarningsResponse.data.success && updatedEarningsResponse.data.data.length > 0) {
                        const todayRecord = updatedEarningsResponse.data.data[0];
                        console.log('\n✅ سجل اليوم في جدول driver_earnings:');
                        console.log(`   رحلات اليوم: ${todayRecord.today_trips}`);
                        console.log(`   أرباح اليوم: ${todayRecord.today_earnings}`);
                        console.log(`   إجمالي الرحلات: ${todayRecord.total_trips}`);
                        console.log(`   إجمالي الأرباح: ${todayRecord.total_earnings}`);
                    }
                    
                    if (newEarnings.balance > oldEarnings.balance) {
                        console.log('\n✅ ✅ ✅ جميع الاختبارات نجحت! ✅ ✅ ✅');
                        console.log('📊 جدول driver_earnings يعمل بشكل صحيح!');
                    } else {
                        console.log('\n❌ لم يتم تحديث الأرباح بشكل صحيح');
                    }
                }
            } else {
                console.log('❌ فشل إكمال الرحلة');
            }
        } else {
            console.log('❌ فشل إنشاء الرحلة');
        }
        
    } catch (error) {
        console.error('❌ خطأ في الاختبار:', error.message);
        if (error.response) {
            console.error('   الاستجابة:', error.response.data);
        }
    }
}

// Run tests
testDriverEarnings();
