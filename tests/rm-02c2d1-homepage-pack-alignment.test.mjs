/**
 * RM-02C2D1 — Homepage pack cards alignment + pack selection flow tests.
 *
 * Verifies:
 *   A. homepage uses "Essentiel", not "Formule Starter"
 *   B. homepage shows Sérénité +69€
 *   C. homepage shows Excellence +149€
 *   D. homepage no longer contains +159€
 *   E. homepage no longer contains "Photos pro 4K"
 *   F. homepage no longer contains included Sunday/public holiday claim
 *   G. homepage no longer contains included/free fuel claim
 *   H. homepage contains exact approved fuel wording
 *   I. homepage contains "Tout Essentiel inclus"
 *   J. duplicate "Suivi de mission" removed from Essentiel card
 *   K. badge is "LE PLUS CHOISI"
 *   L. homepage links use ?pack=starter|serenite|excellence
 *   M. devis reads ?pack=
 *   N. devis maps essentiel -> starter
 *   O. devis accepts starter
 *   P. devis accepts serenite
 *   Q. devis accepts excellence
 *   R. invalid pack is ignored safely
 *   S. URL-selected pack updates packSelect
 *   T. authoritative preview remains /api/calculate-quote
 *   U. submit remains /api/calculate-quote
 *   V. no BathilyPricing.calculate reintroduced
 *   W. C2A request control remains intact
 *   X. no backend pricing change
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
import crypto from 'node:crypto';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');
const indexPath = path.join(repoRoot, 'index.html');
const indexSrc = fs.readFileSync(indexPath, 'utf8');
const devisPath = path.join(repoRoot, 'devis.html');
const devisSrc = fs.readFileSync(devisPath, 'utf8');
const pricingPath = path.join(repoRoot, 'functions', '_pricing.js');
const pricingSrc = fs.readFileSync(pricingPath, 'utf8');

// =========================================================
// Homepage static checks (A-L)
// =========================================================

// A. homepage uses "Essentiel", not "Formule Starter"
test('A. homepage uses "Essentiel" as pack 1 name', () => {
  assert.ok(indexSrc.includes('Essentiel'),
    'homepage must contain "Essentiel"');
  assert.ok(!indexSrc.includes('Formule Starter'),
    'homepage must not contain "Formule Starter"');
});

// B. homepage shows Sérénité +69€
test('B. homepage shows Sérénité +69€', () => {
  assert.ok(/Sérénité.*\+69€/.test(indexSrc) || indexSrc.includes('Pack Sérénité'),
    'homepage must show Sérénité pack name');
  assert.ok(indexSrc.includes('+69€'),
    'homepage must show +69€ for Sérénité');
});

// C. homepage shows Excellence +149€
test('C. homepage shows Excellence +149€', () => {
  assert.ok(indexSrc.includes('Pack Excellence'),
    'homepage must show Excellence pack name');
  assert.ok(indexSrc.includes('+149€'),
    'homepage must show +149€ for Excellence');
});

// D. homepage no longer contains +159€
test('D. homepage no longer contains +159€', () => {
  assert.ok(!indexSrc.includes('+159€'),
    'homepage must not contain stale +159€');
  assert.ok(!/\b159€/.test(indexSrc),
    'homepage must not contain 159€ anywhere in pack section');
});

// E. homepage no longer contains "Photos pro 4K"
test('E. homepage no longer contains "Photos pro 4K"', () => {
  assert.ok(!/photos pro 4k/i.test(indexSrc),
    'homepage must not contain "Photos pro 4K"');
  assert.ok(!/photos 4k/i.test(indexSrc),
    'homepage must not contain "Photos 4K"');
});

// F. homepage no longer contains included Sunday/public holiday claim
test('F. homepage no longer contains included Sunday/public holiday claim', () => {
  assert.ok(!/livraison dim/i.test(indexSrc),
    'homepage must not contain "Livraison dim./férié"');
  assert.ok(!/dimanche.*férié/i.test(indexSrc),
    'homepage must not contain "dimanche/férié" as included');
});

// G. homepage no longer contains included/free fuel claim
test('G. homepage no longer contains included/free fuel claim', () => {
  // "Plein de carburant" (free/included) must be gone
  assert.ok(!/plein de carburant/i.test(indexSrc),
    'homepage must not contain "Plein de carburant" as included/free');
  // "carburant offert" must be gone
  assert.ok(!/carburant offert/i.test(indexSrc),
    'homepage must not contain "carburant offert"');
});

// H. homepage contains exact approved fuel wording
test('H. homepage contains exact approved fuel wording', () => {
  assert.ok(indexSrc.includes('Plein ou complément de carburant sur demande'),
    'homepage must contain approved fuel phrase start');
  assert.ok(indexSrc.includes('carburant facturé au réel'),
    'homepage must contain "carburant facturé au réel"');
});

// I. homepage contains "Tout Essentiel inclus"
test('I. homepage contains "Tout Essentiel inclus"', () => {
  assert.ok(indexSrc.includes('Tout Essentiel inclus'),
    'homepage must contain "Tout Essentiel inclus" in Sérénité card');
  assert.ok(!indexSrc.includes('Tout Starter inclus'),
    'homepage must not contain stale "Tout Starter inclus"');
});

// J. duplicate "Suivi de mission" removed from Essentiel card
test('J. duplicate "Suivi de mission" removed from Essentiel card', () => {
  // Count occurrences of "Suivi de mission" in the pack cards section
  // Extract the pack cards section to avoid counting other sections
  const packSectionMatch = indexSrc.match(/Packs de service[\s\S]*?Niveaux de service optionnels[\s\S]*?<\/div>\s*<\/div>/);
  const packSection = packSectionMatch ? packSectionMatch[0] : indexSrc;
  const suiviCount = (packSection.match(/Suivi de mission/g) || []).length;
  assert.equal(suiviCount, 1,
    `pack cards section must contain "Suivi de mission" exactly once (found ${suiviCount})`);
});

// K. badge is "LE PLUS CHOISI"
test('K. badge is "LE PLUS CHOISI"', () => {
  assert.ok(indexSrc.includes('LE PLUS CHOISI'),
    'homepage must contain "LE PLUS CHOISI" badge');
  assert.ok(!/Plus populaire/i.test(indexSrc),
    'homepage must not contain stale "Plus populaire" badge');
});

// L. homepage links use ?pack=starter|serenite|excellence
test('L. homepage links use ?pack=starter|serenite|excellence', () => {
  assert.ok(indexSrc.includes('devis.html?pack=starter'),
    'homepage must link to devis.html?pack=starter');
  assert.ok(indexSrc.includes('devis.html?pack=serenite'),
    'homepage must link to devis.html?pack=serenite');
  assert.ok(indexSrc.includes('devis.html?pack=excellence'),
    'homepage must link to devis.html?pack=excellence');
});

// =========================================================
// CTA semantic markup checks
// =========================================================

test('CTA. homepage pack cards use semantic <a> elements (not div onclick)', () => {
  // Must have <a href="devis.html?pack=..."> for each card
  assert.ok(/<a\s+href="devis\.html\?pack=starter"/.test(indexSrc),
    'homepage must use <a href> for Starter/Essentiel card');
  assert.ok(/<a\s+href="devis\.html\?pack=serenite"/.test(indexSrc),
    'homepage must use <a href> for Sérénité card');
  assert.ok(/<a\s+href="devis\.html\?pack=excellence"/.test(indexSrc),
    'homepage must use <a href> for Excellence card');
  // Must not have onclick="window.location.href='devis.html?pack=...'"
  assert.ok(!/onclick="window\.location\.href='devis\.html\?pack=/.test(indexSrc),
    'homepage must not use inline onclick for pack card navigation');
});

test('CTA. no nested interactive elements inside pack card <a> tags', () => {
  // Extract each pack card <a> block and check no nested <a> or <button>
  const cardRegex = /<a\s+href="devis\.html\?pack=(starter|serenite|excellence)"[\s\S]*?<\/a>/g;
  const cards = indexSrc.match(cardRegex) || [];
  assert.ok(cards.length === 3, `expected 3 pack card <a> elements, found ${cards.length}`);
  for (const card of cards) {
    // Extract inner content only (strip the card's own opening <a ...> and closing </a>)
    const openTagEnd = card.indexOf('>');
    const inner = card.slice(openTagEnd + 1, -4); // remove opening tag and </a>
    // No nested <a> inside the card content
    assert.ok(!/<a\s/i.test(inner), 'pack card <a> must not contain nested <a> elements');
    // No nested <button> inside the card <a>
    assert.ok(!/<button/i.test(inner),
      'pack card <a> must not contain nested <button> elements');
  }
});

// =========================================================
// Devis URL param static checks (M, T, U, V, W, X)
// =========================================================

// M. devis reads ?pack=
test('M. devis reads ?pack= URL param', () => {
  assert.ok(/urlParams\.get\(['"]pack['"]\)/.test(devisSrc),
    'devis.html must read ?pack= from URLSearchParams');
});

// T. authoritative preview remains /api/calculate-quote
test('T. devis.html preview still calls /api/calculate-quote', () => {
  const previewMatches = (devisSrc.match(/\/api\/calculate-quote/g) || []).length;
  assert.ok(previewMatches >= 2,
    `devis.html must call /api/calculate-quote in both preview and submit (found ${previewMatches})`);
});

// U. submit remains /api/calculate-quote
test('U. devis.html submit still calls /api/calculate-quote', () => {
  assert.ok(/function submitDevis[\s\S]*\/api\/calculate-quote/.test(devisSrc),
    'submitDevis must call /api/calculate-quote');
});

// V. no BathilyPricing.calculate reintroduced
test('V. devis.html does not call BathilyPricing.calculate', () => {
  assert.ok(!devisSrc.includes('BathilyPricing.calculate'),
    'devis.html must not call BathilyPricing.calculate()');
  assert.ok(!devisSrc.includes('BathilyPricing'),
    'devis.html must not reference BathilyPricing at all');
});

// W. C2A request control remains intact
test('W. devis.html C2A request control structures intact', () => {
  assert.ok(devisSrc.includes('function calculatePrice'),
    'devis.html must have calculatePrice function');
  assert.ok(devisSrc.includes('_fetchAuthoritativePreview'),
    'devis.html must have _fetchAuthoritativePreview');
  assert.ok(devisSrc.includes('_buildQuotePayload'),
    'devis.html must have _buildQuotePayload');
  assert.ok(devisSrc.includes('_invalidatePreview'),
    'devis.html must have _invalidatePreview');
  assert.ok(devisSrc.includes('_previewAbortCtrl'),
    'devis.html must have _previewAbortCtrl');
  assert.ok(devisSrc.includes('_previewSeq'),
    'devis.html must have _previewSeq');
  assert.ok(devisSrc.includes('AbortController'),
    'devis.html must use AbortController');
});

// X. no backend pricing change
test('X. functions/_pricing.js pack prices unchanged', () => {
  assert.ok(pricingSrc.includes('PACK_PRICES_PUBLIC = { starter: 0, serenite: 69, excellence: 149 }'),
    'backend PACK_PRICES_PUBLIC must be { starter: 0, serenite: 69, excellence: 149 }');
  assert.ok(pricingSrc.includes('PACK_PRICES_PRO = { starter: 0, serenite: 55, excellence: 125 }'),
    'backend PACK_PRICES_PRO must be { starter: 0, serenite: 55, excellence: 125 }');
  assert.ok(pricingSrc.includes("CANONICAL_PACKS = ['starter', 'serenite', 'excellence']"),
    'backend CANONICAL_PACKS must be unchanged');
  // essentiel alias must still exist
  assert.ok(/essentiel.*starter/.test(pricingSrc),
    'backend must still map essentiel -> starter alias');
});

// =========================================================
// Behavioral harness: test devis URL param reading (N-S)
// =========================================================

/**
 * Extract the inline <script> block from devis.html that contains
 * the DOMContentLoaded handler and preview logic.
 */
