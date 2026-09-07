// Web Push fetch-based transport adapter.
// Uses web-push's public generateRequestDetails() API to build the
// encrypted payload + VAPID headers, then sends via fetch() instead of
// https.request(). This avoids the need for enable_nodejs_http_modules
// compatibility flag in Cloudflare Pages Functions.
//
// Public API:
//   buildWebPushRequest(subscription, payload, options) → requestDetails
//   sendWebPush(subscription, payload, options) → { ok, status, headers, retryAfter, body }
//   classifyPushResponse(status, headers) → classification string

import webpush from 'web-push';

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
// Uses web-push's public generateRequestDetails() to produce:
//   { method, endpoint, headers, body, ... }
// The body is a Buffer containing the aes128gcm-encrypted payload.
// Headers include Authorization (VAPID JWT), TTL, Content-Encoding,
// Content-Type, Urgency, and Content-Length.
//
// This does NOT call https.request — it only builds the request.
// =========================================================

export function buildWebPushRequest(subscription, payload, options = {}) {
  // generateRequestDetails is a public method on the web-push singleton.
  // It handles VAPID key validation, payload encryption (aes128gcm),
  // and header construction.
  const requestDetails = webpush.generateRequestDetails(subscription, payload, options);

  return {
    method: requestDetails.method,
    endpoint: requestDetails.endpoint,
    headers: requestDetails.headers,
    body: requestDetails.body,
  };
}

// =========================================================
// SEND WEB PUSH
// =========================================================
// Builds the request via generateRequestDetails(), then sends via fetch().
// Returns a normalized result object:
//   { ok, status, headers, retryAfter, body, classification }
//
// ok = true only for 2xx responses.
// classification is from classifyPushResponse().
// retryAfter is parsed from Retry-After header (seconds) or null.
// =========================================================

export async function sendWebPush(subscription, payload, options = {}) {
  const requestDetails = buildWebPushRequest(subscription, payload, options);

  let response;
  try {
    response = await fetch(requestDetails.endpoint, {
      method: requestDetails.method,
      headers: requestDetails.headers,
      body: requestDetails.body || undefined,
    });
  } catch (err) {
    // Network error — no HTTP response received.
    // Could not connect, DNS failure, timeout, etc.
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

// Re-export webpush for callers who need generateVAPIDKeys/setVapidDetails
export { webpush };
