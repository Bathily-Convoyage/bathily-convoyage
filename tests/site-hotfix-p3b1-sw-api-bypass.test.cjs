/**
 * SITE-HOTFIX-P3-B1 — Service Worker API cache bypass regression test.
 *
 * Verifies that public/sw.js (the source-of-truth service worker) explicitly
 * bypasses all same-origin /api/* routes BEFORE any cache logic, so dynamic
 * API responses are never handled by the service worker cache.
 *
 * Also includes a runtime simulation that loads the SW fetch handler in a
 * fake environment and proves that for /api/calculate-quote the handler
 * returns without calling event.respondWith(), caches.match(), or
 * cache.put() — while a normal static asset still enters SW handling.
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');

const repoRoot = path.resolve(__dirname, '..');
const swPath = path.join(repoRoot, 'public', 'sw.js');
const sw = fs.readFileSync(swPath, 'utf8');

// =========================================================
// Source of truth: public/sw.js is the deployed SW
// =========================================================

test('source of truth is public/sw.js (v5)', () => {
  assert.ok(/bathily-convoyage-v5/.test(sw), 'public/sw.js must be v5');
});

// =========================================================
// 1. Explicit /api/ bypass exists
// =========================================================

test('sw.js contains explicit /api/ bypass', () => {
  assert.ok(
    /url\.pathname === '\/api' \|\| url\.pathname\.startsWith\('\/api\/'\)/.test(sw),
    'sw.js must bypass /api and /api/* routes',
  );
});

// =========================================================
// 2 & 3. Bypass occurs before HTML and static cache logic
// =========================================================

test('api bypass occurs before HTML network-first logic', () => {
  const apiIdx = sw.indexOf("url.pathname === '/api'");
  const htmlIdx = sw.indexOf("req.headers.get('accept')?.includes('text/html')");
  assert.ok(apiIdx >= 0, 'api bypass found');
  assert.ok(htmlIdx >= 0, 'HTML network-first logic found');
  assert.ok(apiIdx < htmlIdx, 'api bypass must be before HTML logic');
});

test('api bypass occurs before static cache-first logic', () => {
  const apiIdx = sw.indexOf("url.pathname === '/api'");
  // The final caches.match(req) for static assets (not inside HTML/JS blocks)
  const staticIdx = sw.lastIndexOf('caches.match(req)');
  assert.ok(apiIdx >= 0, 'api bypass found');
  assert.ok(staticIdx >= 0, 'static cache-first logic found');
  assert.ok(apiIdx < staticIdx, 'api bypass must be before static cache-first logic');
});

// =========================================================
// 4 & 5. Specific API routes match the bypass
// =========================================================

test('/api/calculate-quote matches the bypass condition', () => {
  const url = new URL('https://bathily-convoyage.fr/api/calculate-quote');
  assert.ok(url.pathname === '/api' || url.pathname.startsWith('/api/'),
    '/api/calculate-quote must match bypass');
});

test('/api/foo/bar matches the bypass condition', () => {
  const url = new URL('https://bathily-convoyage.fr/api/foo/bar');
  assert.ok(url.pathname === '/api' || url.pathname.startsWith('/api/'),
    '/api/foo/bar must match bypass');
});

// =========================================================
// 6. /api root (no trailing slash) is bypassed
// =========================================================

test('/api without trailing slash matches the bypass condition', () => {
  const url = new URL('https://bathily-convoyage.fr/api');
  assert.ok(url.pathname === '/api' || url.pathname.startsWith('/api/'),
    '/api (root) must match bypass');
});

// =========================================================
// 7. /apiary or /apisomething must NOT accidentally match
// =========================================================

test('/apiary does NOT match the bypass condition', () => {
  const url = new URL('https://bathily-convoyage.fr/apiary');
  assert.ok(!(url.pathname === '/api' || url.pathname.startsWith('/api/')),
    '/apiary must not match bypass (startsWith /api/ would fail, === /api would fail)');
});

test('/apisomething does NOT match the bypass condition', () => {
  const url = new URL('https://bathily-convoyage.fr/apisomething');
  assert.ok(!(url.pathname === '/api' || url.pathname.startsWith('/api/')),
    '/apisomething must not match bypass');
});

test('/api/ bypass uses exact /api or /api/ prefix (not loose /api prefix)', () => {
  // Ensure the code does NOT use a loose startsWith('/api') that would catch /apiary
  assert.ok(
    !/url\.pathname\.startsWith\('\/api'\)/.test(sw),
    'sw.js must not use loose startsWith(\'/api\') — would match /apiary',
  );
});

// =========================================================
// 8. Existing /.netlify/ bypass remains
// =========================================================

test('existing /.netlify/ bypass remains', () => {
  assert.ok(/url\.pathname\.startsWith\('\/\.netlify\/'\)/.test(sw),
    '/.netlify/ bypass must be preserved');
});

// =========================================================
// 9. Cross-origin bypass remains
// =========================================================

test('cross-origin bypass remains', () => {
  assert.ok(/url\.origin !== location\.origin/.test(sw),
    'cross-origin bypass must be preserved');
});

// =========================================================
// 10. Non-GET bypass remains
// =========================================================

test('non-GET bypass remains', () => {
  assert.ok(/req\.method !== 'GET'/.test(sw),
    'non-GET bypass must be preserved');
});

// =========================================================
// 11 & 12. HTML network-first and static cache-first remain
// =========================================================

test('HTML network-first logic remains', () => {
  assert.ok(/req\.headers\.get\('accept'\)\?\.includes\('text\/html'\)/.test(sw),
    'HTML network-first logic must be preserved');
});

test('static cache-first logic remains', () => {
  assert.ok(/caches\.match\(req\)\.then\(\(cached\) =>/.test(sw),
    'static cache-first logic must be preserved');
});

// =========================================================
// 13. Push / notification handlers unchanged
// =========================================================

test('push notification handler remains', () => {
  assert.ok(/addEventListener\('push'/.test(sw), 'push handler must be preserved');
});

test('notificationclick handler remains', () => {
  assert.ok(/addEventListener\('notificationclick'/.test(sw),
    'notificationclick handler must be preserved');
});

// =========================================================
// Runtime simulation: API request bypasses SW handling
// =========================================================

/**
 * Load the SW fetch handler in a fake environment and simulate a fetch event.
 * Returns the call log so tests can verify which SW APIs were invoked.
 */
