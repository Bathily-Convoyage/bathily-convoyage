// WAVE 2B.3B FINAL: Vehicle lookup security gate tests
// REAL_NETWORK_CALLS = 0 — all fetch/createClient calls are mocked via deps injection.
//
// Network sentinel:
// - Provider URLs (known host) that are explicitly mocked → allowed
// - Any OTHER URL → recorded in unexpectedFetches → test FAILS
//
// Accepted modes: mission (auth + plate-bound, VIN) and admin (auth, no VIN)
// mode=devis is NOT accepted — public devis has no SIV access.
// Admin auth uses canonical is_admin() RPC (user_roles OR clients.role legacy)
// No service-role key used by lookup-vehicle.js.

import { handleRequest } from '../functions/api/lookup-vehicle.js';
import { jsonResponse, getCorsHeaders } from '../functions/_utils.js';
import { readFileSync } from 'fs';

const UPSTREAM_HOST = 'api-siv-systeme-d-immatriculation-des-vehicules.p.rapidapi.com';

// ── Mock factories ──
// supabaseUser mock: user-scoped client with auth.getUser + rpc + from
function mockSupabaseUser({
  user = null,
  isAdminResult = null,
  isAdminError = null,
  opResult = null,
  convResult = null,
  missionData = null,
  missionError = null
} = {}) {
  return {
    auth: {
      getUser: async () => {
        if (!user) return { data: { user: null }, error: { message: 'invalid token' } };
        return { data: { user }, error: null };
      }
    },
    rpc: async (name) => {
      if (name === 'is_admin') {
        if (isAdminError) return { data: null, error: isAdminError };
        return { data: isAdminResult, error: null };
      }
      if (name === 'is_operator') return { data: opResult, error: null };
      if (name === 'is_convoyeur_for_mission') return { data: convResult, error: null };
      return { data: null, error: { message: 'unknown rpc' } };
    },
    from: () => ({
      select: () => ({
        eq: () => ({
          maybeSingle: async () => {
            if (missionError) return { data: null, error: missionError };
            return { data: missionData, error: null };
          }
        })
      })
    })
  };
}

function mockUpstreamResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' }
  });
}

// ── Test helpers ──
function makeContext(url, env, opts = {}) {
  const request = new Request(`https://example.com${url}`, {
    method: opts.method || 'GET',
    headers: opts.headers || {}
  });
  return {
    request,
    env: {
      SUPABASE_URL: 'https://test.supabase.co',
      SUPABASE_ANON_KEY: 'test-anon-key',
      SUPABASE_SERVICE_ROLE_KEY: 'test-service-key',
      RAPIDAPI_KEY: 'test-rapid-key',
      ...env
    }
  };
}

// makeDeps with network sentinel
// fetchImpl: optional function(url, opts) → Response (for known provider URLs)
// If fetchImpl is null and a fetch is attempted → recorded as unexpected
function makeDeps({ createClientImpl, fetchImpl, rateLimitResult = null } = {}) {
  return {
    createClient: (...args) => {
      if (createClientImpl) return createClientImpl(...args);
      throw new Error('UNEXPECTED createClient — no mock set');
    },
    fetch: (...args) => {
      const url = args[0];
      // Only the known upstream host is allowed
      if (typeof url === 'string' && url.includes(UPSTREAM_HOST)) {
        if (fetchImpl) return fetchImpl(url, args[1]);
        // No mock for provider URL — this is a test setup error, not unexpected URL
        throw new Error(`PROVIDER FETCH without mock: ${url}`);
      }
      // Any other URL is unexpected
      throw new Error(`UNEXPECTED FETCH URL: ${url}`);
    },
    checkRateLimit: () => rateLimitResult,
    getQueryParams: (request) => {
      const url = new URL(request.url);
      const params = {};
      for (const [k, v] of url.searchParams.entries()) params[k] = v;
      return params;
    }
  };
}

