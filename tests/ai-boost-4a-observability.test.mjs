// AI-BOOST-4A — Observability / Quality / Cost Baseline Tests
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

function mockCreateClient({ admin = true } = {}) {
  return function() {
    return {
      auth: {
        getUser: async (token) => {
          if (!token || token.length < 10) return { data: { user: null }, error: { message: 'invalid' } };
          return { data: { user: { id: 'admin-4a', email: 'admin@test.com' } }, error: null };
        },
      },
      rpc: async (fnName) => {
        if (fnName === 'is_admin') return { data: admin, error: null };
        return { data: null, error: { message: 'unknown' } };
      },
    };
  };
}

const ADMIN_CC = mockCreateClient({ admin: true });
const ADMIN_AUTH = 'Bearer test-admin-4a-token-1234567890';

const BASE_ENV = {
  SUPABASE_URL: 'https://test.supabase.co',
  SUPABASE_ANON_KEY: 'test-anon-key',
  AI_ENABLED: 'true',
  AI_API_KEY: 'test-key',
  AI_MODEL_DEFAULT: 'gpt-5.6-luna',
  AI_ADMIN_MAX_REQUESTS_PER_MINUTE: '30',
};

let ipCounter = 0;
function makeRequest(body, opts = {}) {
  ipCounter++;
  const headers = new Map();
  headers.set('content-type', 'application/json');
  headers.set('origin', 'https://www.bathily-convoyage.fr');
  headers.set('cf-connecting-ip', `203.0.113.${ipCounter % 200 + 1}`);
  if (opts.headers) {
    for (const [k, v] of Object.entries(opts.headers)) headers.set(k.toLowerCase(), v);
  }
  return {
    method: 'POST',
    headers: { get: (name) => headers.get(name.toLowerCase()) || null },
    text: async () => typeof body === 'string' ? body : JSON.stringify(body),
    url: 'https://www.bathily-convoyage.fr/api/ai-assist',
  };
}

// Capture console.log for telemetry inspection
let telemetryCaptures = [];
function captureTelemetry() {
  telemetryCaptures = [];
  const origLog = console.log;
  console.log = function(...args) {
    try {
      const parsed = JSON.parse(args[0]);
      if (parsed.event === 'ai_request' || parsed.type === 'ai_telemetry') {
        telemetryCaptures.push(parsed);
      }
    } catch {}
    origLog.apply(console, args);
  };
  return () => { console.log = origLog; };
}

async function callAiAssist({ body, env, fetchImpl, authHeader, createClientImpl }) {
  const mod = await import('../functions/api/ai-assist.js');
  if (mod._resetCircuitBreaker) mod._resetCircuitBreaker();
  if (mod._resetAdminRateLimit) mod._resetAdminRateLimit();
  if (mod._resetAggregation) mod._resetAggregation();
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
  const { status = 200, body = null } = opts;
  return async function() {
    return { ok: status >= 200 && status < 300, status, json: async () => body || {} };
  };
}

const SUCCESS_BODY = {
  choices: [{ message: { content: '{"draft":"Bonjour, nous revenons vers vous.","confidence":"medium"}' } }],
  usage: { prompt_tokens: 100, completion_tokens: 50 },
};

const DEVIS_SUCCESS_BODY = {
  choices: [{ message: { content: JSON.stringify({
    vehicle_type: 'car', urgency: 'normal', pickup_constraints: ['en semaine'],
    delivery_constraints: ['avant vendredi'], special_constraints: [],
    customer_intent: 'quote_request', needs_human_review: false,
  }) } }],
  usage: { prompt_tokens: 80, completion_tokens: 40 },
};

// ============================================================
// TELEMETRY TESTS (1-11)
// ============================================================

// TEST 1: success event contains allowed fields
{
  const restore = captureTelemetry();
  await callAiAssist({
    body: { task: 'support_draft', input: { customerMessage: 'test' } },
    fetchImpl: mockFetch({ status: 200, body: SUCCESS_BODY }),
    authHeader: ADMIN_AUTH,
  });
  restore();
  const event = telemetryCaptures.find(e => e.status === 'success' || e.event === 'ai_request');
  assert.ok(event);
  assert.strictEqual(event.event, 'ai_request');
  assert.ok(event.request_id);
  assert.ok(event.task);
  assert.ok('fallback_used' in event);
  assert.ok('model' in event);
  assert.ok('provider' in event);
  assert.ok('latency_ms' in event);
  ok('1. success event contains allowed fields');
}

// TEST 2: fallback event correct
{
  const restore = captureTelemetry();
  await callAiAssist({
    body: { task: 'support_draft', input: { customerMessage: 'test' } },
    env: { AI_ENABLED: 'false' },
    fetchImpl: mockFetch({ status: 200, body: SUCCESS_BODY }),
    authHeader: ADMIN_AUTH,
  });
  restore();
  const event = telemetryCaptures.find(e => e.fallback_used === true);
  assert.ok(event);
  assert.strictEqual(event.source, 'fallback');
  ok('2. fallback event correct');
}

// TEST 3: disabled event correct
{
  const restore = captureTelemetry();
  await callAiAssist({
    body: { task: 'support_draft', input: { customerMessage: 'test' } },
    env: { AI_ENABLED: 'false' },
    fetchImpl: mockFetch({ status: 200, body: SUCCESS_BODY }),
    authHeader: ADMIN_AUTH,
  });
  restore();
  const event = telemetryCaptures.find(e => e.ai_disabled === true);
  assert.ok(event);
  assert.strictEqual(event.error_category, 'ai_disabled');
  ok('3. disabled event correct');
}

