// PROD-1D-C.2 — Local unit/integration tests for the notification scheduler Worker.
//
// NO remote calls.
// NO real secrets.
// NO provider or Resend interaction.
//
// H2D-E2: Extended to cover dual-consumer (email + push) invocation,
// error isolation, and exactly-one-call-per-consumer-per-tick.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import scheduler from '../src/workers/notification-scheduler.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const TEST_SECRET = 'test-local-secret-64-char-alpha-numeric-00000000000000000000001';
const PRODUCTION_EMAIL_TARGET = 'https://www.bathily-convoyage.fr/api/process-notification-outbox';
const PRODUCTION_PUSH_TARGET = 'https://www.bathily-convoyage.fr/api/process-push-outbox';

let originalFetch = null;
let originalConsoleLog = null;
let originalSetTimeout = null;
let originalClearTimeout = null;

let fetchCalls = [];
let consoleCalls = [];

const capturedSetTimeout = { delay: null };

function makeController() {
  return { scheduledTime: Date.now(), cron: '* * * * *' };
}

function makeCtx() {
  return { waitUntil: () => {} };
}

function installLogCapture() {
  consoleCalls = [];
  originalConsoleLog = console.log;
  console.log = (...args) => {
    consoleCalls.push(args.map(a => (typeof a === 'string' ? a : JSON.stringify(a))));
    originalConsoleLog(...args);
  };
}

function restoreLogCapture() {
  console.log = originalConsoleLog;
}

function installFetch(mock) {
  originalFetch = globalThis.fetch;
  globalThis.fetch = mock;
}

function restoreFetch() {
  globalThis.fetch = originalFetch;
}

function installImmediateTimeout() {
  originalSetTimeout = globalThis.setTimeout;
  originalClearTimeout = globalThis.clearTimeout;
  capturedSetTimeout.delay = null;
  globalThis.setTimeout = (fn, ms) => {
    capturedSetTimeout.delay = ms;
    fn();
    return 0;
  };
  globalThis.clearTimeout = () => {};
}

function restoreTimeout() {
  globalThis.setTimeout = originalSetTimeout;
  globalThis.clearTimeout = originalClearTimeout;
}

function allLogsAsString() {
  return consoleCalls.map(args => args.join(' ')).join(' ');
}

function findLog(event) {
  for (const args of consoleCalls) {
    for (const s of args) {
      try {
        const obj = JSON.parse(s);
        if (obj && obj.event === event) return obj;
      } catch {
        // ignore non-JSON log lines
      }
    }
  }
  return null;
}

function findLogByConsumer(event, consumer) {
  for (const args of consoleCalls) {
    for (const s of args) {
      try {
        const obj = JSON.parse(s);
        if (obj && obj.event === event && obj.consumer === consumer) return obj;
      } catch {
        // ignore non-JSON log lines
      }
    }
  }
  return null;
}

function assertNoSecretInLogs() {
  const haystack = allLogsAsString();
  assert.strictEqual(haystack.includes(TEST_SECRET), false, 'secret found in logs');
  assert.strictEqual(haystack.includes('x-cron-secret'), false, 'auth header found in logs');
}

function mockResponse(status, body, headers = {}) {
  return async (url, init) => {
    fetchCalls.push({ url, init });
    const text = typeof body === 'string' ? body : JSON.stringify(body);
    return new Response(text, { status, headers: { 'Content-Type': 'application/json', ...headers } });
  };
}

// Mock that returns different responses based on which consumer URL is called.
function mockMultiResponse(notificationResp, pushResp) {
  return async (url, init) => {
    fetchCalls.push({ url, init });
    let resp;
    if (url.includes('process-notification-outbox')) {
      resp = notificationResp;
    } else if (url.includes('process-push-outbox')) {
      resp = pushResp;
    } else {
      resp = { status: 404, body: { error: 'unknown endpoint' } };
    }
    const text = typeof resp.body === 'string' ? resp.body : JSON.stringify(resp.body);
    return new Response(text, { status: resp.status, headers: { 'Content-Type': 'application/json' } });
  };
}

