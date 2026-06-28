const { createClient } = require('@supabase/supabase-js');
const crypto = require('crypto');
const { rateLimit } = require('./_rate-limit');

const allowedOrigins = ['https://www.bathily-convoyage.fr', 'https://bathily-convoyage.fr', 'http://localhost:5173', 'http://localhost:3000'];

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

  // Rate limiting: 10 / minute / IP
  const rl = rateLimit(event, 'approve-convoyeur', 10, 60000);
  if (rl) return rl;

  try {
    // ===== VÉRIFICATION ADMIN =====
    const authHeader = event.headers.authorization || event.headers.Authorization || '';
    if (!authHeader.startsWith('Bearer ')) {
      return { statusCode: 401, headers, body: JSON.stringify({ error: 'Token manquant' }) };
    }
    const token = authHeader.split(' ')[1];

    // Client standard pour vérifier le token
    const sbAdmin = createClient(
      process.env.SUPABASE_URL,
      process.env.SUPABASE_ANON_KEY // Utiliser la clé anonyme, ou service_role selon besoin
    );
    const { data: { user }, error: userError } = await sbAdmin.auth.getUser(token);

    if (userError || !user) {
      return { statusCode: 401, headers, body: JSON.stringify({ error: 'Token invalide' }) };
    }

    // Vérifier que l'utilisateur a le rôle admin dans la table clients
    const { data: profile, error: profileError } = await sbAdmin
      .from('clients')
      .select('role')
      .eq('auth_user_id', user.id)
      .maybeSingle();

    if (profileError || !profile || profile.role !== 'admin') {
      return { statusCode: 403, headers, body: JSON.stringify({ error: 'Accès réservé aux administrateurs' }) };
    }

    // ===== TRAITEMENT DE LA CANDIDATURE =====
    const { candidat_id } = JSON.parse(event.body || '{}');
    if (!candidat_id) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: 'candidat_id requis' }) };
    }

    // Client service_role pour opérations d'écriture (bypass RLS)
    const sb = createClient(
      process.env.SUPABASE_URL,
      process.env.SUPABASE_SERVICE_ROLE_KEY
    );

    // 1. Récupérer le candidat (uniquement si statut 'pending')
    const { data: candidat, error: candError } = await sb
      .from('convoyeur_candidatures')
      .select('id, email, prenom, nom, telephone, ville, zone, type_permis, statut')
      .eq('id', candidat_id)
      .eq('statut', 'pending')
      .single();

    if (candError || !candidat) {
      return { statusCode: 404, headers, body: JSON.stringify({ error: 'Candidature introuvable ou déjà traitée' }) };
    }

    // 2. Générer un mot de passe temporaire sécurisé
    const tempPassword = crypto.randomBytes(8).toString('hex').slice(0, 10) + crypto.randomBytes(3).toString('hex').slice(0, 4).toUpperCase() + '!';

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
      zone: candidat.zone || candidat.ville,
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
    await sb.from('convoyeur_candidatures').update({ statut: 'approved' }).eq('id', candidat_id);

    // 6. Envoyer l'email avec les accès
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
        message: `Compte créé pour ${candidat.prenom} ${candidat.nom}`
      })
    };

  } catch (err) {
    console.error('approve-convoyeur error:', err);
    return { statusCode: 500, headers, body: JSON.stringify({ error: err.message }) };
  }
};