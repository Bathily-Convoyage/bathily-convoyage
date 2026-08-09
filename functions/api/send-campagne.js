import { createClient } from '@supabase/supabase-js';
import { getCorsHeaders, jsonResponse, handleOptions, checkRateLimit, parseBody } from '../_utils.js';

export async function onRequest(context) {
  const { request, env } = context;

  const optionsRes = handleOptions(request);
  if (optionsRes) return optionsRes;

  const headers = getCorsHeaders(request);

  if (request.method !== 'POST') {
    return jsonResponse({ error: 'POST requis' }, 405, headers);
  }

  const rl = checkRateLimit(request, 'send-campagne', 3, 60000);
  if (rl) return rl;

  const authHeader = request.headers.get('authorization') || '';
  if (!authHeader.startsWith('Bearer ')) {
    return jsonResponse({ error: 'Authentification admin requise.' }, 401, headers);
  }
  const token = authHeader.split(' ')[1];
  if (!env.SUPABASE_ANON_KEY) {
    return jsonResponse({ error: 'Configuration Supabase manquante.' }, 500, headers);
  }
  const sbAuth = createClient(env.SUPABASE_URL, env.SUPABASE_ANON_KEY);
  const { data: { user }, error: userErr } = await sbAuth.auth.getUser(token);
  if (userErr || !user) {
    return jsonResponse({ error: 'Token invalide.' }, 401, headers);
  }

  const supabaseUrl = env.SUPABASE_URL;
  const supabaseServiceKey = env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !supabaseServiceKey) {
    return jsonResponse({ error: 'Configuration Supabase manquante.' }, 500, headers);
  }
  const supabaseAdmin = createClient(supabaseUrl, supabaseServiceKey, {
    auth: { autoRefreshToken: false, persistSession: false }
  });

  const { data: profile } = await supabaseAdmin
    .from('clients').select('role').eq('auth_user_id', user.id).maybeSingle();
  if (!profile || profile.role !== 'admin') {
    return jsonResponse({ error: 'Accès réservé aux administrateurs.' }, 403, headers);
  }

  const resendApiKey = env.RESEND_API_KEY;
  if (!resendApiKey) {
    return jsonResponse({ error: 'RESEND_API_KEY manquante.' }, 500, headers);
  }

  try {
    const { sujet, contenu } = await parseBody(request);
    if (!sujet || !contenu) {
      return jsonResponse({ error: 'Sujet et contenu requis' }, 400, headers);
    }

    const { data: subscribers, error: subErr } = await supabaseAdmin
      .from('newsletter_subscribers').select('email, nom, unsubscribe_token').eq('statut', 'actif').limit(1000);

    if (subErr) throw subErr;
    if (!subscribers || subscribers.length === 0) {
      return jsonResponse({ sent: 0, message: 'Aucun abonné actif' }, 200, headers);
    }

    const { data: campagne, error: campErr } = await supabaseAdmin.from('campagnes').insert({
      sujet, contenu, statut: 'envoyee', destinataires: subscribers.length, envoyee_le: new Date().toISOString()
    }).select().single();

    if (campErr) console.warn('Erreur enregistrement campagne:', campErr.message);

    let sent = 0;
    for (const subscriber of subscribers) {
      const token = subscriber.unsubscribe_token || '';
      const html = `<div style="font-family:Inter,sans-serif;max-width:600px;margin:0 auto;background:#FDFBF7;padding:32px;">
        <div style="text-align:center;margin-bottom:24px"><span style="font-size:1.5rem;font-weight:800;color:#0A4D68">Bathily-Convoyage</span></div>
        ${contenu}
        <div style="margin-top:32px;padding-top:24px;border-top:1px solid #eee;text-align:center">
          <p style="font-size:.75rem;color:#999">Vous recevez cet email car vous êtes inscrit à la newsletter Bathily-Convoyage.<br>
          <a href="https://www.bathily-convoyage.fr/unsubscribe.html?token=${encodeURIComponent(token)}" style="color:#999">Se désinscrire</a></p>
        </div></div>`;

      try {
        await fetch('https://api.resend.com/emails', {
          method: 'POST', headers: { 'Authorization': 'Bearer ' + resendApiKey, 'Content-Type': 'application/json' },
          body: JSON.stringify({ from: 'Bathily-Convoyage <newsletter@bathily-convoyage.fr>', to: [subscriber.email], subject: sujet, html })
        });
        sent += 1;
      } catch (e) {
        console.error('Erreur envoi email:', e.message);
      }
    }

    return jsonResponse({ sent, campagne_id: campagne?.id }, 200, headers);

  } catch (err) {
    return jsonResponse({ error: err.message }, 500, headers);
  }
}
