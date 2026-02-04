// Test API endpoint
const http = require('http');

const options = {
    hostname: 'localhost',
    port: 3000,
    path: '/api/admin/dashboard/stats',
    method: 'GET'
};

const req = http.request(options, (res) => {
    let data = '';
    
    res.on('data', (chunk) => {
        data += chunk;
    });
    
    res.on('end', () => {
        console.log('📊 API Response:');
        try {
            const parsed = JSON.parse(data);
            console.log(JSON.stringify(parsed, null, 2));
        } catch (e) {
            console.log(data);
        }
        process.exit(0);
    });
});

req.on('error', (error) => {
    console.error('❌ Error:', error.message);
    process.exit(1);
});

req.end();

setTimeout(() => {
    console.log('⏱️ Timeout - Server might not be running');
    process.exit(1);
}, 5000);