function simulateFetch(requestUrl, { method = 'GET', accept = null, destination = '' } = {}) {
  const calls = { respondWith: 0, cachesMatch: 0, cachesOpen: 0, cachePut: 0, fetch: 0 };

  // Fake caches API
  const fakeCache = {
    match: () => { calls.cachesMatch++; return Promise.resolve(null); },
    put: () => { calls.cachePut++; return Promise.resolve(); },
    addAll: () => Promise.resolve(),
  };
  const fakeCaches = {
    open: () => { calls.cachesOpen++; return Promise.resolve(fakeCache); },
    match: () => { calls.cachesMatch++; return Promise.resolve(null); },
    keys: () => Promise.resolve([]),
    delete: () => Promise.resolve(true),
  };

  // Fake fetch — returns a promise with a cloneable fake response
  const fakeFetch = () => {
    calls.fetch++;
    const fakeRes = {
      ok: true,
      clone: () => fakeRes,
    };
    return Promise.resolve(fakeRes);
  };

  // Fake self / global scope for the service worker
  const location = { origin: new URL(requestUrl).origin };
  const fakeEvent = {
    request: {
      method,
      url: requestUrl,
      headers: {
        get: (name) => {
          if (name === 'accept') return accept;
          return null;
        },
      },
      destination,
    },
    waitUntil: () => {},
    respondWith: () => { calls.respondWith++; },
    notification: { close: () => {} },
    data: null,
  };

  // Build a fake self with addEventListener that captures handlers
  const handlers = {};
  const fakeSelf = {
    addEventListener: (type, handler) => { handlers[type] = handler; },
    skipWaiting: () => {},
    clients: { claim: () => {}, matchAll: () => Promise.resolve([]), openWindow: () => Promise.resolve() },
    registration: { showNotification: () => {} },
  };

  // Provide globals the SW expects
  const sandbox = {
    self: fakeSelf,
    caches: fakeCaches,
    fetch: fakeFetch,
    location,
    clients: fakeSelf.clients,
    registration: fakeSelf.registration,
    URL,
    Response: { error: () => ({}) },
    console: { warn: () => {} },
  };

  // Eval the SW source in a function scope with the sandbox globals
  const params = Object.keys(sandbox);
  const values = Object.values(sandbox);
  // eslint-disable-next-line no-new-func
  const fn = new Function(...params, sw);
  fn(...values);

  // Trigger the fetch handler
  if (handlers.fetch) {
    handlers.fetch(fakeEvent);
  }

  return calls;
}

