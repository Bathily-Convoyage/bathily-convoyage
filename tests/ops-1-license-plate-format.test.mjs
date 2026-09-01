// OPS-1A — License Plate Format Fix — Static Validation
//
// Validates the three plate formatter functions in:
// - dashboard-admin.html  (formatAdminPlaque)
// - devis.html            (formatPlaque)
// - etat-des-lieux.html   (fmtPlaque)
//
// Also validates:
// - mobile-friendly attributes on plate inputs
// - no restrictive HTML pattern= attribute
// - backend normalizePlate/formatProviderPlate consistency
// - storage policy unchanged (stores formatted value, not canonical AB123CD)
// - SIV detection rule: only ^[A-Z]{2}[0-9]{3}[A-Z]{2}$ gets hyphens
// - non-SIV/FNI/foreign plates are NOT fake-formatted as SIV

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const baseDir = new URL('../', import.meta.url);

// ── Extract a function from HTML source ──
function extractFunction(html, funcName) {
  // Match function declarations: function name(args) { ... }
  const re = new RegExp(`function\\s+${funcName}\\s*\\(([^)]*)\\)\\s*\\{`, 'g');
  const m = re.exec(html);
  if (!m) return null;
  const start = m.index + m[0].length;
  let depth = 1;
  let i = start;
  while (i < html.length && depth > 0) {
    if (html[i] === '{') depth++;
    if (html[i] === '}') depth--;
    i++;
  }
  const body = html.slice(start, i - 1);
  const args = m[1];
  return new Function(args, body);
}

// ── Mock input element ──
function mockInput(value) {
  return { value };
}

// ── Run formatter and return result ──
function runFormat(fn, inputValue) {
  const inp = mockInput(inputValue);
  fn(inp);
  return inp.value;
}

// ── Load HTML files ──
const adminHtml = await readFile(new URL('dashboard-admin.html', baseDir), 'utf8');
const devisHtml = await readFile(new URL('devis.html', baseDir), 'utf8');
const edlHtml = await readFile(new URL('etat-des-lieux.html', baseDir), 'utf8');

// ── Extract formatters ──
const formatAdminPlaque = extractFunction(adminHtml, 'formatAdminPlaque');
const formatPlaque = extractFunction(devisHtml, 'formatPlaque');
const fmtPlaque = extractFunction(edlHtml, 'fmtPlaque');

assert(formatAdminPlaque, 'formatAdminPlaque function found in dashboard-admin.html');
assert(formatPlaque, 'formatPlaque function found in devis.html');
assert(fmtPlaque, 'fmtPlaque function found in etat-des-lieux.html');

