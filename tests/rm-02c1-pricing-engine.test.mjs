// RM-02C1 — Pricing engine unit tests.
//
// Verifies the corrected RM-02 backend pricing formula:
//  - B2C base 1.20, packs 0/69/149, B2B unchanged
//  - seasonal +15% removed (March/June/September identical)
//  - global adjustment: B2C only, transport only, additive delta
//  - pack isolation, B2B isolation, urgency isolation, gardiennage isolation
//  - long-distance discount preserves (basePrice + packPrice) × dist_coeff
//  - zero-adjustment backward compatibility (bit-identical to current formula
//    with seasonal removed + Excellence 149)
//  - rounding boundaries, minimum, plateau, utilitaire coefficient
//  - essentiel alias → starter
//
// Run: node --test tests/rm-02c1-pricing-engine.test.mjs

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { calculateQuote, normalizePack } from '../functions/_pricing.js';

// Helper: base B2C Automobile quote with explicit distance (no geocoding).
function quote(opts) {
  return calculateQuote({
    depart: 'A', arrivee: 'B', type: 'Automobile', mode: 'route',
    pack: 'starter', distance: 300, ...opts
  });
}

// =========================================================
// A. ZERO ADJUSTMENT COMPATIBILITY
// =========================================================
test('A. zero-adjust: 300km starter = 360 (base 1.20 × 300)', () => {
  const r = quote({ distance: 300, pack: 'starter', globalAdjustPercent: 0 });
  assert.equal(r.total_ht, 360);
  assert.equal(r.details.global_adjust_percent, 0);
  assert.equal(r.details.global_adjust_delta, 0);
});

test('A. zero-adjust: 300km serenite = 429 (360 + 69)', () => {
  const r = quote({ distance: 300, pack: 'serenite', globalAdjustPercent: 0 });
  assert.equal(r.total_ht, 429);
});

test('A. zero-adjust: 300km excellence = 509 (360 + 149)', () => {
  const r = quote({ distance: 300, pack: 'excellence', globalAdjustPercent: 0 });
  assert.equal(r.total_ht, 509);
  assert.equal(r.details.packPrice, 149);
});

test('A. zero-adjust: 600km excellence = 782 (round((720+149)*0.90))', () => {
  const r = quote({ distance: 600, pack: 'excellence', globalAdjustPercent: 0 });
  assert.equal(r.total_ht, 782);
});

test('A. zero-adjust: 900km serenite = 977 (round((1080+69)*0.85))', () => {
  const r = quote({ distance: 900, pack: 'serenite', globalAdjustPercent: 0 });
  assert.equal(r.total_ht, 977);
});

test('A. zero-adjust: 50km starter hits minimum 150', () => {
  const r = quote({ distance: 50, pack: 'starter', globalAdjustPercent: 0 });
  assert.equal(r.total_ht, 150);
});

test('A. zero-adjust: 200km plateau excellence = 779 (350+280+149)', () => {
  const r = quote({ distance: 200, pack: 'excellence', mode: 'plateau', globalAdjustPercent: 0 });
  assert.equal(r.total_ht, 779);
});

test('A. zero-adjust: 300km Utilitaire u10 serenite = 573', () => {
  const r = quote({ distance: 300, type: 'Utilitaire', utilSize: '10', pack: 'serenite', globalAdjustPercent: 0 });
  // base = round(300*1.40)=420, ×1.20=504, +69=573
  assert.equal(r.total_ht, 573);
});

test('A. zero-adjust: 300km excellence urgency = 662 (round(509*1.30))', () => {
  const r = quote({ distance: 300, pack: 'excellence', isUrgence: true, globalAdjustPercent: 0 });
  assert.equal(r.total_ht, 662);
});

test('A. zero-adjust: 300km serenite gardiennage = 459 (429+30)', () => {
  const r = quote({ distance: 300, pack: 'serenite', isGardiennage: true, globalAdjustPercent: 0 });
  assert.equal(r.total_ht, 459);
});

// =========================================================
// B. PACK ISOLATION
// =========================================================
test('B. pack isolation: g=0 vs g=+10, pack component unchanged (excellence)', () => {
  const r0 = quote({ distance: 300, pack: 'excellence', globalAdjustPercent: 0 });
  const r10 = quote({ distance: 300, pack: 'excellence', globalAdjustPercent: 10 });
  assert.equal(r0.details.packPrice, 149);
  assert.equal(r10.details.packPrice, 149);
  // total increased by exactly the transport delta (360 × 10% = 36)
  assert.equal(r10.total_ht - r0.total_ht, 36);
});

