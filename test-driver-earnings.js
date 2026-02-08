const axios = require('axios');

const BASE_URL = 'http://localhost:3000';

async function testDriverEarnings() {
    console.log('🧪 اختبار نظام أرباح السائقين\n');
    
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
        
        // 2. Create a test trip
        console.log('\n2️⃣ إنشاء رحلة اختبارية...');
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
            cost: 75.50,
            distance: 12.5,
            duration: 20,
            payment_method: 'cash',
            status: 'pending'
        };
        
        const createResponse = await axios.post(`${BASE_URL}/api/trips`, tripData);
        
        if (createResponse.data.success) {
            const tripId = createResponse.data.data.id;
            console.log(`✅ تم إنشاء رحلة جديدة: ${tripId}`);
            
            // 3. Complete the trip
            console.log('\n3️⃣ إكمال الرحلة...');
            const completeResponse = await axios.patch(`${BASE_URL}/api/trips/${tripId}/status`, {
                status: 'completed',
                cost: 75.50
            });
            
            if (completeResponse.data.success) {
                console.log('✅ تم إكمال الرحلة بنجاح');
                
                // 4. Check updated stats
                console.log('\n4️⃣ التحقق من تحديث الإحصائيات...');
                await new Promise(resolve => setTimeout(resolve, 1000)); // Wait 1 second
                
                const updatedStatsResponse = await axios.get(`${BASE_URL}/api/drivers/2/stats`);
                
                if (updatedStatsResponse.data.success) {
                    const newEarnings = updatedStatsResponse.data.data.earnings;
                    const oldEarnings = statsResponse.data.data.earnings;
                    
                    console.log('✅ تم تحديث الإحصائيات:');
                    console.log(`   الرصيد السابق: ${oldEarnings.balance} SAR`);
                    console.log(`   الرصيد الجديد: ${newEarnings.balance} SAR`);
                    console.log(`   الفرق: +${(newEarnings.balance - oldEarnings.balance).toFixed(2)} SAR`);
                    
                    if (newEarnings.balance > oldEarnings.balance) {
                        console.log('\n✅ ✅ ✅ جميع الاختبارات نجحت! ✅ ✅ ✅');
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
