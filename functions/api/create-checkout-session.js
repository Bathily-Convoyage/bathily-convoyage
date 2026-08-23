import Stripe from 'stripe';
import { createClient } from '@supabase/supabase-js';
import { getCorsHeaders, jsonResponse, handleOptions, checkRateLimit, parseBody } from '../_utils.js';

/**
 * Determine whether an existing Stripe Checkout Session is safe to reuse.
 * This is a pure local validation used before creating a new session.
 */
export function canReuseExistingSession(existingSession, mission, env) {
  if (!existingSession || typeof existingSession !== 'object') {
    return { reusable: false, reason: 'Session Stripe introuvable.' };
  }

  if (existingSession.url === undefined || existingSession.url === null || existingSession.url === '') {
    return { reusable: false, reason: 'URL de session invalide.' };
  }

  const key = env.STRIPE_SECRET_KEY || '';
  const expectedLivemode = /^(sk|rk)_live_/.test(key);
  if (existingSession.livemode !== expectedLivemode) {
    return { reusable: false, reason: 'Mode de session Stripe incohérent.' };
  }

  if (existingSession.status !== 'open') {
    if (existingSession.status === 'complete') {
      if (existingSession.payment_status === 'paid') {
        return { reusable: false, reason: 'Le paiement semble déjà effectué. Actualisez la page ou contactez le support.' };
      }
      return { reusable: false, reason: 'La session de paiement est complète mais non réglée. Synchronisation requise.' };
    }
    if (existingSession.status === 'expired') {
      return { reusable: false, reason: 'La session de paiement a expiré. Un renouvellement est nécessaire.' };
    }
    return { reusable: false, reason: 'La session de paiement n\'est pas réutilisable.' };
  }

  if (existingSession.payment_status !== 'unpaid') {
    return { reusable: false, reason: 'La session de paiement n\'est pas en attente.' };
  }

  if (existingSession.mode !== 'payment') {
    return { reusable: false, reason: 'Type de session Stripe incohérent.' };
  }

  if (existingSession.currency !== 'eur') {
    return { reusable: false, reason: 'Devise de session Stripe incohérente.' };
  }

  const priceHt = parseFloat(mission.montant_ht);
  const amountCents = Math.round(priceHt * 100);
  if ((existingSession.amount_total || 0) !== amountCents) {
    return { reusable: false, reason: 'Montant de session Stripe incohérent.' };
  }

  const metadata = existingSession.metadata || {};
  if (metadata.mission_id !== mission.id) {
    return { reusable: false, reason: 'Métadonnées de session incohérentes.' };
  }

  if (metadata.reference !== mission.reference) {
    return { reusable: false, reason: 'Référence de session incohérente.' };
  }

  return { reusable: true, url: existingSession.url };
}

function isExpectedLivemode(key) {
  return /^(sk|rk)_live_/.test(key || '');
}

