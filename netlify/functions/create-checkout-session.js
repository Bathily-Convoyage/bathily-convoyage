const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const { createClient } = require('@supabase/supabase-js');

// Initialiser Supabase avec la clé Service Role pour pouvoir modifier les données
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

exports.handler = async (event, context) => {
  // Configurer les headers CORS pour autoriser l'accès depuis le frontend
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
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
    const { missionId, successUrl, cancelUrl } = JSON.parse(event.body);

    if (!missionId || !successUrl || !cancelUrl) {
      return {
        statusCode: 400,
        headers,
        body: JSON.stringify({ error: 'Paramètres manquants : missionId, successUrl, cancelUrl requis.' })
      };
    }

    // 1. Récupérer la mission en base de données de manière sécurisée
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

    const priceHt = parseFloat(mission.montant_ht);
    if (isNaN(priceHt) || priceHt <= 0) {
      return {
        statusCode: 400,
        headers,
        body: JSON.stringify({ error: 'Le montant de la mission est invalide ou égal à 0.' })
      };
    }

    // 2. Calculer le montant TTC en centimes (TVA 20% incluse)
    // Stripe requiert les montants en centimes (ex: 10,00 € = 1000)
    const amountTtcCents = Math.round(priceHt * 1.20 * 100);

    // 3. Créer la session de paiement Stripe Checkout
    const description = `Convoyage ${mission.vehicule || 'Véhicule'} : ${mission.depart.split('(')[0].trim()} ➔ ${mission.arrivee.split('(')[0].trim()} · Réf: ${mission.reference}`;
    
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
      success_url: `${successUrl}?payment_status=success&mission_id=${missionId}&session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${cancelUrl}?payment_status=cancel&mission_id=${missionId}`,
      metadata: {
        mission_id: missionId,
        reference: mission.reference
      }
    });

    // 4. Mettre à jour la mission avec l'ID de la session Stripe
    const { error: updateError } = await supabase
      .from('missions')
      .update({ stripe_session_id: session.id })
      .eq('id', missionId);

    if (updateError) {
      console.error("Erreur lors de l'enregistrement de la session Stripe :", updateError.message);
      // On continue quand même car la session Stripe est créée
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
