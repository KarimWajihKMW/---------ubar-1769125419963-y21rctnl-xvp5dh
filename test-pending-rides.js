const axios = require('axios');

const BASE_URL = 'http://localhost:3000/api';

// Test data
const testRideRequest = {
    user_id: 1,
    passenger_name: 'أحمد محمد',
    passenger_phone: '0551234567',
    pickup_location: 'مطار الملك خالد الدولي',
    dropoff_location: 'برج المملكة، الرياض',
    pickup_lat: 24.9576,
    pickup_lng: 46.6988,
    dropoff_lat: 24.7110,
    dropoff_lng: 46.6750,
    car_type: 'economy',
    estimated_cost: 95.50,
    estimated_distance: 35.2,
    estimated_duration: 45,
    payment_method: 'cash',
    notes: 'من فضلك كن في الموعد'
};

async function runTests() {
    console.log('🧪 Starting Pending Ride Requests API Tests...\n');
    
    let createdRequestId = null;

    try {
        // Test 1: Create new ride request
        console.log('1️⃣ Testing: Create new ride request');
        const createResponse = await axios.post(`${BASE_URL}/pending-rides`, testRideRequest);
        console.log('✅ Create Response:', createResponse.data);
        createdRequestId = createResponse.data.data.request_id;
        console.log(`   Request ID: ${createdRequestId}\n`);

        // Wait a moment
        await new Promise(resolve => setTimeout(resolve, 500));

        // Test 2: Get all pending rides
        console.log('2️⃣ Testing: Get all pending rides');
        const getAllResponse = await axios.get(`${BASE_URL}/pending-rides`);
        console.log('✅ Get All Response:', {
            success: getAllResponse.data.success,
            count: getAllResponse.data.count,
            requests: getAllResponse.data.data.map(r => ({
                request_id: r.request_id,
                passenger_name: r.passenger_name,
                pickup: r.pickup_location,
                status: r.status
            }))
        });
        console.log('');

        // Test 3: Get pending rides with status filter
        console.log('3️⃣ Testing: Get pending rides (status=waiting)');
        const getWaitingResponse = await axios.get(`${BASE_URL}/pending-rides?status=waiting`);
        console.log('✅ Waiting Rides:', {
            count: getWaitingResponse.data.count,
            requests: getWaitingResponse.data.data.map(r => r.request_id)
        });
        console.log('');

        // Test 4: Get specific ride request
        console.log('4️⃣ Testing: Get specific ride request');
        const getOneResponse = await axios.get(`${BASE_URL}/pending-rides/${createdRequestId}`);
        console.log('✅ Get One Response:', {
            request_id: getOneResponse.data.data.request_id,
            passenger: getOneResponse.data.data.passenger_name,
            status: getOneResponse.data.data.status,
            cost: getOneResponse.data.data.estimated_cost
        });
        console.log('');

        // Test 5: Get pending rides for driver
        console.log('5️⃣ Testing: Get pending rides for driver (driver_id=1)');
        const getDriverRidesResponse = await axios.get(`${BASE_URL}/drivers/1/pending-rides`);
        console.log('✅ Driver Rides Response:', {
            count: getDriverRidesResponse.data.count,
            requests: getDriverRidesResponse.data.data.map(r => ({
                request_id: r.request_id,
                pickup: r.pickup_location,
                car_type: r.car_type
            }))
        });
        console.log('');

        // Test 6: Driver rejects ride
        console.log('6️⃣ Testing: Driver rejects ride request');
        const rejectResponse = await axios.post(`${BASE_URL}/pending-rides/${createdRequestId}/reject`, {
            driver_id: 2
        });
        console.log('✅ Reject Response:', {
            message: rejectResponse.data.message,
            rejection_count: rejectResponse.data.data.rejection_count,
            rejected_by: rejectResponse.data.data.rejected_by
        });
        console.log('');

        // Test 7: Driver accepts ride
        console.log('7️⃣ Testing: Driver accepts ride request');
        const acceptResponse = await axios.post(`${BASE_URL}/pending-rides/${createdRequestId}/accept`, {
            driver_id: 1
        });
        console.log('✅ Accept Response:', {
            message: acceptResponse.data.message,
            status: acceptResponse.data.data.status,
            assigned_driver_id: acceptResponse.data.data.assigned_driver_id,
            assigned_at: acceptResponse.data.data.assigned_at
        });
        console.log('');

        // Test 8: Create another request to test cancellation
        console.log('8️⃣ Testing: Create and cancel ride request');
        const createResponse2 = await axios.post(`${BASE_URL}/pending-rides`, {
            ...testRideRequest,
            passenger_name: 'سارة أحمد',
            passenger_phone: '0552345678'
        });
        const requestId2 = createResponse2.data.data.request_id;
        console.log(`   Created request: ${requestId2}`);
        
        const cancelResponse = await axios.post(`${BASE_URL}/pending-rides/${requestId2}/cancel`);
        console.log('✅ Cancel Response:', {
            message: cancelResponse.data.message,
            status: cancelResponse.data.data.status
        });
        console.log('');

        // Test 9: Test cleanup of expired requests
        console.log('9️⃣ Testing: Cleanup expired requests');
        const cleanupResponse = await axios.post(`${BASE_URL}/pending-rides/cleanup`);
        console.log('✅ Cleanup Response:', cleanupResponse.data);
        console.log('');

        // Test 10: Get final state
        console.log('🔟 Testing: Get final state of all requests');
        const finalStateResponse = await axios.get(`${BASE_URL}/pending-rides`);
        console.log('✅ Final State:');
        console.table(finalStateResponse.data.data.map(r => ({
            request_id: r.request_id,
            passenger: r.passenger_name,
            status: r.status,
            rejection_count: r.rejection_count,
            assigned_driver: r.assigned_driver_id || 'N/A'
        })));

        console.log('\n✅ All tests passed successfully! 🎉\n');

    } catch (error) {
        console.error('\n❌ Test failed:', error.response?.data || error.message);
        console.error('Error details:', {
            status: error.response?.status,
            statusText: error.response?.statusText,
            data: error.response?.data
        });
        process.exit(1);
    }
}

// Make sure server is running
console.log('⚠️  Make sure the server is running on port 3000');
console.log('   Run: DATABASE_URL="<YOUR_DATABASE_URL>" npm start\n');

setTimeout(() => {
    runTests().then(() => process.exit(0)).catch(err => {
        console.error(err);
        process.exit(1);
    });
}, 1000);