// ── Backend normalizePlate (replicated from functions/api/lookup-vehicle.js) ──
function normalizePlate(p) {
  return (p || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
}
function formatProviderPlate(normalized) {
  if (normalized.length === 7) {
    return `${normalized.slice(0, 2)}-${normalized.slice(2, 5)}-${normalized.slice(5)}`;
  }
  return normalized;
}

// ── SIV detection rule ──
const SIV_PATTERN = /^[A-Z]{2}[0-9]{3}[A-Z]{2}$/;

// =========================================================
// TEST SUITE
// =========================================================
const checks = [];
function check(name, ok) {
  checks.push([name, ok]);
}

// ── SIV plates: must format as XX-XXX-XX ──
const sivInputs = [
  ['AB123CD', 'AB-123-CD'],
  ['AB-123-CD', 'AB-123-CD'],
  ['ab123cd', 'AB-123-CD'],
  ['AB 123 CD', 'AB-123-CD'],
  ['AB_123_CD', 'AB-123-CD'],
  ['ab-123-cd', 'AB-123-CD'],
  ['AB  123  CD', 'AB-123-CD'],
  ['AA-123-AA', 'AA-123-AA'],
  ['ZZ-999-ZZ', 'ZZ-999-ZZ'],
];

for (const [input, expected] of sivInputs) {
  check(`admin SIV "${input}" -> "${expected}"`, runFormat(formatAdminPlaque, input) === expected);
  check(`devis SIV "${input}" -> "${expected}"`, runFormat(formatPlaque, input) === expected);
  check(`edl SIV "${input}" -> "${expected}"`, runFormat(fmtPlaque, input) === expected);
}

// ── Intermediate typing: must NOT produce malformed states ──
const intermediateInputs = [
  ['A', 'A'],
  ['AB', 'AB'],
  ['AB1', 'AB1'],
  ['AB12', 'AB12'],
  ['AB123', 'AB123'],
  ['AB123C', 'AB123C'],
  ['AB123CD', 'AB-123-CD'],  // complete SIV — hyphens appear
];

for (const [input, expected] of intermediateInputs) {
  const adminResult = runFormat(formatAdminPlaque, input);
  const devisResult = runFormat(formatPlaque, input);
  const edlResult = runFormat(fmtPlaque, input);
  check(`admin intermediate "${input}" -> "${expected}" (got "${adminResult}")`, adminResult === expected);
  check(`devis intermediate "${input}" -> "${expected}" (got "${devisResult}")`, devisResult === expected);
  check(`edl intermediate "${input}" -> "${expected}" (got "${edlResult}")`, edlResult === expected);
}

// ── Critical: no malformed AB123C-D ──
check('admin no malformed AB123C-D', runFormat(formatAdminPlaque, 'AB123CD') !== 'AB123C-D');
check('devis no malformed AB123C-D', runFormat(formatPlaque, 'AB123CD') !== 'AB123C-D');
check('edl no malformed AB123C-D', runFormat(fmtPlaque, 'AB123CD') !== 'AB123C-D');

check('admin no malformed AB123C-D from AB-123-CD', runFormat(formatAdminPlaque, 'AB-123-CD') !== 'AB123C-D');
check('devis no malformed AB123C-D from AB-123-CD', runFormat(formatPlaque, 'AB-123-CD') !== 'AB123C-D');
check('edl no malformed AB123C-D from AB-123-CD', runFormat(fmtPlaque, 'AB-123-CD') !== 'AB123C-D');

// ── Non-SIV/FNI plates: must NOT get fake SIV formatting ──
const fniInputs = [
  ['123AB34', '123AB34'],
  ['1234AB75', '1234AB75'],
  ['123ABC75', '123ABC75'],
  ['123 AB 34', '123AB34'],
  ['1234 AB 75', '1234AB75'],
  ['123 ABC 75', '123ABC75'],
];

for (const [input, expected] of fniInputs) {
  const adminResult = runFormat(formatAdminPlaque, input);
  const devisResult = runFormat(formatPlaque, input);
  const edlResult = runFormat(fmtPlaque, input);
  check(`admin FNI "${input}" -> "${expected}" (got "${adminResult}")`, adminResult === expected);
  check(`devis FNI "${input}" -> "${expected}" (got "${devisResult}")`, devisResult === expected);
  check(`edl FNI "${input}" -> "${expected}" (got "${edlResult}")`, edlResult === expected);
  // Verify no fake SIV hyphens were added
  check(`admin FNI "${input}" no fake SIV hyphens`, !/^[A-Z]{2}-[0-9]{3}-[A-Z]{2}$/.test(adminResult));
  check(`devis FNI "${input}" no fake SIV hyphens`, !/^[A-Z]{2}-[0-9]{3}-[A-Z]{2}$/.test(devisResult));
  check(`edl FNI "${input}" no fake SIV hyphens`, !/^[A-Z]{2}-[0-9]{3}-[A-Z]{2}$/.test(edlResult));
}

// ── Foreign/manual plates: no fake SIV formatting ──
const foreignInputs = [
  ['B-AB1234', 'BAB1234'],     // German-style
  ['M1234567', 'M1234567'],    // Simple
  ['AB1234', 'AB1234'],        // 6 chars, not SIV
  ['ABCDEFG', 'ABCDEFG'],      // 7 chars but letters only, not SIV
  ['1234567', '1234567'],      // 7 chars but numbers only, not SIV
  ['AB123CDE', 'AB123CDE'],    // 8 chars
];

for (const [input, expected] of foreignInputs) {
  const adminResult = runFormat(formatAdminPlaque, input);
  const devisResult = runFormat(formatPlaque, input);
  const edlResult = runFormat(fmtPlaque, input);
  check(`admin foreign "${input}" -> "${expected}" (got "${adminResult}")`, adminResult === expected);
  check(`devis foreign "${input}" -> "${expected}" (got "${devisResult}")`, devisResult === expected);
  check(`edl foreign "${input}" -> "${expected}" (got "${edlResult}")`, edlResult === expected);
  check(`admin foreign "${input}" no fake SIV`, !/^[A-Z]{2}-[0-9]{3}-[A-Z]{2}$/.test(adminResult));
}

// ── Edge cases ──
check('admin empty -> empty', runFormat(formatAdminPlaque, '') === '');
check('devis empty -> empty', runFormat(formatPlaque, '') === '');
check('edl empty -> empty', runFormat(fmtPlaque, '') === '');

check('admin spaces only -> empty', runFormat(formatAdminPlaque, '   ') === '');
check('admin hyphens only -> empty', runFormat(formatAdminPlaque, '---') === '');
check('admin underscores only -> empty', runFormat(formatAdminPlaque, '___') === '');

// ── Unicode/non-breaking spaces are stripped ──
check('admin NBSP stripped', runFormat(formatAdminPlaque, 'AB\u00A0123\u00A0CD') === 'AB-123-CD');
check('admin unicode dash stripped', runFormat(formatAdminPlaque, 'AB\u2013123\u2013CD') === 'AB-123-CD');
check('admin em-dash stripped', runFormat(formatAdminPlaque, 'AB\u2014123\u2014CD') === 'AB-123-CD');

// ── Maxlength: SIV result AB-123-CD is 9 chars, fits in maxlength=9 ──
check('admin SIV result length <= 9', runFormat(formatAdminPlaque, 'AB123CD').length <= 9);
check('devis SIV result length <= 9', runFormat(formatPlaque, 'AB123CD').length <= 9);
check('edl SIV result length <= 9', runFormat(fmtPlaque, 'AB123CD').length <= 9);

// ── Truncation: admin and devis truncate to 9 chars (pre-existing maxlength=9) ──
check('admin truncates to 9', runFormat(formatAdminPlaque, 'ABCDEFGH123456').length <= 9);
check('devis truncates to 9', runFormat(formatPlaque, 'ABCDEFGH123456').length <= 9);

// ── OPS-1A.1: EDL must NOT truncate — no maxlength was present before OPS-1 ──
// EDL formatter preserves long non-SIV values without destructive truncation.
check('edl does NOT truncate long non-SIV (OPS-1A.1)', runFormat(fmtPlaque, 'ABCDEFGH123456') === 'ABCDEFGH123456');
check('edl long non-SIV not fake SIV formatted', !/^[A-Z]{2}-[0-9]{3}-[A-Z]{2}$/.test(runFormat(fmtPlaque, 'ABCDEFGH123456')));
check('edl long FNI-style 1234AB75678 not truncated', runFormat(fmtPlaque, '1234AB75678') === '1234AB75678');
check('edl long foreign MABCDEFGH not truncated', runFormat(fmtPlaque, 'MABCDEFGH') === 'MABCDEFGH');

// =========================================================
// HTML ATTRIBUTE CHECKS
// =========================================================

// ── Admin input has mobile-friendly attributes ──
check('admin input has autocapitalize=characters', /id="adminPlaqueInput"[^>]*autocapitalize="characters"/.test(adminHtml));
check('admin input has inputmode=text', /id="adminPlaqueInput"[^>]*inputmode="text"/.test(adminHtml));
check('admin input has autocomplete=off', /id="adminPlaqueInput"[^>]*autocomplete="off"/.test(adminHtml));
check('admin input has spellcheck=false', /id="adminPlaqueInput"[^>]*spellcheck="false"/.test(adminHtml));
check('admin input has maxlength=9', /id="adminPlaqueInput"[^>]*maxlength="9"/.test(adminHtml));

// ── No restrictive pattern= on admin input ──
check('admin input has NO pattern= attribute', !/id="adminPlaqueInput"[^>]*pattern=/.test(adminHtml));

// ── Devis input has mobile-friendly attributes ──
check('devis input has autocapitalize=characters', /id="plaqueInput"[^>]*autocapitalize="characters"/.test(devisHtml));
check('devis input has inputmode=text', /id="plaqueInput"[^>]*inputmode="text"/.test(devisHtml));
check('devis input has autocomplete=off', /id="plaqueInput"[^>]*autocomplete="off"/.test(devisHtml));
check('devis input has spellcheck=false', /id="plaqueInput"[^>]*spellcheck="false"/.test(devisHtml));
check('devis input has maxlength=9', /id="plaqueInput"[^>]*maxlength="9"/.test(devisHtml));
check('devis input has NO pattern= attribute', !/id="plaqueInput"[^>]*pattern=/.test(devisHtml));

// ── EDL input has mobile-friendly attributes ──
// OPS-1A.1: EDL vPlaque must NOT have maxlength (was not present before OPS-1)
check('edl input has autocapitalize=characters', /id="vPlaque"[^>]*autocapitalize="characters"/.test(edlHtml));
check('edl input has inputmode=text', /id="vPlaque"[^>]*inputmode="text"/.test(edlHtml));
check('edl input has autocomplete=off', /id="vPlaque"[^>]*autocomplete="off"/.test(edlHtml));
check('edl input has spellcheck=false', /id="vPlaque"[^>]*spellcheck="false"/.test(edlHtml));
check('EDL_MAXLENGTH_ADDED=NO — vPlaque has NO maxlength introduced by OPS-1', !/id="vPlaque"[^>]*maxlength=/.test(edlHtml));
check('edl input has NO pattern= attribute', !/id="vPlaque"[^>]*pattern=/.test(edlHtml));

// =========================================================
// SIV DETECTION RULE
// =========================================================

// Verify the SIV pattern is present in all three formatters
check('admin formatter uses SIV pattern regex', /A-Z\]\{2\}\[0-9\]\{3\}\[A-Z\]\{2\}/.test(adminHtml));
check('devis formatter uses SIV pattern regex', /A-Z\]\{2\}\[0-9\]\{3\}\[A-Z\]\{2\}/.test(devisHtml));
check('edl formatter uses SIV pattern regex', /A-Z\]\{2\}\[0-9\]\{3\}\[A-Z\]\{2\}/.test(edlHtml));

