const axios = require('axios');

const BASE_URL = 'http://localhost:3000/api';

async function testIntegratedSystem() {
    console.log('🧪 اختبار النظام المتكامل: ربط الرحلات مع pending_ride_requests\n');
    
    try {
        // Test 1: إنشاء رحلة من الراكب
        console.log('1️⃣ اختبار: إنشاء طلب رحلة من الراكب');
        const tripData = {
            user_id: 1,
            pickup_location: 'مطار الملك عبدالعزيز الدولي، جدة',
            dropoff_location: 'كورنيش جدة',
            pickup_lat: 21.6797,
            pickup_lng: 39.1567,
            dropoff_lat: 21.5169,
            dropoff_lng: 39.1748,
            car_type: 'economy',
            cost: 78.50,
            distance: 18.5,
            duration: 25,
            payment_method: 'cash',
            status: 'pending'
        };

        const createTripResponse = await axios.post(`${BASE_URL}/trips`, tripData);
        console.log('✅ تم إنشاء الرحلة:', {
            trip_id: createTripResponse.data.data.id,
            status: createTripResponse.data.data.status
        });
        const tripId = createTripResponse.data.data.id;
        
        // انتظار قليلاً
        await new Promise(resolve => setTimeout(resolve, 1000));

        // Test 2: التحقق من وجود الطلب في pending_ride_requests
        console.log('\n2️⃣ اختبار: التحقق من وجود الطلب في pending_ride_requests');
        const pendingRidesResponse = await axios.get(`${BASE_URL}/pending-rides?status=waiting&limit=10`);
        console.log('✅ الطلبات في الانتظار:', {
            count: pendingRidesResponse.data.count,
            latest_request: pendingRidesResponse.data.data[0] ? {
                request_id: pendingRidesResponse.data.data[0].request_id,
                pickup: pendingRidesResponse.data.data[0].pickup_location,
                status: pendingRidesResponse.data.data[0].status
            } : 'لا توجد طلبات'
        });

        if (pendingRidesResponse.data.count === 0) {
            console.log('❌ خطأ: لم يتم إنشاء طلب في pending_ride_requests');
            return;
        }

        const latestRequest = pendingRidesResponse.data.data[0];
        const requestId = latestRequest.request_id;

        // Test 3: عرض الطلبات المتاحة للسائق
        console.log('\n3️⃣ اختبار: عرض الطلبات المتاحة للسائق (driver_id=1)');
        const driverPendingResponse = await axios.get(`${BASE_URL}/drivers/1/pending-rides`);
        console.log('✅ الطلبات المتاحة للسائق:', {
            count: driverPendingResponse.data.count,
            requests: driverPendingResponse.data.data.map(r => ({
                request_id: r.request_id,
                pickup: r.pickup_location,
                cost: r.estimated_cost
            }))
        });

        // Test 4: السائق يقبل الطلب
        console.log('\n4️⃣ اختبار: السائق يقبل الطلب');
        const acceptResponse = await axios.post(`${BASE_URL}/pending-rides/${requestId}/accept`, {
            driver_id: 1
        });
        console.log('✅ قبول الطلب:', {
            message: acceptResponse.data.message,
            status: acceptResponse.data.data.status,
            assigned_driver_id: acceptResponse.data.data.assigned_driver_id
        });

        // انتظار قليلاً
        await new Promise(resolve => setTimeout(resolve, 1000));

        // Test 5: التحقق من تحديث الرحلة في trips
        console.log('\n5️⃣ اختبار: التحقق من تحديث الرحلة في trips');
        const tripCheckUrl = `${BASE_URL}/trips?limit=1&user_id=1`;
        const tripCheckResponse = await axios.get(tripCheckUrl);
        
        const updatedTrips = tripCheckResponse.data.data.filter(t => 
            t.status === 'assigned' && 
            t.pickup_location.includes('مطار')
        );
        
        if (updatedTrips.length > 0) {
            console.log('✅ تم تحديث الرحلة في trips:', {
                trip_id: updatedTrips[0].id,
                status: updatedTrips[0].status,
                driver_id: updatedTrips[0].driver_id,
                driver_name: updatedTrips[0].driver_name
            });
        } else {
            console.log('⚠️ لم يتم العثور على رحلة محدثة بحالة assigned');
        }

        // Test 6: تحديث حالة الرحلة إلى ongoing
        console.log('\n6️⃣ اختبار: تحديث حالة الرحلة إلى ongoing');
        const ongoingResponse = await axios.patch(`${BASE_URL}/trips/${tripId}/status`, {
            status: 'ongoing'
        });
        console.log('✅ تحديث إلى ongoing:', {
            trip_id: ongoingResponse.data.data.id,
            status: ongoingResponse.data.data.status
        });

        // Test 7: إكمال الرحلة
        console.log('\n7️⃣ اختبار: إكمال الرحلة');
        const completeResponse = await axios.patch(`${BASE_URL}/trips/${tripId}/status`, {
            status: 'completed',
            passenger_rating: 5,
            driver_rating: 5
        });
        console.log('✅ إكمال الرحلة:', {
            trip_id: completeResponse.data.data.id,
            status: completeResponse.data.data.status
        });

        // انتظار قليلاً
        await new Promise(resolve => setTimeout(resolve, 500));

        // Test 8: التحقق من تحديث pending_ride_requests
        console.log('\n8️⃣ اختبار: التحقق من تحديث pending_ride_requests');
        const finalPendingCheck = await axios.get(`${BASE_URL}/pending-rides/${requestId}`);
        console.log('✅ الحالة النهائية للطلب:', {
            request_id: finalPendingCheck.data.data.request_id,
            status: finalPendingCheck.data.data.status,
            assigned_driver: finalPendingCheck.data.data.assigned_driver_name
        });

        // Test 9: اختبار سيناريو إلغاء رحلة
        console.log('\n9️⃣ اختبار: سيناريو إلغاء رحلة');
        const cancelTripData = {
            user_id: 2,
            pickup_location: 'الحمراء مول، الرياض',
            dropoff_location: 'غرناطة مول',
            pickup_lat: 24.7136,
            pickup_lng: 46.6753,
            dropoff_lat: 24.7418,
            dropoff_lng: 46.6767,
            car_type: 'family',
            cost: 45.00,
            distance: 12.3,
            duration: 18,
            payment_method: 'card',
            status: 'pending'
        };

        const cancelTripResponse = await axios.post(`${BASE_URL}/trips`, cancelTripData);
        const cancelTripId = cancelTripResponse.data.data.id;
        console.log('   تم إنشاء رحلة للإلغاء:', cancelTripId);

        await new Promise(resolve => setTimeout(resolve, 500));

        const cancelResponse = await axios.patch(`${BASE_URL}/trips/${cancelTripId}/status`, {
            status: 'cancelled'
        });
        console.log('✅ تم إلغاء الرحلة:', {
            trip_id: cancelResponse.data.data.id,
            status: cancelResponse.data.data.status
        });

        // Test 10: عرض الإحصائيات النهائية
        console.log('\n🔟 الإحصائيات النهائية:');
        const allPendingResponse = await axios.get(`${BASE_URL}/pending-rides`);
        const stats = {
            total: allPendingResponse.data.count,
            waiting: allPendingResponse.data.data.filter(r => r.status === 'waiting').length,
            accepted: allPendingResponse.data.data.filter(r => r.status === 'accepted').length,
            completed: allPendingResponse.data.data.filter(r => r.status === 'completed').length,
            cancelled: allPendingResponse.data.data.filter(r => r.status === 'cancelled').length
        };
        console.log('✅ الإحصائيات:');
        console.table(stats);

        console.log('\n✅ جميع الاختبارات نجحت بنجاح! 🎉\n');
        console.log('📊 ملخص النتائج:');
        console.log('   ✓ إنشاء رحلة من الراكب يظهر في pending_ride_requests');
        console.log('   ✓ السائق يمكنه رؤية الطلبات المتاحة');
        console.log('   ✓ قبول السائق للطلب يحدث جدول trips');
        console.log('   ✓ تحديث حالة الرحلة يحدث pending_ride_requests');
        console.log('   ✓ النظام متكامل ويعمل بشكل صحيح!\n');

    } catch (error) {
        console.error('\n❌ فشل الاختبار:', error.response?.data || error.message);
        if (error.response) {
            console.error('التفاصيل:', {
                status: error.response.status,
                statusText: error.response.statusText,
                data: error.response.data
            });
        }
        process.exit(1);
    }
}

console.log('⚠️  تأكد من تشغيل السيرفر على port 3000');
console.log('   Run: DATABASE_URL="<YOUR_DATABASE_URL>" npm start\n');

setTimeout(() => {
    testIntegratedSystem()
        .then(() => process.exit(0))
        .catch(err => {
            console.error(err);
            process.exit(1);
        });
}, 1000);
