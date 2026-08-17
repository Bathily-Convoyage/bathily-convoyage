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

const UPSTREAM_HOST = 'api-siv-systeme-d-immatriculation-des-vehicules.p.rapidapi.com';
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

function err(code, message, status, request) {
  return jsonResponse({ error: message, code }, status, getCorsHeaders(request));
}

// Map upstream JSON to our public response shape.
// Preserves the existing field mapping contract.
function mapUpstreamData(data) {
  const innerData = (data && data.data) || {};
  const result = {
    marque: innerData.AWN_marque || innerData.marque || data.marque || data.make || data.Brand || '',
    modele: innerData.AWN_modele || innerData.modele || data.modele || data.model || data.Model || '',
    energie: innerData.AWN_energie || innerData.energie || data.energie || data.fuelType || data.Fuel || '',
    couleur: innerData.AWN_couleur || innerData.couleur || data.couleur || data.color || data.Color || '',
    annee: (innerData.AWN_date_mise_en_circulation_us ? innerData.AWN_date_mise_en_circulation_us.substring(0, 4) : null) || innerData.AWN_annee_debut_modele || data.annee || data.year || '',
    vin: innerData.AWN_VIN || innerData.vin || data.vin || data.vinNumber || '',
    puissance: innerData.AWN_puissance_fiscale || innerData.puissance || data.puissanceFiscale || data.puissance_fiscale || data.power || ''
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

async function callUpstream(formattedPlate, rapidApiKey, fetchFn) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT_MS);
  try {
    const response = await fetchFn(`https://${UPSTREAM_HOST}/${formattedPlate}`, {
      method: 'GET',
      headers: {
        'x-rapidapi-host': UPSTREAM_HOST,
        'x-rapidapi-key': rapidApiKey,
        'Content-Type': 'application/json'
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
  try {
    response = await callUpstream(formattedPlate, rapidApiKey, fetchImpl);
  } catch (fetchErr) {
    if (fetchErr.name === 'AbortError') {
      return err('vehicle_provider_timeout', 'Délai dépassé. Veuillez réessayer.', 504, request);
    }
    return err('vehicle_provider_error', 'Service d\'identification véhicule indisponible.', 502, request);
  }

  let data;
  try {
    data = await response.json();
  } catch (e) {
    return err('vehicle_provider_error', 'Réponse invalide du fournisseur.', 502, request);
  }

  if (!response.ok || data.error || (data.code && data.code !== 200)) {
    if (response.status === 404) {
      return err('vehicle_not_found', 'Aucun véhicule trouvé pour cette plaque.', 404, request);
    }
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
