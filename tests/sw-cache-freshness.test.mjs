import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, '..');

async function readSW() {
  return readFile(join(repoRoot, 'public', 'sw.js'), 'utf8');
}

test('CACHE_NAME is bathily-convoyage-v5', async () => {
  const sw = await readSW();
  assert.match(sw, /bathily-convoyage-v5/, 'CACHE_NAME must be v5');
  assert.doesNotMatch(sw, /bathily-convoyage-v4/, 'old v4 cache name must not remain');
});

test('old caches are deleted on activate', async () => {
  const sw = await readSW();
  assert.match(sw, /caches\.keys\(\)/, 'activate must enumerate caches');
  assert.match(sw, /keys\.filter\(\(key\) => key !== CACHE_NAME\)/, 'activate must filter out current cache');
  assert.match(sw, /caches\.delete\(key\)/, 'activate must delete old caches');
});

test('HTML remains network-first', async () => {
  const sw = await readSW();
  const htmlBlock = sw.match(/text\/html[\s\S]*?return;\s*\}/);
  assert.ok(htmlBlock, 'HTML handling block must exist');
  assert.match(htmlBlock[0], /fetch\(req\)/, 'HTML must fetch from network first');
  assert.match(htmlBlock[0], /caches\.match\(req\)/, 'HTML must fallback to cache on network failure');
});

test('same-origin JS is network-first', async () => {
  const sw = await readSW();
  const jsBlock = sw.match(/\.js'|destination.*script[\s\S]*?return;\s*\}/);
  assert.ok(jsBlock, 'JS network-first block must exist');
  // Verify network fetch happens before cache match
  const jsSection = sw.substring(sw.indexOf('Same-origin JavaScript'));
  assert.match(jsSection, /fetch\(req\)/, 'JS must fetch from network first');
  assert.match(jsSection, /caches\.match\(req\)/, 'JS must fallback to cache on network failure');
});

test('successful JS network response updates cache', async () => {
  const sw = await readSW();
  const jsSection = sw.substring(sw.indexOf('Same-origin JavaScript'));
  assert.match(jsSection, /res\.ok/, 'JS response must be checked for ok status');
  assert.match(jsSection, /cache\.put\(req, clone\)/, 'JS must update cache on successful network response');
});

test('JS network failure falls back to cached response', async () => {
  const sw = await readSW();
  const jsSection = sw.substring(sw.indexOf('Same-origin JavaScript'));
  assert.match(jsSection, /\.catch\(\(\) => caches\.match\(req\)/, 'JS must fallback to cache on network failure');
});

test('non-ok JS response is not cached', async () => {
  const sw = await readSW();
  const jsSection = sw.substring(sw.indexOf('Same-origin JavaScript'));
  // The cache.put must be inside an if (res.ok) block
  const putMatch = jsSection.match(/if \(res\.ok\)\s*\{[\s\S]*?cache\.put/);
  assert.ok(putMatch, 'JS cache.put must be guarded by res.ok check');
});

test('cross-origin requests are not intercepted', async () => {
  const sw = await readSW();
  assert.match(sw, /url\.origin !== location\.origin/, 'cross-origin requests must be skipped');
});

test('non-GET requests are ignored', async () => {
  const sw = await readSW();
  assert.match(sw, /req\.method !== 'GET'/, 'non-GET requests must be skipped');
});

test('Supabase/external API behavior unchanged (cross-origin skip)', async () => {
  const sw = await readSW();
  // Cross-origin skip covers Supabase, Stripe, and all external APIs
  assert.match(sw, /url\.origin !== location\.origin/, 'external origins must be skipped');
});

test('Netlify functions are skipped', async () => {
  const sw = await readSW();
  assert.match(sw, /\/\.netlify\//, 'Netlify functions path must be skipped');
});

test('other static assets remain cache-first', async () => {
  const sw = await readSW();
  const cacheFirstBlock = sw.match(/Other static assets[\s\S]*?caches\.match\(req\)\.then\(\(cached\) => \{[\s\S]*?if \(cached\) return cached/);
  assert.ok(cacheFirstBlock, 'other static assets must use cache-first strategy');
});

test('push notification handler preserved', async () => {
  const sw = await readSW();
  assert.match(sw, /addEventListener\('push'/, 'push event listener must be preserved');
});

test('notification click handler preserved', async () => {
  const sw = await readSW();
  assert.match(sw, /addEventListener\('notificationclick'/, 'notificationclick event listener must be preserved');
});

test('skipWaiting and clients.claim preserved', async () => {
  const sw = await readSW();
  assert.match(sw, /self\.skipWaiting\(\)/, 'skipWaiting must be preserved');
  assert.match(sw, /self\.clients\.claim\(\)/, 'clients.claim must be preserved');
});

test('STATIC_ASSETS list preserved', async () => {
  const sw = await readSW();
  assert.match(sw, /\/index\.html/, 'STATIC_ASSETS must include index.html');
  assert.match(sw, /\/manifest\.json/, 'STATIC_ASSETS must include manifest.json');
  assert.match(sw, /\/favicon\.png/, 'STATIC_ASSETS must include favicon.png');
});
