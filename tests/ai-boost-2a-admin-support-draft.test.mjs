// AI-BOOST-2A — Admin-Gated AI Gateway Tests
//
// Tests cover:
// AUTHORIZATION:
// 1. no auth header => 401, zero provider calls
// 2. invalid token => 401, zero provider calls
// 3. expired/invalid session => 401, zero provider calls
// 4. authenticated non-admin => 403, zero provider calls
// 5. authenticated admin => provider call allowed
// 6. role supplied by client body cannot bypass server auth
//
// SECRET / SECURITY:
// 7. API key never reaches browser
// 8. API key never appears in response
// 9. raw provider error never exposed
// 10. auth token never logged
// 11. customer message never logged
// 12. no service-role secret in frontend
//
// PII:
// 13. only customerMessage sent to provider
// 14. name/email/phone/address/ref excluded
//
// BUSINESS BOUNDARIES:
// 15. no pricing mutation
// 16. no mission-state mutation
// 17. no DB mutation from AI feature
// 18. no email send
// 19. no Auth mutation
//
// AI FOUNDATION (regression):
// 20. MAX_DRAFT_LEN = 200
// 21. default model = gpt-5.6-luna
// 22. SUPPORTED_PROVIDERS = openai, openrouter
// 23. invalid provider => no fetch, fallback
// 24. OpenAI contract: max_completion_tokens, no temperature, reasoning_effort
// 25. OpenRouter contract: max_tokens, temperature, no response_format
// 26. fallback draft <= 200 chars
// 27. UTF-8 byte counting
// 28. structured output validation
// 29. HTML rejection
// 30. system prompt injection constraints
// 31. INVALID_JSON for malformed/empty/whitespace
// 32. meta.fallback_used and meta.source on all responses

import assert from 'assert';
import { readFileSync } from 'fs';

let passed = 0;
let testIpCounter = 0;
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
            data: {
              user: {
                id: 'test-user-id-123',
                email: 'admin@test.com',
              },
            },
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

// ============================================================
// HELPERS
// ============================================================

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
    headers: {
      get: (name) => headers.get(name.toLowerCase()) || null,
    },
    text: async () => typeof body === 'string' ? body : JSON.stringify(body),
    url: 'https://www.bathily-convoyage.fr/api/ai-assist',
  };
}

function makeContext({ body, env, fetchImpl, rawText, authHeader, createClientImpl } = {}) {
  const req = makeRequest(body, authHeader ? { headers: { Authorization: authHeader } } : {});
  if (rawText !== undefined) {
    req.text = async () => rawText;
  }
  return {
    request: req,
    env: env || {},
    fetchImpl: fetchImpl || null,
    createClientImpl: createClientImpl || null,
  };
}

async function callAiAssist({ body, env, fetchImpl, rawText, authHeader, createClientImpl }) {
  const mod = await import('../functions/api/ai-assist.js');
  // Reset circuit breaker and admin rate limiter before each call
  if (mod._resetCircuitBreaker) mod._resetCircuitBreaker();
  if (mod._resetAdminRateLimit) mod._resetAdminRateLimit();
  const ctx = makeContext({ body, env, fetchImpl, rawText, authHeader, createClientImpl });
  const response = await mod.onRequest(ctx);
  const json = await response.json();
  return { response, json };
}

function mockFetch(opts = {}) {
  const {
    status = 200,
    body = null,
    delay = 0,
    shouldAbort = false,
    captureBody = null,
    captureUrl = null,
  } = opts;

  return async function(url, options) {
    if (shouldAbort) {
      const err = new Error('Aborted');
      err.name = 'AbortError';
      throw err;
    }

    if (delay > 0) {
      await new Promise(r => setTimeout(r, delay));
    }

    if (captureUrl !== null) {
      captureUrl.value = url;
    }

    if (captureBody !== null && options?.body) {
      try {
        captureBody.parsed = JSON.parse(options.body);
      } catch {
        captureBody.raw = options.body;
      }
    }

    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => body || {},
    };
  };
}

const ADMIN_AUTH = 'Bearer test-admin-token-1234567890';
const NON_ADMIN_AUTH = 'Bearer test-nonadmin-token-1234567890';
const ADMIN_CC = mockCreateClient({ admin: true });
const NON_ADMIN_CC = mockCreateClient({ admin: false });
const AUTH_ERROR_CC = mockCreateClient({ admin: true, authError: true });
const ADMIN_CHECK_ERROR_CC = mockCreateClient({ admin: true, adminCheckError: true });

