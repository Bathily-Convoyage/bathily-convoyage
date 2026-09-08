// Web Push fetch-based transport adapter (Cloudflare-compatible, RFC 8291).
// Implements RFC 8291 aes128gcm content encryption with RFC 8188 body framing,
// and RFC 8292 VAPID authentication using @mmmike/web-push's public VAPID API.
//
// Uses only WebCrypto (globalThis.crypto.subtle) — no Node.js crypto,
// no Node crypto, no Node https module. Runs in Cloudflare Pages Functions
// (workerd), Node.js 20+, Deno, Bun, and browsers.
//
// Public API:
//   setVapidDetails(subject, publicKey, privateKey) → void
//   generateVAPIDKeys() → Promise<{ publicKey, privateKey }>
//   buildWebPushRequest(subscription, payload, options) → Promise<requestDetails>
//   sendWebPush(subscription, payload, options) → Promise<result>
//   classifyPushResponse(status, headers) → classification string

import { generateVapidKeys as _generateVapidKeys, createVapidJwt } from '@mmmike/web-push/vapid';

// =========================================================
// VAPID CONFIGURATION
// =========================================================

let vapidConfig = null;

export function setVapidDetails(subject, publicKey, privateKey) {
  vapidConfig = { subject, publicKey, privateKey };
}

export { _generateVapidKeys as generateVAPIDKeys };

// =========================================================
// BASE64URL HELPERS
// =========================================================

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
  // Normalize: handle both standard base64 and base64url, with or without padding
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

// =========================================================
// RFC 8291 / RFC 8188 CONSTANTS
// =========================================================

const SALT_LENGTH = 16;
const KEY_ID_LENGTH = 65;       // Uncompressed P-256 public key
const PADDING_DELIMITER = 0x02;  // Final record delimiter per RFC 8188
const RECORD_SIZE = 4096;       // rs field in body header (RFC 8291 §4)
const HEADER_LENGTH = SALT_LENGTH + 4 + 1 + KEY_ID_LENGTH; // 86 bytes

// =========================================================
// CONCAT HELPER
// =========================================================

