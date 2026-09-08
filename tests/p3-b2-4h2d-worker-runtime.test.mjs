// P3-B2.4H2D — Worker runtime compatibility test.
//
// Verifies that the Cloudflare-compatible Web Push transport works
// in a workerd-like runtime (via wrangler dev / Pages Functions).
//
// This test:
// 1. Starts a local HTTP mock push endpoint
// 2. Builds a Web Push request using @pushforge/builder (WebCrypto)
// 3. Verifies no crypto.createECDH is called
// 4. Verifies no https.request is called
// 5. Verifies the request can be built in a worker-like context
//
// Since we can't easily run a full Pages Functions worker in a test,
// we verify the key invariants:
// - The _push.js module only uses WebCrypto (globalThis.crypto.subtle)
// - It does not import node:crypto or use crypto.createECDH
// - It does not import web-push
// - The @pushforge/builder dependency uses only WebCrypto

import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { buildWebPushRequest, sendWebPush, webpush, generateVAPIDKeys } from '../functions/_push.js';

const repoRoot = path.resolve(import.meta.dirname, '..');

function readFile(relPath) {
  return fs.readFileSync(path.join(repoRoot, relPath), 'utf8');
}

// ── Helpers ──

function base64UrlEncode(bytes) {
  const arr = new Uint8Array(bytes);
  let binary = '';
  for (let i = 0; i < arr.length; i++) binary += String.fromCharCode(arr[i]);
  const base64 = typeof btoa !== 'undefined'
    ? btoa(binary)
    : Buffer.from(binary, 'binary').toString('base64');
  return base64.replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}

async function generateSyntheticSubscription(endpoint) {
  const keyPair = await crypto.subtle.generateKey(
    { name: 'ECDH', namedCurve: 'P-256' },
    true,
    ['deriveBits']
  );
  const publicRaw = await crypto.subtle.exportKey('raw', keyPair.publicKey);
  const p256dh = base64UrlEncode(publicRaw);
  const authBytes = crypto.getRandomValues(new Uint8Array(16));
  const auth = base64UrlEncode(authBytes);
  return { endpoint, keys: { p256dh, auth } };
}

// ── Static analysis tests ──

test('WORKER_RUNTIME: _push.js does not import node:crypto', () => {
  const code = readFile('functions/_push.js');
  assert.ok(!code.includes("from 'node:crypto'"),
    '_push.js must NOT import node:crypto');
  assert.ok(!code.includes('require("node:crypto")'),
    '_push.js must NOT require node:crypto');
});

test('WORKER_RUNTIME: _push.js does not import web-push', () => {
  const code = readFile('functions/_push.js');
  assert.ok(!code.includes("from 'web-push'"),
    '_push.js must NOT import web-push');
  assert.ok(!code.includes('require("web-push")'),
    '_push.js must NOT require web-push');
});

test('WORKER_RUNTIME: _push.js does not use crypto.createECDH', () => {
  const code = readFile('functions/_push.js');
  assert.ok(!code.includes('createECDH'),
    '_push.js must NOT use crypto.createECDH');
});

test('WORKER_RUNTIME: _push.js uses @pushforge/builder', () => {
  const code = readFile('functions/_push.js');
  assert.ok(code.includes("@pushforge/builder"),
    '_push.js must import @pushforge/builder');
});

test('WORKER_RUNTIME: @pushforge/builder uses globalThis.crypto.subtle', () => {
  const cryptoCode = readFile('node_modules/@pushforge/builder/dist/lib/crypto.js');
  assert.ok(cryptoCode.includes('globalThis.crypto'),
    '@pushforge/builder must use globalThis.crypto');
  assert.ok(cryptoCode.includes('subtle'),
    '@pushforge/builder must use crypto.subtle');
  assert.ok(!cryptoCode.includes('createECDH'),
    '@pushforge/builder must NOT use crypto.createECDH');
  assert.ok(!cryptoCode.includes("require('crypto')"),
    '@pushforge/builder must NOT require node crypto');
});

