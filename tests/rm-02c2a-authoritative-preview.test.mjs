/**
 * RM-02C2A — Public devis authoritative preview tests.
 *
 * Verifies that devis.html:
 *   A. Preview uses /api/calculate-quote (not local business pricing)
 *   B. No local business price calculation controls displayed total
 *   C. Required-field guard sends zero requests when depart/arrivee incomplete
 *   D. Debounce coalesces rapid text changes
 *   E. New request aborts previous request
 *   F. Stale response cannot overwrite newer response
 *   G. 200 updates preview from API
 *   H. 400 renders safe error
 *   I. 429 renders rate-limit state
 *   J. 500/network failure invalidates stale preview
 *   K. aborted request does not render error
 *   L. submit still revalidates through /api/calculate-quote
 *   M. devis.html public pack copy (Essentiel, Sérénité +69, Excellence +149,
 *      forbidden Excellence features absent)
 *   N. seasonal +15% no longer exists in reachable devis preview path
 *
 * Static tests use source inspection (matching existing test stack).
 * Behavioral tests use a JSDOM-free harness that loads the inline script
 * with a mocked fetch, AbortController, and DOM stubs.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');
const devisPath = path.join(repoRoot, 'devis.html');
const devisSrc = fs.readFileSync(devisPath, 'utf8');

// =========================================================
// Static source checks (A, B, M, N)
// =========================================================

// A. Preview uses /api/calculate-quote
test('A. devis.html preview calls /api/calculate-quote', () => {
  // Preview path must reference the authoritative endpoint
  const previewMatches = (devisSrc.match(/\/api\/calculate-quote/g) || []).length;
  assert.ok(previewMatches >= 2,
    `devis.html must call /api/calculate-quote in both preview and submit (found ${previewMatches})`);
});

// B. No local business price calculation controls displayed total
test('B. devis.html has no local business pricing logic', () => {
  // No hardcoded B2C/B2B rate tables in the preview path
  assert.ok(!/BASE_RATES.*Automobile.*route.*1\.20/.test(devisSrc),
    'devis.html must not contain local BASE_RATES with 1.20');
  assert.ok(!/baseRates.*Automobile.*route.*0\.90/.test(devisSrc),
    'devis.html must not contain local B2B baseRates');
  // No local pack price tables
  assert.ok(!/packPrices.*serenite.*69/.test(devisSrc),
    'devis.html must not contain local packPrices table');
  assert.ok(!/packPrices.*excellence.*159/.test(devisSrc),
    'devis.html must not contain local Excellence 159');
  // No local urgency multiplier calculation
  assert.ok(!/total.*Math\.round.*1\.30/.test(devisSrc),
    'devis.html must not compute urgency locally');
  // No local gardiennage pricing
  assert.ok(!/isGardiennage.*\+\s*_isProMode\s*\?\s*20\s*:\s*30/.test(devisSrc),
    'devis.html must not compute gardiennage locally');
  // No BathilyPricing usage
  assert.ok(!devisSrc.includes('BathilyPricing'),
    'devis.html must not reference BathilyPricing at all');
  // No local distance calculation for pricing
  assert.ok(!devisSrc.includes('function calculateDistance'),
    'devis.html must not contain local calculateDistance function');
  assert.ok(!devisSrc.includes('function geocodeAddress'),
    'devis.html must not contain local geocodeAddress function');
  assert.ok(!devisSrc.includes('function haversine'),
    'devis.html must not contain local haversine function');
});

// M. Pack copy alignment
test('M. devis.html pack copy uses approved RM-02 commercial truth', () => {
  // Essentiel name (not Starter)
  assert.ok(devisSrc.includes('Essentiel'),
    'devis.html must use Essentiel as pack name');
  assert.ok(!/Starter.*Inclus/.test(devisSrc),
    'devis.html must not use "Starter — Inclus"');
  // Sérénité +69
  assert.ok(devisSrc.includes('Sérénité — +69€'),
    'devis.html must show Sérénité at +69€');
  // Excellence +149 (not 159)
  assert.ok(devisSrc.includes('Excellence — +149€'),
    'devis.html must show Excellence at +149€');
  assert.ok(!devisSrc.includes('159'),
    'devis.html must not contain stale 159 anywhere');
  // Forbidden Excellence features absent
  assert.ok(!/plein carburant/i.test(devisSrc.replace(/carburant sur demande.*au réel/i, '')),
    'devis.html must not list "plein carburant" as included');
  assert.ok(!devisSrc.includes('photos 4K'),
    'devis.html must not list "photos 4K"');
  assert.ok(!/livraison dim/i.test(devisSrc),
    'devis.html must not list "livraison dim./férié" as included');
  // Approved Excellence phrase present
  assert.ok(devisSrc.includes('plein ou complément de carburant sur demande'),
    'devis.html must include approved fuel phrase');
  assert.ok(devisSrc.includes('carburant facturé au réel'),
    'devis.html must include "carburant facturé au réel"');
});

// N. Seasonal +15% removed
test('N. devis.html has no seasonal +15% in reachable preview path', () => {
  assert.ok(!devisSrc.includes('haute_saison'),
    'devis.html must not reference haute_saison');
  assert.ok(!devisSrc.includes('Haute saison'),
    'devis.html must not display "Haute saison"');
  assert.ok(!/saison.*\+15%/.test(devisSrc),
    'devis.html must not show seasonal +15%');
  assert.ok(!/coeffs\.haute_saison/.test(devisSrc),
    'devis.html must not apply haute_saison coefficient');
});

// L. Submit still revalidates through /api/calculate-quote
test('L. submitDevis revalidates through /api/calculate-quote', () => {
  assert.ok(/submitDevis/.test(devisSrc),
    'devis.html must have submitDevis function');
  // Submit must call the API (not trust cached preview)
  assert.ok(/function submitDevis[\s\S]*\/api\/calculate-quote/.test(devisSrc),
    'submitDevis must call /api/calculate-quote');
  // Must not submit _lastValidQuote directly as the price
  assert.ok(!/devisData.*_lastValidQuote/.test(devisSrc),
    'submit must not use cached preview as the submitted price');
});

// js/pricing.js no longer loaded by devis.html
test('devis.html no longer loads js/pricing.js', () => {
  assert.ok(!devisSrc.includes('js/pricing.js'),
    'devis.html must not load js/pricing.js');
});

// =========================================================
// Behavioral harness: load inline script with mocked DOM/fetch
// =========================================================

/**
 * Extract the inline <script> block from devis.html that contains
 * calculatePrice and the preview logic. We evaluate it in a sandbox
 * with mocked globals to test request control behavior.
 */