function concat(...parts) {
  const out = new Uint8Array(parts.reduce((t, p) => t + p.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

// =========================================================
// RFC 8291 KEY DERIVATION
// =========================================================

function hkdfInfo(label, ...context) {
  return concat(
    new TextEncoder().encode(label),
    new Uint8Array([0x00]),
    ...context
  );
}

async function importHkdfKey(bytes) {
  return crypto.subtle.importKey('raw', bytes, 'HKDF', false, ['deriveBits', 'deriveKey']);
}

// =========================================================
// RFC 8291 PAYLOAD ENCRYPTION
// =========================================================
// Encrypts payload as a single aes128gcm record per RFC 8291 / RFC 8188.
//
// Body layout:
//   salt(16) || rs(4 BE) || idlen(1=65) || keyid(65) || ciphertext
//
// Key derivation:
//   1. ECDH P-256 between sender ephemeral key and subscription p256dh
//   2. IKM = HKDF(salt=auth, IKM=shared_secret, info="WebPush: info\0" || clientPub || serverPub)
//   3. CEK = HKDF(salt=salt, IKM=IKM, info="Content-Encoding: aes128gcm\0")
//   4. Nonce = HKDF(salt=salt, IKM=IKM, info="Content-Encoding: nonce\0")
//   5. Encrypt: AES-128-GCM(CEK, nonce, payload || 0x02)

async function encryptAes128gcmPayload(payloadBytes, p256dhKey, authSecret) {
  // Validate and decode subscription keys
  const clientPublicKeyBytes = base64UrlDecodeToBytes(p256dhKey);
  if (clientPublicKeyBytes.length !== 65 || clientPublicKeyBytes[0] !== 0x04) {
    throw new Error('Invalid subscription p256dh key: expected 65-byte uncompressed P-256 point');
  }
  const authSecretBytes = base64UrlDecodeToBytes(authSecret);
  if (authSecretBytes.length < 16) {
    throw new Error('Invalid subscription auth secret: expected at least 16 bytes');
  }

  // 1. Generate ephemeral sender ECDH P-256 key pair
  const serverKeyPair = await crypto.subtle.generateKey(
    { name: 'ECDH', namedCurve: 'P-256' },
    true,
    ['deriveBits']
  );

  // 2. Import client public key
  const clientPublicKey = await crypto.subtle.importKey(
    'raw',
    clientPublicKeyBytes,
    { name: 'ECDH', namedCurve: 'P-256' },
    false,
    []
  );

  // 3. Derive shared secret via ECDH
  const sharedSecret = new Uint8Array(
    await crypto.subtle.deriveBits(
      { name: 'ECDH', public: clientPublicKey },
      serverKeyPair.privateKey,
      256
    )
  );

  // 4. Export server public key (raw uncompressed)
  const serverPublicKey = new Uint8Array(
    await crypto.subtle.exportKey('raw', serverKeyPair.publicKey)
  );

  // 5. Derive IKM: HKDF(salt=auth, IKM=shared_secret, info="WebPush: info\0" || clientPub || serverPub)
  const ikm = new Uint8Array(
    await crypto.subtle.deriveBits(
      {
        name: 'HKDF',
        hash: 'SHA-256',
        salt: authSecretBytes,
        info: hkdfInfo('WebPush: info', clientPublicKeyBytes, serverPublicKey),
      },
      await importHkdfKey(sharedSecret),
      256
    )
  );

  // 6. Generate random salt
  const salt = crypto.getRandomValues(new Uint8Array(SALT_LENGTH));

  // 7. Derive CEK: HKDF(salt=salt, IKM=ikm, info="Content-Encoding: aes128gcm\0")
  const ikmKey = await importHkdfKey(ikm);
  const contentEncryptionKey = await crypto.subtle.deriveKey(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt,
      info: hkdfInfo('Content-Encoding: aes128gcm'),
    },
    ikmKey,
    { name: 'AES-GCM', length: 128 },
    false,
    ['encrypt']
  );

  // 8. Derive nonce: HKDF(salt=salt, IKM=ikm, info="Content-Encoding: nonce\0")
  const nonce = new Uint8Array(
    await crypto.subtle.deriveBits(
      {
        name: 'HKDF',
        hash: 'SHA-256',
        salt,
        info: hkdfInfo('Content-Encoding: nonce'),
      },
      ikmKey,
      96
    )
  );

  // 9. Pad payload with final record delimiter (0x02)
  const paddedPayload = concat(
    new TextEncoder().encode(payloadBytes),
    new Uint8Array([PADDING_DELIMITER])
  );

  // 10. Encrypt with AES-128-GCM
  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv: nonce },
      contentEncryptionKey,
      paddedPayload
    )
  );

  // 11. Build RFC 8188 content-coding header: salt || rs || idlen || keyid
  const header = new Uint8Array(HEADER_LENGTH);
  header.set(salt, 0);
  new DataView(header.buffer).setUint32(SALT_LENGTH, RECORD_SIZE, false); // big-endian
  header[SALT_LENGTH + 4] = KEY_ID_LENGTH;
  header.set(serverPublicKey, SALT_LENGTH + 5);

  // 12. Body = header || ciphertext
  return concat(header, ciphertext);
}

// =========================================================
// RESPONSE CLASSIFICATION
// =========================================================
// Classifies push service HTTP responses for retry/cleanup logic.
// Returns one of:
//   'success'              — 2xx, notification accepted
//   'stale_subscription'   — 404 or 410, endpoint expired (delete subscription)
//   'retryable'            — 429 or 5xx, transient failure (retry with backoff)
//   'terminal_failed'      — 400/401/403, permanent failure (do not retry)
//   'ambiguous_retryable'  — network error, unknown if delivered
// =========================================================

