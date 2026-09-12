import { getCorsHeaders, jsonResponse, handleOptions, checkRateLimit, parseBody } from '../_utils.js';
import { calculateQuoteFromAddresses } from '../_pricing.js';
import { createClient } from '@supabase/supabase-js';

// RM-02: read the persisted B2C global pricing adjustment from system_settings.
// Server-side only (service-role key). The public browser never reads this row.
// Failure policy: any error / missing row / malformed value → 0 (no adjustment).
async function readGlobalAdjustPercent(env) {
  if (!env || !env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) return 0;
  try {
    const sb = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY);
    const { data, error } = await sb
      .from('system_settings')
      .select('value')
      .eq('key', 'global_adjust_percent')
      .maybeSingle();
    if (error || !data || !data.value) return 0;
    const pct = data.value.percent;
    const n = Number(pct);
    return Number.isFinite(n) ? n : 0;
  } catch (e) {
    // Defensive: never break quote calculation because of a config read failure.
    console.error('RM-02 global_adjust_percent read failed, falling back to 0:', e?.message || e);
    return 0;
  }
}

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

    // RM-02: server-side authoritative config read (B2C-only adjustment).
    const globalAdjustPercent = await readGlobalAdjustPercent(env);

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
      globalAdjustPercent,
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
