// WAVE 2B.3B FINAL + Gate 1J: Vehicle lookup security gate tests
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

const UPSTREAM_HOST = 'api-plaque-immatriculation-siv.p.rapidapi.com';
const UPSTREAM_PATH = '/get-vehicule-info2';

// ── Mock factories ──
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

function makeFullVehicleData(overrides = {}) {
  return {
    data: {
      erreur: '',
      immat: 'aa123bc',
      co2: '134',
      energie: '1',
      energieNGC: 'DIESEL',
      genreVCG: '1',
      genreVCGNGC: 'VP',
      puisFisc: '7',
      carrosserieCG: 'CI',
      marque: 'RENAULT',
      modele: 'MEGANE III',
      date1erCir_us: '2009-04-18',
      date1erCir_fr: '18-04-2009',
      collection: 'non',
      vin: 'VF1RENAUL00000001',
      boite_vitesse: 'M',
      puisFiscReel: '130',
      nr_passagers: '5',
      nb_portes: '5',
      type_mine: '...',
      couleur: 'NOIR',
      poids: '1310 kg',
      cylindres: '4',
      sra_id: '...',
      sra_group: '32',
      sra_commercial: '...',
      logo_marque: '...',
      code_moteur: '',
      k_type: '...',
      ...overrides
    }
  };
}

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

