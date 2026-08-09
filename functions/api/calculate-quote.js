import { getCorsHeaders, jsonResponse, handleOptions, checkRateLimit, parseBody } from '../_utils.js';
import { calculateQuoteFromAddresses } from '../_pricing.js';

export async function onRequest(context) {
  const { request, env } = context;

  const optionsRes = handleOptions(request);
  if (optionsRes) return optionsRes;

  if (request.method !== 'POST') {
    return jsonResponse({ error: 'Méthode non autorisée. Utilisez POST.' }, 405, getCorsHeaders(request));
  }

  const rl = checkRateLimit(request, 'calculate-quote', 30, 60000);
  if (rl) return rl;

  try {
    const body = await parseBody(request);

    const {
      depart,
      arrivee,
      type = 'Automobile',
      mode = 'route',
      pack = 'starter',
      isUrgence = false,
      isGardiennage = false,
      vehicleCondition = 'working',
      utilSize,
      isPro = false,
      promoPercent = 0,
      dateLivraison
    } = body;

    if (!depart || !arrivee) {
      return jsonResponse({ error: 'Les champs départ et arrivée sont requis.' }, 400, getCorsHeaders(request));
    }

    if (Number(promoPercent) < 0 || Number(promoPercent) > 100) {
      return jsonResponse({ error: 'promoPercent doit être entre 0 et 100.' }, 400, getCorsHeaders(request));
    }

    const quote = await calculateQuoteFromAddresses({
      depart,
      arrivee,
      type,
      mode,
      pack,
      isUrgence,
      isGardiennage,
      vehicleCondition,
      utilSize,
      isPro,
      promoPercent: 0,
      dateLivraison
    });

    if (quote.error) {
      return jsonResponse(quote, 400, getCorsHeaders(request));
    }

    return jsonResponse(quote, 200, getCorsHeaders(request));

  } catch (error) {
    console.error('Erreur calculate-quote:', error);
    return jsonResponse({ error: error.message || 'Erreur interne' }, 500, getCorsHeaders(request));
  }
}
