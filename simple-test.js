async function testAPI() {
    try {
        const response = await fetch('http://localhost:3000/api/admin/dashboard/stats');
        const data = await response.json();
        console.log('API Response:', JSON.stringify(data, null, 2));
    } catch (error) {
        console.error('Error:', error.message);
    }
}

testAPI();