// TEST 4: quota event correct
{
  const mod = await import('../functions/api/ai-assist.js');
  mod._resetCircuitBreaker();
  mod._resetAdminRateLimit();
  mod._resetAggregation();
  const restore = captureTelemetry();
  const trackingFetch = async () => ({ ok: true, status: 200, json: async () => SUCCESS_BODY });
  for (let i = 0; i < 2; i++) {
    const req = makeRequest({ task: 'support_draft', input: { customerMessage: `t${i}` } }, { headers: { Authorization: ADMIN_AUTH } });
    await mod.onRequest({ request: req, env: { ...BASE_ENV, AI_ADMIN_MAX_REQUESTS_PER_MINUTE: '2' }, fetchImpl: trackingFetch, createClientImpl: ADMIN_CC });
  }
  const req3 = makeRequest({ task: 'support_draft', input: { customerMessage: 'over' } }, { headers: { Authorization: ADMIN_AUTH } });
  await mod.onRequest({ request: req3, env: { ...BASE_ENV, AI_ADMIN_MAX_REQUESTS_PER_MINUTE: '2' }, fetchImpl: trackingFetch, createClientImpl: ADMIN_CC });
  restore();
  const event = telemetryCaptures.find(e => e.quota_limited === true);
  assert.ok(event);
  assert.strictEqual(event.error_category, 'quota_limited');
  assert.strictEqual(event.http_status, 429);
  ok('4. quota event correct');
}

// TEST 5: circuit event correct
{
  const mod = await import('../functions/api/ai-assist.js');
  mod._resetCircuitBreaker();
  mod._resetAdminRateLimit();
  mod._resetAggregation();
  const failingFetch = async () => ({ ok: false, status: 500, json: async () => ({}) });
  for (let i = 0; i < 3; i++) {
    const req = makeRequest({ task: 'support_draft', input: { customerMessage: `f${i}` } }, { headers: { Authorization: ADMIN_AUTH } });
    await mod.onRequest({ request: req, env: { ...BASE_ENV, AI_CIRCUIT_FAILURE_THRESHOLD: '3', AI_CIRCUIT_OPEN_MS: '60000' }, fetchImpl: failingFetch, createClientImpl: ADMIN_CC });
  }
  const restore = captureTelemetry();
  const req = makeRequest({ task: 'support_draft', input: { customerMessage: 'after' } }, { headers: { Authorization: ADMIN_AUTH } });
  await mod.onRequest({ request: req, env: { ...BASE_ENV, AI_CIRCUIT_FAILURE_THRESHOLD: '3', AI_CIRCUIT_OPEN_MS: '60000' }, fetchImpl: async () => ({ ok: true, status: 200, json: async () => SUCCESS_BODY }), createClientImpl: ADMIN_CC });
  restore();
  const event = telemetryCaptures.find(e => e.circuit_open === true);
  assert.ok(event);
  assert.strictEqual(event.error_category, 'circuit_open');
  ok('5. circuit event correct');
}

// TEST 6: timeout normalized
{
  const mod = await import('../functions/api/ai-assist.js');
  const result = mod.normalizeErrorCategory('timeout');
  assert.strictEqual(result, 'provider_timeout');
  ok('6. timeout normalized');
}

// TEST 7: provider 429 normalized
{
  const mod = await import('../functions/api/ai-assist.js');
  const result = mod.normalizeErrorCategory('rate_limited_by_provider');
  assert.strictEqual(result, 'provider_rate_limited');
  ok('7. provider 429 normalized');
}

// TEST 8: provider 5xx normalized
{
  const mod = await import('../functions/api/ai-assist.js');
  const result = mod.normalizeErrorCategory('provider_error');
  assert.strictEqual(result, 'provider_5xx');
  ok('8. provider 5xx normalized');
}

// TEST 9: invalid output normalized
{
  const mod = await import('../functions/api/ai-assist.js');
  const result = mod.normalizeErrorCategory('invalid_json_output');
  assert.strictEqual(result, 'output_validation_failed');
  ok('9. invalid output normalized');
}

// TEST 10: unknown task normalized
{
  const mod = await import('../functions/api/ai-assist.js');
  const result = mod.normalizeErrorCategory('unknown_task');
  assert.strictEqual(result, 'unknown_task');
  ok('10. unknown task normalized');
}

// TEST 11: invalid input normalized
{
  const mod = await import('../functions/api/ai-assist.js');
  const result = mod.normalizeErrorCategory('invalid_body');
  assert.strictEqual(result, 'invalid_input');
  ok('11. invalid input normalized');
}

// ============================================================
// PRIVACY TESTS (12-20)
// ============================================================

// TEST 12: prompt content absent
{
  const restore = captureTelemetry();
  await callAiAssist({
    body: { task: 'support_draft', input: { customerMessage: 'secret prompt content test' } },
    fetchImpl: mockFetch({ status: 200, body: SUCCESS_BODY }),
    authHeader: ADMIN_AUTH,
  });
  restore();
  const event = telemetryCaptures.find(e => e.event === 'ai_request');
  const eventStr = JSON.stringify(event);
  assert.ok(!eventStr.includes('secret prompt content test'));
  // "prompt_tokens" is a field name (allowed), but raw prompt text must not be present
  assert.ok(!eventStr.includes('customerMessage'));
  ok('12. prompt content absent from telemetry');
}

// TEST 13: output absent
{
  const restore = captureTelemetry();
  await callAiAssist({
    body: { task: 'support_draft', input: { customerMessage: 'test' } },
    fetchImpl: mockFetch({ status: 200, body: SUCCESS_BODY }),
    authHeader: ADMIN_AUTH,
  });
  restore();
  const event = telemetryCaptures.find(e => e.event === 'ai_request' && e.fallback_used === false);
  assert.ok(event);
  const eventStr = JSON.stringify(event);
  assert.ok(!eventStr.includes('Bonjour, nous revenons'));
  ok('13. output absent from telemetry');
}