test('B. pack isolation: serenite pack component unchanged across adjustments', () => {
  for (const g of [0, 10, -10, 50, -50]) {
    const r = quote({ distance: 300, pack: 'serenite', globalAdjustPercent: g });
    assert.equal(r.details.packPrice, 69, `packPrice should be 69 for g=${g}`);
  }
});

test('B. pack isolation: starter pack component is 0 regardless of adjustment', () => {
  for (const g of [0, 10, -10, 50, -50]) {
    const r = quote({ distance: 300, pack: 'starter', globalAdjustPercent: g });
    assert.equal(r.details.packPrice, 0, `packPrice should be 0 for g=${g}`);
  }
});

// =========================================================
// C. B2B ISOLATION
// =========================================================
test('C. B2B isolation: same B2B total for g=-50, 0, +50', () => {
  const results = [];
  for (const g of [-50, 0, 50]) {
    const r = quote({ distance: 300, pack: 'excellence', isPro: true, globalAdjustPercent: g });
    assert.equal(r.details.isPro, true);
    assert.equal(r.details.global_adjust_percent, 0, `B2B global_adjust_percent must be 0 for g=${g}`);
    assert.equal(r.details.global_adjust_delta, 0, `B2B global_adjust_delta must be 0 for g=${g}`);
    results.push(r.total_ht);
  }
  // B2B: base=270 (0.90×300), excellence=125 → 395
  assert.deepEqual(results, [395, 395, 395]);
});

test('C. B2B isolation: B2B rates unchanged', () => {
  const r = quote({ distance: 300, pack: 'excellence', isPro: true });
  // B2B auto rate 0.90 → base 270, pack 125 → 395
  assert.equal(r.details.basePrice, 270);
  assert.equal(r.details.packPrice, 125);
  assert.equal(r.total_ht, 395);
});

test('C. B2B isolation: B2B urgency unchanged', () => {
  const r = quote({ distance: 300, pack: 'excellence', isPro: true, isUrgence: true });
  // 395 × 1.25 = 493.75 → 494
  assert.equal(r.total_ht, 494);
});

// =========================================================
// D. URGENCY ISOLATION
// =========================================================
test('D. urgency isolation: global delta identical with urgency on/off', () => {
  // Use distance=167 → basePrice=200 (167×1.20=200.4→200) to match RM-02B2 spec example.
  const baseOpts = { distance: 167, pack: 'excellence', globalAdjustPercent: 10 };
  const rNoUrg = quote({ ...baseOpts, isUrgence: false });
  const rUrg = quote({ ...baseOpts, isUrgence: true });
  assert.equal(rNoUrg.details.global_adjust_delta, 20, 'delta should be 20 without urgency');
  assert.equal(rUrg.details.global_adjust_delta, 20, 'delta should be 20 with urgency');
  // Without urgency: 349 + 20 = 369
  assert.equal(rNoUrg.total_ht, 369);
  // With urgency: round(349*1.30)=454, +20=474
  assert.equal(rUrg.total_ht, 474);
});

test('D. urgency isolation: +10% does NOT become +26 because of urgency', () => {
  const rUrg0 = quote({ distance: 167, pack: 'excellence', isUrgence: true, globalAdjustPercent: 0 });
  const rUrg10 = quote({ distance: 167, pack: 'excellence', isUrgence: true, globalAdjustPercent: 10 });
  // Without adjustment: 454. With +10%: 454 + 20 = 474 (not 454 + 26)
  assert.equal(rUrg10.total_ht - rUrg0.total_ht, 20);
});

// =========================================================
// E. GARDIENNAGE ISOLATION
// =========================================================
test('E. gardiennage isolation: global adjustment does not modify flat fee', () => {
  const r0 = quote({ distance: 300, pack: 'serenite', isGardiennage: true, globalAdjustPercent: 0 });
  const r10 = quote({ distance: 300, pack: 'serenite', isGardiennage: true, globalAdjustPercent: 10 });
  // Without adjustment: 429 + 30 = 459
  assert.equal(r0.total_ht, 459);
  // With +10%: transport_delta = round(360*0.10)=36 → 429 + 36 + 30 = 495
  assert.equal(r10.total_ht, 495);
  // Gardiennage flat fee is 30 in both cases
  const garden0 = r0.details.applied_coeffs.find(c => c.label.startsWith('Gardiennage'));
  const garden10 = r10.details.applied_coeffs.find(c => c.label.startsWith('Gardiennage'));
  assert.equal(garden0.value, 30);
  assert.equal(garden10.value, 30);
});

