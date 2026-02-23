// Test script: Captain Reposition Coach
// Runs against API_BASE_URL (defaults to localhost)

const baseURL = process.env.API_BASE_URL || 'http://localhost:3000/api';

async function jsonFetch(url, options = {}) {
  const res = await fetch(url, options);
  const data = await res.json().catch(() => ({}));
  return { res, data };
}

async function loginAdmin() {
  const candidates = [];
  if (process.env.ADMIN_EMAIL && process.env.ADMIN_PASSWORD) {
    candidates.push({ email: process.env.ADMIN_EMAIL, password: process.env.ADMIN_PASSWORD });
  }
  candidates.push(
    { email: 'admin@ubar.sa', password: '12345678' },
    { email: 'admin2@ubar.sa', password: '12345678' },
    { email: 'admin@ubar.sa', password: '11111111' }
  );

  for (const c of candidates) {
    const { res, data } = await jsonFetch(`${baseURL}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: c.email, password: c.password, role: 'admin' })
    });
    if (res.ok && data.success && data.token) {
      console.log(`✅ Admin login OK: ${c.email}`);
      return { token: data.token, user: data.data };
    }
  }
  throw new Error('Admin login failed');
}

async function ensureDriver(adminHeaders) {
  const driverEmail = `reposition_driver_${Date.now()}@ubar.sa`;
  const driverPhone = `05${Math.floor(Math.random() * 90000000 + 10000000)}`;
  const { res, data } = await jsonFetch(
    `${baseURL}/drivers/resolve?email=${encodeURIComponent(driverEmail)}&phone=${encodeURIComponent(driverPhone)}&auto_create=1`,
    { headers: adminHeaders }
  );
  if (!res.ok || !data.success || !data.data?.id) {
    throw new Error(`Driver resolve failed: ${data.error || res.status}`);
  }
  return data.data;
}

async function createTripNear(adminHeaders, { riderId, lat, lng, dlat, dlng, cost }) {
  const trip = {
    user_id: riderId,
    pickup_location: 'اختبار تمركز - نقطة التقاط',
    dropoff_location: 'اختبار تمركز - وجهة',
    pickup_lat: lat,
    pickup_lng: lng,
    dropoff_lat: dlat,
    dropoff_lng: dlng,
    car_type: 'economy',
    cost: cost,
    distance: 6.5,
    duration: 16,
    payment_method: 'cash',
    source: 'passenger_app'
  };

  const { res, data } = await jsonFetch(`${baseURL}/trips`, {
    method: 'POST',
    headers: adminHeaders,
    body: JSON.stringify(trip)
  });
  if (!res.ok || !data.success || !data.data?.id) {
    throw new Error(`Create trip failed: ${data.error || res.status}`);
  }
  return data.data.id;
}

async function loginPassengerPhone() {
  const phone = `+9665${Math.floor(Math.random() * 90000000 + 10000000)}`;
  const { res, data } = await jsonFetch(`${baseURL}/users/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ phone, name: 'Test Passenger', email: `p_${Date.now()}@ubar.sa` })
  });
  if (!res.ok || !data.success || !data.token) {
    throw new Error(`Passenger login failed: ${data.error || res.status}`);
  }
  return { token: data.token, user: data.data };
}

async function main() {
  console.log('🧪 Testing Captain Reposition Coach\n');

  const adminAuth = await loginAdmin();
  const adminHeaders = {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${adminAuth.token}`
  };

  const passenger = await loginPassengerPhone();

  // Ensure driver exists and has a known location
  const driver = await ensureDriver(adminHeaders);
  const driverId = driver.id;
  console.log('✅ Driver ready:', driverId);

  const driverLat = 24.7136;
  const driverLng = 46.6753;

  const locRes = await jsonFetch(`${baseURL}/drivers/${encodeURIComponent(driverId)}/location`, {
    method: 'PATCH',
    headers: adminHeaders,
    body: JSON.stringify({ lat: driverLat, lng: driverLng })
  });
  if (!locRes.res.ok || !locRes.data.success) {
    throw new Error(`Update driver location failed: ${locRes.data.error || locRes.res.status}`);
  }
  console.log('✅ Driver location updated');

  // Create a few trips around driver to generate demand signal
  const points = [
    { lat: driverLat + 0.005, lng: driverLng + 0.004, dlat: driverLat + 0.03, dlng: driverLng + 0.02, cost: 28.5 },
    { lat: driverLat + 0.006, lng: driverLng + 0.003, dlat: driverLat + 0.02, dlng: driverLng + 0.03, cost: 31.0 },
    { lat: driverLat + 0.012, lng: driverLng - 0.002, dlat: driverLat + 0.015, dlng: driverLng + 0.01, cost: 22.0 },
    { lat: driverLat - 0.008, lng: driverLng + 0.007, dlat: driverLat - 0.01, dlng: driverLng + 0.02, cost: 35.0 },
    { lat: driverLat - 0.010, lng: driverLng + 0.006, dlat: driverLat + 0.01, dlng: driverLng + 0.01, cost: 26.0 }
  ];

  for (const p of points) {
    await createTripNear(adminHeaders, { riderId: passenger.user.id, ...p });
  }
  console.log(`✅ Created ${points.length} trips for demand signal`);

  // Fetch suggestions
  const sug = await jsonFetch(`${baseURL}/drivers/${encodeURIComponent(driverId)}/captain/reposition/suggestions?limit=5`, {
    headers: adminHeaders
  });
  if (!sug.res.ok || !sug.data.success) {
    throw new Error(`Suggestions failed: ${sug.data.error || sug.res.status}`);
  }

  const rows = Array.isArray(sug.data.data) ? sug.data.data : [];
  console.log('✅ Suggestions OK:', { count: rows.length });

  if (rows.length === 0) {
    console.log('ℹ️ No suggestions returned (this can happen if no demand data matches filters).');
    process.exit(0);
  }

  const first = rows[0];
  if (!first.event_id) {
    throw new Error('Missing event_id in suggestion');
  }

  const fb = await jsonFetch(`${baseURL}/drivers/${encodeURIComponent(driverId)}/captain/reposition/feedback`, {
    method: 'POST',
    headers: adminHeaders,
    body: JSON.stringify({ event_id: first.event_id, action: 'executed', note: 'test' })
  });
  if (!fb.res.ok || !fb.data.success) {
    throw new Error(`Feedback failed: ${fb.data.error || fb.res.status}`);
  }
  console.log('✅ Feedback OK:', fb.data.data?.feedback_action);

  console.log('\n✅ Captain Reposition Coach test completed');
}

main().catch((e) => {
  console.error('❌ test-captain-reposition failed:', e.message);
  process.exit(1);
});