// TEST 14: customerMessage absent
{
  const restore = captureTelemetry();
  await callAiAssist({
    body: { task: 'support_draft', input: { customerMessage: 'customer secret message' } },
    fetchImpl: mockFetch({ status: 200, body: SUCCESS_BODY }),
    authHeader: ADMIN_AUTH,
  });
  restore();
  const eventStr = JSON.stringify(telemetryCaptures);
  assert.ok(!eventStr.includes('customer secret message'));
  assert.ok(!eventStr.includes('customerMessage'));
  ok('14. customerMessage absent from telemetry');
}

// TEST 15: auth token absent
{
  const restore = captureTelemetry();
  await callAiAssist({
    body: { task: 'support_draft', input: { customerMessage: 'test' } },
    fetchImpl: mockFetch({ status: 200, body: SUCCESS_BODY }),
    authHeader: 'Bearer super-secret-token-1234567890',
  });
  restore();
  const eventStr = JSON.stringify(telemetryCaptures);
  assert.ok(!eventStr.includes('super-secret-token-1234567890'));
  ok('15. auth token absent from telemetry');
}

// TEST 16: API key absent
{
  const restore = captureTelemetry();
  await callAiAssist({
    body: { task: 'support_draft', input: { customerMessage: 'test' } },
    env: { AI_API_KEY: 'sk-test-secret-key-4a-123456789' },
    fetchImpl: mockFetch({ status: 200, body: SUCCESS_BODY }),
    authHeader: ADMIN_AUTH,
  });
  restore();
  const eventStr = JSON.stringify(telemetryCaptures);
  assert.ok(!eventStr.includes('sk-test-secret-key-4a-123456789'));
  ok('16. API key absent from telemetry');
}

// TEST 17: raw provider error absent
{
  const restore = captureTelemetry();
  const errorBody = { error: { message: 'raw internal provider error with stack trace' } };
  await callAiAssist({
    body: { task: 'support_draft', input: { customerMessage: 'test' } },
    fetchImpl: mockFetch({ status: 500, body: errorBody }),
    authHeader: ADMIN_AUTH,
  });
  restore();
  const eventStr = JSON.stringify(telemetryCaptures);
  assert.ok(!eventStr.includes('raw internal provider error'));
  assert.ok(!eventStr.includes('stack trace'));
  ok('17. raw provider error absent from telemetry');
}

// TEST 18: user_id absent
{
  const restore = captureTelemetry();
  await callAiAssist({
    body: { task: 'support_draft', input: { customerMessage: 'test' } },
    fetchImpl: mockFetch({ status: 200, body: SUCCESS_BODY }),
    authHeader: ADMIN_AUTH,
  });
  restore();
  const event = telemetryCaptures.find(e => e.event === 'ai_request');
  assert.ok(!('user_id' in event));
  assert.ok(!('admin_user_id' in event));
  ok('18. user_id absent from telemetry');
}

// TEST 19: quote_id absent
{
  const restore = captureTelemetry();
  await callAiAssist({
    body: { task: 'devis_structuring', input: { customerMessage: 'test' } },
    fetchImpl: mockFetch({ status: 200, body: DEVIS_SUCCESS_BODY }),
    authHeader: ADMIN_AUTH,
  });
  restore();
  const event = telemetryCaptures.find(e => e.event === 'ai_request');
  assert.ok(!('quote_id' in event));
  ok('19. quote_id absent from telemetry');
}

// TEST 20: mission_id absent
{
  const restore = captureTelemetry();
  await callAiAssist({
    body: { task: 'support_draft', input: { customerMessage: 'test' } },
    fetchImpl: mockFetch({ status: 200, body: SUCCESS_BODY }),
    authHeader: ADMIN_AUTH,
  });
  restore();
  const event = telemetryCaptures.find(e => e.event === 'ai_request');
  assert.ok(!('mission_id' in event));
  ok('20. mission_id absent from telemetry');
}

// ============================================================
// TOKEN TESTS (21-23)
// ============================================================

// TEST 21: usage parsed correctly
{
  const restore = captureTelemetry();
  await callAiAssist({
    body: { task: 'support_draft', input: { customerMessage: 'test' } },
    fetchImpl: mockFetch({ status: 200, body: SUCCESS_BODY }),
    authHeader: ADMIN_AUTH,
  });
  restore();
  const event = telemetryCaptures.find(e => e.event === 'ai_request' && e.fallback_used === false);
  assert.strictEqual(event.prompt_tokens, 100);
  assert.strictEqual(event.completion_tokens, 50);
  assert.strictEqual(event.total_tokens, 150);
  ok('21. usage parsed correctly');
}

// TEST 22: total_tokens computed only if both present
{
  const mod = await import('../functions/api/ai-assist.js');
  // Simulate: input present, output null
  const restore = captureTelemetry();
  const partialBody = {
    choices: [{ message: { content: '{"draft":"test","confidence":"low"}' } }],
    usage: { prompt_tokens: 50 }, // no completion_tokens
  };
  await callAiAssist({
    body: { task: 'support_draft', input: { customerMessage: 'test' } },
    fetchImpl: mockFetch({ status: 200, body: partialBody }),
    authHeader: ADMIN_AUTH,
  });
  restore();
  const event = telemetryCaptures.find(e => e.event === 'ai_request' && e.fallback_used === false);
  assert.strictEqual(event.prompt_tokens, 50);
  assert.strictEqual(event.completion_tokens, null);
  assert.strictEqual(event.total_tokens, null);
  ok('22. total_tokens null when one component missing');
}

// TEST 23: missing usage => nulls
{
  const restore = captureTelemetry();
  const noUsageBody = {
    choices: [{ message: { content: '{"draft":"test","confidence":"low"}' } }],
  };
  await callAiAssist({
    body: { task: 'support_draft', input: { customerMessage: 'test' } },
    fetchImpl: mockFetch({ status: 200, body: noUsageBody }),
    authHeader: ADMIN_AUTH,
  });
  restore();
  const event = telemetryCaptures.find(e => e.event === 'ai_request' && e.fallback_used === false);
  assert.strictEqual(event.prompt_tokens, null);
  assert.strictEqual(event.completion_tokens, null);
  assert.strictEqual(event.total_tokens, null);
  ok('23. missing usage => nulls');
}

