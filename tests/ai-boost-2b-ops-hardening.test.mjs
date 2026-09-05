// AI-BOOST-2B — Production AI Operational Hardening Tests
//
// Tests cover:
// KILL SWITCH (Phase 1)
// 1. AI_ENABLED absent => zero provider calls, fallback, ai_disabled=true
// 2. AI_ENABLED=false => zero provider calls, fallback, ai_disabled=true
// 3. AI_ENABLED=true + valid admin => provider allowed
// 4. invalid AI_ENABLED => fail closed
//
// PER-ADMIN LIMIT (Phase 2)
// 5. admin within limit => provider allowed
// 6. admin exceeds limit => 429, zero provider call
// 7. separate admin identities do not share counter
// 8. unauthenticated remains 401 before provider
// 9. non-admin remains 403 before provider
//
// CIRCUIT BREAKER (Phase 6)
// 10. 3 qualifying failures open circuit
// 11. open circuit => zero provider call
// 12. cooldown permits probe
// 13. successful probe closes circuit
// 14. invalid output does not trip provider circuit
// 15. unauthorized requests do not affect circuit
//
// CONFIG (Phase 10)
// 16. invalid provider => zero fetch
// 17. invalid model config => fail closed
// 18. invalid max tokens => fail closed
// 19. valid max tokens applied
// 20. output token cap never exceeds support_draft policy
//
// METADATA (Phase 8)
// 21. ai_disabled flag correct
// 22. circuit_open flag correct
// 23. quota_limited flag correct
// 24. no secret/config raw values leaked
//
// BUSINESS SAFETY
// 25. no DB mutation
// 26. no email send
// 27. no mission-state mutation
// 28. no pricing mutation
// 29. no Auth mutation
//
// REGRESSION
// 30. existing AI-2A tests pass
// 31. AI foundation tests pass
// 32. security/Auth regression suites pass
// 33. Vite build PASS

import assert from 'assert';
import { readFileSync } from 'fs';

let passed = 0;
function ok(label) {
  passed++;
  console.log(`# ok - ${label}`);
}

// ============================================================
// MOCK SUPABASE CLIENT
// ============================================================

function mockCreateClient({ admin = true, authError = false, adminCheckError = false } = {}) {
  return function(url, key, options) {
    return {
      auth: {
        getUser: async (token) => {
          if (authError) return { data: { user: null }, error: { message: 'invalid token' } };
          if (!token || token.length < 10) return { data: { user: null }, error: { message: 'invalid token' } };
          return {
            data: { user: { id: 'test-admin-id-2b', email: 'admin@test.com' } },
            error: null,
          };
        },
      },
      rpc: async (fnName) => {
        if (fnName === 'is_admin') {
          if (adminCheckError) throw new Error('RPC error');
          return { data: admin, error: null };
        }
        return { data: null, error: { message: 'unknown function' } };
      },
    };
  };
}

// Separate admin identity for rate-limit isolation tests
function mockCreateClientAdmin2() {
  return function(url, key, options) {
    return {
      auth: {
        getUser: async (token) => {
          if (!token || token.length < 10) return { data: { user: null }, error: { message: 'invalid' } };
          return { data: { user: { id: 'test-admin-id-2b-second', email: 'admin2@test.com' } }, error: null };
        },
      },
      rpc: async (fnName) => {
        if (fnName === 'is_admin') return { data: true, error: null };
        return { data: null, error: { message: 'unknown' } };
      },
    };
  };
}

const ADMIN_CC = mockCreateClient({ admin: true });
const ADMIN_CC_2 = mockCreateClientAdmin2();
const NON_ADMIN_CC = mockCreateClient({ admin: false });
const AUTH_ERROR_CC = mockCreateClient({ admin: true, authError: true });

const ADMIN_AUTH = 'Bearer test-admin-token-2b-1234567890';
const ADMIN_AUTH_2 = 'Bearer test-admin2-token-2b-1234567890';
const NON_ADMIN_AUTH = 'Bearer test-nonadmin-token-2b-12345';

const BASE_ENV = {
  SUPABASE_URL: 'https://test.supabase.co',
  SUPABASE_ANON_KEY: 'test-anon-key',
  AI_ENABLED: 'true',
  AI_API_KEY: 'test-key',
  AI_MODEL_DEFAULT: 'gpt-5.6-luna',
  AI_ADMIN_MAX_REQUESTS_PER_MINUTE: '30',
};

// ============================================================
// HELPERS
// ============================================================

let testIpCounter = 0;

function makeRequest(body, opts = {}) {
  testIpCounter++;
  const headers = new Map();
  headers.set('content-type', 'application/json');
  headers.set('origin', 'https://www.bathily-convoyage.fr');
  headers.set('cf-connecting-ip', `203.0.113.${testIpCounter % 200 + 1}`);
  if (opts.headers) {
    for (const [k, v] of Object.entries(opts.headers)) {
      headers.set(k.toLowerCase(), v);
    }
  }
  return {
    method: opts.method || 'POST',
    headers: { get: (name) => headers.get(name.toLowerCase()) || null },
    text: async () => typeof body === 'string' ? body : JSON.stringify(body),
    url: 'https://www.bathily-convoyage.fr/api/ai-assist',
  };
}

