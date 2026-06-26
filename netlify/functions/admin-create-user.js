const { createClient } = require('@supabase/supabase-js');
const crypto = require('crypto');
const { rateLimit } = require('./_rate-limit');

exports.handler = async (event, context) => {
  const allowedOrigins = ['https://www.bathily-convoyage.fr', 'https://bathily-convoyage.fr', 'http://localhost:5173', 'http://localhost:3000'];
  const origin = event.headers.origin || event.headers.Origin || '';
  const corsOrigin = allowedOrigins.includes(origin) ? origin : allowedOrigins[0];
  
  const headers = {
    'Access-Control-Allow-Origin': corsOrigin,
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Content-Type': 'application/json'
  };

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers, body: '' };
  }

  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method Not Allowed' }) };
  }

  // Rate limiting: 10 / minute / IP
  const rl = rateLimit(event, 'admin-create-user', 10, 60000);
  if (rl) return rl;

  try {
    const authHeader = event.headers.authorization || event.headers.Authorization || '';
    if (!authHeader.startsWith('Bearer ')) {
      return { statusCode: 401, headers, body: JSON.stringify({ error: 'Token requis.' }) };
    }
    const token = authHeader.split(' ')[1];

    const supabaseUrl = process.env.SUPABASE_URL;
    const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
    const supabaseAnonKey = process.env.SUPABASE_ANON_KEY || supabaseServiceKey;

    if (!supabaseUrl || !supabaseServiceKey) {
      throw new Error("Configuration Supabase manquante côté serveur.");
    }

    const supabaseAdmin = createClient(supabaseUrl, supabaseServiceKey, {
      auth: { autoRefreshToken: false, persistSession: false }
    });
    
    const supabaseAnon = createClient(supabaseUrl, supabaseAnonKey, {
      auth: { autoRefreshToken: false, persistSession: false }
    });

    // 1. Vérifier l'utilisateur courant (l'Admin)
    const { data: { user }, error: authError } = await supabaseAnon.auth.getUser(token);
    if (authError || !user) {
      return { statusCode: 401, headers, body: JSON.stringify({ error: 'Session invalide.' }) };
    }

    // 2. Vérifier que c'est bien un Admin
    const { data: profile } = await supabaseAdmin
      .from('clients')
      .select('role')
      .eq('auth_user_id', user.id)
      .single();

    if (!profile || profile.role !== 'admin') {
      return { statusCode: 403, headers, body: JSON.stringify({ error: 'Accès refusé. Rôle administrateur requis.' }) };
    }

    // 3. Lire le payload
    const { targetTable, payload } = JSON.parse(event.body);
    if (!['clients', 'convoyeurs'].includes(targetTable)) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: 'Table cible invalide.' }) };
    }

    const email = payload.email;
    if (!email) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: 'Email obligatoire.' }) };
    }

    // 4. Creer le compte Auth avec mot de passe temporaire (sans envoi email Supabase)
    const tempPassword = 'TempPass_' + crypto.randomBytes(6).toString('hex').slice(0, 8) + '!1';
    const { data: createData, error: createError } = await supabaseAdmin.auth.admin.createUser({
      email: email,
      password: tempPassword,
      email_confirm: true
    });

    if (createError) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: 'Erreur creation compte: ' + createError.message }) };
    }

    const newUserId = createData.user.id;

    // 5. Inserer dans la table correspondante
    const insertPayload = {
      ...payload,
      auth_user_id: newUserId
    };

    if (targetTable === 'clients') {
      insertPayload.role = 'client';
    }

    const { error: insertError } = await supabaseAdmin
      .from(targetTable)
      .insert([insertPayload]);

    if (insertError) {
      await supabaseAdmin.auth.admin.deleteUser(newUserId);
      return { statusCode: 500, headers, body: JSON.stringify({ error: 'Erreur base de donnees: ' + insertError.message }) };
    }

    // 6. Generer un lien de recovery et l'envoyer via Resend
    const redirectToUrl = `${corsOrigin}/reset-password.html`;
    try {
      const { data: resetData } = await supabaseAdmin.auth.admin.generateLink('recovery', email, {
        redirectTo: redirectToUrl
      });
      const resetUrl = resetData?.properties?.action_link || resetData?.properties?.redirect_to || redirectToUrl;

      const resendApiKey = process.env.RESEND_API_KEY;
      const FROM_EMAIL = process.env.EMAIL_FROM || 'onboarding@resend.dev';
      const prenom = payload.prenom || '';

      if (resendApiKey) {
        await fetch('https://api.resend.com/emails', {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${resendApiKey}`,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            from: `Bathily Convoyage <${FROM_EMAIL}>`,
            to: [email],
            subject: 'Bienvenue sur Bathily Convoyage - Definissez votre mot de passe',
            html: `<div style="font-family: 'Inter', Arial, sans-serif; max-width: 600px; margin: 0 auto; background: #FDFBF7; padding: 40px;">
              <div style="text-align: center; margin-bottom: 30px;">
                <h1 style="color: #0A4D68; font-size: 1.5rem; margin: 0;">Bathily-Convoyage</h1>
                <p style="color: #6B625A; font-size: 0.85rem;">Convoyage automobile professionnel</p>
              </div>
              <div style="background: white; border-radius: 16px; padding: 30px; box-shadow: 0 4px 12px rgba(0,0,0,0.05);">
                <h2 style="color: #0A4D68; margin-top: 0;">Bienvenue ${prenom} !</h2>
                <p style="color: #2D2A24; font-size: 0.95rem; line-height: 1.6;">
                  Votre compte a ete cree. Pour definir votre mot de passe et acceder a votre espace, cliquez sur le bouton ci-dessous :
                </p>
                <div style="text-align: center; margin: 30px 0;">
                  <a href="${resetUrl}" style="background: #0A4D68; color: white; padding: 14px 32px; border-radius: 12px; text-decoration: none; font-weight: 700; font-size: 0.9rem; display: inline-block;">Definir mon mot de passe</a>
                </div>
                <p style="color: #6B625A; font-size: 0.8rem; line-height: 1.5;">
                  Si le bouton ne fonctionne pas, copiez-collez ce lien :<br>
                  <a href="${resetUrl}" style="color: #0A4D68; word-break: break-all;">${resetUrl}</a>
                </p>
                <p style="color: #6B625A; font-size: 0.8rem; margin-top: 20px;">Ce lien expirera dans 1 heure.</p>
              </div>
              <p style="text-align: center; color: #6B625A; font-size: 0.75rem; margin-top: 20px;">Bathily-Convoyage - contact@bathily-convoyage.fr</p>
            </div>`
          })
        });
      }
    } catch (emailErr) {
      console.warn('Erreur envoi email reset (non bloquant):', emailErr.message);
    }

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({ success: true, userId: newUserId, message: 'Utilisateur créé et invitation envoyée.' })
    };

  } catch (error) {
    console.error('Erreur API admin-create-user:', error);
    return { statusCode: 500, headers, body: JSON.stringify({ error: error.message || 'Erreur interne' }) };
  }
};
