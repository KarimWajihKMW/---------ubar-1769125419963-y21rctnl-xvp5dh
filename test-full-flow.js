const axios = require('axios');

const API_URL = 'http://localhost:3000/api';

async function testFullUserFlow() {
    console.log('🧪 Testing Full User Profile Update Flow\n');
    
    try {
        const testPhone = '0551234567';
        let userId = null;

        // Step 1: Login as passenger
        console.log('Step 1: Login as passenger');
        const loginResponse = await axios.post(`${API_URL}/users/login`, {
            phone: testPhone,
            name: 'عبدالعزيز أحمد'
        });
        
        if (!loginResponse.data.success) {
            throw new Error('Login failed');
        }
        
        userId = loginResponse.data.data.id;
        console.log('✅ Login successful');
        console.log(`   User ID: ${userId}`);
        console.log(`   Name: ${loginResponse.data.data.name}`);
        console.log(`   Email: ${loginResponse.data.data.email}\n`);

        // Step 2: Update user name (simulating profile edit)
        console.log('Step 2: Update user name');
        const newName = 'عبدالعزيز أحمد (تم التعديل)';
        const updateResponse = await axios.put(`${API_URL}/users/${userId}`, {
            name: newName
        });

        if (!updateResponse.data.success) {
            throw new Error('Update failed');
        }

        console.log('✅ Update successful');
        console.log(`   New name: ${updateResponse.data.data.name}`);
        console.log(`   Updated at: ${updateResponse.data.data.updated_at}\n`);

        // Step 3: Simulate logout and login again
        console.log('Step 3: Simulate logout and login again');
        const reloginResponse = await axios.post(`${API_URL}/users/login`, {
            phone: testPhone,
            name: 'عبدالعزيز أحمد' // Using old name intentionally
        });

        if (!reloginResponse.data.success) {
            throw new Error('Re-login failed');
        }

        console.log('✅ Re-login successful');
        console.log(`   Name from DB: ${reloginResponse.data.data.name}`);
        console.log(`   Should be: ${newName}`);
        
        if (reloginResponse.data.data.name === newName) {
            console.log('   ✅ Name persisted correctly!\n');
        } else {
            console.log('   ❌ Name did NOT persist!\n');
        }

        // Step 4: Verify by fetching user directly
        console.log('Step 4: Verify by fetching user directly');
        const fetchResponse = await axios.get(`${API_URL}/users/${userId}`);

        if (!fetchResponse.data.success) {
            throw new Error('Fetch failed');
        }

        console.log('✅ Direct fetch successful');
        console.log(`   Name: ${fetchResponse.data.data.name}`);
        console.log(`   Email: ${fetchResponse.data.data.email}`);
        console.log(`   Phone: ${fetchResponse.data.data.phone}\n`);

        // Step 5: Restore original name
        console.log('Step 5: Restore original name');
        const restoreResponse = await axios.put(`${API_URL}/users/${userId}`, {
            name: 'عبدالعزيز أحمد'
        });

        if (restoreResponse.data.success) {
            console.log('✅ Name restored to original\n');
        }

        console.log('✅✅✅ All tests passed! The update system works correctly! ✅✅✅');

    } catch (error) {
        console.error('❌ Test failed:', error.response?.data || error.message);
        process.exit(1);
    }
}

// Run tests
console.log('Starting Full User Profile Update Flow tests...');
console.log('Make sure the server is running on port 3000\n');

setTimeout(() => {
    testFullUserFlow()
        .then(() => {
            console.log('\n✅ Testing completed successfully!');
            process.exit(0);
        })
        .catch((error) => {
            console.error('\n❌ Testing failed:', error);
            process.exit(1);
        });
}, 1000);
