// Test script for API endpoints
const baseURL = process.env.API_BASE_URL || 'http://localhost:3000/api';
const originURL = baseURL.endsWith('/api') ? baseURL.slice(0, -4) : baseURL;

async function testAPI() {
    console.log('🧪 Testing Akwadra API Endpoints\n');
    
    try {
        // Test 1: Health check
        console.log('1️⃣ Testing health endpoint...');
        let response = await fetch(`${baseURL}/health`);
        let data = await response.json();
        console.log('✅ Health:', data);
        
        // Test 2: Database health check
        console.log('\n2️⃣ Testing database health endpoint...');
        response = await fetch(`${baseURL}/db/health`);
        data = await response.json();
        console.log('✅ DB Health:', data);

        // Test 2️⃣b: Get active offers
        console.log('\n2️⃣b Testing offers endpoint...');
        response = await fetch(`${baseURL}/offers?active=1`);
        data = await response.json();
        console.log(`✅ Active offers: ${data.count}`);

        // Test 2️⃣c: Validate offer code
        console.log('\n2️⃣c Testing offer validation...');
        response = await fetch(`${baseURL}/offers/validate?code=WELCOME20`);
        data = await response.json();
        console.log('✅ Offer validate:', data.data?.code || 'not found');

        // Test 3: Get all trips
        console.log('\n3️⃣ Testing get all trips...');
        response = await fetch(`${baseURL}/trips`);
        data = await response.json();
        console.log(`✅ Total trips: ${data.total}`);
        console.log(`   First trip:`, data.data[0]);

        // Test 4: Get completed trips
        console.log('\n4️⃣ Testing get completed trips...');
        response = await fetch(`${baseURL}/trips/completed`);
        data = await response.json();
        console.log(`✅ Completed trips: ${data.count}`);

        // Test 5: Get cancelled trips
        console.log('\n5️⃣ Testing get cancelled trips...');
        response = await fetch(`${baseURL}/trips/cancelled`);
        data = await response.json();
        console.log(`✅ Cancelled trips: ${data.count}`);

        // Test 6: Get trip statistics
        console.log('\n6️⃣ Testing trip statistics...');
        response = await fetch(`${baseURL}/trips/stats/summary?source=passenger_app`);
        data = await response.json();
        console.log('✅ Stats:', data.data);

        // Test 7: Get users
        console.log('\n7️⃣ Testing get users...');
        response = await fetch(`${baseURL}/users`);
        data = await response.json();
        console.log(`✅ Total users: ${data.total}`);

        // Test 8: Create a new trip
        console.log('\n8️⃣ Testing create new trip...');
        const newTrip = {
            user_id: 3,
            pickup_location: 'شارع التحلية، الرياض',
            dropoff_location: 'العليا مول',
            pickup_lat: 24.7136,
            pickup_lng: 46.6753,
            pickup_accuracy: 8.5,
            pickup_timestamp: Date.now(),
            dropoff_lat: 24.6917,
            dropoff_lng: 46.6853,
            car_type: 'economy',
            cost: 45.50,
            distance: 10.5,
            duration: 20,
            payment_method: 'card',
            source: 'passenger_app'
        };
        
        response = await fetch(`${baseURL}/trips`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(newTrip)
        });
        data = await response.json();
        console.log('✅ Created trip:', data.data.id);
        
        const createdTripId = data.data.id;

        // Test 8️⃣b: Update pickup location (GPS live update)
        console.log('\n8️⃣b Testing pickup live update endpoint...');
        const pickupUpdate = {
            pickup_lat: 24.71361,
            pickup_lng: 46.67531,
            pickup_accuracy: 6.2,
            pickup_timestamp: Date.now(),
            source: 'test-api'
        };
        response = await fetch(`${baseURL}/trips/${createdTripId}/pickup`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(pickupUpdate)
        });
        data = await response.json();
        console.log('✅ Pickup updated:', data.data);

        // Test 9: Get next pending trip (nearest by driver location)
        console.log('\n9️⃣ Testing get next pending trip...');
        response = await fetch(`${baseURL}/trips/pending/next?car_type=economy&lat=24.7136&lng=46.6753`);
        data = await response.json();
        console.log('✅ Pending trip:', data.data?.id || 'none');

        // Test 1️⃣0️⃣: Assign driver to trip
        console.log('\n1️⃣0️⃣ Testing assign driver to trip...');
        response = await fetch(`${baseURL}/trips/${createdTripId}/assign`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ driver_id: 1, driver_name: 'أحمد عبدالله المالكي' })
        });
        data = await response.json();
        console.log('✅ Assigned trip status:', data.data.status);

        // Test 1️⃣1️⃣: Start trip (status=ongoing + trip_status=started)
        console.log('\n1️⃣1️⃣ Testing start trip (ongoing/started)...');
        response = await fetch(`${baseURL}/trips/${createdTripId}/status`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ status: 'ongoing', trip_status: 'started' })
        });
        data = await response.json();
        console.log('✅ Updated trip status:', data.data.status, 'trip_status:', data.data.trip_status);

        // Verify started
        response = await fetch(`${baseURL}/trips/${createdTripId}`);
        data = await response.json();
        console.log('✅ Trip after start:', { status: data.data.status, trip_status: data.data.trip_status });

        // Complete trip
        console.log('\n1️⃣1️⃣b Testing complete trip (completed/completed)...');
        response = await fetch(`${baseURL}/trips/${createdTripId}/status`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ status: 'completed', trip_status: 'completed' })
        });
        data = await response.json();
        console.log('✅ Trip completed:', data.data.status, 'trip_status:', data.data.trip_status);

        // Rate driver (new endpoint)
        console.log('\n1️⃣1️⃣c Testing POST /rate-driver ...');
        response = await fetch(`${originURL}/rate-driver`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ trip_id: createdTripId, rating: 5, comment: 'اختبار تقييم السائق' })
        });
        data = await response.json();
        console.log('✅ Rate driver:', {
            status: data.data?.status,
            trip_status: data.data?.trip_status,
            passenger_rating: data.data?.passenger_rating,
            passenger_review: data.data?.passenger_review
        });

        // Verify rider trip history includes the trip
        console.log('\n1️⃣1️⃣d Testing GET /rider/trips ...');
        response = await fetch(`${baseURL}/rider/trips?rider_id=3`);
        data = await response.json();
        const riderTrips = Array.isArray(data.data) ? data.data : [];
        console.log('✅ Rider trips fetched:', riderTrips.length);
        const riderHasTrip = riderTrips.some(t => t.id === createdTripId);
        console.log('   Contains created trip:', riderHasTrip ? '✅' : '❌');

        // Verify driver trip history includes the trip
        console.log('\n1️⃣1️⃣e Testing GET /driver/trips ...');
        response = await fetch(`${baseURL}/driver/trips?driver_id=1`);
        data = await response.json();
        const driverTrips = Array.isArray(data.data) ? data.data : [];
        console.log('✅ Driver trips fetched:', driverTrips.length);
        const driverHasTrip = driverTrips.some(t => t.id === createdTripId);
        console.log('   Contains created trip:', driverHasTrip ? '✅' : '❌');

        // Verify admin dashboard metrics
        console.log('\n1️⃣1️⃣f Testing admin dashboard metrics ...');
        response = await fetch(`${baseURL}/admin/dashboard/stats`);
        data = await response.json();
        console.log('✅ Admin stats keys:', Object.keys(data.data || {}).slice(0, 12));
        console.log('   total_trips:', data.data?.total_trips);
        console.log('   total_revenue:', data.data?.total_revenue);
        console.log('   total_drivers_earnings:', data.data?.total_drivers_earnings);
        console.log('   total_distance:', data.data?.total_distance);
        console.log('   trips_today:', data.data?.trips_today);
        console.log('   trips_this_month:', data.data?.trips_this_month);

        // Test 1️⃣2️⃣: Get single trip
        console.log('\n1️⃣2️⃣ Testing get single trip...');
        response = await fetch(`${baseURL}/trips/${createdTripId}`);
        data = await response.json();
        console.log('✅ Trip details:', data.data);

        // Test 1️⃣2️⃣b: Get live trip snapshot
        console.log('\n1️⃣2️⃣b Testing get live trip snapshot...');
        response = await fetch(`${baseURL}/trips/${createdTripId}/live`);
        data = await response.json();
        console.log('✅ Live trip snapshot:', {
            id: data.data?.id,
            status: data.data?.status,
            driver_id: data.data?.driver_id,
            driver_last_lat: data.data?.driver_last_lat,
            driver_last_lng: data.data?.driver_last_lng
        });

        // Test 1️⃣3️⃣: Reject pending trip
        console.log('\n1️⃣3️⃣ Testing reject pending trip...');
        const rejectTrip = {
            user_id: 3,
            pickup_location: 'طريق الملك عبدالله، الرياض',
            dropoff_location: 'النخيل مول',
            pickup_lat: 24.7510,
            pickup_lng: 46.7050,
            dropoff_lat: 24.7743,
            dropoff_lng: 46.7386,
            car_type: 'economy',
            cost: 32.00,
            distance: 8.2,
            duration: 15,
            payment_method: 'cash',
            source: 'passenger_app'
        };

        response = await fetch(`${baseURL}/trips`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(rejectTrip)
        });
        data = await response.json();
        const rejectTripId = data.data.id;

        response = await fetch(`${baseURL}/trips/${rejectTripId}/reject`, { method: 'PATCH' });
        data = await response.json();
        console.log('✅ Rejected trip status:', data.data.status);

        // Test 1️⃣4️⃣: Resolve driver profile (auto create)
        console.log('\n1️⃣4️⃣ Testing resolve driver profile (auto create)...');
        response = await fetch(`${baseURL}/drivers/resolve?email=driver1@ubar.sa&auto_create=1`);
        data = await response.json();
        console.log('✅ Resolved driver:', data.data?.id, data.data?.name);

        // Test 1️⃣4️⃣b: Auto-create driver profile for new email
        console.log('\n1️⃣4️⃣b Testing auto-create driver profile for new email...');
        const autoEmail = `autodriver_${Date.now()}@ubar.sa`;
        response = await fetch(`${baseURL}/drivers/resolve?email=${encodeURIComponent(autoEmail)}&auto_create=1`);
        data = await response.json();
        const autoDriverId = data.data?.id;
        console.log('✅ Auto-created driver:', autoDriverId, data.data?.email);

        // Test 1️⃣4️⃣c: Update driver location
        console.log('\n1️⃣4️⃣c Testing update driver location...');
        response = await fetch(`${baseURL}/drivers/${autoDriverId}/location`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ lat: 24.7136, lng: 46.6753 })
        });
        data = await response.json();
        console.log('✅ Driver location updated:', data.data?.id, data.data?.last_lat, data.data?.last_lng);

        // Test 1️⃣4️⃣d: Get driver location
        console.log('\n1️⃣4️⃣d Testing get driver location...');
        response = await fetch(`${baseURL}/drivers/${autoDriverId}/location`);
        data = await response.json();
        console.log('✅ Driver location fetched:', data.data?.last_lat, data.data?.last_lng);

        // Test 1️⃣4️⃣e: Get nearest driver
        console.log('\n1️⃣4️⃣e Testing get nearest driver...');
        response = await fetch(`${baseURL}/drivers/nearest?lat=24.7136&lng=46.6753`);
        data = await response.json();
        console.log('✅ Nearest driver:', data.data?.id || 'none');

        // Test 1️⃣5️⃣: Get available drivers
        console.log('\n1️⃣5️⃣ Testing get available drivers...');
        response = await fetch(`${baseURL}/drivers`);
        data = await response.json();
        console.log(`✅ Available drivers: ${data.data.length}`);
        
        console.log('\n🎉 All tests passed!');
        
    } catch (error) {
        console.error('❌ Test failed:', error.message);
    }
}

// Run tests
testAPI();
