const { createClient } = require('@supabase/supabase-js');

exports.handler = async (event, context) => {
  const headers = {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*'
  };

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers, body: '' };
  }

  // Verifier le cron secret
  const cronSecret = event.headers['x-cron-secret'] || event.queryStringParameters?.secret;
  if (cronSecret !== process.env.CRON_SECRET) {
    return { statusCode: 401, headers, body: JSON.stringify({ error: 'Non autorisé' }) };
  }

  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const resendApiKey = process.env.RESEND_API_KEY;

  if (!supabaseUrl || !supabaseServiceKey || !resendApiKey) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'Variables manquantes' }) };
  }

  const sb = createClient(supabaseUrl, supabaseServiceKey);
  const now = new Date();
  const results = { devis_relances: 0, mission_rappels: 0, errors: [] };

  try {
    // ── 1. Relance devis en attente (> 24h sans paiement) ──
    const yesterday = new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString();
    const twoDaysAgo = new Date(now.getTime() - 48 * 60 * 60 * 1000).toISOString();

    const { data: devisEnAttente, error: errDevis } = await sb
      .from('devis')
      .select('id, email, prenom, depart, arrivee, vehicule, prix, created_at')
      .eq('statut', 'en_attente')
      .gte('created_at', twoDaysAgo)
      .lte('created_at', yesterday)
      .is('relance_envoyee', null)
      .limit(50);

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

    // ── 2. Rappel mission J-1 (mission demain) ──
    const tomorrow = new Date(now.getTime() + 24 * 60 * 60 * 1000);
    const tomorrowStart = new Date(tomorrow.getFullYear(), tomorrow.getMonth(), tomorrow.getDate()).toISOString();
    const tomorrowEnd = new Date(tomorrow.getFullYear(), tomorrow.getMonth(), tomorrow.getDate(), 23, 59, 59).toISOString();

    const { data: missionsDemain, error: errMissions } = await sb
      .from('missions')
      .select('id, client_email, client_nom, convoyeur_email, convoyeur_nom, depart_ville, arrivee_ville, date_prise_en_charge')
      .eq('statut', 'planifie')
      .gte('date_prise_en_charge', tomorrowStart)
      .lte('date_prise_en_charge', tomorrowEnd)
      .is('rappel_envoye', null)
      .limit(50);

    if (errMissions) results.errors.push('missions query: ' + errMissions.message);

    if (missionsDemain && missionsDemain.length > 0) {
      for (const mission of missionsDemain) {
        try {
          if (mission.client_email) {
            await sendRappelClientEmail(mission, resendApiKey);
          }
          if (mission.convoyeur_email) {
            await sendRappelConvoyeurEmail(mission, resendApiKey);
          }
          await sb.from('missions').update({ rappel_envoye: now.toISOString() }).eq('id', mission.id);
          results.mission_rappels++;
        } catch (e) {
          results.errors.push('rappel mission ' + mission.id + ': ' + e.message);
        }
      }
    }

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({ success: true, ...results, timestamp: now.toISOString() })
    };
  } catch (err) {
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: err.message, ...results })
    };
  }
};

async function sendRelanceEmail(devis, apiKey) {
  const html = `
    <div style="font-family:Inter,sans-serif;max-width:600px;margin:0 auto;background:#FDFBF7;padding:32px;">
      <div style="text-align:center;margin-bottom:24px;">
        <span style="font-size:1.5rem;font-weight:800;color:#0A4D68;">Bathily-Convoyage</span>
      </div>
      <h2 style="color:#0A4D68;font-family:Montserrat,sans-serif;">Votre devis vous attend, ${devis.prenom || ''} !</h2>
      <p style="color:#6B625A;font-size:0.95rem;line-height:1.6;">
        Vous avez demandé un devis pour le convoyage de votre ${devis.vehicule || 'véhicule'} de
        <strong>${devis.depart || ''}</strong> à <strong>${devis.arrivee || ''}</strong>.
        Prix estimé : <strong>${devis.prix || ''}€</strong>.
      </p>
      <p style="color:#6B625A;font-size:0.95rem;line-height:1.6;">
        Votre devis est encore valable. Réservez votre convoyeur maintenant pour garantir la disponibilité.
      </p>
      <div style="text-align:center;margin:32px 0;">
        <a href="https://www.bathily-convoyage.fr/devis.html"
           style="background:#0A4D68;color:white;padding:14px 32px;border-radius:40px;text-decoration:none;font-weight:600;display:inline-block;">
          Finaliser ma demande
        </a>
      </div>
      <p style="color:#6B625A;font-size:0.8rem;text-align:center;margin-top:24px;">
        Si vous ne souhaitez plus recevoir d'emails, ignorez ce message.
      </p>
    </div>
  `;

  await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      'Authorization': 'Bearer ' + apiKey,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      from: 'Bathily-Convoyage <noreply@bathily-convoyage.fr>',
      to: devis.email,
      subject: '⏰ Votre devis de convoyage vous attend',
      html: html
    })
  });
}