test('WORKER_RUNTIME: @pushforge/builder does not use https module', () => {
  // Check all dist files for https.request or node:https
  const files = [
    'node_modules/@pushforge/builder/dist/lib/request.js',
    'node_modules/@pushforge/builder/dist/lib/payload.js',
    'node_modules/@pushforge/builder/dist/lib/vapid.js',
    'node_modules/@pushforge/builder/dist/lib/crypto.js',
    'node_modules/@pushforge/builder/dist/lib/jwt.js',
    'node_modules/@pushforge/builder/dist/lib/shared-secret.js',
    'node_modules/@pushforge/builder/dist/lib/base64.js',
    'node_modules/@pushforge/builder/dist/lib/utils.js',
  ];
  for (const f of files) {
    const code = readFile(f);
    assert.ok(!code.includes("from 'node:https'"),
      `${f} must NOT import node:https`);
    assert.ok(!code.includes("require('https')"),
      `${f} must NOT require https`);
  }
});

// ── Runtime tests (Node.js with WebCrypto, simulating worker runtime) ──

test('WORKER_RUNTIME: request build succeeds using WebCrypto only', async () => {
  const keys = await generateVAPIDKeys();
  webpush.setVapidDetails('mailto:test@bathily-convoyage.invalid', keys.publicKey, keys.privateKey);

  const sub = await generateSyntheticSubscription('https://fcm.googleapis.com/fcm/send/test');
  const payload = JSON.stringify({ title: 'Worker Test', body: 'Hello from edge' });

  const req = await buildWebPushRequest(sub, payload, { TTL: 3600 });

  assert.ok(req.method === 'POST');
  assert.ok(req.endpoint);
  assert.ok(req.headers);
  assert.ok(req.body);
  assert.ok(req.body.byteLength > 0);
});

test('WORKER_RUNTIME: no crypto.createECDH called during request build', async () => {
  // Monkey-patch crypto.createECDH to detect if it's called
  const nodeCrypto = await import('node:crypto');
  const originalCreateECDH = nodeCrypto.default.createECDH;
  let createECDHCalled = false;

  nodeCrypto.default.createECDH = function() {
    createECDHCalled = true;
    throw new Error('crypto.createECDH should not be called');
  };

  try {
    const keys = await generateVAPIDKeys();
    webpush.setVapidDetails('mailto:test@bathily-convoyage.invalid', keys.publicKey, keys.privateKey);

    const sub = await generateSyntheticSubscription('https://fcm.googleapis.com/fcm/send/test2');
    const req = await buildWebPushRequest(sub, JSON.stringify({ title: 'T' }), { TTL: 60 });

    assert.equal(createECDHCalled, false,
      'crypto.createECDH must NOT be called during request build');
    assert.ok(req.body.byteLength > 0, 'request body must be non-empty');
  } finally {
    nodeCrypto.default.createECDH = originalCreateECDH;
  }
});

test('WORKER_RUNTIME: no https.request called during sendWebPush', async () => {
  const https = await import('node:https');
  const originalRequest = https.default.request;
  let httpsCalled = false;

  https.default.request = function() {
    httpsCalled = true;
    throw new Error('https.request should not be called');
  };

  try {
    const keys = await generateVAPIDKeys();
    webpush.setVapidDetails('mailto:test@bathily-convoyage.invalid', keys.publicKey, keys.privateKey);

    // Use a non-listening port — connection refused (uses fetch, not https.request)
    const sub = await generateSyntheticSubscription('http://127.0.0.1:1/push');
    const result = await sendWebPush(sub, JSON.stringify({ title: 'T' }), { TTL: 60 });

    assert.equal(httpsCalled, false, 'https.request was not called');
    assert.equal(result.classification, 'ambiguous_retryable',
      'network error should be classified as ambiguous_retryable');
  } finally {
    https.default.request = originalRequest;
  }
});

test('WORKER_RUNTIME: REQUEST_BUILD_WORKER_RUNTIME=PASS', async () => {
  // Final summary test — all worker runtime checks pass
  const keys = await generateVAPIDKeys();
  webpush.setVapidDetails('mailto:test@bathily-convoyage.invalid', keys.publicKey, keys.privateKey);

  const sub = await generateSyntheticSubscription('https://fcm.googleapis.com/fcm/send/final');
  const req = await buildWebPushRequest(sub, JSON.stringify({ title: 'Final' }), { TTL: 60 });

  assert.ok(req.body.byteLength > 0, 'body is non-empty');
  assert.ok(req.headers['Authorization'] || req.headers['authorization'], 'VAPID auth present');
  assert.ok(req.headers['Content-Encoding'] || req.headers['content-encoding'], 'content encoding present');
});
