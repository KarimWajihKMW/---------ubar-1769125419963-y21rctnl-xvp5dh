const axios = require('axios');

const API_URL = 'http://localhost:3000/api';

async function testAdminDashboardStats() {
    try {
        console.log('🧪 Testing Admin Dashboard Stats API\n');
        
        const response = await axios.get(`${API_URL}/admin/dashboard/stats`);
        
        console.log('✅ Status:', response.status);
        console.log('✅ Response:', JSON.stringify(response.data, null, 2));
        
        if (response.data.success) {
            const { today_trips, active_drivers, total_earnings, avg_rating } = response.data.data;
            console.log('\n📊 Dashboard Stats:');
            console.log('   - Today Trips:', today_trips);
            console.log('   - Active Drivers:', active_drivers);
            console.log('   - Total Earnings:', total_earnings);
            console.log('   - Average Rating:', avg_rating);
        }
        
    } catch (error) {
        console.error('❌ Error:', error.response?.data || error.message);
    }
}

testAdminDashboardStats();
