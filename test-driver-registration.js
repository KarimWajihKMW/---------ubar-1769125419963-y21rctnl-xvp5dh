const fs = require('fs');
const path = require('path');

const API_URL = 'http://localhost:3000/api';

// Helper function to make API calls
async function apiCall(endpoint, method = 'GET', body = null, isFormData = false) {
    const url = `${API_URL}${endpoint}`;
    const options = {
        method,
        headers: isFormData ? {} : { 'Content-Type': 'application/json' }
    };

    if (body) {
        options.body = isFormData ? body : JSON.stringify(body);
    }

    try {
        const response = await fetch(url, options);
        const data = await response.json();
        return { status: response.status, data };
    } catch (error) {
        console.error(`Error calling ${endpoint}:`, error.message);
        return { status: 500, data: { error: error.message } };
    }
}

async function testDriverRegistration() {
    console.log('\n🧪 Testing Driver Registration API\n');
    console.log('='.repeat(60));

    // Test 1: Get pending drivers (should be empty initially)
    console.log('\n1️⃣ Testing GET /api/drivers/pending');
    const pendingResult = await apiCall('/drivers/pending');
    console.log('Status:', pendingResult.status);
    console.log('Response:', JSON.stringify(pendingResult.data, null, 2));

    // Test 2: Register new driver with documents
    console.log('\n2️⃣ Testing POST /api/drivers/register');
    console.log('Note: This test requires actual file uploads.');
    console.log('We will create dummy files for testing...');

    // Create test images
    const testDir = path.join(__dirname, 'test-uploads');
    if (!fs.existsSync(testDir)) {
        fs.mkdirSync(testDir, { recursive: true });
    }

    const createTestFile = (filename, content = 'Test file content') => {
        const filePath = path.join(testDir, filename);
        fs.writeFileSync(filePath, content);
        return filePath;
    };

    const idCardPath = createTestFile('test-id-card.jpg', 'Fake ID Card Image');
    const licensePath = createTestFile('test-license.jpg', 'Fake License Image');
    const vehiclePath = createTestFile('test-vehicle.jpg', 'Fake Vehicle License Image');

    // Note: For actual file upload test, we need to use a different approach
    console.log('Created test files:', { idCardPath, licensePath, vehiclePath });
    console.log('⚠️  File upload test requires HTTP client with multipart/form-data support');
    console.log('Using curl command for testing...\n');

    // Test 3: Check driver status (should not exist yet)
    console.log('\n3️⃣ Testing GET /api/drivers/status/:phone');
    const statusResult = await apiCall('/drivers/status/0501111111');
    console.log('Status:', statusResult.status);
    console.log('Response:', JSON.stringify(statusResult.data, null, 2));

    // Test 4: Approve a driver (using one of the sample drivers)
    console.log('\n4️⃣ Testing PATCH /api/drivers/:id/approval');
    const approvalResult = await apiCall('/drivers/1/approval', 'PATCH', {
        approval_status: 'approved',
        approved_by: 8
    });
    console.log('Status:', approvalResult.status);
    console.log('Response:', JSON.stringify(approvalResult.data, null, 2));

    // Test 5: Get all drivers
    console.log('\n5️⃣ Testing GET /api/drivers');
    const driversResult = await apiCall('/drivers?status=offline');
    console.log('Status:', driversResult.status);
    console.log('Total drivers:', driversResult.data.data?.length || 0);

    console.log('\n' + '='.repeat(60));
    console.log('\n✅ Basic API tests completed!\n');

    // Print curl command for manual file upload test
    console.log('📝 To test file upload manually, run this curl command:\n');
    console.log(`curl -X POST http://localhost:3000/api/drivers/register \\
  -F "name=عبدالله محمد الأحمد" \\
  -F "phone=0501111111" \\
  -F "email=abdullah@test.sa" \\
  -F "password=test1234" \\
  -F "car_type=economy" \\
  -F "car_plate=أ ب ج 9999" \\
  -F "id_card_photo=@${idCardPath}" \\
  -F "drivers_license=@${licensePath}" \\
  -F "vehicle_license=@${vehiclePath}"
`);

    console.log('\n📝 To approve the newly registered driver:\n');
    console.log(`curl -X PATCH http://localhost:3000/api/drivers/9/approval \\
  -H "Content-Type: application/json" \\
  -d '{"approval_status":"approved","approved_by":8}'
`);

    console.log('\n📝 To check pending registrations:\n');
    console.log('curl http://localhost:3000/api/drivers/pending\n');
}

// Run tests
testDriverRegistration().catch(console.error);