// =========================================================
// F. LONG-DISTANCE REGRESSION
// =========================================================
test('F. 600km excellence g=0 = 782 (historical (base+pack)*0.90)', () => {
  const r = quote({ distance: 600, pack: 'excellence', globalAdjustPercent: 0 });
  assert.equal(r.total_ht, 782);
});

test('F. 600km excellence g=+10 = 847 (782 + round(648*0.10)=65)', () => {
  const r = quote({ distance: 600, pack: 'excellence', globalAdjustPercent: 10 });
  // transport_discounted = round(720*0.90) = 648, delta = round(64.8) = 65
  assert.equal(r.details.global_adjust_delta, 65);
  assert.equal(r.total_ht, 847);
});

test('F. 900km serenite g=0 = 977 (historical (base+pack)*0.85)', () => {
  const r = quote({ distance: 900, pack: 'serenite', globalAdjustPercent: 0 });
  assert.equal(r.total_ht, 977);
});

test('F. 900km serenite g=+10 = 977 + round(round(1080*0.85)*0.10)', () => {
  const r = quote({ distance: 900, pack: 'serenite', globalAdjustPercent: 10 });
  // transport_discounted = round(1080*0.85) = round(918) = 918, delta = round(91.8) = 92
  assert.equal(r.details.global_adjust_delta, 92);
  assert.equal(r.total_ht, 977 + 92);
});

test('F. 500km exactly: discount applies (dist_coeff=0.90)', () => {
  const r = quote({ distance: 500, pack: 'starter', globalAdjustPercent: 0 });
  // base = 600, total = round(600*0.90) = 540
  assert.equal(r.total_ht, 540);
});

test('F. 499km: no discount (dist_coeff=1.0)', () => {
  const r = quote({ distance: 499, pack: 'starter', globalAdjustPercent: 0 });
  // base = round(499*1.20) = 599
  assert.equal(r.total_ht, 599);
});

test('F. 799km: 0.90 discount', () => {
  const r = quote({ distance: 799, pack: 'starter', globalAdjustPercent: 0 });
  // base = round(799*1.20) = 959, round(959*0.90) = 863
  assert.equal(r.total_ht, 863);
});

test('F. 800km: 0.85 discount', () => {
  const r = quote({ distance: 800, pack: 'starter', globalAdjustPercent: 0 });
  // base = 960, round(960*0.85) = 816
  assert.equal(r.total_ht, 816);
});

// =========================================================
// G. SEASONAL REMOVAL
// =========================================================
test('G. seasonal removed: March, June, September produce identical results (starter)', () => {
  const march = quote({ distance: 300, pack: 'starter', dateLivraison: '2026-03-15', globalAdjustPercent: 0 });
  const june = quote({ distance: 300, pack: 'starter', dateLivraison: '2026-06-15', globalAdjustPercent: 0 });
  const sept = quote({ distance: 300, pack: 'starter', dateLivraison: '2026-09-15', globalAdjustPercent: 0 });
  assert.equal(march.total_ht, june.total_ht);
  assert.equal(june.total_ht, sept.total_ht);
  assert.equal(march.total_ht, 360);
  // No seasonal applied_coeff
  assert.ok(!march.details.applied_coeffs.some(c => c.label.includes('saison')));
});

test('G. seasonal removed: March/June/September identical (excellence)', () => {
  const march = quote({ distance: 600, pack: 'excellence', dateLivraison: '2026-03-15', globalAdjustPercent: 0 });
  const june = quote({ distance: 600, pack: 'excellence', dateLivraison: '2026-06-15', globalAdjustPercent: 0 });
  const sept = quote({ distance: 600, pack: 'excellence', dateLivraison: '2026-09-15', globalAdjustPercent: 0 });
  assert.equal(march.total_ht, june.total_ht);
  assert.equal(june.total_ht, sept.total_ht);
  assert.equal(march.total_ht, 782);
});

// =========================================================
// H. BOUNDARIES (global adjustment range)
// =========================================================
test('H. boundary: +50 applied', () => {
  const r = quote({ distance: 300, pack: 'starter', globalAdjustPercent: 50 });
  // delta = round(360*0.50) = 180, total = 360 + 180 = 540
  assert.equal(r.details.global_adjust_percent, 50);
  assert.equal(r.details.global_adjust_delta, 180);
  assert.equal(r.total_ht, 540);
});

