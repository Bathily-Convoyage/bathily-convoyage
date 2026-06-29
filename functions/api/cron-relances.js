import { createClient } from '@supabase/supabase-js';
import { jsonResponse, handleOptions, parseBody, getQueryParams } from '../_utils.js';

export async function onRequest(context) {
  const { request, env } = context;

  const optionsRes = handleOptions(request);
  if (optionsRes) return optionsRes;

  const headers = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' };

  if (request.method !== 'POST') {
    return jsonResponse({ error: 'POST requis' }, 405, headers);
  }

  const params = getQueryParams(request);
  const cronSecret = request.headers.get('x-cron-secret') || params.secret;
  if (cronSecret !== env.CRON_SECRET) {
    return jsonResponse({ error: 'Non autorisé' }, 401, headers);
  }

  const supabaseUrl = env.SUPABASE_URL;
  const supabaseServiceKey = env.SUPABASE_SERVICE_ROLE_KEY;
  const resendApiKey = env.RESEND_API_KEY;

  if (!supabaseUrl || !supabaseServiceKey || !resendApiKey) {
    return jsonResponse({ error: 'Variables manquantes' }, 500, headers);
  }

  const sb = createClient(supabaseUrl, supabaseServiceKey);
  const now = new Date();
  const results = { devis_relances: 0, mission_rappels: 0, errors: [] };

  try {
    const yesterday = new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString();
    const twoDaysAgo = new Date(now.getTime() - 48 * 60 * 60 * 1000).toISOString();

    const { data: devisEnAttente, error: errDevis } = await sb
      .from('devis').select('id, email, prenom, depart, arrivee, vehicule, prix, created_at')
      .eq('statut', 'en_attente').gte('created_at', twoDaysAgo).lte('created_at', yesterday)
      .is('relance_envoyee', null).limit(50);

    if (errDevis) results.errors.push('devis query: ' + errDevis.message);

    if (devisEnAttente && devisEnAttente.length > 0) {
      for (const devis of devisEnAttente) {
        try {
          await sendRelanceEmail(devis, resendApiKey);
          await sb.from('devis').update({ relance_envoyee: now.toISOString() }).eq('id', devis.id);
          results.devis_relances++;
        } catch (e) {
          results.errors.push('relance devis ' + devis.id + ': ' + e.message);
        }
      }
    }

    const tomorrow = new Date(now.getTime() + 24 * 60 * 60 * 1000);
    const tomorrowStart = new Date(tomorrow.getFullYear(), tomorrow.getMonth(), tomorrow.getDate()).toISOString();
    const tomorrowEnd = new Date(tomorrow.getFullYear(), tomorrow.getMonth(), tomorrow.getDate(), 23, 59, 59).toISOString();

    const { data: missionsDemain, error: errMissions } = await sb
      .from('missions').select('id, client_email, client_nom, convoyeur_email, convoyeur_nom, depart_ville, arrivee_ville, date_prise_en_charge')
      .eq('statut', 'planifie').gte('date_prise_en_charge', tomorrowStart).lte('date_prise_en_charge', tomorrowEnd)
      .is('rappel_envoye', null).limit(50);

    if (errMissions) results.errors.push('missions query: ' + errMissions.message);

    if (missionsDemain && missionsDemain.length > 0) {
      for (const mission of missionsDemain) {
        try {
          if (mission.client_email) await sendRappelClientEmail(mission, resendApiKey);
          if (mission.convoyeur_email) await sendRappelConvoyeurEmail(mission, resendApiKey);
          await sb.from('missions').update({ rappel_envoye: now.toISOString() }).eq('id', mission.id);
          results.mission_rappels++;
        } catch (e) {
          results.errors.push('rappel mission ' + mission.id + ': ' + e.message);
        }
      }
    }

    return jsonResponse({ success: true, ...results, timestamp: now.toISOString() }, 200, headers);

  } catch (err) {
    return jsonResponse({ error: err.message, ...results }, 500, headers);
  }
}

