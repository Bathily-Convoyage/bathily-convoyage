import { createClient } from '@supabase/supabase-js';
import { getCorsHeaders, jsonResponse, handleOptions, checkRateLimit, parseBody } from '../_utils.js';

export async function onRequest(context) {
  const { request, env } = context;

  const optionsRes = handleOptions(request);
  if (optionsRes) return optionsRes;

  if (request.method !== 'POST') {
    return jsonResponse({ error: 'Méthode non autorisée.' }, 405, getCorsHeaders(request));
  }

  const rl = checkRateLimit(request, 'request-convoyeur-role', 3, 3600000);
  if (rl) return rl;

  try {
    const authHeader = request.headers.get('authorization') || '';
    if (!authHeader.startsWith('Bearer ')) {
      return jsonResponse({ error: 'Vous devez être connecté pour effectuer cette demande.' }, 401, getCorsHeaders(request));
    }
    const token = authHeader.split(' ')[1];

    if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) {
      throw new Error('Configuration Supabase manquante.');
    }

    const supabaseAnon = createClient(env.SUPABASE_URL, env.SUPABASE_ANON_KEY || env.SUPABASE_SERVICE_ROLE_KEY, {
      auth: { autoRefreshToken: false, persistSession: false }
    });
    const supabaseAdmin = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
      auth: { autoRefreshToken: false, persistSession: false }
    });

    // Vérifier l'identité du client
    const { data: { user }, error: authError } = await supabaseAnon.auth.getUser(token);
    if (authError || !user) {
      return jsonResponse({ error: 'Session invalide. Veuillez vous reconnecter.' }, 401, getCorsHeaders(request));
    }

    // Récupérer le profil client
    const { data: clientProfile } = await supabaseAdmin
      .from('clients')
      .select('prenom, nom, email, telephone, ville, code_postal')
      .eq('auth_user_id', user.id)
      .maybeSingle();

    if (!clientProfile) {
      return jsonResponse({ error: 'Profil client introuvable.' }, 404, getCorsHeaders(request));
    }

    // Vérifier s'il est déjà convoyeur
    const { data: existingConvoyeur } = await supabaseAdmin
      .from('convoyeurs')
      .select('id')
      .eq('email', clientProfile.email)
      .maybeSingle();

    if (existingConvoyeur) {
      return jsonResponse({ error: 'already_convoyeur', message: 'Vous êtes déjà enregistré comme convoyeur.' }, 409, getCorsHeaders(request));
    }

    // Vérifier s'il a déjà une candidature en cours
    const { data: existingCandidature } = await supabaseAdmin
      .from('convoyeur_candidatures')
      .select('id, statut')
      .eq('email', clientProfile.email)
      .eq('statut', 'pending')
      .maybeSingle();

    if (existingCandidature) {
      return jsonResponse({ error: 'already_pending', message: 'Votre demande est déjà en cours de traitement.' }, 409, getCorsHeaders(request));
    }

    // Données supplémentaires optionnelles du body
    const body = await parseBody(request);
    const zone = body.zone || clientProfile.ville || '';
    const typePermis = body.type_permis || null;
    const selfie = body.selfie || null;
    const videoPresentation = body.video_presentation || null;

    // Créer la candidature
    const { data: candidature, error: insertError } = await supabaseAdmin
      .from('convoyeur_candidatures')
      .insert([{
        email: clientProfile.email,
        prenom: clientProfile.prenom,
        nom: clientProfile.nom,
        telephone: clientProfile.telephone,
        ville: clientProfile.ville || '',
        zone: zone,
        type_permis: typePermis,
        statut: 'pending',
        selfie: selfie,
        video_presentation: videoPresentation,
        existing_auth_user_id: user.id
      }])
      .select('id')
      .single();

    if (insertError) {
      // Si la colonne existing_auth_user_id n'existe pas, réessayer sans
      if (insertError.message.includes('existing_auth_user_id')) {
        const { data: candidature2, error: insertError2 } = await supabaseAdmin
          .from('convoyeur_candidatures')
          .insert([{
            email: clientProfile.email,
            prenom: clientProfile.prenom,
            nom: clientProfile.nom,
            telephone: clientProfile.telephone,
            ville: clientProfile.ville || '',
            zone: zone,
            type_permis: typePermis,
            statut: 'pending',
            selfie: selfie,
            video_presentation: videoPresentation
          }])
          .select('id')
          .single();

        if (insertError2) {
          return jsonResponse({ error: 'Erreur lors de la création de la candidature: ' + insertError2.message }, 500, getCorsHeaders(request));
        }
        return await sendSuccessResponse(env, clientProfile, candidature2.id, getCorsHeaders(request));
      }
      return jsonResponse({ error: 'Erreur lors de la création de la candidature: ' + insertError.message }, 500, getCorsHeaders(request));
    }

    return await sendSuccessResponse(env, clientProfile, candidature.id, getCorsHeaders(request));

  } catch (error) {
    console.error('Erreur request-convoyeur-role:', error);
    return jsonResponse({ error: error.message || 'Erreur interne' }, 500, getCorsHeaders(request));
  }
}

async function sendSuccessResponse(env, clientProfile, candidatureId, headers) {
  // Envoyer un email à l'admin
  const resendApiKey = env.RESEND_API_KEY;
  const FROM_EMAIL = env.EMAIL_FROM || 'onboarding@resend.dev';
  const adminEmail = env.ADMIN_EMAIL || 'contact@bathily-convoyage.fr';

  if (resendApiKey) {
    try {
      await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${resendApiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          from: `Bathily Convoyage <${FROM_EMAIL}>`,
          to: [adminEmail],
          subject: 'Nouvelle demande de devenir convoyeur (client existant)',
          html: `<div style="font-family:'Inter',Arial,sans-serif;max-width:600px;margin:0 auto;background:#FDFBF7;padding:40px;">
            <div style="text-align:center;margin-bottom:30px"><h1 style="color:#0A4D68;font-size:1.5rem;margin:0">Bathily-Convoyage</h1></div>
            <div style="background:white;border-radius:16px;padding:30px;">
              <h2 style="color:#0A4D68;">Nouvelle demande de convoyeur</h2>
              <p style="color:#2D2A24;font-size:0.95rem;line-height:1.6;">
                <strong>${clientProfile.prenom} ${clientProfile.nom}</strong> (${clientProfile.email}) souhaite devenir convoyeur.<br>
                Il/elle est déjà client(e) sur la plateforme.
              </p>
              <p style="color:#6B625A;font-size:0.85rem;">Connectez-vous au dashboard admin pour valider cette candidature.</p>
            </div>
          </div>`
        })
      });
    } catch (e) {
      console.warn('Email admin non envoyé:', e.message);
    }
  }

  return jsonResponse({
    success: true,
    candidature_id: candidatureId,
    message: 'Votre demande a été enregistrée. Notre équipe vous contactera sous 24h.'
  }, 200, headers);
}