const ADMIN_ENV = {
  SUPABASE_URL: 'https://test.supabase.co',
  SUPABASE_ANON_KEY: 'test-anon-key',
  AI_ENABLED: 'true',
  AI_ADMIN_MAX_REQUESTS_PER_MINUTE: '30',
};

// ============================================================
// AUTHORIZATION TESTS
// ============================================================

// TEST 1: No auth header => 401, zero provider calls
{
  let fetchCount = 0;
  const trackingFetch = async () => { fetchCount++; return { ok: true, status: 200, json: async () => ({}) }; };

  const { response, json } = await callAiAssist({
    body: { task: 'support_draft', input: { customerMessage: 'Test no auth' } },
    env: { ...ADMIN_ENV, AI_API_KEY: 'test-key' },
    fetchImpl: trackingFetch,
  });

  assert.strictEqual(response.status, 401);
  assert.strictEqual(json.code, 'UNAUTHORIZED');
  assert.strictEqual(fetchCount, 0, 'No auth header should make ZERO provider calls');
  ok('1. no auth header => 401, zero provider calls');
}

// TEST 2: Invalid token => 401, zero provider calls
{
  let fetchCount = 0;
  const trackingFetch = async () => { fetchCount++; return { ok: true, status: 200, json: async () => ({}) }; };

  const { response, json } = await callAiAssist({
    body: { task: 'support_draft', input: { customerMessage: 'Test invalid token' } },
    env: { ...ADMIN_ENV, AI_API_KEY: 'test-key' },
    fetchImpl: trackingFetch,
    authHeader: 'Bearer short',
    createClientImpl: AUTH_ERROR_CC,
  });

  assert.strictEqual(response.status, 401);
  assert.strictEqual(json.code, 'UNAUTHORIZED');
  assert.strictEqual(fetchCount, 0, 'Invalid token should make ZERO provider calls');
  ok('2. invalid token => 401, zero provider calls');
}

// TEST 3: Expired/invalid session => 401, zero provider calls
{
  let fetchCount = 0;
  const trackingFetch = async () => { fetchCount++; return { ok: true, status: 200, json: async () => ({}) }; };

  const { response, json } = await callAiAssist({
    body: { task: 'support_draft', input: { customerMessage: 'Test expired session' } },
    env: { ...ADMIN_ENV, AI_API_KEY: 'test-key' },
    fetchImpl: trackingFetch,
    authHeader: ADMIN_AUTH,
    createClientImpl: AUTH_ERROR_CC,
  });

  assert.strictEqual(response.status, 401);
  assert.strictEqual(json.code, 'UNAUTHORIZED');
  assert.strictEqual(fetchCount, 0, 'Expired session should make ZERO provider calls');
  ok('3. expired/invalid session => 401, zero provider calls');
}

// TEST 4: Authenticated non-admin => 403, zero provider calls
{
  let fetchCount = 0;
  const trackingFetch = async () => { fetchCount++; return { ok: true, status: 200, json: async () => ({}) }; };

  const { response, json } = await callAiAssist({
    body: { task: 'support_draft', input: { customerMessage: 'Test non-admin' } },
    env: { ...ADMIN_ENV, AI_API_KEY: 'test-key' },
    fetchImpl: trackingFetch,
    authHeader: NON_ADMIN_AUTH,
    createClientImpl: NON_ADMIN_CC,
  });

  assert.strictEqual(response.status, 403);
  assert.strictEqual(json.code, 'FORBIDDEN');
  assert.strictEqual(fetchCount, 0, 'Non-admin should make ZERO provider calls');
  ok('4. authenticated non-admin => 403, zero provider calls');
}

// TEST 5: Authenticated admin => provider call allowed
{
  const capture = {};
  const { json } = await callAiAssist({
    body: { task: 'support_draft', input: { customerMessage: 'Test admin access' } },
    env: { ...ADMIN_ENV, AI_API_KEY: 'test-key', AI_MODEL_DEFAULT: 'gpt-5.6-luna' },
    fetchImpl: mockFetch({
      status: 200,
      body: { choices: [{ message: { content: '{"draft": "Bonjour, nous revenons vers vous.", "confidence": "medium"}' } }], usage: { prompt_tokens: 10, completion_tokens: 5 } },
      captureBody: capture,
    }),
    authHeader: ADMIN_AUTH,
    createClientImpl: ADMIN_CC,
  });

  assert.strictEqual(json.ok, true);
  assert.strictEqual(json.meta.fallback_used, false);
  assert.strictEqual(json.meta.source, 'ai');
  assert.ok(capture.parsed, 'Provider call should have been made');
  ok('5. authenticated admin => provider call allowed');
}