async function sendRelanceEmail(devis, apiKey) {
  const html = `<div style="font-family:Inter,sans-serif;max-width:600px;margin:0 auto;background:#FDFBF7;padding:32px;">
    <div style="text-align:center;margin-bottom:24px"><span style="font-size:1.5rem;font-weight:800;color:#0A4D68">Bathily-Convoyage</span></div>
    <h2 style="color:#0A4D68">Votre devis vous attend, ${devis.prenom || ''} !</h2>
    <p style="color:#6B625A;font-size:.95rem">Convoyage de ${devis.vehicule || 'véhicule'} de <strong>${devis.depart || ''}</strong> à <strong>${devis.arrivee || ''}</strong>. Prix estimé : <strong>${devis.prix || ''}€</strong>.</p>
    <div style="text-align:center;margin:32px 0"><a href="https://www.bathily-convoyage.fr/devis.html" style="background:#0A4D68;color:white;padding:14px 32px;border-radius:40px;text-decoration:none;font-weight:600;display:inline-block">Finaliser ma demande</a></div>
  </div>`;
  await fetch('https://api.resend.com/emails', {
    method: 'POST', headers: { 'Authorization': 'Bearer ' + apiKey, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from: 'Bathily-Convoyage <noreply@bathily-convoyage.fr>', to: devis.email, subject: '⏰ Votre devis de convoyage vous attend', html })
  });
}

async function sendRappelClientEmail(mission, apiKey) {
  const dateStr = new Date(mission.date_prise_en_charge).toLocaleDateString('fr-FR', { weekday: 'long', day: 'numeric', month: 'long' });
  const html = `<div style="font-family:Inter,sans-serif;max-width:600px;margin:0 auto;background:#FDFBF7;padding:32px;">
    <div style="text-align:center;margin-bottom:24px"><span style="font-size:1.5rem;font-weight:800;color:#0A4D68">Bathily-Convoyage</span></div>
    <h2 style="color:#0A4D68">Rappel : votre mission est demain</h2>
    <p style="color:#6B625A;font-size:.95rem">Bonjour ${mission.client_nom || ''}, c'est demain, <strong>${dateStr}</strong>. Trajet de <strong>${mission.depart_ville || ''}</strong> à <strong>${mission.arrivee_ville || ''}</strong>.</p>
    <div style="text-align:center;margin:32px 0"><a href="https://www.bathily-convoyage.fr/dashboard-client.html" style="background:#0A4D68;color:white;padding:14px 32px;border-radius:40px;text-decoration:none;font-weight:600;display:inline-block">Suivre ma mission</a></div>
  </div>`;
  await fetch('https://api.resend.com/emails', {
    method: 'POST', headers: { 'Authorization': 'Bearer ' + apiKey, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from: 'Bathily-Convoyage <noreply@bathily-convoyage.fr>', to: mission.client_email, subject: '📅 Rappel : votre convoyage est demain', html })
  });
}

async function sendRappelConvoyeurEmail(mission, apiKey) {
  const dateStr = new Date(mission.date_prise_en_charge).toLocaleDateString('fr-FR', { weekday: 'long', day: 'numeric', month: 'long' });
  const html = `<div style="font-family:Inter,sans-serif;max-width:600px;margin:0 auto;background:#FDFBF7;padding:32px;">
    <div style="text-align:center;margin-bottom:24px"><span style="font-size:1.5rem;font-weight:800;color:#0A4D68">Bathily-Convoyage</span></div>
    <h2 style="color:#0A4D68">Rappel : mission demain</h2>
    <p style="color:#6B625A;font-size:.95rem">Bonjour ${mission.convoyeur_nom || ''}, mission demain <strong>${dateStr}</strong> : <strong>${mission.depart_ville || ''}</strong> → <strong>${mission.arrivee_ville || ''}</strong>.</p>
    <div style="text-align:center;margin:32px 0"><a href="https://www.bathily-convoyage.fr/dashboard-convoyeur.html" style="background:#0A4D68;color:white;padding:14px 32px;border-radius:40px;text-decoration:none;font-weight:600;display:inline-block">Voir les détails</a></div>
  </div>`;
  await fetch('https://api.resend.com/emails', {
    method: 'POST', headers: { 'Authorization': 'Bearer ' + apiKey, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from: 'Bathily-Convoyage <noreply@bathily-convoyage.fr>', to: mission.convoyeur_email, subject: '📅 Rappel : mission demain', html })
  });
}