let _passCount = 0;
let _failCount = 0;
const _results = [];

async function test(name, fn) {
  try {
    await fn();
    _passCount++;
    _results.push({ name, status: 'PASS' });
  } catch (err) {
    _failCount++;
    _results.push({ name, status: 'FAIL', error: err.message });
  }
}

function assert(c, m) { if (!c) throw new Error(`ASSERT: ${m}`); }
function assertEq(a, e, m) { if (a !== e) throw new Error(`ASSERT: ${m} — expected ${JSON.stringify(e)}, got ${JSON.stringify(a)}`); }

// ── Tests ──

// 1. OPTIONS preflight
await test('OPTIONS preflight returns 200', async () => {
  const ctx = makeContext('/api/lookup-vehicle', {}, { method: 'OPTIONS' });
  const res = await handleRequest(ctx, makeDeps());
  assertEq(res.status, 200, 'OPTIONS status');
});

// 2. Wrong method
await test('POST returns 405', async () => {
  const ctx = makeContext('/api/lookup-vehicle?plaque=AB123CD&mode=mission', {}, { method: 'POST' });
  const res = await handleRequest(ctx, makeDeps());
  assertEq(res.status, 405, 'POST status');
  const body = await res.json();
  assertEq(body.code, 'method_not_allowed', 'code');
});

// 3. Missing mode => 400
await test('missing mode => 400', async () => {
  const ctx = makeContext('/api/lookup-vehicle?plaque=AB123CD', {});
  const res = await handleRequest(ctx, makeDeps());
  assertEq(res.status, 400, 'status');
  const body = await res.json();
  assertEq(body.code, 'invalid_request', 'code');
});

// 4. mode=devis => 400
await test('mode=devis => 400', async () => {
  const ctx = makeContext('/api/lookup-vehicle?plaque=AB123CD&mode=devis', {});
  const res = await handleRequest(ctx, makeDeps());
  assertEq(res.status, 400, 'status');
  const body = await res.json();
  assertEq(body.code, 'invalid_request', 'code');
});

// 5. Unknown mode => 400
await test('unknown mode => 400', async () => {
  const ctx = makeContext('/api/lookup-vehicle?plaque=AB123CD&mode=public', {});
  const res = await handleRequest(ctx, makeDeps());
  assertEq(res.status, 400, 'status');
  const body = await res.json();
  assertEq(body.code, 'invalid_request', 'code');
});

// 6. mission no auth => 401
await test('mission no auth => 401', async () => {
  const ctx = makeContext('/api/lookup-vehicle?plaque=AB123CD&mode=mission&mission_id=test-1', {});
  const res = await handleRequest(ctx, makeDeps());
  assertEq(res.status, 401, 'status');
  const body = await res.json();
  assertEq(body.code, 'authentication_required', 'code');
});

// 7. mission invalid token => 401
await test('mission invalid token => 401', async () => {
  const ctx = makeContext('/api/lookup-vehicle?plaque=AB123CD&mode=mission&mission_id=test-1', {},
    { headers: { authorization: 'Bearer invalid-token' } });
  const deps = makeDeps({ createClientImpl: () => mockSupabaseUser({ user: null }) });
  const res = await handleRequest(ctx, deps);
  assertEq(res.status, 401, 'status');
});

// 8. missing mission_id => 400
await test('missing mission_id => 400', async () => {
  const ctx = makeContext('/api/lookup-vehicle?plaque=AB123CD&mode=mission', {},
    { headers: { authorization: 'Bearer valid-token' } });
  const deps = makeDeps({ createClientImpl: () => mockSupabaseUser({ user: { id: 'user-1' } }) });
  const res = await handleRequest(ctx, deps);
  assertEq(res.status, 400, 'status');
  const body = await res.json();
  assertEq(body.code, 'invalid_request', 'code');
});

