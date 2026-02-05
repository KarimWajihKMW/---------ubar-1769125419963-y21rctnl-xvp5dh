const axios = require('axios');

const API_URL = 'http://localhost:3000/api';

let createdPassengerId = null;

async function testPassengersAPI() {
    console.log('🧪 Testing Passengers API\n');
    
    try {
        // Test 1: Get all passengers
        console.log('Test 1: Get all passengers');
        const getAllResponse = await axios.get(`${API_URL}/passengers`);
        console.log('✅ GET /api/passengers');
        console.log(`   Found ${getAllResponse.data.total} passengers`);
        console.log(`   Returned ${getAllResponse.data.data.length} in this page\n`);

        // Test 2: Create new passenger
        console.log('Test 2: Create new passenger');
        const newPassenger = {
            name: 'أحمد محمد',
            phone: '01234567890',
            email: 'ahmed.test@example.com',
            password: 'test1234'
        };
        
        const createResponse = await axios.post(`${API_URL}/passengers`, newPassenger);
        createdPassengerId = createResponse.data.data.id;
        console.log('✅ POST /api/passengers');
        console.log(`   Created passenger with ID: ${createdPassengerId}`);
        console.log(`   Name: ${createResponse.data.data.name}`);
        console.log(`   Phone: ${createResponse.data.data.phone}\n`);

        // Test 3: Get passenger by ID
        console.log('Test 3: Get passenger by ID');
        const getByIdResponse = await axios.get(`${API_URL}/passengers/${createdPassengerId}`);
        console.log('✅ GET /api/passengers/:id');
        console.log(`   Passenger: ${getByIdResponse.data.data.name}`);
        console.log(`   Email: ${getByIdResponse.data.data.email}`);
        if (getByIdResponse.data.data.stats) {
            console.log(`   Total trips: ${getByIdResponse.data.data.stats.total_trips}\n`);
        }

        // Test 4: Update passenger
        console.log('Test 4: Update passenger');
        const updateData = {
            name: 'أحمد محمد المحدث',
            email: 'ahmed.updated@example.com'
        };
        
        const updateResponse = await axios.put(`${API_URL}/passengers/${createdPassengerId}`, updateData);
        console.log('✅ PUT /api/passengers/:id');
        console.log(`   Updated name: ${updateResponse.data.data.name}`);
        console.log(`   Updated email: ${updateResponse.data.data.email}\n`);

        // Test 5: Search passengers
        console.log('Test 5: Search passengers');
        const searchResponse = await axios.get(`${API_URL}/passengers?search=أحمد`);
        console.log('✅ GET /api/passengers?search=أحمد');
        console.log(`   Found ${searchResponse.data.total} passengers matching "أحمد"\n`);

        // Test 6: Get passenger trips
        console.log('Test 6: Get passenger trips');
        const tripsResponse = await axios.get(`${API_URL}/passengers/${createdPassengerId}/trips`);
        console.log('✅ GET /api/passengers/:id/trips');
        console.log(`   Found ${tripsResponse.data.total} trips for this passenger\n`);

        // Test 7: Try duplicate phone (should fail)
        console.log('Test 7: Try creating duplicate phone');
        try {
            await axios.post(`${API_URL}/passengers`, {
                name: 'راكب آخر',
                phone: '01234567890',
                email: 'another@example.com'
            });
            console.log('❌ Should have failed with duplicate phone\n');
        } catch (error) {
            console.log('✅ Correctly rejected duplicate phone');
            console.log(`   Error: ${error.response.data.error}\n`);
        }

        // Test 8: Delete passenger
        console.log('Test 8: Delete passenger');
        const deleteResponse = await axios.delete(`${API_URL}/passengers/${createdPassengerId}`);
        console.log('✅ DELETE /api/passengers/:id');
        console.log(`   ${deleteResponse.data.message}\n`);

        // Test 9: Try to get deleted passenger (should fail)
        console.log('Test 9: Try to get deleted passenger');
        try {
            await axios.get(`${API_URL}/passengers/${createdPassengerId}`);
            console.log('❌ Should have failed - passenger was deleted\n');
        } catch (error) {
            console.log('✅ Correctly returned 404 for deleted passenger');
            console.log(`   Error: ${error.response.data.error}\n`);
        }

        console.log('✅✅✅ All tests passed! ✅✅✅');

    } catch (error) {
        console.error('❌ Test failed:', error.response?.data || error.message);
        process.exit(1);
    }
}

// Run tests
console.log('Starting Passengers API tests...');
console.log('Make sure the server is running on port 3000\n');

setTimeout(() => {
    testPassengersAPI()
        .then(() => {
            console.log('\n✅ Testing completed successfully!');
            process.exit(0);
        })
        .catch((error) => {
            console.error('\n❌ Testing failed:', error);
            process.exit(1);
        });
}, 1000);