test('H. boundary: -50 applied', () => {
  const r = quote({ distance: 300, pack: 'starter', globalAdjustPercent: -50 });
  // delta = round(360*-0.50) = -180, total = 360 - 180 = 180
  assert.equal(r.details.global_adjust_percent, -50);
  assert.equal(r.details.global_adjust_delta, -180);
  assert.equal(r.total_ht, 180);
});

test('H. boundary: +51 clamped to +50', () => {
  const r = quote({ distance: 300, pack: 'starter', globalAdjustPercent: 51 });
  assert.equal(r.details.global_adjust_percent, 50);
  assert.equal(r.details.global_adjust_delta, 180);
});

test('H. boundary: -51 clamped to -50', () => {
  const r = quote({ distance: 300, pack: 'starter', globalAdjustPercent: -51 });
  assert.equal(r.details.global_adjust_percent, -50);
  assert.equal(r.details.global_adjust_delta, -180);
});

test('H. boundary: null → 0', () => {
  const r = quote({ distance: 300, pack: 'starter', globalAdjustPercent: null });
  assert.equal(r.details.global_adjust_percent, 0);
  assert.equal(r.details.global_adjust_delta, 0);
  assert.equal(r.total_ht, 360);
});

test('H. boundary: undefined → 0', () => {
  const r = quote({ distance: 300, pack: 'starter' });
  assert.equal(r.details.global_adjust_percent, 0);
  assert.equal(r.details.global_adjust_delta, 0);
  assert.equal(r.total_ht, 360);
});

test('H. boundary: NaN → 0', () => {
  const r = quote({ distance: 300, pack: 'starter', globalAdjustPercent: NaN });
  assert.equal(r.details.global_adjust_percent, 0);
  assert.equal(r.details.global_adjust_delta, 0);
});

test('H. boundary: non-numeric string → 0', () => {
  const r = quote({ distance: 300, pack: 'starter', globalAdjustPercent: 'abc' });
  assert.equal(r.details.global_adjust_percent, 0);
  assert.equal(r.details.global_adjust_delta, 0);
});

test('H. boundary: numeric string "10" → 10', () => {
  const r = quote({ distance: 300, pack: 'starter', globalAdjustPercent: '10' });
  assert.equal(r.details.global_adjust_percent, 10);
  assert.equal(r.details.global_adjust_delta, 36);
});

// =========================================================
// I. ROUNDING BOUNDARIES
// =========================================================
test('I. rounding: base .5 boundary (499.5km not possible, use 417km → 500.4 → 500)', () => {
  // 417km × 1.20 = 500.4 → round = 500
  const r = quote({ distance: 417, pack: 'starter', globalAdjustPercent: 0 });
  assert.equal(r.details.basePrice, 500);
});

test('I. rounding: 418km × 1.20 = 501.6 → 502', () => {
  const r = quote({ distance: 418, pack: 'starter', globalAdjustPercent: 0 });
  assert.equal(r.details.basePrice, 502);
});

test('I. rounding: long-distance .5 boundary (646km excellence)', () => {
  // base = 775, +149 = 924, ×0.90 = 831.6 → 832
  const r = quote({ distance: 646, pack: 'excellence', globalAdjustPercent: 0 });
  assert.equal(r.total_ht, 832);
});

test('I. rounding: global delta .5 boundary', () => {
  // transport_discounted = 355, g=+10 → 35.5 → round = 36 (JS Math.round rounds .5 up)
  // base = 355 → distance where round(dist*1.20)=355 → 296km × 1.20 = 355.2 → 355
  const r = quote({ distance: 296, pack: 'starter', globalAdjustPercent: 10 });
  assert.equal(r.details.basePrice, 355);
  assert.equal(r.details.global_adjust_delta, 36);
});

test('I. rounding: urgency .5 boundary', () => {
  // 350 base, pack 0, ×1.25 = 437.5 → 438
  const r = quote({ distance: 292, pack: 'starter', isUrgence: true, globalAdjustPercent: 0 });
  // 292 × 1.20 = 350.4 → 350, ×1.30 = 455
  assert.equal(r.details.basePrice, 350);
  assert.equal(r.total_ht, 455);
});

test('I. zero-adjust rounding drift: NONE for all representative cases', () => {
  const cases = [
    { distance: 300, pack: 'starter' },
    { distance: 300, pack: 'serenite' },
    { distance: 300, pack: 'excellence' },
    { distance: 600, pack: 'excellence' },
    { distance: 900, pack: 'serenite' },
    { distance: 50, pack: 'starter' },
    { distance: 200, pack: 'excellence', mode: 'plateau' },
    { distance: 300, type: 'Utilitaire', utilSize: '10', pack: 'serenite' },
    { distance: 300, pack: 'excellence', isUrgence: true },
    { distance: 300, pack: 'serenite', isGardiennage: true },
  ];
  for (const c of cases) {
    const r0 = quote({ ...c, globalAdjustPercent: 0 });
    const rUndef = quote({ ...c });
    assert.equal(r0.total_ht, rUndef.total_ht, `drift for ${JSON.stringify(c)}`);
  }
});

