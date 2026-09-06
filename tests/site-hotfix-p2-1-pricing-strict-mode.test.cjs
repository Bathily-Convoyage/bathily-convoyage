/**
 * SITE-HOTFIX-P2-1 — pricing.js strict-mode ReferenceError regression test.
 *
 * Verifies that BathilyPricing.calculate() executes without ReferenceError
 * in strict mode, returning correct numeric results for:
 *   - Automobile route (base minimum applied)
 *   - Moto route
 *   - Automobile plateau mode
 *   - Long-distance coefficient (800km+)
 *   - Utilitaire route
 *
 * Context:
 *   public/js/pricing.js wraps everything in (function(){ 'use strict'; ... })().
 *   Previously, calculate() assigned to `prix` and referenced `min` without
 *   declaring them. In strict mode this throws ReferenceError, breaking the
 *   dashboard-admin "Créer un devis personnalisé" auto-price preview.
 *
 * The public /devis page is NOT affected (uses its own inline calculatePrice)
 * and must remain unchanged.
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');

const repoRoot = path.resolve(__dirname, '..');
const pricingPath = path.join(repoRoot, 'public', 'js', 'pricing.js');
const pricingSrc = fs.readFileSync(pricingPath, 'utf8');

// Fixed date with no seasonal/weekend/night coefficients:
//   Wednesday March 18, 2026 at 10:00 local time
//   month=2 (not 5-8), day=3 (not 0/6), hour=10 (not >=22 or <6)
const NEUTRAL_DATE = '2026-03-18T10:00';

// =========================================================
// Helper: load pricing.js into a fake window context
// =========================================================
function loadPricing() {
  const window = {};
  // pricing.js is an IIFE that assigns to window.BathilyPricing
  // eslint-disable-next-line no-eval
  eval(pricingSrc);
  return window;
}

// =========================================================
// Static source checks
// =========================================================
test('pricing.js uses strict mode', () => {
  assert.ok(pricingSrc.includes("'use strict'"), "pricing.js must contain 'use strict'");
});

test('pricing.js declares prix with var inside calculate', () => {
  // Must find "var prix" inside the calculate function — not just "prix ="
  const calcMatch = pricingSrc.match(/function calculate[\s\S]*?\n  \}/);
  assert.ok(calcMatch, 'calculate function not found');
  const calcBody = calcMatch[0];
  assert.ok(
    /var\s+prix\s*=/.test(calcBody),
    'calculate() must declare prix with var — otherwise strict mode throws ReferenceError',
  );
});

test('pricing.js declares min with var inside calculate', () => {
  const calcMatch = pricingSrc.match(/function calculate[\s\S]*?\n  \}/);
  assert.ok(calcMatch, 'calculate function not found');
  const calcBody = calcMatch[0];
  assert.ok(
    /var\s+min\s*=/.test(calcBody),
    'calculate() must declare min with var — otherwise strict mode throws ReferenceError',
  );
});

// =========================================================
// Runtime: calculate() does not throw ReferenceError
// =========================================================
test('calculate() does not throw ReferenceError for Automobile 100km route', () => {
  const window = loadPricing();
  const result = window.BathilyPricing.calculate({
    vehType: 'Automobile',
    distance: 100,
    mode: 'route',
    date: NEUTRAL_DATE,
  });
  assert.equal(typeof result.prix, 'number');
  assert.equal(typeof result.prixTTC, 'number');
  assert.equal(typeof result.min, 'number');
  // 100km * 1.00/km = 100, min=120 → max(100,120) = 120
  assert.equal(result.prix, 120);
  assert.equal(result.prixTTC, 144);
  assert.equal(result.min, 120);
  assert.equal(result.details.length, 0);
});

test('calculate() for Moto 200km route', () => {
  const window = loadPricing();
  const result = window.BathilyPricing.calculate({
    vehType: 'Moto',
    distance: 200,
    mode: 'route',
    date: NEUTRAL_DATE,
  });
  // 200km * 0.85/km = 170, min=100 → max(170,100) = 170
  assert.equal(result.prix, 170);
  assert.equal(result.min, 100);
  assert.equal(typeof result.prixTTC, 'number');
});

test('calculate() for Automobile 100km plateau mode', () => {
  const window = loadPricing();
  const result = window.BathilyPricing.calculate({
    vehType: 'Automobile',
    distance: 100,
    mode: 'plateau',
    date: NEUTRAL_DATE,
  });
  // Route base: max(100*1.00, 120) = 120
  // Plateau adds: max(350 + 100*0.45, 350) = max(395, 350) = 395
  // Total: 120 + 395 = 515
  assert.equal(result.prix, 515);
  assert.equal(result.baseRate, 350); // plateau_base
  assert.equal(typeof result.prixTTC, 'number');
});

test('calculate() for Automobile 800km route (long-distance coefficient)', () => {
  const window = loadPricing();
  const result = window.BathilyPricing.calculate({
    vehType: 'Automobile',
    distance: 800,
    mode: 'route',
    date: NEUTRAL_DATE,
  });
  // 800km * 1.00/km = 800, min=120 → max(800,120) = 800
  // Long distance -15%: 800 * 0.85 = 680
  assert.equal(result.prix, 680);
  assert.ok(result.details.length >= 1, 'should have at least 1 detail (long distance)');
  assert.ok(
    result.details.some((d) => d.label.includes('longue distance')),
    'should include long-distance discount detail',
  );
});

test('calculate() for Utilitaire 300km route', () => {
  const window = loadPricing();
  const result = window.BathilyPricing.calculate({
    vehType: 'Utilitaire',
    distance: 300,
    mode: 'route',
    date: NEUTRAL_DATE,
  });
  // 300km * 1.10/km = 330, min=150 → max(330,150) = 330
  assert.equal(result.prix, 330);
  assert.equal(result.min, 150);
});

test('calculate() returns object with all expected properties', () => {
  const window = loadPricing();
  const result = window.BathilyPricing.calculate({
    vehType: 'Automobile',
    distance: 100,
    mode: 'route',
    date: NEUTRAL_DATE,
  });
  assert.ok('prix' in result, 'result must have prix');
  assert.ok('prixTTC' in result, 'result must have prixTTC');
  assert.ok('distance' in result, 'result must have distance');
  assert.ok('mode' in result, 'result must have mode');
  assert.ok('vehType' in result, 'result must have vehType');
  assert.ok('baseRate' in result, 'result must have baseRate');
  assert.ok('details' in result, 'result must have details');
  assert.ok('min' in result, 'result must have min');
});

test('BathilyPricing exports calculate, formatResult, BASE_RATES, COEFFS', () => {
  const window = loadPricing();
  assert.equal(typeof window.BathilyPricing.calculate, 'function');
  assert.equal(typeof window.BathilyPricing.formatResult, 'function');
  assert.equal(typeof window.BathilyPricing.BASE_RATES, 'object');
  assert.equal(typeof window.BathilyPricing.COEFFS, 'object');
});

// =========================================================
// dashboard-admin linkage: recalc() calls calculate() and uses result.prix
// =========================================================
test('dashboard-admin.html calls BathilyPricing.calculate() in recalc()', () => {
  const adminPath = path.join(repoRoot, 'dashboard-admin.html');
  const adminSrc = fs.readFileSync(adminPath, 'utf8');
  assert.ok(
    adminSrc.includes('BathilyPricing.calculate'),
    'dashboard-admin.html must call BathilyPricing.calculate() for auto-price preview',
  );
  assert.ok(
    adminSrc.includes('result.prix'),
    'dashboard-admin.html must use result.prix from calculate() to populate auto-price field',
  );
});

// =========================================================
// /devis must NOT call BathilyPricing.calculate (own inline logic)
// =========================================================
test('devis.html does NOT call BathilyPricing.calculate()', () => {
  const devisPath = path.join(repoRoot, 'devis.html');
  const devisSrc = fs.readFileSync(devisPath, 'utf8');
  assert.ok(
    !devisSrc.includes('BathilyPricing.calculate'),
    'devis.html must not call BathilyPricing.calculate() — it has its own inline calculatePrice()',
  );
  // devis.html may still reference BathilyPricing.COEFFS — that's fine
  assert.ok(
    devisSrc.includes('function calculatePrice'),
    'devis.html must have its own calculatePrice() function',
  );
});