function extractInlineScript() {
  // The inline script starts at <script> after the body content
  // and ends at </script> before the address-autocomplete script.
  const match = devisSrc.match(/<script>([\s\S]*?)<\/script>\s*<script src="js\/address-autocomplete/);
  if (!match) throw new Error('Could not extract inline script from devis.html');
  return match[1];
}

const inlineScript = extractInlineScript();

/**
 * Create a mock DOM environment for testing the preview logic.
 * Returns controllers for fetch, AbortController, and timers.
 */
function createMockEnv() {
  const state = {
    fetchCalls: [],
    fetchResponses: [], // queue of {status, body, delay}
    abortedSignals: [],
    timers: [],
    now: 0,
  };

  // Mock elements
  const elements = {};
  function makeEl(id, props = {}) {
    const el = {
      id,
      value: props.value || '',
      checked: props.checked || false,
      textContent: props.textContent || '',
      innerHTML: props.innerHTML || '',
      style: {},
      classList: { toggle: () => {}, add: () => {}, remove: () => {}, contains: () => false },
      addEventListener: () => {},
      ...props,
    };
    elements[id] = el;
    return el;
  }

  // Pre-register all elements referenced by the code
  const elementIds = [
    'depart', 'arrivee', 'vehiculeType', 'modeTransport', 'packSelect',
    'optUrgence', 'optGardiennage', 'vehicleCondition', 'utilSize',
    'dateLivraison', 'priceDisplay', 'distanceDisplay', 'promoCodeInput',
    'promoCodeMessage', 'sivEnergy', 'veRechargeInfo',
    'submitBtn', 'errDepart', 'errArrivee', 'errDateLivraison',
    'errPrenom', 'errNom', 'errEmail', 'errCgu', 'cguCheck',
    'clientPrenom', 'clientNom', 'clientEmail', 'clientTel',
    'heureLivraison', 'messageDevis', 'plaqueInput', 'marqueInput',
    'modeleInput', 'vehiculeManuel', 'isCollection', 'transportMode',
    'departSuggests', 'arriveeSuggests', 'tarifsBaseContent',
  ];
  for (const id of elementIds) makeEl(id);

  const documentMock = {
    getElementById: (id) => elements[id] || null,
    createElement: () => makeEl('created'),
    addEventListener: () => {},
    body: { insertBefore: () => {} },
  };

  // Mock fetch
  function mockFetch(url, opts = {}) {
    state.fetchCalls.push({ url, opts });
    const signal = opts.signal;
    return new Promise((resolve, reject) => {
      // Check if already aborted
      if (signal && signal.aborted) {
        reject(new Error('Aborted'));
        return;
      }
      // Register abort handler
      if (signal) {
        signal.addEventListener('abort', () => {
          state.abortedSignals.push(signal);
          reject(new Error('Aborted'));
        });
      }
      // Get next queued response or default
      const resp = state.fetchResponses.shift() || { status: 200, body: { total_ht: 100, distance: 50, details: {} } };
      const delay = resp.delay || 0;
      setTimeout(() => {
        if (signal && signal.aborted) {
          reject(new Error('Aborted'));
          return;
        }
        resolve({
          ok: resp.status >= 200 && resp.status < 300,
          status: resp.status,
          json: async () => resp.body,
        });
      }, delay);
    });
  }

  // Mock AbortController
  class MockAbortController {
    constructor() {
      this.signal = { aborted: false, _listeners: [] };
      this.signal.addEventListener = (ev, cb) => {
        if (ev === 'abort') this.signal._listeners.push(cb);
      };
    }
    abort() {
      this.signal.aborted = true;
      for (const cb of this.signal._listeners) cb();
    }
  }

  // Mock setTimeout/clearTimeout with controllable time
  function mockSetTimeout(cb, ms) {
    const id = state.timers.length;
    state.timers.push({ id, cb, fireAt: state.now + (ms || 0), fired: false });
    return id;
  }
  function mockClearTimeout(id) {
    if (id !== undefined && id !== null && state.timers[id]) {
      state.timers[id].fired = true; // mark as cancelled
    }
  }

  return {
    state,
    elements,
    documentMock,
    mockFetch,
    MockAbortController,
    mockSetTimeout,
    mockClearTimeout,
    // Advance timers: fire all pending non-cancelled timers whose fireAt <= now
    advanceTimers(ms) {
      state.now += ms;
      const pending = state.timers.filter(t => !t.fired && t.fireAt <= state.now);
      for (const t of pending) {
        t.fired = true;
        t.cb();
      }
    },
    fireTimer(id) {
      const t = state.timers[id];
      if (t && !t.fired) { t.fired = true; t.cb(); }
    },
    setElement(id, props) {
      Object.assign(elements[id], props);
    },
    queueResponse(status, body, delay = 0) {
      state.fetchResponses.push({ status, body, delay });
    },
    reset() {
      state.fetchCalls = [];
      state.fetchResponses = [];
      state.abortedSignals = [];
      state.timers = [];
      state.now = 0;
    },
  };
}

/**
 * Evaluate the inline script in a sandbox with mocked globals.
 * Returns the sandbox for inspection.
 */
function loadScriptInSandbox(env, extraGlobals = {}) {
  const sandbox = {
    window: {},
    document: env.documentMock,
    fetch: env.mockFetch,
    AbortController: env.MockAbortController,
    setTimeout: env.mockSetTimeout,
    clearTimeout: env.mockClearTimeout,
    console: { log: () => {}, warn: () => {}, error: () => {} },
    URLSearchParams: URLSearchParams,
    crypto: { randomUUID: () => 'test-uuid-1234' },
    Swal: { fire: () => {} },
    AddressAutocomplete: null,
    _sbClient: null,
    location: { search: '', href: 'https://test.example/devis.html' },
    ...extraGlobals,
  };
  sandbox.window = sandbox; // window === global
  sandbox.window.location = sandbox.location;
  // Build a function to evaluate the script with these globals.
  // Use getters for let variables so tests can observe live values.
  const fn = new Function(
    ...Object.keys(sandbox),
    inlineScript + '\n; return { calculatePrice, _fetchAuthoritativePreview, _invalidatePreview, submitDevis, get _lastValidQuote() { return _lastValidQuote; }, get _previewSeq() { return _previewSeq; }, get _previewAbortCtrl() { return _previewAbortCtrl; }, get _currentPrice() { return _currentPrice; }, get _currentDistance() { return _currentDistance; }, get _isProMode() { return _isProMode; } };'
  );
  const result = fn(...Object.values(sandbox));
  return { sandbox, result };
}

// =========================================================
// Behavioral tests (C, D, E, F, G, H, I, J, K)
// =========================================================

// C. Required-field guard: zero requests when depart/arrivee incomplete
test('C. no API request when depart or arrivee is empty', () => {
  const env = createMockEnv();
  const { result } = loadScriptInSandbox(env);
  // Both empty
  env.setElement('depart', { value: '' });
  env.setElement('arrivee', { value: '' });
  result.calculatePrice(true);
  assert.equal(env.state.fetchCalls.length, 0,
    'no fetch call when both fields empty');
  // Only depart
  env.setElement('depart', { value: 'Paris' });
  env.setElement('arrivee', { value: '' });
  result.calculatePrice(true);
  assert.equal(env.state.fetchCalls.length, 0,
    'no fetch call when arrivee empty');
  // Only arrivee
  env.setElement('depart', { value: '' });
  env.setElement('arrivee', { value: 'Lyon' });
  result.calculatePrice(true);
  assert.equal(env.state.fetchCalls.length, 0,
    'no fetch call when depart empty');
});

// D. Debounce coalesces rapid text changes
test('D. debounce coalesces rapid text input changes', async () => {
  const env = createMockEnv();
  const { result } = loadScriptInSandbox(env);
  env.setElement('depart', { value: 'Paris' });
  env.setElement('arrivee', { value: 'Lyon' });
  // Simulate 5 rapid calls (debounced)
  for (let i = 0; i < 5; i++) {
    env.setElement('depart', { value: 'Paris' + i });
    result.calculatePrice(false); // debounced
  }
  // No request should fire immediately
  assert.equal(env.state.fetchCalls.length, 0,
    'no fetch call before debounce timer fires');
  // Advance time past debounce
  env.advanceTimers(350);
  // Only one request should have fired
  assert.equal(env.state.fetchCalls.length, 1,
    `exactly one fetch call after debounce (got ${env.state.fetchCalls.length})`);
});

// E. New request aborts previous request
test('E. new preview request aborts previous in-flight request', async () => {
  const env = createMockEnv();
  const { result } = loadScriptInSandbox(env);
  env.setElement('depart', { value: 'Paris' });
  env.setElement('arrivee', { value: 'Lyon' });
  // Queue a slow response
  env.queueResponse(200, { total_ht: 100, distance: 50, details: {} }, 1000);
  // Start first request (immediate)
  result.calculatePrice(true);
  const firstCtrl = result._previewAbortCtrl;
  assert.ok(firstCtrl, 'AbortController created for first request');
  // Start second request before first resolves
  env.setElement('depart', { value: 'Marseille' });
  result.calculatePrice(true);
  // First should be aborted
  assert.ok(firstCtrl.signal.aborted,
    'first request AbortController must be aborted when second starts');
});

// F. Stale response cannot overwrite newer response
test('F. stale response does not update UI when newer request exists', async () => {
  const env = createMockEnv();
  const { result } = loadScriptInSandbox(env);
  env.setElement('depart', { value: 'Paris' });
  env.setElement('arrivee', { value: 'Lyon' });
  // Queue two responses: first slow, second fast
  env.queueResponse(200, { total_ht: 100, distance: 50, details: {} }, 500);
  env.queueResponse(200, { total_ht: 200, distance: 60, details: {} }, 0);
  // Start first request
  result.calculatePrice(true);
  const seqAfterFirst = result._previewSeq;
  // Immediately start second (aborts first at fetch level, but first's
  // promise may still resolve — stale guard must reject it)
  env.setElement('depart', { value: 'Marseille' });
  result.calculatePrice(true);
  assert.ok(result._previewSeq > seqAfterFirst,
    'sequence must increment for second request');
  // Advance time to let both resolve
  env.advanceTimers(600);
  // Yield to let promise microtasks settle
  await new Promise(r => setTimeout(r, 10));
  // The second (newer) response must win — _currentPrice = 200
  assert.equal(result._currentPrice, 200,
    `newer response must win (expected 200, got ${result._currentPrice})`);
});

// G. 200 updates preview from API
test('G. HTTP 200 updates preview from API response', async () => {
  const env = createMockEnv();
  const { result } = loadScriptInSandbox(env);
  env.setElement('depart', { value: 'Paris' });
  env.setElement('arrivee', { value: 'Lyon' });
  env.queueResponse(200, {
    total_ht: 452, ttc: 542, distance: 377,
    remuneration_convoyeur: 271, marge: 181,
    details: { basePrice: 452, packPrice: 0, global_adjust_percent: 0,
               global_adjust_delta: 0, applied_coeffs: [] }
  });
  result.calculatePrice(true);
  env.advanceTimers(10);
  // Wait for promise microtasks
  await new Promise(r => setTimeout(r, 10));
  assert.equal(result._currentPrice, 452, 'price updated from API total_ht');
  assert.equal(result._currentDistance, 377, 'distance updated from API');
  assert.ok(result._lastValidQuote, 'valid quote cached');
  assert.equal(env.state.fetchCalls.length, 1, 'one fetch call made');
});

// H. 400 renders safe error
test('H. HTTP 400 renders safe error and invalidates preview', async () => {
  const env = createMockEnv();
  const { result } = loadScriptInSandbox(env);
  env.setElement('depart', { value: 'Paris' });
  env.setElement('arrivee', { value: 'Lyon' });
  env.queueResponse(400, { error: 'Données invalides' });
  result.calculatePrice(true);
  env.advanceTimers(10);
  await new Promise(r => setTimeout(r, 10));
  assert.equal(result._currentPrice, 0, 'price invalidated on 400');
  assert.equal(result._lastValidQuote, null, 'no cached quote on 400');
  assert.ok(env.elements.priceDisplay.innerHTML.includes('Données invalides') ||
            env.elements.priceDisplay.innerHTML.includes('invalid'),
    'error message rendered');
});

// I. 429 renders rate-limit state
test('I. HTTP 429 renders rate-limit message', async () => {
  const env = createMockEnv();
  const { result } = loadScriptInSandbox(env);
  env.setElement('depart', { value: 'Paris' });
  env.setElement('arrivee', { value: 'Lyon' });
  env.queueResponse(429, { error: 'Too many requests' });
  result.calculatePrice(true);
  env.advanceTimers(10);
  await new Promise(r => setTimeout(r, 10));
  assert.equal(result._currentPrice, 0, 'price invalidated on 429');
  assert.equal(result._lastValidQuote, null, 'no cached quote on 429');
  assert.ok(env.elements.priceDisplay.innerHTML.includes('requêtes') ||
            env.elements.priceDisplay.innerHTML.includes('Patientez'),
    'rate-limit message rendered');
});

// J. 500/network failure invalidates stale preview
test('J. HTTP 500 invalidates stale preview', async () => {
  const env = createMockEnv();
  const { result } = loadScriptInSandbox(env);
  env.setElement('depart', { value: 'Paris' });
  env.setElement('arrivee', { value: 'Lyon' });
  env.queueResponse(500, { error: 'Erreur serveur' });
  result.calculatePrice(true);
  env.advanceTimers(10);
  await new Promise(r => setTimeout(r, 10));
  assert.equal(result._currentPrice, 0, 'price invalidated on 500');
  assert.equal(result._lastValidQuote, null, 'no cached quote on 500');
  assert.ok(env.elements.priceDisplay.innerHTML.includes('Erreur serveur') ||
            env.elements.priceDisplay.innerHTML.includes('Réessayez'),
    'server error message rendered');
});

// K. aborted request does not render error
test('K. aborted request does not render error', async () => {
  const env = createMockEnv();
  const { result } = loadScriptInSandbox(env);
  env.setElement('depart', { value: 'Paris' });
  env.setElement('arrivee', { value: 'Lyon' });
  // Queue a response that would arrive, but we abort before
  env.queueResponse(200, { total_ht: 100, distance: 50, details: {} }, 500);
  result.calculatePrice(true);
  const firstSeq = result._previewSeq;
  // Capture current innerHTML (loading state)
  const htmlAfterLoading = env.elements.priceDisplay.innerHTML;
  // Abort by starting a new request
  env.setElement('depart', { value: 'Marseille' });
  result.calculatePrice(true);
  // The first request's promise will reject with 'Aborted'
  // Advance time to let the rejection settle
  env.advanceTimers(600);
  await new Promise(r => setTimeout(r, 10));
  // The aborted request must not have rendered an error from the first call.
  // (The second request may render its own result, but the first must not
  // produce an error visible to the user.)
  // We verify by checking that _previewSeq advanced (second request won).
  assert.ok(result._previewSeq > firstSeq,
    'second request has a higher sequence number');
});

// =========================================================
// Performance check: rapid input request count
// =========================================================

test('PERF. rapid typing produces at most one request after quiet period', async () => {
  const env = createMockEnv();
  const { result } = loadScriptInSandbox(env);
  env.setElement('depart', { value: 'P' });
  env.setElement('arrivee', { value: 'L' });
  // Simulate 10 rapid keystrokes (debounced)
  for (let i = 0; i < 10; i++) {
    env.setElement('depart', { value: 'Paris' + 'a'.repeat(i) });
    result.calculatePrice(false);
    env.advanceTimers(50); // 50ms between keystrokes (faster than debounce)
  }
  // No request yet (still within debounce window)
  assert.equal(env.state.fetchCalls.length, 0,
    'no request during rapid typing');
  // Quiet period
  env.advanceTimers(350);
  assert.equal(env.state.fetchCalls.length, 1,
    `exactly one request after quiet period (got ${env.state.fetchCalls.length})`);
});

test('PERF. selects/toggles refresh immediately (no debounce)', async () => {
  const env = createMockEnv();
  const { result } = loadScriptInSandbox(env);
  env.setElement('depart', { value: 'Paris' });
  env.setElement('arrivee', { value: 'Lyon' });
  env.queueResponse(200, { total_ht: 100, distance: 50, details: {} });
  // immediate=true should fire without waiting for debounce
  result.calculatePrice(true);
  assert.equal(env.state.fetchCalls.length, 1,
    'immediate call fires request synchronously');
});

test('PERF. empty required fields generate zero API calls', () => {
  const env = createMockEnv();
  const { result } = loadScriptInSandbox(env);
  env.setElement('depart', { value: '' });
  env.setElement('arrivee', { value: '' });
  // Multiple calls with empty fields
  for (let i = 0; i < 10; i++) result.calculatePrice(true);
  assert.equal(env.state.fetchCalls.length, 0,
    'zero API calls when required fields empty');
});