// Verify the old buggy conditions are gone
check('admin no old v.length <= 5 condition', !/v\.length\s*<=\s*5/.test(adminHtml));
check('devis no old v.length <= 5 condition', !/v\.length\s*<=\s*5/.test(devisHtml));
check('edl no old length-based hyphen logic', !/v\.length>2\).*v\.slice\(0,2\)\+'-'\+v\.slice\(2\).*v\.length>6/.test(edlHtml));

// =========================================================
// BACKEND CONSISTENCY
// =========================================================

// All three frontend inputs must produce values that the backend normalizes to the same key
const testPlates = ['AB-123-CD', 'AB123CD', 'ab 123 cd', 'AB_123_CD'];
const normalizedKeys = testPlates.map(p => normalizePlate(p));
check('all test plates normalize to same backend key', normalizedKeys.every(k => k === 'AB123CD'));

// Backend formatProviderPlate produces AB-123-CD for 7-char normalized
check('backend formatProviderPlate("AB123CD") = "AB-123-CD"', formatProviderPlate('AB123CD') === 'AB-123-CD');

// Frontend formatted value, when sent to backend, normalizes correctly
const frontendFormatted = runFormat(formatAdminPlaque, 'AB123CD');
check('frontend "AB-123-CD" -> backend normalize -> "AB123CD"', normalizePlate(frontendFormatted) === 'AB123CD');
check('backend re-formats to "AB-123-CD" for provider', formatProviderPlate(normalizePlate(frontendFormatted)) === 'AB-123-CD');