function extractInlineScript() {
  const match = devisSrc.match(/<script>([\s\S]*?)<\/script>\s*<script src="js\/address-autocomplete/);
  if (!match) throw new Error('Could not extract inline script from devis.html');
  return match[1];
}

const inlineScript = extractInlineScript();

/**
 * Create a mock DOM environment for testing the DOMContentLoaded handler.
 * The key difference from C2A harness: document.addEventListener captures
 * the DOMContentLoaded callback so we can fire it manually.
 */
function createMockEnv(locationSearch) {
  const state = {
    fetchCalls: [],
    fetchResponses: [],
    abortedSignals: [],
    timers: [],
    now: 0,
  };

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

  // Capture DOMContentLoaded callback
  let domReadyCallback = null;
  const documentMock = {
    getElementById: (id) => elements[id] || null,
    createElement: () => makeEl('created'),
    addEventListener: (event, cb) => {
      if (event === 'DOMContentLoaded') domReadyCallback = cb;
    },
    body: { insertBefore: () => {} },
  };

  function mockFetch(url, opts = {}) {
    state.fetchCalls.push({ url, opts });
    const signal = opts.signal;
    return new Promise((resolve, reject) => {
      if (signal && signal.aborted) { reject(new Error('Aborted')); return; }
      if (signal) {
        signal.addEventListener('abort', () => {
          state.abortedSignals.push(signal);
          reject(new Error('Aborted'));
        });
      }
      const resp = state.fetchResponses.shift() || { status: 200, body: { total_ht: 100, distance: 50, details: {} } };
      const delay = resp.delay || 0;
      setTimeout(() => {
        if (signal && signal.aborted) { reject(new Error('Aborted')); return; }
        resolve({ ok: resp.status >= 200 && resp.status < 300, status: resp.status, json: async () => resp.body });
      }, delay);
    });
  }

  class MockAbortController {
    constructor() {
      this.signal = { aborted: false, _listeners: [] };
      this.signal.addEventListener = (ev, cb) => { if (ev === 'abort') this.signal._listeners.push(cb); };
    }
    abort() { this.signal.aborted = true; for (const cb of this.signal._listeners) cb(); }
  }

  function mockSetTimeout(cb, ms) {
    const id = state.timers.length;
    state.timers.push({ id, cb, fireAt: state.now + (ms || 0), fired: false });
    return id;
  }
  function mockClearTimeout(id) {
    if (id !== undefined && id !== null && state.timers[id]) state.timers[id].fired = true;
  }

  // Mock localStorage
  const localStorageMock = {
    getItem: () => null,
    removeItem: () => {},
  };

  return {
    state, elements, documentMock, mockFetch, MockAbortController,
    mockSetTimeout, mockClearTimeout, localStorageMock,
    getDomReadyCallback: () => domReadyCallback,
    advanceTimers(ms) {
      state.now += ms;
      const pending = state.timers.filter(t => !t.fired && t.fireAt <= state.now);
      for (const t of pending) { t.fired = true; t.cb(); }
    },
    setElement(id, props) { Object.assign(elements[id], props); },
    queueResponse(status, body, delay = 0) { state.fetchResponses.push({ status, body, delay }); },
  };
}

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
    localStorage: env.localStorageMock,
    location: { search: extraGlobals._locationSearch || '', href: 'https://test.example/devis.html' },
    ...extraGlobals,
  };
  sandbox.window = sandbox;
  sandbox.window.location = sandbox.location;
  delete extraGlobals._locationSearch;

  const fn = new Function(
    ...Object.keys(sandbox),
    inlineScript + '\n; return { calculatePrice, _fetchAuthoritativePreview, _invalidatePreview, _buildQuotePayload, submitDevis, get _lastValidQuote() { return _lastValidQuote; }, get _previewSeq() { return _previewSeq; }, get _previewAbortCtrl() { return _previewAbortCtrl; }, get _currentPrice() { return _currentPrice; }, get _currentDistance() { return _currentDistance; }, get _isProMode() { return _isProMode; } };'
  );
  const result = fn(...Object.values(sandbox));
  return { sandbox, result };
}

