/**
 * RM-02C2D1A — Pack cards responsive hotfix tests.
 *
 * Verifies:
 *   A. desktop pack grid remains 3 columns
 *   B. responsive breakpoint exists
 *   C. mobile grid becomes 1 column
 *   D. no horizontal overflow rule regression
 *   E. semantic anchors remain
 *   F. Essentiel remains visible
 *   G. Sérénité +69 remains
 *   H. Excellence +149 remains
 *   I. "LE PLUS CHOISI" remains
 *   J. approved fuel wording remains
 *   K. no forbidden claims reintroduced
 *   L. no pricing JS added
 *   M. no backend files changed
 *   N. design-system colors not overridden arbitrarily
 *   O. Montserrat/Inter usage preserved
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');
const indexPath = path.join(repoRoot, 'index.html');
const indexSrc = fs.readFileSync(indexPath, 'utf8');
const pricingPath = path.join(repoRoot, 'functions', '_pricing.js');
const pricingSrc = fs.readFileSync(pricingPath, 'utf8');

// =========================================================
// A. desktop pack grid remains 3 columns
// =========================================================
test('A. desktop pack grid remains 3 columns', () => {
  // The .hp-pack-grid class must define repeat(3, 1fr) for desktop
  assert.ok(/\.hp-pack-grid\s*\{[^}]*grid-template-columns:\s*repeat\(3,\s*1fr\)/.test(indexSrc),
    '.hp-pack-grid must use repeat(3, 1fr) for desktop layout');
});

// =========================================================
// B. responsive breakpoint exists
// =========================================================
test('B. responsive breakpoint exists for pack grid', () => {
  // Must have a @media rule targeting .hp-pack-grid within the pack cards style block
  const styleMatch = indexSrc.match(/Packs de service[\s\S]*?<style>([\s\S]*?)<\/style>/);
  assert.ok(styleMatch, 'pack cards <style> block must exist');
  const styleContent = styleMatch[1];
  assert.ok(/@media\s*\(\s*max-width:\s*768px\s*\)/.test(styleContent),
    'pack cards style must have @media (max-width: 768px) rule');
  assert.ok(/\.hp-pack-grid/.test(styleContent),
    'pack cards style must reference .hp-pack-grid');
});

// =========================================================
// C. mobile grid becomes 1 column
// =========================================================
test('C. mobile grid becomes 1 column at breakpoint', () => {
  // Extract the pack cards style block first, then find the media query within it
  const styleMatch = indexSrc.match(/Packs de service[\s\S]*?<style>([\s\S]*?)<\/style>/);
  assert.ok(styleMatch, 'pack cards <style> block must exist');
  const styleContent = styleMatch[1];
  const mediaMatch = styleContent.match(/@media\s*\(\s*max-width:\s*768px\s*\)\s*\{([\s\S]*?)\}/);
  assert.ok(mediaMatch, 'pack cards style must have @media (max-width: 768px) block');
  const mediaBlock = mediaMatch[1];
  assert.ok(/\.hp-pack-grid\s*\{[^}]*grid-template-columns:\s*1fr/.test(mediaBlock),
    '.hp-pack-grid must collapse to 1fr in mobile media query');
});

// =========================================================
// D. no horizontal overflow rule regression
// =========================================================
test('D. no horizontal overflow rule regression', () => {
  // The pack grid must not cause horizontal overflow
  // max-width: 900px and margin: 0 auto ensure it stays within container
  assert.ok(/\.hp-pack-grid\s*\{[^}]*max-width:\s*900px/.test(indexSrc),
    '.hp-pack-grid must have max-width to prevent overflow');
  assert.ok(/\.hp-pack-grid\s*\{[^}]*margin:\s*0\s+auto/.test(indexSrc),
    '.hp-pack-grid must have margin: 0 auto for centering');
});

// =========================================================
// E. semantic anchors remain
// =========================================================
test('E. semantic anchors remain for pack cards', () => {
  assert.ok(/<a\s+href="devis\.html\?pack=starter"/.test(indexSrc),
    'homepage must use <a href> for Essentiel card');
  assert.ok(/<a\s+href="devis\.html\?pack=serenite"/.test(indexSrc),
    'homepage must use <a href> for Sérénité card');
  assert.ok(/<a\s+href="devis\.html\?pack=excellence"/.test(indexSrc),
    'homepage must use <a href> for Excellence card');
  assert.ok(!/onclick="window\.location\.href='devis\.html\?pack=/.test(indexSrc),
    'homepage must not use inline onclick for pack card navigation');
});

// =========================================================
// F. Essentiel remains visible
// =========================================================
test('F. Essentiel remains visible', () => {
  assert.ok(indexSrc.includes('Essentiel'),
    'homepage must contain "Essentiel"');
  assert.ok(!indexSrc.includes('Formule Starter'),
    'homepage must not contain "Formule Starter"');
});

// =========================================================
// G. Sérénité +69 remains
// =========================================================
test('G. Sérénité +69 remains', () => {
  assert.ok(indexSrc.includes('Pack Sérénité'),
    'homepage must contain "Pack Sérénité"');
  assert.ok(indexSrc.includes('+69€'),
    'homepage must contain "+69€"');
});

// =========================================================
// H. Excellence +149 remains
// =========================================================
test('H. Excellence +149 remains', () => {
  assert.ok(indexSrc.includes('Pack Excellence'),
    'homepage must contain "Pack Excellence"');
  assert.ok(indexSrc.includes('+149€'),
    'homepage must contain "+149€"');
});

// =========================================================
// I. "LE PLUS CHOISI" remains
// =========================================================
test('I. "LE PLUS CHOISI" badge remains', () => {
  assert.ok(indexSrc.includes('LE PLUS CHOISI'),
    'homepage must contain "LE PLUS CHOISI" badge');
});

// =========================================================
// J. approved fuel wording remains
// =========================================================
test('J. approved fuel wording remains', () => {
  assert.ok(indexSrc.includes('Plein ou complément de carburant sur demande'),
    'homepage must contain approved fuel phrase start');
  assert.ok(indexSrc.includes('carburant facturé au réel'),
    'homepage must contain "carburant facturé au réel"');
});

// =========================================================
// K. no forbidden claims reintroduced
// =========================================================
test('K. no forbidden claims reintroduced', () => {
  assert.ok(!indexSrc.includes('+159€'),
    'homepage must not contain stale +159€');
  assert.ok(!/photos pro 4k/i.test(indexSrc),
    'homepage must not contain "Photos pro 4K"');
  assert.ok(!/livraison dim/i.test(indexSrc),
    'homepage must not contain "Livraison dim./férié"');
  assert.ok(!/plein de carburant/i.test(indexSrc),
    'homepage must not contain "Plein de carburant" as included/free');
  assert.ok(!/Priorité d.affectation/i.test(indexSrc),
    'homepage must not contain "Priorité d\'affectation"');
  assert.ok(!/Support VIP/i.test(indexSrc),
    'homepage must not contain "Support VIP"');
});

// =========================================================
// L. no pricing JS added
// =========================================================
test('L. no pricing JS added to index.html', () => {
  // The responsive fix is CSS-only, no JS should be added
  // Check that no new <script> block was added near the pack cards
  const packSectionMatch = indexSrc.match(/Packs de service[\s\S]*?<\/style>/);
  assert.ok(packSectionMatch, 'pack cards style section must exist');
  const packSection = packSectionMatch[0];
  assert.ok(!/<script/i.test(packSection),
    'pack cards section must not contain <script> tags');
  assert.ok(!/BathilyPricing/i.test(indexSrc),
    'index.html must not reference BathilyPricing');
});

// =========================================================
// M. no backend files changed
// =========================================================
test('M. no backend pricing changes', () => {
  assert.ok(pricingSrc.includes('PACK_PRICES_PUBLIC = { starter: 0, serenite: 69, excellence: 149 }'),
    'backend PACK_PRICES_PUBLIC must be unchanged');
  assert.ok(pricingSrc.includes("CANONICAL_PACKS = ['starter', 'serenite', 'excellence']"),
    'backend CANONICAL_PACKS must be unchanged');
});

// =========================================================
// N. design-system colors not overridden arbitrarily
// =========================================================
test('N. pack grid uses existing design-system tokens (no arbitrary colors)', () => {
  // The .hp-pack-grid rule must not introduce new colors
  const gridRuleMatch = indexSrc.match(/\.hp-pack-grid\s*\{([^}]*)\}/);
  assert.ok(gridRuleMatch, '.hp-pack-grid rule must exist');
  const gridRule = gridRuleMatch[1];
  // Must not contain hardcoded hex colors (should use tokens)
  assert.ok(!/#[0-9a-fA-F]{3,8}/.test(gridRule),
    '.hp-pack-grid must not use hardcoded hex colors');
});

// =========================================================
// O. Montserrat/Inter usage preserved
// =========================================================
test('O. Montserrat/Inter typography preserved in pack cards', () => {
  // Pack card titles must still use Montserrat
  assert.ok(/font-family:\s*'Montserrat'/.test(indexSrc),
    'pack cards must still use Montserrat for titles');
  // The responsive fix must not remove font-family declarations
  const packSectionMatch = indexSrc.match(/Packs de service[\s\S]*?<\/div>\s*<\/div>\s*<\/section>/);
  if (packSectionMatch) {
    const packSection = packSectionMatch[0];
    assert.ok(/Montserrat/.test(packSection),
      'pack cards section must reference Montserrat');
  }
});

// =========================================================
// P. inline grid style removed (moved to class)
// =========================================================
test('P. pack grid inline style removed (moved to CSS class)', () => {
  // The old inline style must be gone
  assert.ok(!/style="display:\s*grid;\s*grid-template-columns:\s*repeat\(3,\s*1fr\)/.test(indexSrc),
    'old inline grid style must be removed (moved to .hp-pack-grid class)');
  // The new class must be present
  assert.ok(/class="hp-pack-grid"/.test(indexSrc),
    'pack grid div must use class="hp-pack-grid"');
});

// =========================================================
// Q. no nested interactive elements (regression check)
// =========================================================
test('Q. no nested interactive elements inside pack card <a> tags', () => {
  const cardRegex = /<a\s+href="devis\.html\?pack=(starter|serenite|excellence)"[\s\S]*?<\/a>/g;
  const cards = indexSrc.match(cardRegex) || [];
  assert.ok(cards.length === 3, `expected 3 pack card <a> elements, found ${cards.length}`);
  for (const card of cards) {
    const openTagEnd = card.indexOf('>');
    const inner = card.slice(openTagEnd + 1, -4);
    assert.ok(!/<a\s/i.test(inner), 'pack card <a> must not contain nested <a> elements');
    assert.ok(!/<button/i.test(inner),
      'pack card <a> must not contain nested <button> elements');
  }
});
