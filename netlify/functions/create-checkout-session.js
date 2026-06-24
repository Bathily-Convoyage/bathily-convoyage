const Stripe = require('stripe');
const { createClient } = require('@supabase/supabase-js');

exports.handler = async (event, context) => {
  // Configurer les headers CORS
  const allowedOrigins = ['https://www.bathily-convoyage.fr', 'https://bathily-convoyage.fr', 'http://localhost:5173', 'http://localhost:3000'];
  const origin = event.headers.origin || event.headers.Origin || '';
  const corsOrigin = allowedOrigins.includes(origin) ? origin : allowedOrigins[0];
  const headers = {
    'Access-Control-Allow-Origin': corsOrigin,
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Content-Type': 'application/json'
  };

  // Gérer la requête OPTIONS (CORS preflight)
  if (event.httpMethod === 'OPTIONS') {
    return {
      statusCode: 200,
      headers,
      body: ''
    };
  }

  if (event.httpMethod !== 'POST') {
    return {
      statusCode: 405,
      headers,
      body: JSON.stringify({ error: 'Méthode non autorisée. Utilisez POST.' })
    };
  }

  try {
    // Vérification des variables d'environnement
    if (!process.env.STRIPE_SECRET_KEY) {
      throw new Error("La variable d'environnement STRIPE_SECRET_KEY est manquante.");
    }
    if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
      throw new Error("Les variables d'environnement Supabase sont manquantes.");
    }

    const stripe = Stripe(process.env.STRIPE_SECRET_KEY);
    const supabase = createClient(
      process.env.SUPABASE_URL,
      process.env.SUPABASE_SERVICE_ROLE_KEY
    );

    // Récupérer les données et le token
    const { missionId, successUrl, cancelUrl } = JSON.parse(event.body);
    const authHeader = event.headers.authorization || event.headers.Authorization || '';

    if (!authHeader.startsWith('Bearer ')) {
      return {
        statusCode: 401,
        headers,
        body: JSON.stringify({ error: 'Token d\'authentification requis.' })
      };
    }
    const token = authHeader.split(' ')[1];

    // Vérifier l'utilisateur authentifié
    const supabaseAnon = createClient(
      process.env.SUPABASE_URL,
      process.env.SUPABASE_ANON_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY
    );
    const { data: { user }, error: userError } = await supabaseAnon.auth.getUser(token);

    if (userError || !user) {
      return {
        statusCode: 401,
        headers,
        body: JSON.stringify({ error: 'Session invalide. Veuillez vous reconnecter.' })
      };
    }

    // Vérifier les paramètres requis
    if (!missionId || !successUrl || !cancelUrl) {
      return {
        statusCode: 400,
        headers,
        body: JSON.stringify({ error: 'Paramètres manquants : missionId, successUrl, cancelUrl requis.' })
      };
    }

    // 1. Récupérer la mission en base de données
    const { data: mission, error: selectError } = await supabase
      .from('missions')
      .select('*')
      .eq('id', missionId)
      .single();

    if (selectError || !mission) {
      return {
        statusCode: 404,
        headers,
        body: JSON.stringify({ error: 'Mission introuvable en base de données.' })
      };
    }

    // 2. Vérifier que l'utilisateur est le client de la mission OU un admin
    const { data: profile } = await supabaseAnon
      .from('clients')
      .select('role, id, email')
      .eq('auth_user_id', user.id)
      .maybeSingle();

    const isAdmin = profile?.role === 'admin';
    const isClient = mission.client_id === profile?.id || mission.client_email === user.email;

    if (!isClient && !isAdmin) {
      return {
        statusCode: 403,
        headers,
        body: JSON.stringify({ error: 'Vous n\'êtes pas autorisé à payer cette mission.' })
      };
    }

    // 3. Vérifier que la mission n'est pas déjà payée
    if (mission.paiement_statut === 'paid') {
      return {
        statusCode: 409,
        headers,
        body: JSON.stringify({ error: 'Cette mission est déjà payée.' })
      };
    }

    // 4. Vérifier que la mission est dans un état paiement possible
    const statut = mission.status || 'planned';
    if (statut === 'cancelled' || statut === 'completed') {
      return {
        statusCode: 400,
        headers,
        body: JSON.stringify({ error: 'Cette mission ne peut pas être payée (annulée ou terminée).' })
      };
    }

    const priceHt = parseFloat(mission.montant_ht);
    if (isNaN(priceHt) || priceHt <= 0) {
      return {
        statusCode: 400,
        headers,
        body: JSON.stringify({ error: 'Le montant de la mission est invalide ou égal à 0.' })
      };
    }

    // 5. Calculer le montant TTC en centimes (TVA 20% incluse)
    const amountTtcCents = Math.round(priceHt * 1.20 * 100);

    // 6. Forcer les URLs de succès et d'annulation depuis le serveur
    const baseUrl = process.env.URL || 'https://www.bathily-convoyage.fr';
    const successUrlFinal = `${baseUrl}/dashboard-client.html?payment_status=success&mission_id=${missionId}`;
    const cancelUrlFinal = `${baseUrl}/dashboard-client.html?payment_status=cancel&mission_id=${missionId}`;

    // 7. Créer la session de paiement Stripe Checkout
    const dep = (mission.depart || '').split('(')[0].trim();
    const arr = (mission.arrivee || '').split('(')[0].trim();
    const description = `Convoyage ${mission.vehicule || 'Véhicule'} : ${dep} ➔ ${arr} · Réf: ${mission.reference}`;
    
    const session = await stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      line_items: [
        {
          price_data: {
            currency: 'eur',
            product_data: {
              name: `Bathily Convoyage - Réf: ${mission.reference}`,
              description: description,
            },
            unit_amount: amountTtcCents,
          },
          quantity: 1,
        },
      ],
      mode: 'payment',
      success_url: successUrlFinal,
      cancel_url: cancelUrlFinal,
      metadata: {
        mission_id: missionId,
        reference: mission.reference,
        client_id: user.id
      }
    });

    // 8. Mettre à jour la mission avec l'ID de la session Stripe
    const { error: updateError } = await supabase
      .from('missions')
      .update({ stripe_session_id: session.id })
      .eq('id', missionId);

    if (updateError) {
      console.error("Erreur lors de l'enregistrement de la session Stripe :", updateError.message);
    }

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({ url: session.url })
    };

  } catch (error) {
    console.error("Erreur dans create-checkout-session :", error);
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: error.message || 'Erreur interne du serveur.' })
    };
  }
};