const { createClient } = require('@supabase/supabase-js');

exports.handler = async (event, context) => {
  const allowedOrigins = ['https://www.bathily-convoyage.fr', 'https://bathily-convoyage.fr'];
  const origin = event.headers.origin || event.headers.Origin || '';
  const corsOrigin = allowedOrigins.includes(origin) ? origin : allowedOrigins[0];
  const headers = {
    'Access-Control-Allow-Origin': corsOrigin,
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Content-Type': 'application/json'
  };

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers, body: '' };
  }

  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method Not Allowed' }) };
  }

  try {
    const { email, password, prenom, nom, telephone, societe, isPro } = JSON.parse(event.body);
    if (!email || !password) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: 'Email et mot de passe requis.' }) };
    }

    if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
      throw new Error('Configuration Supabase manquante.');
    }

    const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
      auth: { autoRefreshToken: false, persistSession: false }
    });

    // 1. Creer le compte Auth avec email_confirm a true (pas d'email Supabase envoye)
    const { data: createData, error: createError } = await supabase.auth.admin.createUser({
      email: email.trim().toLowerCase(),
      password: password,
      email_confirm: true,
      user_metadata: { prenom, nom, source: isPro ? 'pro_signup' : 'client_signup' }
    });

    if (createError) {
      if (createError.message.includes('already') || createError.message.includes('registered')) {
        return { statusCode: 409, headers, body: JSON.stringify({ error: 'already_registered' }) };
      }
      return { statusCode: 400, headers, body: JSON.stringify({ error: createError.message }) };
    }

    const newUserId = createData.user.id;

    // 2. Inserer dans la table clients
    const insertPayload = {
      prenom,
      nom,
      email: email.trim().toLowerCase(),
      telephone: telephone || null,
      societe: societe || null,
      role: 'client',
      auth_user_id: newUserId
    };

    if (isPro) {
      insertPayload.is_pro = true;
      insertPayload.pro_status = 'pending';
    }

    const { error: insertError } = await supabase.from('clients').insert([insertPayload]);

    if (insertError) {
      await supabase.auth.admin.deleteUser(newUserId);
      return { statusCode: 500, headers, body: JSON.stringify({ error: insertError.message }) };
    }

    // 3. Envoyer email de bienvenue via Resend (si pro)
    if (isPro) {
      const resendApiKey = process.env.RESEND_API_KEY;
      const FROM_EMAIL = process.env.EMAIL_FROM || 'onboarding@resend.dev';
      if (resendApiKey) {
        try {
          await fetch('https://api.resend.com/emails', {
            method: 'POST',
            headers: {
              'Authorization': `Bearer ${resendApiKey}`,
              'Content-Type': 'application/json'
            },
            body: JSON.stringify({
              from: `Bathily Convoyage <${FROM_EMAIL}>`,
              to: [email.trim().toLowerCase()],
              subject: 'Demande de compte Pro recue - Bathily Convoyage',
              html: `<div style="font-family: 'Inter', Arial, sans-serif; max-width: 600px; margin: 0 auto; background: #FDFBF7; padding: 40px;">
                <div style="text-align: center; margin-bottom: 30px;">
                  <h1 style="color: #0A4D68; font-size: 1.5rem; margin: 0;">Bathily-Convoyage</h1>
                </div>
                <div style="background: white; border-radius: 16px; padding: 30px;">
                  <h2 style="color: #0A4D68;">Bonjour ${prenom},</h2>
                  <p style="color: #2D2A24; font-size: 0.95rem; line-height: 1.6;">
                    Votre demande de compte Pro a bien ete enregistree.<br>
                    Notre equipe valide votre acces sous 24h ouvrees.
                  </p>
                  <p style="color: #6B625A; font-size: 0.85rem;">Vous recevrez un email de confirmation une fois votre compte valide.</p>
                </div>
              </div>`
            })
          });
        } catch (e) { console.warn('Email pro non envoye:', e.message); }
      }
    }

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({ success: true, userId: newUserId, isPro: !!isPro })
    };

  } catch (error) {
    console.error('Erreur client-signup:', error);
    return { statusCode: 500, headers, body: JSON.stringify({ error: error.message || 'Erreur interne' }) };
  }
};
