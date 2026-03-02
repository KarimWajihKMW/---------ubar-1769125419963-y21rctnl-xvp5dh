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

    if (res.ok && data.success && data.token) {
      return { token: data.token, user: data.data, email: c.email };
    }
  }

  throw new Error('Admin login failed: set ADMIN_EMAIL and ADMIN_PASSWORD env vars if needed');
}

async function testAdminInnovations() {
  console.log('🧪 Testing Admin Innovations APIs (10 approved features)');

  const admin = await loginAdmin();
  console.log(`✅ Admin login OK: ${admin.email}`);

  const headers = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${admin.token}`
  };

  {
    const { res, data } = await jsonFetch(`${baseURL}/admin/innovations/features`, { headers });
    assertOk('features list', res, data);
    console.log('✅ Features list');
  }

  {
    const { res, data } = await jsonFetch(`${baseURL}/admin/innovations/roadmap`, { headers });
    assertOk('innovations roadmap', res, data);
    console.log('✅ Roadmap coverage');
  }

  {
    const { res, data } = await jsonFetch(`${baseURL}/admin/innovations/compliance-report`, { headers });
    assertOk('innovations compliance report', res, data);
    console.log('✅ Governance compliance report');
  }

  {
    const { res, data } = await jsonFetch(`${baseURL}/admin/innovations/policy-twin/simulate`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        policy_name: 'smoke_policy_v1',
        pricing_delta_pct: 5,
        driver_supply_delta_pct: 8,
        fairness_delta_pct: 6
      })
    });
    assertOk('Policy Twin Simulator', res, data);
    console.log('✅ 1) Policy Twin Simulator');
  }

  {
    const { res, data } = await jsonFetch(`${baseURL}/admin/innovations/city-pulse/genome?refresh=1`, { headers });
    assertOk('City Pulse Genome', res, data);
    console.log('✅ 2) City Pulse Genome');
  }

  {
    const rebuild = await jsonFetch(`${baseURL}/admin/innovations/trust-route/rebuild`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ window_days: 14 })
    });
    assertOk('Trust-by-Route Index rebuild', rebuild.res, rebuild.data);

    const list = await jsonFetch(`${baseURL}/admin/innovations/trust-route?limit=20`, { headers });
    assertOk('Trust-by-Route Index list', list.res, list.data);
    console.log('✅ 3) Trust-by-Route Index');
  }

  {
    const create = await jsonFetch(`${baseURL}/admin/innovations/outcome-market/decision`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        title: 'Smoke outcome market decision',
        hypothesis: 'Adjust dispatch can reduce cancel rate',
        stake_points: 15,
        predicted_impact: { cancel_rate: -0.08, avg_wait_minutes: -1.1 }
      })
    });
    assertOk('Outcome Market create', create.res, create.data);

    const id = create.data?.data?.id;
    if (!id) throw new Error('Outcome Market create returned no id');

    const settle = await jsonFetch(`${baseURL}/admin/innovations/outcome-market/${id}/settle`, {
      method: 'PATCH',
      headers,
      body: JSON.stringify({ actual_impact: { cancel_rate: -0.05, avg_wait_minutes: -0.9 } })
    });
    assertOk('Outcome Market settle', settle.res, settle.data);
    console.log('✅ 4) Outcome Market');
  }

  {
    const { res, data } = await jsonFetch(`${baseURL}/admin/innovations/silent-crisis/predict`, { headers });
    assertOk('Silent Crisis Predictor', res, data);
    console.log('✅ 5) Silent Crisis Predictor');
  }

  {
    const { res, data } = await jsonFetch(`${baseURL}/admin/innovations/recovery-composer/compose`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        case_type: 'support_ticket',
        case_id: `smoke-${Date.now()}`,
        severity: 'high',
        inconvenience_minutes: 35,
        sentiment: 42
      })
    });
    assertOk('Recovery Composer', res, data);
    console.log('✅ 6) Recovery Composer');
  }

  {
    const getDial = await jsonFetch(`${baseURL}/admin/innovations/ethical-dial`, { headers });
    assertOk('Ethical Risk Dial GET', getDial.res, getDial.data);

    const patchDial = await jsonFetch(`${baseURL}/admin/innovations/ethical-dial`, {
      method: 'PATCH',
      headers,
      body: JSON.stringify({ profit_weight: 0.3, fairness_weight: 0.3, safety_weight: 0.4 })
    });
    assertOk('Ethical Risk Dial PATCH', patchDial.res, patchDial.data);
    console.log('✅ 7) Ethical Risk Dial');
  }

  {
    const { res, data } = await jsonFetch(`${baseURL}/admin/innovations/narrative-audit/build`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ title: 'Smoke narrative', window_hours: 24 })
    });
    assertOk('Narrative Audit Lens', res, data);
    console.log('✅ 8) Narrative Audit Lens');
  }

  {
    const session = await jsonFetch(`${baseURL}/admin/innovations/copilot-arena/session`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ scenario_type: 'dispatch_shock', difficulty: 'hard' })
    });
    assertOk('Admin Copilot Arena session create', session.res, session.data);
    const sid = session.data?.data?.id;
    if (!sid) throw new Error('Admin Copilot Arena create returned no id');

    const score = await jsonFetch(`${baseURL}/admin/innovations/copilot-arena/session/${sid}/score`, {
      method: 'PATCH',
      headers,
      body: JSON.stringify({ submitted_decision: { action_speed: 80, safety_weight: 85, fairness_weight: 78 } })
    });
    assertOk('Admin Copilot Arena score', score.res, score.data);
    console.log('✅ 9) Admin Copilot Arena');
  }

  {
    const rebalance = await jsonFetch(`${baseURL}/admin/innovations/hub-rebalancer/rebalance`, {
      method: 'POST',
      headers,
      body: JSON.stringify({})
    });
    assertOk('Autonomous Hub Rebalancer rebalance', rebalance.res, rebalance.data);

    const actions = await jsonFetch(`${baseURL}/admin/innovations/hub-rebalancer/actions`, { headers });
    assertOk('Autonomous Hub Rebalancer actions', actions.res, actions.data);
    console.log('✅ 10) Autonomous Hub Rebalancer');
  }

  {
    const { res, data } = await jsonFetch(`${baseURL}/admin/innovations/kpis/summary`, { headers });
    assertOk('Innovation KPIs summary', res, data);
    console.log('✅ KPIs summary');
  }

  console.log('🎉 Admin Innovations API smoke test passed');
}

testAdminInnovations().catch((err) => {
  console.error('❌ Admin Innovations API smoke test failed:', err.message || err);
  process.exit(1);
});
