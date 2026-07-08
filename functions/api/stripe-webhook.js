import Stripe from 'stripe';
import { createClient } from '@supabase/supabase-js';
import { randomHex } from '../_utils.js';

export async function onRequest(context) {
  const { request, env } = context;

  if (request.method !== 'POST') {
    return new Response('Méthode non autorisée. Utilisez POST.', { status: 405 });
  }

  try {
    if (!env.STRIPE_SECRET_KEY) throw new Error("STRIPE_SECRET_KEY manquante.");
    if (!env.SUPABASE_URL) throw new Error("SUPABASE_URL manquante.");
    if (!env.SUPABASE_SERVICE_ROLE_KEY) throw new Error("SUPABASE_SERVICE_ROLE_KEY manquante.");

    const stripe = Stripe(env.STRIPE_SECRET_KEY);
    const supabase = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY);

    const sigHeader = request.headers.get('stripe-signature') || '';
    const webhookSecret = env.STRIPE_WEBHOOK_SECRET;

    if (!sigHeader || !webhookSecret) {
      return new Response('En-tête stripe-signature ou configuration secrète manquante.', { status: 400 });
    }

    const rawBody = await request.text();

    let stripeEvent;
    try {
      stripeEvent = stripe.webhooks.constructEvent(rawBody, sigHeader, webhookSecret);
    } catch (err) {
      console.error(`Échec vérification signature: ${err.message}`);
      return new Response(`Erreur de signature: ${err.message}`, { status: 400 });
    }

    if (stripeEvent.type === 'checkout.session.completed') {
      const session = stripeEvent.data.object;
      const missionId = session.metadata.mission_id;
      const reference = session.metadata.reference;

      if (!missionId) {
        return new Response('ID de mission manquant.', { status: 200 });
      }

      const { data: mission, error: missionError } = await supabase.from('missions')
        .select('id, reference, depart, arrivee, vehicule, mode, pack, montant_ht, paiement_statut, status, client_id, client_email, client_nom, client_telephone, convoyeur_nom, convoyeur_id, date_mission')
        .eq('id', missionId).single();

      if (missionError || !mission) {
        return new Response(`Mission ${missionId} introuvable`, { status: 404 });
      }

      if (mission.paiement_statut === 'paid' || mission.paiement_statut === 'paye') {
        return new Response(`Mission ${reference} déjà traitée.`, { status: 200 });
      }

      const updateFields = { paiement_statut: 'paid' };
      if (mission.status === 'available') updateFields.status = 'planned';

      const { error: updateError } = await supabase.from('missions').update(updateFields).eq('id', missionId);
      if (updateError) {
        return new Response(`Erreur BDD: ${updateError.message}`, { status: 500 });
      }

      let tempPassword = null;
      const clientEmail = mission.client_email;

      if (clientEmail) {
        try {
          const { data: existingUsers } = await supabase.auth.admin.listUsers();
          const existingAuthUser = existingUsers?.users?.find(u => u.email === clientEmail);
          let authUserId = null;

          if (existingAuthUser) {
            // Utilisateur Auth déjà existant (ex: convoyeur qui paie un devis)
            authUserId = existingAuthUser.id;
          } else {
            // Nouvel utilisateur : créer le compte Auth
            tempPassword = randomHex(6).toUpperCase().slice(0, 8) + randomHex(3).slice(0, 3) + '!';

            const { data: newAuthUser, error: authError } = await supabase.auth.admin.createUser({
              email: clientEmail, password: tempPassword, email_confirm: true,
              user_metadata: { prenom: mission.client_nom?.split(' ')[0] || 'Client', nom: mission.client_nom?.split(' ').slice(1).join(' ') || '', role: 'client' }
            });

            if (!authError) {
              authUserId = newAuthUser.user.id;
            }
          }

          // Créer ou mettre à jour la ligne clients (dans tous les cas)
          if (authUserId) {
            const { data: existingClient } = await supabase.from('clients')
              .select('id').eq('email', clientEmail).maybeSingle();

            if (existingClient) {
              await supabase.from('clients').update({
                auth_user_id: authUserId,
                prenom: mission.client_nom?.split(' ')[0] || 'Client',
                nom: mission.client_nom?.split(' ').slice(1).join(' ') || '',
                role: 'client'
              }).eq('email', clientEmail);
            } else {
              await supabase.from('clients').insert([{
                auth_user_id: authUserId,
                email: clientEmail,
                prenom: mission.client_nom?.split(' ')[0] || 'Client',
                nom: mission.client_nom?.split(' ').slice(1).join(' ') || '',
                role: 'client'
              }]);
            }
          }
        } catch (authErr) {
          console.error('Erreur création compte client:', authErr.message);
        }
      }

      try {
        const siteUrl = env.URL || 'https://www.bathily-convoyage.fr';
        await fetch(`${siteUrl}/api/send-email`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-internal-secret': env.INTERNAL_SECRET || '' },
          body: JSON.stringify({ trigger: 'payment_success', id: missionId, temp_password: tempPassword })
        });
      } catch (emailErr) {
        console.error("Erreur déclenchement email:", emailErr.message);
      }
    }

    return new Response(JSON.stringify({ received: true }), { status: 200, headers: { 'Content-Type': 'application/json' } });

  } catch (error) {
    console.error("Erreur stripe-webhook:", error);
    return new Response(`Erreur interne: ${error.message}`, { status: 500 });
  }
}
