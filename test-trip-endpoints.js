const axios = require('axios');

const API_BASE = process.env.API_BASE || 'http://localhost:3000';

async function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main() {
    const riderId = Number(process.env.TEST_RIDER_ID || 1);
    const driverId = Number(process.env.TEST_DRIVER_ID || 1);

    console.log('🧪 Trip completion persistence test');
    console.log('   API_BASE:', API_BASE);
    console.log('   riderId:', riderId, 'driverId:', driverId);

    // Baseline admin stats
    const beforeAdmin = await axios.get(`${API_BASE}/api/admin/dashboard/stats`);
    const beforeTrips = Number(beforeAdmin.data?.data?.total_trips || 0);
    const beforeRevenue = Number(beforeAdmin.data?.data?.total_revenue || 0);

    // Create trip
    const tripId = `T-END-${Date.now()}`;
    const createRes = await axios.post(`${API_BASE}/api/trips`, {
        id: tripId,
        user_id: riderId,
        driver_id: driverId,
        pickup_location: 'Test Pickup',
        dropoff_location: 'Test Dropoff',
        pickup_lat: 24.7136,
        pickup_lng: 46.6753,
        dropoff_lat: 24.7110,
        dropoff_lng: 46.6760,
        cost: 25.5,
        distance: 4.2,
        duration: 10,
        payment_method: 'cash',
        status: 'assigned',
        source: 'test'
    });
    if (!createRes.data?.success) throw new Error('Create trip failed');
    console.log('✅ Created trip', tripId);

    // Start trip (sets started_at + trip_status started)
    const startRes = await axios.patch(`${API_BASE}/api/trips/${tripId}/status`, {
        status: 'ongoing'
    });
    if (!startRes.data?.success) throw new Error('Start trip failed');
    console.log('✅ Started trip');

    // Wait a moment so duration calculation > 0
    await sleep(1100);

    // End trip (server-side completion)
    const endRes = await axios.post(`${API_BASE}/trips/end`, {
        trip_id: tripId,
        driver_id: driverId,
        price: 30.0
    });
    if (!endRes.data?.success) throw new Error('End trip failed');

    const ended = endRes.data?.data;
    console.log('✅ Ended trip response:', ended);

    if (String(ended.trip_id) !== String(tripId)) throw new Error('trip_id mismatch');
    if (!Number.isFinite(Number(ended.price))) throw new Error('price not returned');
    if (!Number.isFinite(Number(ended.duration))) throw new Error('duration not returned');
    if (!Number.isFinite(Number(ended.distance))) throw new Error('distance not returned');

    // Trip persisted
    const tripRes = await axios.get(`${API_BASE}/api/trips/${tripId}`);
    const trip = tripRes.data?.data;
    if (!trip) throw new Error('Trip fetch failed');
    if (trip.status !== 'completed') throw new Error(`Expected status=completed, got ${trip.status}`);
    if (trip.trip_status !== 'completed') throw new Error(`Expected trip_status=completed, got ${trip.trip_status}`);
    if (!trip.completed_at) throw new Error('Expected completed_at to be set');
    if (Number(trip.price || trip.cost) <= 0) throw new Error('Expected price/cost > 0');
    console.log('✅ Trip persisted with completed status');

    // Rider history shows trip
    const riderTrips = await axios.get(`${API_BASE}/rider/trips`, { params: { rider_id: riderId } });
    const riderList = riderTrips.data?.data || [];
    const riderHas = riderList.some((t) => String(t.id) === String(tripId));
    if (!riderHas) throw new Error('Trip not found in rider history');
    console.log('✅ Rider history includes trip');

    // Driver history shows trip
    const driverTrips = await axios.get(`${API_BASE}/driver/trips`, { params: { driver_id: driverId } });
    const driverList = driverTrips.data?.data || [];
    const driverHas = driverList.some((t) => String(t.id) === String(tripId));
    if (!driverHas) throw new Error('Trip not found in driver history');
    console.log('✅ Driver history includes trip');

    // Admin stats increased
    const afterAdmin = await axios.get(`${API_BASE}/api/admin/dashboard/stats`);
    const afterTrips = Number(afterAdmin.data?.data?.total_trips || 0);
    const afterRevenue = Number(afterAdmin.data?.data?.total_revenue || 0);

    if (afterTrips < beforeTrips + 1) {
        throw new Error(`Expected total_trips to increase by >=1 (${beforeTrips} -> ${afterTrips})`);
    }
    if (afterRevenue < beforeRevenue + 30.0) {
        throw new Error(`Expected total_revenue to increase (${beforeRevenue} -> ${afterRevenue})`);
    }

    console.log('✅ Admin stats increased');
    console.log('🎉 All checks passed');
}

main().catch((err) => {
    console.error('❌ Test failed:', err?.response?.data || err.message);
    process.exit(1);
});
