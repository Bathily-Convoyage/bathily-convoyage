import Stripe from 'stripe';
import { createClient } from '@supabase/supabase-js';
import { getCorsHeaders, jsonResponse, handleOptions, checkRateLimit, parseBody } from '../_utils.js';

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

    const stripe = Stripe(env.STRIPE_SECRET_KEY);
    const supabase = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY);

    const { missionId, successUrl, cancelUrl } = await parseBody(request);
    const authHeader = request.headers.get('authorization') || '';

    if (!authHeader.startsWith('Bearer ')) {
      return jsonResponse({ error: 'Token d\'authentification requis.' }, 401, getCorsHeaders(request));
    }
    const token = authHeader.split(' ')[1];

    const supabaseAnon = createClient(env.SUPABASE_URL, env.SUPABASE_ANON_KEY || env.SUPABASE_SERVICE_ROLE_KEY);
    const { data: { user }, error: userError } = await supabaseAnon.auth.getUser(token);

    if (userError || !user) {
      return jsonResponse({ error: 'Session invalide. Veuillez vous reconnecter.' }, 401, getCorsHeaders(request));
    }

    if (!missionId || !successUrl || !cancelUrl) {
      return jsonResponse({ error: 'Paramètres manquants : missionId, successUrl, cancelUrl requis.' }, 400, getCorsHeaders(request));
    }

    const { data: mission, error: selectError } = await supabase.from('missions')
      .select('id, reference, depart, arrivee, vehicule, mode, pack, montant_ht, paiement_statut, status, client_id, client_email, client_nom, convoyeur_nom')
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

    const statut = mission.status || 'planned';
    if (statut === 'cancelled' || statut === 'completed') {
      return jsonResponse({ error: 'Cette mission ne peut pas être payée.' }, 400, getCorsHeaders(request));
    }

    const priceHt = parseFloat(mission.montant_ht);
    if (isNaN(priceHt) || priceHt <= 0) {
      return jsonResponse({ error: 'Le montant de la mission est invalide.' }, 400, getCorsHeaders(request));
    }

    const amountCents = Math.round(priceHt * 100);
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

    const { error: updateError } = await supabase.from('missions').update({ stripe_session_id: session.id }).eq('id', missionId);
    if (updateError) console.error("Erreur enregistrement session Stripe:", updateError.message);

    return jsonResponse({ url: session.url }, 200, getCorsHeaders(request));

  } catch (error) {
    console.error("Erreur create-checkout-session:", error);
    return jsonResponse({ error: error.message || 'Erreur interne du serveur.' }, 500, getCorsHeaders(request));
  }
}
