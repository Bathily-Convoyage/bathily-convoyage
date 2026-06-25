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
    const { email } = JSON.parse(event.body);
    if (!email) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: 'Email requis.' }) };
    }

    const cleanEmail = email.trim().toLowerCase();

    if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
      throw new Error('Configuration Supabase manquante.');
    }

    const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
      auth: { autoRefreshToken: false, persistSession: false }
    });

    // 1. Verifier si le client existe dans la table
    const { data: clientRow } = await supabase
      .from('clients')
      .select('id, prenom, nom, auth_user_id')
      .eq('email', cleanEmail)
      .maybeSingle();

    if (!clientRow) {
      return { statusCode: 404, headers, body: JSON.stringify({ error: 'Aucun compte client trouve avec cet email.' }) };
    }

    // 2. Si pas de compte Auth, en creer un
    let authUserId = clientRow.auth_user_id;

    if (!authUserId) {
      const tempPassword = 'TempPass_' + Math.random().toString(36).slice(2, 10) + '!1';
      const { data: createData, error: createError } = await supabase.auth.admin.createUser({
        email: cleanEmail,
        password: tempPassword,
        email_confirm: true
      });

      if (createError) {
        const { data: userList } = await supabase.auth.admin.listUsers();
        const existingUser = userList?.users?.find(u => u.email === cleanEmail);
        if (existingUser) {
          authUserId = existingUser.id;
        } else {
          return { statusCode: 400, headers, body: JSON.stringify({ error: 'Impossible de creer le compte: ' + createError.message }) };
        }
      } else {
        authUserId = createData.user.id;
      }

      if (authUserId) {
        await supabase.from('clients').update({ auth_user_id: authUserId }).eq('id', clientRow.id);
      }
    }

    // 3. Generer un lien de recovery
    const redirectTo = corsOrigin + '/reset-password.html';
    let resetUrl = null;

    // Methode 1: generateLink type recovery
    try {
      const { data: resetData, error: resetError } = await supabase.auth.admin.generateLink('recovery', cleanEmail, {
        redirectTo: redirectTo
      });
      if (!resetError && resetData) {
        resetUrl = resetData.properties?.action_link || resetData.properties?.redirect_to || null;
      }
    } catch (e) {
      console.warn('generateLink recovery failed:', e.message);
    }

    // Methode 2: generateLink type invite (fallback)
    if (!resetUrl) {
      try {
        const { data: inviteData, error: inviteError } = await supabase.auth.admin.generateLink('invite', cleanEmail, {
          redirectTo: redirectTo
        });
        if (!inviteError && inviteData) {
          resetUrl = inviteData.properties?.action_link || inviteData.properties?.redirect_to || null;
        }
      } catch (e) {
        console.warn('generateLink invite failed:', e.message);
      }
    }

    // Methode 3: resetPasswordForEmail cote serveur (fallback)
    if (!resetUrl) {
      try {
        const { error: rpcError } = await supabase.auth.resetPasswordForEmail(cleanEmail, {
          redirectTo: redirectTo
        });
        if (!rpcError) {
          return {
            statusCode: 200,
            headers,
            body: JSON.stringify({ success: true, message: 'Email de reinitialisation envoye.' })
          };
        }
      } catch (e) {
        console.warn('resetPasswordForEmail fallback failed:', e.message);
      }
    }

    if (!resetUrl) {
      return { statusCode: 500, headers, body: JSON.stringify({ error: 'Impossible de generer le lien de reset. Contactez l administrateur.' }) };
    }

    // 4. Envoyer via Resend
    const resendApiKey = process.env.RESEND_API_KEY;
    const FROM_EMAIL = process.env.EMAIL_FROM || 'onboarding@resend.dev';
    const prenom = clientRow.prenom || '';

    const emailHtml = `
      <div style="font-family: 'Inter', Arial, sans-serif; max-width: 600px; margin: 0 auto; background: #FDFBF7; padding: 40px;">
        <div style="text-align: center; margin-bottom: 30px;">
          <h1 style="color: #0A4D68; font-size: 1.5rem; margin: 0;">Bathily-Convoyage</h1>
          <p style="color: #6B625A; font-size: 0.85rem;">Convoyage automobile professionnel</p>
        </div>
        <div style="background: white; border-radius: 16px; padding: 30px; box-shadow: 0 4px 12px rgba(0,0,0,0.05);">
          <h2 style="color: #0A4D68; margin-top: 0;">Reinitialisation de votre mot de passe</h2>
          <p style="color: #2D2A24; font-size: 0.95rem; line-height: 1.6;">Bonjour ${prenom},</p>
          <p style="color: #2D2A24; font-size: 0.95rem; line-height: 1.6;">
            Pour definir votre mot de passe et acceder a votre espace client, cliquez sur le bouton ci-dessous :
          </p>
          <div style="text-align: center; margin: 30px 0;">
            <a href="${resetUrl}" style="background: #0A4D68; color: white; padding: 14px 32px; border-radius: 12px; text-decoration: none; font-weight: 700; font-size: 0.9rem; display: inline-block;">Definir mon mot de passe</a>
          </div>
          <p style="color: #6B625A; font-size: 0.8rem; line-height: 1.5;">
            Si le bouton ne fonctionne pas, copiez-collez ce lien dans votre navigateur :<br>
            <a href="${resetUrl}" style="color: #0A4D68; word-break: break-all;">${resetUrl}</a>
          </p>
          <p style="color: #6B625A; font-size: 0.8rem; margin-top: 20px;">Ce lien expirera dans 1 heure.</p>
        </div>
        <p style="text-align: center; color: #6B625A; font-size: 0.75rem; margin-top: 20px;">
          Bathily-Convoyage - contact@bathily-convoyage.fr
        </p>
      </div>
    `;

    if (resendApiKey) {
      const response = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${resendApiKey}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          from: `Bathily Convoyage <${FROM_EMAIL}>`,
          to: [cleanEmail],
          subject: 'Definissez votre mot de passe - Bathily Convoyage',
          html: emailHtml
        })
      });

      const data = await response.json();
      if (!response.ok) {
        console.error('Erreur Resend:', data);
        return { statusCode: 500, headers, body: JSON.stringify({ error: 'Erreur envoi email: ' + (data.message || 'inconnue') }) };
      }
    } else {
      console.log('[SIMULATION] Email reset password client pour:', cleanEmail);
    }

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({ success: true, message: 'Email de reinitialisation envoye.' })
    };

  } catch (error) {
    console.error('Erreur client-reset-password:', error);
    return { statusCode: 500, headers, body: JSON.stringify({ error: error.message || 'Erreur interne' }) };
  }
};