// Mock that throws for a specific consumer URL.
function mockMultiThrow(notificationFn, pushFn) {
  return async (url, init) => {
    fetchCalls.push({ url, init });
    if (url.includes('process-notification-outbox') && notificationFn) {
      throw notificationFn();
    }
    if (url.includes('process-push-outbox') && pushFn) {
      throw pushFn();
    }
    // Default: success
    return new Response(JSON.stringify({ processed: 0, results: [] }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });
  };
}

const OK_RESP = { status: 200, body: { processed: 0, results: [] } };
const ERR_500 = { status: 500, body: { error: 'boom' } };

async function runWorker(env) {
  await scheduler.scheduled(makeController(), env, makeCtx());
}

async function runTest(env, fetchMock, timeoutMode = false) {
  fetchCalls = [];
  consoleCalls = [];
  installLogCapture();
  installFetch(fetchMock);
  if (timeoutMode) {
    installImmediateTimeout();
  }
  try {
    await runWorker(env);
  } finally {
    if (timeoutMode) {
      restoreTimeout();
    }
    restoreFetch();
    restoreLogCapture();
  }
}

function parseJsonc(filePath) {
  const raw = readFileSync(filePath, 'utf8');
  const stripped = raw
    .split('\n')
    .filter(line => !line.trim().startsWith('//'))
    .join('\n');
  return JSON.parse(stripped);
}

// Helper: find fetch call by URL substring
function findCall(urlSubstring) {
  return fetchCalls.find(c => c.url.includes(urlSubstring));
}

// =========================================================
// TESTS
// =========================================================

const results = { pass: 0, fail: 0, details: [] };

async function t(name, fn) {
  try {
    await fn();
    results.pass++;
    results.details.push({ name, status: 'PASS' });
    console.log(`[PASS] ${name}`);
  } catch (err) {
    results.fail++;
    results.details.push({ name, status: 'FAIL', detail: err.message });
    console.log(`[FAIL] ${name} — ${err.message}`);
  }
}

await t('T1 scheduler disabled => fetch count 0', async () => {
  await runTest({ NOTIFICATION_SCHEDULER_ENABLED: 'false' }, () => { throw new Error('fetch should not be called'); });
  assert.strictEqual(fetchCalls.length, 0);
  assert.ok(findLog('scheduler_disabled'));
  assertNoSecretInLogs();
});

await t('T2 missing OUTBOX_CRON_SECRET => fetch count 0', async () => {
  await runTest({ NOTIFICATION_SCHEDULER_ENABLED: 'true' }, () => { throw new Error('fetch should not be called'); });
  assert.strictEqual(fetchCalls.length, 0);
  assert.ok(findLog('configuration_error'));
  assertNoSecretInLogs();
});

await t('T3 enabled + valid secret => exactly 2 fetches (email + push)', async () => {
  await runTest({ NOTIFICATION_SCHEDULER_ENABLED: 'true', OUTBOX_CRON_SECRET: TEST_SECRET }, mockResponse(200, { processed: 0, results: [] }));
  assert.strictEqual(fetchCalls.length, 2);
  assert.ok(findLogByConsumer('ok', 'notification'));
  assert.ok(findLogByConsumer('ok', 'push'));
  assertNoSecretInLogs();
});

await t('T4 both calls use POST', async () => {
  await runTest({ NOTIFICATION_SCHEDULER_ENABLED: 'true', OUTBOX_CRON_SECRET: TEST_SECRET }, mockResponse(200, { processed: 0, results: [] }));
  assert.strictEqual(fetchCalls.length, 2);
  assert.strictEqual(fetchCalls[0].init.method, 'POST');
  assert.strictEqual(fetchCalls[1].init.method, 'POST');
  assertNoSecretInLogs();
});