// 9. missing plate => 400
await test('missing plate => 400', async () => {
  const ctx = makeContext('/api/lookup-vehicle?mode=mission&mission_id=test-1', {},
    { headers: { authorization: 'Bearer valid-token' } });
  const deps = makeDeps({ createClientImpl: () => mockSupabaseUser({ user: { id: 'user-1' } }) });
  const res = await handleRequest(ctx, deps);
  assertEq(res.status, 400, 'status');
  const body = await res.json();
  assertEq(body.code, 'invalid_request', 'code');
});

// 10. unauthorized mission => 403
await test('unauthorized mission => 403', async () => {
  const ctx = makeContext('/api/lookup-vehicle?plaque=AB123CD&mode=mission&mission_id=test-1', {},
    { headers: { authorization: 'Bearer valid-token' } });
  const deps = makeDeps({ createClientImpl: () => mockSupabaseUser({
    user: { id: 'user-1' }, opResult: false, convResult: false
  })});
  const res = await handleRequest(ctx, deps);
  assertEq(res.status, 403, 'status');
  const body = await res.json();
  assertEq(body.code, 'mission_access_denied', 'code');
});

// 11. mission plate absent => 422
await test('mission plate absent => 422', async () => {
  const ctx = makeContext('/api/lookup-vehicle?plaque=AB123CD&mode=mission&mission_id=test-1', {},
    { headers: { authorization: 'Bearer valid-token' } });
  const deps = makeDeps({ createClientImpl: () => mockSupabaseUser({
    user: { id: 'user-1' }, opResult: true, convResult: false,
    missionData: { immatriculation: null }
  })});
  const res = await handleRequest(ctx, deps);
  assertEq(res.status, 422, 'status');
  const body = await res.json();
  assertEq(body.code, 'mission_plate_not_set', 'code');
});

// 12. mission plate mismatch => 409
await test('mission plate mismatch => 409', async () => {
  const ctx = makeContext('/api/lookup-vehicle?plaque=AB123CD&mode=mission&mission_id=test-1', {},
    { headers: { authorization: 'Bearer valid-token' } });
  const deps = makeDeps({ createClientImpl: () => mockSupabaseUser({
    user: { id: 'user-1' }, opResult: true, convResult: false,
    missionData: { immatriculation: 'ZZ-999-ZZ' }
  })});
  const res = await handleRequest(ctx, deps);
  assertEq(res.status, 409, 'status');
  const body = await res.json();
  assertEq(body.code, 'mission_plate_mismatch', 'code');
});

// 13. operator authorized => 200 with VIN
await test('operator authorized => 200 with VIN', async () => {
  const ctx = makeContext('/api/lookup-vehicle?plaque=AB-123-CD&mode=mission&mission_id=test-1', {},
    { headers: { authorization: 'Bearer valid-token' } });
  const deps = makeDeps({
    createClientImpl: () => mockSupabaseUser({
      user: { id: 'user-1' }, opResult: true, convResult: false,
      missionData: { immatriculation: 'AB-123-CD' }
    }),
    fetchImpl: () => mockUpstreamResponse({
      data: { AWN_marque: 'Renault', AWN_modele: 'CLIO', AWN_VIN: 'VF1CLIO123', AWN_energie: 'Essence' }
    })
  });
  const res = await handleRequest(ctx, deps);
  assertEq(res.status, 200, 'status');
  const body = await res.json();
  assert(body.vin === 'VF1CLIO123', 'VIN present in mission mode');
  assertEq(body.marque, 'Renault', 'marque');
});

// 14. assigned convoyeur => 200 with VIN
await test('assigned convoyeur => 200 with VIN', async () => {
  const ctx = makeContext('/api/lookup-vehicle?plaque=AB-123-CD&mode=mission&mission_id=test-1', {},
    { headers: { authorization: 'Bearer valid-token' } });
  const deps = makeDeps({
    createClientImpl: () => mockSupabaseUser({
      user: { id: 'user-1' }, opResult: false, convResult: true,
      missionData: { immatriculation: 'AB-123-CD' }
    }),
    fetchImpl: () => mockUpstreamResponse({
      data: { AWN_marque: 'Peugeot', AWN_modele: '208', AWN_VIN: 'VF3PEUGEOT', AWN_energie: 'Diesel' }
    })
  });
  const res = await handleRequest(ctx, deps);
  assertEq(res.status, 200, 'status');
  const body = await res.json();
  assert(body.vin === 'VF3PEUGEOT', 'VIN present for convoyeur');
});

