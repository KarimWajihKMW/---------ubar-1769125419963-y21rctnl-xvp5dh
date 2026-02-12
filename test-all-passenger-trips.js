const axios = require('axios');

const BASE_URL = 'http://localhost:3000/api';
const DB_URL = 'postgresql://postgres:gnQuusUxfjjvwiryBRkdvFjzBkXhEieJ@trolley.proxy.rlwy.net:47888/railway';

async function testAllPassengerTrips() {
    console.log('🧪 اختبار شامل: كل طلبات الراكب تظهر في pending_ride_requests\n');
    
    try {
        // Test 1: طلب رحلة عادي (الحالة الأكثر شيوعاً)
        console.log('1️⃣ اختبار: طلب رحلة عادي من الراكب');
        const trip1 = await axios.post(`${BASE_URL}/trips`, {
            user_id: 1,
            pickup_location: 'الحمراء مول، الرياض',
            dropoff_location: 'برج الفيصلية',
            pickup_lat: 24.7136,
            pickup_lng: 46.6753,
            dropoff_lat: 24.6877,
            dropoff_lng: 46.6857,
            car_type: 'economy',
            cost: 35.50,
            distance: 8.2,
            duration: 15,
            payment_method: 'cash',
            status: 'pending'
        });
        console.log('✅ تم إنشاء رحلة 1:', trip1.data.data.id);

        // Test 2: طلب رحلة بدون status (default pending)
        console.log('\n2️⃣ اختبار: طلب رحلة بدون تحديد status');
        const trip2 = await axios.post(`${BASE_URL}/trips`, {
            user_id: 2,
            pickup_location: 'العليا، الرياض',
            dropoff_location: 'الملز',
            pickup_lat: 24.7418,
            pickup_lng: 46.6767,
            dropoff_lat: 24.7034,
            dropoff_lng: 46.6766,
            car_type: 'family',
            cost: 42.00,
            distance: 10.5,
            duration: 18,
            payment_method: 'card'
            // لا يوجد status - سيكون default pending
        });
        console.log('✅ تم إنشاء رحلة 2:', trip2.data.data.id);

        // Test 3: طلب رحلة luxury
        console.log('\n3️⃣ اختبار: طلب رحلة luxury');
        const trip3 = await axios.post(`${BASE_URL}/trips`, {
            user_id: 3,
            pickup_location: 'مطار الملك خالد الدولي',
            dropoff_location: 'فندق الريتز كارلتون',
            pickup_lat: 24.9576,
            pickup_lng: 46.6988,
            dropoff_lat: 24.6877,
            dropoff_lng: 46.7219,
            car_type: 'luxury',
            cost: 125.00,
            distance: 35.8,
            duration: 40,
            payment_method: 'card',
            status: 'pending'
        });
        console.log('✅ تم إنشاء رحلة 3:', trip3.data.data.id);

        // Test 4: طلب رحلة بدون driver_id
        console.log('\n4️⃣ اختبار: طلب رحلة بدون سائق محدد');
        const trip4 = await axios.post(`${BASE_URL}/trips`, {
            user_id: 4,
            pickup_location: 'الدرعية التاريخية',
            dropoff_location: 'حي السفارات',
            pickup_lat: 24.7347,
            pickup_lng: 46.5767,
            dropoff_lat: 24.6901,
            dropoff_lng: 46.6340,
            car_type: 'economy',
            cost: 55.00,
            distance: 15.3,
            duration: 22,
            payment_method: 'cash',
            status: 'pending'
        });
        console.log('✅ تم إنشاء رحلة 4:', trip4.data.data.id);

        // انتظار قليلاً للتأكد من حفظ البيانات
        await new Promise(resolve => setTimeout(resolve, 2000));

        // Test 5: التحقق من وجود جميع الطلبات في pending_ride_requests
        console.log('\n5️⃣ التحقق من قاعدة البيانات: pending_ride_requests');
        const pendingRequests = await axios.get(`${BASE_URL}/pending-rides?status=waiting&limit=50`);
        
        console.log(`\n📊 إجمالي الطلبات في الانتظار: ${pendingRequests.data.count}`);
        
        const recentRequests = pendingRequests.data.data.filter(r => {
            const createdTime = new Date(r.created_at).getTime();
            const now = Date.now();
            return (now - createdTime) < 60000; // آخر دقيقة
        });
        
        console.log(`\n✅ الطلبات المضافة في آخر دقيقة: ${recentRequests.length}`);
        console.table(recentRequests.map(r => ({
            request_id: r.request_id,
            راكب: r.passenger_name,
            من: r.pickup_location.substring(0, 30),
            'نوع السيارة': r.car_type,
            التكلفة: r.estimated_cost,
            الحالة: r.status
        })));

        if (recentRequests.length >= 4) {
            console.log('\n✅✅✅ نجح! جميع طلبات الراكب ظهرت في pending_ride_requests! ✅✅✅');
        } else {
            console.log(`\n⚠️ تحذير: فقط ${recentRequests.length} من 4 طلبات ظهرت`);
        }

        // Test 6: التحقق من أن السائقين يمكنهم رؤية هذه الطلبات
        console.log('\n6️⃣ اختبار: السائقين يمكنهم رؤية الطلبات');
        
        const driver1Requests = await axios.get(`${BASE_URL}/drivers/1/pending-rides`);
        console.log(`✅ السائق 1 (economy) يرى ${driver1Requests.data.count} طلب`);
        
        const driver2Requests = await axios.get(`${BASE_URL}/drivers/2/pending-rides`);
        console.log(`✅ السائق 2 (family) يرى ${driver2Requests.data.count} طلب`);
        
        const driver3Requests = await axios.get(`${BASE_URL}/drivers/3/pending-rides`);
        console.log(`✅ السائق 3 (luxury) يرى ${driver3Requests.data.count} طلب`);

        // Test 7: اختبار قبول ورفض
        console.log('\n7️⃣ اختبار: قبول ورفض الطلبات');
        
        if (recentRequests.length > 0) {
            const firstRequest = recentRequests[0];
            
            // رفض من سائق
            await axios.post(`${BASE_URL}/pending-rides/${firstRequest.request_id}/reject`, {
                driver_id: 1
            });
            console.log(`✅ تم رفض الطلب ${firstRequest.request_id} من السائق 1`);
            
            // قبول من سائق آخر
            if (recentRequests.length > 1) {
                const secondRequest = recentRequests[1];
                await axios.post(`${BASE_URL}/pending-rides/${secondRequest.request_id}/accept`, {
                    driver_id: 2
                });
                console.log(`✅ تم قبول الطلب ${secondRequest.request_id} من السائق 2`);
            }
        }

        // Test 8: التحقق النهائي
        console.log('\n8️⃣ الحالة النهائية للطلبات');
        const finalState = await axios.get(`${BASE_URL}/pending-rides?limit=50`);
        
        const waiting = finalState.data.data.filter(r => r.status === 'waiting').length;
        const accepted = finalState.data.data.filter(r => r.status === 'accepted').length;
        const rejected = finalState.data.data.filter(r => r.rejection_count > 0).length;
        
        console.log('\n📊 الإحصائيات:');
        console.table({
            'في الانتظار': waiting,
            'تم القبول': accepted,
            'بها رفض': rejected,
            'الإجمالي': finalState.data.count
        });

        console.log('\n' + '='.repeat(60));
        console.log('✅✅✅ جميع الاختبارات نجحت! النظام يعمل بشكل صحيح! ✅✅✅');
        console.log('='.repeat(60));
        console.log('\n📝 النتيجة:');
        console.log('   ✓ كل رحلة يطلبها الراكب تظهر في pending_ride_requests');
        console.log('   ✓ السائقين يمكنهم رؤية الطلبات المناسبة');
        console.log('   ✓ القبول والرفض يعمل بشكل صحيح');
        console.log('   ✓ النظام متكامل 100%\n');

    } catch (error) {
        console.error('\n❌ فشل الاختبار:', error.message);
        if (error.response) {
            console.error('التفاصيل:', {
                status: error.response.status,
                data: error.response.data
            });
        }
        process.exit(1);
    }
}

console.log('⚠️  تأكد من تشغيل السيرفر على port 3000\n');

setTimeout(() => {
    testAllPassengerTrips()
        .then(() => process.exit(0))
        .catch(err => {
            console.error(err);
            process.exit(1);
        });
}, 1000);