// TEST 6: Role supplied by client body cannot bypass server auth
{
  let fetchCount = 0;
  const trackingFetch = async () => { fetchCount++; return { ok: true, status: 200, json: async () => ({}) }; };

  // Client tries to send role=admin in the body, but server uses non-admin createClient
  const { response, json } = await callAiAssist({
    body: { task: 'support_draft', input: { customerMessage: 'Test role bypass' }, role: 'admin', isAdmin: true },
    env: { ...ADMIN_ENV, AI_API_KEY: 'test-key' },
    fetchImpl: trackingFetch,
    authHeader: NON_ADMIN_AUTH,
    createClientImpl: NON_ADMIN_CC,
  });

  assert.strictEqual(response.status, 403);
  assert.strictEqual(json.code, 'FORBIDDEN');
  assert.strictEqual(fetchCount, 0, 'Client-supplied role should NOT bypass server auth');
  ok('6. role supplied by client body cannot bypass server auth');
}

// ============================================================
// SECRET / SECURITY TESTS
// ============================================================

// TEST 7: API key never reaches browser (not in response)
{
  const { json } = await callAiAssist({
    body: { task: 'support_draft', input: { customerMessage: 'Test key in response' } },
    env: { ...ADMIN_ENV, AI_API_KEY: 'sk-test-secret-key-123456789', AI_MODEL_DEFAULT: 'gpt-5.6-luna' },
    fetchImpl: mockFetch({
      status: 200,
      body: { choices: [{ message: { content: '{"draft": "Bonjour", "confidence": "low"}' } }], usage: { prompt_tokens: 10, completion_tokens: 5 } },
    }),
    authHeader: ADMIN_AUTH,
    createClientImpl: ADMIN_CC,
  });

  const responseStr = JSON.stringify(json);
  assert.ok(!responseStr.includes('sk-test-secret-key-123456789'));
  ok('7. API key never appears in response');
}

// TEST 8: API key never appears in fallback output
{
  const { json } = await callAiAssist({
    body: { task: 'support_draft', input: { customerMessage: 'Test key in fallback' } },
    env: { ...ADMIN_ENV, AI_API_KEY: 'sk-test-secret-key-123456789' },
    fetchImpl: mockFetch({ shouldAbort: true }),
    authHeader: ADMIN_AUTH,
    createClientImpl: ADMIN_CC,
  });

  const responseStr = JSON.stringify(json);
  assert.ok(!responseStr.includes('sk-test-secret-key-123456789'));
  ok('8. API key never appears in fallback output');
}

// TEST 9: Raw provider error never exposed
{
  const { json } = await callAiAssist({
    body: { task: 'support_draft', input: { customerMessage: 'Test error leak' } },
    env: { ...ADMIN_ENV, AI_API_KEY: 'test-key', AI_MODEL_DEFAULT: 'gpt-5.6-luna' },
    fetchImpl: mockFetch({ status: 500 }),
    authHeader: ADMIN_AUTH,
    createClientImpl: ADMIN_CC,
  });

  const responseStr = JSON.stringify(json);
  assert.ok(!responseStr.includes('Error'));
  assert.ok(!responseStr.includes('stack'));
  ok('9. raw provider error never exposed');
}

// TEST 10: Auth token never logged in telemetry
{
  const source = readFileSync(new URL('../functions/api/ai-assist.js', import.meta.url), 'utf8');
  // The telemetry function should not log auth tokens
  assert.ok(!source.includes('meta.authToken'));
  assert.ok(!source.includes('meta.token'));
  assert.ok(!source.includes('meta.access_token'));
  ok('10. auth token never logged (source inspection)');
}

// TEST 11: Customer message never logged in telemetry
{
  const source = readFileSync(new URL('../functions/api/ai-assist.js', import.meta.url), 'utf8');
  assert.ok(!source.includes('meta.customerMessage'));
  assert.ok(!source.includes('meta.userPrompt'));
  assert.ok(!source.includes('meta.input_text'));
  ok('11. customer message never logged (source inspection)');
}

// TEST 12: No service-role secret in frontend
{
  const source = readFileSync(new URL('../dashboard-admin.html', import.meta.url), 'utf8');
  assert.ok(!source.includes('SUPABASE_SERVICE_ROLE_KEY'));
  assert.ok(!source.includes('service_role'));
  assert.ok(!source.includes('service-role'));
  ok('12. no service-role secret in frontend');
}

// ============================================================
// PII TESTS
// ============================================================