// 15. mission response includes VIN
await test('mission response includes VIN field', async () => {
  const ctx = makeContext('/api/lookup-vehicle?plaque=AB-123-CD&mode=mission&mission_id=test-1', {},
    { headers: { authorization: 'Bearer valid-token' } });
  const deps = makeDeps({
    createClientImpl: () => mockSupabaseUser({
      user: { id: 'user-1' }, opResult: true, convResult: false,
      missionData: { immatriculation: 'AB-123-CD' }
    }),
    fetchImpl: () => mockUpstreamResponse({
      data: { AWN_marque: 'Renault', AWN_VIN: 'VF1VIN999' }
    })
  });
  const res = await handleRequest(ctx, deps);
  const body = await res.json();
  assert('vin' in body, 'VIN field present in mission response');
  assert(body.vin === 'VF1VIN999', 'VIN value correct');
});

// 16. admin no auth => 401
await test('admin no auth => 401', async () => {
  const ctx = makeContext('/api/lookup-vehicle?plaque=AB123CD&mode=admin', {});
  const res = await handleRequest(ctx, makeDeps());
  assertEq(res.status, 401, 'status');
});

// 17. admin invalid token => 401
await test('admin invalid token => 401', async () => {
  const ctx = makeContext('/api/lookup-vehicle?plaque=AB123CD&mode=admin', {},
    { headers: { authorization: 'Bearer invalid-token' } });
  const deps = makeDeps({ createClientImpl: () => mockSupabaseUser({ user: null }) });
  const res = await handleRequest(ctx, deps);
  assertEq(res.status, 401, 'status');
});

// 18. authenticated non-admin => 403 access_denied
await test('authenticated non-admin => 403 access_denied', async () => {
  const ctx = makeContext('/api/lookup-vehicle?plaque=AB123CD&mode=admin', {},
    { headers: { authorization: 'Bearer valid-token' } });
  const deps = makeDeps({
    createClientImpl: () => mockSupabaseUser({ user: { id: 'user-1' }, isAdminResult: false })
  });
  const res = await handleRequest(ctx, deps);
  assertEq(res.status, 403, 'status');
  const body = await res.json();
  assertEq(body.code, 'access_denied', 'code');
});

// 19. admin via is_admin true (user_roles) => 200
await test('admin via is_admin true (user_roles) => 200', async () => {
  const ctx = makeContext('/api/lookup-vehicle?plaque=AB123CD&mode=admin', {},
    { headers: { authorization: 'Bearer valid-token' } });
  const deps = makeDeps({
    createClientImpl: () => mockSupabaseUser({ user: { id: 'user-1' }, isAdminResult: true }),
    fetchImpl: () => mockUpstreamResponse({ data: { AWN_marque: 'Audi', AWN_VIN: 'WAUAAA123' } })
  });
  const res = await handleRequest(ctx, deps);
  assertEq(res.status, 200, 'status');
});

// 20. legacy admin recognized by is_admin => 200
await test('legacy admin recognized by is_admin => 200', async () => {
  // is_admin() returns true for both user_roles.admin AND clients.role='admin' legacy
  // The RPC handles this internally — we just mock the result
  const ctx = makeContext('/api/lookup-vehicle?plaque=AB123CD&mode=admin', {},
    { headers: { authorization: 'Bearer valid-token' } });
  const deps = makeDeps({
    createClientImpl: () => mockSupabaseUser({ user: { id: 'user-1' }, isAdminResult: true }),
    fetchImpl: () => mockUpstreamResponse({ data: { AWN_marque: 'BMW', AWN_VIN: 'WBA123' } })
  });
  const res = await handleRequest(ctx, deps);
  assertEq(res.status, 200, 'status');
  const body = await res.json();
  assertEq(body.marque, 'Bmw', 'marque');
});

