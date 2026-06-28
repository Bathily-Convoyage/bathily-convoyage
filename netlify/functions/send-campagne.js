const { createClient } = require('@supabase/supabase-js');

exports.handler = async (event, context) => {
  const headers = {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS'
  };

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers, body: '' };
  }

  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers, body: JSON.stringify({ error: 'POST requis' }) };
  }

  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const resendApiKey = process.env.RESEND_API_KEY;

  if (!supabaseUrl || !supabaseServiceKey || !resendApiKey) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'Variables manquantes' }) };
  }

  try {
    const { sujet, contenu } = JSON.parse(event.body);
    if (!sujet || !contenu) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: 'Sujet et contenu requis' }) };
    }

    const sb = createClient(supabaseUrl, supabaseServiceKey);

    // Recuperer tous les abonnes actifs
    const { data: subscribers, error: subErr } = await sb
      .from('newsletter_subscribers')
      .select('email, nom')
      .eq('statut', 'actif')
      .limit(1000);

    if (subErr) throw subErr;
    if (!subscribers || subscribers.length === 0) {
      return { statusCode: 200, headers, body: JSON.stringify({ sent: 0, message: 'Aucun abonné actif' }) };
    }

    // Enregistrer la campagne
    const { data: campagne, error: campErr } = await sb.from('campagnes').insert({
      sujet: sujet,
      contenu: contenu,
      statut: 'envoyee',
      destinataires: subscribers.length,
      envoyee_le: new Date().toISOString()
    }).select().single();

    if (campErr) console.warn('Erreur enregistrement campagne:', campErr.message);

    // Envoyer les emails par batch via Resend
    const html = `
      <div style="font-family:Inter,sans-serif;max-width:600px;margin:0 auto;background:#FDFBF7;padding:32px;">
        <div style="text-align:center;margin-bottom:24px;">
          <span style="font-size:1.5rem;font-weight:800;color:#0A4D68;">Bathily-Convoyage</span>
        </div>
        ${contenu}
        <div style="margin-top:32px;padding-top:24px;border-top:1px solid #eee;text-align:center;">
          <p style="font-size:0.75rem;color:#999;">
            Vous recevez cet email car vous êtes inscrit à la newsletter Bathily-Convoyage.
            <br><a href="https://www.bathily-convoyage.fr/unsubscribe.html" style="color:#999;">Se désinscrire</a>
          </p>
        </div>
      </div>
    `;

    let sent = 0;
    const batchSize = 50;
    for (let i = 0; i < subscribers.length; i += batchSize) {
      const batch = subscribers.slice(i, i + batchSize);
      const to = batch.map(s => s.email);

      try {
        await fetch('https://api.resend.com/emails', {
          method: 'POST',
          headers: {
            'Authorization': 'Bearer ' + resendApiKey,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            from: 'Bathily-Convoyage <newsletter@bathily-convoyage.fr>',
            bcc: to,
            subject: sujet,
            html: html
          })
        });
        sent += batch.length;
      } catch (e) {
        console.error('Erreur batch email:', e.message);
      }
    }

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({ sent: sent, campagne_id: campagne?.id })
    };
  } catch (err) {
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: err.message })
    };
  }
};
