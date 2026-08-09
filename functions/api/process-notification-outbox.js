import { createClient } from '@supabase/supabase-js';
import { getCorsHeaders, jsonResponse, handleOptions } from '../_utils.js';
import { sendEmail, wrapEmailLayout } from '../_email.js';

const SUBJECTS = {
  mission_assigned: 'Votre mission est assignée',
  edl_departure_validated: 'Départ confirmé',
  edl_arrival_validated: 'Arrivée confirmée',
  mission_delivered: 'Mission livrée',
  mission_cancelled: 'Mission annulée'
};

function buildBody(reference, type) {
  const title = SUBJECTS[type] || 'Notification mission';
  const body = `<p>Notification concernant la mission <strong>${reference}</strong>.</p>`;
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
    const authHeader = request.headers.get('authorization') || '';
    if (!authHeader.startsWith('Bearer ')) {
      return jsonResponse({ error: 'Authentification requise.' }, 401, getCorsHeaders(request));
    }

    if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) {
      return jsonResponse({ error: 'Configuration Supabase manquante.' }, 500, getCorsHeaders(request));
    }

    const supabase = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY);
    const token = authHeader.split(' ')[1];
    const { data: { user }, error: userErr } = await supabase.auth.getUser(token);
    if (userErr || !user) {
      return jsonResponse({ error: 'Token invalide.' }, 401, getCorsHeaders(request));
    }

    const { data: profile } = await supabase.rpc('is_internal_user');
    if (!profile) {
      return jsonResponse({ error: 'Accès réservé admin/operator.' }, 403, getCorsHeaders(request));
    }

    const { data: rows, error: rpcErr } = await supabase.rpc('process_notification_outbox', { p_limit: 10 });
    if (rpcErr) throw rpcErr;

    const results = [];
    for (const row of (rows || [])) {
      const outbox = await supabase
        .from('notification_outbox')
        .select('id, payload, status, attempts, mission_id')
        .eq('id', row.id)
        .single();

      if (outbox.error || !outbox.data || outbox.data.status !== 'prepared') {
        results.push({ id: row.id, status: outbox.data?.status || 'skipped' });
        continue;
      }

      const { payload } = outbox.data;
      const to = payload?.to;
      const subject = payload?.subject;
      const html = payload?.body;

      if (!to || !subject || !html) {
        await supabase
          .from('notification_outbox')
          .update({ status: 'failed', last_error: 'Payload incomplet' })
          .eq('id', row.id);
        results.push({ id: row.id, status: 'failed' });
        continue;
      }

      try {
        const res = await sendEmail({ to, subject, html }, env);
        await supabase
          .from('notification_outbox')
          .update({
            status: 'sent',
            sent_at: new Date().toISOString(),
            attempts: (outbox.data.attempts || 0) + 1,
            last_error: null,
            payload: { ...payload, provider_message_id: res?.id }
          })
          .eq('id', row.id);
        results.push({ id: row.id, status: 'sent', message_id: res?.id });
      } catch (sendErr) {
        const attempts = (outbox.data.attempts || 0) + 1;
        const nextStatus = attempts >= 3 ? 'failed' : 'retry';
        await supabase
          .from('notification_outbox')
          .update({ status: nextStatus, attempts, last_error: sendErr.message })
          .eq('id', row.id);
        results.push({ id: row.id, status: nextStatus, error: sendErr.message });
      }
    }

    return jsonResponse({ processed: results.length, results }, 200, getCorsHeaders(request));
  } catch (err) {
    return jsonResponse({ error: err.message }, 500, getCorsHeaders(request));
  }
}
