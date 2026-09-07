// P3-B2.3A2 — Durable test for fetch-based web push transport adapter.
// Tests:
// - Synthetic subscription generation
// - Request build via generateRequestDetails (public API)
// - Fetch POST to local mock server
// - Required headers (Authorization, TTL, Content-Encoding, Urgency)
// - Non-empty encrypted payload
// - Response classification (2xx, 404, 410, 429, 5xx, network error)
// - No https.request usage
// - Request equivalence between buildWebPushRequest and generateRequestDetails

import { test } from 'node:test';
import assert from 'node:assert';
import http from 'node:http';
import crypto from 'node:crypto';
import { buildWebPushRequest, sendWebPush, classifyPushResponse, webpush } from '../functions/_push.js';

// ── Helpers ──

function generateTestVapidKeys() {
  return webpush.generateVAPIDKeys();
}

function generateSyntheticSubscription(endpoint) {
  const ecdh = crypto.createECDH('prime256v1');
  ecdh.generateKeys();
  const p256dh = ecdh.getPublicKey().toString('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const auth = crypto.randomBytes(16).toString('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  return { endpoint, keys: { p256dh, auth } };
}

function startMockServer(responses) {
  // responses: array of { status, headers?, body? } to return sequentially
  let callIndex = 0;
  let lastRequest = null;

  const server = http.createServer((req, res) => {
    let body = [];
    req.on('data', (chunk) => body.push(chunk));
    req.on('end', () => {
      lastRequest = {
        method: req.method,
        url: req.url,
        headers: req.headers,
        bodyLength: Buffer.concat(body).length,
      };

      const response = responses[Math.min(callIndex, responses.length - 1)];
      callIndex++;

      const headers = response.headers || { 'Content-Type': 'text/plain' };
      res.writeHead(response.status, headers);
      res.end(response.body || '');
    });
  });

  return {
    server,
    getLastRequest: () => lastRequest,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

// ── Tests ──

test('web-push generateVAPIDKeys produces valid keys', () => {
  const keys = generateTestVapidKeys();
  assert.ok(keys.publicKey.length > 80, 'publicKey ~87 chars');
  assert.ok(keys.privateKey.length > 40, 'privateKey ~43 chars');
});

test('crypto.createECDH prime256v1 generates valid p256dh', () => {
  const ecdh = crypto.createECDH('prime256v1');
  ecdh.generateKeys();
  const pubKey = ecdh.getPublicKey();
  assert.equal(pubKey.length, 65, 'uncompressed P-256 public key is 65 bytes');
  assert.equal(pubKey[0], 0x04, 'starts with 0x04');
});

test('buildWebPushRequest produces correct method, endpoint, headers, body', () => {
  const keys = generateTestVapidKeys();
  webpush.setVapidDetails('mailto:test@bathily-convoyage.invalid', keys.publicKey, keys.privateKey);

  const sub = generateSyntheticSubscription('https://127.0.0.1:1/push');
  const payload = JSON.stringify({ title: 'Test', body: 'Test', url: '/' });

  const req = buildWebPushRequest(sub, payload, { TTL: 60 });

  assert.equal(req.method, 'POST');
  assert.equal(req.endpoint, 'https://127.0.0.1:1/push');
  assert.ok(req.headers['Authorization'], 'VAPID Authorization header present');
  assert.equal(req.headers['TTL'], 60);
  assert.equal(req.headers['Content-Encoding'], 'aes128gcm');
  assert.equal(req.headers['Content-Type'], 'application/octet-stream');
  assert.equal(req.headers['Urgency'], 'normal');
  assert.ok(req.body, 'encrypted body exists');
  assert.ok(req.body.length > 0, 'encrypted body is non-empty');
});

test('buildWebPushRequest is equivalent to web-push generateRequestDetails', () => {
  const keys = generateTestVapidKeys();
  webpush.setVapidDetails('mailto:test@bathily-convoyage.invalid', keys.publicKey, keys.privateKey);

  const sub = generateSyntheticSubscription('https://127.0.0.1:1/push');
  const payload = JSON.stringify({ title: 'Test', body: 'Test', url: '/' });
  const options = { TTL: 60 };

  // PATH_A: direct generateRequestDetails
  const direct = webpush.generateRequestDetails(sub, payload, options);

  // PATH_B: adapter buildWebPushRequest
  const adapter = buildWebPushRequest(sub, payload, options);

  // Method and endpoint are deterministic
  assert.equal(adapter.method, direct.method);
  assert.equal(adapter.endpoint, direct.endpoint);

  // Headers: TTL, Content-Encoding, Content-Type, Urgency are deterministic
  assert.equal(adapter.headers['TTL'], direct.headers['TTL']);
  assert.equal(adapter.headers['Content-Encoding'], direct.headers['Content-Encoding']);
  assert.equal(adapter.headers['Content-Type'], direct.headers['Content-Type']);
  assert.equal(adapter.headers['Urgency'], direct.headers['Urgency']);

  // Authorization header: VAPID JWT contains an exp claim that changes per
  // invocation, so we compare structure (starts with 'vapid t=') not exact value.
  assert.ok(adapter.headers['Authorization'].startsWith('vapid t='),
    'adapter Authorization is VAPID format');
  assert.ok(direct.headers['Authorization'].startsWith('vapid t='),
    'direct Authorization is VAPID format');

  // Body: encryption uses a random salt + ephemeral ECDH key, so the ciphertext
  // differs per invocation. Compare length (same payload → same ciphertext length).
  assert.equal(adapter.body.length, direct.body.length,
    'body length matches for same payload');
});

test('sendWebPush sends POST to mock server and receives 201', async () => {
  const keys = generateTestVapidKeys();
  webpush.setVapidDetails('mailto:test@bathily-convoyage.invalid', keys.publicKey, keys.privateKey);

  const mock = startMockServer([{ status: 201, body: 'OK' }]);

  await new Promise((resolve) => mock.server.listen(0, '127.0.0.1', resolve));
  const port = mock.server.address().port;
  const endpoint = `http://127.0.0.1:${port}/push`;

  const sub = generateSyntheticSubscription(endpoint);
  const payload = JSON.stringify({ title: 'Test', body: 'Test', url: '/' });

  const result = await sendWebPush(sub, payload, { TTL: 60 });

  assert.ok(result.ok, '201 should be ok');
  assert.equal(result.status, 201);
  assert.equal(result.classification, 'success');

  const lastReq = mock.getLastRequest();
  assert.equal(lastReq.method, 'POST');
  assert.ok(lastReq.bodyLength > 0, 'mock received non-empty body');

  await mock.close();
});

test('sendWebPush headers reach mock server correctly', async () => {
  const keys = generateTestVapidKeys();
  webpush.setVapidDetails('mailto:test@bathily-convoyage.invalid', keys.publicKey, keys.privateKey);

  const mock = startMockServer([{ status: 201 }]);
  await new Promise((resolve) => mock.server.listen(0, '127.0.0.1', resolve));
  const port = mock.server.address().port;
  const endpoint = `http://127.0.0.1:${port}/push`;

  const sub = generateSyntheticSubscription(endpoint);
  const payload = JSON.stringify({ title: 'Test', body: 'Test', url: '/' });

  await sendWebPush(sub, payload, { TTL: 120 });

  const lastReq = mock.getLastRequest();
  assert.ok(lastReq.headers['authorization'], 'Authorization header received by mock');
  assert.equal(lastReq.headers['ttl'], '120', 'TTL header received by mock');
  assert.equal(lastReq.headers['content-encoding'], 'aes128gcm');
  assert.equal(lastReq.headers['content-type'], 'application/octet-stream');

  await mock.close();
});

test('classifyPushResponse: 2xx → success', () => {
  assert.equal(classifyPushResponse(200, {}), 'success');
  assert.equal(classifyPushResponse(201, {}), 'success');
});

test('classifyPushResponse: 404 → stale_subscription', () => {
  assert.equal(classifyPushResponse(404, {}), 'stale_subscription');
});

test('classifyPushResponse: 410 → stale_subscription', () => {
  assert.equal(classifyPushResponse(410, {}), 'stale_subscription');
});

test('classifyPushResponse: 429 → retryable', () => {
  assert.equal(classifyPushResponse(429, {}), 'retryable');
});

test('classifyPushResponse: 5xx → retryable', () => {
  assert.equal(classifyPushResponse(500, {}), 'retryable');
  assert.equal(classifyPushResponse(503, {}), 'retryable');
});

test('classifyPushResponse: 400/401/403 → terminal_failed', () => {
  assert.equal(classifyPushResponse(400, {}), 'terminal_failed');
  assert.equal(classifyPushResponse(401, {}), 'terminal_failed');
  assert.equal(classifyPushResponse(403, {}), 'terminal_failed');
});

test('sendWebPush classifies 404 as stale_subscription', async () => {
  const keys = generateTestVapidKeys();
  webpush.setVapidDetails('mailto:test@bathily-convoyage.invalid', keys.publicKey, keys.privateKey);

  const mock = startMockServer([{ status: 404, body: 'Not Found' }]);
  await new Promise((resolve) => mock.server.listen(0, '127.0.0.1', resolve));
  const port = mock.server.address().port;

  const sub = generateSyntheticSubscription(`http://127.0.0.1:${port}/push`);
  const result = await sendWebPush(sub, JSON.stringify({ title: 'T' }), { TTL: 60 });

  assert.equal(result.ok, false);
  assert.equal(result.status, 404);
  assert.equal(result.classification, 'stale_subscription');

  await mock.close();
});

test('sendWebPush classifies 410 as stale_subscription', async () => {
  const keys = generateTestVapidKeys();
  webpush.setVapidDetails('mailto:test@bathily-convoyage.invalid', keys.publicKey, keys.privateKey);

  const mock = startMockServer([{ status: 410, body: 'Gone' }]);
  await new Promise((resolve) => mock.server.listen(0, '127.0.0.1', resolve));
  const port = mock.server.address().port;

  const sub = generateSyntheticSubscription(`http://127.0.0.1:${port}/push`);
  const result = await sendWebPush(sub, JSON.stringify({ title: 'T' }), { TTL: 60 });

  assert.equal(result.status, 410);
  assert.equal(result.classification, 'stale_subscription');

  await mock.close();
});

test('sendWebPush classifies 429 as retryable and parses Retry-After', async () => {
  const keys = generateTestVapidKeys();
  webpush.setVapidDetails('mailto:test@bathily-convoyage.invalid', keys.publicKey, keys.privateKey);

  const mock = startMockServer([{ status: 429, headers: { 'Retry-After': '30' } }]);
  await new Promise((resolve) => mock.server.listen(0, '127.0.0.1', resolve));
  const port = mock.server.address().port;

  const sub = generateSyntheticSubscription(`http://127.0.0.1:${port}/push`);
  const result = await sendWebPush(sub, JSON.stringify({ title: 'T' }), { TTL: 60 });

  assert.equal(result.status, 429);
  assert.equal(result.classification, 'retryable');
  assert.equal(result.retryAfter, 30);

  await mock.close();
});

test('sendWebPush classifies 500 as retryable', async () => {
  const keys = generateTestVapidKeys();
  webpush.setVapidDetails('mailto:test@bathily-convoyage.invalid', keys.publicKey, keys.privateKey);

  const mock = startMockServer([{ status: 503, body: 'Service Unavailable' }]);
  await new Promise((resolve) => mock.server.listen(0, '127.0.0.1', resolve));
  const port = mock.server.address().port;

  const sub = generateSyntheticSubscription(`http://127.0.0.1:${port}/push`);
  const result = await sendWebPush(sub, JSON.stringify({ title: 'T' }), { TTL: 60 });

  assert.equal(result.status, 503);
  assert.equal(result.classification, 'retryable');

  await mock.close();
});

test('sendWebPush classifies network error as ambiguous_retryable', async () => {
  const keys = generateTestVapidKeys();
  webpush.setVapidDetails('mailto:test@bathily-convoyage.invalid', keys.publicKey, keys.privateKey);

  // Use a non-listening port — connection refused
  const sub = generateSyntheticSubscription('http://127.0.0.1:1/push');
  const result = await sendWebPush(sub, JSON.stringify({ title: 'T' }), { TTL: 60 });

  assert.equal(result.ok, false);
  assert.equal(result.status, null);
  assert.equal(result.classification, 'ambiguous_retryable');
  assert.ok(result.error, 'error message present');
});

test('no https.request is called by the adapter', async () => {
  // Verify that sendWebPush uses fetch, not https.request.
  // We intercept https.request to detect if it's called.
  const https = await import('node:https');
  const originalRequest = https.default.request;
  let httpsCalled = false;

  https.default.request = function() {
    httpsCalled = true;
    throw new Error('https.request should not be called');
  };

  try {
    const keys = generateTestVapidKeys();
    webpush.setVapidDetails('mailto:test@bathily-convoyage.invalid', keys.publicKey, keys.privateKey);

    const mock = startMockServer([{ status: 201 }]);
    await new Promise((resolve) => mock.server.listen(0, '127.0.0.1', resolve));
    const port = mock.server.address().port;

    const sub = generateSyntheticSubscription(`http://127.0.0.1:${port}/push`);
    await sendWebPush(sub, JSON.stringify({ title: 'T' }), { TTL: 60 });

    assert.equal(httpsCalled, false, 'https.request was not called');

    await mock.close();
  } finally {
    https.default.request = originalRequest;
  }
});