test('RUNTIME: /api/calculate-quote does not call event.respondWith()', () => {
  const calls = simulateFetch('https://bathily-convoyage.fr/api/calculate-quote');
  assert.equal(calls.respondWith, 0, 'event.respondWith must NOT be called for /api/*');
});

test('RUNTIME: /api/calculate-quote does not call caches.match()', () => {
  const calls = simulateFetch('https://bathily-convoyage.fr/api/calculate-quote');
  assert.equal(calls.cachesMatch, 0, 'caches.match must NOT be called for /api/*');
});

test('RUNTIME: /api/calculate-quote does not call cache.put()', () => {
  const calls = simulateFetch('https://bathily-convoyage.fr/api/calculate-quote');
  assert.equal(calls.cachePut, 0, 'cache.put must NOT be called for /api/*');
});

test('RUNTIME: /api (root, no trailing slash) does not call event.respondWith()', () => {
  const calls = simulateFetch('https://bathily-convoyage.fr/api');
  assert.equal(calls.respondWith, 0, 'event.respondWith must NOT be called for /api root');
  assert.equal(calls.cachesMatch, 0, 'caches.match must NOT be called for /api root');
});

test('RUNTIME: /apiary is NOT bypassed (enters SW handling)', () => {
  // /apiary is not an API route, so it should fall through to SW handling.
  // It is not HTML (no accept header) and not .js, so it hits the static
  // cache-first branch which calls caches.match().
  const calls = simulateFetch('https://bathily-convoyage.fr/apiary');
  assert.ok(calls.respondWith > 0, '/apiary must enter SW handling (not bypassed)');
  assert.ok(calls.cachesMatch > 0, '/apiary must reach cache-first logic');
});

test('RUNTIME: a normal static asset still enters SW handling', () => {
  // A CSS file is a static asset that should be handled by cache-first.
  const calls = simulateFetch('https://bathily-convoyage.fr/css/design-system.css');
  assert.ok(calls.respondWith > 0, 'static asset must trigger event.respondWith');
  assert.ok(calls.cachesMatch > 0, 'static asset must trigger caches.match');
});

test('RUNTIME: an HTML page still enters SW network-first handling', () => {
  const calls = simulateFetch('https://bathily-convoyage.fr/index.html', { accept: 'text/html' });
  assert.ok(calls.respondWith > 0, 'HTML page must trigger event.respondWith');
  assert.ok(calls.fetch > 0 || calls.cachesMatch > 0 || calls.cachesOpen > 0,
    'HTML page must enter network-first or cache logic');
});

// =========================================================
// Cache version: not changed
// =========================================================

test('CACHE_NAME is not changed (still v5)', () => {
  assert.ok(/bathily-convoyage-v5/.test(sw), 'CACHE_NAME must remain v5');
  assert.ok(!/bathily-convoyage-v6/.test(sw), 'CACHE_NAME must NOT be bumped to v6');
});