// ============================================================
// COST TESTS (24-27)
// ============================================================

// TEST 24: valid synthetic rates compute expected cost
{
  const mod = await import('../functions/api/ai-assist.js');
  const cost = mod.estimateCost(
    { input_tokens: 1000, output_tokens: 500 },
    { costInputPer1mUsd: 10, costOutputPer1mUsd: 30 },
  );
  // 1000/1M * 10 + 500/1M * 30 = 0.01 + 0.015 = 0.025
  assert.strictEqual(cost, 0.025);
  ok('24. valid synthetic rates compute expected cost');
}

// TEST 25: absent rates => null
{
  const mod = await import('../functions/api/ai-assist.js');
  const cost = mod.estimateCost(
    { input_tokens: 100, output_tokens: 50 },
    { costInputPer1mUsd: null, costOutputPer1mUsd: null },
  );
  assert.strictEqual(cost, null);
  ok('25. absent rates => null');
}

// TEST 26: invalid rates ignored
{
  const mod = await import('../functions/api/ai-assist.js');
  assert.strictEqual(mod.parseCostRate('abc'), null);
  assert.strictEqual(mod.parseCostRate('-1'), null);
  assert.strictEqual(mod.parseCostRate(''), null);
  assert.strictEqual(mod.parseCostRate(undefined), null);
  assert.strictEqual(mod.parseCostRate('10'), 10);
  ok('26. invalid rates ignored/safely disabled');
}

// TEST 27: cost config never breaks provider call
{
  const { json } = await callAiAssist({
    body: { task: 'support_draft', input: { customerMessage: 'test' } },
    env: { AI_COST_INPUT_PER_1M_USD: 'invalid', AI_COST_OUTPUT_PER_1M_USD: 'also-invalid' },
    fetchImpl: mockFetch({ status: 200, body: SUCCESS_BODY }),
    authHeader: ADMIN_AUTH,
  });
  assert.strictEqual(json.meta.fallback_used, false);
  assert.strictEqual(json.meta.source, 'ai');
  ok('27. cost config never breaks provider call');
}

// ============================================================
// AGGREGATION TESTS (28-34)
// ============================================================

// TEST 28: success counter increments
{
  const mod = await import('../functions/api/ai-assist.js');
  mod._resetCircuitBreaker();
  mod._resetAdminRateLimit();
  mod._resetAggregation();
  await callAiAssist({
    body: { task: 'support_draft', input: { customerMessage: 'test' } },
    fetchImpl: mockFetch({ status: 200, body: SUCCESS_BODY }),
    authHeader: ADMIN_AUTH,
  });
  const summary = mod.getAggregationSummary();
  assert.strictEqual(summary.support_draft.requests, 1);
  assert.strictEqual(summary.support_draft.successes, 1);
  ok('28. success counter increments');
}

// TEST 29: fallback counter increments
{
  const mod = await import('../functions/api/ai-assist.js');
  mod._resetCircuitBreaker();
  mod._resetAdminRateLimit();
  mod._resetAggregation();
  await callAiAssist({
    body: { task: 'support_draft', input: { customerMessage: 'test' } },
    env: { AI_ENABLED: 'false' },
    fetchImpl: mockFetch({ status: 200, body: SUCCESS_BODY }),
    authHeader: ADMIN_AUTH,
  });
  const summary = mod.getAggregationSummary();
  assert.strictEqual(summary.support_draft.fallbacks, 1);
  ok('29. fallback counter increments');
}

// TEST 30: error counter increments
{
  const mod = await import('../functions/api/ai-assist.js');
  mod._resetCircuitBreaker();
  mod._resetAdminRateLimit();
  mod._resetAggregation();
  await callAiAssist({
    body: { task: 'support_draft', input: { customerMessage: 'test' } },
    fetchImpl: mockFetch({ status: 500, body: {} }),
    authHeader: ADMIN_AUTH,
  });
  const summary = mod.getAggregationSummary();
  assert.ok(summary.support_draft.fallbacks >= 1);
  ok('30. error/fallback counter increments on provider error');
}

// TEST 31: task counters isolated
{
  const mod = await import('../functions/api/ai-assist.js');
  mod._resetCircuitBreaker();
  mod._resetAdminRateLimit();
  mod._resetAggregation();
  // support_draft call (don't use callAiAssist which resets aggregation)
  const req1 = makeRequest({ task: 'support_draft', input: { customerMessage: 'test' } }, { headers: { Authorization: ADMIN_AUTH } });
  await mod.onRequest({ request: req1, env: { ...BASE_ENV }, fetchImpl: mockFetch({ status: 200, body: SUCCESS_BODY }), createClientImpl: ADMIN_CC });
  // devis_structuring call
  const req2 = makeRequest({ task: 'devis_structuring', input: { customerMessage: 'test' } }, { headers: { Authorization: ADMIN_AUTH } });
  await mod.onRequest({ request: req2, env: { ...BASE_ENV }, fetchImpl: mockFetch({ status: 200, body: DEVIS_SUCCESS_BODY }), createClientImpl: ADMIN_CC });
  const summary = mod.getAggregationSummary();
  assert.strictEqual(summary.support_draft.requests, 1);
  assert.strictEqual(summary.devis_structuring.requests, 1);
  ok('31. task counters isolated');
}

// TEST 32: reset helper test-only
{
  const mod = await import('../functions/api/ai-assist.js');
  mod._resetAggregation();
  const summary1 = mod.getAggregationSummary();
  assert.strictEqual(Object.keys(summary1).length, 0);
  ok('32. reset helper clears aggregation');
}