await t('T5 both calls carry x-cron-secret header', async () => {
  await runTest({ NOTIFICATION_SCHEDULER_ENABLED: 'true', OUTBOX_CRON_SECRET: TEST_SECRET }, mockResponse(200, { processed: 0, results: [] }));
  assert.strictEqual(fetchCalls[0].init.headers['x-cron-secret'], TEST_SECRET);
  assert.strictEqual(fetchCalls[1].init.headers['x-cron-secret'], TEST_SECRET);
  assertNoSecretInLogs();
});

await t('T6 header value correct internally without printing it', async () => {
  await runTest({ NOTIFICATION_SCHEDULER_ENABLED: 'true', OUTBOX_CRON_SECRET: TEST_SECRET }, mockResponse(200, { processed: 0, results: [] }));
  assert.strictEqual(fetchCalls[0].init.headers['x-cron-secret'], TEST_SECRET);
  assert.strictEqual(fetchCalls[1].init.headers['x-cron-secret'], TEST_SECRET);
  const text = allLogsAsString();
  assert.strictEqual(text.includes(TEST_SECRET), false);
  assertNoSecretInLogs();
});

await t('T7 HTTP 200 + processed 0 => both consumers PASS', async () => {
  await runTest({ NOTIFICATION_SCHEDULER_ENABLED: 'true', OUTBOX_CRON_SECRET: TEST_SECRET }, mockResponse(200, { processed: 0, results: [] }));
  const emailLog = findLogByConsumer('ok', 'notification');
  const pushLog = findLogByConsumer('ok', 'push');
  assert.ok(emailLog);
  assert.ok(pushLog);
  assert.strictEqual(emailLog.processed, 0);
  assert.strictEqual(pushLog.processed, 0);
  assert.strictEqual(emailLog.http_status, 200);
  assert.strictEqual(pushLog.http_status, 200);
  assertNoSecretInLogs();
});

await t('T8 HTTP 200 + processed >0 => log correctly for both', async () => {
  await runTest({ NOTIFICATION_SCHEDULER_ENABLED: 'true', OUTBOX_CRON_SECRET: TEST_SECRET }, mockResponse(200, { processed: 3, results: [{}, {}, {}] }));
  const emailLog = findLogByConsumer('ok', 'notification');
  const pushLog = findLogByConsumer('ok', 'push');
  assert.ok(emailLog);
  assert.ok(pushLog);
  assert.strictEqual(emailLog.processed, 3);
  assert.strictEqual(pushLog.processed, 3);
  assert.strictEqual(emailLog.results_count, 3);
  assert.strictEqual(pushLog.results_count, 3);
  assertNoSecretInLogs();
});

await t('T9 401 => exactly 2 fetches, both critical_auth_failure', async () => {
  await runTest({ NOTIFICATION_SCHEDULER_ENABLED: 'true', OUTBOX_CRON_SECRET: TEST_SECRET }, mockResponse(401, { error: 'unauthorized' }));
  assert.strictEqual(fetchCalls.length, 2);
  assert.ok(findLogByConsumer('critical_auth_failure', 'notification'));
  assert.ok(findLogByConsumer('critical_auth_failure', 'push'));
  assertNoSecretInLogs();
});

await t('T10 403 => exactly 2 fetches, both critical_auth_failure', async () => {
  await runTest({ NOTIFICATION_SCHEDULER_ENABLED: 'true', OUTBOX_CRON_SECRET: TEST_SECRET }, mockResponse(403, { error: 'forbidden' }));
  assert.strictEqual(fetchCalls.length, 2);
  assert.ok(findLogByConsumer('critical_auth_failure', 'notification'));
  assert.ok(findLogByConsumer('critical_auth_failure', 'push'));
  assertNoSecretInLogs();
});

await t('T11 429 => exactly 2 fetches, both rate_limited', async () => {
  await runTest({ NOTIFICATION_SCHEDULER_ENABLED: 'true', OUTBOX_CRON_SECRET: TEST_SECRET }, mockResponse(429, { error: 'rate limit' }));
  assert.strictEqual(fetchCalls.length, 2);
  assert.ok(findLogByConsumer('rate_limited', 'notification'));
  assert.ok(findLogByConsumer('rate_limited', 'push'));
  assertNoSecretInLogs();
});

