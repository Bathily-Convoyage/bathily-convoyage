import { createClient } from '@supabase/supabase-js';
import { getCorsHeaders, jsonResponse, handleOptions, escapeHtml } from '../_utils.js';
import { sendEmail, wrapEmailLayout } from '../_email.js';

const SUBJECTS = {
  mission_assigned: 'Votre mission est assignée',
  edl_departure_validated: 'Départ confirmé',
  mission_started: 'Mission en cours',
  edl_arrival_validated: 'Arrivée confirmée',
  mission_delivered: 'Mission livrée',
  mission_cancelled: 'Mission annulée'
};

function buildBody(reference, type) {
  const title = SUBJECTS[type] || 'Notification mission';
  const safeRef = escapeHtml(reference);
  const body = `<p>Notification concernant la mission <strong>${safeRef}</strong>.</p>`;
  return wrapEmailLayout(title, body);
}

// =========================================================
// PERSISTENCE ERROR — distinct from provider errors
// =========================================================
class PersistenceError extends Error {
  constructor(message) {
    super(message);
    this.name = 'PersistenceError';
  }
}

// =========================================================
// CONTROLLED OUTBOX UPDATE HELPER
//
// Executes an UPDATE with compare-and-set protection:
//   id = expected row
//   status = 'prepared'
//   attempts = expected current attempts
//
// Verifies:
//   1. No PostgREST error
//   2. Exactly one row affected (data != null)
//
// Throws PersistenceError on any failure.
// Never masks a PostgREST error.
// =========================================================
async function updateOutboxState(supabase, id, expectedAttempts, update) {
  const { data, error } = await supabase
    .from('notification_outbox')
    .update(update)
    .eq('id', id)
    .eq('status', 'prepared')
    .eq('attempts', expectedAttempts)
    .select('id')
    .maybeSingle();

  if (error) {
    throw new PersistenceError(`Outbox update error: ${error.message}`);
  }
  if (!data) {
    throw new PersistenceError('Outbox update affected 0 rows (CAS mismatch)');
  }
  return data;
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

    if (!env.CRON_SECRET) {
      return jsonResponse({ error: 'Configuration CRON_SECRET manquante.' }, 500, getCorsHeaders(request));
    }

    const cronSecret = request.headers.get('x-cron-secret') || '';

    if (!cronSecret || cronSecret !== env.CRON_SECRET) {
      return jsonResponse({ error: 'Non autorisé.' }, 401, getCorsHeaders(request));
    }

    const supabase = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY);

    const { data: rows, error: rpcErr } = await supabase.rpc('process_notification_outbox', { p_limit: 10 });
    if (rpcErr) throw rpcErr;

    const results = [];
    for (const row of (rows || [])) {
      const outbox = await supabase
        .from('notification_outbox')
        .select('id, notification_type, payload, status, attempts, mission_id, prepared_at, sent_at')
        .eq('id', row.id)
        .single();

      if (outbox.error || !outbox.data || outbox.data.status !== 'prepared') {
        results.push({ id: row.id, status: outbox.data?.status || row.status || 'skipped' });
        continue;
      }

      const { payload, attempts: currentAttempts } = outbox.data;
      const to = payload?.to;
      const subject = payload?.subject;
      const html = payload?.body;

      // ─── INCOMPLETE PAYLOAD → failed (no provider call) ───
      if (!to || !subject || !html) {
        try {
          await updateOutboxState(supabase, row.id, currentAttempts, {
            status: 'failed', prepared_at: null, sent_at: null, last_error: 'Payload incomplet'
          });
          results.push({ id: row.id, status: 'failed' });
        } catch (persistErr) {
          // Persistence failure → STOP batch, HTTP 500
          return jsonResponse({ error: 'Outbox persistence failure' }, 500, getCorsHeaders(request));
        }
        continue;
      }

      const idempotencyKey = `notification-outbox/${outbox.data.id}`;
      const newAttempts = (currentAttempts || 0) + 1;

      // ─── PHASE A: PROVIDER CALL (isolated from DB ACK) ───
      let providerResult = null;
      let providerError = null;
      try {
        providerResult = await sendEmail({ to, subject, html, idempotencyKey }, env);
      } catch (err) {
        providerError = err;
      }

      // ─── PHASE B: PERSIST PROVIDER OUTCOME ───
      if (providerError === null) {
        // Provider success → persist sent
        try {
          await updateOutboxState(supabase, row.id, currentAttempts, {
            status: 'sent',
            sent_at: new Date().toISOString(),
            attempts: newAttempts,
            prepared_at: null,
            last_error: null,
            payload: { ...payload, provider_message_id: providerResult?.id }
          });
          results.push({ id: row.id, status: 'sent', message_id: providerResult?.id });
        } catch (persistErr) {
          // DB ACK failure after provider success:
          // DO NOT report sent, DO NOT retry provider, STOP batch
          return jsonResponse({ error: 'Outbox persistence failure' }, 500, getCorsHeaders(request));
        }
      } else {
        // Provider failure → persist retry/failed
        const nextStatus = newAttempts >= 3 ? 'failed' : 'retry';
        try {
          await updateOutboxState(supabase, row.id, currentAttempts, {
            status: nextStatus,
            attempts: newAttempts,
            prepared_at: null,
            sent_at: null,
            last_error: providerError.message
          });
          results.push({ id: row.id, status: nextStatus, error: providerError.message });
        } catch (persistErr) {
          // DB ACK failure after provider failure:
          // DO NOT retry provider, DO NOT report retry/failed, STOP batch
          return jsonResponse({ error: 'Outbox persistence failure' }, 500, getCorsHeaders(request));
        }
      }
    }

    return jsonResponse({ processed: results.length, results }, 200, getCorsHeaders(request));
  } catch (err) {
    return jsonResponse({ error: err.message }, 500, getCorsHeaders(request));
  }
}
