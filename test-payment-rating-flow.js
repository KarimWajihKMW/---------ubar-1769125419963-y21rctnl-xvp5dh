const axios = require('axios');

const API_BASE = process.env.API_BASE || 'http://localhost:3000';

async function loginPassenger() {
    const ts = Date.now();
    const email = `passenger_flow_${ts}@test.com`;
    const password = process.env.TEST_PASSENGER_PASSWORD || '12345678';

    const response = await axios.post(`${API_BASE}/api/auth/login`, {
        email,
        password,
        role: 'passenger',
        name: 'راكب اختبار الدفع',
        phone: `010${String(ts).slice(-8)}`
    });

    if (!response.data?.success || !response.data?.token || !response.data?.data?.id) {
        throw new Error('Passenger login failed');
    }

    return {
        token: response.data.token,
        userId: Number(response.data.data.id)
    };
}

async function loginAdminOptional() {
    const email = process.env.ADMIN_EMAIL || 'admin@ubar.sa';
    const password = process.env.ADMIN_PASSWORD || '12345678';

    try {
        const response = await axios.post(`${API_BASE}/api/auth/login`, {
            email,
            password,
            role: 'admin'
        });

        if (!response.data?.success || !response.data?.token) {
            return null;
        }

        return {
            token: response.data.token,
            userId: response.data?.data?.id || null
        };
    } catch (error) {
        return null;
    }
}

async function main() {
    console.log('🧪 Test: payment + mutual rating flow');
    console.log('   API_BASE:', API_BASE);

    const passenger = await loginPassenger();
    const passengerHeaders = { Authorization: `Bearer ${passenger.token}` };

    const tripId = `T-PAY-RATE-${Date.now()}`;

    const createRes = await axios.post(`${API_BASE}/api/trips`, {
        id: tripId,
        user_id: passenger.userId,
        rider_id: passenger.userId,
        driver_id: Number(process.env.TEST_DRIVER_ID || 1),
        pickup_location: 'Test Pickup',
        dropoff_location: 'Test Dropoff',
        pickup_lat: 24.7136,
        pickup_lng: 46.6753,
        dropoff_lat: 24.711,
        dropoff_lng: 46.676,
        cost: 35,
        distance: 5.1,
        duration: 12,
        payment_method: 'cash',
        status: 'ongoing',
        trip_status: 'started',
        source: 'test'
    }, { headers: passengerHeaders });

    if (!createRes.data?.success) {
        throw new Error('Trip creation failed');
    }
    console.log('✅ Trip created:', tripId);

    const completeRes = await axios.patch(`${API_BASE}/api/trips/${tripId}/status`, {
        status: 'completed',
        trip_status: 'completed',
        payment_method: 'cash',
        cost: 35,
        distance: 5.1,
        duration: 12
    }, { headers: passengerHeaders });

    if (!completeRes.data?.success) {
        throw new Error('Passenger payment completion failed');
    }
    console.log('✅ Passenger completed payment');

    const rateDriverRes = await axios.post(`${API_BASE}/api/rate-driver`, {
        trip_id: tripId,
        rating: 5,
        comment: 'رحلة ممتازة'
    }, { headers: passengerHeaders });

    if (!rateDriverRes.data?.success) {
        throw new Error('Passenger rating failed');
    }
    console.log('✅ Passenger rated driver');

    const admin = await loginAdminOptional();
    if (admin?.token) {
        const adminHeaders = { Authorization: `Bearer ${admin.token}` };
        const driverRateRes = await axios.patch(`${API_BASE}/api/trips/${tripId}/status`, {
            status: 'completed',
            trip_status: 'rated',
            driver_rating: 5,
            driver_review: 'راكب محترم'
        }, { headers: adminHeaders });

        if (!driverRateRes.data?.success) {
            throw new Error('Driver/passenger rating patch failed');
        }
        console.log('✅ Driver-side rating recorded (via admin token)');
    } else {
        console.log('⚠️ Admin login unavailable, skipped driver-side rating assertion');
    }

    const tripRes = await axios.get(`${API_BASE}/api/trips/${tripId}`, { headers: passengerHeaders });
    const trip = tripRes.data?.data;
    if (!trip) {
        throw new Error('Trip fetch failed');
    }

    if (String(trip.status || '').toLowerCase() !== 'completed') {
        throw new Error(`Expected status=completed, got ${trip.status}`);
    }
    if (String(trip.payment_method || '').toLowerCase() !== 'cash') {
        throw new Error(`Expected payment_method=cash, got ${trip.payment_method}`);
    }
    if (Number(trip.passenger_rating) !== 5) {
        throw new Error(`Expected passenger_rating=5, got ${trip.passenger_rating}`);
    }

    console.log('🎉 Flow verified successfully');
    console.log({
        trip_id: trip.id,
        status: trip.status,
        trip_status: trip.trip_status,
        payment_method: trip.payment_method,
        passenger_rating: trip.passenger_rating,
        driver_rating: trip.driver_rating
    });
}

main().catch((error) => {
    console.error('❌ Test failed:', error.response?.data || error.message);
    process.exit(1);
});