await t('T12 500 => exactly 2 fetches, both consumer_error', async () => {
  await runTest({ NOTIFICATION_SCHEDULER_ENABLED: 'true', OUTBOX_CRON_SECRET: TEST_SECRET }, mockResponse(500, { error: 'boom' }));
  assert.strictEqual(fetchCalls.length, 2);
  assert.ok(findLogByConsumer('consumer_error', 'notification'));
  assert.ok(findLogByConsumer('consumer_error', 'push'));
  assertNoSecretInLogs();
});

await t('T13 network exception => exactly 2 fetches, both network_error', async () => {
  await runTest({ NOTIFICATION_SCHEDULER_ENABLED: 'true', OUTBOX_CRON_SECRET: TEST_SECRET }, async (url, init) => { fetchCalls.push({ url, init }); throw new TypeError('fetch failed'); });
  assert.strictEqual(fetchCalls.length, 2);
  const emailLog = findLogByConsumer('network_error', 'notification');
  const pushLog = findLogByConsumer('network_error', 'push');
  assert.ok(emailLog);
  assert.ok(pushLog);
  assert.strictEqual(emailLog.error_class, 'TypeError');
  assert.strictEqual(pushLog.error_class, 'TypeError');
  assertNoSecretInLogs();
});

await t('T14 timeout => exactly 2 fetches, both timeout_ambiguous', async () => {
  const timeoutFetch = async (url, init) => {
    fetchCalls.push({ url, init });
    return new Promise((_, reject) => {
      if (init.signal && init.signal.aborted) {
        const err = new Error('aborted');
        err.name = 'AbortError';
        reject(err);
      } else if (init.signal) {
        const onAbort = () => {
          const err = new Error('aborted');
          err.name = 'AbortError';
          reject(err);
        };
        init.signal.addEventListener('abort', onAbort);
      }
    });
  };
  await runTest({ NOTIFICATION_SCHEDULER_ENABLED: 'true', OUTBOX_CRON_SECRET: TEST_SECRET }, timeoutFetch, true);
  assert.strictEqual(fetchCalls.length, 2);
  assert.strictEqual(capturedSetTimeout.delay, 30000);
  assert.ok(findLogByConsumer('timeout_ambiguous', 'notification'));
  assert.ok(findLogByConsumer('timeout_ambiguous', 'push'));
  assertNoSecretInLogs();
});

await t('T15 malformed JSON => no extra fetches, both ok', async () => {
  await runTest({ NOTIFICATION_SCHEDULER_ENABLED: 'true', OUTBOX_CRON_SECRET: TEST_SECRET }, mockResponse(200, 'this is not json', { 'Content-Type': 'text/plain' }));
  assert.strictEqual(fetchCalls.length, 2);
  const emailLog = findLogByConsumer('ok', 'notification');
  const pushLog = findLogByConsumer('ok', 'push');
  assert.ok(emailLog);
  assert.ok(pushLog);
  assert.strictEqual(emailLog.processed, null);
  assert.strictEqual(pushLog.processed, null);
  assertNoSecretInLogs();
});

await t('T16 secret absent from logs', async () => {
  await runTest({ NOTIFICATION_SCHEDULER_ENABLED: 'true', OUTBOX_CRON_SECRET: TEST_SECRET }, mockResponse(200, { processed: 0, results: [] }));
  const text = allLogsAsString();
  assert.strictEqual(text.includes(TEST_SECRET), false);
  assertNoSecretInLogs();
});

await t('T17 request headers absent from logs', async () => {
  await runTest({ NOTIFICATION_SCHEDULER_ENABLED: 'true', OUTBOX_CRON_SECRET: TEST_SECRET }, mockResponse(200, { processed: 0, results: [] }));
  const text = allLogsAsString();
  assert.strictEqual(text.includes('x-cron-secret'), false);
  assert.strictEqual(text.includes('headers'), false);
  assertNoSecretInLogs();
});

