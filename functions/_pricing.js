// Shared pure pricing engine — backend authoritative source of truth
// Mirror of frontend js/pricing.js and devis.html rules.
// No secrets. No DB. No side effects.

const CANONICAL_PACKS = ['starter', 'serenite', 'excellence'];

const PACK_ALIASES = {
  starter: 'starter',
  'starter — inclus (convoyeur certifié, suivi gps, état des lieux 20 photos)': 'starter',
  serenite: 'serenite',
  'sérénité': 'serenite',
  'sérénité — +69€ (nettoyage int./ext., lavage, rdv planifié, support vip)': 'serenite',
  'serenite — +69€ (nettoyage int./ext., lavage, rdv planifié, support vip)': 'serenite',
  excellence: 'excellence',
  'excellence — +159€ (plein carburant, photos 4k, livraison directe)': 'excellence'
};

export function normalizePack(value) {
  if (value === undefined || value === null) return null;
  const v = String(value).trim().toLowerCase();
  if (CANONICAL_PACKS.includes(v)) return v;
  if (PACK_ALIASES[v]) return PACK_ALIASES[v];
  // accepte les clés sans diacritiques
  const deaccent = v.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  if (CANONICAL_PACKS.includes(deaccent)) return deaccent;
  if (PACK_ALIASES[deaccent]) return PACK_ALIASES[deaccent];
  return null;
}

const BASE_RATES_PUBLIC = {
  Automobile: { route: 1.20, plateau: 1.40 },
  Moto: { route: 1.00, plateau: 1.20 },
  Utilitaire: { route: 1.40, plateau: 1.60 },
  Luxe: { route: 1.80, plateau: 2.00 }
};

const BASE_RATES_PRO = {
  Automobile: { route: 0.90, plateau: 1.05 },
  Moto: { route: 0.77, plateau: 0.90 },
  Utilitaire: { route: 1.15, plateau: 1.20 },
  Luxe: { route: 1.50, plateau: 1.50 }
};

const PACK_PRICES_PUBLIC = { starter: 0, serenite: 69, excellence: 159 };
const PACK_PRICES_PRO = { starter: 0, serenite: 55, excellence: 125 };

const UTIL_SIZE_COEFFS = { '3': 1.0, '6': 1.10, '10': 1.20, '14': 1.30, '20': 1.50 };

const PLATEAU_FORFAIT_PUBLIC = 350;
const PLATEAU_FORFAIT_PRO = 292;

const COEFFS = {
  dist_500plus: 0.90,
  dist_800plus: 0.85,
  urgence_public: 1.30,
  urgence_pro: 1.25,
  gardiennage_public: 30,
  gardiennage_pro: 20,
  haute_saison: 1.15,
  remuneration_rate: 0.60
};

function toRad(deg) { return deg * Math.PI / 180; }

function haversine(lat1, lon1, lat2, lon2) {
  const R = 6371;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return Math.round(R * c * 1.22);
}

async function geocodeAddress(address) {
  if (!address) return null;
  try {
    const url = `https://api-adresse.data.gouv.fr/search/?q=${encodeURIComponent(address)}&limit=1`;
    const response = await fetch(url, { headers: { Accept: 'application/json' } });
    if (!response.ok) return null;
    const data = await response.json();
    if (!data.features || data.features.length === 0) return null;
    const f = data.features[0].geometry.coordinates;
    return { lat: f[1], lon: f[0] };
  } catch (e) { return null; }
}

async function calculateDistance(depart, arrivee) {
  if (!depart || !arrivee) return 0;
  const c1 = await geocodeAddress(depart);
  const c2 = await geocodeAddress(arrivee);
  if (!c1 || !c2) return 0;

  try {
    const url = `https://router.project-osrm.org/route/v1/driving/${c1.lon},${c1.lat};${c2.lon},${c2.lat}?overview=false`;
    const response = await fetch(url, { headers: { Accept: 'application/json' } });
    if (response.ok) {
      const data = await response.json();
      if (data.routes && data.routes.length > 0) {
        return Math.round(data.routes[0].distance / 1000);
      }
    }
  } catch (e) { /* fall through */ }

  return haversine(c1.lat, c1.lon, c2.lat, c2.lon);
}

function isHauteSaison(date) {
  const d = date ? new Date(date) : new Date();
  const month = d.getMonth(); // 0-11
  return month >= 5 && month <= 8; // juin-septembre
}

