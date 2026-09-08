// Web Push fetch-based transport adapter (Cloudflare-compatible).
// Uses @pushforge/builder (Web Crypto API) to build the encrypted
// payload + VAPID headers, then sends via fetch().
//
// Replaces the previous web-push dependency that used Node.js
// crypto APIs unavailable in the Cloudflare Pages Functions
// (workerd) runtime.
//
// Public API:
//   setVapidDetails(subject, publicKey, privateKey) → void
//   generateVAPIDKeys() → { publicKey, privateKey }
//   buildWebPushRequest(subscription, payload, options) → Promise<requestDetails>
//   sendWebPush(subscription, payload, options) → Promise<result>
//   classifyPushResponse(status, headers) → classification string

import { buildPushHTTPRequest } from '@pushforge/builder';

// =========================================================
// VAPID CONFIGURATION
// =========================================================

let vapidConfig = null;

export function setVapidDetails(subject, publicKey, privateKey) {
  vapidConfig = { subject, publicKey, privateKey, jwk: null };
}

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
  // Normalize standard base64 to base64url, then decode
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
// VAPID KEY CONVERSION
// =========================================================
// Converts the base64url raw VAPID key pair (as stored in Cloudflare
// secrets and produced by web-push.generateVAPIDKeys) to the JWK
// format required by @pushforge/builder.
//
// Raw public key: 65 bytes (0x04 + x[32] + y[32]), base64url encoded
// Raw private key: 32 bytes (d), base64url encoded

function buildVapidJwk(publicKey, privateKey) {
  const rawPub = base64UrlDecodeToBytes(publicKey);
  if (rawPub.length !== 65 || rawPub[0] !== 0x04) {
    throw new Error('Invalid VAPID public key: expected 65-byte uncompressed P-256 point');
  }
  const x = base64UrlEncode(rawPub.slice(1, 33));
  const y = base64UrlEncode(rawPub.slice(33, 65));
  // Private key is already base64url encoded — JWK d uses the same encoding
  return { kty: 'EC', crv: 'P-256', x, y, d: privateKey };
}

async function getVapidJwk() {
  if (!vapidConfig) throw new Error('VAPID not configured — call setVapidDetails first');
  if (!vapidConfig.jwk) {
    vapidConfig.jwk = buildVapidJwk(vapidConfig.publicKey, vapidConfig.privateKey);
  }
  return vapidConfig.jwk;
}

// =========================================================
// VAPID KEY GENERATION (WebCrypto)
// =========================================================

export async function generateVAPIDKeys() {
  const keyPair = await crypto.subtle.generateKey(
    { name: 'ECDSA', namedCurve: 'P-256' },
    true,
    ['sign', 'verify']
  );
  const publicRaw = await crypto.subtle.exportKey('raw', keyPair.publicKey);
  const privateJwk = await crypto.subtle.exportKey('jwk', keyPair.privateKey);
  return {
    publicKey: base64UrlEncode(publicRaw),
    privateKey: privateJwk.d,
  };
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
// Uses @pushforge/builder's buildPushHTTPRequest() to produce:
//   { method, endpoint, headers, body }
// The body is an ArrayBuffer containing the aesgcm-encrypted payload.
// Headers include Authorization (VAPID JWT + public key), TTL,
// Content-Encoding, Content-Type, Urgency, Encryption, Crypto-Key.
//
// This is ASYNC because buildPushHTTPRequest uses WebCrypto.
// =========================================================

export async function buildWebPushRequest(subscription, payload, options = {}) {
  const jwk = await getVapidJwk();

  // Parse string payload to object for PushForge (it JSON.stringifies internally)
  const payloadObj = typeof payload === 'string' ? JSON.parse(payload) : payload;

  const pushOptions = {};
  if (options.TTL !== undefined) pushOptions.ttl = options.TTL;
  if (options.urgency) pushOptions.urgency = options.urgency;
  if (options.topic) pushOptions.topic = options.topic;

  // @pushforge/builder validates that endpoints must use HTTPS.
  // For local testing with HTTP mock servers, temporarily swap the
  // endpoint scheme to pass validation, then restore the original
  // endpoint for the actual fetch call.
  const originalEndpoint = subscription.endpoint;
  let subscriptionForBuild = subscription;
  if (originalEndpoint.startsWith('http://')) {
    subscriptionForBuild = {
      ...subscription,
      endpoint: 'https://' + originalEndpoint.slice(7),
    };
  }

  const { headers, body } = await buildPushHTTPRequest({
    privateJWK: jwk,
    subscription: subscriptionForBuild,
    message: {
      payload: payloadObj,
      adminContact: vapidConfig.subject,
      options: pushOptions,
    },
  });

  // Normalize headers to plain object for consistent access
  let headersObj;
  if (headers instanceof Headers) {
    headersObj = {};
    for (const [key, value] of headers.entries()) {
      headersObj[key] = value;
    }
  } else {
    headersObj = headers;
  }

  return {
    method: 'POST',
    endpoint: originalEndpoint,
    headers: headersObj,
    body,
  };
}

// =========================================================
// SEND WEB PUSH
// =========================================================
// Builds the request via buildPushHTTPRequest(), then sends via fetch().
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
  generateVAPIDKeys,
};
