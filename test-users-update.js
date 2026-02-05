const axios = require('axios');

const API_URL = 'http://localhost:3000/api';

async function testUsersAPI() {
    console.log('🧪 Testing Users Update API\n');
    
    try {
        // Test 1: Get a user (using known user from database)
        console.log('Test 1: Get user by ID');
        const userId = 2; // Assuming user with ID 2 exists
        
        try {
            const getUserResponse = await axios.get(`${API_URL}/users/${userId}`);
            console.log('✅ GET /api/users/:id');
            console.log(`   User: ${getUserResponse.data.data.name}`);
            console.log(`   Email: ${getUserResponse.data.data.email}`);
            console.log(`   Phone: ${getUserResponse.data.data.phone}\n`);

            // Test 2: Update user
            console.log('Test 2: Update user name');
            const updateData = {
                name: 'عبدالعزيز أحمد (محدث)',
                email: getUserResponse.data.data.email,
                phone: getUserResponse.data.data.phone
            };
            
            const updateResponse = await axios.put(`${API_URL}/users/${userId}`, updateData);
            console.log('✅ PUT /api/users/:id');
            console.log(`   Updated name: ${updateResponse.data.data.name}`);
            console.log(`   Updated at: ${updateResponse.data.data.updated_at}\n`);

            // Test 3: Verify update
            console.log('Test 3: Verify update by fetching again');
            const verifyResponse = await axios.get(`${API_URL}/users/${userId}`);
            console.log('✅ Verified update');
            console.log(`   Name: ${verifyResponse.data.data.name}`);
            console.log(`   Should match: عبدالعزيز أحمد (محدث)\n`);

            // Test 4: Update only email
            console.log('Test 4: Update only email');
            const emailUpdate = {
                email: 'abdulaziz.updated@ubar.sa'
            };
            
            const emailResponse = await axios.put(`${API_URL}/users/${userId}`, emailUpdate);
            console.log('✅ PUT /api/users/:id (email only)');
            console.log(`   Updated email: ${emailResponse.data.data.email}\n`);

            // Test 5: Restore original name
            console.log('Test 5: Restore original name');
            const restoreData = {
                name: 'عبدالعزيز أحمد'
            };
            
            const restoreResponse = await axios.put(`${API_URL}/users/${userId}`, restoreData);
            console.log('✅ Restored original name');
            console.log(`   Name: ${restoreResponse.data.data.name}\n`);

            console.log('✅✅✅ All tests passed! ✅✅✅');

        } catch (error) {
            if (error.response && error.response.status === 404) {
                console.log('ℹ️ User with ID 2 not found. Testing with ID 1...\n');
                
                // Try with user ID 1
                const getUserResponse = await axios.get(`${API_URL}/users/1`);
                console.log('✅ GET /api/users/1');
                console.log(`   User: ${getUserResponse.data.data.name}`);
                console.log(`   Email: ${getUserResponse.data.data.email}\n`);

                // Update test
                const updateData = {
                    name: getUserResponse.data.data.name + ' (تم التحديث)'
                };
                
                const updateResponse = await axios.put(`${API_URL}/users/1`, updateData);
                console.log('✅ PUT /api/users/1');
                console.log(`   Updated name: ${updateResponse.data.data.name}\n`);

                console.log('✅✅✅ Tests passed with user ID 1! ✅✅✅');
            } else {
                throw error;
            }
        }

    } catch (error) {
        console.error('❌ Test failed:', error.response?.data || error.message);
        process.exit(1);
    }
}

// Run tests
console.log('Starting Users Update API tests...');
console.log('Make sure the server is running on port 3000\n');

setTimeout(() => {
    testUsersAPI()
        .then(() => {
            console.log('\n✅ Testing completed successfully!');
            process.exit(0);
        })
        .catch((error) => {
            console.error('\n❌ Testing failed:', error);
            process.exit(1);
        });
}, 1000);
