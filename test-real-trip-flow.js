// End-to-end test for real (live-tracked) trip flow
// Requires server running on localhost:3000 and a working DB.

const baseURL = process.env.API_BASE_URL || 'http://localhost:3000/api';

async function req(path, options = {}) {
  const res = await fetch(`${baseURL}${path}`, {
    headers: {
      'Content-Type': 'application/json',
      ...(options.headers || {})
    },
    ...options
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = data?.error || `HTTP ${res.status}`;
    throw new Error(`${options.method || 'GET'} ${path} failed: ${msg}`);
  }
  return data;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function testRealTripFlow() {
  console.log('🧪 Real Trip Flow (Live Tracking) Test\n');

  // 1) Create pending trip (passenger app)
  console.log('1️⃣ Create trip');
  const tripId = `TR-LIVE-${Date.now()}`;
  const createTrip = await req('/trips', {
    method: 'POST',
    body: JSON.stringify({
      id: tripId,
      user_id: 1,
      pickup_location: 'نقطة الالتقاط (اختبار)',
      dropoff_location: 'نقطة الوصول (اختبار)',
      pickup_lat: 24.7136,
      pickup_lng: 46.6753,
      dropoff_lat: 24.6917,
      dropoff_lng: 46.6853,
      car_type: 'economy',
      // Estimated values (backend will compute actual on completion)
      cost: 20,
      distance: 3,
      duration: 10,
      payment_method: 'cash',
      status: 'pending',
      source: 'passenger_app'
    })
  });
  console.log('✅ Trip created:', createTrip?.data?.id);

  // 2) Assign driver
  console.log('\n2️⃣ Assign driver');
  const assign = await req(`/trips/${tripId}/assign`, {
    method: 'PATCH',
    body: JSON.stringify({ driver_id: 1, driver_name: 'اختبار كابتن' })
  });
  console.log('✅ Assigned status:', assign?.data?.status);

  // 3) Send some driver location updates (these should be recorded into trip_location_updates)
  console.log('\n3️⃣ Send driver live location updates');
  const driverId = 1;
  const points = [
    { lat: 24.7136, lng: 46.6753 },
    { lat: 24.7110, lng: 46.6780 },
    { lat: 24.7050, lng: 46.6810 },
    { lat: 24.6990, lng: 46.6830 },
    { lat: 24.6917, lng: 46.6853 }
  ];

  for (const p of points.slice(0, 2)) {
    await req(`/drivers/${driverId}/location`, {
      method: 'PATCH',
      body: JSON.stringify({ lat: p.lat, lng: p.lng, accuracy_m: 10 })
    });
    await sleep(300);
  }
  console.log('✅ Location updates sent (pre-start)');

  // 4) Start trip
  console.log('\n4️⃣ Start trip (ongoing)');
  const started = await req(`/trips/${tripId}/status`, {
    method: 'PATCH',
    body: JSON.stringify({ status: 'ongoing' })
  });
  console.log('✅ Trip status:', started?.data?.status);

  // 5) Continue location updates
  console.log('\n5️⃣ Location updates during trip');
  for (const p of points.slice(2)) {
    await req(`/drivers/${driverId}/location`, {
      method: 'PATCH',
      body: JSON.stringify({ lat: p.lat, lng: p.lng, accuracy_m: 10 })
    });
    await sleep(300);
  }
  console.log('✅ Location updates sent (in-trip)');

  // 6) Complete trip (backend should compute actual distance/cost/duration)
  console.log('\n6️⃣ Complete trip');
  const completed = await req(`/trips/${tripId}/status`, {
    method: 'PATCH',
    body: JSON.stringify({ status: 'completed', payment_method: 'cash' })
  });
  console.log('✅ Completed. Stored distance:', completed?.data?.distance, 'cost:', completed?.data?.cost, 'duration:', completed?.data?.duration);

  // 7) Fetch trip log
  console.log('\n7️⃣ Fetch trip log');
  const log = await req(`/trips/${tripId}/log?include_path=1`);
  const summary = log?.data?.summary;
  const events = log?.data?.events || [];

  if (!summary) throw new Error('Missing log summary');
  if (!(summary.distance_km > 0)) throw new Error('distance_km not computed');
  if (!(summary.cost_sar > 0)) throw new Error('cost_sar not computed');
  if (!(summary.duration_min > 0)) throw new Error('duration_min not computed');

  const eventTypes = events.map((e) => e.event_type);
  if (!eventTypes.includes('assigned')) throw new Error('assigned event missing');
  if (!eventTypes.includes('started')) throw new Error('started event missing');
  if (!eventTypes.includes('completed')) throw new Error('completed event missing');

  console.log('✅ Trip log OK:', {
    status: summary.status,
    distance_km: summary.distance_km,
    cost_sar: summary.cost_sar,
    duration_min: summary.duration_min,
    events: eventTypes
  });

  console.log('\n🎉 Real Trip Flow test passed!');
}

testRealTripFlow().catch((err) => {
  console.error('❌ Test failed:', err.message);
  process.exit(1);
});
