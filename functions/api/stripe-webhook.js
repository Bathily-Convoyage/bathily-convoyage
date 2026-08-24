import Stripe from 'stripe';
import { createClient } from '@supabase/supabase-js';
import { randomHex } from '../_utils.js';

const PAID_CHECKOUT_EVENTS = new Set([
  'checkout.session.completed',
  'checkout.session.async_payment_succeeded',
]);

export async function findAuthUserByEmail(supabase, email) {
  const cleanEmail = String(email || '').trim().toLowerCase();
  if (!cleanEmail) return null;

  const perPage = 200;
  for (let page = 1; page <= 100; page += 1) {
    const { data, error } = await supabase.auth.admin.listUsers({ page, perPage });
    if (error) throw new Error(`Recherche Auth impossible: ${error.message}`);

    const users = data?.users || [];
    const match = users.find((user) => String(user.email || '').trim().toLowerCase() === cleanEmail);
    if (match) return match;
    if (users.length < perPage) return null;
  }

  throw new Error('Recherche Auth interrompue: limite de pagination atteinte.');
}

export async function ensureClientAccess(supabase, mission) {
  const email = String(mission.client_email || '').trim().toLowerCase();
  if (!email) return { skipped: true, reason: 'client_email_missing' };

  let authUser = await findAuthUserByEmail(supabase, email);
  if (!authUser) {
    const password = `${randomHex(6).toUpperCase().slice(0, 8)}${randomHex(3).slice(0, 3)}!`;
    const { data, error } = await supabase.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
      user_metadata: {
        prenom: mission.client_nom?.split(' ')[0] || 'Client',
        nom: mission.client_nom?.split(' ').slice(1).join(' ') || '',
        role: 'client',
      },
    });

    if (error) {
      authUser = await findAuthUserByEmail(supabase, email);
      if (!authUser) throw new Error(`Création du compte client impossible: ${error.message}`);
    } else {
      authUser = data?.user || null;
    }
  }

  if (!authUser?.id) throw new Error('Compte Auth client introuvable après création.');

  const { data: existingClient, error: clientLookupError } = await supabase
    .from('clients')
    .select('id, role')
    .eq('email', email)
    .maybeSingle();
  if (clientLookupError) throw new Error(`Recherche du profil client impossible: ${clientLookupError.message}`);

  const { error: profileError } = await supabase.from('clients').upsert({
    id: existingClient?.id,
    auth_user_id: authUser.id,
    email,
    prenom: mission.client_nom?.split(' ')[0] || 'Client',
    nom: mission.client_nom?.split(' ').slice(1).join(' ') || '',
    role: existingClient?.role || 'client',
  }, { onConflict: 'email' });
  if (profileError) throw new Error(`Rattachement du profil client impossible: ${profileError.message}`);

  return { skipped: false, authUserId: authUser.id };
}

async function triggerPaymentEmail({ env, missionId, stripeEventId, fetchImpl }) {
  const siteUrl = (env.URL || 'https://www.bathily-convoyage.fr').replace(/\/$/, '');
  const response = await fetchImpl(`${siteUrl}/api/send-email`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-internal-secret': env.INTERNAL_SECRET || '',
    },
    body: JSON.stringify({
      trigger: 'payment_success',
      id: missionId,
      stripe_event_id: stripeEventId,
    }),
  });

  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    throw new Error(`Notification paiement refusée (${response.status})${detail ? `: ${detail.slice(0, 200)}` : ''}`);
  }
}

export async function onRequest(context) {
  const { request, env } = context;

  if (request.method !== 'POST') {
    return new Response('Méthode non autorisée. Utilisez POST.', { status: 405 });
  }

  try {
    if (!env.STRIPE_SECRET_KEY) throw new Error('STRIPE_SECRET_KEY manquante.');
    if (!env.SUPABASE_URL) throw new Error('SUPABASE_URL manquante.');
    if (!env.SUPABASE_SERVICE_ROLE_KEY) throw new Error('SUPABASE_SERVICE_ROLE_KEY manquante.');

    const stripe = context.stripe || Stripe(env.STRIPE_SECRET_KEY);
    const supabase = context.supabase || createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
      auth: { autoRefreshToken: false, persistSession: false },
    });
    const fetchImpl = context.fetchImpl || fetch;

    const sigHeader = request.headers.get('stripe-signature') || '';
    const webhookSecret = env.STRIPE_WEBHOOK_SECRET;
    if (!sigHeader || !webhookSecret) {
      return new Response('En-tête stripe-signature ou configuration secrète manquante.', { status: 400 });
    }

    const rawBody = await request.text();
    let stripeEvent;
    try {
      stripeEvent = await stripe.webhooks.constructEventAsync(rawBody, sigHeader, webhookSecret);
    } catch (err) {
      console.error(`Échec vérification signature: ${err.message}`);
      return new Response(`Erreur de signature: ${err.message}`, { status: 400 });
    }

    if (!PAID_CHECKOUT_EVENTS.has(stripeEvent.type)) {
      return new Response(JSON.stringify({ received: true, ignored: true }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    const session = stripeEvent.data.object;
    const missionId = session.metadata?.mission_id;
    const reference = session.metadata?.reference;
    if (!missionId) return new Response('ID de mission manquant.', { status: 200 });

    if (session.payment_status !== 'paid') {
      return new Response(JSON.stringify({ received: true, payment_pending: true }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    const { data: mission, error: missionError } = await supabase
      .from('missions')
      .select('id, reference, depart, arrivee, vehicule, mode, pack, montant_ht, paiement_statut, status, client_id, client_email, client_nom, client_telephone, convoyeur_nom, convoyeur_id, date_mission')
      .eq('id', missionId)
      .single();
    if (missionError || !mission) return new Response(`Mission ${missionId} introuvable`, { status: 404 });

    const { error: rpcError } = await supabase.rpc('complete_stripe_checkout_payment', {
      p_mission_id: missionId,
      p_session_id: session.id,
    });
    if (rpcError) {
      console.error('Erreur paiement RPC:', rpcError.message);
      return new Response(`Erreur BDD: ${rpcError.message}`, { status: 500 });
    }

    await ensureClientAccess(supabase, mission);
    await triggerPaymentEmail({
      env,
      missionId,
      stripeEventId: stripeEvent.id,
      fetchImpl,
    });

    return new Response(JSON.stringify({ received: true, reference: reference || mission.reference }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (error) {
    console.error('Erreur stripe-webhook:', error);
    return new Response(`Erreur interne: ${error.message}`, { status: 500 });
  }
}
