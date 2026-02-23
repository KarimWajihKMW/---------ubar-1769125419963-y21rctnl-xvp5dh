// Captain v4 feature endpoints test
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
      return { token: data.token, user: data.data };
    }
  }
  throw new Error('Admin login failed');
}

async function loginPassenger() {
  const phone = `+9665${Math.floor(Math.random() * 90000000 + 10000000)}`;
  const email = `p_${Date.now()}_${Math.floor(Math.random() * 1000)}@ubar.sa`;
  const { res, data } = await jsonFetch(`${baseURL}/users/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ phone, name: 'CaptainV4 Passenger', email })
  });
  if (!res.ok || !data.success || !data.token) {
    throw new Error(`Passenger login failed: ${data.error || res.status}`);
  }
  return { token: data.token, user: data.data };
}

async function ensureDriver(adminHeaders) {
  const phone = `05${Math.floor(Math.random() * 90000000 + 10000000)}`;
  const email = `driver_${Date.now()}@ubar.sa`;

  const { res, data } = await jsonFetch(`${baseURL}/drivers/resolve?email=${encodeURIComponent(email)}&phone=${encodeURIComponent(phone)}&auto_create=1`, {
    headers: adminHeaders
  });
  if (!res.ok || !data.success || !data.data?.id) {
    throw new Error(`Driver resolve failed: ${data.error || res.status}`);
  }

  const driverId = data.data.id;
  const loc = await jsonFetch(`${baseURL}/drivers/${driverId}/location`, {
    method: 'PATCH',
    headers: adminHeaders,
    body: JSON.stringify({ lat: 24.7136, lng: 46.6753 })
  });
  if (!loc.res.ok) {
    throw new Error(`Driver location update failed: ${loc.data.error || loc.res.status}`);
  }

  // approve driver (best effort)
  await jsonFetch(`${baseURL}/drivers/${driverId}/approval`, {
    method: 'PATCH',
    headers: adminHeaders,
    body: JSON.stringify({ approval_status: 'approved' })
  }).catch(() => {});

  return driverId;
}

async function createTrip(passengerHeaders) {
  const payload = {
    pickup_location: 'Test Pickup',
    dropoff_location: 'Test Dropoff',
    pickup_lat: 24.7136,
    pickup_lng: 46.6753,
    dropoff_lat: 24.7236,
    dropoff_lng: 46.6853,
    car_type: 'economy',
    cost: 25,
    payment_method: 'cash'
  };

  const { res, data } = await jsonFetch(`${baseURL}/trips`, {
    method: 'POST',
    headers: passengerHeaders,
    body: JSON.stringify(payload)
  });

  if (!res.ok || !data.success || !data.data?.id) {
    throw new Error(`Trip create failed: ${data.error || res.status}`);
  }
  return data.data.id;
}

async function run() {
  console.log('🧪 Testing Captain v4 Endpoints\n');

  const admin = await loginAdmin();
  const adminHeaders = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${admin.token}`
  };

  const passenger = await loginPassenger();
  const passengerHeaders = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${passenger.token}`
  };

  const driverId = await ensureDriver(adminHeaders);

  // Set boundaries (admin mode)
  {
    const { res, data } = await jsonFetch(`${baseURL}/drivers/me/boundaries`, {
      method: 'PUT',
      headers: adminHeaders,
      body: JSON.stringify({
        driver_id: driverId,
        boundaries: {
          destination_change_requires_approval: true,
          extra_stops_policy: 'موافقة مطلوبة',
          large_bags_policy: 'حسب المساحة',
          max_passengers_policy: 'حسب الترخيص'
        }
      })
    });
    if (!res.ok || !data.success) throw new Error(`Boundaries set failed: ${data.error || res.status}`);
    console.log('✅ Boundaries set');
  }

  const tripId = await createTrip(passengerHeaders);
  console.log('✅ Trip created:', tripId);

  // Assign driver (admin)
  {
    const { res, data } = await jsonFetch(`${baseURL}/trips/${encodeURIComponent(tripId)}/assign`, {
      method: 'PATCH',
      headers: adminHeaders,
      body: JSON.stringify({ driver_id: driverId, driver_name: 'Test Driver' })
    });
    if (!res.ok || !data.success) throw new Error(`Assign failed: ${data.error || res.status}`);
    if (!data.data?.boundaries_snapshot_json) throw new Error('Expected boundaries_snapshot_json on trip after assign');
    console.log('✅ Driver assigned + boundaries snapshot');
  }

  // Meet code: get as admin, verify as passenger
  let meetCode = null;
  {
    const { res, data } = await jsonFetch(`${baseURL}/trips/${encodeURIComponent(tripId)}/meet-code`, { headers: adminHeaders });
    if (!res.ok || !data.success || !data.data?.code) throw new Error(`Meet code get failed: ${data.error || res.status}`);
    meetCode = String(data.data.code);
    console.log('✅ Meet code generated:', meetCode);
  }
  {
    const { res, data } = await jsonFetch(`${baseURL}/trips/${encodeURIComponent(tripId)}/meet-code/verify`, {
      method: 'POST',
      headers: passengerHeaders,
      body: JSON.stringify({ code: meetCode })
    });
    if (!res.ok || !data.success) throw new Error(`Meet code verify failed: ${data.error || res.status}`);
    console.log('✅ Meet code verified');
  }

  // Expectations set + get
  {
    const { res, data } = await jsonFetch(`${baseURL}/trips/${encodeURIComponent(tripId)}/expectations`, {
      method: 'PATCH',
      headers: passengerHeaders,
      body: JSON.stringify({ expectations: { quiet: 'quiet', music: 'no_music', ac: 'ac', route: 'fast' } })
    });
    if (!res.ok || !data.success) throw new Error(`Expectations set failed: ${data.error || res.status}`);
    console.log('✅ Expectations set');
  }
  {
    const { res, data } = await jsonFetch(`${baseURL}/trips/${encodeURIComponent(tripId)}/expectations`, { headers: adminHeaders });
    if (!res.ok || !data.success) throw new Error(`Expectations get failed: ${data.error || res.status}`);
    if (!data.data?.expectations) throw new Error('Expectations missing');
    console.log('✅ Expectations get');
  }

  // Justified message + ACK
  let msgId = null;
  {
    const { res, data } = await jsonFetch(`${baseURL}/trips/${encodeURIComponent(tripId)}/messages`, {
      method: 'POST',
      headers: adminHeaders,
      body: JSON.stringify({ template_key: 'arrival', reason_key: 'traffic', requires_ack: true, message: '🚦 زحمة، موافق؟' })
    });
    if (!res.ok || !data.success || !data.data?.id) throw new Error(`Message send failed: ${data.error || res.status}`);
    msgId = data.data.id;
    console.log('✅ Justified message sent:', msgId);
  }
  {
    const { res, data } = await jsonFetch(`${baseURL}/trips/${encodeURIComponent(tripId)}/messages/${encodeURIComponent(String(msgId))}/ack`, {
      method: 'POST',
      headers: passengerHeaders,
      body: JSON.stringify({ decision: 'accepted' })
    });
    if (!res.ok || !data.success) throw new Error(`Message ack failed: ${data.error || res.status}`);
    console.log('✅ Message ACK accepted');
  }

  // Arrival steps
  {
    const { res, data } = await jsonFetch(`${baseURL}/trips/${encodeURIComponent(tripId)}/arrival/step1`, {
      method: 'POST',
      headers: adminHeaders,
      body: JSON.stringify({ lat: 24.7136, lng: 46.6753 })
    });
    if (!res.ok || !data.success) throw new Error(`Arrival step1 failed: ${data.error || res.status}`);
    console.log('✅ Arrival step1');
  }
  {
    const { res, data } = await jsonFetch(`${baseURL}/trips/${encodeURIComponent(tripId)}/arrival/step2`, {
      method: 'POST',
      headers: adminHeaders,
      body: JSON.stringify({ seen: false })
    });
    if (!res.ok || !data.success) throw new Error(`Arrival step2 failed: ${data.error || res.status}`);
    console.log('✅ Arrival step2');
  }

  // Timeline get + verify
  {
    const { res, data } = await jsonFetch(`${baseURL}/trips/${encodeURIComponent(tripId)}/timeline`, { headers: adminHeaders });
    if (!res.ok || !data.success) throw new Error(`Timeline get failed: ${data.error || res.status}`);
    console.log('✅ Timeline events:', (data.data || []).length);
  }
  {
    const { res, data } = await jsonFetch(`${baseURL}/trips/${encodeURIComponent(tripId)}/timeline/verify`, { headers: adminHeaders });
    if (!res.ok || !data.success) throw new Error(`Timeline verify failed: ${data.error || res.status}`);
    if (!data.data?.ok) throw new Error(`Timeline verify not ok: bad_seq=${data.data?.bad_seq}`);
    console.log('✅ Timeline verified');
  }

  // Car check upload (admin with driver_id)
  {
    const fd = new FormData();
    fd.append('driver_id', String(driverId));
    fd.append('stage', 'post_trip');
    fd.append('trip_id', String(tripId));
    const jpg = new Blob([Buffer.from([0xff, 0xd8, 0xff, 0xd9])], { type: 'image/jpeg' });
    fd.append('photos', jpg, 'a.jpg');

    const res = await fetch(`${baseURL}/drivers/me/car-checks`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${admin.token}` },
      body: fd
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.success) throw new Error(`Car check upload failed: ${data.error || res.status}`);
    console.log('✅ Car check uploaded');
  }

  // Witness note upload (admin)
  {
    const fd = new FormData();
    const audio = new Blob([Buffer.from('test')], { type: 'audio/webm' });
    fd.append('audio', audio, 'w.webm');
    fd.append('duration_seconds', '8');

    const res = await fetch(`${baseURL}/trips/${encodeURIComponent(tripId)}/witness-notes`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${admin.token}` },
      body: fd
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.success) throw new Error(`Witness upload failed: ${data.error || res.status}`);
    console.log('✅ Witness note uploaded');
  }

  console.log('\n🎉 Captain v4 endpoints look OK!\n');
}

run().catch((err) => {
  console.error('❌ test-captain-v4 failed:', err.message);
  process.exit(1);
});
