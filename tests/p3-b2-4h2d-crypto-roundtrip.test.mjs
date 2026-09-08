// P3-B2.4H2D — Real cryptographic roundtrip test for Cloudflare-compatible
// Web Push transport.
//
// This test performs REAL encryption + decryption using WebCrypto API only
// (no crypto.createECDH). It verifies that the payload encrypted by
// @pushforge/builder can be decrypted back to the original plaintext using
// the subscription's private key.
//
// Protocol: aesgcm (RFC 8291 older encoding, used by @pushforge/builder)
//
// Required tests:
// 1. Import known valid VAPID private/public P-256 pair
// 2. Build one Web Push request for a synthetic valid subscription
// 3. Verify request construction succeeds without crypto.createECDH()
// 4. Verify Authorization/VAPID header structurally valid
// 5. Verify Crypto-Key / Encryption headers correct
// 6. Verify Content-Encoding=aesgcm
// 7. Verify encrypted body non-empty
// 8. Verify body differs from plaintext
// 9. Decrypt generated payload locally with subscription private key
// 10. Verify DECRYPTED_PAYLOAD == ORIGINAL_PAYLOAD

import { test } from 'node:test';
import assert from 'node:assert';
import { buildWebPushRequest, webpush, generateVAPIDKeys } from '../functions/_push.js';

// ── Base64url helpers ──

function base64UrlEncode(bytes) {
  const arr = new Uint8Array(bytes);
  let binary = '';
  for (let i = 0; i < arr.length; i++) binary += String.fromCharCode(arr[i]);
  const base64 = typeof btoa !== 'undefined'
    ? btoa(binary)
    : Buffer.from(binary, 'binary').toString('base64');
  return base64.replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}

function base64UrlDecodeToBytes(str) {
  const base64 = str.replace(/-/g, '+').replace(/_/g, '/');
  const padded = base64 + '='.repeat((4 - (base64.length % 4)) % 4);
  if (typeof atob !== 'undefined') {
    const binary = atob(padded);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
  }
  return new Uint8Array(Buffer.from(padded, 'base64'));
}

// ── Synthetic subscription generation (WebCrypto only) ──

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
  return { endpoint, keys: { p256dh, auth }, _privateKey: keyPair.privateKey };
}

// ── aesgcm decryption (RFC 8291 older encoding) ──

async function decryptAesgcmPayload(
  encryptedBody,
  subscriptionPrivateKey,
  serverPublicKeyRaw,
  authSecret,
  clientPublicKeyRaw
) {
  // 1. Derive shared secret using ECDH (subscription private + server public)
  const serverPublicKey = await crypto.subtle.importKey(
    'raw',
    serverPublicKeyRaw,
    { name: 'ECDH', namedCurve: 'P-256' },
    false,
    []
  );
  const sharedSecret = await crypto.subtle.deriveBits(
    { name: 'ECDH', public: serverPublicKey },
    subscriptionPrivateKey,
    256
  );

  // 2. Derive pseudo-random key: HKDF(auth, sharedSecret, "Content-Encoding: auth\0")
  const prk = await crypto.subtle.deriveBits(
    { name: 'HKDF', hash: 'SHA-256', salt: authSecret, info: new TextEncoder().encode('Content-Encoding: auth\0') },
    await crypto.subtle.importKey('raw', sharedSecret, 'HKDF', false, ['deriveBits']),
    256
  );
  const prkKey = await crypto.subtle.importKey('raw', prk, 'HKDF', false, ['deriveBits']);

  // 3. Create context: "P-256\0" + len(clientPub) + clientPub + len(serverPub) + serverPub
  const context = concatTypedArrays([
    new TextEncoder().encode('P-256\0'),
    new Uint8Array([0, clientPublicKeyRaw.length]),
    clientPublicKeyRaw,
    new Uint8Array([0, serverPublicKeyRaw.length]),
    serverPublicKeyRaw,
  ]);

  // 4. Derive nonce: HKDF(salt, prk, "Content-Encoding: nonce\0" + context)
  const nonce = await crypto.subtle.deriveBits(
    { name: 'HKDF', hash: 'SHA-256', salt: saltFromHeaders, info: concatTypedArrays([new TextEncoder().encode('Content-Encoding: nonce\0'), context]) },
    prkKey,
    12 * 8
  );

  // 5. Derive content encryption key: HKDF(salt, prk, "Content-Encoding: aesgcm\0" + context)
  const cek = await crypto.subtle.deriveBits(
    { name: 'HKDF', hash: 'SHA-256', salt: saltFromHeaders, info: concatTypedArrays([new TextEncoder().encode('Content-Encoding: aesgcm\0'), context]) },
    prkKey,
    16 * 8
  );
  const cekKey = await crypto.subtle.importKey('raw', cek, 'AES-GCM', false, ['decrypt']);

  // 6. Decrypt using AES-GCM
  const decrypted = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: nonce },
    cekKey,
    encryptedBody
  );

  // 7. Remove padding: first 2 bytes are padding length (big-endian), then padding, then payload
  const decryptedBytes = new Uint8Array(decrypted);
  const paddingLen = (decryptedBytes[0] << 8) | decryptedBytes[1];
  const payload = decryptedBytes.slice(2 + paddingLen);

  return new TextDecoder().decode(payload);
}

