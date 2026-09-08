// P3-B2.3A2 — Durable test for Cloudflare-compatible web push transport adapter.
// Tests:
// - Synthetic subscription generation (WebCrypto, no crypto.createECDH)
// - Request build via RFC 8291 aes128gcm (async, WebCrypto-based)
// - Fetch POST to local mock server
// - Required headers (Authorization, TTL, Content-Encoding, Urgency)
// - Non-empty encrypted payload
// - Response classification (2xx, 404, 410, 429, 5xx, network error)
// - No https.request usage
// - No crypto.createECDH usage

import { test } from 'node:test';
import assert from 'node:assert';
import http from 'node:http';
import { buildWebPushRequest, sendWebPush, classifyPushResponse, webpush, generateVAPIDKeys } from '../functions/_push.js';

// ── Helpers ──

async function generateTestVapidKeys() {
  return generateVAPIDKeys();
}

async function generateSyntheticSubscription(endpoint) {
  // Generate P-256 ECDH key pair using WebCrypto (not crypto.createECDH)
  const keyPair = await crypto.subtle.generateKey(
    { name: 'ECDH', namedCurve: 'P-256' },
    true,
    ['deriveBits']
  );
  const publicRaw = await crypto.subtle.exportKey('raw', keyPair.publicKey);
  // Base64url encode the 65-byte uncompressed public key
  const p256dh = base64UrlEncode(publicRaw);
  // Generate 16-byte auth secret
  const authBytes = crypto.getRandomValues(new Uint8Array(16));
  const auth = base64UrlEncode(authBytes);
  return { endpoint, keys: { p256dh, auth }, _privateKey: keyPair.privateKey };
}

function base64UrlEncode(bytes) {
  const arr = new Uint8Array(bytes);
  let binary = '';
  for (let i = 0; i < arr.length; i++) binary += String.fromCharCode(arr[i]);
  const base64 = typeof btoa !== 'undefined'
    ? btoa(binary)
    : Buffer.from(binary, 'binary').toString('base64');
  return base64.replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}

