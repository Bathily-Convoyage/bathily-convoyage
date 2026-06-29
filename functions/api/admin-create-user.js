import { createClient } from '@supabase/supabase-js';
import { getCorsHeaders, jsonResponse, handleOptions, checkRateLimit, parseBody, randomHex } from '../_utils.js';

export async function onRequest(context) {
  const { request, env } = context;

  const optionsRes = handleOptions(request);
  if (optionsRes) return optionsRes;

  if (request.method !== 'POST') {
    return jsonResponse({ error: 'Method Not Allowed' }, 405, getCorsHeaders(request));
  }

  const rl = checkRateLimit(request, 'admin-create-user', 10, 60000);
  if (rl) return rl;

  try {
    const authHeader = request.headers.get('authorization') || '';
    if (!authHeader.startsWith('Bearer ')) {
      return jsonResponse({ error: 'Token requis.' }, 401, getCorsHeaders(request));
    }
    const token = authHeader.split(' ')[1];

    const supabaseUrl = env.SUPABASE_URL;
    const supabaseServiceKey = env.SUPABASE_SERVICE_ROLE_KEY;
    const supabaseAnonKey = env.SUPABASE_ANON_KEY || supabaseServiceKey;

    if (!supabaseUrl || !supabaseServiceKey) {
      throw new Error("Configuration Supabase manquante côté serveur.");
    }

    const supabaseAdmin = createClient(supabaseUrl, supabaseServiceKey, {
      auth: { autoRefreshToken: false, persistSession: false }
    });
    const supabaseAnon = createClient(supabaseUrl, supabaseAnonKey, {
      auth: { autoRefreshToken: false, persistSession: false }
    });

    const { data: { user }, error: authError } = await supabaseAnon.auth.getUser(token);
    if (authError || !user) {
      return jsonResponse({ error: 'Session invalide.' }, 401, getCorsHeaders(request));
    }

    const { data: profile } = await supabaseAdmin
      .from('clients').select('role').eq('auth_user_id', user.id).single();

    if (!profile || profile.role !== 'admin') {
      return jsonResponse({ error: 'Accès refusé. Rôle administrateur requis.' }, 403, getCorsHeaders(request));
    }

    const { targetTable, payload } = await parseBody(request);
    if (!['clients', 'convoyeurs'].includes(targetTable)) {
      return jsonResponse({ error: 'Table cible invalide.' }, 400, getCorsHeaders(request));
    }

    const email = payload.email;
    if (!email) {
      return jsonResponse({ error: 'Email obligatoire.' }, 400, getCorsHeaders(request));
    }

    const tempPassword = 'TempPass_' + randomHex(6).slice(0, 8) + '!1';
    const { data: createData, error: createError } = await supabaseAdmin.auth.admin.createUser({
      email: email, password: tempPassword, email_confirm: true
    });

    if (createError) {
      return jsonResponse({ error: 'Erreur création compte: ' + createError.message }, 400, getCorsHeaders(request));
    }

    const newUserId = createData.user.id;
    const insertPayload = { ...payload, auth_user_id: newUserId };
    if (targetTable === 'clients') insertPayload.role = 'client';

    const { error: insertError } = await supabaseAdmin.from(targetTable).insert([insertPayload]);

    if (insertError) {
      await supabaseAdmin.auth.admin.deleteUser(newUserId);
      return jsonResponse({ error: 'Erreur base de données: ' + insertError.message }, 500, getCorsHeaders(request));
    }

    const corsOrigin = getCorsHeaders(request)['Access-Control-Allow-Origin'];
    const redirectToUrl = `${corsOrigin}/reset-password.html`;
    try {
      const { data: resetData } = await supabaseAdmin.auth.admin.generateLink('recovery', email, { redirectTo: redirectToUrl });
      const resetUrl = resetData?.properties?.action_link || resetData?.properties?.redirect_to || redirectToUrl;
      const resendApiKey = env.RESEND_API_KEY;
      const FROM_EMAIL = env.EMAIL_FROM || 'onboarding@resend.dev';
      const prenom = payload.prenom || '';

      if (resendApiKey) {
        await fetch('https://api.resend.com/emails', {
          method: 'POST',
          headers: { 'Authorization': `Bearer ${resendApiKey}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            from: `Bathily Convoyage <${FROM_EMAIL}>`, to: [email],
            subject: 'Bienvenue sur Bathily Convoyage - Définissez votre mot de passe',
            html: `<div style="font-family:'Inter',Arial,sans-serif;max-width:600px;margin:0 auto;background:#FDFBF7;padding:40px;">
              <div style="text-align:center;margin-bottom:30px"><h1 style="color:#0A4D68;font-size:1.5rem;margin:0">Bathily-Convoyage</h1></div>
              <div style="background:white;border-radius:16px;padding:30px;box-shadow:0 4px 12px rgba(0,0,0,.05)">
              <h2 style="color:#0A4D68;margin-top:0">Bienvenue ${prenom} !</h2>
              <p style="color:#2D2A24;font-size:.95rem;line-height:1.6">Votre compte a été créé. Cliquez ci-dessous pour définir votre mot de passe :</p>
              <div style="text-align:center;margin:30px 0"><a href="${resetUrl}" style="background:#0A4D68;color:white;padding:14px 32px;border-radius:12px;text-decoration:none;font-weight:700;display:inline-block">Définir mon mot de passe</a></div>
              <p style="color:#6B625A;font-size:.8rem">Ce lien expirera dans 1 heure.</p></div></div>`
          })
        });
      }
    } catch (emailErr) {
      console.warn('Erreur envoi email reset:', emailErr.message);
    }

    return jsonResponse({ success: true, userId: newUserId, message: 'Utilisateur créé et invitation envoyée.' }, 200, getCorsHeaders(request));

  } catch (error) {
    console.error('Erreur admin-create-user:', error);
    return jsonResponse({ error: error.message || 'Erreur interne' }, 500, getCorsHeaders(request));
  }
}