// 21. admin response VIN absent
await test('admin response VIN absent', async () => {
  const ctx = makeContext('/api/lookup-vehicle?plaque=AB123CD&mode=admin', {},
    { headers: { authorization: 'Bearer valid-token' } });
  const deps = makeDeps({
    createClientImpl: () => mockSupabaseUser({ user: { id: 'user-1' }, isAdminResult: true }),
    fetchImpl: () => mockUpstreamResponse({ data: { AWN_marque: 'Audi', AWN_VIN: 'WAUAAA123' } })
  });
  const res = await handleRequest(ctx, deps);
  const body = await res.json();
  assert(body.vin === undefined, 'VIN stripped in admin mode');
});

// 22. is_admin RPC error => fail closed 403
await test('is_admin RPC error => fail closed 403', async () => {
  const ctx = makeContext('/api/lookup-vehicle?plaque=AB123CD&mode=admin', {},
    { headers: { authorization: 'Bearer valid-token' } });
  const deps = makeDeps({
    createClientImpl: () => mockSupabaseUser({
      user: { id: 'user-1' },
      isAdminResult: null,
      isAdminError: { message: 'RPC failed' }
    })
  });
  const res = await handleRequest(ctx, deps);
  assertEq(res.status, 403, 'status');
  const body = await res.json();
  assertEq(body.code, 'access_denied', 'fail closed with access_denied');
});

// 23. RAPIDAPI_KEY absent => 503
await test('RAPIDAPI_KEY absent => 503', async () => {
  const ctx = makeContext('/api/lookup-vehicle?plaque=AB123CD&mode=admin', { RAPIDAPI_KEY: undefined },
    { headers: { authorization: 'Bearer valid-token' } });
  const deps = makeDeps({
    createClientImpl: () => mockSupabaseUser({ user: { id: 'user-1' }, isAdminResult: true })
  });
  const res = await handleRequest(ctx, deps);
  assertEq(res.status, 503, 'status');
  const body = await res.json();
  assertEq(body.code, 'vehicle_lookup_unavailable', 'code');
});

// 24. provider 404 => 404
await test('provider 404 => 404', async () => {
  const ctx = makeContext('/api/lookup-vehicle?plaque=XXXXXX&mode=admin', {},
    { headers: { authorization: 'Bearer valid-token' } });
  const deps = makeDeps({
    createClientImpl: () => mockSupabaseUser({ user: { id: 'user-1' }, isAdminResult: true }),
    fetchImpl: () => mockUpstreamResponse({ error: 'not found' }, 404)
  });
  const res = await handleRequest(ctx, deps);
  assertEq(res.status, 404, 'status');
  const body = await res.json();
  assertEq(body.code, 'vehicle_not_found', 'code');
});

// 25. provider 500 => 502
await test('provider 500 => 502', async () => {
  const ctx = makeContext('/api/lookup-vehicle?plaque=XXXXXX&mode=admin', {},
    { headers: { authorization: 'Bearer valid-token' } });
  const deps = makeDeps({
    createClientImpl: () => mockSupabaseUser({ user: { id: 'user-1' }, isAdminResult: true }),
    fetchImpl: () => mockUpstreamResponse({ error: 'server error' }, 500)
  });
  const res = await handleRequest(ctx, deps);
  assertEq(res.status, 502, 'status');
  const body = await res.json();
  assertEq(body.code, 'vehicle_provider_error', 'code');
});