// TEST 13: Only customerMessage sent to provider
{
  const capture = {};
  await callAiAssist({
    body: {
      task: 'support_draft',
      input: {
        customerMessage: 'Test PII scope',
        customerName: 'Jean Dupont',
        missionRef: 'BC-2025-001',
        email: 'jean@example.com',
        phone: '0601020304',
        address: '123 rue de Paris',
      },
    },
    env: { ...ADMIN_ENV, AI_API_KEY: 'test-key', AI_MODEL_DEFAULT: 'gpt-5.6-luna' },
    fetchImpl: mockFetch({
      status: 200,
      body: { choices: [{ message: { content: '{"draft": "Bonjour", "confidence": "low"}' } }], usage: { prompt_tokens: 10, completion_tokens: 5 } },
      captureBody: capture,
    }),
    authHeader: ADMIN_AUTH,
    createClientImpl: ADMIN_CC,
  });

  const userContent = capture.parsed.messages.find(m => m.role === 'user')?.content || '';
  assert.ok(userContent.includes('Test PII scope'));
  assert.ok(!userContent.includes('Jean Dupont'));
  assert.ok(!userContent.includes('BC-2025-001'));
  assert.ok(!userContent.includes('jean@example.com'));
  assert.ok(!userContent.includes('0601020304'));
  assert.ok(!userContent.includes('123 rue de Paris'));
  ok('13. only customerMessage sent to provider (PII excluded)');
}

// TEST 14: Name/email/phone/address/ref excluded from provider payload
{
  const capture = {};
  await callAiAssist({
    body: {
      task: 'support_draft',
      input: {
        customerMessage: 'Message only',
        customerName: 'Marie Curie',
        email: 'marie@test.com',
        phone: '0701020304',
        address: '456 av Lyon',
        missionRef: 'REF-789',
      },
    },
    env: { ...ADMIN_ENV, AI_API_KEY: 'test-key', AI_MODEL_DEFAULT: 'gpt-5.6-luna' },
    fetchImpl: mockFetch({
      status: 200,
      body: { choices: [{ message: { content: '{"draft": "Bonjour", "confidence": "low"}' } }], usage: { prompt_tokens: 10, completion_tokens: 5 } },
      captureBody: capture,
    }),
    authHeader: ADMIN_AUTH,
    createClientImpl: ADMIN_CC,
  });

  const fullPayload = JSON.stringify(capture.parsed);
  assert.ok(!fullPayload.includes('Marie Curie'));
  assert.ok(!fullPayload.includes('marie@test.com'));
  assert.ok(!fullPayload.includes('0701020304'));
  assert.ok(!fullPayload.includes('456 av Lyon'));
  assert.ok(!fullPayload.includes('REF-789'));
  ok('14. name/email/phone/address/ref excluded from provider payload');
}

// ============================================================
// BUSINESS BOUNDARIES
// ============================================================

// TEST 15: No pricing mutation
{
  const source = readFileSync(new URL('../functions/api/ai-assist.js', import.meta.url), 'utf8');
  assert.ok(!source.includes('calculateQuote'));
  assert.ok(!source.includes('_pricing'));
  ok('15. no pricing mutation');
}

// TEST 16: No mission-state mutation
{
  const source = readFileSync(new URL('../functions/api/ai-assist.js', import.meta.url), 'utf8');
  assert.ok(!source.includes('missions'));
  assert.ok(!source.includes('mission_status'));
  assert.ok(!source.includes('mission_state'));
  ok('16. no mission-state mutation');
}

// TEST 17: No DB mutation from AI feature
{
  const source = readFileSync(new URL('../functions/api/ai-assist.js', import.meta.url), 'utf8');
  // createClient is used ONLY for auth verification (getUser + rpc is_admin)
  // No .insert, .update, .delete, .upsert on the supabase client
  assert.ok(!source.includes('.insert('));
  assert.ok(!source.includes('.update('));
  assert.ok(!source.includes('.delete('));
  assert.ok(!source.includes('.upsert('));
  ok('17. no DB mutation from AI feature');
}

// TEST 18: No email send
{
  const source = readFileSync(new URL('../functions/api/ai-assist.js', import.meta.url), 'utf8');
  assert.ok(!source.includes('api.resend.com'));
  assert.ok(!source.includes('RESEND_API_KEY'));
  assert.ok(!source.includes('sendEmail'));
  ok('18. no email send');
}

// TEST 19: No Auth mutation
{
  const source = readFileSync(new URL('../functions/api/ai-assist.js', import.meta.url), 'utf8');
  assert.ok(!source.includes('auth.admin'));
  assert.ok(!source.includes('signUp'));
  assert.ok(!source.includes('signInWithPassword'));
  assert.ok(!source.includes('verifyOtp'));
  assert.ok(!source.includes('resetPassword'));
  assert.ok(!source.includes('auth.signOut'));
  ok('19. no Auth mutation');
}