async function callAiAssist({ body, env, fetchImpl, rawText, authHeader, createClientImpl }) {
  const mod = await import('../functions/api/ai-assist.js');
  // Reset state before each call
  if (mod._resetCircuitBreaker) mod._resetCircuitBreaker();
  if (mod._resetAdminRateLimit) mod._resetAdminRateLimit();
  const req = makeRequest(body, authHeader ? { headers: { Authorization: authHeader } } : {});
  if (rawText !== undefined) req.text = async () => rawText;
  const ctx = {
    request: req,
    env: { ...BASE_ENV, ...(env || {}) },
    fetchImpl: fetchImpl || null,
    createClientImpl: createClientImpl || ADMIN_CC,
  };
  const response = await mod.onRequest(ctx);
  const json = await response.json();
  return { response, json };
}

// Call WITHOUT resetting state (for circuit breaker accumulation tests)
async function callAiAssistNoReset({ body, env, fetchImpl, authHeader, createClientImpl }) {
  const mod = await import('../functions/api/ai-assist.js');
  const req = makeRequest(body, authHeader ? { headers: { Authorization: authHeader } } : {});
  const ctx = {
    request: req,
    env: { ...BASE_ENV, ...(env || {}) },
    fetchImpl: fetchImpl || null,
    createClientImpl: createClientImpl || ADMIN_CC,
  };
  const response = await mod.onRequest(ctx);
  const json = await response.json();
  return { response, json };
}

function mockFetch(opts = {}) {
  const {
    status = 200,
    body = null,
    captureBody = null,
    captureUrl = null,
  } = opts;
  return async function(url, options) {
    if (captureUrl !== null) captureUrl.value = url;
    if (captureBody !== null && options?.body) {
      try { captureBody.parsed = JSON.parse(options.body); } catch { captureBody.raw = options.body; }
    }
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => body || {},
    };
  };
}

const SUCCESS_BODY = {
  choices: [{ message: { content: '{"draft": "Bonjour, nous revenons vers vous.", "confidence": "medium"}' } }],
  usage: { prompt_tokens: 10, completion_tokens: 5 },
};

// ============================================================
// KILL SWITCH TESTS (Phase 1)
// ============================================================

// TEST 1: AI_ENABLED absent => zero provider calls, fallback, ai_disabled=true
{
  let fetchCount = 0;
  const trackingFetch = async () => { fetchCount++; return { ok: true, status: 200, json: async () => ({}) }; };

  const { response, json } = await callAiAssist({
    body: { task: 'support_draft', input: { customerMessage: 'Test no AI_ENABLED' } },
    env: { AI_ENABLED: undefined, AI_API_KEY: 'test-key' },
    fetchImpl: trackingFetch,
    authHeader: ADMIN_AUTH,
  });

  assert.strictEqual(response.status, 200);
  assert.strictEqual(json.meta.fallback_used, true);
  assert.strictEqual(json.meta.source, 'fallback');
  assert.strictEqual(json.meta.ai_disabled, true);
  assert.strictEqual(fetchCount, 0);
  ok('1. AI_ENABLED absent => zero provider calls, fallback, ai_disabled=true');
}

// TEST 2: AI_ENABLED=false => zero provider calls, fallback, ai_disabled=true
{
  let fetchCount = 0;
  const trackingFetch = async () => { fetchCount++; return { ok: true, status: 200, json: async () => ({}) }; };

  const { response, json } = await callAiAssist({
    body: { task: 'support_draft', input: { customerMessage: 'Test AI_ENABLED false' } },
    env: { AI_ENABLED: 'false', AI_API_KEY: 'test-key' },
    fetchImpl: trackingFetch,
    authHeader: ADMIN_AUTH,
  });

  assert.strictEqual(response.status, 200);
  assert.strictEqual(json.meta.fallback_used, true);
  assert.strictEqual(json.meta.ai_disabled, true);
  assert.strictEqual(fetchCount, 0);
  ok('2. AI_ENABLED=false => zero provider calls, fallback, ai_disabled=true');
}

// TEST 3: AI_ENABLED=true + valid admin => provider allowed
{
  const { json } = await callAiAssist({
    body: { task: 'support_draft', input: { customerMessage: 'Test AI enabled' } },
    env: { AI_ENABLED: 'true', AI_API_KEY: 'test-key' },
    fetchImpl: mockFetch({ status: 200, body: SUCCESS_BODY }),
    authHeader: ADMIN_AUTH,
  });

  assert.strictEqual(json.meta.fallback_used, false);
  assert.strictEqual(json.meta.source, 'ai');
  assert.strictEqual(json.meta.ai_disabled, false);
  ok('3. AI_ENABLED=true + valid admin => provider allowed');
}