// TEST 33: avg latency correct
{
  const mod = await import('../functions/api/ai-assist.js');
  mod._resetCircuitBreaker();
  mod._resetAdminRateLimit();
  mod._resetAggregation();
  await callAiAssist({
    body: { task: 'support_draft', input: { customerMessage: 'test' } },
    fetchImpl: mockFetch({ status: 200, body: SUCCESS_BODY }),
    authHeader: ADMIN_AUTH,
  });
  const summary = mod.getAggregationSummary();
  assert.ok(summary.support_draft.avg_latency_ms >= 0);
  ok('33. avg latency correct');
}

// TEST 34: fallback rate correct
{
  const mod = await import('../functions/api/ai-assist.js');
  mod._resetCircuitBreaker();
  mod._resetAdminRateLimit();
  mod._resetAggregation();
  // 1 success
  const req1 = makeRequest({ task: 'support_draft', input: { customerMessage: 'test' } }, { headers: { Authorization: ADMIN_AUTH } });
  await mod.onRequest({ request: req1, env: { ...BASE_ENV }, fetchImpl: mockFetch({ status: 200, body: SUCCESS_BODY }), createClientImpl: ADMIN_CC });
  // 1 fallback (AI disabled)
  const req2 = makeRequest({ task: 'support_draft', input: { customerMessage: 'test' } }, { headers: { Authorization: ADMIN_AUTH } });
  await mod.onRequest({ request: req2, env: { ...BASE_ENV, AI_ENABLED: 'false' }, fetchImpl: mockFetch({ status: 200, body: SUCCESS_BODY }), createClientImpl: ADMIN_CC });
  const summary = mod.getAggregationSummary();
  assert.strictEqual(summary.support_draft.requests, 2);
  assert.strictEqual(summary.support_draft.fallback_rate, 0.5);
  ok('34. fallback rate correct');
}

// ============================================================
// OPS REGRESSION TESTS (35-40)
// ============================================================

// TEST 35: kill switch still works
{
  const { json } = await callAiAssist({
    body: { task: 'support_draft', input: { customerMessage: 'test' } },
    env: { AI_ENABLED: 'false' },
    fetchImpl: mockFetch({ status: 200, body: SUCCESS_BODY }),
    authHeader: ADMIN_AUTH,
  });
  assert.strictEqual(json.meta.fallback_used, true);
  assert.strictEqual(json.meta.ai_disabled, true);
  ok('35. kill switch still works');
}

// TEST 36: admin quota still works
{
  const mod = await import('../functions/api/ai-assist.js');
  mod._resetCircuitBreaker();
  mod._resetAdminRateLimit();
  mod._resetAggregation();
  const trackingFetch = async () => ({ ok: true, status: 200, json: async () => SUCCESS_BODY });
  for (let i = 0; i < 2; i++) {
    const req = makeRequest({ task: 'support_draft', input: { customerMessage: `t${i}` } }, { headers: { Authorization: ADMIN_AUTH } });
    await mod.onRequest({ request: req, env: { ...BASE_ENV, AI_ADMIN_MAX_REQUESTS_PER_MINUTE: '2' }, fetchImpl: trackingFetch, createClientImpl: ADMIN_CC });
  }
  const req3 = makeRequest({ task: 'support_draft', input: { customerMessage: 'over' } }, { headers: { Authorization: ADMIN_AUTH } });
  const res3 = await mod.onRequest({ request: req3, env: { ...BASE_ENV, AI_ADMIN_MAX_REQUESTS_PER_MINUTE: '2' }, fetchImpl: trackingFetch, createClientImpl: ADMIN_CC });
  const json3 = await res3.json();
  assert.strictEqual(res3.status, 429);
  ok('36. admin quota still works');
}

// TEST 37: circuit breaker still works
{
  const mod = await import('../functions/api/ai-assist.js');
  mod._resetCircuitBreaker();
  mod._resetAdminRateLimit();
  mod._resetAggregation();
  const failingFetch = async () => ({ ok: false, status: 500, json: async () => ({}) });
  for (let i = 0; i < 3; i++) {
    const req = makeRequest({ task: 'support_draft', input: { customerMessage: `f${i}` } }, { headers: { Authorization: ADMIN_AUTH } });
    await mod.onRequest({ request: req, env: { ...BASE_ENV, AI_CIRCUIT_FAILURE_THRESHOLD: '3', AI_CIRCUIT_OPEN_MS: '60000' }, fetchImpl: failingFetch, createClientImpl: ADMIN_CC });
  }
  assert.strictEqual(mod.circuitIsOpen(), true);
  ok('37. circuit breaker still works');
}

// TEST 38: support_draft still works
{
  const { json } = await callAiAssist({
    body: { task: 'support_draft', input: { customerMessage: 'test' } },
    fetchImpl: mockFetch({ status: 200, body: SUCCESS_BODY }),
    authHeader: ADMIN_AUTH,
  });
  assert.strictEqual(json.meta.fallback_used, false);
  assert.strictEqual(json.meta.source, 'ai');
  assert.ok(json.output.draft);
  ok('38. support_draft still works');
}

// TEST 39: devis_structuring still works
{
  const { json } = await callAiAssist({
    body: { task: 'devis_structuring', input: { customerMessage: 'test' } },
    fetchImpl: mockFetch({ status: 200, body: DEVIS_SUCCESS_BODY }),
    authHeader: ADMIN_AUTH,
  });
  assert.strictEqual(json.meta.fallback_used, false);
  assert.strictEqual(json.output.vehicle_type, 'car');
  ok('39. devis_structuring still works');
}

// TEST 40: no DB/business mutation
{
  const source = readFileSync(new URL('../functions/api/ai-assist.js', import.meta.url), 'utf8');
  assert.ok(!source.includes('.insert('));
  assert.ok(!source.includes('.update('));
  assert.ok(!source.includes('.delete('));
  assert.ok(!source.includes('.upsert('));
  assert.ok(!source.includes('.from('));
  ok('40. no DB/business mutation');
}

// ============================================================
// ADDITIONAL TESTS
// ============================================================