// =========================================================
// Behavioral tests: devis URL param reading (N-S)
// =========================================================

// N. devis maps essentiel -> starter
test('N. devis maps essentiel -> starter', () => {
  const env = createMockEnv();
  const { result } = loadScriptInSandbox(env, { _locationSearch: '?pack=essentiel' });
  const domReady = env.getDomReadyCallback();
  assert.ok(domReady, 'DOMContentLoaded callback must be registered');
  // Fire DOMContentLoaded
  domReady();
  // packSelect must be set to 'starter'
  assert.equal(env.elements.packSelect.value, 'starter',
    'devis must map essentiel -> starter');
});

// O. devis accepts starter
test('O. devis accepts starter', () => {
  const env = createMockEnv();
  const { result } = loadScriptInSandbox(env, { _locationSearch: '?pack=starter' });
  env.getDomReadyCallback()();
  assert.equal(env.elements.packSelect.value, 'starter',
    'devis must accept ?pack=starter');
});

// P. devis accepts serenite
test('P. devis accepts serenite', () => {
  const env = createMockEnv();
  const { result } = loadScriptInSandbox(env, { _locationSearch: '?pack=serenite' });
  env.getDomReadyCallback()();
  assert.equal(env.elements.packSelect.value, 'serenite',
    'devis must accept ?pack=serenite');
});

