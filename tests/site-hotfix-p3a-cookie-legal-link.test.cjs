/**
 * SITE-HOTFIX-P3-A — cookie-consent.js legal link regression test.
 *
 * Verifies that the cookie banner's legal/privacy link is root-relative
 * ("/mentions-legales.html") so it resolves correctly on nested routes
 * such as /blog/*, instead of the previous relative "mentions-legales.html"
 * which would resolve to /blog/mentions-legales.html.
 *
 * Scope guard: only the href should have changed — consent logic, storage
 * keys, banner styling and analytics behaviour must remain untouched.
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');

const repoRoot = path.resolve(__dirname, '..');
const cookiePath = path.join(repoRoot, 'public', 'js', 'cookie-consent.js');
const cookie = fs.readFileSync(cookiePath, 'utf8');

// =========================================================
// Legal link is root-relative
// =========================================================

test('cookie banner legal link is root-relative ("/mentions-legales.html")', () => {
  assert.ok(
    /href="\/mentions-legales\.html"/.test(cookie),
    'legal link must be root-relative: href="/mentions-legales.html"',
  );
});

test('cookie banner does NOT use the old relative href', () => {
  // The old form was href="mentions-legales.html" (no leading slash).
  // Ensure no such occurrence remains.
  assert.ok(
    !/href="mentions-legales\.html"/.test(cookie),
    'relative href="mentions-legales.html" must be removed (breaks on nested routes)',
  );
});

test('only one legal link href exists in cookie-consent.js', () => {
  const matches = cookie.match(/href="[^"]*mentions-legales\.html"/g);
  assert.ok(Array.isArray(matches), 'href match array produced');
  assert.equal(matches.length, 1, 'exactly one mentions-legales.html href present');
  assert.equal(matches[0], 'href="/mentions-legales.html"', 'the single href is root-relative');
});

// =========================================================
// Nested-route resolution simulation
// =========================================================

test('root-relative link resolves to /mentions-legales.html from a nested /blog/* route', () => {
  // Simulate URL resolution the way a browser would for an <a href>.
  // A root-relative "/mentions-legales.html" always resolves against the
  // origin, regardless of the current path.
  const nestedBase = 'https://bathily-convoyage.fr/blog/convoyage-vehicule-electrique.html';
  const resolved = new URL('/mentions-legales.html', nestedBase).toString();
  assert.equal(
    resolved,
    'https://bathily-convoyage.fr/mentions-legales.html',
    'root-relative link must resolve to the site root from nested routes',
  );
});

test('the old relative link would have resolved incorrectly on a nested route (regression baseline)', () => {
  // This documents the original defect: a relative "mentions-legales.html"
  // on /blog/foo.html resolves to /blog/mentions-legales.html (wrong).
  const nestedBase = 'https://bathily-convoyage.fr/blog/convoyage-vehicule-electrique.html';
  const wrongResolved = new URL('mentions-legales.html', nestedBase).toString();
  assert.equal(
    wrongResolved,
    'https://bathily-convoyage.fr/blog/mentions-legales.html',
    'baseline: relative link resolves under /blog/ (the original defect)',
  );
  // And confirm the fixed link does NOT match that wrong resolution.
  const fixedResolved = new URL('/mentions-legales.html', nestedBase).toString();
  assert.notEqual(fixedResolved, wrongResolved, 'fixed link must not match the defective resolution');
});

// =========================================================
// Scope guard: consent logic / storage keys / styling unchanged
// =========================================================

test('consent storage key is unchanged (bathily_cookie_consent)', () => {
  assert.ok(/bathily_cookie_consent/.test(cookie), 'storage key preserved');
});

test('consent accepts "accepted" and "refused" values (logic unchanged)', () => {
  assert.ok(/consent === 'accepted' \|\| consent === 'refused'/.test(cookie), 'early-return consent check preserved');
  assert.ok(/localStorage\.setItem\('bathily_cookie_consent', 'accepted'\)/.test(cookie), 'accept handler preserved');
  assert.ok(/localStorage\.setItem\('bathily_cookie_consent', 'refused'\)/.test(cookie), 'refuse handler preserved');
});

test('banner styling tokens are unchanged', () => {
  assert.ok(/banner\.id = 'cookie-banner'/.test(cookie), 'banner id preserved');
  assert.ok(/position:fixed;bottom:0/.test(cookie), 'banner fixed-bottom positioning preserved');
  assert.ok(/#063244/.test(cookie), 'banner bordeaux-dark background preserved');
  assert.ok(/#F5A623/.test(cookie), 'accent warning colour preserved');
});

test('cookie-consent.js does not reference a service worker', () => {
  assert.ok(!/serviceWorker|service-worker|sw\.js/i.test(cookie), 'no service worker reference introduced');
});