// ============================================================
// AI FOUNDATION REGRESSION TESTS
// ============================================================

// TEST 20: MAX_DRAFT_LEN = 200
{
  const mod = await import('../functions/api/ai-assist.js');
  assert.strictEqual(mod.MAX_DRAFT_LEN, 200);
  ok('20. MAX_DRAFT_LEN = 200');
}

// TEST 21: Default model = gpt-5.6-luna
{
  const mod = await import('../functions/api/ai-assist.js');
  assert.strictEqual(mod.DEFAULT_MODEL, 'gpt-5.6-luna');
  ok('21. default model is gpt-5.6-luna');
}

// TEST 22: SUPPORTED_PROVIDERS = openai, openrouter
{
  const mod = await import('../functions/api/ai-assist.js');
  assert.ok(mod.SUPPORTED_PROVIDERS.has('openai'));
  assert.ok(mod.SUPPORTED_PROVIDERS.has('openrouter'));
  assert.strictEqual(mod.SUPPORTED_PROVIDERS.size, 2);
  ok('22. SUPPORTED_PROVIDERS = openai, openrouter');
}

// TEST 23: Invalid provider => no fetch, fallback (admin authed)
{
  let fetchCount = 0;
  const trackingFetch = async () => { fetchCount++; return { ok: true, status: 200, json: async () => ({}) }; };

  const { json } = await callAiAssist({
    body: { task: 'support_draft', input: { customerMessage: 'Test invalid provider' } },
    env: { ...ADMIN_ENV, AI_API_KEY: 'test-key', AI_PROVIDER: 'anthropic' },
    fetchImpl: trackingFetch,
    authHeader: ADMIN_AUTH,
    createClientImpl: ADMIN_CC,
  });

  assert.strictEqual(fetchCount, 0, 'Invalid provider should make ZERO fetch calls');
  assert.strictEqual(json.meta.fallback_used, true);
  ok('23. invalid provider => no fetch, fallback');
}

// TEST 24: OpenAI contract: max_completion_tokens, no temperature, reasoning_effort
{
  const capture = {};
  const mod = await import('../functions/api/ai-assist.js');
  await mod.callLLM({
    provider: 'openai',
    model: 'gpt-5.6-luna',
    apiKey: 'test-key',
    systemPrompt: 'Test',
    userPrompt: 'Test',
    timeoutMs: 5000,
    fetchImpl: mockFetch({
      status: 200,
      body: { choices: [{ message: { content: '{"draft": "Bonjour", "confidence": "low"}' } }], usage: { prompt_tokens: 10, completion_tokens: 5 } },
      captureBody: capture,
    }),
  });

  assert.ok(capture.parsed.max_completion_tokens, 'OpenAI should use max_completion_tokens');
  assert.ok(!capture.parsed.max_tokens, 'OpenAI should NOT use max_tokens');
  assert.ok(!('temperature' in capture.parsed), 'OpenAI should NOT include temperature');
  assert.strictEqual(capture.parsed.reasoning_effort, 'low');
  ok('24. OpenAI contract: max_completion_tokens, no temperature, reasoning_effort');
}

// TEST 25: OpenRouter contract: max_tokens, temperature, no response_format
{
  const capture = {};
  const mod = await import('../functions/api/ai-assist.js');
  await mod.callLLM({
    provider: 'openrouter',
    model: 'some-model',
    apiKey: 'test-key',
    systemPrompt: 'Test',
    userPrompt: 'Test',
    timeoutMs: 5000,
    fetchImpl: mockFetch({
      status: 200,
      body: { choices: [{ message: { content: '{"draft": "Bonjour", "confidence": "low"}' } }], usage: { prompt_tokens: 10, completion_tokens: 5 } },
      captureBody: capture,
    }),
  });

  assert.ok(capture.parsed.max_tokens, 'OpenRouter should use max_tokens');
  assert.ok('temperature' in capture.parsed, 'OpenRouter should include temperature');
  assert.ok(!capture.parsed.response_format, 'OpenRouter should NOT include response_format');
  ok('25. OpenRouter contract: max_tokens, temperature, no response_format');
}

// TEST 26: Fallback draft <= 200 chars
{
  const mod = await import('../functions/api/ai-assist.js');
  const fallback = mod.fallbackSupportDraft();
  assert.ok(fallback.draft.length <= 200, `Fallback draft is ${fallback.draft.length} chars`);
  ok(`26. fallback draft is ${fallback.draft.length} characters (<= 200)`);
}