// Q. devis accepts excellence
test('Q. devis accepts excellence', () => {
  const env = createMockEnv();
  const { result } = loadScriptInSandbox(env, { _locationSearch: '?pack=excellence' });
  env.getDomReadyCallback()();
  assert.equal(env.elements.packSelect.value, 'excellence',
    'devis must accept ?pack=excellence');
});

// R. invalid pack is ignored safely
test('R. invalid pack value is ignored safely', () => {
  const env = createMockEnv();
  // Set a known initial value to verify it's not changed
  env.elements.packSelect.value = 'serenite';
  const { result } = loadScriptInSandbox(env, { _locationSearch: '?pack=invalidpack' });
  env.getDomReadyCallback()();
  // packSelect should remain at its initial value (not changed to invalid)
  assert.equal(env.elements.packSelect.value, 'serenite',
    'invalid pack value must not change packSelect');
});

test('R2. no pack param leaves default selection', () => {
  const env = createMockEnv();
  env.elements.packSelect.value = 'starter';
  const { result } = loadScriptInSandbox(env, { _locationSearch: '' });
  env.getDomReadyCallback()();
  assert.equal(env.elements.packSelect.value, 'starter',
    'no pack param must leave default selection');
});

// S. URL-selected pack updates packSelect and triggers preview
test('S. URL-selected pack updates packSelect and triggers preview refresh', async () => {
  const env = createMockEnv();
  // Pre-fill addresses so calculatePrice has something to calculate
  env.elements.depart.value = 'Paris';
  env.elements.arrivee.value = 'Lyon';
  const { result } = loadScriptInSandbox(env, { _locationSearch: '?pack=excellence' });
  env.getDomReadyCallback()();
  // packSelect must be set to excellence
  assert.equal(env.elements.packSelect.value, 'excellence',
    'packSelect must be set to excellence from URL');
  // No localStorage data, so no setTimeout calculatePrice fires.
  // Manually trigger calculatePrice to verify it uses the correct pack.
  env.queueResponse(200, { total_ht: 500, distance: 400, details: { pack: 'excellence' } });
  result.calculatePrice(true);
  env.advanceTimers(10);
  await new Promise(r => setTimeout(r, 10));
  // Verify the API was called
  assert.equal(env.state.fetchCalls.length, 1, 'calculatePrice must call the API');
  // Verify the payload contains pack=excellence
  const payload = JSON.parse(env.state.fetchCalls[0].opts.body);
  assert.equal(payload.pack, 'excellence',
    'API payload must contain pack=excellence');
});