export async function onRequest(context) {
  const { request, env } = context;

  const optionsRes = handleOptions(request);
  if (optionsRes) return optionsRes;

  const rl = checkRateLimit(request, 'create-checkout-session', 10, 60000);
  if (rl) return rl;

  if (request.method !== 'POST') {
    return jsonResponse({ error: 'Méthode non autorisée. Utilisez POST.' }, 405, getCorsHeaders(request));
  }

  try {
    if (!env.STRIPE_SECRET_KEY) throw new Error("STRIPE_SECRET_KEY manquante.");
    if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) throw new Error("Variables Supabase manquantes.");

    const stripe = context.stripe || Stripe(env.STRIPE_SECRET_KEY);
    const supabase = context.supabase || createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY);

    const { missionId, successUrl, cancelUrl } = await parseBody(request);
    const authHeader = request.headers.get('authorization') || '';

    if (!authHeader.startsWith('Bearer ')) {
      return jsonResponse({ error: 'Token d\'authentification requis.' }, 401, getCorsHeaders(request));
    }
    const token = authHeader.split(' ')[1];

    if (!env.SUPABASE_ANON_KEY) {
      throw new Error("SUPABASE_ANON_KEY manquante.");
    }
    const supabaseAnon = context.supabaseAnon || createClient(env.SUPABASE_URL, env.SUPABASE_ANON_KEY);
    const { data: { user }, error: userError } = await supabaseAnon.auth.getUser(token);

    if (userError || !user) {
      return jsonResponse({ error: 'Session invalide. Veuillez vous reconnecter.' }, 401, getCorsHeaders(request));
    }

    if (!missionId || !successUrl || !cancelUrl) {
      return jsonResponse({ error: 'Paramètres manquants : missionId, successUrl, cancelUrl requis.' }, 400, getCorsHeaders(request));
    }

    const { data: mission, error: selectError } = await supabase.from('missions')
      .select('id, reference, depart, arrivee, vehicule, mode, pack, montant_ht, paiement_statut, status, client_id, client_email, client_nom, convoyeur_nom, stripe_session_id')
      .eq('id', missionId).single();

    if (selectError || !mission) {
      return jsonResponse({ error: 'Mission introuvable en base de données.' }, 404, getCorsHeaders(request));
    }

    const { data: profile } = await supabaseAnon.from('clients').select('role, id, email').eq('auth_user_id', user.id).maybeSingle();
    const isAdmin = profile?.role === 'admin';
    const clientEmailLower = (mission.client_email || '').toLowerCase().trim();
    const userEmailLower = (user.email || '').toLowerCase().trim();
    const profileEmailLower = (profile?.email || '').toLowerCase().trim();
    const isClient = mission.client_id === profile?.id
      || clientEmailLower === userEmailLower
      || clientEmailLower === profileEmailLower;

    if (!isClient && !isAdmin) {
      return jsonResponse({ error: 'Vous n\'êtes pas autorisé à payer cette mission.' }, 403, getCorsHeaders(request));
    }

    if (mission.paiement_statut === 'paid') {
      return jsonResponse({ error: 'Cette mission est déjà payée.' }, 409, getCorsHeaders(request));
    }

    const statut = mission.status;
    const PAYABLE_STATUSES = ['available', 'assigned', 'accepted'];
    if (!PAYABLE_STATUSES.includes(statut)) {
      return jsonResponse({ error: 'Cette mission ne peut pas être payée (statut non autorisé).' }, 400, getCorsHeaders(request));
    }

    const priceHt = parseFloat(mission.montant_ht);
    if (isNaN(priceHt) || priceHt <= 0) {
      return jsonResponse({ error: 'Le montant de la mission est invalide.' }, 400, getCorsHeaders(request));
    }

    const amountCents = Math.round(priceHt * 100);

    // If the mission already has a Stripe Checkout Session, attempt to reuse it.
    if (mission.stripe_session_id) {
      let existingSession = null;
      try {
        existingSession = await stripe.checkout.sessions.retrieve(mission.stripe_session_id);
      } catch (retrieveErr) {
        console.error("Erreur récupération session Stripe existante:", retrieveErr.message);
        return jsonResponse({ error: 'Impossible de réutiliser cette session de paiement.' }, 409, getCorsHeaders(request));
      }

      const reuse = canReuseExistingSession(existingSession, mission, env);
      if (reuse.reusable) {
        return jsonResponse({ url: reuse.url, reused: true }, 200, getCorsHeaders(request));
      }

      return jsonResponse({ error: reuse.reason }, 409, getCorsHeaders(request));
    }

    const baseUrl = env.URL || 'https://www.bathily-convoyage.fr';
    const successUrlFinal = `${baseUrl}/dashboard-client.html?payment_status=success&mission_id=${missionId}`;
    const cancelUrlFinal = `${baseUrl}/dashboard-client.html?payment_status=cancel&mission_id=${missionId}`;

    const dep = (mission.depart || '').split('(')[0].trim();
    const arr = (mission.arrivee || '').split('(')[0].trim();
    const description = `Convoyage ${mission.vehicule || 'Véhicule'} : ${dep} ➔ ${arr} · Réf: ${mission.reference}`;

    const session = await stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      line_items: [{
        price_data: { currency: 'eur', product_data: { name: `Bathily Convoyage - Réf: ${mission.reference}`, description }, unit_amount: amountCents },
        quantity: 1,
      }],
      mode: 'payment',
      success_url: successUrlFinal,
      cancel_url: cancelUrlFinal,
      metadata: { mission_id: missionId, reference: mission.reference, client_id: user.id }
    });

    const { data: rpcResult, error: rpcError } = await supabase.rpc('record_stripe_checkout_session', {
      p_mission_id: missionId,
      p_session_id: session.id
    });

    if (rpcError) {
      console.error("Erreur liaison session Stripe (RPC):", rpcError.message);
      // The Checkout Session was created in Stripe but DB link failed.
      // Attempt to expire the orphan session so it cannot be used.
      try {
        await stripe.checkout.sessions.expire(session.id);
      } catch (expireErr) {
        console.error("Echec expiration session orpheline:", expireErr.message);
      }
      return jsonResponse({ error: 'Erreur lors de la liaison de la session de paiement.' }, 500, getCorsHeaders(request));
    }

    return jsonResponse({ url: session.url }, 200, getCorsHeaders(request));

  } catch (error) {
    console.error("Erreur create-checkout-session:", error);
    return jsonResponse({ error: error.message || 'Erreur interne du serveur.' }, 500, getCorsHeaders(request));
  }
}