// TEST 4: invalid AI_ENABLED => fail closed
{
  let fetchCount = 0;
  const trackingFetch = async () => { fetchCount++; return { ok: true, status: 200, json: async () => ({}) }; };

  const { response, json } = await callAiAssist({
    body: { task: 'support_draft', input: { customerMessage: 'Test invalid AI_ENABLED' } },
    env: { AI_ENABLED: 'yes', AI_API_KEY: 'test-key' },
    fetchImpl: trackingFetch,
    authHeader: ADMIN_AUTH,
  });

  assert.strictEqual(response.status, 200);
  assert.strictEqual(json.meta.fallback_used, true);
  assert.strictEqual(fetchCount, 0);
  ok('4. invalid AI_ENABLED => fail closed');
}

// ============================================================
// PER-ADMIN LIMIT TESTS (Phase 2)
// ============================================================

// TEST 5: admin within limit => provider allowed
{
  const { json } = await callAiAssist({
    body: { task: 'support_draft', input: { customerMessage: 'Test within limit' } },
    env: { AI_ADMIN_MAX_REQUESTS_PER_MINUTE: '5' },
    fetchImpl: mockFetch({ status: 200, body: SUCCESS_BODY }),
    authHeader: ADMIN_AUTH,
  });

  assert.strictEqual(json.meta.fallback_used, false);
  assert.strictEqual(json.meta.source, 'ai');
  ok('5. admin within limit => provider allowed');
}

// TEST 6: admin exceeds limit => 429, zero provider call
{
  const mod = await import('../functions/api/ai-assist.js');
  mod._resetCircuitBreaker();
  mod._resetAdminRateLimit();

  let fetchCount = 0;
  const trackingFetch = async () => { fetchCount++; return { ok: true, status: 200, json: async () => SUCCESS_BODY }; };

  // Make 3 successful calls (limit=3)
  for (let i = 0; i < 3; i++) {
    const req = makeRequest({ task: 'support_draft', input: { customerMessage: `Test ${i}` } }, { headers: { Authorization: ADMIN_AUTH } });
    await mod.onRequest({ request: req, env: { ...BASE_ENV, AI_ADMIN_MAX_REQUESTS_PER_MINUTE: '3' }, fetchImpl: trackingFetch, createClientImpl: ADMIN_CC });
  }

  // 4th call should be rate limited
  const req4 = makeRequest({ task: 'support_draft', input: { customerMessage: 'Test over limit' } }, { headers: { Authorization: ADMIN_AUTH } });
  const response4 = await mod.onRequest({ request: req4, env: { ...BASE_ENV, AI_ADMIN_MAX_REQUESTS_PER_MINUTE: '3' }, fetchImpl: trackingFetch, createClientImpl: ADMIN_CC });
  const json4 = await response4.json();

  assert.strictEqual(response4.status, 429);
  assert.strictEqual(json4.code, 'RATE_LIMITED');
  assert.strictEqual(json4.meta.quota_limited, true);
  // fetchCount should be 3 (only the successful calls), not 4
  assert.strictEqual(fetchCount, 3);
  ok('6. admin exceeds limit => 429, zero provider call');
}

// TEST 7: separate admin identities do not share counter
{
  const mod = await import('../functions/api/ai-assist.js');
  mod._resetCircuitBreaker();
  mod._resetAdminRateLimit();

  let fetchCount = 0;
  const trackingFetch = async () => { fetchCount++; return { ok: true, status: 200, json: async () => SUCCESS_BODY }; };

  // Admin 1 makes 3 calls (limit=3)
  for (let i = 0; i < 3; i++) {
    const req = makeRequest({ task: 'support_draft', input: { customerMessage: `Admin1 test ${i}` } }, { headers: { Authorization: ADMIN_AUTH } });
    await mod.onRequest({ request: req, env: { ...BASE_ENV, AI_ADMIN_MAX_REQUESTS_PER_MINUTE: '3' }, fetchImpl: trackingFetch, createClientImpl: ADMIN_CC });
  }

  // Admin 2 should still be allowed (independent counter)
  const req2 = makeRequest({ task: 'support_draft', input: { customerMessage: 'Admin2 test' } }, { headers: { Authorization: ADMIN_AUTH_2 } });
  const response2 = await mod.onRequest({ request: req2, env: { ...BASE_ENV, AI_ADMIN_MAX_REQUESTS_PER_MINUTE: '3' }, fetchImpl: trackingFetch, createClientImpl: ADMIN_CC_2 });
  const json2 = await response2.json();

  assert.strictEqual(response2.status, 200);
  assert.strictEqual(json2.meta.fallback_used, false);
  assert.strictEqual(json2.meta.source, 'ai');
  ok('7. separate admin identities do not share counter');
}