// TEST 27: UTF-8 byte counting
{
  const mod = await import('../functions/api/ai-assist.js');
  const emoji = '🎉';
  const emojiMessage = emoji.repeat(1500);
  const jsLen = emojiMessage.length;
  const byteLen = mod.utf8ByteLength(JSON.stringify({ customerMessage: emojiMessage }));
  assert.ok(jsLen < 4096, `JS length should be < 4096, got ${jsLen}`);
  assert.ok(byteLen > 4096, `UTF-8 byte length should be > 4096, got ${byteLen}`);
  ok('27. UTF-8 byte counting (emoji overflow detected)');
}

// TEST 28: Structured output validation
{
  const mod = await import('../functions/api/ai-assist.js');

  // Valid output
  const valid = mod.validateSupportDraftOutput({ draft: 'Bonjour', confidence: 'low' });
  assert.strictEqual(valid.valid, true);

  // Empty draft
  const empty = mod.validateSupportDraftOutput({ draft: '', confidence: 'low' });
  assert.strictEqual(empty.valid, false);

  // Invalid confidence
  const badConf = mod.validateSupportDraftOutput({ draft: 'Bonjour', confidence: 'invalid' });
  assert.strictEqual(badConf.valid, false);

  // Too long
  const tooLong = mod.validateSupportDraftOutput({ draft: 'A'.repeat(201), confidence: 'low' });
  assert.strictEqual(tooLong.valid, false);

  ok('28. structured output validation works');
}

// TEST 29: HTML rejection
{
  const mod = await import('../functions/api/ai-assist.js');

  const script = mod.validateSupportDraftOutput({ draft: 'Bonjour <script>alert(1)</script>', confidence: 'low' });
  assert.strictEqual(script.valid, false);

  const iframe = mod.validateSupportDraftOutput({ draft: 'Bonjour <iframe src="evil"></iframe>', confidence: 'low' });
  assert.strictEqual(iframe.valid, false);

  const jsUri = mod.validateSupportDraftOutput({ draft: 'Cliquez: javascript:alert(1)', confidence: 'low' });
  assert.strictEqual(jsUri.valid, false);

  ok('29. HTML/script/javascript: rejected in output');
}

// TEST 30: System prompt injection constraints
{
  const mod = await import('../functions/api/ai-assist.js');
  const prompt = mod.SYSTEM_PROMPT;
  assert.ok(prompt.includes('NON FIABLE'));
  assert.ok(prompt.includes('Ne suivez JAMAIS'));
  assert.ok(prompt.includes('révélez JAMAIS'));
  assert.ok(prompt.includes("N'inventez JAMAIS"));
  ok('30. system prompt contains injection/security constraints');
}

// TEST 31: INVALID_JSON for malformed/empty/whitespace
{
  const { response: r1, json: j1 } = await callAiAssist({
    rawText: '{ invalid',
    env: ADMIN_ENV,
    authHeader: ADMIN_AUTH,
    createClientImpl: ADMIN_CC,
  });
  assert.strictEqual(r1.status, 400);
  assert.strictEqual(j1.code, 'INVALID_JSON');

  const { response: r2, json: j2 } = await callAiAssist({
    rawText: '',
    env: ADMIN_ENV,
    authHeader: ADMIN_AUTH,
    createClientImpl: ADMIN_CC,
  });
  assert.strictEqual(r2.status, 400);
  assert.strictEqual(j2.code, 'INVALID_JSON');

  const { response: r3, json: j3 } = await callAiAssist({
    rawText: '   \n  ',
    env: ADMIN_ENV,
    authHeader: ADMIN_AUTH,
    createClientImpl: ADMIN_CC,
  });
  assert.strictEqual(r3.status, 400);
  assert.strictEqual(j3.code, 'INVALID_JSON');

  ok('31. INVALID_JSON for malformed/empty/whitespace');
}

// TEST 32: meta.fallback_used and meta.source on fallback (admin authed, no key)
{
  const { json } = await callAiAssist({
    body: { task: 'support_draft', input: { customerMessage: 'Test fallback meta' } },
    env: ADMIN_ENV, // no AI_API_KEY
    authHeader: ADMIN_AUTH,
    createClientImpl: ADMIN_CC,
  });

  assert.strictEqual(json.ok, true);
  assert.strictEqual(json.meta.fallback_used, true);
  assert.strictEqual(json.meta.source, 'fallback');
  assert.strictEqual(json.meta.model, 'fallback');
  ok('32. meta.fallback_used=true, source="fallback" on no-key fallback');
}