/**
 * Authoritative quote calculation.
 * @param {Object} opts
 * @returns {Object} { total_ht, ttc, distance, remuneration_convoyeur, marge, details, applied_coeffs }
 */
export function calculateQuote(opts) {
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
    dateLivraison,
    distance // authoritative distance; caller may ignore client distance
  } = opts;

  if (!distance || distance <= 0) {
    return { error: 'distance_non_calculable' };
  }

  const normalizedPack = normalizePack(pack);
  if (!normalizedPack) {
    return { error: 'pack_inconnu', pack_reçu: pack };
  }

  const baseRates = isPro ? BASE_RATES_PRO : BASE_RATES_PUBLIC;
  const packPrices = isPro ? PACK_PRICES_PRO : PACK_PRICES_PUBLIC;
  const plateauForfait = isPro ? PLATEAU_FORFAIT_PRO : PLATEAU_FORFAIT_PUBLIC;

  const effectiveMode = vehicleCondition === 'non_working' ? 'plateau' : mode;

  const rates = baseRates[type] || baseRates.Automobile;
  const perKm = effectiveMode === 'plateau' ? rates.plateau : rates.route;

  let basePrice;
  if (effectiveMode === 'plateau') {
    basePrice = plateauForfait + Math.round(distance * perKm);
  } else {
    const min = isPro
      ? (type === 'Moto' ? 100 : 125)
      : (type === 'Moto' ? 120 : 150);
    basePrice = Math.max(Math.round(distance * perKm), min);
  }

  // Coefficient taille utilitaire
  if (type === 'Utilitaire' && utilSize && UTIL_SIZE_COEFFS[utilSize]) {
    basePrice = Math.round(basePrice * UTIL_SIZE_COEFFS[utilSize]);
  }

  let total = basePrice + (packPrices[normalizedPack] || 0);

  const applied = [];

  // Remise longue distance
  if (distance >= 800) {
    total = Math.round(total * COEFFS.dist_800plus);
    applied.push({ label: 'Remise longue distance (-15%)', value: -0.15 });
  } else if (distance >= 500) {
    total = Math.round(total * COEFFS.dist_500plus);
    applied.push({ label: 'Remise distance (-10%)', value: -0.10 });
  }

  // Haute saison
  if (isHauteSaison(dateLivraison)) {
    total = Math.round(total * COEFFS.haute_saison);
    applied.push({ label: 'Haute saison (+15%)', value: 0.15 });
  }

  // Urgence
  if (isUrgence) {
    const coeff = isPro ? COEFFS.urgence_pro : COEFFS.urgence_public;
    total = Math.round(total * coeff);
    applied.push({ label: `Urgence (+${Math.round((coeff - 1) * 100)}%)`, value: coeff - 1 });
  }

  // Gardiennage
  if (isGardiennage) {
    const fee = isPro ? COEFFS.gardiennage_pro : COEFFS.gardiennage_public;
    total += fee;
    applied.push({ label: `Gardiennage (+${fee}€)`, value: fee });
  }

  // Promo code
  let discount = 0;
  if (promoPercent > 0 && promoPercent <= 100) {
    discount = Math.round(total * (promoPercent / 100));
    total -= discount;
    applied.push({ label: `Code promo -${promoPercent}%`, value: -(promoPercent / 100) });
  }

  // TVA non applicable — franchise en base (art. 293 B CGI)
  // Prix affiché final = HT
  const total_ht = Math.round(total);
  const ttc = Math.round(total_ht * 1.2); // affichage informatif seul

  const remuneration_convoyeur = Math.round(total_ht * COEFFS.remuneration_rate);
  const marge = total_ht - remuneration_convoyeur;

  return {
    total_ht,
    ttc,
    distance,
    remuneration_convoyeur,
    marge,
    details: {
      depart,
      arrivee,
      type,
      mode: effectiveMode,
      pack: normalizedPack,
      isUrgence,
      isGardiennage,
      utilSize,
      isPro,
      promoPercent,
      discount,
      basePrice,
      applied_coeffs: applied
    }
  };
}

export async function calculateQuoteFromAddresses(opts) {
  const distance = await calculateDistance(opts.depart, opts.arrivee);
  if (!distance) return { error: 'distance_non_calculable', distance: 0 };
  return calculateQuote({ ...opts, distance });
}

export { calculateDistance, haversine };
