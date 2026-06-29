import { createClient } from '@supabase/supabase-js';
import crypto from 'crypto';
import { getCorsHeaders, jsonResponse, handleOptions, checkRateLimit, parseBody } from '../_utils.js';

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
      .select('id, email, prenom, nom, telephone, ville, zone, type_permis, statut')
      .eq('id', candidat_id).eq('statut', 'pending').single();

    if (candError || !candidat) {
      return jsonResponse({ error: 'Candidature introuvable ou déjà traitée' }, 404, getCorsHeaders(request));
    }

    const tempPassword = crypto.randomBytes(8).toString('hex').slice(0, 10) + crypto.randomBytes(3).toString('hex').slice(0, 4).toUpperCase() + '!';

    const { data: authData, error: authError } = await sb.auth.admin.createUser({
      email: candidat.email, password: tempPassword, email_confirm: true,
      user_metadata: { prenom: candidat.prenom, nom: candidat.nom, role: 'convoyeur' }
    });

    if (authError) {
      return jsonResponse({ error: 'Erreur création compte Auth: ' + authError.message }, 500, getCorsHeaders(request));
    }

    const authUserId = authData.user.id;

    const { error: insertError } = await sb.from('convoyeurs').insert([{
      auth_user_id: authUserId, prenom: candidat.prenom, nom: candidat.nom, email: candidat.email,
      telephone: candidat.telephone, ville: candidat.ville, zone: candidat.zone || candidat.ville,
      niveau: 'Standard', disponible: true, type_permis: candidat.type_permis || null
    }]);

    if (insertError) {
      await sb.auth.admin.deleteUser(authUserId);
      return jsonResponse({ error: 'Erreur création profil: ' + insertError.message }, 500, getCorsHeaders(request));
    }

    await sb.from('convoyeur_candidatures').update({ statut: 'approved' }).eq('id', candidat_id);

    try {
      const baseUrl = env.URL || 'https://www.bathily-convoyage.fr';
      await fetch(`${baseUrl}/api/send-email`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ trigger: 'convoyeur_approved', email: candidat.email, prenom: candidat.prenom, temp_password: tempPassword })
      });
    } catch (emailErr) {
      console.warn('Email non envoyé:', emailErr.message);
    }

    return jsonResponse({ success: true, message: `Compte créé pour ${candidat.prenom} ${candidat.nom}` }, 200, getCorsHeaders(request));

  } catch (err) {
    console.error('approve-convoyeur error:', err);
    return jsonResponse({ error: err.message }, 500, getCorsHeaders(request));
  }
}