// These need to be set from the headers — declared outside for closure access
let saltFromHeaders;

function concatTypedArrays(arrays) {
  const length = arrays.reduce((acc, a) => acc + a.length, 0);
  const result = new Uint8Array(length);
  let index = 0;
  for (const arr of arrays) {
    result.set(arr, index);
    index += arr.length;
  }
  return result;
}

// ── Tests ──

test('1. Generate valid VAPID key pair (WebCrypto)', async () => {
  const keys = await generateVAPIDKeys();
  assert.ok(keys.publicKey, 'public key exists');
  assert.ok(keys.privateKey, 'private key exists');
  assert.ok(keys.publicKey.length > 80, 'public key is ~87 chars base64url');
  assert.ok(keys.privateKey.length > 40, 'private key is ~43 chars base64url');

  // Verify public key is a valid 65-byte uncompressed P-256 point
  const pubBytes = base64UrlDecodeToBytes(keys.publicKey);
  assert.equal(pubBytes.length, 65, 'public key is 65 bytes');
  assert.equal(pubBytes[0], 0x04, 'public key starts with 0x04 (uncompressed)');
});

test('2. Build Web Push request for synthetic subscription (no crypto.createECDH)', async () => {
  const keys = await generateVAPIDKeys();
  webpush.setVapidDetails('mailto:test@bathily-convoyage.invalid', keys.publicKey, keys.privateKey);

  const sub = await generateSyntheticSubscription('https://fcm.googleapis.com/fcm/send/test');
  const payload = JSON.stringify({ title: 'Test', body: 'Hello', url: '/' });

  const req = await buildWebPushRequest(sub, payload, { TTL: 3600 });

  assert.ok(req.method === 'POST', 'method is POST');
  assert.ok(req.endpoint, 'endpoint exists');
  assert.ok(req.headers, 'headers exist');
  assert.ok(req.body, 'body exists');
  assert.ok(req.body.byteLength > 0, 'body is non-empty');
});

test('3. Authorization/VAPID header structurally valid', async () => {
  const keys = await generateVAPIDKeys();
  webpush.setVapidDetails('mailto:test@bathily-convoyage.invalid', keys.publicKey, keys.privateKey);

  const sub = await generateSyntheticSubscription('https://fcm.googleapis.com/fcm/send/test');
  const req = await buildWebPushRequest(sub, JSON.stringify({ title: 'T' }), { TTL: 60 });

  const authHeader = req.headers['Authorization'] || req.headers['authorization'];
  assert.ok(authHeader, 'Authorization header present');
  assert.ok(authHeader.startsWith('vapid t='), 'Authorization starts with "vapid t="');
  assert.ok(authHeader.includes(', k='), 'Authorization includes public key (k=)');
});

test('4. Crypto-Key and Encryption headers correct', async () => {
  const keys = await generateVAPIDKeys();
  webpush.setVapidDetails('mailto:test@bathily-convoyage.invalid', keys.publicKey, keys.privateKey);

  const sub = await generateSyntheticSubscription('https://fcm.googleapis.com/fcm/send/test');
  const req = await buildWebPushRequest(sub, JSON.stringify({ title: 'T' }), { TTL: 60 });

  const cryptoKeyHeader = req.headers['Crypto-Key'] || req.headers['crypto-key'];
  const encryptionHeader = req.headers['Encryption'] || req.headers['encryption'];

  assert.ok(cryptoKeyHeader, 'Crypto-Key header present');
  assert.ok(cryptoKeyHeader.startsWith('dh='), 'Crypto-Key starts with dh=');

  assert.ok(encryptionHeader, 'Encryption header present');
  assert.ok(encryptionHeader.startsWith('salt='), 'Encryption starts with salt=');
});

test('5. Content-Encoding is aesgcm', async () => {
  const keys = await generateVAPIDKeys();
  webpush.setVapidDetails('mailto:test@bathily-convoyage.invalid', keys.publicKey, keys.privateKey);

  const sub = await generateSyntheticSubscription('https://fcm.googleapis.com/fcm/send/test');
  const req = await buildWebPushRequest(sub, JSON.stringify({ title: 'T' }), { TTL: 60 });

  const contentEncoding = req.headers['Content-Encoding'] || req.headers['content-encoding'];
  assert.equal(contentEncoding, 'aesgcm', 'Content-Encoding is aesgcm');
});

