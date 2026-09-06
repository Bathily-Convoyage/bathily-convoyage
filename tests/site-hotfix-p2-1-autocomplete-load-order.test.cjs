/**
 * SITE-HOTFIX-P2-1 — Homepage address autocomplete load-order regression test.
 *
 * Verifies that index.html loads js/address-autocomplete.js BEFORE the inline
 * <script> block that references window.AddressAutocomplete. Previously, the
 * script tag was placed after the inline block, so AddressAutocomplete was
 * undefined when the initialization code ran, causing the homepage departure
 * and arrival autocomplete to never be wired.
 *
 * Also verifies:
 *   - No duplicate script load
 *   - goToDevis() function still exists (preserved behavior)
 *   - Vehicle tab functions (setVehType) still exist (preserved behavior)
 *   - devis.html autocomplete behavior is unchanged (separate script load)
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');

const repoRoot = path.resolve(__dirname, '..');
const indexPath = path.join(repoRoot, 'index.html');
const indexSrc = fs.readFileSync(indexPath, 'utf8');

// =========================================================
// Helper: find all <script> tag positions (src and inline)
// =========================================================
function findScriptTags(src) {
  const tags = [];
  const regex = /<script(?:\s+src=["']([^"']+)["'])?(?:[^>]*)?>(?:<\/script>)?/g;
  let match;
  while ((match = regex.exec(src)) !== null) {
    tags.push({
      index: match.index,
      src: match[1] || null, // null = inline script
      fullMatch: match[0],
    });
  }
  return tags;
}

// =========================================================
// Core: address-autocomplete.js loads before AddressAutocomplete usage
// =========================================================
test('address-autocomplete.js script tag appears before window.AddressAutocomplete reference', () => {
  const scriptTags = findScriptTags(indexSrc);
  const autocompleteTag = scriptTags.find((t) => t.src && t.src.includes('address-autocomplete.js'));
  assert.ok(autocompleteTag, 'index.html must load js/address-autocomplete.js');

  const acRefIdx = indexSrc.indexOf('window.AddressAutocomplete');
  assert.ok(acRefIdx >= 0, 'index.html must reference window.AddressAutocomplete');

  assert.ok(
    autocompleteTag.index < acRefIdx,
    `address-autocomplete.js (at index ${autocompleteTag.index}) must load BEFORE window.AddressAutocomplete reference (at index ${acRefIdx})`,
  );
});

test('address-autocomplete.js is loaded exactly once in index.html', () => {
  const matches = indexSrc.match(/<script\s+src=["'][^"']*address-autocomplete\.js["']/g);
  assert.ok(matches, 'address-autocomplete.js must be loaded at least once');
  assert.equal(matches.length, 1, 'address-autocomplete.js must be loaded exactly once (no duplicates)');
});

// =========================================================
// Inline script that uses AddressAutocomplete must come after the library
// =========================================================
test('inline script block containing AddressAutocomplete init starts after library script', () => {
  const scriptTags = findScriptTags(indexSrc);
  const autocompleteTag = scriptTags.find((t) => t.src && t.src.includes('address-autocomplete.js'));

  // Find the inline <script> block that contains "window.AddressAutocomplete"
  const acRefIdx = indexSrc.indexOf('window.AddressAutocomplete');
  const inlineTags = scriptTags.filter((t) => t.src === null);
  const containingInline = inlineTags
    .filter((t) => t.index < acRefIdx)
    .sort((a, b) => b.index - a.index)[0]; // closest inline script before the reference

  assert.ok(containingInline, 'inline script block containing AddressAutocomplete reference must exist');
  assert.ok(
    autocompleteTag.index < containingInline.index,
    `address-autocomplete.js (at ${autocompleteTag.index}) must load before the inline script block (at ${containingInline.index}) that uses it`,
  );
});

// =========================================================
// Autocomplete initialization calls are present
// =========================================================
test('index.html initializes departure autocomplete via AddressAutocomplete.setupCity', () => {
  assert.ok(
    indexSrc.includes("AddressAutocomplete.setupCity('depart'"),
    "index.html must call AddressAutocomplete.setupCity('depart', ...)",
  );
});

test('index.html initializes arrival autocomplete via AddressAutocomplete.setupCity', () => {
  assert.ok(
    indexSrc.includes("AddressAutocomplete.setupCity('arrivee'"),
    "index.html must call AddressAutocomplete.setupCity('arrivee', ...)",
  );
});

// =========================================================
// Preserved behaviors: goToDevis and setVehType
// =========================================================
test('index.html preserves goToDevis() function', () => {
  assert.ok(
    indexSrc.includes('function goToDevis'),
    'index.html must still define goToDevis() function',
  );
});

test('index.html preserves setVehType() function', () => {
  assert.ok(
    indexSrc.includes('function setVehType') || indexSrc.includes('setVehType'),
    'index.html must still define/reference setVehType() function',
  );
});

// =========================================================
// devis.html autocomplete is separately loaded (unchanged behavior)
// =========================================================
test('devis.html loads address-autocomplete.js (unchanged, separate from homepage fix)', () => {
  const devisPath = path.join(repoRoot, 'devis.html');
  const devisSrc = fs.readFileSync(devisPath, 'utf8');
  assert.ok(
    devisSrc.includes('address-autocomplete.js'),
    'devis.html must still load address-autocomplete.js',
  );
});

// =========================================================
// address-autocomplete.js exports window.AddressAutocomplete
// =========================================================
test('address-autocomplete.js exports window.AddressAutocomplete with setupCity method', () => {
  const acPath = path.join(repoRoot, 'public', 'js', 'address-autocomplete.js');
  const acSrc = fs.readFileSync(acPath, 'utf8');
  assert.ok(
    acSrc.includes('window.AddressAutocomplete') || acSrc.includes('AddressAutocomplete'),
    'address-autocomplete.js must export AddressAutocomplete',
  );
  assert.ok(
    acSrc.includes('setupCity'),
    'address-autocomplete.js must define setupCity method',
  );
});