// TEST 33: AI success meta (admin authed)
{
  const { json } = await callAiAssist({
    body: { task: 'support_draft', input: { customerMessage: 'Test AI success meta' } },
    env: { ...ADMIN_ENV, AI_API_KEY: 'test-key', AI_MODEL_DEFAULT: 'gpt-5.6-luna' },
    fetchImpl: mockFetch({
      status: 200,
      body: { choices: [{ message: { content: '{"draft": "Bonjour, nous revenons vers vous.", "confidence": "medium"}' } }], usage: { prompt_tokens: 10, completion_tokens: 5 } },
    }),
    authHeader: ADMIN_AUTH,
    createClientImpl: ADMIN_CC,
  });

  assert.strictEqual(json.meta.fallback_used, false);
  assert.strictEqual(json.meta.source, 'ai');
  assert.strictEqual(json.meta.model, 'gpt-5.6-luna');
  ok('33. AI success meta.fallback_used=false, source="ai"');
}

// TEST 34: Admin check error => fail closed (403)
{
  let fetchCount = 0;
  const trackingFetch = async () => { fetchCount++; return { ok: true, status: 200, json: async () => ({}) }; };

  const { response, json } = await callAiAssist({
    body: { task: 'support_draft', input: { customerMessage: 'Test admin check error' } },
    env: { ...ADMIN_ENV, AI_API_KEY: 'test-key' },
    fetchImpl: trackingFetch,
    authHeader: ADMIN_AUTH,
    createClientImpl: ADMIN_CHECK_ERROR_CC,
  });

  assert.strictEqual(response.status, 403);
  assert.strictEqual(json.code, 'FORBIDDEN');
  assert.strictEqual(fetchCount, 0, 'Admin check error should make ZERO provider calls');
  ok('34. admin check RPC error => fail closed (403)');
}

// TEST 35: Missing SUPABASE_URL => 401
{
  let fetchCount = 0;
  const trackingFetch = async () => { fetchCount++; return { ok: true, status: 200, json: async () => ({}) }; };

  const { response, json } = await callAiAssist({
    body: { task: 'support_draft', input: { customerMessage: 'Test no supabase config' } },
    env: { AI_API_KEY: 'test-key' }, // no SUPABASE_URL
    fetchImpl: trackingFetch,
    authHeader: ADMIN_AUTH,
    createClientImpl: ADMIN_CC,
  });

  assert.strictEqual(response.status, 401);
  assert.strictEqual(fetchCount, 0);
  ok('35. missing SUPABASE_URL => 401, zero provider calls');
}

// TEST 36: OPTIONS preflight still works (no auth required)
{
  const mod = await import('../functions/api/ai-assist.js');
  testIpCounter++;
  const ctx = {
    request: {
      method: 'OPTIONS',
      headers: { get: (name) => {
        const n = name.toLowerCase();
        if (n === 'origin') return 'https://www.bathily-convoyage.fr';
        if (n === 'cf-connecting-ip') return `203.0.113.${testIpCounter % 200 + 1}`;
        return null;
      }},
      url: 'https://www.bathily-convoyage.fr/api/ai-assist',
    },
    env: {},
  };
  const response = await mod.onRequest(ctx);
  assert.strictEqual(response.status, 200);
  ok('36. OPTIONS preflight returns 200 (no auth required)');
}

// TEST 37: GET method rejected
{
  const mod = await import('../functions/api/ai-assist.js');
  testIpCounter++;
  const ctx = {
    request: {
      method: 'GET',
      headers: { get: (name) => {
        if (name.toLowerCase() === 'cf-connecting-ip') return `203.0.113.${testIpCounter % 200 + 1}`;
        return null;
      }},
      url: 'https://www.bathily-convoyage.fr/api/ai-assist',
    },
    env: {},
  };
  const response = await mod.onRequest(ctx);
  assert.strictEqual(response.status, 405);
  ok('37. GET method rejected with 405');
}

// TEST 38: UI — AI button present in dashboard-admin.html
{
  const source = readFileSync(new URL('../dashboard-admin.html', import.meta.url), 'utf8');
  assert.ok(source.includes('Générer un brouillon IA'), 'AI button text should be present');
  assert.ok(source.includes('generateAiDraft'), 'generateAiDraft function should be present');
  ok('38. AI button present in admin dashboard');
}

