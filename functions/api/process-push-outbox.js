// P3-B2.3B — Push notification outbox consumer.
// Processes push_notification_outbox rows and delivers Web Push
// notifications to all subscribed devices for the target user.
//
// Architecture:
//   1. Auth via OUTBOX_CRON_SECRET (same class as email consumer)
//   2. RPC claim_push_outbox_rows → atomically claim due rows
//   3. Load ALL push_subscriptions for target_user_id
//   4. Send via functions/_push.js (fetch-based, no https.request)
//   5. Classify responses, update delivery state
//   6. Clean stale subscriptions (404/410)
//   7. Retry with exponential backoff
//
// Fully separated from email pipeline. Does NOT modify
// process-notification-outbox.js or notification_outbox table.

import { createClient } from '@supabase/supabase-js';
import { getCorsHeaders, jsonResponse, handleOptions } from '../_utils.js';
import { sendWebPush, classifyPushResponse, webpush } from '../_push.js';

// =========================================================
// CONFIGURATION
// =========================================================

const MAX_ATTEMPTS = 5;

// Exponential backoff: 30s, 60s, 120s, 240s, 480s
function computeBackoff(attempts) {
  const baseSeconds = 30;
  const delay = baseSeconds * Math.pow(2, attempts - 1);
  return new Date(Date.now() + delay * 1000).toISOString();
}

// =========================================================
// PAYLOAD BUILDER
// =========================================================
// Constructs SW-compatible payload: { title, body, url }
// URL is always a relative same-origin path — never external.

function buildPushPayload(notificationType, payload) {
  const missionId = payload?.mission_id;
  const metadata = payload?.metadata || {};

  switch (notificationType) {
    case 'mission_assigned':
      return {
        title: 'Nouvelle mission assignée',
        body: 'Une mission vous a été assignée. Consultez votre tableau de bord.',
        url: '/dashboard-convoyeur.html'
      };
    case 'mission_cancelled':
      return {
        title: 'Mission annulée',
        body: 'Une mission a été annulée. Consultez votre tableau de bord.',
        url: '/dashboard-convoyeur.html'
      };
    default:
      return {
        title: 'Notification Bathily-Convoyage',
        body: 'Vous avez une nouvelle notification.',
        url: '/dashboard-convoyeur.html'
      };
  }
}

// =========================================================
// URL SAFETY
// =========================================================
// Push notification URLs must be same-origin relative paths.
// Never allow external URLs from DB payload.

function validatePushUrl(url) {
  if (!url || typeof url !== 'string') return '/dashboard-convoyeur.html';
  // Must start with / and not // (protocol-relative) or /\\ (UNC path)
  if (url.startsWith('/') && !url.startsWith('//') && !url.startsWith('/\\')) {
    return url;
  }
  // Reject any absolute URL (http://, https://, etc.)
  return '/dashboard-convoyeur.html';
}

// =========================================================
// SANITIZED LOGGING
// =========================================================

function sanitizeForLog(value) {
  if (!value) return null;
  const str = String(value);
  if (str.length <= 20) return str.substring(0, 8) + '...';
  return str.substring(0, 8) + '...(' + str.length + ' chars)';
}

// =========================================================
// CONSUMER
// =========================================================