// TEST 41: ERROR_CATEGORIES is bounded allowlist
{
  const mod = await import('../functions/api/ai-assist.js');
  assert.ok(mod.ERROR_CATEGORIES.has('none'));
  assert.ok(mod.ERROR_CATEGORIES.has('ai_disabled'));
  assert.ok(mod.ERROR_CATEGORIES.has('provider_timeout'));
  assert.ok(mod.ERROR_CATEGORIES.has('output_validation_failed'));
  assert.ok(!mod.ERROR_CATEGORIES.has('random_error'));
  ok('41. ERROR_CATEGORIES is bounded allowlist');
}

// TEST 42: response meta includes usage for admin
{
  const { json } = await callAiAssist({
    body: { task: 'support_draft', input: { customerMessage: 'test' } },
    fetchImpl: mockFetch({ status: 200, body: SUCCESS_BODY }),
    authHeader: ADMIN_AUTH,
  });
  assert.ok(json.meta.usage);
  assert.strictEqual(json.meta.usage.prompt_tokens, 100);
  assert.strictEqual(json.meta.usage.completion_tokens, 50);
  assert.strictEqual(json.meta.usage.total_tokens, 150);
  ok('42. response meta includes usage for admin');
}

// TEST 43: response meta includes estimated_cost_usd when configured
{
  const { json } = await callAiAssist({
    body: { task: 'support_draft', input: { customerMessage: 'test' } },
    env: { AI_COST_INPUT_PER_1M_USD: '10', AI_COST_OUTPUT_PER_1M_USD: '30' },
    fetchImpl: mockFetch({ status: 200, body: SUCCESS_BODY }),
    authHeader: ADMIN_AUTH,
  });
  assert.ok(json.meta.estimated_cost_usd !== undefined);
  // 100/1M * 10 + 50/1M * 30 = 0.001 + 0.0015 = 0.0025
  assert.ok(json.meta.estimated_cost_usd > 0);
  ok('43. response meta includes estimated_cost_usd when configured');
}

// TEST 44: response meta estimated_cost_usd null when not configured
{
  const { json } = await callAiAssist({
    body: { task: 'support_draft', input: { customerMessage: 'test' } },
    fetchImpl: mockFetch({ status: 200, body: SUCCESS_BODY }),
    authHeader: ADMIN_AUTH,
  });
  assert.strictEqual(json.meta.estimated_cost_usd, null);
  ok('44. response meta estimated_cost_usd null when not configured');
}

// TEST 45: telemetry event name is ai_request (not ai_telemetry)
{
  const restore = captureTelemetry();
  await callAiAssist({
    body: { task: 'support_draft', input: { customerMessage: 'test' } },
    fetchImpl: mockFetch({ status: 200, body: SUCCESS_BODY }),
    authHeader: ADMIN_AUTH,
  });
  restore();
  const event = telemetryCaptures.find(e => e.event === 'ai_request');
  assert.ok(event);
  ok('45. telemetry event name is ai_request');
}

// ============================================================
// AI-BOOST-4A.1 — OBSERVABILITY COMPLETENESS FIX TESTS
// ============================================================

// TEST A: aggregation quota — quota_limited counter increments, request count includes it
{
  const mod = await import('../functions/api/ai-assist.js');
  mod._resetCircuitBreaker();
  mod._resetAdminRateLimit();
  mod._resetAggregation();
  const trackingFetch = async () => ({ ok: true, status: 200, json: async () => SUCCESS_BODY });
  // Exhaust quota (limit=2)
  for (let i = 0; i < 2; i++) {
    const req = makeRequest({ task: 'support_draft', input: { customerMessage: `t${i}` } }, { headers: { Authorization: ADMIN_AUTH } });
    await mod.onRequest({ request: req, env: { ...BASE_ENV, AI_ADMIN_MAX_REQUESTS_PER_MINUTE: '2' }, fetchImpl: trackingFetch, createClientImpl: ADMIN_CC });
  }
  // Third request hits quota
  const req3 = makeRequest({ task: 'support_draft', input: { customerMessage: 'over' } }, { headers: { Authorization: ADMIN_AUTH } });
  await mod.onRequest({ request: req3, env: { ...BASE_ENV, AI_ADMIN_MAX_REQUESTS_PER_MINUTE: '2' }, fetchImpl: trackingFetch, createClientImpl: ADMIN_CC });
  const summary = mod.getAggregationSummary();
  assert.strictEqual(summary.support_draft.requests, 3);
  assert.strictEqual(summary.support_draft.quota_limited, 1);
  assert.strictEqual(summary.support_draft.errors, 1);
  ok('A. aggregation quota — quota_limited=1, errors=1, requests=3');
}

// TEST B: aggregation circuit-open — circuit_open + fallbacks increment
{
  const mod = await import('../functions/api/ai-assist.js');
  mod._resetCircuitBreaker();
  mod._resetAdminRateLimit();
  mod._resetAggregation();
  const failingFetch = async () => ({ ok: false, status: 500, json: async () => ({}) });
  // Open circuit with 3 failures
  for (let i = 0; i < 3; i++) {
    const req = makeRequest({ task: 'support_draft', input: { customerMessage: `f${i}` } }, { headers: { Authorization: ADMIN_AUTH } });
    await mod.onRequest({ request: req, env: { ...BASE_ENV, AI_CIRCUIT_FAILURE_THRESHOLD: '3', AI_CIRCUIT_OPEN_MS: '60000' }, fetchImpl: failingFetch, createClientImpl: ADMIN_CC });
  }
  // 4th request blocked by open circuit
  const req4 = makeRequest({ task: 'support_draft', input: { customerMessage: 'blocked' } }, { headers: { Authorization: ADMIN_AUTH } });
  await mod.onRequest({ request: req4, env: { ...BASE_ENV, AI_CIRCUIT_FAILURE_THRESHOLD: '3', AI_CIRCUIT_OPEN_MS: '60000' }, fetchImpl: async () => ({ ok: true, status: 200, json: async () => SUCCESS_BODY }), createClientImpl: ADMIN_CC });
  const summary = mod.getAggregationSummary();
  // 3rd failure opens circuit (records circuit_open), 4th request blocked (records circuit_open)
  assert.ok(summary.support_draft.circuit_open >= 1);
  assert.ok(summary.support_draft.fallbacks >= 4); // 3 error fallbacks + 1 circuit-open fallback
  ok('B. aggregation circuit-open — circuit_open incremented, fallbacks incremented');
}