// TEST 39: UI — button action is manual (onclick, not auto)
{
  const source = readFileSync(new URL('../dashboard-admin.html', import.meta.url), 'utf8');
  assert.ok(source.includes('onclick="generateAiDraft'), 'Button should use onclick (manual trigger)');
  // Verify it's NOT auto-called on tab load
  const supportLoadIdx = source.indexOf("if (tabId === 'support') loadSupportTickets()");
  const aiDraftIdx = source.indexOf('generateAiDraft');
  // loadSupportTickets should not call generateAiDraft
  const loadFnStart = source.indexOf('async function loadSupportTickets()');
  const loadFnEnd = source.indexOf('window.replyTicket', loadFnStart);
  const loadFnBody = source.substring(loadFnStart, loadFnEnd);
  assert.ok(!loadFnBody.includes('generateAiDraft'), 'loadSupportTickets should NOT call generateAiDraft');
  ok('39. button action is manual (not auto-triggered)');
}

// TEST 40: UI — draft returned into editable textarea
{
  const source = readFileSync(new URL('../dashboard-admin.html', import.meta.url), 'utf8');
  assert.ok(source.includes('textarea.value = data.output.draft'), 'Draft should be set in textarea');
  ok('40. draft returned into editable textarea');
}

// TEST 41: UI — AI draft is never auto-sent
{
  const source = readFileSync(new URL('../dashboard-admin.html', import.meta.url), 'utf8');
  // generateAiDraft should NOT call send-email or update support_tickets
  const genFnStart = source.indexOf('window.generateAiDraft');
  const genFnEnd = source.indexOf('window.closeTicket', genFnStart);
  const genFnBody = source.substring(genFnStart, genFnEnd);
  assert.ok(!genFnBody.includes('send-email'), 'generateAiDraft should NOT send email');
  assert.ok(!genFnBody.includes('support_tickets'), 'generateAiDraft should NOT update support_tickets');
  assert.ok(!genFnBody.includes('.update('), 'generateAiDraft should NOT update DB');
  ok('41. AI draft is never auto-sent');
}

// TEST 42: UI — fallback is visibly distinguishable
{
  const source = readFileSync(new URL('../dashboard-admin.html', import.meta.url), 'utf8');
  assert.ok(source.includes('Brouillon IA généré'), 'AI success indicator should be present');
  assert.ok(source.includes('Assistant indisponible'), 'Fallback indicator should be present');
  ok('42. fallback is visibly distinguishable in UI');
}

// TEST 43: UI — auth token in Authorization header only, not in JSON body
{
  const source = readFileSync(new URL('../dashboard-admin.html', import.meta.url), 'utf8');
  const genFnStart = source.indexOf('window.generateAiDraft');
  const genFnEnd = source.indexOf('window.closeTicket', genFnStart);
  const genFnBody = source.substring(genFnStart, genFnEnd);

  // Token should be in Authorization header
  assert.ok(genFnBody.includes("Authorization"), 'Token should be in Authorization header');

  // Token should NOT be in the JSON body
  const bodyMatch = genFnBody.match(/body:\s*JSON\.stringify\(([\s\S]*?)\)/);
  if (bodyMatch) {
    const bodyContent = bodyMatch[1];
    assert.ok(!bodyContent.includes('access_token'), 'Token should NOT be in JSON body');
    assert.ok(!bodyContent.includes('session.token'), 'Token should NOT be in JSON body');
  }
  ok('43. auth token in Authorization header only, not in JSON body');
}

// TEST 44: verifyAdminAuth exported
{
  const mod = await import('../functions/api/ai-assist.js');
  assert.ok(typeof mod.verifyAdminAuth === 'function');
  ok('44. verifyAdminAuth is exported');
}

// TEST 45: No auth header => no Supabase client created
{
  // Verify that when no auth header is present, the gateway returns 401
  // without even trying to create a Supabase client
  let clientCreated = false;
  const trackingCC = () => { clientCreated = true; return { auth: { getUser: async () => ({ data: { user: null }, error: {} }) }, rpc: async () => ({ data: false, error: null }) }; };

  const { response } = await callAiAssist({
    body: { task: 'support_draft', input: { customerMessage: 'Test' } },
    env: { ...ADMIN_ENV, AI_API_KEY: 'test-key' },
    fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({}) }),
    authHeader: null, // no auth header
    createClientImpl: trackingCC,
  });

  assert.strictEqual(response.status, 401);
  assert.strictEqual(clientCreated, false, 'No Supabase client should be created when no auth header');
  ok('45. no auth header => no Supabase client created');
}

// ============================================================
// SUMMARY
// ============================================================

console.log(`\nAll ${passed} AI-BOOST-2A admin-gated tests passed.`);
