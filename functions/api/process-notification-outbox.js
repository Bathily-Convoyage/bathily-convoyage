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

      if (!to || !subject || !html) {
        await supabase
          .from('notification_outbox')
          .update({ status: 'failed', prepared_at: null, sent_at: null, last_error: 'Payload incomplet' })
          .eq('id', row.id);
        results.push({ id: row.id, status: 'failed' });
        continue;
      }

      const idempotencyKey = `notification-outbox/${outbox.data.id}`;
      const newAttempts = (currentAttempts || 0) + 1;

      try {
        const res = await sendEmail({ to, subject, html, idempotencyKey }, env);
        await supabase
          .from('notification_outbox')
          .update({
            status: 'sent',
            sent_at: new Date().toISOString(),
            attempts: newAttempts,
            prepared_at: null,
            last_error: null,
            payload: { ...payload, provider_message_id: res?.id }
          })
          .eq('id', row.id);
        results.push({ id: row.id, status: 'sent', message_id: res?.id });
      } catch (sendErr) {
        const nextStatus = newAttempts >= 3 ? 'failed' : 'retry';
        await supabase
          .from('notification_outbox')
          .update({ status: nextStatus, attempts: newAttempts, prepared_at: null, sent_at: null, last_error: sendErr.message })
          .eq('id', row.id);
        results.push({ id: row.id, status: nextStatus, error: sendErr.message });
      }
    }

    return jsonResponse({ processed: results.length, results }, 200, getCorsHeaders(request));
  } catch (err) {
    return jsonResponse({ error: err.message }, 500, getCorsHeaders(request));
  }
}
