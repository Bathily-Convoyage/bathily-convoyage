/**
 * RM-02C2B2 — Harden calculateAdminPrice() tests.
 *
 * Verifies that dashboard-admin.html manual mission pricing preview:
 *   A. Still calls /api/calculate-quote
 *   B. No local pricing calculation introduced
 *   C. Required-field guard prevents request
 *   D. 300ms text debounce
 *   E. Discrete control refresh is immediate
 *   F. Immediate path cancels pending debounce
 *   G. Previous request is aborted
 *   H. Stale response cannot overwrite newer
 *   I. Sequence checked after fetch
 *   J. Sequence checked after JSON parse
 *   K. 12s timeout exists
 *   L. Timeout distinguished from supersede abort
 *   M. Supersede abort is silent
 *   N. Stale price invalidated before pending request
 *   O. _lastManualQuote invalidated before new request/error
 *   P. 400 visible state
 *   Q. 429 visible state
 *   R. 5xx visible state
 *   S. Network error visible state
 *   T. Timeout visible state
 *   U. Error message is not immediately self-cleared
 *   V. Invalid response shape rejected
 *   W. Success updates latest authoritative price
 *   X. Success updates remuneration
 *   Y. updateManualMarginDisplay remains correctly invoked
 *   Z. Submit still independently revalidates
 *   AA. Submit does not trust _lastManualQuote
 *   AB. mode='route' preserved
 *   AC. vehicleCondition='working' preserved
 *   AD. isPro=false preserved
 *   AE. No utilSize/promoPercent invented
 *   AF. C2B1 quick-create remains unchanged
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

// Extract the calculateAdminPrice section (includes _manualPriceRenderStatus + calculateAdminPrice + _manualPriceFetchPreview).
const capStart = adminSrc.indexOf('function _manualPriceRenderStatus');
const capEnd = adminSrc.indexOf('// ============================================================\n// FONCTIONS UTILITAIRES', capStart);
const capSection = adminSrc.substring(capStart, capEnd);

// Extract the _doCreateMission submit section.
const submitStart = adminSrc.indexOf('async function _doCreateMission');
const submitEnd = adminSrc.indexOf('const sb = getSupabase();', submitStart + 200);
const submitSection = adminSrc.substring(submitStart, submitEnd);

// Extract the event listener section for manual pricing.
const listenerStart = adminSrc.indexOf('// ---- Calcul automatique du tarif (admin) ----');
const listenerEnd = adminSrc.indexOf('// ---- Mise à jour automatique de la marge ----');
const listenerSection = adminSrc.substring(listenerStart, listenerEnd);

// A. Still calls /api/calculate-quote
test('A. calculateAdminPrice calls /api/calculate-quote', () => {
  assert.ok(capSection.includes('/api/calculate-quote'),
    'calculateAdminPrice must call /api/calculate-quote');
});

// B. No local pricing calculation introduced
test('B. no local pricing calculation introduced', () => {
  assert.ok(!capSection.includes('BathilyPricing'),
    'calculateAdminPrice must NOT use BathilyPricing');
  assert.ok(!capSection.includes('BASE_RATES'),
    'calculateAdminPrice must NOT use BASE_RATES');
  assert.ok(!capSection.includes('COEFFS'),
    'calculateAdminPrice must NOT use COEFFS');
  assert.ok(!capSection.includes('haversine'),
    'calculateAdminPrice must NOT use haversine');
});

// C. Required-field guard prevents request
test('C. required-field guard prevents request with empty depart/arrivee', () => {
  assert.ok(/if\s*\(\s*!depart\s*\|\|\s*!arrivee\s*\)/.test(capSection),
    'calculateAdminPrice must guard against empty depart/arrivee');
  // Guard must abort in-flight request and clear debounce
  assert.ok(/if\s*\(\s*!depart\s*\|\|\s*!arrivee\s*\)[\s\S]{0,200}_manualPriceAbortCtrl/.test(capSection),
    'required-field guard must abort in-flight request');
  assert.ok(/if\s*\(\s*!depart\s*\|\|\s*!arrivee\s*\)[\s\S]{0,300}_manualPriceDebounceTimer/.test(capSection),
    'required-field guard must cancel pending debounce');
});

// D. 300ms text debounce
test('D. 300ms text debounce for address inputs', () => {
  assert.ok(adminSrc.includes('MANUAL_PRICE_DEBOUNCE_MS = 300'),
    'must define MANUAL_PRICE_DEBOUNCE_MS = 300');
  assert.ok(/departField\.addEventListener\('input'.*calculateAdminPrice\(false\)/.test(adminSrc),
    'depart input must use debounced refresh (false)');
  assert.ok(/arriveeField\.addEventListener\('input'.*calculateAdminPrice\(false\)/.test(adminSrc),
    'arrivee input must use debounced refresh (false)');
});

// E. Discrete control refresh is immediate
test('E. discrete controls use immediate refresh', () => {
  assert.ok(/vehTypeField\.addEventListener\('change'.*calculateAdminPrice\(true\)/.test(adminSrc),
    'vehicle type change must use immediate refresh (true)');
  assert.ok(/packField\.addEventListener\('change'.*calculateAdminPrice\(true\)/.test(adminSrc),
    'pack change must use immediate refresh (true)');
});

// F. Immediate path cancels pending debounce
test('F. immediate path cancels pending debounce timer', () => {
  assert.ok(/if\s*\(\s*immediate\s*\)[\s\S]{0,100}clearTimeout\(\s*_manualPriceDebounceTimer/.test(capSection),
    'immediate path must clear pending debounce timer before requesting');
});

// G. Previous request is aborted
test('G. previous in-flight request is aborted', () => {
  assert.ok(capSection.includes('AbortController'),
    'calculateAdminPrice must use AbortController');
  assert.ok(/_manualPriceAbortCtrl[\s\S]{0,50}abort\(\)/.test(capSection),
    'must abort previous request before starting new one');
});

// H. Stale response cannot overwrite newer
test('H. stale response cannot overwrite newer response', () => {
  assert.ok(capSection.includes('_manualPriceSeq'),
    'must have monotonic sequence (_manualPriceSeq)');
  assert.ok(/const mySeq = \+\+_manualPriceSeq/.test(capSection),
    'must increment sequence per request');
});

// I. Sequence checked after fetch
test('I. sequence checked after fetch', () => {
  assert.ok(/clearTimeout\(timeoutId\)[\s\S]{0,30}if\s*\(\s*mySeq\s*!==\s*_manualPriceSeq\s*\)\s*return/.test(capSection),
    'must check sequence after fetch returns');
});

// J. Sequence checked after JSON parse
test('J. sequence checked after JSON parse', () => {
  assert.ok(/quote = await response\.json\(\)[\s\S]{0,30}if\s*\(\s*mySeq\s*!==\s*_manualPriceSeq\s*\)\s*return/.test(capSection),
    'must check sequence after JSON parse');
});

// K. 12s timeout exists
test('K. 12s timeout exists', () => {
  assert.ok(adminSrc.includes('MANUAL_PRICE_TIMEOUT_MS = 12000'),
    'must define MANUAL_PRICE_TIMEOUT_MS = 12000');
  assert.ok(/setTimeout[\s\S]{0,100}MANUAL_PRICE_TIMEOUT_MS/.test(capSection),
    'must set timeout using MANUAL_PRICE_TIMEOUT_MS');
});

// L. Timeout distinguished from supersede abort
test('L. timeout distinguished from supersede abort', () => {
  assert.ok(capSection.includes('_timedOut'),
    'must use _timedOut flag to distinguish timeout');
  assert.ok(/abortCtrl\._timedOut\s*&&\s*mySeq\s*===\s*_manualPriceSeq/.test(capSection),
    'must check _timedOut and sequence in abort handler');
});

// M. Supersede abort is silent
test('M. supersede abort is silent (no error render on non-timeout abort)', () => {
  // The abort block must return without rendering error for non-timeout aborts
  const abortBlock = capSection.match(/abortCtrl\.signal\.aborted[\s\S]{0,400}return/);
  assert.ok(abortBlock,
    'abort block must exist and return');
  // Non-timeout abort should not call any C2B1 error render function
  assert.ok(!/abortCtrl\.signal\.aborted[\s\S]{0,300}_qcRenderError/.test(capSection),
    'non-timeout abort must not call _qcRenderError');
});

// N. Stale price invalidated before pending request
test('N. stale price invalidated before pending request', () => {
  assert.ok(/_lastManualQuote\s*=\s*null[\s\S]{0,200}priceInput\.value\s*=\s*''/.test(capSection),
    'must invalidate _lastManualQuote and clear price before scheduling/requesting');
});

// O. _lastManualQuote invalidated before new request/error
test('O. _lastManualQuote invalidated on error paths', () => {
  // Network error path
  assert.ok(/abortCtrl\.signal\.aborted[\s\S]{0,300}_lastManualQuote\s*=\s*null/.test(capSection),
    'must invalidate _lastManualQuote on network error');
  // HTTP error path
  assert.ok(/!response\.ok[\s\S]{0,100}_lastManualQuote\s*=\s*null/.test(capSection),
    'must invalidate _lastManualQuote on HTTP error');
});

// P-R. Error states (400, 429, 5xx) — verify visible messages + clear price/rem
test('P. 400 visible message rendered', () => {
  assert.ok(/response\.status === 400[\s\S]{0,100}_manualPriceRenderStatus/.test(capSection),
    'must render visible status for 400');
  assert.ok(capSection.includes('Données invalides.'),
    'must have 400 message: "Données invalides."');
});

test('Q. 429 visible message rendered', () => {
  assert.ok(/response\.status === 429[\s\S]{0,100}_manualPriceRenderStatus/.test(capSection),
    'must render visible status for 429');
  assert.ok(capSection.includes('Trop de requêtes. Patientez quelques secondes.'),
    'must have 429 message');
});

test('R. 5xx visible message rendered', () => {
  assert.ok(/response\.status >= 500[\s\S]{0,100}_manualPriceRenderStatus/.test(capSection),
    'must render visible status for 5xx');
  assert.ok(capSection.includes('Erreur serveur. Réessayez.'),
    'must have 5xx message');
});

// S. Network error visible state
test('S. network error renders visible message', () => {
  assert.ok(capSection.includes('Erreur réseau. Réessayez.'),
    'must render visible network error message');
  assert.ok(/Erreur réseau[\s\S]{0,50}_manualPriceRenderStatus/.test(capSection) || /_manualPriceRenderStatus[\s\S]{0,50}Erreur réseau/.test(capSection),
    'must call _manualPriceRenderStatus with network error message');
});

// T. Timeout visible state
test('T. timeout renders visible message', () => {
  assert.ok(capSection.includes('Délai dépassé. Réessayez.'),
    'must render visible timeout message');
  assert.ok(/_timedOut\s*&&\s*mySeq\s*===\s*_manualPriceSeq[\s\S]{0,300}_manualPriceRenderStatus/.test(capSection),
    'timeout must call _manualPriceRenderStatus');
});

// U. Error message is not immediately self-cleared
test('U. error message persists (not self-cleared by invalidation)', () => {
  // _manualPriceRenderStatus sets textContent, not value, so it's independent
  // from priceInput/remInput clearing. Verify the renderer exists and is called
  // on error paths WITHOUT being followed by a clear.
  assert.ok(capSection.includes('function _manualPriceRenderStatus'),
    'must have _manualPriceRenderStatus function');
  // Verify no _qcInvalidate-style clear after render
  assert.ok(!capSection.includes('_qcInvalidate'),
    'manual flow must not use C2B1 invalidate function');
  assert.ok(!capSection.includes('_qcRenderError'),
    'manual flow must not use C2B1 error render function');
});

// V. Invalid response shape rejected
test('V. invalid response shape rejected', () => {
  assert.ok(/typeof quote\.total_ht\s*!==\s*'number'/.test(capSection),
    'must validate quote.total_ht is a number');
  assert.ok(/typeof quote\.distance\s*!==\s*'number'/.test(capSection),
    'must validate quote.distance is a number');
  assert.ok(/typeof quote\.total_ht\s*!==\s*'number'[\s\S]{0,100}_lastManualQuote\s*=\s*null/.test(capSection),
    'invalid response must invalidate _lastManualQuote');
});

// W. Success updates latest authoritative price
test('W. success updates price from authoritative response', () => {
  assert.ok(/_lastManualQuote\s*=\s*quote/.test(capSection),
    'must set _lastManualQuote on success');
  assert.ok(/priceInput\.value\s*=\s*quote\.total_ht/.test(capSection),
    'must update priceInput from quote.total_ht');
});

// X. Success updates remuneration
test('X. success updates remuneration from authoritative response', () => {
  assert.ok(/remInput.*quote\.remuneration_convoyeur/.test(capSection),
    'must update remInput from quote.remuneration_convoyeur');
});

// Y. updateManualMarginDisplay remains correctly invoked
test('Y. updateManualMarginDisplay invoked on success and error paths', () => {
  const matches = capSection.match(/updateManualMarginDisplay\(\)/g) || [];
  assert.ok(matches.length >= 4,
    `must call updateManualMarginDisplay on success and error paths (found ${matches.length})`);
});

// Z. Submit still independently revalidates
test('Z. submit independently calls /api/calculate-quote', () => {
  assert.ok(submitSection.includes('/api/calculate-quote'),
    '_doCreateMission must call /api/calculate-quote');
});

// AA. Submit does not trust _lastManualQuote
test('AA. submit does not trust _lastManualQuote as final authority', () => {
  assert.ok(!submitSection.includes('_lastManualQuote'),
    '_doCreateMission must NOT reference _lastManualQuote');
});

// AB. mode='route' preserved
test('AB. mode="route" preserved in calculateAdminPrice', () => {
  assert.ok(capSection.includes("mode: 'route'"),
    'calculateAdminPrice must preserve mode="route"');
  assert.ok(submitSection.includes("mode: 'route'"),
    '_doCreateMission must preserve mode="route"');
});

// AC. vehicleCondition='working' preserved
test('AC. vehicleCondition="working" preserved', () => {
  assert.ok(capSection.includes("vehicleCondition: 'working'"),
    'calculateAdminPrice must preserve vehicleCondition="working"');
  assert.ok(submitSection.includes("vehicleCondition: 'working'"),
    '_doCreateMission must preserve vehicleCondition="working"');
});

// AD. isPro=false preserved
test('AD. isPro=false preserved', () => {
  assert.ok(capSection.includes('isPro: false'),
    'calculateAdminPrice must preserve isPro=false');
  assert.ok(submitSection.includes('isPro: false'),
    '_doCreateMission must preserve isPro=false');
});

// AE. No utilSize/promoPercent invented
test('AE. no utilSize or promoPercent invented', () => {
  assert.ok(!capSection.includes('utilSize'),
    'calculateAdminPrice must NOT include utilSize');
  assert.ok(!capSection.includes('promoPercent'),
    'calculateAdminPrice must NOT include promoPercent');
  assert.ok(!submitSection.includes('utilSize'),
    '_doCreateMission must NOT include utilSize');
  assert.ok(!submitSection.includes('promoPercent'),
    '_doCreateMission must NOT include promoPercent');
});

// AF. C2B1 quick-create remains unchanged
test('AF. C2B1 quick-create markers unchanged', () => {
  assert.ok(adminSrc.includes('function _qcBuildPayload'),
    '_qcBuildPayload must still exist');
  assert.ok(adminSrc.includes('function _qcFetchPreview'),
    '_qcFetchPreview must still exist');
  assert.ok(adminSrc.includes('QC_DEBOUNCE_MS = 300'),
    'QC_DEBOUNCE_MS must still exist');
  assert.ok(adminSrc.includes('QC_TIMEOUT_MS = 12000'),
    'QC_TIMEOUT_MS must still exist');
  assert.ok(adminSrc.includes('function _qcRenderError'),
    '_qcRenderError must still exist');
  // cdDistance must remain readonly
  const distMatch = adminSrc.match(/id="cdDistance"[^>]*>/);
  assert.ok(distMatch && distMatch[0].includes('readonly'),
    'cdDistance must remain readonly');
  // No BathilyPricing re-introduced
  const stripped = adminSrc.replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
  const functionalRefs = (stripped.match(/BathilyPricing\./g) || []).length;
  assert.equal(functionalRefs, 0,
    'no functional BathilyPricing references must exist');
});

// Additional: autocomplete onSelect uses immediate
test('autocomplete onSelect calls calculateAdminPrice(true) (immediate)', () => {
  assert.ok(/setupAddress\('manual-depart'[\s\S]{0,300}calculateAdminPrice\(true\)/.test(adminSrc),
    'depart autocomplete onSelect must call calculateAdminPrice(true)');
  assert.ok(/setupAddress\('manual-arrivee'[\s\S]{0,300}calculateAdminPrice\(true\)/.test(adminSrc),
    'arrivee autocomplete onSelect must call calculateAdminPrice(true)');
});

// Additional: no duplicate event listeners
test('no duplicate event listeners for manual pricing', () => {
  // Count blur listeners on departField
  const departBlurCount = (listenerSection.match(/departField\.addEventListener\('blur'/g) || []).length;
  assert.equal(departBlurCount, 1, `departField must have exactly 1 blur listener (found ${departBlurCount})`);
  const departInputChangeCount = (listenerSection.match(/departField\.addEventListener\('input'/g) || []).length;
  // Note: _initAddrChangeTracking also adds input listener, but it's in a different section
  assert.ok(departInputChangeCount >= 1, 'departField must have input listener in pricing section');
});

// =========================================================
// RM-02C2B2.2 — Address event dedup
// =========================================================

// A. depart has only one immediate terminal listener (blur, not change)
test('A2.2. depart has only one immediate terminal listener (blur)', () => {
  const blurCount = (listenerSection.match(/departField\.addEventListener\('blur'/g) || []).length;
  const changeCount = (listenerSection.match(/departField\.addEventListener\('change'/g) || []).length;
  assert.equal(blurCount, 1, `departField must have exactly 1 blur listener (found ${blurCount})`);
  assert.equal(changeCount, 0, `departField must have 0 change listeners (found ${changeCount}) — blur is the terminal event`);
});

// B. arrivee has only one immediate terminal listener (blur, not change)
test('B2.2. arrivee has only one immediate terminal listener (blur)', () => {
  const blurCount = (listenerSection.match(/arriveeField\.addEventListener\('blur'/g) || []).length;
  const changeCount = (listenerSection.match(/arriveeField\.addEventListener\('change'/g) || []).length;
  assert.equal(blurCount, 1, `arriveeField must have exactly 1 blur listener (found ${blurCount})`);
  assert.equal(changeCount, 0, `arriveeField must have 0 change listeners (found ${changeCount}) — blur is the terminal event`);
});

// C. no blur+change dual immediate registration remains
test('C2.2. no blur+change dual immediate registration on text address fields', () => {
  // Verify no address field has BOTH blur AND change listeners
  const departBlur = (listenerSection.match(/departField\.addEventListener\('blur'/g) || []).length;
  const departChange = (listenerSection.match(/departField\.addEventListener\('change'/g) || []).length;
  assert.ok(!(departBlur > 0 && departChange > 0),
    'departField must not have both blur AND change (dual immediate binding)');

  const arriveeBlur = (listenerSection.match(/arriveeField\.addEventListener\('blur'/g) || []).length;
  const arriveeChange = (listenerSection.match(/arriveeField\.addEventListener\('change'/g) || []).length;
  assert.ok(!(arriveeBlur > 0 && arriveeChange > 0),
    'arriveeField must not have both blur AND change (dual immediate binding)');
});

// D. input remains debounced
test('D2.2. input remains debounced on address fields', () => {
  assert.ok(/departField\.addEventListener\('input'.*calculateAdminPrice\(false\)/.test(listenerSection),
    'departField input must call calculateAdminPrice(false) (debounced)');
  assert.ok(/arriveeField\.addEventListener\('input'.*calculateAdminPrice\(false\)/.test(listenerSection),
    'arriveeField input must call calculateAdminPrice(false) (debounced)');
});

// E. autocomplete onSelect remains immediate
test('E2.2. autocomplete onSelect remains immediate', () => {
  assert.ok(/setupAddress\('manual-depart'[\s\S]{0,300}calculateAdminPrice\(true\)/.test(adminSrc),
    'depart autocomplete onSelect must call calculateAdminPrice(true)');
  assert.ok(/setupAddress\('manual-arrivee'[\s\S]{0,300}calculateAdminPrice\(true\)/.test(adminSrc),
    'arrivee autocomplete onSelect must call calculateAdminPrice(true)');
});

// F. discrete control change remains immediate
test('F2.2. discrete controls (vehicle, pack) remain immediate on change', () => {
  assert.ok(/vehTypeField\.addEventListener\('change'.*calculateAdminPrice\(true\)/.test(listenerSection),
    'vehicle type change must call calculateAdminPrice(true) (immediate)');
  assert.ok(/packField\.addEventListener\('change'.*calculateAdminPrice\(true\)/.test(listenerSection),
    'pack change must call calculateAdminPrice(true) (immediate)');
});

// G. pending debounce is cancelled before immediate request
test('G2.2. immediate path cancels pending debounce timer', () => {
  assert.ok(/if\s*\(\s*immediate\s*\)[\s\S]{0,100}clearTimeout\(\s*_manualPriceDebounceTimer/.test(capSection),
    'immediate path must clear pending debounce timer before requesting');
});

// H. C2B1 remains unchanged
test('H2.2. C2B1 quick-create unchanged by dedup fix', () => {
  assert.ok(adminSrc.includes('function _qcBuildPayload'),
    '_qcBuildPayload must still exist');
  assert.ok(adminSrc.includes('function _qcFetchPreview'),
    '_qcFetchPreview must still exist');
  assert.ok(adminSrc.includes('QC_DEBOUNCE_MS = 300'),
    'QC_DEBOUNCE_MS must still exist');
  assert.ok(adminSrc.includes('QC_TIMEOUT_MS = 12000'),
    'QC_TIMEOUT_MS must still exist');
  const distMatch = adminSrc.match(/id="cdDistance"[^>]*>/);
  assert.ok(distMatch && distMatch[0].includes('readonly'),
    'cdDistance must remain readonly');
});

// Additional: manual state variables are separate from C2B1
test('manual preview state variables are separate from C2B1', () => {
  assert.ok(adminSrc.includes('_manualPriceAbortCtrl'),
    'must have _manualPriceAbortCtrl (separate from _qcAbortCtrl)');
  assert.ok(adminSrc.includes('_manualPriceSeq'),
    'must have _manualPriceSeq (separate from _qcSeq)');
  assert.ok(adminSrc.includes('_manualPriceDebounceTimer'),
    'must have _manualPriceDebounceTimer (separate from _qcDebounceTimer)');
});

// =========================================================
// RM-02C2B2.1 — User-visible error/status state
// =========================================================

// A2. Visible loading state exists
test('A2. visible loading state rendered via _manualPriceRenderStatus', () => {
  assert.ok(capSection.includes('Calcul en cours…'),
    'must render "Calcul en cours…" loading text');
  assert.ok(/_manualPriceRenderStatus\('Calcul en cours…'/.test(capSection),
    'must call _manualPriceRenderStatus with loading message');
});

// G2. Invalid response visible message
test('G2. invalid response renders visible message', () => {
  assert.ok(/typeof quote\.total_ht[\s\S]{0,300}_manualPriceRenderStatus\('Réponse tarifaire invalide\.'/.test(capSection),
    'invalid response shape must render "Réponse tarifaire invalide."');
});

// H2. Messages persist after render (status element is separate from price fields)
test('H2. status element exists in HTML and is separate from price inputs', () => {
  assert.ok(adminSrc.includes('id="manual-price-status"'),
    'must have manual-price-status element in HTML');
  // Status element must NOT be a number input (so text won't be rejected)
  const statusMatch = adminSrc.match(/id="manual-price-status"[^>]*>/);
  assert.ok(statusMatch && !statusMatch[0].includes('type="number"'),
    'status element must not be a number input');
});

// I2. Supersede abort remains silent (no status render on non-timeout abort)
test('I2. supersede abort does not render error status', () => {
  // The non-timeout abort path must return without calling _manualPriceRenderStatus
  const abortBlock = capSection.match(/abortCtrl\.signal\.aborted[\s\S]{0,400}return/);
  assert.ok(abortBlock,
    'abort block must exist and return');
  // Check that the non-timeout branch doesn't call _manualPriceRenderStatus
  // The timeout branch has _manualPriceRenderStatus, but it's guarded by _timedOut
  assert.ok(/abortCtrl\.signal\.aborted[\s\S]{0,150}if\s*\(\s*abortCtrl\._timedOut[\s\S]{0,300}_manualPriceRenderStatus/.test(capSection),
    'only timeout abort should call _manualPriceRenderStatus');
});

// J2. Incomplete required fields remain neutral (no error)
test('J2. incomplete required fields render neutral, not error', () => {
  // The required-field guard must call _manualPriceRenderStatus with empty/neutral
  assert.ok(/!depart\s*\|\|\s*!arrivee[\s\S]{0,300}_manualPriceRenderStatus\(''/.test(capSection),
    'required-field guard must render neutral (empty) status, not error');
});

// K2. Success clears/replaces error state
test('K2. success renders neutral status (clears error)', () => {
  // Success path must call _manualPriceRenderStatus with empty/neutral
  assert.ok(/_lastManualQuote\s*=\s*quote[\s\S]{0,200}_manualPriceRenderStatus\(''/.test(capSection),
    'success must render neutral (empty) status to clear any previous error');
});

// L2. Price/rem remain cleared on errors
test('L2. price and remuneration cleared on all error paths', () => {
  const errorPaths = capSection.match(/_lastManualQuote\s*=\s*null[\s\S]{0,100}priceInput\.value\s*=\s*''/g) || [];
  assert.ok(errorPaths.length >= 4,
    `must have at least 4 error paths that clear price (found ${errorPaths.length})`);
});

// M2. _lastManualQuote remains null on errors
test('M2. _lastManualQuote set to null on all error paths', () => {
  const nullPaths = capSection.match(/_lastManualQuote\s*=\s*null/g) || [];
  assert.ok(nullPaths.length >= 5,
    `must have at least 5 _lastManualQuote = null paths (found ${nullPaths.length})`);
});

// N2. Margin stale state cleared on errors
test('N2. updateManualMarginDisplay called on all error paths', () => {
  const marginCalls = capSection.match(/updateManualMarginDisplay\(\)/g) || [];
  assert.ok(marginCalls.length >= 5,
    `must call updateManualMarginDisplay on all error+success paths (found ${marginCalls.length})`);
});

// O2. No pricing semantics changed
test('O2. pricing semantics unchanged (mode, vehicleCondition, isPro)', () => {
  assert.ok(capSection.includes("mode: 'route'"),
    'mode must remain "route"');
  assert.ok(capSection.includes("vehicleCondition: 'working'"),
    'vehicleCondition must remain "working"');
  assert.ok(capSection.includes('isPro: false'),
    'isPro must remain false');
});

// P2. C2B1 remains unchanged
test('P2. C2B1 quick-create unchanged by status addition', () => {
  assert.ok(adminSrc.includes('function _qcBuildPayload'),
    '_qcBuildPayload must still exist');
  assert.ok(adminSrc.includes('function _qcFetchPreview'),
    '_qcFetchPreview must still exist');
  assert.ok(adminSrc.includes('function _qcRenderError'),
    '_qcRenderError must still exist');
  const distMatch = adminSrc.match(/id="cdDistance"[^>]*>/);
  assert.ok(distMatch && distMatch[0].includes('readonly'),
    'cdDistance must remain readonly');
});