// TEST C: aggregation invalid config — fallback counter increments
{
  const mod = await import('../functions/api/ai-assist.js');
  mod._resetCircuitBreaker();
  mod._resetAdminRateLimit();
  mod._resetAggregation();
  const req = makeRequest({ task: 'support_draft', input: { customerMessage: 'test' } }, { headers: { Authorization: ADMIN_AUTH } });
  await mod.onRequest({ request: req, env: { ...BASE_ENV, AI_PROVIDER: 'invalid_provider' }, fetchImpl: mockFetch({ status: 200, body: SUCCESS_BODY }), createClientImpl: ADMIN_CC });
  const summary = mod.getAggregationSummary();
  assert.strictEqual(summary.support_draft.requests, 1);
  assert.strictEqual(summary.support_draft.fallbacks, 1);
  ok('C. aggregation invalid config — fallback=1');
}

// TEST D: aggregation no key — fallback counter increments
{
  const mod = await import('../functions/api/ai-assist.js');
  mod._resetCircuitBreaker();
  mod._resetAdminRateLimit();
  mod._resetAggregation();
  const req = makeRequest({ task: 'support_draft', input: { customerMessage: 'test' } }, { headers: { Authorization: ADMIN_AUTH } });
  await mod.onRequest({ request: req, env: { ...BASE_ENV, AI_API_KEY: '' }, fetchImpl: mockFetch({ status: 200, body: SUCCESS_BODY }), createClientImpl: ADMIN_CC });
  const summary = mod.getAggregationSummary();
  assert.strictEqual(summary.support_draft.requests, 1);
  assert.strictEqual(summary.support_draft.fallbacks, 1);
  ok('D. aggregation no key — fallback=1');
}

// TEST E: output validation taxonomy — error_category normalized to output_validation_failed
{
  const restore = captureTelemetry();
  // Send a devis_structuring request with a mock that returns invalid vehicle_type
  const invalidBody = {
    choices: [{ message: { content: JSON.stringify({
      vehicle_type: 'airplane', // invalid enum
      urgency: 'normal',
      pickup_constraints: [],
      delivery_constraints: [],
      special_constraints: [],
      customer_intent: 'quote_request',
      needs_human_review: true,
    }) } }],
    usage: { prompt_tokens: 50, completion_tokens: 20 },
  };
  await callAiAssist({
    body: { task: 'devis_structuring', input: { customerMessage: 'test' } },
    fetchImpl: mockFetch({ status: 200, body: invalidBody }),
    authHeader: ADMIN_AUTH,
  });
  restore();
  const event = telemetryCaptures.find(e => e.task === 'devis_structuring' && e.fallback_used === true);
  assert.ok(event);
  assert.strictEqual(event.error_category, 'output_validation_failed');
  // validation_result retains the internal validator code
  assert.ok(event.validation_result);
  assert.notStrictEqual(event.validation_result, 'output_validation_failed');
  ok('E. output validation taxonomy — error_category=output_validation_failed, validation_result preserves internal code');
}

// TEST F: response partial usage — prompt_tokens=50, completion_tokens=null, total_tokens=null
{
  const partialBody = {
    choices: [{ message: { content: '{"draft":"test","confidence":"low"}' } }],
    usage: { prompt_tokens: 50 }, // no completion_tokens
  };
  const { json } = await callAiAssist({
    body: { task: 'support_draft', input: { customerMessage: 'test' } },
    fetchImpl: mockFetch({ status: 200, body: partialBody }),
    authHeader: ADMIN_AUTH,
  });
  assert.strictEqual(json.meta.usage.prompt_tokens, 50);
  assert.strictEqual(json.meta.usage.completion_tokens, null);
  assert.strictEqual(json.meta.usage.total_tokens, null);
  ok('F. response partial usage — prompt=50, completion=null, total=null');
}

// TEST G: full usage remains 100/50/150
{
  const { json } = await callAiAssist({
    body: { task: 'support_draft', input: { customerMessage: 'test' } },
    fetchImpl: mockFetch({ status: 200, body: SUCCESS_BODY }),
    authHeader: ADMIN_AUTH,
  });
  assert.strictEqual(json.meta.usage.prompt_tokens, 100);
  assert.strictEqual(json.meta.usage.completion_tokens, 50);
  assert.strictEqual(json.meta.usage.total_tokens, 150);
  ok('G. full usage remains 100/50/150');
}

// TEST H: missing usage remains all null
{
  const noUsageBody = {
    choices: [{ message: { content: '{"draft":"test","confidence":"low"}' } }],
  };
  const { json } = await callAiAssist({
    body: { task: 'support_draft', input: { customerMessage: 'test' } },
    fetchImpl: mockFetch({ status: 200, body: noUsageBody }),
    authHeader: ADMIN_AUTH,
  });
  assert.strictEqual(json.meta.usage, null);
  ok('H. missing usage remains all null');
}

// TEST I: aggregation unsupported provider — fallback increments
{
  const mod = await import('../functions/api/ai-assist.js');
  mod._resetCircuitBreaker();
  mod._resetAdminRateLimit();
  mod._resetAggregation();
  const req = makeRequest({ task: 'support_draft', input: { customerMessage: 'test' } }, { headers: { Authorization: ADMIN_AUTH } });
  // parseAiConfig will reject 'invalid_provider' but the double-check path also catches it
  // Use a provider that passes config but fails the SUPPORTED_PROVIDERS check
  await mod.onRequest({ request: req, env: { ...BASE_ENV, AI_PROVIDER: 'unknown_vendor' }, fetchImpl: mockFetch({ status: 200, body: SUCCESS_BODY }), createClientImpl: ADMIN_CC });
  const summary = mod.getAggregationSummary();
  assert.ok(summary.support_draft.fallbacks >= 1);
  ok('I. aggregation unsupported provider — fallback incremented');
}

