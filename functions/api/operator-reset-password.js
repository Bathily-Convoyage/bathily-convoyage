import { createClient } from '@supabase/supabase-js';
import { getCorsHeaders, jsonResponse, handleOptions, checkRateLimit, parseBody, escapeHtml } from '../_utils.js';

const GENERIC_SUCCESS = 'Si cette adresse correspond à un opérateur actif, un e-mail de réinitialisation a été envoyé.';

export async function onRequest(context) {
  const { request, env } = context;
  const optionsResponse = handleOptions(request);
  if (optionsResponse) return optionsResponse;

  if (request.method !== 'POST') {
    return jsonResponse({ error: 'Method Not Allowed' }, 405, getCorsHeaders(request));
  }

  const rateLimitResponse = checkRateLimit(request, 'operator-reset-password', 5, 3600000);
  if (rateLimitResponse) return rateLimitResponse;

  try {
    const { email } = await parseBody(request);
    if (!email || typeof email !== 'string') {
      return jsonResponse({ error: 'Email requis.' }, 400, getCorsHeaders(request));
    }

    if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) {
      throw new Error('Configuration Supabase manquante.');
    }

    const cleanEmail = email.trim().toLowerCase();
    const supabase = context.supabase || createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
      auth: { autoRefreshToken: false, persistSession: false }
    });
    const fetchFn = context.fetch || fetch;

    const { data: usersData, error: usersError } = await supabase.auth.admin.listUsers();
    if (usersError) throw usersError;
    const authUser = usersData?.users?.find(user => user.email?.toLowerCase() === cleanEmail);

    // Always return the same response when the account is unknown or ineligible.
    if (!authUser) {
      return jsonResponse({ success: true, message: GENERIC_SUCCESS }, 200, getCorsHeaders(request));
    }

    const [roleResult, operatorResult] = await Promise.all([
      supabase.from('user_roles').select('role').eq('user_id', authUser.id).eq('role', 'operator').maybeSingle(),
      supabase.from('internal_operators').select('active, display_name').eq('user_id', authUser.id).maybeSingle()
    ]);
    if (roleResult.error) throw roleResult.error;
    if (operatorResult.error) throw operatorResult.error;

    const role = roleResult.data;
    const operator = operatorResult.data;

    if (!role || operator?.active !== true) {
      return jsonResponse({ success: true, message: GENERIC_SUCCESS }, 200, getCorsHeaders(request));
    }

    const origin = getCorsHeaders(request)['Access-Control-Allow-Origin'];
    const redirectTo = `${origin}/reset-password.html`;
    const resendApiKey = env.RESEND_API_KEY;

    if (!resendApiKey) {
      const { error } = await supabase.auth.resetPasswordForEmail(cleanEmail, { redirectTo });
      if (error) throw error;
      return jsonResponse({ success: true, message: GENERIC_SUCCESS }, 200, getCorsHeaders(request));
    }

    const { data: resetData, error: resetError } = await supabase.auth.admin.generateLink('recovery', cleanEmail, { redirectTo });
    if (resetError) throw resetError;
    const resetUrl = resetData?.properties?.action_link;
    if (!resetUrl) throw new Error('Lien de récupération indisponible.');

    const fromEmail = env.EMAIL_FROM || 'onboarding@resend.dev';
    const response = await fetchFn('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${resendApiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: `Bathily Convoyage <${fromEmail}>`,
        to: [cleanEmail],
        subject: 'Réinitialisation de votre accès Opérateur - Bathily Convoyage',
        html: `<div style="font-family:Arial,sans-serif;max-width:600px;margin:auto;padding:32px"><h1 style="color:#0A4D68">Bathily-Convoyage</h1><p>Bonjour ${escapeHtml(operator.display_name || 'Opérateur')},</p><p>Utilisez le bouton ci-dessous pour définir un nouveau mot de passe.</p><p style="margin:28px 0"><a href="${resetUrl}" style="background:#0A4D68;color:#fff;padding:12px 24px;border-radius:8px;text-decoration:none">Définir mon mot de passe</a></p><p>Ce lien est temporaire. Ignorez cet e-mail si vous n’êtes pas à l’origine de la demande.</p></div>`
      })
    });

    if (!response.ok) throw new Error('Échec de l’envoi de l’e-mail.');
    return jsonResponse({ success: true, message: GENERIC_SUCCESS }, 200, getCorsHeaders(request));
  } catch (error) {
    console.error('Erreur operator-reset-password:', error);
    return jsonResponse({ error: 'Service momentanément indisponible.' }, 500, getCorsHeaders(request));
  }
}
