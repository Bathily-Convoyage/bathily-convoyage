import { createClient } from '@supabase/supabase-js';
import { getCorsHeaders, jsonResponse, handleOptions, checkRateLimit, parseBody, randomHex } from '../_utils.js';

export async function onRequest(context) {
  const { request, env } = context;

  const optionsRes = handleOptions(request);
  if (optionsRes) return optionsRes;

  if (request.method !== 'POST') {
    return jsonResponse({ error: 'Method not allowed' }, 405, getCorsHeaders(request));
  }

  const rl = checkRateLimit(request, 'approve-convoyeur', 10, 60000);
  if (rl) return rl;

  try {
    const authHeader = request.headers.get('authorization') || '';
    if (!authHeader.startsWith('Bearer ')) {
      return jsonResponse({ error: 'Token manquant' }, 401, getCorsHeaders(request));
    }
    const token = authHeader.split(' ')[1];

    const sbAdmin = createClient(env.SUPABASE_URL, env.SUPABASE_ANON_KEY || env.SUPABASE_SERVICE_ROLE_KEY);
    const { data: { user }, error: userError } = await sbAdmin.auth.getUser(token);
    if (userError || !user) {
      return jsonResponse({ error: 'Token invalide' }, 401, getCorsHeaders(request));
    }

    const { data: profile } = await sbAdmin.from('clients').select('role').eq('auth_user_id', user.id).maybeSingle();
    if (!profile || profile.role !== 'admin') {
      return jsonResponse({ error: 'Accès réservé aux administrateurs' }, 403, getCorsHeaders(request));
    }

    const { candidat_id } = await parseBody(request);
    if (!candidat_id) {
      return jsonResponse({ error: 'candidat_id requis' }, 400, getCorsHeaders(request));
    }

    const sb = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY);

    const { data: candidat, error: candError } = await sb.from('convoyeur_candidatures')
      .select('id, email, prenom, nom, telephone, ville, zone, type_permis, statut, selfie, video_presentation, existing_auth_user_id')
      .eq('id', candidat_id).eq('statut', 'pending').single();

    if (candError || !candidat) {
      // Retry without existing_auth_user_id if column doesn't exist
      const { data: candidatFallback, error: candError2 } = await sb.from('convoyeur_candidatures')
        .select('id, email, prenom, nom, telephone, ville, zone, type_permis, statut, selfie, video_presentation')
        .eq('id', candidat_id).eq('statut', 'pending').single();

      if (candError2 || !candidatFallback) {
        return jsonResponse({ error: 'Candidature introuvable ou déjà traitée' }, 404, getCorsHeaders(request));
      }
      Object.assign(candidat, candidatFallback);
    }

    // Vérifier si un utilisateur Auth existe déjà (cas d'un client existant)
    let authUserId = null;
    let tempPassword = null;

    if (candidat.existing_auth_user_id) {
      // Client existant - utiliser son compte Auth déjà créé
      authUserId = candidat.existing_auth_user_id;
    } else {
      // Nouveau convoyeur - créer un compte Auth
      const { data: existingUsers } = await sb.auth.admin.listUsers();
      const existingUser = existingUsers?.users?.find(u => u.email === candidat.email);

      if (existingUser) {
        authUserId = existingUser.id;
      } else {
        tempPassword = randomHex(8).slice(0, 10) + randomHex(3).slice(0, 4).toUpperCase() + '!';
        const { data: authData, error: authError } = await sb.auth.admin.createUser({
          email: candidat.email, password: tempPassword, email_confirm: true,
          user_metadata: { prenom: candidat.prenom, nom: candidat.nom, role: 'convoyeur' }
        });

        if (authError) {
          return jsonResponse({ error: 'Erreur création compte Auth: ' + authError.message }, 500, getCorsHeaders(request));
        }
        authUserId = authData.user.id;
      }
    }

    const { error: insertError } = await sb.from('convoyeurs').insert([{
      auth_user_id: authUserId, prenom: candidat.prenom, nom: candidat.nom, email: candidat.email,
      telephone: candidat.telephone, ville: candidat.ville, zone: candidat.zone || candidat.ville,
      niveau: 'Standard', disponible: true, type_permis: candidat.type_permis || null,
      selfie: candidat.selfie, video_presentation: candidat.video_presentation
    }]);

    if (insertError) {
      if (!candidat.existing_auth_user_id && tempPassword) {
        await sb.auth.admin.deleteUser(authUserId);
      }
      return jsonResponse({ error: 'Erreur création profil: ' + insertError.message }, 500, getCorsHeaders(request));
    }

    await sb.from('convoyeur_candidatures').update({ statut: 'approved' }).eq('id', candidat_id);

    try {
      const baseUrl = env.URL || 'https://www.bathily-convoyage.fr';
      const emailPayload = { trigger: 'convoyeur_approved', email: candidat.email, prenom: candidat.prenom };
      if (tempPassword) {
        emailPayload.temp_password = tempPassword;
      }
      await fetch(`${baseUrl}/api/send-email`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-internal-secret': env.INTERNAL_SECRET || '' },
        body: JSON.stringify(emailPayload)
      });
    } catch (emailErr) {
      console.warn('Email non envoyé:', emailErr.message);
    }

    const msg = tempPassword
      ? `Compte créé pour ${candidat.prenom} ${candidat.nom}`
      : `Accès convoyeur activé pour ${candidat.prenom} ${candidat.nom} (compte existant)`;
    return jsonResponse({ success: true, message: msg }, 200, getCorsHeaders(request));

  } catch (err) {
    console.error('approve-convoyeur error:', err);
    return jsonResponse({ error: err.message }, 500, getCorsHeaders(request));
  }
}
