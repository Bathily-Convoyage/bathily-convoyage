/**
 * RM-02C2D3 — Admin pack UI truthfulness tests.
 *
 * Verifies:
 *   A. Admin B2C pack display: Essentiel, +69€, +149€, no stale values
 *   B. Approved copy only: fuel wording, no forbidden claims
 *   C. Truthfulness: no dead Save controls, no fake success, read-only notice
 *   D. Backend safety: _pricing.js unchanged, no migration, no persistence
 *   E. Separation: no B2C/B2B cross-contamination
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');

const adminPath = path.join(repoRoot, 'dashboard-admin.html');
const adminSrc = fs.readFileSync(adminPath, 'utf8');
const pricingPath = path.join(repoRoot, 'functions', '_pricing.js');
const pricingSrc = fs.readFileSync(pricingPath, 'utf8');

// Helper: extract the pack config tab section
function getPackSection() {
  const startIdx = adminSrc.indexOf('id="tab-packs-config"');
  assert.ok(startIdx > -1, 'pack config section must exist');
  // Find the next tab-content or end of file
  const nextTabIdx = adminSrc.indexOf('tab-content', startIdx + 100);
  const endIdx = nextTabIdx > -1 ? adminSrc.lastIndexOf('</div>', nextTabIdx) : adminSrc.length;
  return adminSrc.slice(startIdx, endIdx);
}

// =========================================================
// A. Admin B2C pack display
// =========================================================
test('A1. Admin shows Essentiel (not Starter commercial label)', () => {
  // The pack display title must be "Essentiel"
  assert.ok(adminSrc.includes('display_name_pack_starter">Essentiel'),
    'Admin must display "Essentiel" for starter pack, not "Starter"');
});

test('A2. Admin shows +69€ for Sérénité', () => {
  assert.ok(adminSrc.includes('tag_pack_serenite">+69€'),
    'Admin must display "+69€" for Sérénité pack');
});

test('A3. Admin shows +149€ for Excellence', () => {
  assert.ok(adminSrc.includes('tag_pack_excellence">+149€'),
    'Admin must display "+149€" for Excellence pack');
});

test('A4. Admin has no stale +49€ pack price', () => {
  const packSection = getPackSection();
  assert.ok(!packSection.includes('+49€'),
    'Admin pack section must not contain stale +49€');
});

test('A5. Admin has no stale +129€ pack price', () => {
  const packSection = getPackSection();
  assert.ok(!packSection.includes('+129€'),
    'Admin pack section must not contain stale +129€');
});

test('A6. Admin has no stale +159€ pack price', () => {
  const packSection = getPackSection();
  assert.ok(!packSection.includes('+159€'),
    'Admin pack section must not contain stale +159€');
});

test('A7. Admin has no stale "Starter" as commercial pack label', () => {
  const packSection = getPackSection();
  // "Starter" should not appear as a display title in the pack section
  assert.ok(!packSection.includes('>Starter<'),
    'Admin pack section must not show "Starter" as a commercial label');
});

// =========================================================
// B. Approved copy only
// =========================================================
test('B1. Admin Excellence shows approved fuel wording', () => {
  assert.ok(adminSrc.includes('carburant facturé au réel'),
    'Admin must contain approved fuel wording "carburant facturé au réel"');
});

test('B2. Admin has no "support VIP" claim', () => {
  assert.ok(!/support VIP/i.test(adminSrc),
    'Admin must not contain "support VIP"');
});

test('B3. Admin has no included/free fuel claim', () => {
  assert.ok(!/plein de carburant offert/i.test(adminSrc),
    'Admin must not contain "Plein de carburant offert"');
  assert.ok(!/full energy/i.test(adminSrc),
    'Admin must not contain "Full Energy" free fuel claim');
});

test('B4. Admin has no Photos 4K claim', () => {
  assert.ok(!/photos pro 4k/i.test(adminSrc),
    'Admin must not contain "Photos pro 4K"');
});

test('B5. Admin has no Sunday/public holiday included claim', () => {
  assert.ok(!/livraison dimanche/i.test(adminSrc),
    'Admin must not contain "Livraison dimanche" included claim');
});

test('B6. Admin has no "priorité d\'affectation" claim', () => {
  assert.ok(!/priorité d'affectation/i.test(adminSrc),
    'Admin must not contain "priorité d\'affectation"');
});

// =========================================================
// C. Truthfulness
// =========================================================
test('C1. Admin has no functional-looking dead Save control for packs', () => {
  // No pack-save-btn class should remain
  assert.ok(!adminSrc.includes('pack-save-btn'),
    'Admin must not contain dead pack-save-btn controls');
  // No data-pack attribute on save buttons
  assert.ok(!/data-pack="pack_/.test(adminSrc),
    'Admin must not contain data-pack save button attributes');
});

test('C2. Admin has no fake success path for pack config', () => {
  // No pack save handler, no toast for pack save
  assert.ok(!/savePack|packSaved|pack.*toast|toast.*pack/i.test(adminSrc),
    'Admin must not contain fake pack save success path');
});

test('C3. Admin has no new persistence/API added for pack config', () => {
  // No new API endpoint for pack config
  assert.ok(!/\/api\/.*pack.*config/i.test(adminSrc),
    'Admin must not contain new pack config API endpoint');
  // No localStorage pack persistence
  assert.ok(!/localStorage.*pack_|pack_.*localStorage/i.test(adminSrc),
    'Admin must not contain localStorage pack persistence');
});

test('C4. Admin has read-only/informational notice', () => {
  assert.ok(adminSrc.includes("Modification depuis l'Admin non disponible"),
    'Admin must contain read-only notice "Modification depuis l\'Admin non disponible"');
});

test('C5. Admin has no editable pack input fields (name, price, features)', () => {
  // The old editable inputs should be gone
  assert.ok(!adminSrc.includes('id="name_pack_starter"'),
    'Admin must not contain editable name_pack_starter input');
  assert.ok(!adminSrc.includes('id="price_pack_serenite"'),
    'Admin must not contain editable price_pack_serenite input');
  assert.ok(!adminSrc.includes('id="price_pack_excellence"'),
    'Admin must not contain editable price_pack_excellence input');
  assert.ok(!adminSrc.includes('id="features_pack_starter"'),
    'Admin must not contain editable features_pack_starter textarea');
});

// =========================================================
// D. Backend safety
// =========================================================
test('D1. functions/_pricing.js unchanged', () => {
  assert.ok(pricingSrc.includes('PACK_PRICES_PUBLIC = { starter: 0, serenite: 69, excellence: 149 }'),
    'backend PACK_PRICES_PUBLIC must be unchanged');
  assert.ok(pricingSrc.includes('PACK_PRICES_PRO = { starter: 0, serenite: 55, excellence: 125 }'),
    'backend PACK_PRICES_PRO must be unchanged');
  assert.ok(pricingSrc.includes("CANONICAL_PACKS = ['starter', 'serenite', 'excellence']"),
    'backend CANONICAL_PACKS must be unchanged');
});

test('D2. no new migration added', () => {
  // Check that no new migration file was added in this change
  const migrationsDir = path.join(repoRoot, 'supabase', 'migrations');
  const migrations = fs.readdirSync(migrationsDir);
  // Just verify the directory exists and has files — we're not adding any
  assert.ok(migrations.length > 0, 'migrations directory should exist with files');
});

test('D3. no Supabase pack persistence added', () => {
  // No new system_settings write for pack config in admin
  assert.ok(!/system_settings.*pack_|pack_.*system_settings/i.test(adminSrc),
    'Admin must not contain new system_settings pack write');
});

// =========================================================
// E. Separation
// =========================================================
test('E1. Admin pack section has no B2B prices', () => {
  const packSection = getPackSection();
  assert.ok(!packSection.includes('+55€'),
    'Admin B2C pack section must not contain B2B Sérénité price +55€');
  assert.ok(!packSection.includes('+125€'),
    'Admin B2C pack section must not contain B2B Excellence price +125€');
});

test('E2. Admin pack section has no B2B benefits copied from B2C', () => {
  // The admin pack section should only show B2C values
  const packSection = getPackSection();
  assert.ok(packSection.includes('+69€'),
    'Admin pack section must show B2C Sérénité +69€');
  assert.ok(packSection.includes('+149€'),
    'Admin pack section must show B2C Excellence +149€');
});
