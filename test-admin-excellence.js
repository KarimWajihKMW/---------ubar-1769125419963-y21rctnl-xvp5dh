const baseURL = process.env.API_BASE_URL || 'http://localhost:3000/api';

async function jsonFetch(url, options = {}) {
  const res = await fetch(url, options);
  const data = await res.json().catch(() => ({}));
  return { res, data };
}

function todayISODate() {
  const d = new Date();
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
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

function assertOk(name, res, data) {
  if (!res.ok || !data?.success) {
    throw new Error(`${name} failed: HTTP ${res.status} ${data?.error || ''}`.trim());
  }
}

async function testAdminExcellence() {
  console.log('🧪 Testing Admin Excellence APIs (U1-U10)');

  const admin = await loginAdmin();
  console.log(`✅ Admin login OK: ${admin.email}`);

  const headers = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${admin.token}`
  };

  // U9
  {
    const { res, data } = await jsonFetch(`${baseURL}/admin/crisis-mode`, { headers });
    assertOk('U9 get crisis mode', res, data);
    console.log('✅ U9 crisis-mode GET');
  }

  // U4
  {
    const date = todayISODate();
    const { res, data } = await jsonFetch(`${baseURL}/admin/reconciliation/daily?date=${encodeURIComponent(date)}`, { headers });
    assertOk('U4 reconciliation daily', res, data);
    console.log('✅ U4 reconciliation daily GET');
  }

  // U6
  {
    const { res, data } = await jsonFetch(`${baseURL}/admin/qa/sample?days=7&limit=10`, { headers });
    assertOk('U6 QA sample', res, data);
    console.log('✅ U6 QA sample GET');
  }

  // U8
  {
    const { res, data } = await jsonFetch(`${baseURL}/admin/policy-sandbox/refund-cap`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ cap: 50, days: 30 })
    });
    assertOk('U8 policy sandbox', res, data);
    console.log('✅ U8 policy-sandbox POST');
  }

  // U10
  {
    const { res, data } = await jsonFetch(`${baseURL}/admin/root-causes/top?days=7`, { headers });
    assertOk('U10 root-causes top', res, data);
    console.log('✅ U10 root-causes top GET');
  }

  // Use any existing case for case-bound APIs (U1/U2/U5/U6/U7)
  const casesResp = await jsonFetch(`${baseURL}/admin/cases?limit=1`, { headers });
  assertOk('admin cases list', casesResp.res, casesResp.data);
  const firstCase = Array.isArray(casesResp.data?.data) ? casesResp.data.data[0] : null;

  if (!firstCase) {
    console.log('⚠️ No cases found, skipping case-bound tests (U1/U2/U5/U6/U7/U3).');
    return;
  }

  const caseType = String(firstCase.case_type || '').trim();
  const caseId = String(firstCase.case_id || '').trim();

  if (!caseType || !caseId) {
    console.log('⚠️ Case missing case_type/case_id, skipping case-bound tests.');
    return;
  }

  // U1 timeline + notes
  {
    const tl = await jsonFetch(`${baseURL}/admin/cases/${encodeURIComponent(caseType)}/${encodeURIComponent(caseId)}/timeline`, { headers });
    assertOk('U1 timeline', tl.res, tl.data);

    const note = await jsonFetch(`${baseURL}/admin/cases/${encodeURIComponent(caseType)}/${encodeURIComponent(caseId)}/notes`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ note: 'smoke-test note' })
    });
    assertOk('U1 note add', note.res, note.data);
    console.log('✅ U1 timeline + note');
  }

  // U2 remedy preview
  {
    const packs = await jsonFetch(`${baseURL}/admin/remedy-packs?case_type=${encodeURIComponent(caseType)}`, { headers });
    assertOk('U2 remedy list', packs.res, packs.data);
    const firstPack = Array.isArray(packs.data?.data) ? packs.data.data[0] : null;
    if (firstPack?.key) {
      const preview = await jsonFetch(`${baseURL}/admin/remedy-packs/preview`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ case_type: caseType, case_id: caseId, pack_key: firstPack.key })
      });
      assertOk('U2 remedy preview', preview.res, preview.data);

      const blockedExecute = await jsonFetch(`${baseURL}/admin/remedy-packs/execute`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ case_type: caseType, case_id: caseId, pack_key: firstPack.key })
      });
      if (blockedExecute.res.ok || blockedExecute.res.status !== 409) {
        throw new Error(`U2 execute without preview token should fail with 409, got HTTP ${blockedExecute.res.status}`);
      }
      console.log('✅ U2 remedy preview');
      console.log('✅ U2 execute blocked without preview token');
    } else {
      console.log('⚠️ U2 no remedy packs for this case type');
    }
  }

  // U5 dispute session upsert/read
  {
    const save = await jsonFetch(`${baseURL}/admin/disputes/session`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        case_type: caseType,
        case_id: caseId,
        claim: 'smoke-test claim',
        evidence: 'smoke-test evidence',
        response: 'smoke-test response',
        settlement_offer: 'smoke-test offer',
        decision: 'smoke-test decision'
      })
    });
    assertOk('U5 dispute save', save.res, save.data);

    const get = await jsonFetch(`${baseURL}/admin/disputes/session?case_type=${encodeURIComponent(caseType)}&case_id=${encodeURIComponent(caseId)}`, { headers });
    assertOk('U5 dispute get', get.res, get.data);

    const close = await jsonFetch(`${baseURL}/admin/disputes/session/close`, {
      method: 'PATCH',
      headers,
      body: JSON.stringify({ case_type: caseType, case_id: caseId, close_case: false })
    });
    assertOk('U5 dispute close', close.res, close.data);

    console.log('✅ U5 dispute session save/get');
    console.log('✅ U5 dispute close');
  }

  // U6 QA review create/list
  {
    const create = await jsonFetch(`${baseURL}/admin/qa/reviews`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ case_type: caseType, case_id: caseId, score: 95, reason: 'smoke-test', notes: 'smoke-test review' })
    });
    assertOk('U6 QA create', create.res, create.data);

    const list = await jsonFetch(`${baseURL}/admin/qa/reviews?limit=5&case_type=${encodeURIComponent(caseType)}&case_id=${encodeURIComponent(caseId)}`, { headers });
    assertOk('U6 QA list', list.res, list.data);
    console.log('✅ U6 QA create/list');
  }

  // U7 sensitive access grant + fetch
  {
    const grant = await jsonFetch(`${baseURL}/admin/sensitive-access/grant`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ case_type: caseType, case_id: caseId, reason: 'smoke-test', ttl_minutes: 15 })
    });
    assertOk('U7 sensitive grant', grant.res, grant.data);

    const grantId = grant.data?.data?.id;
    if (grantId) {
      const sensitive = await jsonFetch(`${baseURL}/admin/cases/${encodeURIComponent(caseType)}/${encodeURIComponent(caseId)}/sensitive`, {
        headers: { ...headers, 'X-Sensitive-Access-Grant': String(grantId) }
      });
      assertOk('U7 sensitive read', sensitive.res, sensitive.data);
      console.log('✅ U7 sensitive grant/read');
    } else {
      console.log('⚠️ U7 no grant id returned');
    }
  }

  // U3 ledger (if trip_id available)
  if (firstCase.trip_id) {
    const tripId = String(firstCase.trip_id);
    const ledger = await jsonFetch(`${baseURL}/admin/trips/${encodeURIComponent(tripId)}/payment-ledger`, { headers });
    assertOk('U3 payment ledger', ledger.res, ledger.data);
    console.log('✅ U3 payment ledger');
  } else {
    console.log('⚠️ U3 skipped: selected case has no trip_id');
  }

  console.log('🎉 Admin Excellence API smoke test passed');
}

testAdminExcellence().catch((err) => {
  console.error('❌ Admin Excellence API smoke test failed:', err.message || err);
  process.exit(1);
});