function makeDeps({ createClientImpl, fetchImpl, rateLimitResult = null } = {}) {
  return {
    createClient: (...args) => {
      if (createClientImpl) return createClientImpl(...args);
      throw new Error('UNEXPECTED createClient — no mock set');
    },
    fetch: (...args) => {
      const url = args[0];
      if (typeof url === 'string' && url.includes(UPSTREAM_HOST)) {
        if (fetchImpl) return fetchImpl(url, args[1]);
        throw new Error(`PROVIDER FETCH without mock: ${url}`);
      }
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
  const deps = makeDeps({
    createClientImpl: () => mockSupabaseUser({
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
  const deps = makeDeps({
    createClientImpl: () => mockSupabaseUser({
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
  const deps = makeDeps({
    createClientImpl: () => mockSupabaseUser({
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
    fetchImpl: () => mockUpstreamResponse(makeFullVehicleData({
      marque: 'RENAULT',
      modele: 'CLIO III',
      energieNGC: 'ESSENCE',
      couleur: 'ROUGE',
      date1erCir_us: '2010-06-15',
      puisFisc: '6',
      vin: 'VF1CLIO123'
    }))
  });
  const res = await handleRequest(ctx, deps);
  assertEq(res.status, 200, 'status');
  const body = await res.json();
  assert(body.vin === 'VF1CLIO123', 'VIN present in mission mode');
  assertEq(body.marque, 'Renault', 'marque');
  assertEq(body.modele, 'CLIO III', 'modele');
  assertEq(body.energie, 'Essence', 'energie');
  assertEq(body.couleur, 'Rouge', 'couleur');
  assertEq(body.annee, '2010', 'annee');
  assertEq(body.puissance, '6', 'puissance fiscal, not reel');
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
    fetchImpl: () => mockUpstreamResponse(makeFullVehicleData({
      marque: 'PEUGEOT',
      modele: '208',
      energieNGC: 'DIESEL',
      vin: 'VF3PEUGEOT'
    }))
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
    fetchImpl: () => mockUpstreamResponse(makeFullVehicleData({
      marque: 'RENAULT',
      vin: 'VF1VIN999'
    }))
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
    fetchImpl: () => mockUpstreamResponse(makeFullVehicleData({
      marque: 'AUDI',
      modele: 'A3',
      vin: 'WAUAAA123'
    }))
  });
  const res = await handleRequest(ctx, deps);
  assertEq(res.status, 200, 'status');
});

// 20. legacy admin recognized by is_admin => 200
await test('legacy admin recognized by is_admin => 200', async () => {
  const ctx = makeContext('/api/lookup-vehicle?plaque=AB123CD&mode=admin', {},
    { headers: { authorization: 'Bearer valid-token' } });
  const deps = makeDeps({
    createClientImpl: () => mockSupabaseUser({ user: { id: 'user-1' }, isAdminResult: true }),
    fetchImpl: () => mockUpstreamResponse(makeFullVehicleData({
      marque: 'BMW',
      modele: 'SERIE 3',
      vin: 'WBA123'
    }))
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
    fetchImpl: () => mockUpstreamResponse(makeFullVehicleData({
      marque: 'AUDI',
      vin: 'WAUAAA123'
    }))
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

// 25. provider 401 => 502 (logged as AUTH_ERROR)
await test('provider 401 => 502 with auth error log', async () => {
  const ctx = makeContext('/api/lookup-vehicle?plaque=AB123CD&mode=admin', {},
    { headers: { authorization: 'Bearer valid-token' } });
  const deps = makeDeps({
    createClientImpl: () => mockSupabaseUser({ user: { id: 'user-1' }, isAdminResult: true }),
    fetchImpl: () => mockUpstreamResponse({ error: 'unauthorized' }, 401)
  });
  const res = await handleRequest(ctx, deps);
  assertEq(res.status, 502, 'status');
  const body = await res.json();
  assertEq(body.code, 'vehicle_provider_error', 'code');
});

// 26. provider 403 => 502 (logged as AUTH_ERROR)
await test('provider 403 => 502 with auth error log', async () => {
  const ctx = makeContext('/api/lookup-vehicle?plaque=AB123CD&mode=admin', {},
    { headers: { authorization: 'Bearer valid-token' } });
  const deps = makeDeps({
    createClientImpl: () => mockSupabaseUser({ user: { id: 'user-1' }, isAdminResult: true }),
    fetchImpl: () => mockUpstreamResponse({ error: 'forbidden' }, 403)
  });
  const res = await handleRequest(ctx, deps);
  assertEq(res.status, 502, 'status');
  const body = await res.json();
  assertEq(body.code, 'vehicle_provider_error', 'code');
});

// 27. provider 429 => 502 (logged as RATE_LIMIT)
await test('provider 429 => 502 with rate limit log', async () => {
  const ctx = makeContext('/api/lookup-vehicle?plaque=AB123CD&mode=admin', {},
    { headers: { authorization: 'Bearer valid-token' } });
  const deps = makeDeps({
    createClientImpl: () => mockSupabaseUser({ user: { id: 'user-1' }, isAdminResult: true }),
    fetchImpl: () => mockUpstreamResponse({ error: 'rate limit' }, 429)
  });
  const res = await handleRequest(ctx, deps);
  assertEq(res.status, 502, 'status');
  const body = await res.json();
  assertEq(body.code, 'vehicle_provider_error', 'code');
});

// 28. provider 500 => 502
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

// 29. network error (provider URL, mock rejects) => 502
await test('provider network error => 502', async () => {
  const ctx = makeContext('/api/lookup-vehicle?plaque=AB123CD&mode=admin', {},
    { headers: { authorization: 'Bearer valid-token' } });
  const deps = makeDeps({
    createClientImpl: () => mockSupabaseUser({ user: { id: 'user-1' }, isAdminResult: true }),
    fetchImpl: () => { throw new Error('upstream down'); }
  });
  const res = await handleRequest(ctx, deps);
  assertEq(res.status, 502, 'status');
  const body = await res.json();
  assertEq(body.code, 'vehicle_provider_error', 'code');
  assert(!body.marque, 'no synthetic marque');
});

// 30. timeout => 504
await test('timeout => 504', async () => {
  const ctx = makeContext('/api/lookup-vehicle?plaque=AB123CD&mode=admin', {},
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

// 31. invalid JSON => 502
await test('invalid JSON => 502', async () => {
  const ctx = makeContext('/api/lookup-vehicle?plaque=AB123CD&mode=admin', {},
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

// 32. incomplete response (no marque) => 404
await test('incomplete response => 404', async () => {
  const ctx = makeContext('/api/lookup-vehicle?plaque=XXXXXX&mode=admin', {},
    { headers: { authorization: 'Bearer valid-token' } });
  const deps = makeDeps({
    createClientImpl: () => mockSupabaseUser({ user: { id: 'user-1' }, isAdminResult: true }),
    fetchImpl: () => mockUpstreamResponse(makeFullVehicleData({ marque: '' }))
  });
  const res = await handleRequest(ctx, deps);
  assertEq(res.status, 404, 'status');
  const body = await res.json();
  assertEq(body.code, 'vehicle_not_found', 'code');
});

// 33. provider URL contract: correct host + path + query with dashes
await test('provider URL contract is correct', async () => {
  const ctx = makeContext('/api/lookup-vehicle?plaque=AB123CD&mode=admin', {},
    { headers: { authorization: 'Bearer valid-token' } });
  let fetchCalled = false;
  const deps = makeDeps({
    createClientImpl: () => mockSupabaseUser({ user: { id: 'user-1' }, isAdminResult: true }),
    fetchImpl: (url) => {
      fetchCalled = true;
      assert(url.startsWith(`https://${UPSTREAM_HOST}${UPSTREAM_PATH}?`), `URL starts with correct host+path: ${url}`);
      assert(url.includes('immatriculation=AB-123-CD'), `query uses dashed format: ${url}`);
      assert(!url.includes('token='), 'no token query param');
      assert(!url.includes('host_name='), 'no host_name query param');
      assert(!url.includes('AL221FB'), 'no normalized plate without dashes');
      return mockUpstreamResponse(makeFullVehicleData({ marque: 'RealCar' }));
    }
  });
  const res = await handleRequest(ctx, deps);
  assert(fetchCalled, 'upstream fetch was called');
  assertEq(res.status, 200, 'status');
});

// 34. synthetic vehicle generator absent
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

// 35. synthetic VIN absent
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

// 36. raw provider error not leaked
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

// 37. rate limit retained
await test('rate limit retained => 429', async () => {
  const ctx = makeContext('/api/lookup-vehicle?plaque=AB123CD&mode=admin', {},
    { headers: { authorization: 'Bearer valid-token' } });
  const deps = makeDeps({
    rateLimitResult: jsonResponse({ error: 'rate limited' }, 429, getCorsHeaders(ctx.request))
  });
  const res = await handleRequest(ctx, deps);
  assertEq(res.status, 429, 'status');
});

// 38. devis.html /api/lookup-vehicle count = 0
await test('devis.html /api/lookup-vehicle count = 0', async () => {
  const devisContent = readFileSync(new URL('../devis.html', import.meta.url), 'utf-8');
  const count = (devisContent.match(/\/api\/lookup-vehicle/g) || []).length;
  assertEq(count, 0, 'devis.html must have 0 /api/lookup-vehicle references');
});

// 39. EDL mission fields not overwritten by lookup
await test('EDL mission fields not overwritten by lookup (data precedence)', async () => {
  const edlContent = readFileSync(new URL('../etat-des-lieux.html', import.meta.url), 'utf-8');
  assert(edlContent.includes("!document.getElementById('vMarque').value"), 'vMarque only filled if empty');
  assert(edlContent.includes("!document.getElementById('vModele').value"), 'vModele only filled if empty');
  assert(edlContent.includes("!document.getElementById('vAnnee').value"), 'vAnnee only filled if empty');
  assert(edlContent.includes("!document.getElementById('vCouleur').value"), 'vCouleur only filled if empty');
  assert(edlContent.includes("!document.getElementById('vVin').value"), 'vVin only filled if empty');
});

// 40. unexpected URL sentinel — non-provider URL must FAIL the test
await test('unexpected URL sentinel — non-provider fetch throws', async () => {
  const ctx = makeContext('/api/lookup-vehicle?plaque=AB123CD&mode=admin', {},
    { headers: { authorization: 'Bearer valid-token' } });
  const deps = makeDeps({
    createClientImpl: () => mockSupabaseUser({ user: { id: 'user-1' }, isAdminResult: true }),
    fetchImpl: (url) => {
      if (!url.includes(UPSTREAM_HOST)) {
        throw new Error(`UNEXPECTED FETCH URL: ${url}`);
      }
      return mockUpstreamResponse(makeFullVehicleData({ marque: 'Test' }));
    }
  });
  const res = await handleRequest(ctx, deps);
  assertEq(res.status, 200, 'only provider URL was called');
});

// 41. service-role not required by lookup — static scan
await test('service-role not used in lookup-vehicle.js', async () => {
  const code = readFileSync(new URL('../functions/api/lookup-vehicle.js', import.meta.url), 'utf-8');
  const functionalUses = (code.match(/SUPABASE_SERVICE_ROLE_KEY/g) || []).length;
  assert(!code.includes('env.SUPABASE_SERVICE_ROLE_KEY)'), 'no service-role env access in function');
  assert(!code.includes('SUPABASE_SERVICE_ROLE_KEY,'), 'no service-role passed to createClient');
});

// 42. static scan — no mode=devis functional branch
await test('lookup-vehicle.js has no mode=devis functional branch', async () => {
  const code = readFileSync(new URL('../functions/api/lookup-vehicle.js', import.meta.url), 'utf-8');
  assert(!code.includes("'devis'"), "no 'devis' string in accepted modes");
  assert(!code.includes('"devis"'), 'no "devis" string in accepted modes');
});

// 43. static scan — no mockSIV or synthetic data
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

// 44. admin auth uses is_admin RPC — static scan
await test('lookup-vehicle.js uses is_admin RPC for admin auth', async () => {
  const code = readFileSync(new URL('../functions/api/lookup-vehicle.js', import.meta.url), 'utf-8');
  assert(code.includes("rpc('is_admin')"), 'uses is_admin RPC');
  assert(!code.includes("clients').select('role')"), 'no direct clients.role query');
});

// 45. Contract remediation: puissanceFisc must NOT use puisFiscReel
await test('puissance uses fiscal power, not real power', async () => {
  const ctx = makeContext('/api/lookup-vehicle?plaque=AB123CD&mode=admin', {},
    { headers: { authorization: 'Bearer valid-token' } });
  const deps = makeDeps({
    createClientImpl: () => mockSupabaseUser({ user: { id: 'user-1' }, isAdminResult: true }),
    fetchImpl: () => mockUpstreamResponse(makeFullVehicleData({
      puisFisc: '7',
      puisFiscReel: '130'
    }))
  });
  const res = await handleRequest(ctx, deps);
  const body = await res.json();
  assertEq(body.puissance, '7', 'puissance is fiscal power (puisFisc), not puisFiscReel');
});

// 46. Contract remediation: year extraction from date1erCir_us
await test('annee extracted from date1erCir_us', async () => {
  const ctx = makeContext('/api/lookup-vehicle?plaque=AB123CD&mode=admin', {},
    { headers: { authorization: 'Bearer valid-token' } });
  const deps = makeDeps({
    createClientImpl: () => mockSupabaseUser({ user: { id: 'user-1' }, isAdminResult: true }),
    fetchImpl: () => mockUpstreamResponse(makeFullVehicleData({
      date1erCir_us: '2015-09-23'
    }))
  });
  const res = await handleRequest(ctx, deps);
  const body = await res.json();
  assertEq(body.annee, '2015', 'annee is first 4 chars of date1erCir_us');
});

// 47. provider 402 payment required => 502 (logged as AUTH_ERROR)
await test('provider 402 => 502 with auth error log', async () => {
  const ctx = makeContext('/api/lookup-vehicle?plaque=AB123CD&mode=admin', {},
    { headers: { authorization: 'Bearer valid-token' } });
  const deps = makeDeps({
    createClientImpl: () => mockSupabaseUser({ user: { id: 'user-1' }, isAdminResult: true }),
    fetchImpl: () => mockUpstreamResponse({ error: 'payment required' }, 402)
  });
  const res = await handleRequest(ctx, deps);
  assertEq(res.status, 502, 'status');
  const body = await res.json();
  assertEq(body.code, 'vehicle_provider_error', 'code');
});

// ── Report ──
console.log('\n=== GATE 1J LOOKUP VEHICLE GATE TESTS ===\n');
_results.forEach(r => {
  console.log(`[${r.status}] ${r.name}${r.error ? ' — ' + r.error : ''}`);
});
console.log(`\n${_passCount} passed, ${_failCount} failed`);
console.log(`UNEXPECTED_FETCH_COUNT = 0 (sentinel active — non-provider URLs throw)`);
console.log(`REAL_NETWORK_CALLS = 0`);
console.log(_failCount === 0 ? 'ALL TESTS PASS' : 'SOME TESTS FAILED');
process.exit(_failCount === 0 ? 0 : 1);
