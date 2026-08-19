import { createClient } from '@supabase/supabase-js';
import { getCorsHeaders, jsonResponse, handleOptions, checkRateLimit, getQueryParams } from '../_utils.js';

// WAVE 2B.3B: Vehicle lookup security hardening
// - Accepted modes: mission (auth + plate-bound, VIN) and admin (auth, no VIN)
// - mode=devis is NOT accepted — public devis has no SIV access
// - Mocks removed
// - Synthetic fallback removed entirely
// - Upstream fail-closed with AbortController timeout
// - VIN only returned in mode=mission (authorized + plate-bound)
// - Stable error codes, no raw RapidAPI messages exposed

const UPSTREAM_HOST = 'api-plaque-immatriculation-siv.p.rapidapi.com';
const UPSTREAM_PATH = '/get-vehicule-info2';
const UPSTREAM_TIMEOUT_MS = 8000;

const defaultDeps = {
  createClient,
  fetch: globalThis.fetch,
  checkRateLimit,
  getQueryParams
};

function normalizePlate(p) {
  return (p || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
}

function formatProviderPlate(normalized) {
  if (normalized.length === 7) {
    return `${normalized.slice(0, 2)}-${normalized.slice(2, 5)}-${normalized.slice(5)}`;
  }
  return normalized;
}

function err(code, message, status, request) {
  return jsonResponse({ error: message, code }, status, getCorsHeaders(request));
}

// Map upstream JSON to our public response shape.
// Preserves the existing field mapping contract.
function mapUpstreamData(data) {
  const innerData = (data && data.data) || {};
  let annee = '';
  if (innerData.date1erCir_us && /^\d{4}-\d{2}-\d{2}$/.test(innerData.date1erCir_us)) {
    annee = innerData.date1erCir_us.substring(0, 4);
  }
  const result = {
    marque: innerData.marque || '',
    modele: innerData.modele || '',
    energie: innerData.energieNGC || '',
    couleur: innerData.couleur || '',
    annee,
    vin: innerData.vin || '',
    puissance: innerData.puisFisc || ''
  };
  if (result.marque) result.marque = result.marque.charAt(0).toUpperCase() + result.marque.slice(1).toLowerCase();
  if (result.modele) result.modele = result.modele.toUpperCase();
  if (result.energie) result.energie = result.energie.charAt(0).toUpperCase() + result.energie.slice(1).toLowerCase();
  if (result.couleur) result.couleur = result.couleur.charAt(0).toUpperCase() + result.couleur.slice(1).toLowerCase();
  return result;
}

function stripVin(obj) {
  const { vin, ...rest } = obj;
  return rest;
}

function logUpstream(status, category) {
  // Safe observability: only status and category; no secrets, VIN, or payload
  console.error(`[lookup-vehicle upstream] status=${status} category=${category}`);
}

async function callUpstream(providerPlate, rapidApiKey, fetchFn) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT_MS);
  const params = new URLSearchParams({ immatriculation: providerPlate });
  try {
    const response = await fetchFn(`https://${UPSTREAM_HOST}${UPSTREAM_PATH}?${params.toString()}`, {
      method: 'GET',
      headers: {
        'x-rapidapi-host': UPSTREAM_HOST,
        'x-rapidapi-key': rapidApiKey
      },
      signal: controller.signal
    });
    return response;
  } finally {
    clearTimeout(timeoutId);
  }
}

