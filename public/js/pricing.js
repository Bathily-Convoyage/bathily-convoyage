/**
 * Tarification dynamique — Bathily-Convoyage
 * Ajuste les prix selon : distance, urgence, période, demande, type véhicule
 */

(function () {
  'use strict';

  // Tarifs de base (€ HT/km)
  var BASE_RATES = {
    Automobile: { perKm: 1.00, min: 120 },
    Moto: { perKm: 0.85, min: 100 },
    Utilitaire: { perKm: 1.10, min: 150 },
    Luxe: { perKm: 1.50, min: 200, plateauOnly: true }
  };

  // Coefficients dynamiques
  var COEFFS = {
    // Urgence
    urgence_24h: 1.25,
    urgence_48h: 1.15,
    urgence_7j: 1.05,
    // Période (haute saison : juin-septembre)
    haute_saison: 1.15,
    // Distance (remise sur volume)
    dist_500plus: 0.90,
    dist_800plus: 0.85,
    // Week-end
    weekend: 1.10,
    // Nuit (22h-6h)
    nuit: 1.20,
    // Plateau (forfait de base)
    plateau_base: 350,
    plateau_perKm: 0.45,
    // Taille utilitaire (coefficient multiplicateur)
    util_3m3: 1.0,
    util_6m3: 1.10,
    util_10m3: 1.20,
    util_14m3: 1.30,
    util_20m3: 1.50,
    // Non-roulant (force plateau)
    non_roulant_supplement: 50
  };

  // ── Calculer le tarif dynamique ──
  function calculate(opts) {
    var vehType = opts.vehType || 'Automobile';
    var distance = opts.distance || 0;
    var mode = opts.mode || 'route';
    var datePriseEnCharge = opts.date ? new Date(opts.date) : new Date();
    var urgence = opts.urgence || 'standard';

    var rate = BASE_RATES[vehType] || BASE_RATES.Automobile;

    // ── Tarif de base (route) ──
    prix = distance * rate.perKm;
    prix = Math.max(prix, rate.min);

    // ── Plateau s'AJOUTE au prix route (minimum 350€) ──
    if (mode === 'plateau') {
      var plateauCost = COEFFS.plateau_base + (distance * COEFFS.plateau_perKm);
      prix += Math.max(plateauCost, COEFFS.plateau_base);
    }

    // ── Coefficient distance (remise volume) ──
    if (distance >= 800) prix *= COEFFS.dist_800plus;
    else if (distance >= 500) prix *= COEFFS.dist_500plus;

    // ── Coefficient urgence ──
    if (urgence === '24h') prix *= COEFFS.urgence_24h;
    else if (urgence === '48h') prix *= COEFFS.urgence_48h;
    else if (urgence === '7j') prix *= COEFFS.urgence_7j;

    // ── Coefficient période ──
    var month = datePriseEnCharge.getMonth();
    if (month >= 5 && month <= 8) prix *= COEFFS.haute_saison; // juin-septembre

    // ── Coefficient week-end ──
    var day = datePriseEnCharge.getDay();
    if (day === 0 || day === 6) prix *= COEFFS.weekend;

    // ── Coefficient nuit ──
    var hour = datePriseEnCharge.getHours();
    if (hour >= 22 || hour < 6) prix *= COEFFS.nuit;

    // ── Arrondi ──
    prix = Math.round(prix);

    // ── Détail des coefficients appliqués ──
    var details = [];
    if (distance >= 800) details.push({ label: 'Remise longue distance (-15%)', value: -0.15 });
    else if (distance >= 500) details.push({ label: 'Remise distance (-10%)', value: -0.10 });
    if (urgence === '24h') details.push({ label: 'Majoration urgence 24h (+25%)', value: 0.25 });
    else if (urgence === '48h') details.push({ label: 'Majoration urgence 48h (+15%)', value: 0.15 });
    else if (urgence === '7j') details.push({ label: 'Majoration délai court (+5%)', value: 0.05 });
    if (month >= 5 && month <= 8) details.push({ label: 'Haute saison (+15%)', value: 0.15 });
    if (day === 0 || day === 6) details.push({ label: 'Week-end (+10%)', value: 0.10 });
    if (hour >= 22 || hour < 6) details.push({ label: 'Prise en charge nocturne (+20%)', value: 0.20 });

    return {
      prix: prix,
      prixTTC: Math.round(prix * 1.2),
      distance: distance,
      mode: mode,
      vehType: vehType,
      baseRate: mode === 'plateau' ? COEFFS.plateau_base : rate.perKm,
      details: details,
      min: min
    };
  }

  // ── Formater pour affichage ──
  function formatResult(result) {
    var html = '<div class="quote-detail">';
    html += '<div class="quote-price"><strong>' + result.prix + ' € HT</strong> (' + result.prixTTC + ' € TTC)</div>';
    if (result.details.length > 0) {
      html += '<div class="quote-details-list">';
      result.details.forEach(function (d) {
        var sign = d.value > 0 ? '+' : '';
        var color = d.value > 0 ? '#e74c3c' : '#27ae60';
        html += '<div class="quote-detail-item"><span>' + d.label + '</span><span style="color:' + color + ';">' + sign + Math.round(d.value * 100) + '%</span></div>';
      });
      html += '</div>';
    }
    html += '</div>';
    return html;
  }

  window.BathilyPricing = {
    calculate: calculate,
    formatResult: formatResult,
    BASE_RATES: BASE_RATES,
    COEFFS: COEFFS
  };
})();
