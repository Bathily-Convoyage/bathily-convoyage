const { createClient } = require('@supabase/supabase-js');

exports.handler = async (event, context) => {
  const allowedOrigins = ['https://www.bathily-convoyage.fr', 'https://bathily-convoyage.fr', 'http://localhost:5173', 'http://localhost:3000'];
  const origin = event.headers.origin || event.headers.Origin || '';
  const corsOrigin = allowedOrigins.includes(origin) ? origin : allowedOrigins[0];
  
  const headers = {
    'Access-Control-Allow-Origin': corsOrigin,
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
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
    const authHeader = event.headers.authorization || event.headers.Authorization || '';
    if (!authHeader.startsWith('Bearer ')) {
      return { statusCode: 401, headers, body: JSON.stringify({ error: 'Token requis.' }) };
    }
    const token = authHeader.split(' ')[1];

    const supabaseUrl = process.env.SUPABASE_URL;
    const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
    const supabaseAnonKey = process.env.SUPABASE_ANON_KEY || supabaseServiceKey;

    if (!supabaseUrl || !supabaseServiceKey) {
      throw new Error("Configuration Supabase manquante côté serveur.");
    }

    const supabaseAdmin = createClient(supabaseUrl, supabaseServiceKey, {
      auth: { autoRefreshToken: false, persistSession: false }
    });
    
    const supabaseAnon = createClient(supabaseUrl, supabaseAnonKey, {
      auth: { autoRefreshToken: false, persistSession: false }
    });

    // 1. Vérifier l'utilisateur courant (l'Admin)
    const { data: { user }, error: authError } = await supabaseAnon.auth.getUser(token);
    if (authError || !user) {
      return { statusCode: 401, headers, body: JSON.stringify({ error: 'Session invalide.' }) };
    }

    // 2. Vérifier que c'est bien un Admin
    const { data: profile } = await supabaseAdmin
      .from('clients')
      .select('role')
      .eq('auth_user_id', user.id)
      .single();

    if (!profile || profile.role !== 'admin') {
      return { statusCode: 403, headers, body: JSON.stringify({ error: 'Accès refusé. Rôle administrateur requis.' }) };
    }

    // 3. Lire le payload
    const { targetTable, payload } = JSON.parse(event.body);
    if (!['clients', 'convoyeurs'].includes(targetTable)) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: 'Table cible invalide.' }) };
    }

    const email = payload.email;
    if (!email) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: 'Email obligatoire.' }) };
    }

    // 4. Inviter l'utilisateur (crée le compte + envoie l'email)
    const redirectToUrl = `${corsOrigin}/reset-password.html`;
    const { data: inviteData, error: inviteError } = await supabaseAdmin.auth.admin.inviteUserByEmail(email, {
      redirectTo: redirectToUrl
    });
    
    if (inviteError) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: 'Erreur création compte: ' + inviteError.message }) };
    }

    const newUserId = inviteData.user.id;

    // 5. Insérer dans la table correspondante
    const insertPayload = {
      ...payload,
      auth_user_id: newUserId
    };

    if (targetTable === 'clients') {
      insertPayload.role = 'client';
    }

    const { error: insertError } = await supabaseAdmin
      .from(targetTable)
      .insert([insertPayload]);

    if (insertError) {
      // Nettoyage en cas d'erreur
      await supabaseAdmin.auth.admin.deleteUser(newUserId);
      return { statusCode: 500, headers, body: JSON.stringify({ error: 'Erreur base de données: ' + insertError.message }) };
    }

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({ success: true, message: 'Utilisateur créé et invitation envoyée.' })
    };

  } catch (error) {
    console.error('Erreur API admin-create-user:', error);
    return { statusCode: 500, headers, body: JSON.stringify({ error: error.message || 'Erreur interne' }) };
  }
};