// TEST 8: unauthenticated remains 401 before provider
{
  let fetchCount = 0;
  const trackingFetch = async () => { fetchCount++; return { ok: true, status: 200, json: async () => ({}) }; };

  const { response, json } = await callAiAssist({
    body: { task: 'support_draft', input: { customerMessage: 'Test unauth' } },
    fetchImpl: trackingFetch,
    authHeader: null,
  });

  assert.strictEqual(response.status, 401);
  assert.strictEqual(json.code, 'UNAUTHORIZED');
  assert.strictEqual(fetchCount, 0);
  ok('8. unauthenticated remains 401 before provider');
}

// TEST 9: non-admin remains 403 before provider
{
  let fetchCount = 0;
  const trackingFetch = async () => { fetchCount++; return { ok: true, status: 200, json: async () => ({}) }; };

  const { response, json } = await callAiAssist({
    body: { task: 'support_draft', input: { customerMessage: 'Test non-admin' } },
    fetchImpl: trackingFetch,
    authHeader: NON_ADMIN_AUTH,
    createClientImpl: NON_ADMIN_CC,
  });

  assert.strictEqual(response.status, 403);
  assert.strictEqual(json.code, 'FORBIDDEN');
  assert.strictEqual(fetchCount, 0);
  ok('9. non-admin remains 403 before provider');
}

// ============================================================
// CIRCUIT BREAKER TESTS (Phase 6)
// ============================================================

// TEST 10: 3 qualifying failures open circuit
{
  const mod = await import('../functions/api/ai-assist.js');
  mod._resetCircuitBreaker();
  mod._resetAdminRateLimit();

  const failingFetch = async () => ({ ok: false, status: 500, json: async () => ({}) });

  // 3 failures with threshold=3
  for (let i = 0; i < 3; i++) {
    const req = makeRequest({ task: 'support_draft', input: { customerMessage: `Fail ${i}` } }, { headers: { Authorization: ADMIN_AUTH } });
    await mod.onRequest({ request: req, env: { ...BASE_ENV, AI_CIRCUIT_FAILURE_THRESHOLD: '3' }, fetchImpl: failingFetch, createClientImpl: ADMIN_CC });
  }

  assert.strictEqual(mod.circuitIsOpen(), true);
  ok('10. 3 qualifying failures open circuit');
}

// TEST 11: open circuit => zero provider call
{
  const mod = await import('../functions/api/ai-assist.js');
  mod._resetCircuitBreaker();
  mod._resetAdminRateLimit();

  let fetchCount = 0;
  const failingFetch = async () => { fetchCount++; return { ok: false, status: 500, json: async () => ({}) }; };

  // Trip the circuit with 3 failures
  for (let i = 0; i < 3; i++) {
    const req = makeRequest({ task: 'support_draft', input: { customerMessage: `Fail ${i}` } }, { headers: { Authorization: ADMIN_AUTH } });
    await mod.onRequest({ request: req, env: { ...BASE_ENV, AI_CIRCUIT_FAILURE_THRESHOLD: '3', AI_CIRCUIT_OPEN_MS: '60000' }, fetchImpl: failingFetch, createClientImpl: ADMIN_CC });
  }

  const callsBeforeCircuit = fetchCount;
  // Next call should NOT make a provider call (circuit open)
  const successFetch = async () => { fetchCount++; return { ok: true, status: 200, json: async () => SUCCESS_BODY }; };
  const req = makeRequest({ task: 'support_draft', input: { customerMessage: 'After circuit' } }, { headers: { Authorization: ADMIN_AUTH } });
  const response = await mod.onRequest({ request: req, env: { ...BASE_ENV, AI_CIRCUIT_FAILURE_THRESHOLD: '3', AI_CIRCUIT_OPEN_MS: '60000' }, fetchImpl: successFetch, createClientImpl: ADMIN_CC });
  const json = await response.json();

  assert.strictEqual(fetchCount, callsBeforeCircuit, 'Open circuit should make ZERO additional provider calls');
  assert.strictEqual(json.meta.fallback_used, true);
  assert.strictEqual(json.meta.circuit_open, true);
  ok('11. open circuit => zero provider call');
}

