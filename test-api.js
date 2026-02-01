// Test script for API endpoints
const baseURL = 'http://localhost:3000/api';

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
        response = await fetch(`${baseURL}/trips/stats/summary`);
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
            pickup_location: 'شارع التحلية، الرياض',
            dropoff_location: 'العليا مول',
            car_type: 'economy',
            cost: 45.50,
            distance: 10.5,
            duration: 20,
            payment_method: 'card',
            driver_name: 'أحمد محمد'
        };
        
        response = await fetch(`${baseURL}/trips`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(newTrip)
        });
        data = await response.json();
        console.log('✅ Created trip:', data.data.id);
        
        const createdTripId = data.data.id;
        
        // Test 9: Update trip status to completed
        console.log('\n9️⃣ Testing update trip to completed...');
        response = await fetch(`${baseURL}/trips/${createdTripId}/status`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ status: 'completed', rating: 5 })
        });
        data = await response.json();
        console.log('✅ Updated trip status:', data.data.status);

        // Test 1️⃣0️⃣: Get single trip
        console.log('\n1️⃣0️⃣ Testing get single trip...');
        response = await fetch(`${baseURL}/trips/${createdTripId}`);
        data = await response.json();
        console.log('✅ Trip details:', data.data);

        // Test 1️⃣1️⃣: Get available drivers
        console.log('\n1️⃣1️⃣ Testing get available drivers...');
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