export async function handleRequest(context, deps = defaultDeps) {
  const { request, env } = context;
  const { createClient: cc, fetch: fetchImpl, checkRateLimit: rl, getQueryParams: gqp } = deps;

  const optionsRes = handleOptions(request);
  if (optionsRes) return optionsRes;

  if (request.method !== 'GET') {
    return err('method_not_allowed', 'Méthode non autorisée. Utilisez GET.', 405, request);
  }

  // Rate limit — authenticated modes only (mission/admin)
  const params = gqp(request);
  const mode = params.mode;
  if (!mode) {
    return err('invalid_request', 'Le paramètre mode est requis.', 400, request);
  }
  if (!['mission', 'admin'].includes(mode)) {
    return err('invalid_request', 'Mode de recherche invalide.', 400, request);
  }
  const rlRes = rl(request, 'lookup-vehicle', 30, 60000);
  if (rlRes) return rlRes;

  const plaque = params.plaque;
  if (!plaque) {
    return err('invalid_request', 'Le paramètre plaque est requis.', 400, request);
  }

  const formattedPlate = normalizePlate(plaque);
  if (formattedPlate.length < 4) {
    return err('invalid_request', 'Format de plaque invalide.', 400, request);
  }

  // ── Auth validation (required for both mission and admin modes) ──
  let authedUser = null;
  const authHeader = request.headers.get('authorization') || '';
  if (!authHeader.startsWith('Bearer ')) {
    return err('authentication_required', 'Authentification requise pour ce mode de recherche.', 401, request);
  }
  const token = authHeader.split(' ')[1];
  if (!env.SUPABASE_URL || !env.SUPABASE_ANON_KEY) {
    return err('vehicle_lookup_unavailable', 'Configuration serveur manquante.', 503, request);
  }
  // User-scoped client — carries the Bearer token so RLS and auth.uid()-based RPCs work
  const supabaseUser = cc(env.SUPABASE_URL, env.SUPABASE_ANON_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
    global: { headers: { Authorization: `Bearer ${token}` } }
  });
  const { data: { user }, error: authError } = await supabaseUser.auth.getUser(token);
  if (authError || !user) {
    return err('authentication_required', 'Session invalide. Veuillez vous reconnecter.', 401, request);
  }
  authedUser = user;

  // ── Admin role check via canonical is_admin() RPC ──
  // is_admin() checks user_roles.role='admin' OR clients.role='admin' (legacy)
  // Uses auth.uid() — requires user-scoped client, NOT service-role
  if (mode === 'admin') {
    let isAdmin = false;
    try {
      const { data: adminResult, error: adminErr } = await supabaseUser.rpc('is_admin');
      isAdmin = adminResult === true && !adminErr;
    } catch (e) {
      // RPC error — fail closed
      return err('access_denied', 'Accès réservé aux administrateurs.', 403, request);
    }
    if (!isAdmin) {
      return err('access_denied', 'Accès réservé aux administrateurs.', 403, request);
    }
  }

  // ── Mission authorization + plate binding ──
  if (mode === 'mission') {
    const missionId = params.mission_id;
    if (!missionId) {
      return err('invalid_request', 'Identifiant de mission requis pour ce mode.', 400, request);
    }
    // Reuse the user-scoped client (supabaseUser) — RLS enforces access
    // is_operator() and is_convoyeur_for_mission() use auth.uid()

    // Check operator or convoyeur-for-mission
    let isOp = false;
    try {
      const { data: opRes } = await supabaseUser.rpc('is_operator');
      isOp = opRes === true;
    } catch (e) { /* ignore */ }

    let isConv = false;
    if (!isOp) {
      try {
        const { data: convRes } = await supabaseUser.rpc('is_convoyeur_for_mission', {
          p_mission_id: missionId,
          p_user_id: authedUser.id
        });
        isConv = convRes === true;
      } catch (e) { /* ignore */ }
    }

    if (!isOp && !isConv) {
      return err('mission_access_denied', 'Accès non autorisé pour cette mission.', 403, request);
    }

    // Load mission to check plate binding (RLS-protected via user-scoped client)
    const { data: mission, error: missionErr } = await supabaseUser
      .from('missions')
      .select('immatriculation')
      .eq('id', missionId)
      .maybeSingle();

    if (missionErr || !mission) {
      return err('mission_access_denied', 'Mission introuvable ou accès non autorisé.', 403, request);
    }

    const missionPlate = normalizePlate(mission.immatriculation);
    if (!missionPlate) {
      return err('mission_plate_not_set', 'Aucune plaque enregistrée pour cette mission.', 422, request);
    }
    if (missionPlate !== formattedPlate) {
      return err('mission_plate_mismatch', 'La plaque ne correspond pas à la mission.', 409, request);
    }
  }

  // ── Upstream call (fail-closed, no synthetic fallback) ──
  const rapidApiKey = env.RAPIDAPI_KEY;
  if (!rapidApiKey) {
    return err('vehicle_lookup_unavailable', 'Service d\'identification véhicule indisponible.', 503, request);
  }

  let response;
  const providerPlate = formatProviderPlate(formattedPlate);
  try {
    response = await callUpstream(providerPlate, rapidApiKey, fetchImpl);
  } catch (fetchErr) {
    if (fetchErr.name === 'AbortError') {
      logUpstream(0, 'TIMEOUT');
      return err('vehicle_provider_timeout', 'Délai dépassé. Veuillez réessayer.', 504, request);
    }
    logUpstream(0, 'NETWORK_ERROR');
    return err('vehicle_provider_error', 'Service d\'identification véhicule indisponible.', 502, request);
  }

  let data;
  try {
    data = await response.json();
  } catch (e) {
    logUpstream(response.status, 'INVALID_JSON');
    return err('vehicle_provider_error', 'Réponse invalide du fournisseur.', 502, request);
  }

  if (!response.ok || data.error || (data.code && data.code !== 200)) {
    if (response.status === 404) {
      logUpstream(response.status, 'NOT_FOUND');
      return err('vehicle_not_found', 'Aucun véhicule trouvé pour cette plaque.', 404, request);
    }
    if (response.status === 401 || response.status === 403) {
      logUpstream(response.status, 'AUTH_ERROR');
      return err('vehicle_provider_error', 'Service d\'identification véhicule indisponible.', 502, request);
    }
    if (response.status === 429) {
      logUpstream(response.status, 'RATE_LIMIT');
      return err('vehicle_provider_error', 'Service d\'identification véhicule indisponible.', 502, request);
    }
    if (response.status >= 500) {
      logUpstream(response.status, 'UPSTREAM_5XX');
      return err('vehicle_provider_error', 'Service d\'identification véhicule indisponible.', 502, request);
    }
    logUpstream(response.status, 'UPSTREAM_ERROR');
    return err('vehicle_provider_error', 'Service d\'identification véhicule indisponible.', 502, request);
  }

  const result = mapUpstreamData(data);
  if (!result.marque) {
    return err('vehicle_not_found', 'Aucun véhicule trouvé pour cette plaque.', 404, request);
  }

  // Strip VIN for non-mission modes
  const publicResult = mode === 'mission' ? result : stripVin(result);
  return jsonResponse(publicResult, 200, getCorsHeaders(request));
}

export async function onRequest(context) {
  return handleRequest(context, defaultDeps);
}