await t('T18 disabled scheduler never touches network', async () => {
  let called = false;
  await runTest({ NOTIFICATION_SCHEDULER_ENABLED: 'false' }, () => { called = true; throw new Error('network touched'); });
  assert.strictEqual(called, false);
  assert.ok(findLog('scheduler_disabled'));
});

await t('T19 arbitrary target URL cannot be injected in Production mode', async () => {
  // Production mode must ignore OUTBOX_CONSUMER_URL and use canonical targets.
  await runTest({
    NOTIFICATION_SCHEDULER_ENABLED: 'true',
    OUTBOX_CRON_SECRET: TEST_SECRET,
    OUTBOX_CONSUMER_URL: 'http://evil.example.com/api/process-notification-outbox'
  }, mockResponse(200, { processed: 0, results: [] }));
  assert.strictEqual(fetchCalls.length, 2);
  assert.strictEqual(fetchCalls[0].url, PRODUCTION_EMAIL_TARGET);
  assert.strictEqual(fetchCalls[1].url, PRODUCTION_PUSH_TARGET);
  assert.ok(findLogByConsumer('ok', 'notification'));
  assert.ok(findLogByConsumer('ok', 'push'));
  assertNoSecretInLogs();

  // Local mode must reject non-localhost URL.
  fetchCalls = [];
  consoleCalls = [];
  installLogCapture();
  installFetch(() => { throw new Error('should not fetch'); });
  try {
    await runWorker({
      NOTIFICATION_SCHEDULER_ENABLED: 'true',
      OUTBOX_CRON_SECRET: TEST_SECRET,
      ENVIRONMENT: 'local',
      OUTBOX_CONSUMER_URL: 'http://evil.example.com/api/process-notification-outbox'
    });
  } finally {
    restoreFetch();
    restoreLogCapture();
  }
  assert.strictEqual(fetchCalls.length, 0);
  assert.ok(findLog('target_error'));
});

await t('T20 activation config has exactly one Cron: "* * * * *"', async () => {
  const config = parseJsonc(join(__dirname, '..', 'wrangler-scheduler.jsonc'));
  assert.ok(Array.isArray(config.triggers.crons), 'triggers.crons missing');
  assert.strictEqual(config.triggers.crons.length, 1, 'cron count not 1');
  assert.strictEqual(config.triggers.crons[0], '* * * * *', 'cron expression mismatch');
});

await t('T21 vars.NOTIFICATION_SCHEDULER_ENABLED === "true"', async () => {
  const config = parseJsonc(join(__dirname, '..', 'wrangler-scheduler.jsonc'));
  assert.strictEqual(config.vars.NOTIFICATION_SCHEDULER_ENABLED, 'true', 'scheduler not enabled');
});

await t('T22 secrets.required is exactly ["OUTBOX_CRON_SECRET"]', async () => {
  const config = parseJsonc(join(__dirname, '..', 'wrangler-scheduler.jsonc'));
  assert.ok(Array.isArray(config.secrets.required), 'secrets.required missing');
  assert.deepStrictEqual(config.secrets.required, ['OUTBOX_CRON_SECRET'], 'required secret mismatch');
});

await t('T23 exposure hardening: workers_dev=false, preview_urls=false, no routes', async () => {
  const config = parseJsonc(join(__dirname, '..', 'wrangler-scheduler.jsonc'));
  assert.strictEqual(config.workers_dev, false, 'workers_dev not false');
  assert.strictEqual(config.preview_urls, false, 'preview_urls not false');
  assert.strictEqual('routes' in config, false, 'routes key must not exist');
});

// =========================================================
// H2D-E2 — DUAL CONSUMER TESTS
// =========================================================

await t('T24 one scheduled event invokes exactly 2 endpoints', async () => {
  await runTest({ NOTIFICATION_SCHEDULER_ENABLED: 'true', OUTBOX_CRON_SECRET: TEST_SECRET }, mockResponse(200, { processed: 0, results: [] }));
  assert.strictEqual(fetchCalls.length, 2, 'expected exactly 2 fetch calls');
});

