import { createClient } from '@supabase/supabase-js';
import { getCorsHeaders, jsonResponse, handleOptions, checkRateLimit, parseBody, randomHex } from '../_utils.js';

export async function onRequest(context) {
  const { request, env } = context;

  const optionsRes = handleOptions(request);
  if (optionsRes) return optionsRes;

  if (request.method !== 'POST') {
    return jsonResponse({ error: 'Method Not Allowed' }, 405, getCorsHeaders(request));
  }

  const rl = checkRateLimit(request, 'convoyeur-reset-password', 5, 3600000);
  if (rl) return rl;

  try {
    const { email } = await parseBody(request);
    if (!email) {
      return jsonResponse({ error: 'Email requis.' }, 400, getCorsHeaders(request));
    }

    const cleanEmail = email.trim().toLowerCase();

    if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) {
      throw new Error('Configuration Supabase manquante.');
    }

    const supabase = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
      auth: { autoRefreshToken: false, persistSession: false }
    });

    const { data: convoyeur } = await supabase.from('convoyeurs')
      .select('id, prenom, nom, auth_user_id').eq('email', cleanEmail).maybeSingle();

    if (!convoyeur) {
      return jsonResponse({ error: 'Aucun compte convoyeur trouvé avec cet email.' }, 404, getCorsHeaders(request));
    }

    let authUserId = convoyeur.auth_user_id;

    if (!authUserId) {
      const tempPassword = 'TempPass_' + randomHex(6).slice(0, 8) + '!1';
      const { data: createData, error: createError } = await supabase.auth.admin.createUser({
        email: cleanEmail, password: tempPassword, email_confirm: true
      });

      if (createError) {
        const { data: userList } = await supabase.auth.admin.listUsers();
        const existingUser = userList?.users?.find(u => u.email === cleanEmail);
        if (existingUser) {
          authUserId = existingUser.id;
        } else {
          return jsonResponse({ error: 'Impossible de créer le compte: ' + createError.message }, 400, getCorsHeaders(request));
        }
      } else {
        authUserId = createData.user.id;
      }

      if (authUserId) {
        await supabase.from('convoyeurs').update({ auth_user_id: authUserId }).eq('id', convoyeur.id);
      }
    }

    const corsOrigin = getCorsHeaders(request)['Access-Control-Allow-Origin'];
    const redirectTo = corsOrigin + '/reset-password.html';
    let resetUrl = null;

    try {
      const { data: resetData } = await supabase.auth.admin.generateLink('recovery', cleanEmail, { redirectTo });
      if (resetData) resetUrl = resetData.properties?.action_link || resetData.properties?.redirect_to || null;
    } catch (e) { console.warn('generateLink recovery failed:', e.message); }

    if (!resetUrl) {
      try {
        const { data: inviteData } = await supabase.auth.admin.generateLink('invite', cleanEmail, { redirectTo });
        if (inviteData) resetUrl = inviteData.properties?.action_link || inviteData.properties?.redirect_to || null;
      } catch (e) { console.warn('generateLink invite failed:', e.message); }
    }

    if (!resetUrl) {
      try {
        const { error: rpcError } = await supabase.auth.resetPasswordForEmail(cleanEmail, { redirectTo });
        if (!rpcError) {
          return jsonResponse({ success: true, message: 'Email de réinitialisation envoyé.' }, 200, getCorsHeaders(request));
        }
      } catch (e) { console.warn('resetPasswordForEmail fallback failed:', e.message); }
    }

    if (!resetUrl) {
      return jsonResponse({ error: 'Impossible de générer le lien de reset.' }, 500, getCorsHeaders(request));
    }

    const resendApiKey = env.RESEND_API_KEY;
    const FROM_EMAIL = env.EMAIL_FROM || 'onboarding@resend.dev';
    const prenom = convoyeur.prenom || '';

    const emailHtml = `<div style="font-family:'Inter',Arial,sans-serif;max-width:600px;margin:0 auto;background:#FDFBF7;padding:40px;">
      <div style="text-align:center;margin-bottom:30px"><h1 style="color:#0A4D68;font-size:1.5rem;margin:0">Bathily-Convoyage</h1></div>
      <div style="background:white;border-radius:16px;padding:30px;box-shadow:0 4px 12px rgba(0,0,0,.05)">
      <h2 style="color:#0A4D68;margin-top:0">Réinitialisation de votre mot de passe</h2>
      <p style="color:#2D2A24;font-size:.95rem">Bonjour ${prenom},</p>
      <p style="color:#2D2A24;font-size:.95rem">Cliquez ci-dessous pour définir votre mot de passe :</p>
      <div style="text-align:center;margin:30px 0"><a href="${resetUrl}" style="background:#0A4D68;color:white;padding:14px 32px;border-radius:12px;text-decoration:none;font-weight:700;display:inline-block">Définir mon mot de passe</a></div>
      <p style="color:#6B625A;font-size:.8rem">Ce lien expirera dans 1 heure.</p></div></div>`;

    if (resendApiKey) {
      const response = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${resendApiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ from: `Bathily Convoyage <${FROM_EMAIL}>`, to: [cleanEmail], subject: 'Définissez votre mot de passe - Bathily Convoyage', html: emailHtml })
      });
      if (!response.ok) {
        const data = await response.json();
        return jsonResponse({ error: 'Erreur envoi email: ' + (data.message || 'inconnue') }, 500, getCorsHeaders(request));
      }
    }

    return jsonResponse({ success: true, message: 'Email de réinitialisation envoyé.' }, 200, getCorsHeaders(request));

  } catch (error) {
    console.error('Erreur convoyeur-reset-password:', error);
    return jsonResponse({ error: error.message || 'Erreur interne' }, 500, getCorsHeaders(request));
  }
}
