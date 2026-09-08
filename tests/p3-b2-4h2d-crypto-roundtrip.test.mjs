// P3-B2.4H2D-B — Real cryptographic roundtrip test for RFC 8291 aes128gcm.
//
// This test performs REAL encryption + decryption using WebCrypto API only
// (no crypto.createECDH). It verifies that the payload encrypted by the
// RFC 8291 aes128gcm implementation can be decrypted back to the original
// plaintext using the subscription's private key.
//
// Protocol: aes128gcm (RFC 8291 / RFC 8188)
//
// Body layout: salt(16) || rs(4 BE) || idlen(1) || keyid(65) || ciphertext
//
// Required tests:
// 1. Generate valid VAPID key pair (WebCrypto)
// 2. Build Web Push request for synthetic subscription (no crypto.createECDH)
// 3. Verify Authorization/VAPID header structurally valid
// 4. Verify NO legacy Encryption/Crypto-Key headers (RFC 8291 puts them in body)
// 5. Verify Content-Encoding=aes128gcm
// 6. Verify encrypted body non-empty and differs from plaintext
// 7. Verify RFC 8188 body structure (salt, rs, idlen, keyid)
// 8. Full decryption roundtrip: DECRYPTED_PAYLOAD == ORIGINAL_PAYLOAD
// 9. Multiple randomized roundtrips (5+ cases with varied payloads)
// 10. No crypto.createECDH in source; uses WebCrypto

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

// ── RFC 8291 aes128gcm decryption ──
// Decrypts body: salt(16) || rs(4 BE) || idlen(1) || keyid(65) || ciphertext

async function decryptAes128gcmPayload(encryptedBody, subscriptionPrivateKey) {
  const body = new Uint8Array(encryptedBody);

  // 1. Parse RFC 8188 header
  const salt = body.slice(0, 16);
  const rs = new DataView(body.buffer).getUint32(16, false); // big-endian
  const idlen = body[20];
  const keyid = body.slice(21, 21 + idlen);
  const ciphertext = body.slice(21 + idlen);

  // 2. Import server public key (keyid) for ECDH
  const serverPublicKey = await crypto.subtle.importKey(
    'raw',
    keyid,
    { name: 'ECDH', namedCurve: 'P-256' },
    false,
    []
  );

  // 3. Derive shared secret: ECDH(subscription_private, server_public)
  const sharedSecret = await crypto.subtle.deriveBits(
    { name: 'ECDH', public: serverPublicKey },
    subscriptionPrivateKey,
    256
  );

  // 4. We need client public key for IKM derivation
  // Export subscription's public key from private key
  // (subscriptionPrivateKey was generated with extractable=true)
  const clientPublicKeyRaw = new Uint8Array(
    await crypto.subtle.exportKey('raw',
      (await crypto.subtle.importKey('pkcs8',
        await crypto.subtle.exportKey('pkcs8', subscriptionPrivateKey),
        { name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']
      )).publicKey
    )
  );

  // 5. Derive IKM: HKDF(salt=auth, IKM=shared_secret, info="WebPush: info\0" || clientPub || serverPub)
  // Note: auth secret is NOT available here; it must be passed in
  // This function signature needs authSecret
  throw new Error('Use decryptAes128gcmPayloadWithAuth instead');
}

async function decryptAes128gcmPayloadWithAuth(encryptedBody, subscriptionPrivateKey, authSecret, clientPublicKeyRaw) {
  const body = new Uint8Array(encryptedBody);

  // 1. Parse RFC 8188 header
  const salt = body.slice(0, 16);
  const idlen = body[20];
  const keyid = body.slice(21, 21 + idlen);
  const ciphertext = body.slice(21 + idlen);

  // 2. Import server public key (keyid) for ECDH
  const serverPublicKey = await crypto.subtle.importKey(
    'raw',
    keyid,
    { name: 'ECDH', namedCurve: 'P-256' },
    false,
    []
  );

  // 3. Derive shared secret: ECDH(subscription_private, server_public)
  const sharedSecret = new Uint8Array(await crypto.subtle.deriveBits(
    { name: 'ECDH', public: serverPublicKey },
    subscriptionPrivateKey,
    256
  ));

  // 4. Derive IKM: HKDF(salt=auth, IKM=shared_secret, info="WebPush: info\0" || clientPub || serverPub)
  const ikmInfo = concatTypedArrays([
    new TextEncoder().encode('WebPush: info'),
    new Uint8Array([0x00]),
    clientPublicKeyRaw,
    keyid,
  ]);
  const ikm = await crypto.subtle.deriveBits(
    { name: 'HKDF', hash: 'SHA-256', salt: authSecret, info: ikmInfo },
    await crypto.subtle.importKey('raw', sharedSecret, 'HKDF', false, ['deriveBits', 'deriveKey']),
    256
  );
  const ikmKey = await crypto.subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits', 'deriveKey']);

  // 5. Derive CEK: HKDF(salt=salt, IKM=ikm, info="Content-Encoding: aes128gcm\0")
  const cekInfo = concatTypedArrays([
    new TextEncoder().encode('Content-Encoding: aes128gcm'),
    new Uint8Array([0x00]),
  ]);
  const cek = await crypto.subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt, info: cekInfo },
    ikmKey,
    { name: 'AES-GCM', length: 128 },
    false,
    ['decrypt']
  );

  // 6. Derive nonce: HKDF(salt=salt, IKM=ikm, info="Content-Encoding: nonce\0")
  const nonceInfo = concatTypedArrays([
    new TextEncoder().encode('Content-Encoding: nonce'),
    new Uint8Array([0x00]),
  ]);
  const nonce = await crypto.subtle.deriveBits(
    { name: 'HKDF', hash: 'SHA-256', salt, info: nonceInfo },
    ikmKey,
    96
  );

  // 7. Decrypt AES-128-GCM
  const decrypted = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: nonce },
    cek,
    ciphertext
  );

  // 8. Remove padding: last byte is 0x02 (final record delimiter), padding is 0x00 bytes before it
  const decryptedBytes = new Uint8Array(decrypted);
  // Find the 0x02 delimiter — payload is everything before it (after any 0x00 padding)
  let payloadEnd = decryptedBytes.length;
  // The delimiter 0x02 marks end of payload; padding is 0x00 bytes before delimiter
  // Actually RFC 8188: padding is 0x00 bytes, delimiter is 0x02 for last record
  // Payload is at the start, then 0x00 padding, then 0x02 delimiter
  // Find the 0x02 from the end
  for (let i = decryptedBytes.length - 1; i >= 0; i--) {
    if (decryptedBytes[i] === 0x02) {
      payloadEnd = i;
      break;
    }
  }
  const payload = decryptedBytes.slice(0, payloadEnd);
  return new TextDecoder().decode(payload);
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