await t('T25 notification endpoint URL is correct (production)', async () => {
  await runTest({ NOTIFICATION_SCHEDULER_ENABLED: 'true', OUTBOX_CRON_SECRET: TEST_SECRET }, mockResponse(200, { processed: 0, results: [] }));
  const emailCall = findCall('process-notification-outbox');
  assert.ok(emailCall, 'notification endpoint not called');
  assert.strictEqual(emailCall.url, PRODUCTION_EMAIL_TARGET);
});

await t('T26 push endpoint URL is correct (production)', async () => {
  await runTest({ NOTIFICATION_SCHEDULER_ENABLED: 'true', OUTBOX_CRON_SECRET: TEST_SECRET }, mockResponse(200, { processed: 0, results: [] }));
  const pushCall = findCall('process-push-outbox');
  assert.ok(pushCall, 'push endpoint not called');
  assert.strictEqual(pushCall.url, PRODUCTION_PUSH_TARGET);
});

await t('T27 email 500 does not suppress push invocation', async () => {
  await runTest(
    { NOTIFICATION_SCHEDULER_ENABLED: 'true', OUTBOX_CRON_SECRET: TEST_SECRET },
    mockMultiResponse(ERR_500, OK_RESP)
  );
  assert.strictEqual(fetchCalls.length, 2);
  assert.ok(findLogByConsumer('consumer_error', 'notification'), 'email should log consumer_error');
  assert.ok(findLogByConsumer('ok', 'push'), 'push should log ok');
  // Verify push was actually called
  const pushCall = findCall('process-push-outbox');
  assert.ok(pushCall, 'push endpoint must still be called despite email 500');
});

await t('T28 push 500 does not suppress email invocation', async () => {
  await runTest(
    { NOTIFICATION_SCHEDULER_ENABLED: 'true', OUTBOX_CRON_SECRET: TEST_SECRET },
    mockMultiResponse(OK_RESP, ERR_500)
  );
  assert.strictEqual(fetchCalls.length, 2);
  assert.ok(findLogByConsumer('ok', 'notification'), 'email should log ok');
  assert.ok(findLogByConsumer('consumer_error', 'push'), 'push should log consumer_error');
  // Verify email was actually called
  const emailCall = findCall('process-notification-outbox');
  assert.ok(emailCall, 'email endpoint must still be called despite push 500');
});

await t('T29 email network exception does not suppress push', async () => {
  await runTest(
    { NOTIFICATION_SCHEDULER_ENABLED: 'true', OUTBOX_CRON_SECRET: TEST_SECRET },
    mockMultiThrow(() => new TypeError('email network failed'), null)
  );
  assert.strictEqual(fetchCalls.length, 2);
  assert.ok(findLogByConsumer('network_error', 'notification'), 'email should log network_error');
  assert.ok(findLogByConsumer('ok', 'push'), 'push should log ok');
  const pushCall = findCall('process-push-outbox');
  assert.ok(pushCall, 'push endpoint must still be called despite email network error');
});

await t('T30 push network exception does not suppress email', async () => {
  await runTest(
    { NOTIFICATION_SCHEDULER_ENABLED: 'true', OUTBOX_CRON_SECRET: TEST_SECRET },
    mockMultiThrow(null, () => new TypeError('push network failed'))
  );
  assert.strictEqual(fetchCalls.length, 2);
  assert.ok(findLogByConsumer('ok', 'notification'), 'email should log ok');
  assert.ok(findLogByConsumer('network_error', 'push'), 'push should log network_error');
  const emailCall = findCall('process-notification-outbox');
  assert.ok(emailCall, 'email endpoint must still be called despite push network error');
});