// TEST J: aggregation secret leak — fallback + error both increment
{
  const mod = await import('../functions/api/ai-assist.js');
  mod._resetCircuitBreaker();
  mod._resetAdminRateLimit();
  mod._resetAggregation();
  const leakKey = 'sk-leak-test-key-1234567890';
  // Mock returns the API key in the output (secret leak)
  const leakBody = {
    choices: [{ message: { content: `{"draft":"${leakKey}","confidence":"low"}` } }],
    usage: { prompt_tokens: 10, completion_tokens: 5 },
  };
  const req = makeRequest({ task: 'support_draft', input: { customerMessage: 'test' } }, { headers: { Authorization: ADMIN_AUTH } });
  await mod.onRequest({ request: req, env: { ...BASE_ENV, AI_API_KEY: leakKey }, fetchImpl: mockFetch({ status: 200, body: leakBody }), createClientImpl: ADMIN_CC });
  const summary = mod.getAggregationSummary();
  assert.strictEqual(summary.support_draft.fallbacks, 1);
  assert.strictEqual(summary.support_draft.errors, 1);
  ok('J. aggregation secret leak — fallback=1, error=1');
}

// ============================================================
// AI-BOOST-4A.2 — PARTIAL USAGE COST SAFETY TESTS
// ============================================================

// TEST K: both token counts + both rates => expected cost
{
  const mod = await import('../functions/api/ai-assist.js');
  const cost = mod.estimateCost(
    { input_tokens: 1000, output_tokens: 500 },
    { costInputPer1mUsd: 10, costOutputPer1mUsd: 30 },
  );
  // 1000/1M * 10 + 500/1M * 30 = 0.01 + 0.015 = 0.025
  assert.strictEqual(cost, 0.025);
  ok('K. both tokens + both rates => expected cost');
}

// TEST L: output missing + both rates => null
{
  const mod = await import('../functions/api/ai-assist.js');
  const cost = mod.estimateCost(
    { input_tokens: 100, output_tokens: null },
    { costInputPer1mUsd: 10, costOutputPer1mUsd: 30 },
  );
  assert.strictEqual(cost, null);
  ok('L. output missing + both rates => null');
}

// TEST M: input missing + both rates => null
{
  const mod = await import('../functions/api/ai-assist.js');
  const cost = mod.estimateCost(
    { input_tokens: null, output_tokens: 50 },
    { costInputPer1mUsd: 10, costOutputPer1mUsd: 30 },
  );
  assert.strictEqual(cost, null);
  ok('M. input missing + both rates => null');
}

// TEST N: usage absent => null
{
  const mod = await import('../functions/api/ai-assist.js');
  assert.strictEqual(mod.estimateCost(null, { costInputPer1mUsd: 10, costOutputPer1mUsd: 30 }), null);
  assert.strictEqual(mod.estimateCost(undefined, { costInputPer1mUsd: 10, costOutputPer1mUsd: 30 }), null);
  ok('N. usage absent => null');
}

// TEST O: input present + only input rate => valid partial estimate
{
  const mod = await import('../functions/api/ai-assist.js');
  const cost = mod.estimateCost(
    { input_tokens: 2000, output_tokens: null },
    { costInputPer1mUsd: 10, costOutputPer1mUsd: null },
  );
  // 2000/1M * 10 = 0.02
  assert.strictEqual(cost, 0.02);
  ok('O. input present + only input rate => valid partial estimate');
}

// TEST P: output present + only output rate => valid partial estimate
{
  const mod = await import('../functions/api/ai-assist.js');
  const cost = mod.estimateCost(
    { input_tokens: null, output_tokens: 1000 },
    { costInputPer1mUsd: null, costOutputPer1mUsd: 30 },
  );
  // 1000/1M * 30 = 0.03
  assert.strictEqual(cost, 0.03);
  ok('P. output present + only output rate => valid partial estimate');
}

// TEST Q: endpoint partial usage + both rates => meta.estimated_cost_usd === null
{
  const partialBody = {
    choices: [{ message: { content: '{"draft":"test","confidence":"low"}' } }],
    usage: { prompt_tokens: 50 }, // no completion_tokens
  };
  const { json } = await callAiAssist({
    body: { task: 'support_draft', input: { customerMessage: 'test' } },
    env: { AI_COST_INPUT_PER_1M_USD: '10', AI_COST_OUTPUT_PER_1M_USD: '30' },
    fetchImpl: mockFetch({ status: 200, body: partialBody }),
    authHeader: ADMIN_AUTH,
  });
  assert.strictEqual(json.meta.estimated_cost_usd, null);
  ok('Q. endpoint partial usage + both rates => estimated_cost_usd=null');
}

// TEST R: endpoint full usage + both rates => cost calculated
{
  const { json } = await callAiAssist({
    body: { task: 'support_draft', input: { customerMessage: 'test' } },
    env: { AI_COST_INPUT_PER_1M_USD: '10', AI_COST_OUTPUT_PER_1M_USD: '30' },
    fetchImpl: mockFetch({ status: 200, body: SUCCESS_BODY }),
    authHeader: ADMIN_AUTH,
  });
  // 100/1M * 10 + 50/1M * 30 = 0.001 + 0.0015 = 0.0025
  assert.ok(json.meta.estimated_cost_usd > 0);
  ok('R. endpoint full usage + both rates => cost calculated');
}

console.log(`\nAll ${passed} AI-BOOST-4A observability tests passed.`);