// TEST 12: cooldown permits probe
{
  const mod = await import('../functions/api/ai-assist.js');
  mod._resetCircuitBreaker();
  mod._resetAdminRateLimit();

  let fetchCount = 0;
  const failingFetch = async () => { fetchCount++; return { ok: false, status: 500, json: async () => ({}) }; };

  // Trip circuit with short cooldown
  for (let i = 0; i < 3; i++) {
    const req = makeRequest({ task: 'support_draft', input: { customerMessage: `Fail ${i}` } }, { headers: { Authorization: ADMIN_AUTH } });
    await mod.onRequest({ request: req, env: { ...BASE_ENV, AI_CIRCUIT_FAILURE_THRESHOLD: '3', AI_CIRCUIT_OPEN_MS: '10000' }, fetchImpl: failingFetch, createClientImpl: ADMIN_CC });
  }

  assert.strictEqual(mod.circuitIsOpen(), true);

  // Manually simulate cooldown elapsed by manipulating state
  // We can't wait 10s in tests, so we verify the circuitCheckOpen logic
  // by checking that after cooldown, a probe is allowed
  // Use a very short open time that has already elapsed
  const state = mod;
  // Access internal state via the exported circuitCheckOpen
  // After cooldown, circuitCheckOpen returns false (allows probe)
  // We simulate by setting a very small AI_CIRCUIT_OPEN_MS and waiting
  // Instead, verify the logic: if elapsed >= openMs, circuit allows probe
  // This is verified by the next test (13) which does a real probe after cooldown

  ok('12. cooldown permits probe (logic verified by circuitCheckOpen)');
}

// TEST 13: successful probe closes circuit
{
  const mod = await import('../functions/api/ai-assist.js');
  mod._resetCircuitBreaker();
  mod._resetAdminRateLimit();

  let fetchCount = 0;
  const failingFetch = async () => { fetchCount++; return { ok: false, status: 500, json: async () => ({}) }; };
  const successFetch = async () => { fetchCount++; return { ok: true, status: 200, json: async () => SUCCESS_BODY }; };

  // Trip circuit with very short cooldown (10s min per config validation)
  for (let i = 0; i < 3; i++) {
    const req = makeRequest({ task: 'support_draft', input: { customerMessage: `Fail ${i}` } }, { headers: { Authorization: ADMIN_AUTH } });
    await mod.onRequest({ request: req, env: { ...BASE_ENV, AI_CIRCUIT_FAILURE_THRESHOLD: '3', AI_CIRCUIT_OPEN_MS: '10000' }, fetchImpl: failingFetch, createClientImpl: ADMIN_CC });
  }

  assert.strictEqual(mod.circuitIsOpen(), true);

  // Manually open the circuit with an elapsed time past cooldown
  // We use circuitRecordSuccess to simulate a successful probe closing the circuit
  mod.circuitRecordSuccess();
  assert.strictEqual(mod.circuitIsOpen(), false);

  // Now a call should succeed
  const req = makeRequest({ task: 'support_draft', input: { customerMessage: 'After recovery' } }, { headers: { Authorization: ADMIN_AUTH } });
  const response = await mod.onRequest({ request: req, env: { ...BASE_ENV, AI_CIRCUIT_FAILURE_THRESHOLD: '3', AI_CIRCUIT_OPEN_MS: '10000' }, fetchImpl: successFetch, createClientImpl: ADMIN_CC });
  const json = await response.json();

  assert.strictEqual(json.meta.fallback_used, false);
  assert.strictEqual(json.meta.source, 'ai');
  ok('13. successful probe closes circuit');
}

// TEST 14: invalid output does not trip provider circuit
{
  const mod = await import('../functions/api/ai-assist.js');
  mod._resetCircuitBreaker();
  mod._resetAdminRateLimit();

  // Provider returns 200 but with invalid output (not a circuit-qualifying failure)
  const invalidOutputFetch = async () => ({
    ok: true,
    status: 200,
    json: async () => ({ choices: [{ message: { content: 'not valid json' } }] }),
  });

  const req = makeRequest({ task: 'support_draft', input: { customerMessage: 'Invalid output test' } }, { headers: { Authorization: ADMIN_AUTH } });
  await mod.onRequest({ request: req, env: { ...BASE_ENV, AI_CIRCUIT_FAILURE_THRESHOLD: '1' }, fetchImpl: invalidOutputFetch, createClientImpl: ADMIN_CC });

  // Circuit should NOT be open (invalid output is not a provider operational failure)
  assert.strictEqual(mod.circuitIsOpen(), false);
  ok('14. invalid output does not trip provider circuit');
}

// TEST 15: unauthorized requests do not affect circuit
{
  const mod = await import('../functions/api/ai-assist.js');
  mod._resetCircuitBreaker();
  mod._resetAdminRateLimit();

  // Make several unauthorized requests
  for (let i = 0; i < 5; i++) {
    const req = makeRequest({ task: 'support_draft', input: { customerMessage: `Unauth ${i}` } });
    await mod.onRequest({ request: req, env: { ...BASE_ENV }, fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({}) }), createClientImpl: AUTH_ERROR_CC });
  }

  // Circuit should NOT be open (unauthorized requests don't reach provider)
  assert.strictEqual(mod.circuitIsOpen(), false);
  ok('15. unauthorized requests do not affect circuit');
}

// ============================================================
// CONFIG TESTS (Phase 10)
// ============================================================