await t('T31 exactly one push-consumer call per scheduler tick', async () => {
  await runTest({ NOTIFICATION_SCHEDULER_ENABLED: 'true', OUTBOX_CRON_SECRET: TEST_SECRET }, mockResponse(200, { processed: 0, results: [] }));
  const pushCalls = fetchCalls.filter(c => c.url.includes('process-push-outbox'));
  assert.strictEqual(pushCalls.length, 1, 'expected exactly 1 push consumer call');
});

await t('T32 no accidental duplicate email-consumer call', async () => {
  await runTest({ NOTIFICATION_SCHEDULER_ENABLED: 'true', OUTBOX_CRON_SECRET: TEST_SECRET }, mockResponse(200, { processed: 0, results: [] }));
  const emailCalls = fetchCalls.filter(c => c.url.includes('process-notification-outbox'));
  assert.strictEqual(emailCalls.length, 1, 'expected exactly 1 email consumer call');
});

await t('T33 local mode derives push URL from email URL (path replacement)', async () => {
  await runTest(
    {
      NOTIFICATION_SCHEDULER_ENABLED: 'true',
      OUTBOX_CRON_SECRET: TEST_SECRET,
      ENVIRONMENT: 'local',
      OUTBOX_CONSUMER_URL: 'http://127.0.0.1:8788/api/process-notification-outbox'
    },
    mockResponse(200, { processed: 0, results: [] })
  );
  assert.strictEqual(fetchCalls.length, 2);
  assert.strictEqual(fetchCalls[0].url, 'http://127.0.0.1:8788/api/process-notification-outbox');
  assert.strictEqual(fetchCalls[1].url, 'http://127.0.0.1:8788/api/process-push-outbox');
});

await t('T34 local mode derives push URL from origin fallback', async () => {
  await runTest(
    {
      NOTIFICATION_SCHEDULER_ENABLED: 'true',
      OUTBOX_CRON_SECRET: TEST_SECRET,
      ENVIRONMENT: 'local',
      OUTBOX_CONSUMER_URL: 'http://127.0.0.1:8788/mock'
    },
    mockResponse(200, { processed: 0, results: [] })
  );
  assert.strictEqual(fetchCalls.length, 2);
  assert.strictEqual(fetchCalls[0].url, 'http://127.0.0.1:8788/mock');
  assert.strictEqual(fetchCalls[1].url, 'http://127.0.0.1:8788/api/process-push-outbox');
});

await t('T35 local mode rejects evil push URL (same host check)', async () => {
  // If email URL is evil, entire target resolution fails — neither consumer called
  fetchCalls = [];
  consoleCalls = [];
  installLogCapture();
  installFetch(() => { throw new Error('should not fetch'); });
  try {
    await runWorker({
      NOTIFICATION_SCHEDULER_ENABLED: 'true',
      OUTBOX_CRON_SECRET: TEST_SECRET,
      ENVIRONMENT: 'local',
      OUTBOX_CONSUMER_URL: 'http://evil.example.com/api/process-notification-outbox'
    });
  } finally {
    restoreFetch();
    restoreLogCapture();
  }
  assert.strictEqual(fetchCalls.length, 0);
  assert.ok(findLog('target_error'));
});

await t('T36 both consumers logged with consumer field for observability', async () => {
  await runTest({ NOTIFICATION_SCHEDULER_ENABLED: 'true', OUTBOX_CRON_SECRET: TEST_SECRET }, mockResponse(200, { processed: 0, results: [] }));
  const emailLog = findLogByConsumer('ok', 'notification');
  const pushLog = findLogByConsumer('ok', 'push');
  assert.ok(emailLog, 'notification consumer log must have consumer field');
  assert.ok(pushLog, 'push consumer log must have consumer field');
  assert.strictEqual(emailLog.consumer, 'notification');
  assert.strictEqual(pushLog.consumer, 'push');
});

// =========================================================
// SUMMARY
// =========================================================

console.log('\n=== RESULTS ===');
console.log(`PASS: ${results.pass}`);
console.log(`FAIL: ${results.fail}`);
if (results.fail > 0) {
  process.exitCode = 1;
}
