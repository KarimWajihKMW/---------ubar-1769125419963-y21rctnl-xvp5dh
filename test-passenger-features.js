// Test script for passenger feature endpoints (Haged-uber.md)
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

  throw new Error('Admin login failed: Invalid email or password');
}

async function loginPassenger(label = 'Passenger') {
  const phone = `+9665${Math.floor(Math.random() * 90000000 + 10000000)}`;
  const email = `p_${Date.now()}_${Math.floor(Math.random() * 1000)}@ubar.sa`;

  const { res, data } = await jsonFetch(`${baseURL}/users/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ phone, name: `Test ${label}`, email })
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

  // set driver location so distance-based queries work
  const loc = await jsonFetch(`${baseURL}/drivers/${driverId}/location`, {
    method: 'PATCH',
    headers: adminHeaders,
    body: JSON.stringify({ lat: 24.7136, lng: 46.6753 })
  });
  if (!loc.res.ok) {
    throw new Error(`Driver location update failed: ${loc.data.error || loc.res.status}`);
  }

  return driverId;
}

async function creditWallet(adminHeaders, userId, amount, referenceId) {
  const { res, data } = await jsonFetch(`${baseURL}/admin/wallet/transaction`, {
    method: 'POST',
    headers: adminHeaders,
    body: JSON.stringify({
      owner_type: 'user',
      owner_id: userId,
      amount,
      currency: 'SAR',
      reason: 'Test credit',
      reference_type: 'test_credit',
      reference_id: referenceId || String(Date.now())
    })
  });
  if (!res.ok || !data.success) {
    throw new Error(`Wallet credit failed: ${data.error || res.status}`);
  }
}

async function getWalletBalance(token) {
  const { res, data } = await jsonFetch(`${baseURL}/wallet/me/balance`, {
    headers: { Authorization: `Bearer ${token}` }
  });
  if (!res.ok || !data.success) {
    throw new Error(`Wallet balance failed: ${data.error || res.status}`);
  }
  return Number(data.data?.balance || 0);
}

async function run() {
  console.log('🧪 Testing Passenger Features Endpoints\n');

  const admin = await loginAdmin();
  const adminHeaders = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${admin.token}`
  };

  const p1 = await loginPassenger('P1');
  const p2 = await loginPassenger('P2');
  const p1Headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${p1.token}` };
  const p2Headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${p2.token}` };

  // 0) OAuth endpoints (optional) - should be safe when not configured
  console.log('\n0️⃣ OAuth (optional)...');
  const gLogin = await fetch(`${baseURL}/oauth/google/login`, { redirect: 'manual' });
  if (![501, 302, 303].includes(gLogin.status)) {
    throw new Error(`Google oauth login unexpected status: ${gLogin.status}`);
  }
  const aLogin = await fetch(`${baseURL}/oauth/apple/login`, { redirect: 'manual' });
  if (![501, 302, 303].includes(aLogin.status)) {
    throw new Error(`Apple oauth login unexpected status: ${aLogin.status}`);
  }

  const gLink = await jsonFetch(`${baseURL}/oauth/google/link`, { method: 'POST', headers: p1Headers, body: JSON.stringify({}) });
  if (![501, 200].includes(gLink.res.status)) {
    throw new Error(`Google oauth link unexpected status: ${gLink.res.status}`);
  }
  if (gLink.res.status === 200 && (!gLink.data.success || !gLink.data.url)) {
    throw new Error('Google oauth link missing url');
  }

  const driverId = await ensureDriver(adminHeaders);
  console.log('✅ Driver ready:', driverId);

  // 1) Pickup hubs: admin creates hub, passenger suggests
  console.log('\n1️⃣ Pickup hubs...');
  const hubCreate = await jsonFetch(`${baseURL}/admin/pickup-hubs`, {
    method: 'POST',
    headers: adminHeaders,
    body: JSON.stringify({ title: 'بوابة مول (اختبار)', category: 'مول', lat: 24.7137, lng: 46.6754, is_active: true })
  });
  if (!hubCreate.res.ok) throw new Error(`Create hub failed: ${hubCreate.data.error || hubCreate.res.status}`);
  const hubId = hubCreate.data.data.id;

  const hubSuggest = await jsonFetch(`${baseURL}/pickup-hubs/suggest?lat=24.7136&lng=46.6753&limit=5`, {
    headers: p1Headers
  });
  if (!hubSuggest.res.ok) throw new Error(`Suggest hubs failed: ${hubSuggest.data.error || hubSuggest.res.status}`);
  console.log('✅ Hubs suggested:', hubSuggest.data.data.length);

  // 2) Price lock
  console.log('\n2️⃣ Price lock...');
  const lock = await jsonFetch(`${baseURL}/pricing/lock`, {
    method: 'POST',
    headers: p1Headers,
    body: JSON.stringify({ pickup_lat: 24.7136, pickup_lng: 46.6753, dropoff_lat: 24.6917, dropoff_lng: 46.6853, car_type: 'economy', ttl_seconds: 120 })
  });
  if (!lock.res.ok) throw new Error(`Price lock failed: ${lock.data.error || lock.res.status}`);
  const priceLockId = lock.data.data.id;

  // 3) Family member
  console.log('\n3️⃣ Family member...');
  const fam = await jsonFetch(`${baseURL}/passengers/me/family`, {
    method: 'POST',
    headers: p1Headers,
    body: JSON.stringify({ name: 'أخي (اختبار)', phone: '0500000000' })
  });
  if (!fam.res.ok) throw new Error(`Family add failed: ${fam.data.error || fam.res.status}`);
  const familyMemberId = fam.data.data.id;

  // 3️⃣b) Family spending limits enforcement
  console.log('\n3️⃣b Family limits...');
  const famLimited = await jsonFetch(`${baseURL}/passengers/me/family`, {
    method: 'POST',
    headers: p1Headers,
    body: JSON.stringify({ name: 'طفل (حدود)', phone: '0500000001', daily_limit: 5, weekly_limit: 5 })
  });
  if (!famLimited.res.ok) throw new Error(`Family add (limited) failed: ${famLimited.data.error || famLimited.res.status}`);
  const limitedMemberId = famLimited.data.data.id;

  const limitedTrip = await jsonFetch(`${baseURL}/trips`, {
    method: 'POST',
    headers: p1Headers,
    body: JSON.stringify({
      pickup_location: 'التقاط حدود',
      dropoff_location: 'وجهة حدود',
      pickup_lat: 24.7136,
      pickup_lng: 46.6753,
      pickup_accuracy: 6.1,
      pickup_timestamp: Date.now(),
      dropoff_lat: 24.6917,
      dropoff_lng: 46.6853,
      car_type: 'economy',
      cost: 10,
      distance: 1,
      duration: 10,
      payment_method: 'cash',
      booked_for_family_member_id: limitedMemberId,
      source: 'passenger_app'
    })
  });
  if (limitedTrip.res.status !== 409) {
    throw new Error(`Expected family budget exceeded (409), got: ${limitedTrip.res.status}`);
  }

  // 3️⃣c) Budget envelope check
  console.log('\n3️⃣c Budget envelope...');
  const setEnvelope = await jsonFetch(`${baseURL}/passengers/me/budget-envelope`, {
    method: 'POST',
    headers: p1Headers,
    body: JSON.stringify({ enabled: true, daily_limit: 5, weekly_limit: 5 })
  });
  if (!setEnvelope.res.ok) throw new Error(`Set envelope failed: ${setEnvelope.data.error || setEnvelope.res.status}`);
  const chkEnvelope = await jsonFetch(`${baseURL}/passengers/me/budget-envelope/check`, {
    method: 'POST',
    headers: p1Headers,
    body: JSON.stringify({ amount: 10 })
  });
  if (!chkEnvelope.res.ok) throw new Error(`Envelope check failed: ${chkEnvelope.data.error || chkEnvelope.res.status}`);
  if (chkEnvelope.data.allowed !== false || chkEnvelope.data.force_method !== 'cash') {
    throw new Error('Envelope check should force cash when exceeded');
  }

  // 3️⃣d) Accessibility profile + Emergency card (v2)
  console.log('\n3️⃣d Accessibility + Emergency (v2)...');
  const accPut = await jsonFetch(`${baseURL}/passengers/me/accessibility`, {
    method: 'PUT',
    headers: p1Headers,
    body: JSON.stringify({
      voice_prompts: true,
      text_first: true,
      no_calls: true,
      wheelchair: true,
      extra_time: true,
      simple_language: true,
      notes: 'اختبار ملف الإتاحة'
    })
  });
  if (!accPut.res.ok) throw new Error(`Accessibility PUT failed: ${accPut.data.error || accPut.res.status}`);
  const accGet = await jsonFetch(`${baseURL}/passengers/me/accessibility`, { headers: p1Headers });
  if (!accGet.res.ok) throw new Error(`Accessibility GET failed: ${accGet.data.error || accGet.res.status}`);
  if (accGet.data.data.wheelchair !== true) throw new Error('Accessibility profile should include wheelchair=true');

  const emPut = await jsonFetch(`${baseURL}/passengers/me/emergency-profile`, {
    method: 'PUT',
    headers: p1Headers,
    body: JSON.stringify({
      opt_in: true,
      contact_name: 'Emergency Contact',
      contact_channel: 'phone',
      contact_value: '0500000000',
      medical_note: 'حساسية (اختبار)'
    })
  });
  if (!emPut.res.ok) throw new Error(`Emergency profile PUT failed: ${emPut.data.error || emPut.res.status}`);
  const emGet = await jsonFetch(`${baseURL}/passengers/me/emergency-profile`, { headers: p1Headers });
  if (!emGet.res.ok) throw new Error(`Emergency profile GET failed: ${emGet.data.error || emGet.res.status}`);
  if (emGet.data.data.opt_in !== true) throw new Error('Emergency profile should be opt_in=true');

  // 4) Create trip with hub + note + family + price lock
  console.log('\n4️⃣ Create trip with hub/note/family/lock...');
  const tripCreate = await jsonFetch(`${baseURL}/trips`, {
    method: 'POST',
    headers: p1Headers,
    body: JSON.stringify({
      pickup_location: 'سيتم استبدالها بالـ Hub',
      dropoff_location: 'وجهة اختبار',
      pickup_lat: 24.7136,
      pickup_lng: 46.6753,
      pickup_accuracy: 6.1,
      pickup_timestamp: Date.now(),
      dropoff_lat: 24.6917,
      dropoff_lng: 46.6853,
      car_type: 'economy',
      cost: 999,
      distance: 10,
      duration: 20,
      payment_method: 'cash',
      pickup_hub_id: hubId,
      passenger_note: 'عندي شنط',
      booked_for_family_member_id: familyMemberId,
      price_lock_id: priceLockId,
      source: 'passenger_app'
    })
  });
  if (!tripCreate.res.ok) throw new Error(`Trip create failed: ${tripCreate.data.error || tripCreate.res.status}`);
  const tripId = tripCreate.data.data.id;
  const snapshot = tripCreate.data.data.accessibility_snapshot_json || null;
  if (!snapshot || snapshot.wheelchair !== true) {
    throw new Error('Trip accessibility_snapshot_json should be copied from profile (wheelchair=true)');
  }
  console.log('✅ Trip created:', tripId);

  // 4️⃣b) Trip messaging board (v2)
  console.log('\n4️⃣b Trip messages (v2)...');
  const msgSend = await jsonFetch(`${baseURL}/trips/${encodeURIComponent(tripId)}/messages`, {
    method: 'POST',
    headers: p1Headers,
    body: JSON.stringify({ template_key: 'pickup', message: 'أنا عند البوابة الرئيسية' })
  });
  if (!msgSend.res.ok) throw new Error(`Trip message send failed: ${msgSend.data.error || msgSend.res.status}`);
  const msgList = await jsonFetch(`${baseURL}/trips/${encodeURIComponent(tripId)}/messages?limit=10`, { headers: p1Headers });
  if (!msgList.res.ok) throw new Error(`Trip messages list failed: ${msgList.data.error || msgList.res.status}`);
  if (!Array.isArray(msgList.data.data) || msgList.data.data.length < 1) throw new Error('Trip messages should return at least one message');

  // 4️⃣c) Driver accessibility acknowledgement (v2) - tested via admin path
  console.log('\n4️⃣c Driver accessibility ack (v2)...');
  const ack = await jsonFetch(`${baseURL}/trips/${encodeURIComponent(tripId)}/accessibility-ack`, {
    method: 'POST',
    headers: adminHeaders,
    body: JSON.stringify({ driver_id: driverId })
  });
  if (!ack.res.ok) throw new Error(`Accessibility ack failed: ${ack.data.error || ack.res.status}`);
  if (!ack.data.data.accessibility_ack_at) throw new Error('Ack response should include accessibility_ack_at');

  // 4️⃣d) Accessibility feedback (v2)
  console.log('\n4️⃣d Accessibility feedback (v2)...');
  const fbTripCreate = await jsonFetch(`${baseURL}/trips`, {
    method: 'POST',
    headers: p1Headers,
    body: JSON.stringify({
      pickup_location: 'FB pickup',
      dropoff_location: 'FB dropoff',
      pickup_lat: 24.7136,
      pickup_lng: 46.6753,
      pickup_accuracy: 6.1,
      pickup_timestamp: Date.now(),
      dropoff_lat: 24.6917,
      dropoff_lng: 46.6853,
      car_type: 'economy',
      cost: 10,
      distance: 1,
      duration: 10,
      payment_method: 'cash',
      status: 'pending',
      source: 'passenger_app'
    })
  });
  if (!fbTripCreate.res.ok) throw new Error(`Feedback trip create failed: ${fbTripCreate.data.error || fbTripCreate.res.status}`);
  const fbTripId = fbTripCreate.data.data.id;

  const fbBefore = await jsonFetch(`${baseURL}/trips/${encodeURIComponent(fbTripId)}/accessibility-feedback`, {
    method: 'POST',
    headers: p1Headers,
    body: JSON.stringify({ respected: true, reason: 'اختبار' })
  });
  if (fbBefore.res.status !== 409) {
    throw new Error(`Expected feedback before completion to be 409, got ${fbBefore.res.status}`);
  }

  const completeForFb = await jsonFetch(`${baseURL}/trips/${encodeURIComponent(fbTripId)}/status`, {
    method: 'PATCH',
    headers: adminHeaders,
    body: JSON.stringify({ status: 'completed', trip_status: 'completed' })
  });
  if (!completeForFb.res.ok) throw new Error(`Trip complete for feedback failed: ${completeForFb.data.error || completeForFb.res.status}`);

  const fbAfter = await jsonFetch(`${baseURL}/trips/${encodeURIComponent(fbTripId)}/accessibility-feedback`, {
    method: 'POST',
    headers: p1Headers,
    body: JSON.stringify({ respected: true, reason: 'تم احترام الاحتياجات' })
  });
  if (!fbAfter.res.ok) throw new Error(`Feedback after completion failed: ${fbAfter.data.error || fbAfter.res.status}`);

  // 5) Favorite captain
  console.log('\n5️⃣ Favorites...');
  const favAdd = await jsonFetch(`${baseURL}/passengers/me/favorites`, {
    method: 'POST',
    headers: p1Headers,
    body: JSON.stringify({ driver_id: driverId })
  });
  if (!favAdd.res.ok) throw new Error(`Favorite add failed: ${favAdd.data.error || favAdd.res.status}`);

  const favList = await jsonFetch(`${baseURL}/passengers/me/favorites`, { headers: p1Headers });
  if (!favList.res.ok) throw new Error(`Favorite list failed: ${favList.data.error || favList.res.status}`);
  console.log('✅ Favorites count:', favList.data.data.length);

  // 6) Driver pickup suggestion + passenger decision
  console.log('\n6️⃣ Pickup suggestion flow...');
  const sug = await jsonFetch(`${baseURL}/trips/${encodeURIComponent(tripId)}/pickup-suggestions`, {
    method: 'POST',
    headers: adminHeaders,
    body: JSON.stringify({ hub_id: hubId })
  });
  if (!sug.res.ok) throw new Error(`Create pickup suggestion failed: ${sug.data.error || sug.res.status}`);
  const suggestionId = sug.data.data.id;

  const sugDecision = await jsonFetch(`${baseURL}/trips/${encodeURIComponent(tripId)}/pickup-suggestions/${encodeURIComponent(suggestionId)}/decision`, {
    method: 'PATCH',
    headers: p1Headers,
    body: JSON.stringify({ decision: 'accepted' })
  });
  if (!sugDecision.res.ok) throw new Error(`Decision failed: ${sugDecision.data.error || sugDecision.res.status}`);
  console.log('✅ Suggestion accepted');

  // 7) ETA update
  console.log('\n7️⃣ ETA update...');
  const etaUpdate = await jsonFetch(`${baseURL}/trips/${encodeURIComponent(tripId)}/eta`, {
    method: 'PATCH',
    headers: adminHeaders,
    body: JSON.stringify({ eta_minutes: 7, eta_reason: 'زحمة' })
  });
  if (!etaUpdate.res.ok) throw new Error(`ETA update failed: ${etaUpdate.data.error || etaUpdate.res.status}`);
  const etaGet = await jsonFetch(`${baseURL}/trips/${encodeURIComponent(tripId)}/eta`, { headers: p1Headers });
  if (!etaGet.res.ok) throw new Error(`ETA get failed: ${etaGet.data.error || etaGet.res.status}`);
  console.log('✅ ETA:', etaGet.data.data.eta_minutes, etaGet.data.data.eta_reason);

  // 8) Safety share + emergency
  console.log('\n8️⃣ Safety...');
  const share = await jsonFetch(`${baseURL}/trips/${encodeURIComponent(tripId)}/share`, {
    method: 'POST',
    headers: p1Headers,
    body: JSON.stringify({ ttl_hours: 1 })
  });
  if (!share.res.ok) throw new Error(`Share failed: ${share.data.error || share.res.status}`);

  const token = share.data.data.share_token;
  const shareGet = await jsonFetch(`${baseURL}/share/${encodeURIComponent(token)}`);
  if (!shareGet.res.ok) throw new Error(`Share GET failed: ${shareGet.data.error || shareGet.res.status}`);

  const emergency = await jsonFetch(`${baseURL}/trips/${encodeURIComponent(tripId)}/safety/emergency`, {
    method: 'POST',
    headers: p1Headers,
    body: JSON.stringify({ message: 'اختبار زر طوارئ' })
  });
  if (!emergency.res.ok) throw new Error(`Emergency failed: ${emergency.data.error || emergency.res.status}`);
  if (!emergency.data.emergency_card || emergency.data.emergency_card.contact_name !== 'Emergency Contact') {
    throw new Error('Emergency should return emergency_card for passenger when opt_in=true');
  }
  console.log('✅ Safety OK + emergency card');

  // 9) Support ticket (no attachment)
  console.log('\n9️⃣ Support ticket...');
  const fd = new FormData();
  fd.append('trip_id', tripId);
  fd.append('category', 'payment');
  fd.append('description', 'اختبار إنشاء تذكرة دعم');

  const tRes = await fetch(`${baseURL}/support/tickets`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${p1.token}` },
    body: fd
  });
  const tData = await tRes.json().catch(() => ({}));
  if (!tRes.ok || !tData.success) throw new Error(`Support ticket failed: ${tData.error || tRes.status}`);
  console.log('✅ Ticket created:', tData.data.id);

  // 9️⃣b) Trusted contacts
  console.log('\n9️⃣b Trusted contacts...');
  const addContact = await jsonFetch(`${baseURL}/passengers/me/trusted-contacts`, {
    method: 'POST',
    headers: p1Headers,
    body: JSON.stringify({ name: 'Guardian Test', channel: 'whatsapp', value: '+966500000000' })
  });
  if (!addContact.res.ok) throw new Error(`Add trusted contact failed: ${addContact.data.error || addContact.res.status}`);
  const contactId = addContact.data.data.id;

  const listContacts = await jsonFetch(`${baseURL}/passengers/me/trusted-contacts`, { headers: p1Headers });
  if (!listContacts.res.ok) throw new Error(`List trusted contacts failed: ${listContacts.data.error || listContacts.res.status}`);
  console.log('✅ Trusted contacts count:', listContacts.data.count);

  const delContact = await jsonFetch(`${baseURL}/passengers/me/trusted-contacts/${encodeURIComponent(contactId)}`, {
    method: 'DELETE',
    headers: p1Headers
  });
  if (!delContact.res.ok) throw new Error(`Delete trusted contact failed: ${delContact.data.error || delContact.res.status}`);

  // 9️⃣c) Basic verification (email + phone)
  console.log('\n9️⃣c Verification (basic)...');
  const emailReq = await jsonFetch(`${baseURL}/users/me/verify/email/request`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${p1.token}` }
  });
  if (!emailReq.res.ok) throw new Error(`Email verify request failed: ${emailReq.data.error || emailReq.res.status}`);
  const emailToken = emailReq.data.data.token;

  const emailConfirm = await jsonFetch(`${baseURL}/users/me/verify/email/confirm`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${p1.token}` },
    body: JSON.stringify({ token: emailToken })
  });
  if (!emailConfirm.res.ok) throw new Error(`Email verify confirm failed: ${emailConfirm.data.error || emailConfirm.res.status}`);

  const phoneReq = await jsonFetch(`${baseURL}/users/me/verify/phone/request`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${p1.token}` }
  });
  if (!phoneReq.res.ok) throw new Error(`Phone verify request failed: ${phoneReq.data.error || phoneReq.res.status}`);
  const otp = phoneReq.data.data.otp;

  const phoneConfirm = await jsonFetch(`${baseURL}/users/me/verify/phone/confirm`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${p1.token}` },
    body: JSON.stringify({ otp })
  });
  if (!phoneConfirm.res.ok) throw new Error(`Phone verify confirm failed: ${phoneConfirm.data.error || phoneConfirm.res.status}`);

  const vStatus1 = await jsonFetch(`${baseURL}/passengers/me/verification/status`, { headers: p1Headers });
  if (!vStatus1.res.ok) throw new Error(`Verification status failed: ${vStatus1.data.error || vStatus1.res.status}`);
  console.log('✅ Verified level (after basic):', vStatus1.data.data.verified_level);

  // 9️⃣d) Strong verification request + upload + admin approve
  console.log('\n9️⃣d Verification (strong)...');
  const strongReq = await jsonFetch(`${baseURL}/passengers/me/verification/request`, {
    method: 'POST',
    headers: p1Headers,
    body: JSON.stringify({ level: 'strong' })
  });
  if (!strongReq.res.ok) throw new Error(`Strong verification request failed: ${strongReq.data.error || strongReq.res.status}`);
  const verificationId = strongReq.data.data.id;

  const fdStrong = new FormData();
  fdStrong.append('verification_id', String(verificationId));
  fdStrong.append('id_document', new Blob(['id'], { type: 'image/png' }), 'id.png');
  fdStrong.append('selfie', new Blob(['selfie'], { type: 'image/png' }), 'selfie.png');

  const upRes = await fetch(`${baseURL}/passengers/me/verification/upload`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${p1.token}` },
    body: fdStrong
  });
  const upData = await upRes.json().catch(() => ({}));
  if (!upRes.ok || !upData.success) throw new Error(`Strong verification upload failed: ${upData.error || upRes.status}`);

  const pendingList = await jsonFetch(`${baseURL}/admin/passenger-verifications?status=pending`, { headers: adminHeaders });
  if (!pendingList.res.ok) throw new Error(`Admin pending list failed: ${pendingList.data.error || pendingList.res.status}`);
  const found = pendingList.data.data.find((x) => String(x.id) === String(verificationId));
  if (!found) throw new Error('Strong verification not found in pending list');

  const approve = await jsonFetch(`${baseURL}/admin/passenger-verifications/${encodeURIComponent(verificationId)}`, {
    method: 'PATCH',
    headers: adminHeaders,
    body: JSON.stringify({ status: 'approved' })
  });
  if (!approve.res.ok) throw new Error(`Admin approve failed: ${approve.data.error || approve.res.status}`);

  const vStatus2 = await jsonFetch(`${baseURL}/passengers/me/verification/status`, { headers: p1Headers });
  if (!vStatus2.res.ok) throw new Error(`Verification status 2 failed: ${vStatus2.data.error || vStatus2.res.status}`);
  console.log('✅ Verified level (after strong):', vStatus2.data.data.verified_level);

  // 9️⃣e) Pickup handshake + safety OK/Help + guardian check-ins
  console.log('\n9️⃣e Pickup handshake + guardian + safety...');
  const assignTrip = await jsonFetch(`${baseURL}/trips/${encodeURIComponent(tripId)}/assign`, {
    method: 'PATCH',
    headers: adminHeaders,
    body: JSON.stringify({ driver_id: driverId, driver_name: 'Test Driver' })
  });
  if (!assignTrip.res.ok) throw new Error(`Assign main trip failed: ${assignTrip.data.error || assignTrip.res.status}`);

  // Driver feed should include verification level
  const driverFeed = await jsonFetch(`${baseURL}/drivers/${encodeURIComponent(driverId)}/pending-rides?max_distance=30`, {
    headers: adminHeaders
  });
  if (!driverFeed.res.ok) throw new Error(`Driver pending rides feed failed: ${driverFeed.data.error || driverFeed.res.status}`);
  if (driverFeed.data.data.length > 0) {
    const first = driverFeed.data.data[0];
    if (!('passenger_verified_level' in first)) {
      throw new Error('Driver feed missing passenger_verified_level');
    }
  }

  const handshake = await jsonFetch(`${baseURL}/trips/${encodeURIComponent(tripId)}/pickup-handshake`, { headers: p1Headers });
  if (!handshake.res.ok) throw new Error(`Pickup handshake GET failed: ${handshake.data.error || handshake.res.status}`);
  const code = handshake.data.data.pickup_phrase;
  const qr = handshake.data.data.qr_png_data_url;
  if (!qr || typeof qr !== 'string' || !qr.startsWith('data:image/png')) {
    throw new Error('Pickup handshake missing qr_png_data_url');
  }

  const verify = await jsonFetch(`${baseURL}/trips/${encodeURIComponent(tripId)}/pickup-handshake/verify`, {
    method: 'POST',
    headers: adminHeaders,
    body: JSON.stringify({ code })
  });
  if (!verify.res.ok) throw new Error(`Pickup handshake verify failed: ${verify.data.error || verify.res.status}`);

  const deviationCfg = await jsonFetch(`${baseURL}/trips/${encodeURIComponent(tripId)}/safety/deviation-config`, {
    method: 'POST',
    headers: p1Headers,
    body: JSON.stringify({ enabled: true, deviation_threshold_km: 1.5, stop_minutes_threshold: 5 })
  });
  if (!deviationCfg.res.ok) throw new Error(`Deviation config failed: ${deviationCfg.data.error || deviationCfg.res.status}`);

  const okEvt = await jsonFetch(`${baseURL}/trips/${encodeURIComponent(tripId)}/safety/ok`, {
    method: 'POST',
    headers: p1Headers
  });
  if (!okEvt.res.ok) throw new Error(`Safety OK failed: ${okEvt.data.error || okEvt.res.status}`);

  const helpEvt = await jsonFetch(`${baseURL}/trips/${encodeURIComponent(tripId)}/safety/help`, {
    method: 'POST',
    headers: p1Headers
  });
  if (!helpEvt.res.ok) throw new Error(`Safety Help failed: ${helpEvt.data.error || helpEvt.res.status}`);
  console.log('✅ Safety help share url:', helpEvt.data.share_url);

  const guardianSchedule = await jsonFetch(`${baseURL}/trips/${encodeURIComponent(tripId)}/guardian/checkin`, {
    method: 'POST',
    headers: p1Headers,
    body: JSON.stringify({ due_at: new Date(Date.now() - 60 * 1000).toISOString() })
  });
  if (!guardianSchedule.res.ok) throw new Error(`Guardian schedule failed: ${guardianSchedule.data.error || guardianSchedule.res.status}`);

  const guardianProcess = await jsonFetch(`${baseURL}/admin/jobs/guardian-checkins/process`, {
    method: 'POST',
    headers: adminHeaders,
    body: JSON.stringify({ limit: 20 })
  });
  if (!guardianProcess.res.ok) throw new Error(`Guardian process failed: ${guardianProcess.data.error || guardianProcess.res.status}`);
  console.log('✅ Guardian processed:', guardianProcess.data.processed);

  const guardianConfirm = await jsonFetch(`${baseURL}/trips/${encodeURIComponent(tripId)}/guardian/confirm`, {
    method: 'POST',
    headers: p1Headers
  });
  if (!guardianConfirm.res.ok) throw new Error(`Guardian confirm failed: ${guardianConfirm.data.error || guardianConfirm.res.status}`);

  // 9️⃣f) Safety Capsule aggregate
  console.log('\n9️⃣f Safety Capsule...');
  const capsule = await jsonFetch(`${baseURL}/trips/${encodeURIComponent(tripId)}/safety/capsule`, { headers: p1Headers });
  if (!capsule.res.ok) throw new Error(`Safety capsule failed: ${capsule.data.error || capsule.res.status}`);
  if (!capsule.data.success || !capsule.data.data) throw new Error('Safety capsule missing data');
  if (!Array.isArray(capsule.data.data.timeline)) throw new Error('Safety capsule missing timeline array');
  if (!capsule.data.data.handshake) throw new Error('Safety capsule missing handshake');
  console.log('✅ Safety capsule timeline items:', capsule.data.data.timeline.length);

  // 10) Scheduled ride create + confirm + process
  console.log('\n🔟 Scheduled rides...');
  const scheduled = await jsonFetch(`${baseURL}/scheduled-rides`, {
    method: 'POST',
    headers: p1Headers,
    body: JSON.stringify({
      pickup_location: 'التقاط مجدول',
      dropoff_location: 'وجهة مجدولة',
      pickup_lat: 24.7136,
      pickup_lng: 46.6753,
      dropoff_lat: 24.6917,
      dropoff_lng: 46.6853,
      car_type: 'economy',
      payment_method: 'cash',
      scheduled_at: new Date(Date.now() + 10 * 60 * 1000).toISOString()
    })
  });
  if (!scheduled.res.ok) throw new Error(`Scheduled create failed: ${scheduled.data.error || scheduled.res.status}`);
  const scheduledId = scheduled.data.data.id;

  const confirm = await jsonFetch(`${baseURL}/scheduled-rides/${scheduledId}/confirm`, {
    method: 'POST',
    headers: p1Headers
  });
  if (!confirm.res.ok) throw new Error(`Scheduled confirm failed: ${confirm.data.error || confirm.res.status}`);

  const processDue = await jsonFetch(`${baseURL}/scheduled-rides/process`, {
    method: 'POST',
    headers: adminHeaders,
    body: JSON.stringify({ window_minutes: 20 })
  });
  if (!processDue.res.ok) throw new Error(`Scheduled process failed: ${processDue.data.error || processDue.res.status}`);
  console.log('✅ Scheduled processed:', processDue.data.created_count);

  // 11) Multi-stop repricing
  console.log('\n1️⃣1️⃣ Multi-stop...');
  const stops = await jsonFetch(`${baseURL}/trips/${encodeURIComponent(tripId)}/stops`, {
    method: 'POST',
    headers: p1Headers,
    body: JSON.stringify({
      stops: [
        { lat: 24.705, lng: 46.68, label: 'محطة 1' },
        { lat: 24.699, lng: 46.682, label: 'محطة 2' }
      ]
    })
  });
  if (!stops.res.ok) throw new Error(`Stops failed: ${stops.data.error || stops.res.status}`);
  console.log('✅ Stops set. New price:', stops.data.trip?.price);

  // 12) Split fare + wallet ledger (end trip)
  console.log('\n1️⃣2️⃣ Split fare + wallet debit...');
  await creditWallet(adminHeaders, p1.user.id, 100, `credit-${tripId}-p1`);
  await creditWallet(adminHeaders, p2.user.id, 100, `credit-${tripId}-p2`);

  const splitTrip = await jsonFetch(`${baseURL}/trips`, {
    method: 'POST',
    headers: p1Headers,
    body: JSON.stringify({
      pickup_location: 'Split pickup',
      dropoff_location: 'Split dropoff',
      pickup_lat: 24.7136,
      pickup_lng: 46.6753,
      pickup_accuracy: 7,
      pickup_timestamp: Date.now(),
      dropoff_lat: 24.6917,
      dropoff_lng: 46.6853,
      car_type: 'economy',
      cost: 50,
      distance: 10,
      duration: 20,
      payment_method: 'split',
      source: 'passenger_app'
    })
  });
  if (!splitTrip.res.ok) throw new Error(`Split trip create failed: ${splitTrip.data.error || splitTrip.res.status}`);
  const splitTripId = splitTrip.data.data.id;

  // assign driver
  const assign = await jsonFetch(`${baseURL}/trips/${encodeURIComponent(splitTripId)}/assign`, {
    method: 'PATCH',
    headers: adminHeaders,
    body: JSON.stringify({ driver_id: driverId, driver_name: 'Test Driver' })
  });
  if (!assign.res.ok) throw new Error(`Assign failed: ${assign.data.error || assign.res.status}`);

  // mark started
  const start = await jsonFetch(`${baseURL}/trips/${encodeURIComponent(splitTripId)}/status`, {
    method: 'PATCH',
    headers: adminHeaders,
    body: JSON.stringify({ status: 'ongoing', trip_status: 'started' })
  });
  if (!start.res.ok) throw new Error(`Start failed: ${start.data.error || start.res.status}`);

  const before1 = await getWalletBalance(p1.token);
  const before2 = await getWalletBalance(p2.token);

  // set split participants
  const setSplit = await jsonFetch(`${baseURL}/trips/${encodeURIComponent(splitTripId)}/split-fare`, {
    method: 'POST',
    headers: p1Headers,
    body: JSON.stringify({
      splits: [
        { user_id: p1.user.id, amount: 30, method: 'wallet' },
        { user_id: p2.user.id, amount: 20, method: 'wallet' }
      ]
    })
  });
  if (!setSplit.res.ok) throw new Error(`Set split failed: ${setSplit.data.error || setSplit.res.status}`);

  // end trip (charges wallets)
  const end = await jsonFetch(`${baseURL}/trips/end`, {
    method: 'POST',
    headers: adminHeaders,
    body: JSON.stringify({ trip_id: splitTripId, driver_id: driverId, price: 50, distance_km: 10 })
  });
  if (!end.res.ok) throw new Error(`End trip failed: ${end.data.error || end.res.status}`);

  const after1 = await getWalletBalance(p1.token);
  const after2 = await getWalletBalance(p2.token);

  console.log('✅ Wallet debits applied:', {
    p1: { before: before1, after: after1 },
    p2: { before: before2, after: after2 }
  });

  // 13) Loyalty endpoint
  console.log('\n1️⃣3️⃣ Loyalty...');
  const loyalty = await jsonFetch(`${baseURL}/passengers/me/loyalty`, { headers: p1Headers });
  if (!loyalty.res.ok) throw new Error(`Loyalty failed: ${loyalty.data.error || loyalty.res.status}`);
  console.log('✅ Tier:', loyalty.data.data.tier, 'completed:', loyalty.data.data.completed_trips);

  // 14) Receipt endpoint
  console.log('\n1️⃣4️⃣ Receipt...');
  const receipt = await jsonFetch(`${baseURL}/trips/${encodeURIComponent(splitTripId)}/receipt`, { headers: p1Headers });
  if (!receipt.res.ok) throw new Error(`Receipt failed: ${receipt.data.error || receipt.res.status}`);
  console.log('✅ Receipt OK');

  // 15) Saved Places (v3)
  console.log('\n1️⃣5️⃣ Saved Places (v3)...');
  const spHome = await jsonFetch(`${baseURL}/passengers/me/places`, {
    method: 'POST',
    headers: p1Headers,
    body: JSON.stringify({ label: 'home', name: 'البيت', lat: 24.7136, lng: 46.6753 })
  });
  if (!spHome.res.ok) throw new Error(`Saved place (home) failed: ${spHome.data.error || spHome.res.status}`);

  const spWork = await jsonFetch(`${baseURL}/passengers/me/places`, {
    method: 'POST',
    headers: p1Headers,
    body: JSON.stringify({ label: 'work', name: 'الشغل', lat: 24.6917, lng: 46.6853 })
  });
  if (!spWork.res.ok) throw new Error(`Saved place (work) failed: ${spWork.data.error || spWork.res.status}`);

  const spCustom = await jsonFetch(`${baseURL}/passengers/me/places`, {
    method: 'POST',
    headers: p1Headers,
    body: JSON.stringify({ label: 'custom', name: 'مكان محفوظ', lat: 24.7001, lng: 46.6801, notes: 'بوابة' })
  });
  if (!spCustom.res.ok) throw new Error(`Saved place (custom) failed: ${spCustom.data.error || spCustom.res.status}`);

  const spList = await jsonFetch(`${baseURL}/passengers/me/places`, { headers: p1Headers });
  if (!spList.res.ok) throw new Error(`Saved places list failed: ${spList.data.error || spList.res.status}`);
  if (!Array.isArray(spList.data.data) || spList.data.data.length < 2) throw new Error('Saved places list missing rows');

  const spDelId = spCustom.data.data.id;
  const spDel = await jsonFetch(`${baseURL}/passengers/me/places/${encodeURIComponent(String(spDelId))}`, {
    method: 'DELETE',
    headers: p1Headers
  });
  if (!spDel.res.ok) throw new Error(`Saved place delete failed: ${spDel.data.error || spDel.res.status}`);

  // 16) Trip Templates (v3)
  console.log('\n1️⃣6️⃣ Trip Templates (v3)...');
  const tplCreate = await jsonFetch(`${baseURL}/passengers/me/trip-templates`, {
    method: 'POST',
    headers: p1Headers,
    body: JSON.stringify({
      title: 'قالب سريع',
      payload_json: {
        dropoff_location: 'وجهة القالب',
        dropoff_lat: 24.6917,
        dropoff_lng: 46.6853,
        car_type: 'economy',
        payment_method: 'cash',
        passenger_note: 'من فضلك بسرعة'
      }
    })
  });
  if (!tplCreate.res.ok) throw new Error(`Template create failed: ${tplCreate.data.error || tplCreate.res.status}`);
  const tplId = tplCreate.data.data.id;

  const tplList = await jsonFetch(`${baseURL}/passengers/me/trip-templates`, { headers: p1Headers });
  if (!tplList.res.ok) throw new Error(`Template list failed: ${tplList.data.error || tplList.res.status}`);
  if (!Array.isArray(tplList.data.data) || tplList.data.data.length < 1) throw new Error('Template list empty');

  const tplDel = await jsonFetch(`${baseURL}/passengers/me/trip-templates/${encodeURIComponent(String(tplId))}`, {
    method: 'DELETE',
    headers: p1Headers
  });
  if (!tplDel.res.ok) throw new Error(`Template delete failed: ${tplDel.data.error || tplDel.res.status}`);

  // 17) Ride Pass discount applied on trip creation (v3)
  console.log('\n1️⃣7️⃣ Ride Pass (v3)...');
  const passCreate = await jsonFetch(`${baseURL}/passengers/me/passes`, {
    method: 'POST',
    headers: p1Headers,
    body: JSON.stringify({
      type: 'اختبار-خصم',
      rules_json: { discount_type: 'percent', value: 10, max_discount: 20 },
      status: 'active',
      valid_to: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString()
    })
  });
  if (!passCreate.res.ok) throw new Error(`Pass create failed: ${passCreate.data.error || passCreate.res.status}`);

  const passTrip = await jsonFetch(`${baseURL}/trips`, {
    method: 'POST',
    headers: p1Headers,
    body: JSON.stringify({
      pickup_location: 'Pickup pass',
      dropoff_location: 'Dropoff pass',
      pickup_lat: 24.7136,
      pickup_lng: 46.6753,
      pickup_accuracy: 7,
      pickup_timestamp: Date.now(),
      dropoff_lat: 24.6917,
      dropoff_lng: 46.6853,
      car_type: 'economy',
      cost: 100,
      distance: 10,
      duration: 20,
      payment_method: 'cash',
      source: 'passenger_app'
    })
  });
  if (!passTrip.res.ok) throw new Error(`Trip with pass create failed: ${passTrip.data.error || passTrip.res.status}`);
  const passTripRow = passTrip.data.data;
  if (!(Number(passTripRow.cost) < 100)) {
    throw new Error(`Expected discounted cost < 100, got: ${passTripRow.cost}`);
  }
  if (!passTripRow.discount_amount) {
    throw new Error('Expected discount_amount on trip');
  }
  console.log('✅ Pass discount applied:', { before: passTripRow.fare_before_discount, discount: passTripRow.discount_amount, after: passTripRow.cost });

  // 18) Lost & Found (v3)
  console.log('\n1️⃣8️⃣ Lost & Found (v3)...');
  const lostCreate = await jsonFetch(`${baseURL}/trips/${encodeURIComponent(splitTripId)}/lost-items`, {
    method: 'POST',
    headers: p1Headers,
    body: JSON.stringify({ description: 'محفظة', contact_method: 'phone' })
  });
  if (!lostCreate.res.ok) throw new Error(`Lost item create failed: ${lostCreate.data.error || lostCreate.res.status}`);

  const lostMine = await jsonFetch(`${baseURL}/support/me/lost-items`, { headers: p1Headers });
  if (!lostMine.res.ok) throw new Error(`Lost items list failed: ${lostMine.data.error || lostMine.res.status}`);
  if (!Array.isArray(lostMine.data.data) || lostMine.data.data.length < 1) throw new Error('Lost items list empty');

  const lostAdmin = await jsonFetch(`${baseURL}/admin/lost-items`, { headers: adminHeaders });
  if (!lostAdmin.res.ok) throw new Error(`Admin lost items failed: ${lostAdmin.data.error || lostAdmin.res.status}`);

  const lostId = lostCreate.data.data.id;
  const lostUpdate = await jsonFetch(`${baseURL}/admin/lost-items/${encodeURIComponent(String(lostId))}`, {
    method: 'PATCH',
    headers: adminHeaders,
    body: JSON.stringify({ status: 'resolved' })
  });
  if (!lostUpdate.res.ok) throw new Error(`Admin lost update failed: ${lostUpdate.data.error || lostUpdate.res.status}`);

  // 19) Refund Requests (v3)
  console.log('\n1️⃣9️⃣ Refund Requests (v3)...');
  const beforeRefundBal = await getWalletBalance(p1.token);

  const rrCreate = await jsonFetch(`${baseURL}/trips/${encodeURIComponent(splitTripId)}/refund-request`, {
    method: 'POST',
    headers: p1Headers,
    body: JSON.stringify({ reason: 'مشكلة في الأجرة', amount_requested: 5 })
  });
  if (!rrCreate.res.ok) throw new Error(`Refund request create failed: ${rrCreate.data.error || rrCreate.res.status}`);
  const rrId = rrCreate.data.data.id;

  const rrMine = await jsonFetch(`${baseURL}/support/me/refund-requests`, { headers: p1Headers });
  if (!rrMine.res.ok) throw new Error(`Refund requests list failed: ${rrMine.data.error || rrMine.res.status}`);
  if (!Array.isArray(rrMine.data.data) || rrMine.data.data.length < 1) throw new Error('Refund requests list empty');

  const rrAdmin = await jsonFetch(`${baseURL}/admin/refund-requests`, { headers: adminHeaders });
  if (!rrAdmin.res.ok) throw new Error(`Admin refund requests failed: ${rrAdmin.data.error || rrAdmin.res.status}`);

  const rrApprove = await jsonFetch(`${baseURL}/admin/refund-requests/${encodeURIComponent(String(rrId))}`, {
    method: 'PATCH',
    headers: adminHeaders,
    body: JSON.stringify({ status: 'approved', amount_approved: 5, resolution_note: 'تمت الموافقة' })
  });
  if (!rrApprove.res.ok) throw new Error(`Refund approve failed: ${rrApprove.data.error || rrApprove.res.status}`);

  const afterRefundBal = await getWalletBalance(p1.token);
  if (afterRefundBal < beforeRefundBal + 5) {
    throw new Error(`Expected wallet credit after refund. Before=${beforeRefundBal}, After=${afterRefundBal}`);
  }

  // 20) Tip after trip (v3)
  console.log('\n2️⃣0️⃣ Tip (v3)...');
  const tip = await jsonFetch(`${baseURL}/trips/${encodeURIComponent(splitTripId)}/tip`, {
    method: 'POST',
    headers: p1Headers,
    body: JSON.stringify({ amount: 2, method: 'cash' })
  });
  if (!tip.res.ok) throw new Error(`Tip failed: ${tip.data.error || tip.res.status}`);

  const receipt2 = await jsonFetch(`${baseURL}/trips/${encodeURIComponent(splitTripId)}/receipt`, { headers: p1Headers });
  if (!receipt2.res.ok) throw new Error(`Receipt (after tip) failed: ${receipt2.data.error || receipt2.res.status}`);
  const tips = Array.isArray(receipt2.data.data?.tips) ? receipt2.data.data.tips : [];
  if (!tips.length) throw new Error('Expected tips array in receipt');
  console.log('✅ Tip recorded in receipt');

  // 21) Smart Rebook (v3)
  console.log('\n2️⃣1️⃣ Smart Rebook (v3)...');
  const cancel = await jsonFetch(`${baseURL}/trips/${encodeURIComponent(passTripRow.id)}/status`, {
    method: 'PATCH',
    headers: p1Headers,
    body: JSON.stringify({ status: 'cancelled' })
  });
  if (!cancel.res.ok) throw new Error(`Cancel trip failed: ${cancel.data.error || cancel.res.status}`);

  const rebook = await jsonFetch(`${baseURL}/trips/${encodeURIComponent(passTripRow.id)}/rebook`, {
    method: 'POST',
    headers: p1Headers
  });
  if (!rebook.res.ok) throw new Error(`Rebook failed: ${rebook.data.error || rebook.res.status}`);
  if (!rebook.data.data?.id) throw new Error('Rebook missing new trip id');
  console.log('✅ Rebook created:', rebook.data.data.id);

  console.log('\n✅ Passenger features tests finished');
}

run().catch((err) => {
  console.error('❌ Passenger features tests failed:', err.message);
  process.exit(1);
});