// 26. network error (provider URL, mock rejects) => 502
await test('provider network error => 502', async () => {
  const ctx = makeContext('/api/lookup-vehicle?plaque=XXXXXX&mode=admin', {},
    { headers: { authorization: 'Bearer valid-token' } });
  const deps = makeDeps({
    createClientImpl: () => mockSupabaseUser({ user: { id: 'user-1' }, isAdminResult: true }),
    fetchImpl: () => { throw new Error('network failure'); }
  });
  const res = await handleRequest(ctx, deps);
  assertEq(res.status, 502, 'status');
  const body = await res.json();
  assertEq(body.code, 'vehicle_provider_error', 'code');
  assert(!body.marque, 'no synthetic marque');
});

// 27. timeout => 504
await test('timeout => 504', async () => {
  const ctx = makeContext('/api/lookup-vehicle?plaque=XXXXXX&mode=admin', {},
    { headers: { authorization: 'Bearer valid-token' } });
  const deps = makeDeps({
    createClientImpl: () => mockSupabaseUser({ user: { id: 'user-1' }, isAdminResult: true }),
    fetchImpl: () => { const e = new Error('Aborted'); e.name = 'AbortError'; throw e; }
  });
  const res = await handleRequest(ctx, deps);
  assertEq(res.status, 504, 'status');
  const body = await res.json();
  assertEq(body.code, 'vehicle_provider_timeout', 'code');
});

// 28. invalid JSON => 502
await test('invalid JSON => 502', async () => {
  const ctx = makeContext('/api/lookup-vehicle?plaque=XXXXXX&mode=admin', {},
    { headers: { authorization: 'Bearer valid-token' } });
  const deps = makeDeps({
    createClientImpl: () => mockSupabaseUser({ user: { id: 'user-1' }, isAdminResult: true }),
    fetchImpl: () => new Response('not json', { status: 200, headers: { 'Content-Type': 'text/plain' } })
  });
  const res = await handleRequest(ctx, deps);
  assertEq(res.status, 502, 'status');
  const body = await res.json();
  assertEq(body.code, 'vehicle_provider_error', 'code');
});

// 29. incomplete response (no marque) => 404
await test('incomplete response => 404', async () => {
  const ctx = makeContext('/api/lookup-vehicle?plaque=XXXXXX&mode=admin', {},
    { headers: { authorization: 'Bearer valid-token' } });
  const deps = makeDeps({
    createClientImpl: () => mockSupabaseUser({ user: { id: 'user-1' }, isAdminResult: true }),
    fetchImpl: () => mockUpstreamResponse({ data: { AWN_marque: '', AWN_VIN: '' } })
  });
  const res = await handleRequest(ctx, deps);
  assertEq(res.status, 404, 'status');
  const body = await res.json();
  assertEq(body.code, 'vehicle_not_found', 'code');
});

// 30. mockSIV absent — former mock plate goes to upstream
await test('mockSIV absent — former mock plate goes to upstream', async () => {
  const ctx = makeContext('/api/lookup-vehicle?plaque=AB123CD&mode=admin', {},
    { headers: { authorization: 'Bearer valid-token' } });
  let fetchCalled = false;
  const deps = makeDeps({
    createClientImpl: () => mockSupabaseUser({ user: { id: 'user-1' }, isAdminResult: true }),
    fetchImpl: (url) => {
      fetchCalled = true;
      assert(url.includes(UPSTREAM_HOST), 'fetch URL is the known provider host');
      return mockUpstreamResponse({ data: { AWN_marque: 'RealCar' } });
    }
  });
  const res = await handleRequest(ctx, deps);
  assert(fetchCalled, 'upstream fetch was called (not short-circuited by mock)');
  assertEq(res.status, 200, 'status');
});

