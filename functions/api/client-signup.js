import { createClient } from '@supabase/supabase-js';
import { getCorsHeaders, jsonResponse, handleOptions, checkRateLimit, parseBody } from '../_utils.js';

export async function onRequest(context) {
  const { request, env } = context;

  const optionsRes = handleOptions(request);
  if (optionsRes) return optionsRes;

  if (request.method !== 'POST') {
    return jsonResponse({ error: 'Méthode non autorisée. Utilisez POST.' }, 405, getCorsHeaders(request));
  }

  const rl = checkRateLimit(request, 'client-signup', 5, 3600000);
  if (rl) return rl;

  try {
    const { email, password, prenom, nom, telephone, societe, isPro } = await parseBody(request);
    if (!email || !password) {
      return jsonResponse({ error: 'Email et mot de passe requis.' }, 400, getCorsHeaders(request));
    }

    if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) {
      throw new Error('Configuration Supabase manquante.');
    }

    const supabase = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
      auth: { autoRefreshToken: false, persistSession: false }
    });

    const { data: createData, error: createError } = await supabase.auth.admin.createUser({
      email: email.trim().toLowerCase(),
      password: password,
      email_confirm: true,
      user_metadata: { prenom, nom, source: isPro ? 'pro_signup' : 'client_signup' }
    });

    if (createError) {
      if (createError.message.includes('already') || createError.message.includes('registered')) {
        return jsonResponse({ error: 'already_registered' }, 409, getCorsHeaders(request));
      }
      return jsonResponse({ error: createError.message }, 400, getCorsHeaders(request));
    }

    const newUserId = createData.user.id;

    const insertPayload = {
      prenom, nom,
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
      return jsonResponse({ error: insertError.message }, 500, getCorsHeaders(request));
    }

    if (isPro) {
      const resendApiKey = env.RESEND_API_KEY;
      const FROM_EMAIL = env.EMAIL_FROM || 'onboarding@resend.dev';
      if (resendApiKey) {
        try {
          await fetch('https://api.resend.com/emails', {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${resendApiKey}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({
              from: `Bathily Convoyage <${FROM_EMAIL}>`,
              to: [email.trim().toLowerCase()],
              subject: 'Demande de compte Pro reçue - Bathily Convoyage',
              html: `<div style="font-family: 'Inter', Arial, sans-serif; max-width: 600px; margin: 0 auto; background: #FDFBF7; padding: 40px;">
                <div style="text-align: center; margin-bottom: 30px;">
                  <h1 style="color: #0A4D68; font-size: 1.5rem; margin: 0;">Bathily-Convoyage</h1>
                </div>
                <div style="background: white; border-radius: 16px; padding: 30px;">
                  <h2 style="color: #0A4D68;">Bonjour ${prenom},</h2>
                  <p style="color: #2D2A24; font-size: 0.95rem; line-height: 1.6;">
                    Votre demande de compte Pro a bien été enregistrée.<br>
                    Notre équipe valide votre accès sous 24h ouvrées.
                  </p>
                  <p style="color: #6B625A; font-size: 0.85rem;">Vous recevrez un email de confirmation une fois votre compte validé.</p>
                </div>
              </div>`
            })
          });
        } catch (e) { console.warn('Email pro non envoyé:', e.message); }
      }
    }

    return jsonResponse({ success: true, userId: newUserId, isPro: !!isPro }, 200, getCorsHeaders(request));

  } catch (error) {
    console.error('Erreur client-signup:', error);
    return jsonResponse({ error: error.message || 'Erreur interne' }, 500, getCorsHeaders(request));
  }
}