// =========================================================
// J. ESSENTIEL ALIAS
// =========================================================
test('J. essentiel alias → starter', () => {
  assert.equal(normalizePack('essentiel'), 'starter');
  assert.equal(normalizePack('Essentiel'), 'starter');
  assert.equal(normalizePack('ESSENTIEL'), 'starter');
  assert.equal(normalizePack('essentiel '), 'starter');
});

test('J. essentiel alias: quote with pack="essentiel" works', () => {
  const r = quote({ pack: 'essentiel', globalAdjustPercent: 0 });
  assert.equal(r.details.pack, 'starter');
  assert.equal(r.details.packPrice, 0);
  assert.equal(r.total_ht, 360);
});

test('J. starter key still works (backward compat)', () => {
  assert.equal(normalizePack('starter'), 'starter');
  const r = quote({ pack: 'starter', globalAdjustPercent: 0 });
  assert.equal(r.details.pack, 'starter');
});

// =========================================================
// K. SNAPSHOT CONTRACT
// =========================================================
test('K. snapshot: details include global_adjust_percent and global_adjust_delta', () => {
  const r = quote({ distance: 300, pack: 'excellence', globalAdjustPercent: 10 });
  assert.ok('global_adjust_percent' in r.details);
  assert.ok('global_adjust_delta' in r.details);
  assert.equal(r.details.global_adjust_percent, 10);
  // base=360, dist_coeff=1.0, transport_discounted=360, delta=round(360*0.10)=36
  assert.equal(r.details.global_adjust_delta, 36);
});

test('K. snapshot: applied_coeffs includes global adjustment entry when non-zero', () => {
  const r = quote({ distance: 300, pack: 'excellence', globalAdjustPercent: 10 });
  const entry = r.details.applied_coeffs.find(c => c.label.includes('Ajustement global'));
  assert.ok(entry, 'should have global adjustment applied_coeff');
  assert.equal(entry.value, 0.10);
  assert.equal(entry.delta, 36);
});

test('K. snapshot: no global adjustment applied_coeff when zero', () => {
  const r = quote({ distance: 300, pack: 'excellence', globalAdjustPercent: 0 });
  const entry = r.details.applied_coeffs.find(c => c.label.includes('Ajustement global'));
  assert.equal(entry, undefined);
});

test('K. snapshot: details include packPrice', () => {
  const r = quote({ distance: 300, pack: 'excellence', globalAdjustPercent: 0 });
  assert.equal(r.details.packPrice, 149);
});

test('K. snapshot: B2B details show global_adjust_percent=0', () => {
  const r = quote({ distance: 300, pack: 'excellence', isPro: true, globalAdjustPercent: 50 });
  assert.equal(r.details.global_adjust_percent, 0);
  assert.equal(r.details.global_adjust_delta, 0);
});

// =========================================================
// L. B2C BASE RATE
// =========================================================
test('L. B2C base rate: Automobile route = 1.20', () => {
  const r = quote({ distance: 100, pack: 'starter', globalAdjustPercent: 0 });
  // 100 × 1.20 = 120, but min is 150
  assert.equal(r.details.basePrice, 150);
  // 200km to avoid minimum
  const r2 = quote({ distance: 200, pack: 'starter', globalAdjustPercent: 0 });
  assert.equal(r2.details.basePrice, 240); // 200 × 1.20
});

test('L. B2C base rate: Moto route = 1.00', () => {
  const r = quote({ distance: 200, type: 'Moto', pack: 'starter', globalAdjustPercent: 0 });
  assert.equal(r.details.basePrice, 200); // 200 × 1.00
});

test('L. B2C base rate: Utilitaire route = 1.40', () => {
  const r = quote({ distance: 200, type: 'Utilitaire', pack: 'starter', globalAdjustPercent: 0 });
  assert.equal(r.details.basePrice, 280); // 200 × 1.40
});

test('L. B2C base rate: Luxe route = 1.80', () => {
  const r = quote({ distance: 200, type: 'Luxe', pack: 'starter', globalAdjustPercent: 0 });
  assert.equal(r.details.basePrice, 360); // 200 × 1.80
});