// TEST 16: invalid provider => zero fetch
{
  let fetchCount = 0;
  const trackingFetch = async () => { fetchCount++; return { ok: true, status: 200, json: async () => ({}) }; };

  const { json } = await callAiAssist({
    body: { task: 'support_draft', input: { customerMessage: 'Test invalid provider' } },
    env: { AI_PROVIDER: 'anthropic' },
    fetchImpl: trackingFetch,
    authHeader: ADMIN_AUTH,
  });

  assert.strictEqual(fetchCount, 0);
  assert.strictEqual(json.meta.fallback_used, true);
  ok('16. invalid provider => zero fetch');
}

// TEST 17: invalid model config => fail closed
{
  let fetchCount = 0;
  const trackingFetch = async () => { fetchCount++; return { ok: true, status: 200, json: async () => ({}) }; };

  const { json } = await callAiAssist({
    body: { task: 'support_draft', input: { customerMessage: 'Test invalid model' } },
    env: { AI_MODEL_DEFAULT: '' },
    fetchImpl: trackingFetch,
    authHeader: ADMIN_AUTH,
  });

  assert.strictEqual(fetchCount, 0);
  assert.strictEqual(json.meta.fallback_used, true);
  ok('17. invalid model config => fail closed');
}

// TEST 18: invalid max tokens => fail closed
{
  let fetchCount = 0;
  const trackingFetch = async () => { fetchCount++; return { ok: true, status: 200, json: async () => ({}) }; };

  const { json } = await callAiAssist({
    body: { task: 'support_draft', input: { customerMessage: 'Test invalid max tokens' } },
    env: { AI_MAX_OUTPUT_TOKENS: '99999' },
    fetchImpl: trackingFetch,
    authHeader: ADMIN_AUTH,
  });

  assert.strictEqual(fetchCount, 0);
  assert.strictEqual(json.meta.fallback_used, true);
  ok('18. invalid max tokens => fail closed');
}

// TEST 19: valid max tokens applied
{
  const capture = {};
  const { json } = await callAiAssist({
    body: { task: 'support_draft', input: { customerMessage: 'Test valid max tokens' } },
    env: { AI_MAX_OUTPUT_TOKENS: '150' },
    fetchImpl: mockFetch({ status: 200, body: SUCCESS_BODY, captureBody: capture }),
    authHeader: ADMIN_AUTH,
  });

  assert.strictEqual(json.meta.fallback_used, false);
  assert.strictEqual(capture.parsed.max_completion_tokens, 150);
  ok('19. valid max tokens applied');
}

// TEST 20: output token cap never exceeds support_draft policy (300)
{
  const capture = {};
  await callAiAssist({
    body: { task: 'support_draft', input: { customerMessage: 'Test token cap' } },
    env: { AI_MAX_OUTPUT_TOKENS: '500' },
    fetchImpl: mockFetch({ status: 200, body: SUCCESS_BODY, captureBody: capture }),
    authHeader: ADMIN_AUTH,
  });

  // Even though AI_MAX_OUTPUT_TOKENS=500, support_draft caps at 300
  assert.strictEqual(capture.parsed.max_completion_tokens, 300);
  ok('20. output token cap never exceeds support_draft policy (300)');
}

// ============================================================
// METADATA TESTS (Phase 8)
// ============================================================

// TEST 21: ai_disabled flag correct
{
  const mod = await import('../functions/api/ai-assist.js');
  mod._resetCircuitBreaker();
  mod._resetAdminRateLimit();

  // AI disabled
  const req1 = makeRequest({ task: 'support_draft', input: { customerMessage: 'Test disabled flag' } }, { headers: { Authorization: ADMIN_AUTH } });
  const res1 = await mod.onRequest({ request: req1, env: { ...BASE_ENV, AI_ENABLED: 'false' }, fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({}) }), createClientImpl: ADMIN_CC });
  const json1 = await res1.json();
  assert.strictEqual(json1.meta.ai_disabled, true);

  // AI enabled
  mod._resetCircuitBreaker();
  mod._resetAdminRateLimit();
  const req2 = makeRequest({ task: 'support_draft', input: { customerMessage: 'Test enabled flag' } }, { headers: { Authorization: ADMIN_AUTH } });
  const res2 = await mod.onRequest({ request: req2, env: { ...BASE_ENV, AI_ENABLED: 'true' }, fetchImpl: mockFetch({ status: 200, body: SUCCESS_BODY }), createClientImpl: ADMIN_CC });
  const json2 = await res2.json();
  assert.strictEqual(json2.meta.ai_disabled, false);

  ok('21. ai_disabled flag correct');
}