// S2. pack selection from URL is preserved through preview payload
test('S2. pack from URL param flows through to API payload', async () => {
  const env = createMockEnv();
  env.elements.depart.value = 'Paris';
  env.elements.arrivee.value = 'Marseille';
  const { result } = loadScriptInSandbox(env, { _locationSearch: '?pack=serenite' });
  env.getDomReadyCallback()();
  assert.equal(env.elements.packSelect.value, 'serenite');
  env.queueResponse(200, { total_ht: 300, distance: 200, details: { pack: 'serenite' } });
  result.calculatePrice(true);
  env.advanceTimers(10);
  await new Promise(r => setTimeout(r, 10));
  const payload = JSON.parse(env.state.fetchCalls[0].opts.body);
  assert.equal(payload.pack, 'serenite',
    'API payload must contain pack=serenite from URL param');
});

// S3. essentiel alias flows through to API payload as starter
test('S3. essentiel alias from URL flows to API as starter', async () => {
  const env = createMockEnv();
  env.elements.depart.value = 'Paris';
  env.elements.arrivee.value = 'Lyon';
  const { result } = loadScriptInSandbox(env, { _locationSearch: '?pack=essentiel' });
  env.getDomReadyCallback()();
  assert.equal(env.elements.packSelect.value, 'starter');
  env.queueResponse(200, { total_ht: 200, distance: 100, details: { pack: 'starter' } });
  result.calculatePrice(true);
  env.advanceTimers(10);
  await new Promise(r => setTimeout(r, 10));
  const payload = JSON.parse(env.state.fetchCalls[0].opts.body);
  assert.equal(payload.pack, 'starter',
    'API payload must contain pack=starter (normalized from essentiel)');
});

// =========================================================
// No local pricing introduced
// =========================================================

test('NO_LOCAL_PRICING. devis.html has no local pack price tables', () => {
  assert.ok(!/packPrices.*serenite.*69/.test(devisSrc),
    'devis.html must not contain local packPrices table');
  assert.ok(!/packPrices.*excellence.*149/.test(devisSrc),
    'devis.html must not contain local packPrices table');
});

test('NO_LOCAL_PRICING. homepage has no local pricing calculation', () => {
  assert.ok(!/BathilyPricing\.calculate/.test(indexSrc),
    'homepage must not call BathilyPricing.calculate()');
  assert.ok(!/function calculatePrice/.test(indexSrc),
    'homepage must not contain local calculatePrice function');
});