export function classifyPushResponse(status, headers) {
  if (status >= 200 && status < 300) return 'success';
  if (status === 404 || status === 410) return 'stale_subscription';
  if (status === 429) return 'retryable';
  if (status >= 500) return 'retryable';
  if (status === 400 || status === 401 || status === 403) return 'terminal_failed';
  return 'terminal_failed'; // unknown 4xx → conservative terminal
}

// =========================================================
// BUILD WEB PUSH REQUEST
// =========================================================
// Builds an RFC 8291 aes128gcm request without sending it.
// Returns: { method, endpoint, headers, body }
//
// This is ASYNC because encryption uses WebCrypto.
// =========================================================

export async function buildWebPushRequest(subscription, payload, options = {}) {
  if (!vapidConfig) throw new Error('VAPID not configured — call setVapidDetails first');

  // Parse string payload to string for encryption
  const payloadStr = typeof payload === 'string' ? payload : JSON.stringify(payload);

  // Encrypt payload as RFC 8291 aes128gcm
  const body = await encryptAes128gcmPayload(
    payloadStr,
    subscription.keys.p256dh,
    subscription.keys.auth
  );

  // Build VAPID JWT using @mmmike/web-push's public API
  const endpointOrigin = new URL(subscription.endpoint).origin;
  const ttl = options.TTL !== undefined ? options.TTL : 86400;
  const jwt = await createVapidJwt({
    audience: endpointOrigin,
    subject: vapidConfig.subject,
    publicKey: vapidConfig.publicKey,
    privateKey: vapidConfig.privateKey,
    expiration: Math.min(ttl, 86400), // RFC 8292 caps at 24h
  });

  // Build headers per RFC 8291 / RFC 8292
  const headers = {
    'Authorization': `vapid t=${jwt}, k=${vapidConfig.publicKey}`,
    'Content-Encoding': 'aes128gcm',
    'Content-Type': 'application/octet-stream',
    'TTL': String(ttl),
  };
  if (options.urgency) headers['Urgency'] = options.urgency;
  if (options.topic) headers['Topic'] = options.topic;

  return {
    method: 'POST',
    endpoint: subscription.endpoint,
    headers,
    body,
  };
}

// =========================================================
// SEND WEB PUSH
// =========================================================
// Builds the request via buildWebPushRequest(), then sends via fetch().
// Returns a normalized result object:
//   { ok, status, headers, retryAfter, body, classification }
//
// ok = true only for 2xx responses.
// classification is from classifyPushResponse().
// retryAfter is parsed from Retry-After header (seconds) or null.
// =========================================================

export async function sendWebPush(subscription, payload, options = {}) {
  const requestDetails = await buildWebPushRequest(subscription, payload, options);

  let response;
  try {
    response = await fetch(requestDetails.endpoint, {
      method: requestDetails.method,
      headers: requestDetails.headers,
      body: requestDetails.body || undefined,
    });
  } catch (err) {
    // Network error — no HTTP response received.
    return {
      ok: false,
      status: null,
      headers: null,
      retryAfter: null,
      body: null,
      classification: 'ambiguous_retryable',
      error: err.message || 'Network error',
    };
  }

  const status = response.status;
  const headers = Object.fromEntries(response.headers.entries());
  const classification = classifyPushResponse(status, headers);

  // Parse Retry-After header (seconds)
  let retryAfter = null;
  const retryAfterHeader = headers['retry-after'] || headers['Retry-After'];
  if (retryAfterHeader) {
    const parsed = parseInt(retryAfterHeader, 10);
    if (!isNaN(parsed)) retryAfter = parsed;
  }

  // Read response body (may be empty for push services)
  let bodyText = null;
  try {
    bodyText = await response.text();
  } catch {
    // Body read failure is non-critical
  }

  return {
    ok: status >= 200 && status < 300,
    status,
    headers,
    retryAfter,
    body: bodyText,
    classification,
  };
}

// =========================================================
// COMPATIBILITY EXPORT
// =========================================================
// Provides a webpush-compatible interface for callers that use
// setVapidDetails() and generateVAPIDKeys().

export const webpush = {
  setVapidDetails,
  generateVAPIDKeys: _generateVapidKeys,
};