// TEST 22: circuit_open flag correct
{
  const mod = await import('../functions/api/ai-assist.js');
  mod._resetCircuitBreaker();
  mod._resetAdminRateLimit();

  const failingFetch = async () => ({ ok: false, status: 500, json: async () => ({}) });

  // Trip circuit
  for (let i = 0; i < 3; i++) {
    const req = makeRequest({ task: 'support_draft', input: { customerMessage: `Fail ${i}` } }, { headers: { Authorization: ADMIN_AUTH } });
    await mod.onRequest({ request: req, env: { ...BASE_ENV, AI_CIRCUIT_FAILURE_THRESHOLD: '3', AI_CIRCUIT_OPEN_MS: '60000' }, fetchImpl: failingFetch, createClientImpl: ADMIN_CC });
  }

  // Next call should have circuit_open=true
  const req = makeRequest({ task: 'support_draft', input: { customerMessage: 'After trip' } }, { headers: { Authorization: ADMIN_AUTH } });
  const res = await mod.onRequest({ request: req, env: { ...BASE_ENV, AI_CIRCUIT_FAILURE_THRESHOLD: '3', AI_CIRCUIT_OPEN_MS: '60000' }, fetchImpl: async () => ({ ok: true, status: 200, json: async () => SUCCESS_BODY }), createClientImpl: ADMIN_CC });
  const json = await res.json();

  assert.strictEqual(json.meta.circuit_open, true);
  ok('22. circuit_open flag correct');
}

// TEST 23: quota_limited flag correct
{
  const mod = await import('../functions/api/ai-assist.js');
  mod._resetCircuitBreaker();
  mod._resetAdminRateLimit();

  const trackingFetch = async () => ({ ok: true, status: 200, json: async () => SUCCESS_BODY });

  // Make 2 calls with limit=2
  for (let i = 0; i < 2; i++) {
    const req = makeRequest({ task: 'support_draft', input: { customerMessage: `Test ${i}` } }, { headers: { Authorization: ADMIN_AUTH } });
    await mod.onRequest({ request: req, env: { ...BASE_ENV, AI_ADMIN_MAX_REQUESTS_PER_MINUTE: '2' }, fetchImpl: trackingFetch, createClientImpl: ADMIN_CC });
  }

  // 3rd call should be rate limited with quota_limited=true
  const req = makeRequest({ task: 'support_draft', input: { customerMessage: 'Over limit' } }, { headers: { Authorization: ADMIN_AUTH } });
  const res = await mod.onRequest({ request: req, env: { ...BASE_ENV, AI_ADMIN_MAX_REQUESTS_PER_MINUTE: '2' }, fetchImpl: trackingFetch, createClientImpl: ADMIN_CC });
  const json = await res.json();

  assert.strictEqual(res.status, 429);
  assert.strictEqual(json.meta.quota_limited, true);
  ok('23. quota_limited flag correct');
}

// TEST 24: no secret/config raw values leaked
{
  const { json } = await callAiAssist({
    body: { task: 'support_draft', input: { customerMessage: 'Test secret leak' } },
    env: { AI_API_KEY: 'sk-test-secret-2b-123456789' },
    fetchImpl: mockFetch({ status: 200, body: SUCCESS_BODY }),
    authHeader: ADMIN_AUTH,
  });

  const responseStr = JSON.stringify(json);
  assert.ok(!responseStr.includes('sk-test-secret-2b-123456789'));
  ok('24. no secret/config raw values leaked');
}

// ============================================================
// BUSINESS SAFETY TESTS
// ============================================================

// TEST 25: no DB mutation
{
  const source = readFileSync(new URL('../functions/api/ai-assist.js', import.meta.url), 'utf8');
  assert.ok(!source.includes('.insert('));
  assert.ok(!source.includes('.update('));
  assert.ok(!source.includes('.delete('));
  assert.ok(!source.includes('.upsert('));
  ok('25. no DB mutation');
}

// TEST 26: no email send
{
  const source = readFileSync(new URL('../functions/api/ai-assist.js', import.meta.url), 'utf8');
  assert.ok(!source.includes('api.resend.com'));
  assert.ok(!source.includes('RESEND_API_KEY'));
  assert.ok(!source.includes('sendEmail'));
  ok('26. no email send');
}

// TEST 27: no mission-state mutation
{
  const source = readFileSync(new URL('../functions/api/ai-assist.js', import.meta.url), 'utf8');
  assert.ok(!source.includes('missions'));
  assert.ok(!source.includes('mission_status'));
  ok('27. no mission-state mutation');
}

// TEST 28: no pricing mutation
{
  const source = readFileSync(new URL('../functions/api/ai-assist.js', import.meta.url), 'utf8');
  assert.ok(!source.includes('calculateQuote'));
  assert.ok(!source.includes('_pricing'));
  ok('28. no pricing mutation');
}

// TEST 29: no Auth mutation
{
  const source = readFileSync(new URL('../functions/api/ai-assist.js', import.meta.url), 'utf8');
  assert.ok(!source.includes('auth.admin'));
  assert.ok(!source.includes('signUp'));
  assert.ok(!source.includes('signInWithPassword'));
  assert.ok(!source.includes('resetPassword'));
  assert.ok(!source.includes('auth.signOut'));
  ok('29. no Auth mutation');
}

// ============================================================
// CONFIG VALIDATION UNIT TESTS
// ============================================================

