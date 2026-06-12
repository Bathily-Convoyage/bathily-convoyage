const Stripe = require('stripe');
const { createClient } = require('@supabase/supabase-js');

exports.handler = async (event, context) => {
  // Seuls les appels POST sont autorisés pour les webhooks
  if (event.httpMethod !== 'POST') {
    return {
      statusCode: 405,
      body: 'Méthode non autorisée. Utilisez POST.'
    };
  }

  try {
    // Vérification des variables d'environnement
    if (!process.env.STRIPE_SECRET_KEY) {
      throw new Error("La variable d'environnement STRIPE_SECRET_KEY est manquante.");
    }
    if (!process.env.SUPABASE_URL) {
      throw new Error("La variable d'environnement SUPABASE_URL est manquante.");
    }
    if (!process.env.SUPABASE_SERVICE_ROLE_KEY) {
      throw new Error("La variable d'environnement SUPABASE_SERVICE_ROLE_KEY est manquante.");
    }

    const stripe = Stripe(process.env.STRIPE_SECRET_KEY);
    const supabase = createClient(
      process.env.SUPABASE_URL,
      process.env.SUPABASE_SERVICE_ROLE_KEY
    );

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

    // Déclencher l'e-mail automatique de succès de paiement
    try {
      const siteUrl = process.env.URL || 'https://bathily-convoyage.fr';
      console.log(`📨 Déclenchement de la notification d'e-mail de paiement à : ${siteUrl}/.netlify/functions/send-email`);
      const emailResponse = await fetch(`${siteUrl}/.netlify/functions/send-email`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          trigger: 'payment_success',
          id: missionId
        })
      });
      if (emailResponse.ok) {
        console.log(`✉️ E-mail de confirmation de paiement déclenché avec succès.`);
      } else {
        const text = await emailResponse.text();
        console.warn(`⚠️ Échec du déclenchement d'e-mail (Statut ${emailResponse.status}) : ${text}`);
      }
    } catch (emailErr) {
      console.error("❌ Erreur de déclenchement d'e-mail :", emailErr.message);
    }
  }

  // Renvoyer un statut de succès à Stripe pour acquitter la réception du webhook
  return {
    statusCode: 200,
    body: JSON.stringify({ received: true })
  };
  } catch (error) {
    console.error("Erreur dans stripe-webhook :", error);
    return {
      statusCode: 500,
      body: `Erreur interne: ${error.message}`
    };
  }
};
