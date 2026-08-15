// PROD-1D-C.2 — Local unit/integration tests for the notification scheduler Worker.
//
// NO remote calls.
// NO real secrets.
// NO provider or Resend interaction.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import scheduler from '../src/workers/notification-scheduler.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const TEST_SECRET = 'test-local-secret-64-char-alpha-numeric-00000000000000000000001';
const PRODUCTION_TARGET = 'https://www.bathily-convoyage.fr/api/process-notification-outbox';

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

await t('T3 enabled + valid secret => exactly 1 fetch', async () => {
  await runTest({ NOTIFICATION_SCHEDULER_ENABLED: 'true', OUTBOX_CRON_SECRET: TEST_SECRET }, mockResponse(200, { processed: 0, results: [] }));
  assert.strictEqual(fetchCalls.length, 1);
  assert.ok(findLog('ok'));
  assertNoSecretInLogs();
});

await t('T4 exact method POST', async () => {
  await runTest({ NOTIFICATION_SCHEDULER_ENABLED: 'true', OUTBOX_CRON_SECRET: TEST_SECRET }, mockResponse(200, { processed: 0, results: [] }));
  assert.strictEqual(fetchCalls[0].init.method, 'POST');
  assertNoSecretInLogs();
});

await t('T5 exact header x-cron-secret', async () => {
  await runTest({ NOTIFICATION_SCHEDULER_ENABLED: 'true', OUTBOX_CRON_SECRET: TEST_SECRET }, mockResponse(200, { processed: 0, results: [] }));
  assert.strictEqual(fetchCalls[0].init.headers['x-cron-secret'], TEST_SECRET);
  assertNoSecretInLogs();
});

await t('T6 header value correct internally without printing it', async () => {
  await runTest({ NOTIFICATION_SCHEDULER_ENABLED: 'true', OUTBOX_CRON_SECRET: TEST_SECRET }, mockResponse(200, { processed: 0, results: [] }));
  assert.strictEqual(fetchCalls[0].init.headers['x-cron-secret'], TEST_SECRET);
  const text = allLogsAsString();
  assert.strictEqual(text.includes(TEST_SECRET), false);
  assertNoSecretInLogs();
});

await t('T7 HTTP 200 + processed 0 => PASS', async () => {
  await runTest({ NOTIFICATION_SCHEDULER_ENABLED: 'true', OUTBOX_CRON_SECRET: TEST_SECRET }, mockResponse(200, { processed: 0, results: [] }));
  const log = findLog('ok');
  assert.ok(log);
  assert.strictEqual(log.processed, 0);
  assert.strictEqual(log.results_count, 0);
  assert.strictEqual(log.http_status, 200);
  assertNoSecretInLogs();
});

await t('T8 HTTP 200 + processed >0 => log correctly', async () => {
  await runTest({ NOTIFICATION_SCHEDULER_ENABLED: 'true', OUTBOX_CRON_SECRET: TEST_SECRET }, mockResponse(200, { processed: 3, results: [{}, {}, {}] }));
  const log = findLog('ok');
  assert.ok(log);
  assert.strictEqual(log.processed, 3);
  assert.strictEqual(log.results_count, 3);
  assertNoSecretInLogs();
});

await t('T9 401 => exactly 1 fetch', async () => {
  await runTest({ NOTIFICATION_SCHEDULER_ENABLED: 'true', OUTBOX_CRON_SECRET: TEST_SECRET }, mockResponse(401, { error: 'unauthorized' }));
  assert.strictEqual(fetchCalls.length, 1);
  assert.ok(findLog('critical_auth_failure'));
  assertNoSecretInLogs();
});

await t('T10 403 => exactly 1 fetch', async () => {
  await runTest({ NOTIFICATION_SCHEDULER_ENABLED: 'true', OUTBOX_CRON_SECRET: TEST_SECRET }, mockResponse(403, { error: 'forbidden' }));
  assert.strictEqual(fetchCalls.length, 1);
  assert.ok(findLog('critical_auth_failure'));
  assertNoSecretInLogs();
});

await t('T11 429 => exactly 1 fetch', async () => {
  await runTest({ NOTIFICATION_SCHEDULER_ENABLED: 'true', OUTBOX_CRON_SECRET: TEST_SECRET }, mockResponse(429, { error: 'rate limit' }));
  assert.strictEqual(fetchCalls.length, 1);
  assert.ok(findLog('rate_limited'));
  assertNoSecretInLogs();
});

await t('T12 500 => exactly 1 fetch', async () => {
  await runTest({ NOTIFICATION_SCHEDULER_ENABLED: 'true', OUTBOX_CRON_SECRET: TEST_SECRET }, mockResponse(500, { error: 'boom' }));
  assert.strictEqual(fetchCalls.length, 1);
  assert.ok(findLog('consumer_error'));
  assertNoSecretInLogs();
});

await t('T13 network exception => exactly 1 fetch', async () => {
  await runTest({ NOTIFICATION_SCHEDULER_ENABLED: 'true', OUTBOX_CRON_SECRET: TEST_SECRET }, async (url, init) => { fetchCalls.push({ url, init }); throw new TypeError('fetch failed'); });
  assert.strictEqual(fetchCalls.length, 1);
  const log = findLog('network_error');
  assert.ok(log);
  assert.strictEqual(log.error_class, 'TypeError');
  assertNoSecretInLogs();
});

await t('T14 timeout => exactly 1 fetch', async () => {
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
  assert.strictEqual(fetchCalls.length, 1);
  assert.strictEqual(capturedSetTimeout.delay, 30000);
  assert.ok(findLog('timeout_ambiguous'));
  assertNoSecretInLogs();
});

await t('T15 malformed JSON => no second fetch', async () => {
  await runTest({ NOTIFICATION_SCHEDULER_ENABLED: 'true', OUTBOX_CRON_SECRET: TEST_SECRET }, mockResponse(200, 'this is not json', { 'Content-Type': 'text/plain' }));
  assert.strictEqual(fetchCalls.length, 1);
  const log = findLog('ok');
  assert.ok(log);
  assert.strictEqual(log.processed, null);
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
  // Production mode must ignore OUTBOX_CONSUMER_URL and use canonical target.
  await runTest({
    NOTIFICATION_SCHEDULER_ENABLED: 'true',
    OUTBOX_CRON_SECRET: TEST_SECRET,
    OUTBOX_CONSUMER_URL: 'http://evil.example.com/api/process-notification-outbox'
  }, mockResponse(200, { processed: 0, results: [] }));
  assert.strictEqual(fetchCalls.length, 1);
  assert.strictEqual(fetchCalls[0].url, PRODUCTION_TARGET);
  assert.ok(findLog('ok'));
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
// SUMMARY
// =========================================================

console.log('\n=== RESULTS ===');
console.log(`PASS: ${results.pass}`);
console.log(`FAIL: ${results.fail}`);
if (results.fail > 0) {
  process.exitCode = 1;
}