export async function onRequest(context) {
  const { request, env } = context;

  const optionsRes = handleOptions(request);
  if (optionsRes) return optionsRes;

  if (request.method !== 'POST') {
    return jsonResponse({ error: 'Méthode non autorisée.' }, 405, getCorsHeaders(request));
  }

  try {
    // ── 1. Configuration check ──
    if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) {
      return jsonResponse({ error: 'Configuration Supabase manquante.' }, 500, getCorsHeaders(request));
    }

    // ── 2. Internal auth via OUTBOX_CRON_SECRET ──
    // Same secret class as email consumer — operationally equivalent.
    if (!env.OUTBOX_CRON_SECRET) {
      return jsonResponse({ error: 'Non autorisé.' }, 401, getCorsHeaders(request));
    }

    const cronSecret = request.headers.get('x-cron-secret') || '';
    if (!cronSecret || cronSecret !== env.OUTBOX_CRON_SECRET) {
      return jsonResponse({ error: 'Non autorisé.' }, 401, getCorsHeaders(request));
    }

    // ── 3. VAPID configuration ──
    const vapidSubject = env.URL || 'https://bathily-convoyage.fr';
    const vapidPublicKey = env.VAPID_PUBLIC_KEY;
    const vapidPrivateKey = env.VAPID_PRIVATE_KEY;

    if (!vapidPublicKey || !vapidPrivateKey) {
      // VAPID not configured — mark all due rows as failed
      return jsonResponse({
        error: 'VAPID keys not configured',
        processed: 0
      }, 500, getCorsHeaders(request));
    }

    webpush.setVapidDetails(vapidSubject, vapidPublicKey, vapidPrivateKey);

    const supabase = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY);

    // ── 4. Claim due rows atomically ──
    const { data: claimedRows, error: claimErr } = await supabase.rpc('claim_push_outbox_rows', { p_limit: 10 });
    if (claimErr) throw claimErr;

    const results = [];

    for (const row of (claimedRows || [])) {
      // ── 5. Max attempts check ──
      if (row.attempts >= MAX_ATTEMPTS) {
        await supabase.rpc('complete_push_outbox_row', {
          p_id: row.id,
          p_status: 'failed',
          p_last_error: 'Max attempts reached'
        });
        results.push({ id: row.id, status: 'failed', reason: 'max_attempts' });
        continue;
      }

      // ── 6. Load ALL push_subscriptions for target user ──
      const { data: subscriptions, error: subErr } = await supabase
        .from('push_subscriptions')
        .select('id, endpoint, p256dh, auth_key')
        .eq('user_id', row.target_user_id);

      if (subErr) {
        await supabase.rpc('complete_push_outbox_row', {
          p_id: row.id,
          p_status: 'pending',
          p_last_error: 'Failed to load subscriptions: ' + subErr.message,
          p_next_attempt_at: computeBackoff(row.attempts)
        });
        results.push({ id: row.id, status: 'retry', reason: 'sub_load_error' });
        continue;
      }

      // ── 7. No subscriptions case ──
      if (!subscriptions || subscriptions.length === 0) {
        // Deterministic terminal outcome — no point retrying
        await supabase.rpc('complete_push_outbox_row', {
          p_id: row.id,
          p_status: 'failed',
          p_last_error: 'No push subscriptions for target user'
        });
        results.push({ id: row.id, status: 'failed', reason: 'no_subscriptions' });
        continue;
      }

      // ── 8. Build push payload ──
      const pushPayload = buildPushPayload(row.notification_type, row.payload);
      const safeUrl = validatePushUrl(pushPayload.url);
      const payloadString = JSON.stringify({
        title: pushPayload.title,
        body: pushPayload.body,
        url: safeUrl
      });

      // ── 9. Send to ALL endpoints independently ──
      let anySuccess = false;
      let allStale = true;
      let lastError = null;
      let retryableCount = 0;
      const staleEndpoints = [];

      for (const sub of subscriptions) {
        const subscription = {
          endpoint: sub.endpoint,
          keys: {
            p256dh: sub.p256dh,
            auth: sub.auth_key
          }
        };

        try {
          const result = await sendWebPush(subscription, payloadString, { TTL: 86400 });

          if (result.ok) {
            anySuccess = true;
            allStale = false;
          } else if (result.classification === 'stale_subscription') {
            staleEndpoints.push({ endpoint: sub.endpoint, id: sub.id });
          } else if (result.classification === 'retryable' || result.classification === 'ambiguous_retryable') {
            retryableCount++;
            allStale = false;
            lastError = result.error || result.classification;
          } else {
            // terminal_failed
            allStale = false;
            lastError = result.error || result.classification;
          }
        } catch (err) {
          retryableCount++;
          allStale = false;
          lastError = err.message;
        }
      }

      // ── 10. Clean stale subscriptions (404/410) ──
      for (const stale of staleEndpoints) {
        await supabase
          .from('push_subscriptions')
          .delete()
          .eq('user_id', row.target_user_id)
          .eq('endpoint', stale.endpoint);
      }

      // ── 11. Determine overall delivery outcome ──
      let finalStatus;
      let finalError = null;
      let nextAttempt = null;

      if (anySuccess) {
        // At least one endpoint succeeded → row is sent
        finalStatus = 'sent';
      } else if (allStale && subscriptions.length > 0) {
        // All endpoints were stale → no valid subscription
        finalStatus = 'failed';
        finalError = 'All subscriptions stale (404/410)';
      } else if (retryableCount > 0) {
        // Some endpoints had transient failures → retry
        finalStatus = 'pending';
        finalError = lastError;
        nextAttempt = computeBackoff(row.attempts);
      } else {
        // All terminal failures
        finalStatus = 'failed';
        finalError = lastError || 'All endpoints returned terminal failure';
      }

      // ── 12. Complete delivery ──
      await supabase.rpc('complete_push_outbox_row', {
        p_id: row.id,
        p_status: finalStatus,
        p_last_error: finalError,
        p_next_attempt_at: nextAttempt
      });

      results.push({
        id: row.id,
        status: finalStatus,
        endpoints_total: subscriptions.length,
        stale_cleaned: staleEndpoints.length,
        retryable: retryableCount
      });
    }

    return jsonResponse({ processed: results.length, results }, 200, getCorsHeaders(request));

  } catch (err) {
    return jsonResponse({ error: err.message }, 500, getCorsHeaders(request));
  }
}
