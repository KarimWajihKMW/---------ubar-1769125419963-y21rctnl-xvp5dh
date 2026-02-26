const baseURL = process.env.API_BASE_URL || 'http://localhost:3000/api';

async function jsonFetch(url, options = {}) {
  const res = await fetch(url, options);
  const data = await res.json().catch(() => ({}));
  return { res, data };
}

function assertOk(name, res, data) {
  if (!res.ok || !data?.success) {
    throw new Error(`${name} failed: HTTP ${res.status} ${data?.error || ''}`.trim());
  }
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
    if (res.ok && data?.success && data?.token) {
      return { token: data.token, email: c.email };
    }
  }
  throw new Error('Admin login failed');
}

async function run() {
  console.log('🧪 Testing Admin Risk Command endpoints');
  const admin = await loginAdmin();
  console.log(`✅ Admin login OK: ${admin.email}`);

  const headers = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${admin.token}`
  };

  const features = await jsonFetch(`${baseURL}/admin/risk/features`, { headers });
  assertOk('risk features', features.res, features.data);
  if (!Array.isArray(features.data?.data) || features.data.data.length < 7) {
    throw new Error('risk features expected at least 7 default features');
  }
  const feature = features.data.data[0];
  if (!feature?.key) throw new Error('risk feature key missing');
  console.log('✅ GET /admin/risk/features');

  const patch = await jsonFetch(`${baseURL}/admin/risk/features/${encodeURIComponent(feature.key)}`, {
    method: 'PATCH',
    headers,
    body: JSON.stringify({ stage: 'expand' })
  });
  assertOk('risk feature patch', patch.res, patch.data);
  console.log('✅ PATCH /admin/risk/features/:key');

  const scan = await jsonFetch(`${baseURL}/admin/risk/scan`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ feature_key: feature.key })
  });
  assertOk('risk scan', scan.res, scan.data);
  if (!scan.data?.data?.summary) throw new Error('scan summary missing');
  console.log('✅ POST /admin/risk/scan');

  const alerts = await jsonFetch(`${baseURL}/admin/risk/alerts?limit=30`, { headers });
  assertOk('risk alerts', alerts.res, alerts.data);
  console.log('✅ GET /admin/risk/alerts');

  const metrics = await jsonFetch(`${baseURL}/admin/risk/metrics?hours=24`, { headers });
  assertOk('risk metrics', metrics.res, metrics.data);
  console.log('✅ GET /admin/risk/metrics');

  const locks = await jsonFetch(`${baseURL}/admin/risk/locks?active_only=0&limit=20`, { headers });
  assertOk('risk locks', locks.res, locks.data);
  console.log('✅ GET /admin/risk/locks');

  const firstAlert = Array.isArray(alerts.data?.data) ? alerts.data.data.find(a => String(a.status) === 'open') : null;
  if (firstAlert?.id) {
    const decision = await jsonFetch(`${baseURL}/admin/risk/alerts/${encodeURIComponent(firstAlert.id)}/decision`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ decision: 'monitor', note: 'smoke-test' })
    });
    assertOk('risk alert decision', decision.res, decision.data);
    console.log('✅ POST /admin/risk/alerts/:id/decision');
  } else {
    console.log('ℹ️ No open alert to decision in this run');
  }

  console.log('🎉 Admin Risk Command smoke tests passed');
}

run().catch((err) => {
  console.error('❌ Admin Risk Command smoke test failed:', err.message || err);
  process.exit(1);
});
