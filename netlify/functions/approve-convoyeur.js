const { createClient } = require('@supabase/supabase-js');

const allowedOrigins = ['https://www.bathily-convoyage.fr', 'https://bathily-convoyage.fr'];

exports.handler = async (event) => {
  const origin = event.headers.origin || event.headers.Origin || '';
  const corsOrigin = allowedOrigins.includes(origin) ? origin : allowedOrigins[0];
  const headers = {
    'Access-Control-Allow-Origin': corsOrigin,
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Content-Type': 'application/json'
  };

  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers, body: '' };
  if (event.httpMethod !== 'POST') return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method not allowed' }) };

  try {
    const { candidat_id } = JSON.parse(event.body || '{}');
    if (!candidat_id) return { statusCode: 400, headers, body: JSON.stringify({ error: 'candidat_id requis' }) };

    // Client admin (service_role) — bypass RLS total
    const sb = createClient(
      process.env.SUPABASE_URL,
      process.env.SUPABASE_SERVICE_ROLE_KEY
    );

    // 1. Récupérer le candidat
    const { data: candidat, error: candError } = await sb
      .from('convoyeurs_candidats')
      .select('*')
      .eq('id', candidat_id)
      .single();

    if (candError || !candidat) {
      return { statusCode: 404, headers, body: JSON.stringify({ error: 'Candidat introuvable' }) };
    }

    if (candidat.statut === 'approved') {
      return { statusCode: 409, headers, body: JSON.stringify({ error: 'Candidat déjà approuvé' }) };
    }

    // 2. Générer un mot de passe temporaire sécurisé
    const tempPassword = Math.random().toString(36).slice(2, 10) + Math.random().toString(36).slice(2, 6).toUpperCase() + '!';

    // 3. Créer le compte Supabase Auth
    const { data: authData, error: authError } = await sb.auth.admin.createUser({
      email: candidat.email,
      password: tempPassword,
      email_confirm: true,
      user_metadata: {
        prenom: candidat.prenom,
        nom: candidat.nom,
        role: 'convoyeur'
      }
    });

    if (authError) {
      return { statusCode: 500, headers, body: JSON.stringify({ error: 'Erreur création compte Auth: ' + authError.message }) };
    }

    const authUserId = authData.user.id;

    // 4. Insérer le profil dans public.convoyeurs
    const { error: insertError } = await sb.from('convoyeurs').insert([{
      auth_user_id: authUserId,
      prenom: candidat.prenom,
      nom: candidat.nom,
      email: candidat.email,
      telephone: candidat.telephone,
      ville: candidat.ville,
      zone: candidat.ville,
      niveau: 'Standard',
      disponible: true,
      type_permis: candidat.type_permis || null
    }]);

    if (insertError) {
      // Rollback : supprimer le compte auth créé
      await sb.auth.admin.deleteUser(authUserId);
      return { statusCode: 500, headers, body: JSON.stringify({ error: 'Erreur création profil: ' + insertError.message }) };
    }

    // 5. Mettre à jour le statut de la candidature
    await sb.from('convoyeurs_candidats').update({ statut: 'approved' }).eq('id', candidat_id);

    // 6. Envoyer l'email avec les accès (via send-email)
    try {
      const baseUrl = process.env.URL || 'https://www.bathily-convoyage.fr';
      await fetch(`${baseUrl}/.netlify/functions/send-email`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          trigger: 'convoyeur_approved',
          email: candidat.email,
          prenom: candidat.prenom,
          temp_password: tempPassword
        })
      });
    } catch (emailErr) {
      console.warn('Email non envoyé:', emailErr.message);
    }

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        success: true,
        message: `Compte créé pour ${candidat.prenom} ${candidat.nom}`,
        temp_password: tempPassword
      })
    };

  } catch (err) {
    console.error('approve-convoyeur error:', err);
    return { statusCode: 500, headers, body: JSON.stringify({ error: err.message }) };
  }
};