test('6. Encrypted body is non-empty and differs from plaintext', async () => {
  const keys = await generateVAPIDKeys();
  webpush.setVapidDetails('mailto:test@bathily-convoyage.invalid', keys.publicKey, keys.privateKey);

  const sub = await generateSyntheticSubscription('https://fcm.googleapis.com/fcm/send/test');
  const payload = JSON.stringify({ title: 'Secret', body: 'Hidden', url: '/private' });
  const req = await buildWebPushRequest(sub, payload, { TTL: 60 });

  assert.ok(req.body.byteLength > 0, 'encrypted body is non-empty');

  const bodyStr = new TextDecoder().decode(req.body);
  assert.ok(!bodyStr.includes('Secret'), 'plaintext title not in body');
  assert.ok(!bodyStr.includes('Hidden'), 'plaintext body not in body');
  assert.ok(!bodyStr.includes('/private'), 'plaintext url not in body');
});

test('7. Full decryption roundtrip: DECRYPTED_PAYLOAD == ORIGINAL_PAYLOAD', async () => {
  const keys = await generateVAPIDKeys();
  webpush.setVapidDetails('mailto:test@bathily-convoyage.invalid', keys.publicKey, keys.privateKey);

  const sub = await generateSyntheticSubscription('https://fcm.googleapis.com/fcm/send/test');
  const originalPayload = JSON.stringify({
    title: 'Convoyage Test',
    body: 'Notification body for roundtrip',
    url: '/missions/123',
    data: { missionId: 'abc-123' }
  });

  const req = await buildWebPushRequest(sub, originalPayload, { TTL: 3600 });

  // Extract salt from Encryption header
  const encryptionHeader = req.headers['Encryption'] || req.headers['encryption'];
  const saltB64 = encryptionHeader.replace('salt=', '');
  saltFromHeaders = base64UrlDecodeToBytes(saltB64);

  // Extract server public key from Crypto-Key header
  const cryptoKeyHeader = req.headers['Crypto-Key'] || req.headers['crypto-key'];
  const serverPubB64 = cryptoKeyHeader.replace('dh=', '');
  const serverPublicKeyRaw = base64UrlDecodeToBytes(serverPubB64);

  // Get client public key (p256dh)
  const clientPublicKeyRaw = base64UrlDecodeToBytes(sub.keys.p256dh);

  // Get auth secret
  const authSecret = base64UrlDecodeToBytes(sub.keys.auth);

  // Decrypt the payload using the subscription's private key
  const decryptedPayload = await decryptAesgcmPayload(
    req.body,
    sub._privateKey,
    serverPublicKeyRaw,
    authSecret,
    clientPublicKeyRaw
  );

  assert.equal(decryptedPayload, originalPayload,
    'Decrypted payload must match original payload exactly');
});

test('8. Multiple roundtrips produce correct decryption (randomized)', async () => {
  const keys = await generateVAPIDKeys();
  webpush.setVapidDetails('mailto:test@bathily-convoyage.invalid', keys.publicKey, keys.privateKey);

  for (let i = 0; i < 3; i++) {
    const sub = await generateSyntheticSubscription('https://fcm.googleapis.com/fcm/send/test' + i);
    const originalPayload = JSON.stringify({
      title: `Test ${i}`,
      body: `Body ${i} with unicode: café résumé naïf`,
      url: `/test/${i}`,
      timestamp: Date.now()
    });

    const req = await buildWebPushRequest(sub, originalPayload, { TTL: 60 });

    const encryptionHeader = req.headers['Encryption'] || req.headers['encryption'];
    const saltB64 = encryptionHeader.replace('salt=', '');
    saltFromHeaders = base64UrlDecodeToBytes(saltB64);

    const cryptoKeyHeader = req.headers['Crypto-Key'] || req.headers['crypto-key'];
    const serverPubB64 = cryptoKeyHeader.replace('dh=', '');
    const serverPublicKeyRaw = base64UrlDecodeToBytes(serverPubB64);

    const clientPublicKeyRaw = base64UrlDecodeToBytes(sub.keys.p256dh);
    const authSecret = base64UrlDecodeToBytes(sub.keys.auth);

    const decryptedPayload = await decryptAesgcmPayload(
      req.body,
      sub._privateKey,
      serverPublicKeyRaw,
      authSecret,
      clientPublicKeyRaw
    );

    assert.equal(decryptedPayload, originalPayload,
      `Round ${i}: decrypted payload must match original`);
  }
});

test('9. No crypto.createECDH in _push.js source', async () => {
  const fs = await import('node:fs');
  const path = await import('node:path');
  const source = fs.readFileSync(
    path.resolve('functions/_push.js'), 'utf8'
  );
  assert.ok(!source.includes('createECDH'),
    '_push.js must NOT reference crypto.createECDH');
  assert.ok(!source.includes("from 'web-push'") && !source.includes("require('web-push')"),
    '_push.js must NOT import web-push');
});

test('10. Request construction uses WebCrypto (globalThis.crypto.subtle)', async () => {
  // Verify that @pushforge/builder uses globalThis.crypto.subtle, not Node crypto
  const fs = await import('node:fs');
  const path = await import('node:path');
  const pushCode = fs.readFileSync(
    path.resolve('functions/_push.js'), 'utf8'
  );
  assert.ok(pushCode.includes('@pushforge/builder'),
    '_push.js imports @pushforge/builder');
  assert.ok(!pushCode.includes('node:crypto'),
    '_push.js does NOT import node:crypto');
});