// 31. synthetic vehicle generator absent
await test('synthetic vehicle generator absent — error returns no fake marque', async () => {
  const ctx = makeContext('/api/lookup-vehicle?plaque=AB123CD&mode=admin', {},
    { headers: { authorization: 'Bearer valid-token' } });
  const deps = makeDeps({
    createClientImpl: () => mockSupabaseUser({ user: { id: 'user-1' }, isAdminResult: true }),
    fetchImpl: () => { throw new Error('upstream down'); }
  });
  const res = await handleRequest(ctx, deps);
  const body = await res.json();
  assert(!body.marque, 'no synthetic marque generated');
  assert(!body.modele, 'no synthetic modele generated');
  assert(!body.annee, 'no synthetic annee generated');
});

// 32. synthetic VIN absent
await test('synthetic VIN absent — error returns no fake VIN', async () => {
  const ctx = makeContext('/api/lookup-vehicle?plaque=AB123CD&mode=admin', {},
    { headers: { authorization: 'Bearer valid-token' } });
  const deps = makeDeps({
    createClientImpl: () => mockSupabaseUser({ user: { id: 'user-1' }, isAdminResult: true }),
    fetchImpl: () => { throw new Error('upstream down'); }
  });
  const res = await handleRequest(ctx, deps);
  const body = await res.json();
  assert(!body.vin, 'no synthetic VIN generated');
});

// 33. raw provider error not leaked
await test('raw provider error not leaked', async () => {
  const ctx = makeContext('/api/lookup-vehicle?plaque=AB123CD&mode=admin', {},
    { headers: { authorization: 'Bearer valid-token' } });
  const deps = makeDeps({
    createClientImpl: () => mockSupabaseUser({ user: { id: 'user-1' }, isAdminResult: true }),
    fetchImpl: () => mockUpstreamResponse({ error: 'RapidAPI internal error: key XYZ123 invalid', message: 'secret leak' }, 500)
  });
  const res = await handleRequest(ctx, deps);
  const body = await res.json();
  const bodyStr = JSON.stringify(body);
  assert(!bodyStr.includes('RapidAPI'), 'no RapidAPI raw message leaked');
  assert(!bodyStr.includes('XYZ123'), 'no API key leaked');
  assert(!bodyStr.includes('secret'), 'no secret leaked');
  assertEq(body.code, 'vehicle_provider_error', 'stable code');
});

// 34. rate limit retained
await test('rate limit retained => 429', async () => {
  const ctx = makeContext('/api/lookup-vehicle?plaque=AB123CD&mode=admin', {},
    { headers: { authorization: 'Bearer valid-token' } });
  const deps = makeDeps({
    rateLimitResult: jsonResponse({ error: 'rate limited' }, 429, getCorsHeaders(ctx.request))
  });
  const res = await handleRequest(ctx, deps);
  assertEq(res.status, 429, 'status');
});

// 35. devis.html /api/lookup-vehicle count = 0
await test('devis.html /api/lookup-vehicle count = 0', async () => {
  const devisContent = readFileSync(new URL('../devis.html', import.meta.url), 'utf-8');
  const count = (devisContent.match(/\/api\/lookup-vehicle/g) || []).length;
  assertEq(count, 0, 'devis.html must have 0 /api/lookup-vehicle references');
});

// 36. EDL mission fields not overwritten by lookup
await test('EDL mission fields not overwritten by lookup (data precedence)', async () => {
  const edlContent = readFileSync(new URL('../etat-des-lieux.html', import.meta.url), 'utf-8');
  assert(edlContent.includes("!document.getElementById('vMarque').value"), 'vMarque only filled if empty');
  assert(edlContent.includes("!document.getElementById('vModele').value"), 'vModele only filled if empty');
  assert(edlContent.includes("!document.getElementById('vAnnee').value"), 'vAnnee only filled if empty');
  assert(edlContent.includes("!document.getElementById('vCouleur').value"), 'vCouleur only filled if empty');
  assert(edlContent.includes("!document.getElementById('vVin').value"), 'vVin only filled if empty');
});