async function sendRappelClientEmail(mission, apiKey) {
  const dateStr = new Date(mission.date_prise_en_charge).toLocaleDateString('fr-FR', { weekday: 'long', day: 'numeric', month: 'long' });
  const html = `
    <div style="font-family:Inter,sans-serif;max-width:600px;margin:0 auto;background:#FDFBF7;padding:32px;">
      <div style="text-align:center;margin-bottom:24px;">
        <span style="font-size:1.5rem;font-weight:800;color:#0A4D68;">Bathily-Convoyage</span>
      </div>
      <h2 style="color:#0A4D68;font-family:Montserrat,sans-serif;">Rappel : votre mission est demain</h2>
      <p style="color:#6B625A;font-size:0.95rem;line-height:1.6;">
        Bonjour ${mission.client_nom || ''},<br><br>
        C'est demain, <strong>${dateStr}</strong>, que votre véhicule sera pris en charge pour un trajet de
        <strong>${mission.depart_ville || ''}</strong> à <strong>${mission.arrivee_ville || ''}</strong>.
      </p>
      <p style="color:#6B625A;font-size:0.95rem;line-height:1.6;">
        Votre convoyeur ${mission.convoyeur_nom || ''} vous contactera pour confirmer l'heure exacte de rendez-vous.
        Vous recevrez un lien de suivi GPS par SMS/Email dès le départ.
      </p>
      <div style="text-align:center;margin:32px 0;">
        <a href="https://www.bathily-convoyage.fr/dashboard-client.html"
           style="background:#0A4D68;color:white;padding:14px 32px;border-radius:40px;text-decoration:none;font-weight:600;display:inline-block;">
          Suivre ma mission
        </a>
      </div>
    </div>
  `;

  await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      'Authorization': 'Bearer ' + apiKey,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      from: 'Bathily-Convoyage <noreply@bathily-convoyage.fr>',
      to: mission.client_email,
      subject: '📅 Rappel : votre convoyage est demain',
      html: html
    })
  });
}

async function sendRappelConvoyeurEmail(mission, apiKey) {
  const dateStr = new Date(mission.date_prise_en_charge).toLocaleDateString('fr-FR', { weekday: 'long', day: 'numeric', month: 'long' });
  const html = `
    <div style="font-family:Inter,sans-serif;max-width:600px;margin:0 auto;background:#FDFBF7;padding:32px;">
      <div style="text-align:center;margin-bottom:24px;">
        <span style="font-size:1.5rem;font-weight:800;color:#0A4D68;">Bathily-Convoyage</span>
      </div>
      <h2 style="color:#0A4D68;font-family:Montserrat,sans-serif;">Rappel : mission demain</h2>
      <p style="color:#6B625A;font-size:0.95rem;line-height:1.6;">
        Bonjour ${mission.convoyeur_nom || ''},<br><br>
        Vous avez une mission prévue demain, <strong>${dateStr}</strong> :
        trajet de <strong>${mission.depart_ville || ''}</strong> à <strong>${mission.arrivee_ville || ''}</strong>.
      </p>
      <p style="color:#6B625A;font-size:0.95rem;line-height:1.6;">
        Pensez à contacter le client pour confirmer l'heure de rendez-vous.
        N'oubliez pas : état des lieux (20 photos), activation du suivi GPS, et signature à la livraison.
      </p>
      <div style="text-align:center;margin:32px 0;">
        <a href="https://www.bathily-convoyage.fr/dashboard-convoyeur.html"
           style="background:#0A4D68;color:white;padding:14px 32px;border-radius:40px;text-decoration:none;font-weight:600;display:inline-block;">
          Voir les détails
        </a>
      </div>
    </div>
  `;

  await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      'Authorization': 'Bearer ' + apiKey,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      from: 'Bathily-Convoyage <noreply@bathily-convoyage.fr>',
      to: mission.convoyeur_email,
      subject: '📅 Rappel : mission demain',
      html: html
    })
  });
}