// =========================================================
// STORAGE POLICY
// =========================================================

// Verify storage still uses the formatted value (AB-123-CD), not canonical AB123CD
check('admin stores formatted plate (immatriculation: plaque)', /immatriculation:\s*plaque\s*\|\|\s*null/.test(adminHtml));
check('admin does NOT store normalizePlate(plaque)', !/immatriculation:\s*normalizePlate\(/.test(adminHtml));

// The payload builder preserves the formatted value
check('admin payload builder includes immatriculation', /'immatriculation'/.test(adminHtml));

// =========================================================
// CONSISTENCY ACROSS THREE FORMATTERS
// =========================================================

// All three formatters must produce identical results for SIV
for (const [input, expected] of sivInputs) {
  const a = runFormat(formatAdminPlaque, input);
  const d = runFormat(formatPlaque, input);
  const e = runFormat(fmtPlaque, input);
  check(`consistency SIV "${input}": admin=devis=edl="${expected}"`, a === d && d === e && e === expected);
}

// All three formatters must produce identical results for non-SIV
for (const [input, expected] of fniInputs) {
  const a = runFormat(formatAdminPlaque, input);
  const d = runFormat(formatPlaque, input);
  const e = runFormat(fmtPlaque, input);
  check(`consistency FNI "${input}": admin=devis=edl="${expected}"`, a === d && d === e && e === expected);
}

// =========================================================
// RESULTS
// =========================================================
let passed = 0, failed = 0;
for (const [name, ok] of checks) {
  if (ok) {
    passed++;
  } else {
    failed++;
    console.error(`FAIL: ${name}`);
  }
}

console.log(`\n${passed} checks passed, ${failed} failed`);
if (failed === 0) {
  console.log('\nOPS-1A license plate format fix: PASS');
} else {
  console.log('\nOPS-1A license plate format fix: FAIL');
  process.exit(1);
}