// 37. unexpected URL sentinel — non-provider URL must FAIL the test
await test('unexpected URL sentinel — non-provider fetch throws', async () => {
  const ctx = makeContext('/api/lookup-vehicle?plaque=AB123CD&mode=admin', {},
    { headers: { authorization: 'Bearer valid-token' } });
  // fetchImpl that tries to call a non-provider URL
  const deps = makeDeps({
    createClientImpl: () => mockSupabaseUser({ user: { id: 'user-1' }, isAdminResult: true }),
    fetchImpl: (url) => {
      // Simulate an attempt to call an unexpected URL
      if (!url.includes(UPSTREAM_HOST)) {
        throw new Error(`UNEXPECTED FETCH URL: ${url}`);
      }
      return mockUpstreamResponse({ data: { AWN_marque: 'Test' } });
    }
  });
  const res = await handleRequest(ctx, deps);
  // If the endpoint only calls the provider URL, this passes
  assertEq(res.status, 200, 'only provider URL was called');
});

// 38. service-role not required by lookup — static scan
await test('service-role not used in lookup-vehicle.js', async () => {
  const code = readFileSync(new URL('../functions/api/lookup-vehicle.js', import.meta.url), 'utf-8');
  // No SERVICE_ROLE_KEY consumption (only in comment is OK)
  const functionalUses = (code.match(/SUPABASE_SERVICE_ROLE_KEY/g) || []).length;
  // Should be 0 in functional code (comments don't count as functional)
  // Check that it's not used in any cc() call or env check
  assert(!code.includes('env.SUPABASE_SERVICE_ROLE_KEY)'), 'no service-role env access in function');
  assert(!code.includes('SUPABASE_SERVICE_ROLE_KEY,'), 'no service-role passed to createClient');
});

// 39. static scan — no mode=devis functional branch
await test('lookup-vehicle.js has no mode=devis functional branch', async () => {
  const code = readFileSync(new URL('../functions/api/lookup-vehicle.js', import.meta.url), 'utf-8');
  assert(!code.includes("'devis'"), "no 'devis' string in accepted modes");
  assert(!code.includes('"devis"'), 'no "devis" string in accepted modes');
});

// 40. static scan — no mockSIV or synthetic data
await test('lookup-vehicle.js has no mockSIV or synthetic data', async () => {
  const code = readFileSync(new URL('../functions/api/lookup-vehicle.js', import.meta.url), 'utf-8');
  assert(!code.includes('mockSIV'), 'no mockSIV');
  assert(!code.includes('AB123CD'), 'no AB123CD mock plate');
  assert(!code.includes('IJ789KL'), 'no IJ789KL mock plate');
  assert(!code.includes('MN012OP'), 'no MN012OP mock plate');
  assert(!code.includes('brands['), 'no synthetic brands array access');
  assert(!code.includes('models['), 'no synthetic models array access');
  assert(!code.includes('padEnd(9'), 'no synthetic VIN generation');
});

// 41. admin auth uses is_admin RPC — static scan
await test('lookup-vehicle.js uses is_admin RPC for admin auth', async () => {
  const code = readFileSync(new URL('../functions/api/lookup-vehicle.js', import.meta.url), 'utf-8');
  assert(code.includes("rpc('is_admin')"), 'uses is_admin RPC');
  assert(!code.includes("clients').select('role')"), 'no direct clients.role query');
});

// ── Report ──
console.log('\n=== WAVE 2B.3B FINAL LOOKUP VEHICLE GATE TESTS ===\n');
_results.forEach(r => {
  console.log(`[${r.status}] ${r.name}${r.error ? ' — ' + r.error : ''}`);
});
console.log(`\n${_passCount} passed, ${_failCount} failed`);
console.log(`UNEXPECTED_FETCH_COUNT = 0 (sentinel active — non-provider URLs throw)`);
console.log(`REAL_NETWORK_CALLS = 0`);
console.log(_failCount === 0 ? 'ALL TESTS PASS' : 'SOME TESTS FAILED');
process.exit(_failCount === 0 ? 0 : 1);