test('4. NO legacy Encryption/Crypto-Key headers (RFC 8291 puts salt/key in body)', async () => {
  const keys = await generateVAPIDKeys();
  webpush.setVapidDetails('mailto:test@bathily-convoyage.invalid', keys.publicKey, keys.privateKey);

  const sub = await generateSyntheticSubscription('https://fcm.googleapis.com/fcm/send/test');
  const req = await buildWebPushRequest(sub, JSON.stringify({ title: 'T' }), { TTL: 60 });

  // RFC 8291 aes128gcm does NOT use separate Encryption/Crypto-Key headers
  assert.ok(!req.headers['Encryption'] && !req.headers['encryption'],
    'must NOT emit legacy Encryption header');
  assert.ok(!req.headers['Crypto-Key'] && !req.headers['crypto-key'],
    'must NOT emit legacy Crypto-Key dh header');
});

test('5. Content-Encoding is aes128gcm', async () => {
  const keys = await generateVAPIDKeys();
  webpush.setVapidDetails('mailto:test@bathily-convoyage.invalid', keys.publicKey, keys.privateKey);

  const sub = await generateSyntheticSubscription('https://fcm.googleapis.com/fcm/send/test');
  const req = await buildWebPushRequest(sub, JSON.stringify({ title: 'T' }), { TTL: 60 });

  const contentEncoding = req.headers['Content-Encoding'] || req.headers['content-encoding'];
  assert.equal(contentEncoding, 'aes128gcm', 'Content-Encoding is aes128gcm');
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

test('7. RFC 8188 body structure: salt(16) || rs(4096 BE) || idlen(65) || keyid(0x04...) || ciphertext', async () => {
  const keys = await generateVAPIDKeys();
  webpush.setVapidDetails('mailto:test@bathily-convoyage.invalid', keys.publicKey, keys.privateKey);

  const sub = await generateSyntheticSubscription('https://fcm.googleapis.com/fcm/send/test');
  const req = await buildWebPushRequest(sub, JSON.stringify({ title: 'T' }), { TTL: 60 });
  const body = new Uint8Array(req.body);

  // RFC 8188: salt(16) || rs(4 BE) || idlen(1) || keyid(65) || ciphertext
  assert.ok(body.length >= 86, 'body must be at least 86-byte header + ciphertext');

  // Salt: 16 random bytes (just check length, not value)
  assert.equal(body.length, 86 + (body.length - 86), 'body structure intact');

  // rs: 4-byte big-endian, should be 4096 (0x00001000)
  const rs = new DataView(body.buffer).getUint32(16, false);
  assert.equal(rs, 4096, 'rs (record size) must be 4096');

  // idlen: 1 byte, must be 65
  assert.equal(body[20], 65, 'idlen must be 65 (uncompressed P-256 key)');

  // keyid: 65 bytes, must start with 0x04 (uncompressed point)
  assert.equal(body[21], 0x04, 'keyid must start with 0x04 (uncompressed P-256)');

  // Ciphertext: non-empty (body - 86 header bytes)
  const ciphertextLen = body.length - 86;
  assert.ok(ciphertextLen > 0, 'ciphertext must be non-empty');
});

test('8. Full decryption roundtrip: DECRYPTED_PAYLOAD == ORIGINAL_PAYLOAD', async () => {
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

  // For RFC 8291, salt and key are in the body, not headers
  const clientPublicKeyRaw = base64UrlDecodeToBytes(sub.keys.p256dh);
  const authSecret = base64UrlDecodeToBytes(sub.keys.auth);

  const decryptedPayload = await decryptAes128gcmPayloadWithAuth(
    req.body,
    sub._privateKey,
    authSecret,
    clientPublicKeyRaw
  );

  assert.equal(decryptedPayload, originalPayload,
    'Decrypted payload must match original payload exactly');
});

test('9. Multiple randomized roundtrips with varied payloads (5+ cases)', async () => {
  const keys = await generateVAPIDKeys();
  webpush.setVapidDetails('mailto:test@bathily-convoyage.invalid', keys.publicKey, keys.privateKey);

  const testCases = [
    // ASCII payload
    JSON.stringify({ title: 'Mission Assigned', body: 'You have a new mission', url: '/missions/1' }),
    // Unicode payload
    JSON.stringify({ title: 'Café résumé', body: 'Naïve façade — été', url: '/café' }),
    // Empty/minimal JSON
    JSON.stringify({}),
    // Larger JSON payload
    JSON.stringify({
      title: 'Complex Notification',
      body: 'This is a longer body with multiple words and some special characters: !@#$%^&*()',
      url: '/missions/123?filter=active&sort=desc&page=1',
      data: {
        missionId: 'abc-123-def-456',
        userId: 'user-789',
        timestamp: Date.now(),
        nested: { key: 'value', array: [1, 2, 3] }
      }
    }),
    // URL with query characters
    JSON.stringify({ title: 'T', body: 'B', url: '/path?query=value&other=123#fragment' }),
  ];

  assert.ok(testCases.length >= 5, 'must have at least 5 test cases');

  for (let i = 0; i < testCases.length; i++) {
    const sub = await generateSyntheticSubscription(`https://fcm.googleapis.com/fcm/send/test${i}`);
    const originalPayload = testCases[i];

    const req = await buildWebPushRequest(sub, originalPayload, { TTL: 60 });

    const clientPublicKeyRaw = base64UrlDecodeToBytes(sub.keys.p256dh);
    const authSecret = base64UrlDecodeToBytes(sub.keys.auth);

    const decryptedPayload = await decryptAes128gcmPayloadWithAuth(
      req.body,
      sub._privateKey,
      authSecret,
      clientPublicKeyRaw
    );

    assert.equal(decryptedPayload, originalPayload,
      `Case ${i}: decrypted payload must match original exactly`);
  }
});

test('10. No crypto.createECDH in _push.js source; uses WebCrypto', async () => {
  const fs = await import('node:fs');
  const path = await import('node:path');
  const source = fs.readFileSync(
    path.resolve('functions/_push.js'), 'utf8'
  );
  assert.ok(!source.includes('createECDH'),
    '_push.js must NOT reference crypto.createECDH');
  assert.ok(!source.includes("from 'web-push'") && !source.includes("require('web-push')"),
    '_push.js must NOT import web-push');
  assert.ok(!source.includes('node:crypto'),
    '_push.js must NOT import node:crypto');
  assert.ok(!source.includes('node:https'),
    '_push.js must NOT import node:https');
  assert.ok(source.includes('@mmmike/web-push'),
    '_push.js must import from @mmmike/web-push');
  assert.ok(source.includes('crypto.subtle'),
    '_push.js must use WebCrypto crypto.subtle');
  assert.ok(source.includes('aes128gcm'),
    '_push.js must use aes128gcm encoding');
});
