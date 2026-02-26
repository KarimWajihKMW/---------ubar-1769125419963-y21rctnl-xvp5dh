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
  console.log('🧪 Testing Executive Admin Suite endpoints');
  const admin = await loginAdmin();
  console.log(`✅ Admin login OK: ${admin.email}`);

  const headers = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${admin.token}`
  };

  const simulate = await jsonFetch(`${baseURL}/admin/executive/simulate`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      zone_key: 'citywide',
      pricing_delta_pct: 10,
      driver_supply_delta_pct: 15,
      scenario_key: 'smoke_test'
    })
  });
  assertOk('simulate', simulate.res, simulate.data);
  console.log('✅ POST /admin/executive/simulate');

  const expected = simulate.data?.data?.projected
    ? {
        avg_wait_minutes: simulate.data.data.projected.avg_wait_minutes,
        cancel_rate: simulate.data.data.projected.cancel_rate,
        incidents_count: simulate.data.data.projected.incidents_count,
        revenue_completed: simulate.data.data.projected.revenue_completed
      }
    : null;

  const createDecision = await jsonFetch(`${baseURL}/admin/executive/decisions`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      title: 'Smoke test executive decision',
      reason: 'Automated API smoke test',
      hypothesis: 'Trust improves in next checkpoints',
      decision_type: 'smoke_test',
      zone_key: 'citywide',
      expected_impact: expected
    })
  });
  assertOk('create decision', createDecision.res, createDecision.data);
  const decisionId = createDecision.data?.data?.id;
  if (!decisionId) throw new Error('create decision returned no decision id');
  console.log('✅ POST /admin/executive/decisions');

  const impact = await jsonFetch(`${baseURL}/admin/executive/decision-impact/${encodeURIComponent(decisionId)}`, { headers });
  assertOk('decision impact', impact.res, impact.data);
  console.log('✅ GET /admin/executive/decision-impact/:id');

  const trustIndex = await jsonFetch(`${baseURL}/admin/executive/trust-index?refresh=true`, { headers });
  assertOk('trust index', trustIndex.res, trustIndex.data);
  console.log('✅ GET /admin/executive/trust-index');

  const triggerPlaybook = await jsonFetch(`${baseURL}/admin/executive/playbook/trigger`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      playbook_key: 'shock_autopilot',
      source: 'smoke_test',
      decision_id: decisionId,
      payload: { reason: 'smoke test trigger' }
    })
  });
  assertOk('playbook trigger', triggerPlaybook.res, triggerPlaybook.data);
  console.log('✅ POST /admin/executive/playbook/trigger');

  const briefing = await jsonFetch(`${baseURL}/admin/executive/briefing`, { headers });
  assertOk('briefing', briefing.res, briefing.data);
  if (!briefing.data?.data?.narrative_ar) throw new Error('briefing returned empty narrative');
  console.log('✅ GET /admin/executive/briefing');

  const audit = await jsonFetch(`${baseURL}/admin/audit?decision_id=${encodeURIComponent(decisionId)}&limit=10`, { headers });
  assertOk('audit decision link', audit.res, audit.data);
  const firstAudit = Array.isArray(audit.data?.data) ? audit.data.data[0] : null;
  if (!firstAudit || Number(firstAudit.decision_id) !== Number(decisionId)) {
    throw new Error('audit did not return decision-linked rows');
  }
  if (!firstAudit.decision_title || !firstAudit.decision_reason) {
    throw new Error('audit missing decision context fields');
  }
  console.log('✅ GET /admin/audit with decision context');

  console.log('🎉 Executive Admin Suite smoke tests passed');
}

run().catch((err) => {
  console.error('❌ Executive suite smoke test failed:', err.message || err);
  process.exit(1);
});
