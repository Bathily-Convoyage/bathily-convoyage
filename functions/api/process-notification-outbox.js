import { createClient } from '@supabase/supabase-js';
import { getCorsHeaders, jsonResponse, handleOptions } from '../_utils.js';
import { sendEmail, ProviderError } from '../_email.js';

// =========================================================
// PROD-1D-B.2 — PERMANENT CRON RECOVERY CONSUMER
//
// Architecture:
//   1. Auth via OUTBOX_CRON_SECRET (dedicated, least-privilege)
//   2. RPC process_notification_outbox → prepare rows (freeze to/subject/html)
//   3. RPC begin_delivery_attempt → persistence barrier (freeze from, set
//      delivery_id, first_provider_attempt_at, current_attempt_id, increment
//      attempts, insert ledger row, transition prepared → sending)
//   4. sendEmail with frozen provider_request (verbatim from)
//   5. RPC complete_delivery_attempt → idempotent completion with CAS
//
// No provider call is possible before the persistence barrier succeeds.
// No provider call is possible after 20h idempotency ceiling.
// =========================================================

function buildFromHeader(env) {
  const fromEmail = env.EMAIL_FROM || 'onboarding@resend.dev';
  return `Bathily Convoyage <${fromEmail}>`;
}

export async function onRequest(context) {
  const { request, env } = context;

  const optionsRes = handleOptions(request);
  if (optionsRes) return optionsRes;

  if (request.method !== 'POST') {
    return jsonResponse({ error: 'Méthode non autorisée.' }, 405, getCorsHeaders(request));
  }

  try {
    if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) {
      return jsonResponse({ error: 'Configuration Supabase manquante.' }, 500, getCorsHeaders(request));
    }

    // B.2: authenticate ONLY against OUTBOX_CRON_SECRET (least-privilege).
    // CRON_SECRET MUST NOT authorize this endpoint.
    if (!env.OUTBOX_CRON_SECRET) {
      return jsonResponse({ error: 'Non autorisé.' }, 401, getCorsHeaders(request));
    }

    const cronSecret = request.headers.get('x-cron-secret') || '';
    if (!cronSecret || cronSecret !== env.OUTBOX_CRON_SECRET) {
      return jsonResponse({ error: 'Non autorisé.' }, 401, getCorsHeaders(request));
    }

    const supabase = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY);

    // Step 1: Prepare rows (RPC handles quarantine, stale recovery, preparation)
    const { data: rows, error: rpcErr } = await supabase.rpc('process_notification_outbox', { p_limit: 10 });
    if (rpcErr) throw rpcErr;

    const results = [];
    const fromHeader = buildFromHeader(env);

    for (const row of (rows || [])) {
      // Only process rows that are now 'prepared'
      if (row.status !== 'prepared') {
        results.push({ id: row.id, status: row.status });
        continue;
      }

      // Step 2: Read the prepared row to get current attempts
      const { data: outboxRow, error: fetchErr } = await supabase
        .from('notification_outbox')
        .select('id, attempts, payload, status')
        .eq('id', row.id)
        .single();

      if (fetchErr || !outboxRow || outboxRow.status !== 'prepared') {
        results.push({ id: row.id, status: 'skipped' });
        continue;
      }

      // Step 3: Persistence barrier — begin_delivery_attempt
      const { data: beginResult, error: beginErr } = await supabase.rpc('begin_delivery_attempt', {
        p_outbox_id: outboxRow.id,
        p_expected_attempts: outboxRow.attempts,
        p_from: fromHeader
      });

      if (beginErr) {
        // RPC failure — no provider call
        results.push({ id: row.id, status: 'begin_error', error: beginErr.message });
        continue;
      }

      // beginResult is an array of rows from RETURNS TABLE
      const begin = Array.isArray(beginResult) ? beginResult[0] : beginResult;

      if (!begin || begin.result !== 'ok') {
        // Barrier rejected (cas_mismatch, deadline_expired, invalid_from, etc.)
        results.push({
          id: row.id,
          status: begin?.result || 'begin_failed',
          error: begin?.result
        });
        continue;
      }

      // Step 4: Provider call with frozen provider_request
      const providerRequest = begin.provider_request;
      const idempotencyKey = `notification-outbox/${begin.delivery_id}`;

      let providerResult = null;
      let providerError = null;
      try {
        providerResult = await sendEmail({
          from: providerRequest.from,
          to: providerRequest.to,
          subject: providerRequest.subject,
          html: providerRequest.html,
          idempotencyKey
        }, env);
      } catch (err) {
        providerError = err;
      }

      // Step 5: Complete delivery attempt (idempotent, CAS-protected)
      let classification, httpStatus, errorCode, messageId, lastError, nextRetryAt;

      if (providerError === null) {
        classification = 'success';
        httpStatus = 200;
        errorCode = null;
        messageId = providerResult?.id || null;
        lastError = null;
        nextRetryAt = null;
      } else if (providerError instanceof ProviderError) {
        classification = providerError.classification;
        httpStatus = providerError.httpStatus;
        errorCode = providerError.errorCode;
        messageId = null;
        lastError = providerError.message;

        // Compute next_retry_at for retryable classifications
        if (classification === 'transient_retryable' || classification === 'ambiguous_retryable') {
          const retryAfterSec = providerError.retryAfter || 30;
          nextRetryAt = new Date(Date.now() + retryAfterSec * 1000).toISOString();
        } else {
          nextRetryAt = null;
        }
      } else {
        // Unexpected non-ProviderError → treat as ambiguous
        classification = 'ambiguous_retryable';
        httpStatus = null;
        errorCode = null;
        messageId = null;
        lastError = providerError?.message || 'Unknown error';
        nextRetryAt = new Date(Date.now() + 30 * 1000).toISOString();
      }

      const { data: completeResult, error: completeErr } = await supabase.rpc('complete_delivery_attempt', {
        p_outbox_id: outboxRow.id,
        p_expected_attempt_id: begin.attempt_id,
        p_expected_delivery_id: begin.delivery_id,
        p_attempt_number: begin.attempt_number,
        p_classification: classification,
        p_provider_http_status: httpStatus,
        p_provider_error_code: errorCode,
        p_provider_message_id: messageId,
        p_last_error: lastError,
        p_next_retry_at: nextRetryAt
      });

      if (completeErr) {
        // RPC failure — batch stops
        return jsonResponse({ error: 'Completion RPC failure', detail: completeErr.message }, 500, getCorsHeaders(request));
      }

      const complete = Array.isArray(completeResult) ? completeResult[0] : completeResult;

      if (!complete) {
        return jsonResponse({ error: 'Completion returned no result' }, 500, getCorsHeaders(request));
      }

      if (complete.ack_applied) {
        results.push({
          id: row.id,
          status: complete.outbox_status,
          message_id: messageId,
          attempt_id: begin.attempt_id
        });
      } else {
        // ACK rejected (stale, conflict, invalid transition, etc.)
        // Provider result was persisted (if provider_result_persisted = true)
        results.push({
          id: row.id,
          status: complete.outbox_status || 'unknown',
          failure_reason: complete.failure_reason,
          provider_result_persisted: complete.provider_result_persisted
        });
        // If result_conflict or outbox_cas_mismatch, stop batch
        if (complete.failure_reason === 'result_conflict') {
          return jsonResponse({ error: 'Result conflict on replay', results }, 500, getCorsHeaders(request));
        }
      }
    }

    return jsonResponse({ processed: results.length, results }, 200, getCorsHeaders(request));
  } catch (err) {
    return jsonResponse({ error: err.message }, 500, getCorsHeaders(request));
  }
}