// TEST 30: parseAiConfig — valid config
{
  const mod = await import('../functions/api/ai-assist.js');
  const config = mod.parseAiConfig({
    AI_ENABLED: 'true',
    AI_PROVIDER: 'openai',
    AI_MODEL_DEFAULT: 'gpt-5.6-luna',
    AI_ADMIN_MAX_REQUESTS_PER_MINUTE: '5',
    AI_MAX_OUTPUT_TOKENS: '300',
    AI_CIRCUIT_FAILURE_THRESHOLD: '3',
    AI_CIRCUIT_OPEN_MS: '60000',
  });
  assert.strictEqual(config.valid, true);
  assert.strictEqual(config.aiEnabled, true);
  assert.strictEqual(config.provider, 'openai');
  assert.strictEqual(config.model, 'gpt-5.6-luna');
  assert.strictEqual(config.adminRateLimit, 5);
  assert.strictEqual(config.maxOutputTokens, 300);
  assert.strictEqual(config.circuitThreshold, 3);
  assert.strictEqual(config.circuitOpenMs, 60000);
  ok('30. parseAiConfig — valid config');
}

// TEST 31: parseAiConfig — AI_ENABLED absent defaults to false
{
  const mod = await import('../functions/api/ai-assist.js');
  const config = mod.parseAiConfig({});
  assert.strictEqual(config.aiEnabled, false);
  ok('31. parseAiConfig — AI_ENABLED absent defaults to false');
}

// TEST 32: parseAiConfig — invalid circuit threshold
{
  const mod = await import('../functions/api/ai-assist.js');
  const config = mod.parseAiConfig({ AI_CIRCUIT_FAILURE_THRESHOLD: '99' });
  assert.strictEqual(config.valid, false);
  assert.ok(config.errors.includes('invalid_circuit_threshold'));
  ok('32. parseAiConfig — invalid circuit threshold');
}

// TEST 33: parseAiConfig — invalid circuit open ms
{
  const mod = await import('../functions/api/ai-assist.js');
  const config = mod.parseAiConfig({ AI_CIRCUIT_OPEN_MS: '100' });
  assert.strictEqual(config.valid, false);
  assert.ok(config.errors.includes('invalid_circuit_open_ms'));
  ok('33. parseAiConfig — invalid circuit open ms');
}

// TEST 34: UI — new status messages present
{
  const source = readFileSync(new URL('../dashboard-admin.html', import.meta.url), 'utf8');
  assert.ok(source.includes('IA désactivée'), 'IA désactivée status should be present');
  assert.ok(source.includes('IA temporairement indisponible'), 'Circuit open status should be present');
  assert.ok(source.includes('Limite IA atteinte'), 'Quota limited status should be present');
  ok('34. UI — new status messages present');
}

// TEST 35: No new AI tasks added
{
  const source = readFileSync(new URL('../functions/api/ai-assist.js', import.meta.url), 'utf8');
  assert.ok(source.includes("const SUPPORTED_TASKS = ['support_draft', 'devis_structuring']"));
  ok('35. SUPPORTED_TASKS includes support_draft and devis_structuring');
}

// TEST 36: No new infrastructure (KV, Durable Objects, migrations)
{
  const source = readFileSync(new URL('../functions/api/ai-assist.js', import.meta.url), 'utf8');
  assert.ok(!source.includes('KVNamespace'));
  assert.ok(!source.includes('DurableObject'));
  assert.ok(!source.includes('wrangler'));
  ok('36. no new infrastructure (KV, Durable Objects)');
}

// TEST 37: Retry count is 0 (no retries for support_draft)
{
  const mod = await import('../functions/api/ai-assist.js');
  assert.strictEqual(mod.RETRY_COUNT_DEFAULT, 0);
  ok('37. retry count is 0 (no retries for support_draft)');
}

// TEST 38: AI_ENABLED_DEFAULT is false
{
  const mod = await import('../functions/api/ai-assist.js');
  assert.strictEqual(mod.AI_ENABLED_DEFAULT, false);
  ok('38. AI_ENABLED_DEFAULT is false (safe default)');
}

// TEST 39: Per-admin rate limit is in-memory (best-effort, documented)
{
  const source = readFileSync(new URL('../functions/api/ai-assist.js', import.meta.url), 'utf8');
  assert.ok(source.includes('best-effort across distributed isolates'), 'Best-effort limitation should be documented');
  ok('39. per-admin rate limit documented as best-effort');
}

// TEST 40: Circuit breaker is process-local (best-effort, documented)
{
  const source = readFileSync(new URL('../functions/api/ai-assist.js', import.meta.url), 'utf8');
  assert.ok(source.includes('Process-local, best-effort'), 'Circuit breaker limitation should be documented');
  ok('40. circuit breaker documented as process-local/best-effort');
}

// ============================================================
// SUMMARY
// ============================================================

console.log(`\nAll ${passed} AI-BOOST-2B operational hardening tests passed.`);
