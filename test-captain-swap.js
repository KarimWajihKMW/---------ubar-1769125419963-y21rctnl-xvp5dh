// Test script: Captain Trip Swap Market
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

async function ensureDriver(adminHeaders, prefix) {
  const driverEmail = `${prefix}_${Date.now()}@ubar.sa`;
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

async function setDriverLocation(adminHeaders, driverId, lat, lng) {
  const { res, data } = await jsonFetch(`${baseURL}/drivers/${encodeURIComponent(driverId)}/location`, {
    method: 'PATCH',
    headers: adminHeaders,
    body: JSON.stringify({ lat, lng })
  });
  if (!res.ok || !data.success) {
    throw new Error(`Update driver location failed: ${data.error || res.status}`);
  }
}

async function createTrip(adminHeaders, passengerId, pickupLat, pickupLng, dropLat, dropLng, cost) {
  const trip = {
    user_id: passengerId,
    pickup_location: 'اختبار تبديل - نقطة التقاط',
    dropoff_location: 'اختبار تبديل - وجهة',
    pickup_lat: pickupLat,
    pickup_lng: pickupLng,
    dropoff_lat: dropLat,
    dropoff_lng: dropLng,
    car_type: 'economy',
    cost: cost,
    distance: 9.2,
    duration: 22,
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

async function main() {
  console.log('🧪 Testing Captain Trip Swap Market\n');

  const adminAuth = await loginAdmin();
  const adminHeaders = {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${adminAuth.token}`
  };

  const passenger = await loginPassengerPhone();

  const driverA = await ensureDriver(adminHeaders, 'swap_driver_a');
  const driverB = await ensureDriver(adminHeaders, 'swap_driver_b');

  console.log('✅ Drivers ready:', { driverA: driverA.id, driverB: driverB.id });

  const pickupLat = 24.7136;
  const pickupLng = 46.6753;
  await setDriverLocation(adminHeaders, driverA.id, pickupLat + 0.01, pickupLng + 0.01);
  await setDriverLocation(adminHeaders, driverB.id, pickupLat + 0.012, pickupLng + 0.009);

  const tripId = await createTrip(adminHeaders, passenger.user.id, pickupLat, pickupLng, pickupLat + 0.03, pickupLng + 0.02, 44.0);
  console.log('✅ Trip created:', tripId);

  // Assign to driverA
  const assign = await jsonFetch(`${baseURL}/trips/${encodeURIComponent(tripId)}/assign`, {
    method: 'PATCH',
    headers: adminHeaders,
    body: JSON.stringify({ driver_id: driverA.id, driver_name: driverA.name || 'Driver A' })
  });
  if (!assign.res.ok || !assign.data.success) {
    throw new Error(`Assign driver failed: ${assign.data.error || assign.res.status}`);
  }
  console.log('✅ Trip assigned to driverA');

  // Offer swap
  const offer = await jsonFetch(`${baseURL}/trips/${encodeURIComponent(tripId)}/swap/offer`, {
    method: 'POST',
    headers: adminHeaders,
    body: JSON.stringify({ offered_by_driver_id: driverA.id, reason_code: 'far', ttl_seconds: 90 })
  });
  if (!offer.res.ok || !offer.data.success || !offer.data.data?.id) {
    throw new Error(`Swap offer failed: ${offer.data.error || offer.res.status}`);
  }
  const offerId = offer.data.data.id;
  console.log('✅ Swap offer created:', offerId);

  // Candidate rejects (record decision) - optional, then accept anyway as admin
  const reject = await jsonFetch(`${baseURL}/trips/${encodeURIComponent(tripId)}/swap/reject`, {
    method: 'POST',
    headers: adminHeaders,
    body: JSON.stringify({ offer_id: offerId, driver_id: driverB.id })
  });
  if (!reject.res.ok || !reject.data.success) {
    throw new Error(`Swap reject failed: ${reject.data.error || reject.res.status}`);
  }
  console.log('✅ Swap reject recorded');

  // Accept by driverB
  const accept = await jsonFetch(`${baseURL}/trips/${encodeURIComponent(tripId)}/swap/accept`, {
    method: 'POST',
    headers: adminHeaders,
    body: JSON.stringify({ offer_id: offerId, driver_id: driverB.id })
  });
  if (!accept.res.ok || !accept.data.success) {
    throw new Error(`Swap accept failed: ${accept.data.error || accept.res.status}`);
  }
  console.log('✅ Swap accepted');

  const tripAfter = await jsonFetch(`${baseURL}/trips/${encodeURIComponent(tripId)}`, { headers: adminHeaders });
  if (!tripAfter.res.ok || !tripAfter.data.success) {
    throw new Error(`Fetch trip failed: ${tripAfter.data.error || tripAfter.res.status}`);
  }

  const newDriverId = tripAfter.data.data?.driver_id;
  if (String(newDriverId) !== String(driverB.id)) {
    throw new Error(`Expected driver_id=${driverB.id} but got ${newDriverId}`);
  }

  console.log('✅ Trip driver switched to driverB');
  console.log('\n✅ Captain Trip Swap Market test completed');
}

main().catch((e) => {
  console.error('❌ test-captain-swap failed:', e.message);
  process.exit(1);
});
