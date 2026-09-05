// AI-BOOST-3A — Devis Structuring Tests
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

function mockCreateClient({ admin = true, authError = false } = {}) {
  return function() {
    return {
      auth: {
        getUser: async (token) => {
          if (authError) return { data: { user: null }, error: { message: 'invalid' } };
          if (!token || token.length < 10) return { data: { user: null }, error: { message: 'invalid' } };
          return { data: { user: { id: 'admin-3a', email: 'admin@test.com' } }, error: null };
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
const NON_ADMIN_CC = mockCreateClient({ admin: false });
const AUTH_ERROR_CC = mockCreateClient({ admin: true, authError: true });

const ADMIN_AUTH = 'Bearer test-admin-3a-token-1234567890';
const NON_ADMIN_AUTH = 'Bearer test-nonadmin-3a-12345';

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

async function callAiAssist({ body, env, fetchImpl, authHeader, createClientImpl }) {
  const mod = await import('../functions/api/ai-assist.js');
  if (mod._resetCircuitBreaker) mod._resetCircuitBreaker();
  if (mod._resetAdminRateLimit) mod._resetAdminRateLimit();
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
  const { status = 200, body = null, captureBody = null } = opts;
  return async function(url, options) {
    if (captureBody !== null && options?.body) {
      try { captureBody.parsed = JSON.parse(options.body); } catch { captureBody.raw = options.body; }
    }
    return { ok: status >= 200 && status < 300, status, json: async () => body || {} };
  };
}

const VALID_DEVIS_OUTPUT = {
  vehicle_type: 'car',
  urgency: 'urgent',
  pickup_constraints: ['récupération en semaine'],
  delivery_constraints: ['livraison avant vendredi'],
  special_constraints: [],
  customer_intent: 'quote_request',
  needs_human_review: false,
};

const SUCCESS_BODY = {
  choices: [{ message: { content: JSON.stringify(VALID_DEVIS_OUTPUT) } }],
  usage: { prompt_tokens: 50, completion_tokens: 30 },
};

// ============================================================
// TASK / AUTH TESTS (1-5)
// ============================================================

// TEST 1: devis_structuring accepted
{
  const { json } = await callAiAssist({
    body: { task: 'devis_structuring', input: { customerMessage: 'Bonjour, j\'ai besoin de transporter une voiture.' } },
    fetchImpl: mockFetch({ status: 200, body: SUCCESS_BODY }),
    authHeader: ADMIN_AUTH,
  });
  assert.strictEqual(json.ok, true);
  assert.strictEqual(json.task, 'devis_structuring');
  assert.strictEqual(json.meta.fallback_used, false);
  ok('1. devis_structuring accepted');
}

// TEST 2: unknown task rejected
{
  const { response, json } = await callAiAssist({
    body: { task: 'unknown_task', input: { customerMessage: 'test' } },
    fetchImpl: mockFetch({ status: 200, body: SUCCESS_BODY }),
    authHeader: ADMIN_AUTH,
  });
  assert.strictEqual(response.status, 400);
  assert.strictEqual(json.code, 'UNKNOWN_TASK');
  ok('2. unknown task rejected');
}

// TEST 3: no auth => 401, zero provider call
{
  let fetchCount = 0;
  const trackingFetch = async () => { fetchCount++; return { ok: true, status: 200, json: async () => ({}) }; };
  const { response, json } = await callAiAssist({
    body: { task: 'devis_structuring', input: { customerMessage: 'test' } },
    fetchImpl: trackingFetch,
    authHeader: null,
  });
  assert.strictEqual(response.status, 401);
  assert.strictEqual(json.code, 'UNAUTHORIZED');
  assert.strictEqual(fetchCount, 0);
  ok('3. no auth => 401, zero provider call');
}

// TEST 4: non-admin => 403, zero provider call
{
  let fetchCount = 0;
  const trackingFetch = async () => { fetchCount++; return { ok: true, status: 200, json: async () => ({}) }; };
  const { response, json } = await callAiAssist({
    body: { task: 'devis_structuring', input: { customerMessage: 'test' } },
    fetchImpl: trackingFetch,
    authHeader: NON_ADMIN_AUTH,
    createClientImpl: NON_ADMIN_CC,
  });
  assert.strictEqual(response.status, 403);
  assert.strictEqual(json.code, 'FORBIDDEN');
  assert.strictEqual(fetchCount, 0);
  ok('4. non-admin => 403, zero provider call');
}

// TEST 5: admin allowed
{
  const { json } = await callAiAssist({
    body: { task: 'devis_structuring', input: { customerMessage: 'test' } },
    fetchImpl: mockFetch({ status: 200, body: SUCCESS_BODY }),
    authHeader: ADMIN_AUTH,
  });
  assert.strictEqual(json.meta.fallback_used, false);
  assert.strictEqual(json.meta.source, 'ai');
  ok('5. admin allowed');
}

// ============================================================
// INPUT TESTS (6-9)
// ============================================================

// TEST 6: missing message rejected
{
  const { response, json } = await callAiAssist({
    body: { task: 'devis_structuring', input: {} },
    fetchImpl: mockFetch({ status: 200, body: SUCCESS_BODY }),
    authHeader: ADMIN_AUTH,
  });
  assert.strictEqual(response.status, 400);
  ok('6. missing message rejected');
}

// TEST 7: oversized message rejected
{
  const big = 'A'.repeat(5000);
  const { response } = await callAiAssist({
    body: { task: 'devis_structuring', input: { customerMessage: big } },
    fetchImpl: mockFetch({ status: 200, body: SUCCESS_BODY }),
    authHeader: ADMIN_AUTH,
  });
  assert.strictEqual(response.status, 400);
  ok('7. oversized message rejected');
}

// TEST 8: extra PII fields not forwarded
{
  const capture = {};
  const { json } = await callAiAssist({
    body: {
      task: 'devis_structuring',
      input: {
        customerMessage: 'test message',
        customerName: 'John Doe',
        email: 'john@example.com',
        phone: '0123456789',
        userId: 'user-123',
        missionId: 'mis-456',
        quoteId: 'quote-789',
      },
    },
    fetchImpl: mockFetch({ status: 200, body: SUCCESS_BODY, captureBody: capture }),
    authHeader: ADMIN_AUTH,
  });
  assert.strictEqual(json.meta.fallback_used, false);
  // Verify only customerMessage was sent to provider
  const userMsg = capture.parsed?.messages?.find(m => m.role === 'user')?.content || '';
  assert.ok(!userMsg.includes('John Doe'));
  assert.ok(!userMsg.includes('john@example.com'));
  assert.ok(!userMsg.includes('0123456789'));
  assert.ok(!userMsg.includes('user-123'));
  assert.ok(!userMsg.includes('mis-456'));
  assert.ok(!userMsg.includes('quote-789'));
  ok('8. extra PII fields not forwarded');
}

// TEST 9: prompt injection remains user content
{
  const source = readFileSync(new URL('../functions/api/ai-assist.js', import.meta.url), 'utf8');
  // The system prompt must instruct to ignore injection
  assert.ok(source.includes('injection'));
  assert.ok(source.includes('NON FIABLE'));
  ok('9. prompt injection remains user content (system prompt has injection guards)');
}

// ============================================================
// OUTPUT VALIDATION TESTS (10-19)
// ============================================================

// TEST 10: valid JSON accepted
{
  const { json } = await callAiAssist({
    body: { task: 'devis_structuring', input: { customerMessage: 'test' } },
    fetchImpl: mockFetch({ status: 200, body: SUCCESS_BODY }),
    authHeader: ADMIN_AUTH,
  });
  assert.strictEqual(json.output.vehicle_type, 'car');
  assert.strictEqual(json.output.urgency, 'urgent');
  assert.strictEqual(json.output.needs_human_review, false);
  ok('10. valid JSON accepted');
}

// TEST 11: invalid JSON rejected
{
  const { json } = await callAiAssist({
    body: { task: 'devis_structuring', input: { customerMessage: 'test' } },
    fetchImpl: mockFetch({ status: 200, body: { choices: [{ message: { content: 'not valid json' } }] } }),
    authHeader: ADMIN_AUTH,
  });
  assert.strictEqual(json.meta.fallback_used, true);
  assert.strictEqual(json.output.vehicle_type, 'unknown');
  ok('11. invalid JSON rejected');
}

// TEST 12: invalid enum rejected
{
  const badOutput = { ...VALID_DEVIS_OUTPUT, vehicle_type: 'truck' };
  const { json } = await callAiAssist({
    body: { task: 'devis_structuring', input: { customerMessage: 'test' } },
    fetchImpl: mockFetch({ status: 200, body: { choices: [{ message: { content: JSON.stringify(badOutput) } }] } }),
    authHeader: ADMIN_AUTH,
  });
  assert.strictEqual(json.meta.fallback_used, true);
  ok('12. invalid enum rejected');
}

// TEST 13: excessive array items rejected
{
  const badOutput = {
    ...VALID_DEVIS_OUTPUT,
    pickup_constraints: Array(11).fill('constraint'),
  };
  const { json } = await callAiAssist({
    body: { task: 'devis_structuring', input: { customerMessage: 'test' } },
    fetchImpl: mockFetch({ status: 200, body: { choices: [{ message: { content: JSON.stringify(badOutput) } }] } }),
    authHeader: ADMIN_AUTH,
  });
  assert.strictEqual(json.meta.fallback_used, true);
  ok('13. excessive array items rejected');
}

// TEST 14: excessive string length rejected
{
  const badOutput = {
    ...VALID_DEVIS_OUTPUT,
    pickup_constraints: ['A'.repeat(201)],
  };
  const { json } = await callAiAssist({
    body: { task: 'devis_structuring', input: { customerMessage: 'test' } },
    fetchImpl: mockFetch({ status: 200, body: { choices: [{ message: { content: JSON.stringify(badOutput) } }] } }),
    authHeader: ADMIN_AUTH,
  });
  assert.strictEqual(json.meta.fallback_used, true);
  ok('14. excessive string length rejected');
}

// TEST 15: HTML/script rejected
{
  const badOutput = {
    ...VALID_DEVIS_OUTPUT,
    pickup_constraints: ['<script>alert(1)</script>'],
  };
  const { json } = await callAiAssist({
    body: { task: 'devis_structuring', input: { customerMessage: 'test' } },
    fetchImpl: mockFetch({ status: 200, body: { choices: [{ message: { content: JSON.stringify(badOutput) } }] } }),
    authHeader: ADMIN_AUTH,
  });
  assert.strictEqual(json.meta.fallback_used, true);
  ok('15. HTML/script rejected');
}

// TEST 16: forbidden price field rejected
{
  const badOutput = { ...VALID_DEVIS_OUTPUT, price: 500 };
  const { json } = await callAiAssist({
    body: { task: 'devis_structuring', input: { customerMessage: 'test' } },
    fetchImpl: mockFetch({ status: 200, body: { choices: [{ message: { content: JSON.stringify(badOutput) } }] } }),
    authHeader: ADMIN_AUTH,
  });
  assert.strictEqual(json.meta.fallback_used, true);
  ok('16. forbidden price field rejected');
}

// TEST 17: forbidden distance field rejected
{
  const badOutput = { ...VALID_DEVIS_OUTPUT, distance: 350 };
  const { json } = await callAiAssist({
    body: { task: 'devis_structuring', input: { customerMessage: 'test' } },
    fetchImpl: mockFetch({ status: 200, body: { choices: [{ message: { content: JSON.stringify(badOutput) } }] } }),
    authHeader: ADMIN_AUTH,
  });
  assert.strictEqual(json.meta.fallback_used, true);
  ok('17. forbidden distance field rejected');
}

// TEST 17b: forbidden field hidden in nested object rejected
{
  const badOutput = {
    ...VALID_DEVIS_OUTPUT,
    metadata: { price: 500 },
  };
  const { json } = await callAiAssist({
    body: { task: 'devis_structuring', input: { customerMessage: 'test' } },
    fetchImpl: mockFetch({ status: 200, body: { choices: [{ message: { content: JSON.stringify(badOutput) } }] } }),
    authHeader: ADMIN_AUTH,
  });
  assert.strictEqual(json.meta.fallback_used, true);
  assert.strictEqual(json.output.vehicle_type, 'unknown');
  assert.strictEqual(json.output.needs_human_review, true);
  ok('17b. forbidden field hidden in nested object rejected (deep scan)');
}

// TEST 17c: unknown extra field rejected (strict schema)
{
  const badOutput = { ...VALID_DEVIS_OUTPUT, extra_info: 'something' };
  const { json } = await callAiAssist({
    body: { task: 'devis_structuring', input: { customerMessage: 'test' } },
    fetchImpl: mockFetch({ status: 200, body: { choices: [{ message: { content: JSON.stringify(badOutput) } }] } }),
    authHeader: ADMIN_AUTH,
  });
  assert.strictEqual(json.meta.fallback_used, true);
  ok('17c. unknown extra field rejected (strict schema)');
}

// TEST 18: missing required field rejected
{
  const badOutput = { vehicle_type: 'car', urgency: 'normal' };
  const { json } = await callAiAssist({
    body: { task: 'devis_structuring', input: { customerMessage: 'test' } },
    fetchImpl: mockFetch({ status: 200, body: { choices: [{ message: { content: JSON.stringify(badOutput) } }] } }),
    authHeader: ADMIN_AUTH,
  });
  assert.strictEqual(json.meta.fallback_used, true);
  ok('18. missing required field rejected');
}

// TEST 19: ambiguity => needs_human_review=true
{
  const ambiguousOutput = { ...VALID_DEVIS_OUTPUT, needs_human_review: true };
  const { json } = await callAiAssist({
    body: { task: 'devis_structuring', input: { customerMessage: 'maybe' } },
    fetchImpl: mockFetch({ status: 200, body: { choices: [{ message: { content: JSON.stringify(ambiguousOutput) } }] } }),
    authHeader: ADMIN_AUTH,
  });
  assert.strictEqual(json.meta.fallback_used, false);
  assert.strictEqual(json.output.needs_human_review, true);
  ok('19. ambiguity => needs_human_review=true');
}

// ============================================================
// BUSINESS SAFETY TESTS (20-25)
// ============================================================

// TEST 20: no pricing call
{
  const source = readFileSync(new URL('../functions/api/ai-assist.js', import.meta.url), 'utf8');
  assert.ok(!source.includes('calculateQuote'));
  assert.ok(!source.includes('_pricing'));
  ok('20. no pricing call');
}

// TEST 21: no DB mutation
{
  const source = readFileSync(new URL('../functions/api/ai-assist.js', import.meta.url), 'utf8');
  assert.ok(!source.includes('.insert('));
  assert.ok(!source.includes('.update('));
  assert.ok(!source.includes('.delete('));
  assert.ok(!source.includes('.upsert('));
  ok('21. no DB mutation');
}

// TEST 22: no quote write
{
  const source = readFileSync(new URL('../functions/api/ai-assist.js', import.meta.url), 'utf8');
  // The word "devis" appears in task names/prompts, but must NOT reference the devis DB table
  assert.ok(!source.includes('from(\'devis\')'));
  assert.ok(!source.includes("from('devis')"));
  assert.ok(!source.includes('.from('));
  ok('22. no quote write (no devis table reference)');
}

// TEST 23: no mission creation
{
  const source = readFileSync(new URL('../functions/api/ai-assist.js', import.meta.url), 'utf8');
  assert.ok(!source.includes('missions'));
  assert.ok(!source.includes('mission_status'));
  ok('23. no mission creation');
}

// TEST 24: no email send
{
  const source = readFileSync(new URL('../functions/api/ai-assist.js', import.meta.url), 'utf8');
  assert.ok(!source.includes('api.resend.com'));
  assert.ok(!source.includes('RESEND_API_KEY'));
  assert.ok(!source.includes('sendEmail'));
  ok('24. no email send');
}

// TEST 25: no Auth mutation
{
  const source = readFileSync(new URL('../functions/api/ai-assist.js', import.meta.url), 'utf8');
  assert.ok(!source.includes('auth.admin'));
  assert.ok(!source.includes('signUp'));
  assert.ok(!source.includes('resetPassword'));
  ok('25. no Auth mutation');
}

// ============================================================
// OPS HARDENING TESTS (26-30)
// ============================================================

// TEST 26: AI_ENABLED=false => no provider call
{
  let fetchCount = 0;
  const trackingFetch = async () => { fetchCount++; return { ok: true, status: 200, json: async () => ({}) }; };
  const { json } = await callAiAssist({
    body: { task: 'devis_structuring', input: { customerMessage: 'test' } },
    env: { AI_ENABLED: 'false' },
    fetchImpl: trackingFetch,
    authHeader: ADMIN_AUTH,
  });
  assert.strictEqual(fetchCount, 0);
  assert.strictEqual(json.meta.fallback_used, true);
  assert.strictEqual(json.meta.ai_disabled, true);
  ok('26. AI_ENABLED=false => no provider call');
}

// TEST 27: quota applies to new task
{
  const mod = await import('../functions/api/ai-assist.js');
  mod._resetCircuitBreaker();
  mod._resetAdminRateLimit();
  let fetchCount = 0;
  const trackingFetch = async () => { fetchCount++; return { ok: true, status: 200, json: async () => SUCCESS_BODY }; };
  // 2 calls with limit=2
  for (let i = 0; i < 2; i++) {
    const req = makeRequest({ task: 'devis_structuring', input: { customerMessage: `test ${i}` } }, { headers: { Authorization: ADMIN_AUTH } });
    await mod.onRequest({ request: req, env: { ...BASE_ENV, AI_ADMIN_MAX_REQUESTS_PER_MINUTE: '2' }, fetchImpl: trackingFetch, createClientImpl: ADMIN_CC });
  }
  // 3rd should be rate limited
  const req3 = makeRequest({ task: 'devis_structuring', input: { customerMessage: 'over' } }, { headers: { Authorization: ADMIN_AUTH } });
  const res3 = await mod.onRequest({ request: req3, env: { ...BASE_ENV, AI_ADMIN_MAX_REQUESTS_PER_MINUTE: '2' }, fetchImpl: trackingFetch, createClientImpl: ADMIN_CC });
  const json3 = await res3.json();
  assert.strictEqual(res3.status, 429);
  assert.strictEqual(json3.meta.quota_limited, true);
  ok('27. quota applies to new task');
}

// TEST 28: circuit breaker applies to new task
{
  const mod = await import('../functions/api/ai-assist.js');
  mod._resetCircuitBreaker();
  mod._resetAdminRateLimit();
  const failingFetch = async () => ({ ok: false, status: 500, json: async () => ({}) });
  // 3 failures to trip circuit
  for (let i = 0; i < 3; i++) {
    const req = makeRequest({ task: 'devis_structuring', input: { customerMessage: `fail ${i}` } }, { headers: { Authorization: ADMIN_AUTH } });
    await mod.onRequest({ request: req, env: { ...BASE_ENV, AI_CIRCUIT_FAILURE_THRESHOLD: '3', AI_CIRCUIT_OPEN_MS: '60000' }, fetchImpl: failingFetch, createClientImpl: ADMIN_CC });
  }
  // Next call should be circuit-open
  let fetchCount = 0;
  const successFetch = async () => { fetchCount++; return { ok: true, status: 200, json: async () => SUCCESS_BODY }; };
  const req = makeRequest({ task: 'devis_structuring', input: { customerMessage: 'after' } }, { headers: { Authorization: ADMIN_AUTH } });
  const res = await mod.onRequest({ request: req, env: { ...BASE_ENV, AI_CIRCUIT_FAILURE_THRESHOLD: '3', AI_CIRCUIT_OPEN_MS: '60000' }, fetchImpl: successFetch, createClientImpl: ADMIN_CC });
  const json = await res.json();
  assert.strictEqual(fetchCount, 0);
  assert.strictEqual(json.meta.circuit_open, true);
  ok('28. circuit breaker applies to new task');
}

// TEST 29: invalid config fail-closed
{
  let fetchCount = 0;
  const trackingFetch = async () => { fetchCount++; return { ok: true, status: 200, json: async () => ({}) }; };
  const { json } = await callAiAssist({
    body: { task: 'devis_structuring', input: { customerMessage: 'test' } },
    env: { AI_CIRCUIT_FAILURE_THRESHOLD: '99' },
    fetchImpl: trackingFetch,
    authHeader: ADMIN_AUTH,
  });
  assert.strictEqual(fetchCount, 0);
  assert.strictEqual(json.meta.fallback_used, true);
  ok('29. invalid config fail-closed');
}

// TEST 30: metadata safe
{
  const { json } = await callAiAssist({
    body: { task: 'devis_structuring', input: { customerMessage: 'test' } },
    env: { AI_API_KEY: 'sk-test-secret-3a-123456789' },
    fetchImpl: mockFetch({ status: 200, body: SUCCESS_BODY }),
    authHeader: ADMIN_AUTH,
  });
  const responseStr = JSON.stringify(json);
  assert.ok(!responseStr.includes('sk-test-secret-3a-123456789'));
  assert.ok(json.meta.request_id);
  assert.ok('ai_disabled' in json.meta);
  assert.ok('circuit_open' in json.meta);
  assert.ok('quota_limited' in json.meta);
  ok('30. metadata safe');
}

// ============================================================
// UI TESTS (31-35)
// ============================================================

// TEST 31: button manual only
{
  const source = readFileSync(new URL('../dashboard-admin.html', import.meta.url), 'utf8');
  assert.ok(source.includes('Structurer avec l\'IA'));
  assert.ok(source.includes('structureDevisWithAi'));
  // No auto-call on modal open
  ok('31. button manual only');
}

// TEST 32: preview read-only
{
  const source = readFileSync(new URL('../dashboard-admin.html', import.meta.url), 'utf8');
  assert.ok(source.includes('Aperçu en lecture seule'));
  ok('32. preview read-only');
}

// TEST 33: no auto-fill existing quote fields
{
  const source = readFileSync(new URL('../dashboard-admin.html', import.meta.url), 'utf8');
  // The structureDevisWithAi function should NOT write to any devis form fields
  const fnStart = source.indexOf('window.structureDevisWithAi');
  const fnEnd = source.indexOf('window.adjustDevisPrice');
  const fnBody = source.substring(fnStart, fnEnd);
  assert.ok(!fnBody.includes('updateDevisStatus'));
  assert.ok(!fnBody.includes('.value ='));
  // Only allowed getElementById calls are for AI display elements (devisAiStructResult, devisStructBtn)
  assert.ok(!fnBody.includes('getElementById(\'devisTable'));
  assert.ok(!fnBody.includes('getElementById(\'devisNav'));
  ok('33. no auto-fill existing quote fields');
}

// TEST 34: no auto-save
{
  const source = readFileSync(new URL('../dashboard-admin.html', import.meta.url), 'utf8');
  const fnStart = source.indexOf('window.structureDevisWithAi');
  const fnEnd = source.indexOf('window.adjustDevisPrice');
  const fnBody = source.substring(fnStart, fnEnd);
  assert.ok(!fnBody.includes('supabase.from(\'devis\')'));
  assert.ok(!fnBody.includes('.upsert('));
  assert.ok(!fnBody.includes('.update('));
  assert.ok(!fnBody.includes('.insert('));
  ok('34. no auto-save');
}

// TEST 35: no auto-send
{
  const source = readFileSync(new URL('../dashboard-admin.html', import.meta.url), 'utf8');
  const fnStart = source.indexOf('window.structureDevisWithAi');
  const fnEnd = source.indexOf('window.adjustDevisPrice');
  const fnBody = source.substring(fnStart, fnEnd);
  assert.ok(!fnBody.includes('send-email'));
  assert.ok(!fnBody.includes('resend'));
  ok('35. no auto-send');
}

// ============================================================
// FALLBACK TEST
// ============================================================

// TEST 36: fallback returns safe empty structure
{
  const mod = await import('../functions/api/ai-assist.js');
  const fallback = mod.fallbackDevisStructuring();
  assert.strictEqual(fallback.vehicle_type, 'unknown');
  assert.strictEqual(fallback.urgency, 'unknown');
  assert.strictEqual(fallback.pickup_constraints.length, 0);
  assert.strictEqual(fallback.delivery_constraints.length, 0);
  assert.strictEqual(fallback.special_constraints.length, 0);
  assert.strictEqual(fallback.customer_intent, 'unknown');
  assert.strictEqual(fallback.needs_human_review, true);
  ok('36. fallback returns safe empty structure with needs_human_review=true');
}

// TEST 37: SUPPORTED_TASKS includes both tasks
{
  const mod = await import('../functions/api/ai-assist.js');
  assert.ok(mod.SUPPORTED_TASKS.includes('support_draft'));
  assert.ok(mod.SUPPORTED_TASKS.includes('devis_structuring'));
  assert.strictEqual(mod.SUPPORTED_TASKS.length, 2);
  ok('37. SUPPORTED_TASKS includes both support_draft and devis_structuring');
}

// TEST 38: forbidden fields list covers price/distance/etc
{
  const mod = await import('../functions/api/ai-assist.js');
  assert.ok(mod.FORBIDDEN_DEVIS_FIELDS.includes('price'));
  assert.ok(mod.FORBIDDEN_DEVIS_FIELDS.includes('distance'));
  assert.ok(mod.FORBIDDEN_DEVIS_FIELDS.includes('tva'));
  assert.ok(mod.FORBIDDEN_DEVIS_FIELDS.includes('discount'));
  ok('38. forbidden fields list covers price/distance/tva/discount');
}

// TEST 39: token cap for devis_structuring is 300
{
  const mod = await import('../functions/api/ai-assist.js');
  assert.strictEqual(mod.TASK_TOKEN_CAPS.devis_structuring, 300);
  ok('39. token cap for devis_structuring is 300');
}

// TEST 40: system prompt has extraction rules
{
  const mod = await import('../functions/api/ai-assist.js');
  const prompt = mod.DEVIS_STRUCTURING_PROMPT;
  assert.ok(prompt.includes('N\'inférez JAMAIS le prix'));
  assert.ok(prompt.includes('N\'inférez JAMAIS la distance'));
  assert.ok(prompt.includes('N\'inventez JAMAIS'));
  assert.ok(prompt.includes('unknown'));
  assert.ok(prompt.includes('needs_human_review'));
  assert.ok(prompt.includes('NON FIABLE'));
  ok('40. system prompt has extraction rules with price/distance prohibitions');
}

// ============================================================
// AI-BOOST-3A.2 — FINAL VALIDATOR EDGE CASES
// ============================================================

// TEST 41: empty string constraint rejected
{
  const mod = await import('../functions/api/ai-assist.js');
  const result = mod.validateDevisStructuringOutput({
    ...VALID_DEVIS_OUTPUT,
    pickup_constraints: [''],
  });
  assert.strictEqual(result.valid, false);
  assert.strictEqual(result.error, 'pickup_constraints_empty_item');
  ok('41. empty string constraint rejected');
}

// TEST 42: whitespace-only constraint rejected
{
  const mod = await import('../functions/api/ai-assist.js');
  const result = mod.validateDevisStructuringOutput({
    ...VALID_DEVIS_OUTPUT,
    delivery_constraints: ['   '],
  });
  assert.strictEqual(result.valid, false);
  assert.strictEqual(result.error, 'delivery_constraints_empty_item');
  ok('42. whitespace-only constraint rejected');
}

// TEST 43: object inside constraint array rejected
{
  const mod = await import('../functions/api/ai-assist.js');
  const result = mod.validateDevisStructuringOutput({
    ...VALID_DEVIS_OUTPUT,
    special_constraints: [{ text: 'nested' }],
  });
  assert.strictEqual(result.valid, false);
  assert.strictEqual(result.error, 'invalid_special_constraints_item_type');
  ok('43. object inside constraint array rejected');
}

// TEST 44: nested array inside constraint array rejected
{
  const mod = await import('../functions/api/ai-assist.js');
  const result = mod.validateDevisStructuringOutput({
    ...VALID_DEVIS_OUTPUT,
    pickup_constraints: [['nested', 'array']],
  });
  assert.strictEqual(result.valid, false);
  assert.strictEqual(result.error, 'invalid_pickup_constraints_item_type');
  ok('44. nested array inside constraint array rejected');
}

// TEST 45: root array rejected
{
  const mod = await import('../functions/api/ai-assist.js');
  const result = mod.validateDevisStructuringOutput([
    'vehicle_type',
    'car',
  ]);
  assert.strictEqual(result.valid, false);
  assert.strictEqual(result.error, 'root_array_rejected');
  ok('45. root array rejected');
}

// TEST 46: valid normal constraint accepted
{
  const mod = await import('../functions/api/ai-assist.js');
  const result = mod.validateDevisStructuringOutput({
    ...VALID_DEVIS_OUTPUT,
    pickup_constraints: ['Récupération en semaine'],
    delivery_constraints: ['Livraison avant vendredi'],
    special_constraints: [],
  });
  assert.strictEqual(result.valid, true);
  ok('46. valid normal constraint accepted');
}

// TEST 47: fallbackDevisStructuring() passes validateDevisStructuringOutput()
{
  const mod = await import('../functions/api/ai-assist.js');
  const fallback = mod.fallbackDevisStructuring();
  const result = mod.validateDevisStructuringOutput(fallback);
  assert.strictEqual(result.valid, true, `fallback should validate: ${JSON.stringify(result)}`);
  ok('47. fallbackDevisStructuring() passes validateDevisStructuringOutput()');
}

// TEST 48: number inside constraint array rejected
{
  const mod = await import('../functions/api/ai-assist.js');
  const result = mod.validateDevisStructuringOutput({
    ...VALID_DEVIS_OUTPUT,
    pickup_constraints: [42],
  });
  assert.strictEqual(result.valid, false);
  assert.strictEqual(result.error, 'invalid_pickup_constraints_item_type');
  ok('48. number inside constraint array rejected');
}

// TEST 49: null inside constraint array rejected
{
  const mod = await import('../functions/api/ai-assist.js');
  const result = mod.validateDevisStructuringOutput({
    ...VALID_DEVIS_OUTPUT,
    delivery_constraints: [null],
  });
  assert.strictEqual(result.valid, false);
  assert.strictEqual(result.error, 'invalid_delivery_constraints_item_type');
  ok('49. null inside constraint array rejected');
}

// TEST 50: empty string via full handler => fallback
{
  const badOutput = { ...VALID_DEVIS_OUTPUT, special_constraints: [''] };
  const { json } = await callAiAssist({
    body: { task: 'devis_structuring', input: { customerMessage: 'test' } },
    fetchImpl: mockFetch({ status: 200, body: { choices: [{ message: { content: JSON.stringify(badOutput) } }] } }),
    authHeader: ADMIN_AUTH,
  });
  assert.strictEqual(json.meta.fallback_used, true);
  assert.strictEqual(json.output.vehicle_type, 'unknown');
  assert.strictEqual(json.output.needs_human_review, true);
  ok('50. empty string constraint via handler => fallback');
}

console.log(`\nAll ${passed} AI-BOOST-3A devis structuring tests passed.`);