function startMockServer(responses) {
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

test('generateVAPIDKeys produces valid keys (WebCrypto)', async () => {
  const keys = await generateTestVapidKeys();
  assert.ok(keys.publicKey.length > 80, 'publicKey ~87 chars');
  assert.ok(keys.privateKey.length > 40, 'privateKey ~43 chars');
});

test('WebCrypto ECDH P-256 generates valid p256dh (65 bytes uncompressed)', async () => {
  const keyPair = await crypto.subtle.generateKey(
    { name: 'ECDH', namedCurve: 'P-256' },
    true,
    ['deriveBits']
  );
  const pubKey = new Uint8Array(await crypto.subtle.exportKey('raw', keyPair.publicKey));
  assert.equal(pubKey.length, 65, 'uncompressed P-256 public key is 65 bytes');
  assert.equal(pubKey[0], 0x04, 'starts with 0x04');
});

test('buildWebPushRequest produces correct method, endpoint, headers, body', async () => {
  const keys = await generateTestVapidKeys();
  webpush.setVapidDetails('mailto:test@bathily-convoyage.invalid', keys.publicKey, keys.privateKey);

  const sub = await generateSyntheticSubscription('https://127.0.0.1:1/push');
  const payload = JSON.stringify({ title: 'Test', body: 'Test', url: '/' });

  const req = await buildWebPushRequest(sub, payload, { TTL: 60 });

  assert.equal(req.method, 'POST');
  assert.equal(req.endpoint, 'https://127.0.0.1:1/push');
  assert.ok(req.headers['Authorization'] || req.headers['authorization'], 'VAPID Authorization header present');
  assert.equal(req.headers['TTL'] || req.headers['ttl'], '60');
  assert.equal(req.headers['Content-Encoding'] || req.headers['content-encoding'], 'aes128gcm');
  assert.equal(req.headers['Content-Type'] || req.headers['content-type'], 'application/octet-stream');
  assert.ok(req.body, 'encrypted body exists');
  assert.ok(req.body.byteLength > 0, 'encrypted body is non-empty');
});

test('buildWebPushRequest encrypted body differs from plaintext', async () => {
  const keys = await generateTestVapidKeys();
  webpush.setVapidDetails('mailto:test@bathily-convoyage.invalid', keys.publicKey, keys.privateKey);

  const sub = await generateSyntheticSubscription('https://127.0.0.1:1/push');
  const payload = JSON.stringify({ title: 'Test', body: 'Test', url: '/' });

  const req = await buildWebPushRequest(sub, payload, { TTL: 60 });

  // Convert body to string for comparison
  const bodyStr = typeof req.body === 'string'
    ? req.body
    : new TextDecoder().decode(req.body);
  assert.ok(!bodyStr.includes('"title":"Test"'), 'plaintext must not appear in encrypted body');
  assert.ok(!bodyStr.includes('Test'), 'plaintext content must not appear in body');
});

test('buildWebPushRequest does NOT emit legacy Encryption header', async () => {
  const keys = await generateTestVapidKeys();
  webpush.setVapidDetails('mailto:test@bathily-convoyage.invalid', keys.publicKey, keys.privateKey);

  const sub = await generateSyntheticSubscription('https://127.0.0.1:1/push');
  const payload = JSON.stringify({ title: 'Test', body: 'Test', url: '/' });

  const req = await buildWebPushRequest(sub, payload, { TTL: 60 });

  // RFC 8291 aes128gcm does NOT use separate Encryption/Crypto-Key headers
  assert.ok(!req.headers['Encryption'] && !req.headers['encryption'],
    'must NOT emit legacy Encryption header (salt is in body)');
  assert.ok(!req.headers['Crypto-Key'] && !req.headers['crypto-key'],
    'must NOT emit legacy Crypto-Key dh header (key is in body)');
});

test('buildWebPushRequest body has RFC 8188 header structure', async () => {
  const keys = await generateTestVapidKeys();
  webpush.setVapidDetails('mailto:test@bathily-convoyage.invalid', keys.publicKey, keys.privateKey);

  const sub = await generateSyntheticSubscription('https://127.0.0.1:1/push');
  const payload = JSON.stringify({ title: 'Test', body: 'Test', url: '/' });

  const req = await buildWebPushRequest(sub, payload, { TTL: 60 });
  const body = new Uint8Array(req.body);

  // RFC 8188: salt(16) || rs(4 BE) || idlen(1) || keyid(65) || ciphertext
  assert.ok(body.length >= 86, 'body must be at least 86-byte header + ciphertext');
  assert.equal(body[16], 0x00, 'rs high byte (4096 = 0x00001000 BE)');
  assert.equal(body[17], 0x00, 'rs byte 1');
  assert.equal(body[18], 0x10, 'rs byte 2 (0x10)');
  assert.equal(body[19], 0x00, 'rs low byte');
  assert.equal(body[20], 65, 'idlen must be 65 (uncompressed P-256)');
  assert.equal(body[21], 0x04, 'keyid must start with 0x04 (uncompressed point)');
});

test('sendWebPush sends POST to mock server and receives 201', async () => {
  const keys = await generateTestVapidKeys();
  webpush.setVapidDetails('mailto:test@bathily-convoyage.invalid', keys.publicKey, keys.privateKey);

  const mock = startMockServer([{ status: 201, body: 'OK' }]);

  await new Promise((resolve) => mock.server.listen(0, '127.0.0.1', resolve));
  const port = mock.server.address().port;
  const endpoint = `http://127.0.0.1:${port}/push`;

  const sub = await generateSyntheticSubscription(endpoint);
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
  const keys = await generateTestVapidKeys();
  webpush.setVapidDetails('mailto:test@bathily-convoyage.invalid', keys.publicKey, keys.privateKey);

  const mock = startMockServer([{ status: 201 }]);
  await new Promise((resolve) => mock.server.listen(0, '127.0.0.1', resolve));
  const port = mock.server.address().port;
  const endpoint = `http://127.0.0.1:${port}/push`;

  const sub = await generateSyntheticSubscription(endpoint);
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
  assert.equal(classifyPushResponse(202, {}), 'success');
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
  const keys = await generateTestVapidKeys();
  webpush.setVapidDetails('mailto:test@bathily-convoyage.invalid', keys.publicKey, keys.privateKey);

  const mock = startMockServer([{ status: 404, body: 'Not Found' }]);
  await new Promise((resolve) => mock.server.listen(0, '127.0.0.1', resolve));
  const port = mock.server.address().port;

  const sub = await generateSyntheticSubscription(`http://127.0.0.1:${port}/push`);
  const result = await sendWebPush(sub, JSON.stringify({ title: 'T' }), { TTL: 60 });

  assert.equal(result.ok, false);
  assert.equal(result.status, 404);
  assert.equal(result.classification, 'stale_subscription');

  await mock.close();
});

test('sendWebPush classifies 410 as stale_subscription', async () => {
  const keys = await generateTestVapidKeys();
  webpush.setVapidDetails('mailto:test@bathily-convoyage.invalid', keys.publicKey, keys.privateKey);

  const mock = startMockServer([{ status: 410, body: 'Gone' }]);
  await new Promise((resolve) => mock.server.listen(0, '127.0.0.1', resolve));
  const port = mock.server.address().port;

  const sub = await generateSyntheticSubscription(`http://127.0.0.1:${port}/push`);
  const result = await sendWebPush(sub, JSON.stringify({ title: 'T' }), { TTL: 60 });

  assert.equal(result.status, 410);
  assert.equal(result.classification, 'stale_subscription');

  await mock.close();
});

test('sendWebPush classifies 429 as retryable and parses Retry-After', async () => {
  const keys = await generateTestVapidKeys();
  webpush.setVapidDetails('mailto:test@bathily-convoyage.invalid', keys.publicKey, keys.privateKey);

  const mock = startMockServer([{ status: 429, headers: { 'Retry-After': '30' } }]);
  await new Promise((resolve) => mock.server.listen(0, '127.0.0.1', resolve));
  const port = mock.server.address().port;

  const sub = await generateSyntheticSubscription(`http://127.0.0.1:${port}/push`);
  const result = await sendWebPush(sub, JSON.stringify({ title: 'T' }), { TTL: 60 });

  assert.equal(result.status, 429);
  assert.equal(result.classification, 'retryable');
  assert.equal(result.retryAfter, 30);

  await mock.close();
});

test('sendWebPush classifies 500 as retryable', async () => {
  const keys = await generateTestVapidKeys();
  webpush.setVapidDetails('mailto:test@bathily-convoyage.invalid', keys.publicKey, keys.privateKey);

  const mock = startMockServer([{ status: 503, body: 'Service Unavailable' }]);
  await new Promise((resolve) => mock.server.listen(0, '127.0.0.1', resolve));
  const port = mock.server.address().port;

  const sub = await generateSyntheticSubscription(`http://127.0.0.1:${port}/push`);
  const result = await sendWebPush(sub, JSON.stringify({ title: 'T' }), { TTL: 60 });

  assert.equal(result.status, 503);
  assert.equal(result.classification, 'retryable');

  await mock.close();
});

test('sendWebPush classifies network error as ambiguous_retryable', async () => {
  const keys = await generateTestVapidKeys();
  webpush.setVapidDetails('mailto:test@bathily-convoyage.invalid', keys.publicKey, keys.privateKey);

  // Use a non-listening port — connection refused
  const sub = await generateSyntheticSubscription('http://127.0.0.1:1/push');
  const result = await sendWebPush(sub, JSON.stringify({ title: 'T' }), { TTL: 60 });

  assert.equal(result.ok, false);
  assert.equal(result.status, null);
  assert.equal(result.classification, 'ambiguous_retryable');
  assert.ok(result.error, 'error message present');
});

test('no https.request is called by the adapter', async () => {
  const https = await import('node:https');
  const originalRequest = https.default.request;
  let httpsCalled = false;

  https.default.request = function() {
    httpsCalled = true;
    throw new Error('https.request should not be called');
  };

  try {
    const keys = await generateTestVapidKeys();
    webpush.setVapidDetails('mailto:test@bathily-convoyage.invalid', keys.publicKey, keys.privateKey);

    const mock = startMockServer([{ status: 201 }]);
    await new Promise((resolve) => mock.server.listen(0, '127.0.0.1', resolve));
    const port = mock.server.address().port;

    const sub = await generateSyntheticSubscription(`http://127.0.0.1:${port}/push`);
    await sendWebPush(sub, JSON.stringify({ title: 'T' }), { TTL: 60 });

    assert.equal(httpsCalled, false, 'https.request was not called');

    await mock.close();
  } finally {
    https.default.request = originalRequest;
  }
});

test('no crypto.createECDH is used by the adapter', async () => {
  // Verify that the _push.js module does not import or use crypto.createECDH
  const fs = await import('node:fs');
  const path = await import('node:path');
  const pushCode = fs.readFileSync(
    path.resolve('functions/_push.js'), 'utf8'
  );
  assert.ok(!pushCode.includes('createECDH'),
    '_push.js must NOT use crypto.createECDH');
  assert.ok(!pushCode.includes("from 'web-push'"),
    '_push.js must NOT import from web-push');
  assert.ok(!pushCode.includes("from 'node:crypto'"),
    '_push.js must NOT import from node:crypto');
  assert.ok(!pushCode.includes("from 'node:https'"),
    '_push.js must NOT import from node:https');
  assert.ok(!pushCode.includes('@pushforge/builder'),
    '_push.js must NOT import from removed @pushforge/builder');
  assert.ok(pushCode.includes('@mmmike/web-push'),
    '_push.js must import from @mmmike/web-push');
  assert.ok(pushCode.includes('aes128gcm'),
    '_push.js must use aes128gcm encoding');
  assert.ok(pushCode.includes('crypto.subtle'),
    '_push.js must use WebCrypto crypto.subtle');
});
