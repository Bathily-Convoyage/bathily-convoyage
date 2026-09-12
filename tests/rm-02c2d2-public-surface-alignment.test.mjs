/**
 * RM-02C2D2 — Public surface commercial alignment tests.
 *
 * Verifies:
 *   A. every convoyage-*.html has no stale Starter pack label
 *   B. every convoyage-*.html has no +49 stale pack price
 *   C. every convoyage-*.html has no +129 stale pack price
 *   D. every convoyage-*.html has no +159 stale pack price
 *   E. every relevant B2C pack surface uses 0 / 69 / 149
 *   F. approved fuel wording present where Excellence copy exposes fuel
 *   G. forbidden B2C claims absent
 *   H. pack links use canonical query params where present
 *   I. no BathilyPricing/local pricing added
 *   J. espace-pro B2B prices match backend constants
 *   K. stale B2B 35/99 removed
 *   L. unapproved numeric option prices removed from espace-pro
 *   M. no B2C/B2B cross-contamination
 *   N. charte files untouched
 *   O. backend pricing files untouched
 *   P. homepage D1/D1A pack content unchanged
 *   Q. devis authoritative flow unchanged
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');

// Read all convoyage-*.html files
const convoyageFiles = fs.readdirSync(repoRoot)
  .filter(f => /^convoyage-.*\.html$/.test(f))
  .map(f => ({ name: f, path: path.join(repoRoot, f), src: fs.readFileSync(path.join(repoRoot, f), 'utf8') }));

const indexPath = path.join(repoRoot, 'index.html');
const indexSrc = fs.readFileSync(indexPath, 'utf8');
const devisPath = path.join(repoRoot, 'devis.html');
const devisSrc = fs.readFileSync(devisPath, 'utf8');
const pricingPath = path.join(repoRoot, 'functions', '_pricing.js');
const pricingSrc = fs.readFileSync(pricingPath, 'utf8');
const espaceProPath = path.join(repoRoot, 'espace-pro.html');
const espaceProSrc = fs.readFileSync(espaceProPath, 'utf8');

// =========================================================
// A. every convoyage-*.html has no stale Starter pack label
// =========================================================
test('A. no convoyage page contains "Formule Starter"', () => {
  for (const f of convoyageFiles) {
    assert.ok(!f.src.includes('Formule Starter'),
      `${f.name} must not contain "Formule Starter"`);
  }
});

// =========================================================
// B. every convoyage-*.html has no +49 stale pack price
// =========================================================
test('B. no convoyage page contains +49€ stale pack price', () => {
  for (const f of convoyageFiles) {
    assert.ok(!f.src.includes('+49€'),
      `${f.name} must not contain "+49€" stale pack price`);
  }
});

// =========================================================
// C. every convoyage-*.html has no +129 stale pack price
// =========================================================
test('C. no convoyage page contains +129€ stale pack price', () => {
  for (const f of convoyageFiles) {
    assert.ok(!f.src.includes('+129€'),
      `${f.name} must not contain "+129€" stale pack price`);
  }
});

// =========================================================
// D. every convoyage-*.html has no +159 stale pack price
// =========================================================
test('D. no convoyage page contains +159€ stale pack price', () => {
  for (const f of convoyageFiles) {
    assert.ok(!f.src.includes('+159€'),
      `${f.name} must not contain "+159€" stale pack price`);
  }
});

// =========================================================
// E. every relevant B2C pack surface uses 0 / 69 / 149
// =========================================================
test('E. convoyage pages use approved B2C pack prices (0/69/149)', () => {
  for (const f of convoyageFiles) {
    // Must have Essentiel (0/included)
    assert.ok(f.src.includes('Essentiel'),
      `${f.name} must contain "Essentiel"`);
    // Must have +69€ for Sérénité
    assert.ok(f.src.includes('+69€'),
      `${f.name} must contain "+69€" for Sérénité`);
    // Must have +149€ for Excellence
    assert.ok(f.src.includes('+149€'),
      `${f.name} must contain "+149€" for Excellence`);
  }
});

// =========================================================
// F. approved fuel wording present where Excellence copy exposes fuel
// =========================================================
test('F. approved fuel wording present in convoyage pages', () => {
  for (const f of convoyageFiles) {
    // Excellence description should reference carburant facturé au réel
    assert.ok(f.src.includes('carburant sur demande facturé au réel'),
      `${f.name} must contain approved fuel wording "carburant sur demande facturé au réel"`);
  }
});

// =========================================================
// G. forbidden B2C claims absent
// =========================================================
test('G. no forbidden B2C claims in convoyage pages', () => {
  for (const f of convoyageFiles) {
    assert.ok(!/support VIP/i.test(f.src),
      `${f.name} must not contain "support VIP"`);
    assert.ok(!/Plein de carburant offert/i.test(f.src),
      `${f.name} must not contain "Plein de carburant offert"`);
    assert.ok(!/priorité d'affectation/i.test(f.src),
      `${f.name} must not contain "priorité d'affectation"`);
    assert.ok(!/photos pro 4k/i.test(f.src),
      `${f.name} must not contain "Photos pro 4K"`);
    assert.ok(!/livraison dim/i.test(f.src),
      `${f.name} must not contain "Livraison dim"`);
    assert.ok(!/plein de carburant/i.test(f.src),
      `${f.name} must not contain "Plein de carburant" as included/free`);
  }
});

// =========================================================
// H. pack links use canonical query params where present
// =========================================================
test('H. convoyage pages with pack links use canonical query params', () => {
  for (const f of convoyageFiles) {
    // If the page links to devis.html?pack=, must use canonical values
    const packLinks = f.src.match(/devis\.html\?pack=(\w+)/g) || [];
    for (const link of packLinks) {
      const pack = link.match(/pack=(\w+)/)[1];
      assert.ok(['starter', 'serenite', 'excellence', 'essentiel'].includes(pack),
        `${f.name} has non-canonical pack link: ${link}`);
    }
  }
});

// =========================================================
// I. no BathilyPricing/local pricing added
// =========================================================
test('I. no BathilyPricing or local pricing added to convoyage pages', () => {
  for (const f of convoyageFiles) {
    assert.ok(!f.src.includes('BathilyPricing'),
      `${f.name} must not reference BathilyPricing`);
    // No local pack price tables
    assert.ok(!/packPrices.*serenite.*69/.test(f.src),
      `${f.name} must not contain local packPrices table`);
  }
});

// =========================================================
// J. espace-pro B2B prices match backend constants
// =========================================================
test('J. espace-pro B2B prices match backend constants', () => {
  // Backend: PACK_PRICES_PRO = { starter: 0, serenite: 55, excellence: 125 }
  assert.ok(espaceProSrc.includes('+55€'),
    'espace-pro.html must show Sérénité +55€ (backend B2B price)');
  assert.ok(espaceProSrc.includes('+125€'),
    'espace-pro.html must show Excellence +125€ (backend B2B price)');
  // Must NOT show B2C prices
  assert.ok(!espaceProSrc.includes('+69€'),
    'espace-pro.html must not show B2C Sérénité price +69€');
  assert.ok(!espaceProSrc.includes('+149€'),
    'espace-pro.html must not show B2C Excellence price +149€');
});

// =========================================================
// K. stale B2B 35/99 removed
// =========================================================
test('K. stale B2B 35/99 removed from espace-pro', () => {
  assert.ok(!espaceProSrc.includes('+35€'),
    'espace-pro.html must not contain stale B2B +35€');
  assert.ok(!espaceProSrc.includes('+99€'),
    'espace-pro.html must not contain stale B2B +99€');
});

// =========================================================
// L. unapproved numeric option prices removed from espace-pro
// =========================================================
test('L. unapproved numeric option prices removed from espace-pro', () => {
  // These unapproved option prices must be gone
  assert.ok(!espaceProSrc.includes('+29€'),
    'espace-pro.html must not contain unapproved +29€ option price');
  assert.ok(!espaceProSrc.includes('+50€'),
    'espace-pro.html must not contain unapproved +50€ option price');
  assert.ok(!espaceProSrc.includes('+39€'),
    'espace-pro.html must not contain unapproved +39€ option price');
  assert.ok(!espaceProSrc.includes('+49€'),
    'espace-pro.html must not contain unapproved +49€ option price');
  assert.ok(!espaceProSrc.includes('+59€'),
    'espace-pro.html must not contain unapproved +59€ option price');
  // Forbidden claims must be gone
  assert.ok(!/support VIP/i.test(espaceProSrc),
    'espace-pro.html must not contain "support VIP"');
  assert.ok(!/Plein de carburant/i.test(espaceProSrc),
    'espace-pro.html must not contain "Plein de carburant" claim');
  assert.ok(!/Plein offert/i.test(espaceProSrc),
    'espace-pro.html must not contain "Plein offert" claim');
  assert.ok(!/photos pro 4k/i.test(espaceProSrc),
    'espace-pro.html must not contain "Photos pro 4K" claim');
  assert.ok(!/Livraison dimanche/i.test(espaceProSrc),
    'espace-pro.html must not contain "Livraison dimanche" claim');
  // UNAPPROVED_B2B_CLAIM: Lavage avant livraison and Nettoyage intérieur détaillé
  // have no backend-authoritative source as standalone B2B options
  assert.ok(!espaceProSrc.includes('Lavage avant livraison'),
    'espace-pro.html must not contain unapproved "Lavage avant livraison" B2B claim');
  assert.ok(!espaceProSrc.includes('Nettoyage intérieur détaillé'),
    'espace-pro.html must not contain unapproved "Nettoyage intérieur détaillé" B2B claim');
  assert.ok(!espaceProSrc.includes('Services premium additionnels'),
    'espace-pro.html must not contain orphan "Services premium additionnels" heading');
});

// =========================================================
// L2. backend-authoritative B2B options retained
// =========================================================
test('L2. backend-authoritative B2B options retained in espace-pro', () => {
  // Urgence (+25%) — authority: COEFFS.urgence_pro = 1.25
  assert.ok(espaceProSrc.includes('Urgence (+25%)'),
    'espace-pro.html must retain "Urgence (+25%)" (backend COEFFS.urgence_pro = 1.25)');
  // Gardiennage (+20€) — authority: COEFFS.gardiennage_pro = 20
  assert.ok(espaceProSrc.includes('Gardiennage (+20€)'),
    'espace-pro.html must retain "Gardiennage (+20€)" (backend COEFFS.gardiennage_pro = 20)');
  // B2B pack prices must be present
  assert.ok(espaceProSrc.includes('Pack Sérénité (+55€)'),
    'espace-pro.html must retain "Pack Sérénité (+55€)" (backend PACK_PRICES_PRO.serenite = 55)');
  assert.ok(espaceProSrc.includes('Pack Excellence (+125€)'),
    'espace-pro.html must retain "Pack Excellence (+125€)" (backend PACK_PRICES_PRO.excellence = 125)');
});

// =========================================================
// M. no B2C/B2B cross-contamination
// =========================================================
test('M. no B2C/B2B cross-contamination', () => {
  // B2C pages must not show B2B prices
  for (const f of convoyageFiles) {
    assert.ok(!f.src.includes('+55€'),
      `${f.name} (B2C) must not contain B2B Sérénité price +55€`);
    assert.ok(!f.src.includes('+125€'),
      `${f.name} (B2C) must not contain B2B Excellence price +125€`);
  }
  // B2B page must not show B2C prices
  assert.ok(!espaceProSrc.includes('+69€'),
    'espace-pro.html (B2B) must not contain B2C Sérénité price +69€');
  assert.ok(!espaceProSrc.includes('+149€'),
    'espace-pro.html (B2B) must not contain B2C Excellence price +149€');
});

// =========================================================
// N. charte files untouched
// =========================================================
test('N. charte files untouched', () => {
  const chartePath = path.join(repoRoot, 'charte-graphique-complete.html');
  const charteSrc = fs.readFileSync(chartePath, 'utf8');
  // Must still contain key charter elements
  assert.ok(charteSrc.includes('Bathily-Convoyage'),
    'charte must still contain brand name');
  assert.ok(charteSrc.includes('#0A4D68'),
    'charte must still contain primary color');
  assert.ok(charteSrc.includes('Montserrat'),
    'charte must still contain Montserrat reference');
});

// =========================================================
// O. backend pricing files untouched
// =========================================================
test('O. backend pricing files untouched', () => {
  assert.ok(pricingSrc.includes('PACK_PRICES_PUBLIC = { starter: 0, serenite: 69, excellence: 149 }'),
    'backend PACK_PRICES_PUBLIC must be unchanged');
  assert.ok(pricingSrc.includes('PACK_PRICES_PRO = { starter: 0, serenite: 55, excellence: 125 }'),
    'backend PACK_PRICES_PRO must be unchanged');
  assert.ok(pricingSrc.includes("CANONICAL_PACKS = ['starter', 'serenite', 'excellence']"),
    'backend CANONICAL_PACKS must be unchanged');
});

// =========================================================
// P. homepage D1/D1A pack content unchanged
// =========================================================
test('P. homepage D1/D1A pack content unchanged', () => {
  assert.ok(indexSrc.includes('Essentiel'),
    'homepage must still contain "Essentiel"');
  assert.ok(indexSrc.includes('+69€'),
    'homepage must still contain "+69€"');
  assert.ok(indexSrc.includes('+149€'),
    'homepage must still contain "+149€"');
  assert.ok(indexSrc.includes('LE PLUS CHOISI'),
    'homepage must still contain "LE PLUS CHOISI" badge');
  assert.ok(indexSrc.includes('Plein ou complément de carburant sur demande'),
    'homepage must still contain approved fuel wording');
  assert.ok(indexSrc.includes('hp-pack-grid'),
    'homepage must still contain .hp-pack-grid class (D1A responsive fix)');
  assert.ok(!indexSrc.includes('Formule Starter'),
    'homepage must not contain "Formule Starter"');
});

// =========================================================
// Q. devis authoritative flow unchanged
// =========================================================
test('Q. devis authoritative flow unchanged', () => {
  assert.ok(/urlParams\.get\(['"]pack['"]\)/.test(devisSrc),
    'devis.html must still read ?pack= from URLSearchParams');
  assert.ok(/\/api\/calculate-quote/.test(devisSrc),
    'devis.html must still call /api/calculate-quote');
  assert.ok(!devisSrc.includes('BathilyPricing'),
    'devis.html must not reference BathilyPricing');
});

// =========================================================
// R. convoyage page count
// =========================================================
test('R. convoyage page count is 39', () => {
  assert.equal(convoyageFiles.length, 39,
    `expected 39 convoyage pages, found ${convoyageFiles.length}`);
});

// =========================================================
// S. misleading alt text corrected
// =========================================================
test('S. no misleading city-specific alt text in convoyage pages', () => {
  for (const f of convoyageFiles) {
    // Extract all alt text
    const altTexts = f.src.match(/alt="([^"]*)"/g) || [];
    for (const alt of altTexts) {
      // Skip logo alt
      if (alt.includes('Bathily-Convoyage')) continue;
      // Skip generic alts
      if (alt.includes('partout en France')) continue;
      if (alt.includes('longue distance')) continue;
      if (alt.includes('Convoyage Luxe')) continue;
      if (alt.includes('Convoyage Utilitaire')) continue;
      if (alt.includes('Convoyage Électrique') || alt.includes('Service Convoyage Électrique')) continue;
      if (alt.includes('en France')) continue;
      // Any remaining alt with a city name is suspicious
      // Check for common French city names
      const cities = ['Montpellier', 'Lyon', 'Paris', 'Bordeaux', 'Toulouse',
        'Marseille', 'Lille', 'Nantes', 'Nice', 'Rennes', 'Strasbourg',
        'Amiens', 'Angers', 'Annecy', 'Besançon', 'Caen', 'Clermont',
        'Dijon', 'Grenoble', 'Le Havre', 'Limoges', 'Metz', 'Nancy',
        'Nîmes', 'Orléans', 'Perpignan', 'Reims', 'Rouen', 'Saint-Étienne',
        'Toulon', 'Tours'];
      for (const city of cities) {
        assert.ok(!alt.includes(city),
          `${f.name} must not contain city-specific alt text: ${alt} (found ${city})`);
      }
    }
  }
});
