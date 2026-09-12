/**
 * RM-02C2B1 — Admin quick-create authoritative preview tests.
 *
 * Verifies that dashboard-admin.html quick-create devis dialog:
 *   A. Preview calls /api/calculate-quote (not BathilyPricing)
 *   B. BathilyPricing.calculate() no longer controls quick-create preview
 *   C. Shared payload builder used by preview and submit
 *   D. depart/arrivee required-field guard
 *   E. 300ms text debounce
 *   F. Discrete controls immediate refresh
 *   G. Previous request aborted
 *   H. Stale response blocked
 *   I. Timeout distinguished from normal abort
 *   J. Old price invalidated immediately
 *   K. 400 safe error
 *   L. 429 specific error
 *   M. 500/network error behavior
 *   N. Submit still independently revalidates
 *   O. Legacy manual distance does not influence pricing
 *   P. Dead updateAdminDevisPrice reference absent
 *   Q. dashboard no longer loads js/pricing.js
 *
 * Static tests use source inspection (matching existing test stack).
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');
const adminPath = path.join(repoRoot, 'dashboard-admin.html');
const adminSrc = fs.readFileSync(adminPath, 'utf8');

// Extract the quick-create dialog code (didOpen + preConfirm).
// The dialog is inside createDevisAdmin, starting at the Swal.fire html template.
const qcStart = adminSrc.indexOf('window.createDevisAdmin');
const qcEnd = adminSrc.indexOf('if (!formValues) return;', qcStart);
const qcSection = adminSrc.substring(qcStart, qcEnd);

// =========================================================
// A. Preview calls /api/calculate-quote
// =========================================================
test('A. quick-create preview calls /api/calculate-quote', () => {
  const apiMatches = (qcSection.match(/\/api\/calculate-quote/g) || []).length;
  assert.ok(apiMatches >= 2,
    `quick-create section must call /api/calculate-quote in both preview and submit (found ${apiMatches})`);
});

// B. BathilyPricing.calculate() no longer controls quick-create preview
test('B. BathilyPricing.calculate() absent from quick-create section', () => {
  // Remove comments before checking for functional references
  const stripped = qcSection.replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
  assert.ok(!stripped.includes('BathilyPricing.calculate'),
    'quick-create section must NOT call BathilyPricing.calculate() (functional code)');
  assert.ok(!stripped.includes('result.prix'),
    'quick-create section must NOT use result.prix from legacy calculate()');
});

// C. Shared payload builder used by preview and submit
test('C. quick-create uses shared payload builder (_qcBuildPayload)', () => {
  assert.ok(qcSection.includes('function _qcBuildPayload'),
    'quick-create must define _qcBuildPayload');
  // Preview must use it
  assert.ok(qcSection.includes('JSON.stringify(payload)') || qcSection.includes('_qcBuildPayload()'),
    'preview must use _qcBuildPayload');
  // Submit must build equivalent payload (may be inline or use builder)
  assert.ok(qcSection.includes('preConfirm'),
    'preConfirm must exist');
});

// D. depart/arrivee required-field guard
test('D. quick-create has required-field guard for depart/arrivee', () => {
  assert.ok(/if\s*\(\s*!payload\.depart\s*\|\|\s*!payload\.arrivee\s*\)/.test(qcSection),
    'preview must guard against empty depart/arrivee');
  assert.ok(qcSection.includes('Départ et arrivée sont obligatoires'),
    'submit must validate depart/arrivee');
});

// E. 300ms text debounce
test('E. quick-create uses 300ms debounce for text inputs', () => {
  assert.ok(qcSection.includes('QC_DEBOUNCE_MS = 300'),
    'quick-create must define QC_DEBOUNCE_MS = 300');
  assert.ok(/departInput.*addEventListener.*input.*_qcRefresh\(false\)/.test(qcSection),
    'depart input must use debounced refresh');
  assert.ok(/arriveeInput.*addEventListener.*input.*_qcRefresh\(false\)/.test(qcSection),
    'arrivee input must use debounced refresh');
});

// F. Discrete controls immediate refresh
test('F. quick-create uses immediate refresh for discrete controls', () => {
  assert.ok(/vehSelect.*addEventListener.*change.*_qcRefresh\(true\)/.test(qcSection),
    'vehicle select must use immediate refresh');
  assert.ok(/modeSelect.*addEventListener.*change.*_qcRefresh\(true\)/.test(qcSection),
    'mode select must use immediate refresh');
  assert.ok(/packSelect.*addEventListener.*change.*_qcRefresh\(true\)/.test(qcSection),
    'pack select must use immediate refresh');
  assert.ok(/proSelect.*addEventListener.*change.*_qcRefresh\(true\)/.test(qcSection),
    'pro select must use immediate refresh');
});

// G. Previous request aborted (AbortController)
test('G. quick-create aborts previous in-flight request', () => {
  assert.ok(qcSection.includes('AbortController'),
    'quick-create must use AbortController');
  assert.ok(/if\s*\(\s*_qcAbortCtrl\s*\)\s*\{[^}]*abort\(\)/.test(qcSection),
    'quick-create must abort previous request before starting new one');
});

// H. Stale response blocked (sequence guard)
test('H. quick-create blocks stale responses via sequence guard', () => {
  assert.ok(qcSection.includes('_qcSeq'),
    'quick-create must have monotonic sequence (_qcSeq)');
  assert.ok(/const mySeq = \+\+_qcSeq/.test(qcSection),
    'quick-create must increment sequence per request');
  assert.ok(/if\s*\(\s*mySeq\s*!==\s*_qcSeq\s*\)\s*return/.test(qcSection),
    'quick-create must reject stale responses');
});

// I. Timeout distinguished from normal abort
test('I. quick-create distinguishes timeout from normal abort', () => {
  assert.ok(qcSection.includes('QC_TIMEOUT_MS = 12000'),
    'quick-create must define 12s timeout');
  assert.ok(qcSection.includes('_timedOut'),
    'quick-create must use _timedOut flag to distinguish timeout');
  assert.ok(qcSection.includes('Délai dépassé'),
    'quick-create must show timeout error message');
});

// J. Old price invalidated immediately
test('J. quick-create invalidates old price immediately on input change', () => {
  assert.ok(qcSection.includes('_qcInvalidate'),
    'quick-create must have _qcInvalidate function');
  // _qcRefresh must call _qcInvalidate before scheduling/requesting
  assert.ok(/function _qcRefresh[\s\S]*?_qcInvalidate\(\)/.test(qcSection),
    '_qcRefresh must invalidate before scheduling/requesting');
  assert.ok(/function _qcRefresh[\s\S]*?_qcRenderLoading\(\)/.test(qcSection),
    '_qcRefresh must render loading state immediately');
});

// K. 400 safe error
test('K. quick-create renders safe error for 400', () => {
  assert.ok(/resp\.status === 400/.test(qcSection),
    'quick-create must handle 400 status');
  assert.ok(qcSection.includes('Données invalides'),
    'quick-create must show safe 400 error message');
});

// L. 429 specific error
test('L. quick-create renders rate-limit message for 429', () => {
  assert.ok(/resp\.status === 429/.test(qcSection),
    'quick-create must handle 429 status');
  assert.ok(qcSection.includes('Trop de requêtes'),
    'quick-create must show rate-limit message');
});

// M. 500/network error behavior
test('M. quick-create renders error for 500 and network failures', () => {
  assert.ok(/resp\.status >= 500/.test(qcSection),
    'quick-create must handle 500 status');
  assert.ok(qcSection.includes('Erreur serveur'),
    'quick-create must show server error message');
  assert.ok(qcSection.includes('Erreur réseau'),
    'quick-create must show network error message');
});

// N. Submit still independently revalidates
test('N. submit preConfirm revalidates through /api/calculate-quote', () => {
  assert.ok(qcSection.includes('preConfirm'),
    'preConfirm must exist');
  // Submit must call /api/calculate-quote (not trust cached preview)
  const preConfirmStart = qcSection.indexOf('preConfirm: async');
  const preConfirmSection = qcSection.substring(preConfirmStart);
  assert.ok(preConfirmSection.includes('/api/calculate-quote'),
    'preConfirm must call /api/calculate-quote');
  assert.ok(!preConfirmSection.includes('_qcLastValidQuote'),
    'preConfirm must NOT use cached preview quote');
});

// O. Legacy manual distance does not influence pricing
test('O. legacy manual distance field is read-only (does not influence pricing)', () => {
  // Find the cdDistance input in the HTML template
  const distMatch = adminSrc.match(/<input id="cdDistance"[^>]*>/);
  assert.ok(distMatch, 'cdDistance input must exist');
  assert.ok(distMatch[0].includes('readonly'),
    'cdDistance must be readonly (operator cannot override authoritative distance)');
  // Dead oninput reference must be absent
  assert.ok(!distMatch[0].includes('oninput'),
    'cdDistance must NOT have oninput handler');
});

// P. Dead updateAdminDevisPrice reference absent
test('P. dead updateAdminDevisPrice reference is absent', () => {
  assert.ok(!adminSrc.includes('updateAdminDevisPrice'),
    'dashboard-admin.html must not reference dead updateAdminDevisPrice function');
});

// Q. dashboard no longer loads js/pricing.js
test('Q. dashboard-admin.html no longer loads js/pricing.js', () => {
  assert.ok(!adminSrc.includes('src="/js/pricing.js"'),
    'dashboard-admin.html must not load js/pricing.js');
  assert.ok(!adminSrc.includes('src="js/pricing.js"'),
    'dashboard-admin.html must not load js/pricing.js (relative)');
});

// Additional: no functional BathilyPricing references in entire file
test('dashboard-admin.html has no functional BathilyPricing references', () => {
  // Strip comments before checking for functional references
  const stripped = adminSrc.replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
  const functionalRefs = (stripped.match(/BathilyPricing\./g) || []).length;
  assert.equal(functionalRefs, 0,
    `dashboard-admin.html must not have functional BathilyPricing references (found ${functionalRefs})`);
});
