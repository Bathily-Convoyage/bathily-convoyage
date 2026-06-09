const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const { createClient } = require('@supabase/supabase-js');

// Initialiser Supabase avec la clé Service Role pour contourner les RLS
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

exports.handler = async (event, context) => {
  // Seuls les appels POST sont autorisés pour les webhooks
  if (event.httpMethod !== 'POST') {
    return {
      statusCode: 405,
      body: 'Méthode non autorisée. Utilisez POST.'
    };
  }

  const sigHeader = event.headers['stripe-signature'] || event.headers['Stripe-Signature'];
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;

  if (!sigHeader || !webhookSecret) {
    console.error("Signature Stripe ou secret de webhook manquant.");
    return {
      statusCode: 400,
      body: 'En-tête stripe-signature ou configuration secrète manquante.'
    };
  }

  let stripeEvent;

  try {
    // Reconstruire l'événement Stripe pour valider la signature cryptographique
    stripeEvent = stripe.webhooks.constructEvent(
      event.body,
      sigHeader,
      webhookSecret
    );
  } catch (err) {
    console.error(`❌ Échec de la vérification de la signature du webhook: ${err.message}`);
    return {
      statusCode: 400,
      body: `Erreur de signature: ${err.message}`
    };
  }

  // Gérer l'événement checkout.session.completed
  if (stripeEvent.type === 'checkout.session.completed') {
    const session = stripeEvent.data.object;

    // Récupérer l'ID de la mission dans les métadonnées de la session de paiement
    const missionId = session.metadata.mission_id;
    const reference = session.metadata.reference;

    if (!missionId) {
      console.error("⚠️ Webhook reçu mais pas de missionId dans les métadonnées de la session.");
      return {
        statusCode: 200, // On renvoie 200 à Stripe car la signature est bonne
        body: 'ID de mission manquant.'
      };
    }

    console.log(`💰 Paiement validé pour la mission ${reference} (ID: ${missionId}). Mise à jour en base...`);

    // Mettre à jour le statut du paiement dans Supabase en 'paid'
    const { error: updateError } = await supabase
      .from('missions')
      .update({ paiement_statut: 'paid' })
      .eq('id', missionId);

    if (updateError) {
      console.error(`❌ Erreur lors de la mise à jour de la mission en base: ${updateError.message}`);
      return {
        statusCode: 500,
        body: `Erreur BDD: ${updateError.message}`
      };
    }

    console.log(`✅ Mission ${reference} marquée comme payée (status: paid).`);
  }

  // Renvoyer un statut de succès à Stripe pour acquitter la réception du webhook
  return {
    statusCode: 200,
    body: JSON.stringify({ received: true })
  };
};
