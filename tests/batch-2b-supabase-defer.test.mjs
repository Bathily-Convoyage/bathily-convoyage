import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, '..');

async function readIndex() {
  return readFile(join(repoRoot, 'index.html'), 'utf8');
}

test('Supabase CDN script on index.html has defer attribute', async () => {
  const html = await readIndex();
  const match = html.match(/<script\s+src="https:\/\/cdn\.jsdelivr\.net\/npm\/@supabase\/supabase-js@2"[^>]*>/);
  assert.ok(match, 'Supabase CDN script tag not found');
  assert.match(match[0], /\bdefer\b/, 'Supabase CDN script must have defer attribute');
});

test('supabase-config.js script on index.html has defer attribute', async () => {
  const html = await readIndex();
  const match = html.match(/<script\s+src="\/supabase-config\.js"[^>]*>/);
  assert.ok(match, 'supabase-config.js script tag not found');
  assert.match(match[0], /\bdefer\b/, 'supabase-config.js script must have defer attribute');
});

test('loadPromoBar is scheduled via DOMContentLoaded, not called parser-time', async () => {
  const html = await readIndex();
  // The immediate call must be gone
  assert.doesNotMatch(
    html,
    /\n\s*loadPromoBar\(\);\s*\n/,
    'loadPromoBar() must not be called immediately (parser-time)'
  );
  // Must be wrapped in DOMContentLoaded
  assert.match(
    html,
    /DOMContentLoaded.*loadPromoBar\(\)/,
    'loadPromoBar() must be scheduled via DOMContentLoaded'
  );
});

test('loadPacksConfig is scheduled via DOMContentLoaded, not called parser-time', async () => {
  const html = await readIndex();
  // The immediate call must be gone
  assert.doesNotMatch(
    html,
    /\n\s*loadPacksConfig\(\);\s*\n/,
    'loadPacksConfig() must not be called immediately (parser-time)'
  );
  // Must be wrapped in DOMContentLoaded
  assert.match(
    html,
    /DOMContentLoaded.*loadPacksConfig\(\)/,
    'loadPacksConfig() must be scheduled via DOMContentLoaded'
  );
});

test('auth-entry-redirect.js remains synchronous (no defer attribute)', async () => {
  const html = await readIndex();
  const match = html.match(/<script\s+src="\/js\/auth-entry-redirect\.js"[^>]*>/);
  assert.ok(match, 'auth-entry-redirect.js script tag not found');
  assert.doesNotMatch(match[0], /\bdefer\b/, 'auth-entry-redirect.js must NOT have defer');
});

test('execution order: auth-entry-redirect before Supabase CDN before supabase-config', async () => {
  const html = await readIndex();
  const authIdx = html.indexOf('/js/auth-entry-redirect.js');
  const supabaseIdx = html.indexOf('@supabase/supabase-js@2');
  const configIdx = html.indexOf('/supabase-config.js');
  assert.ok(authIdx > -1, 'auth-entry-redirect.js reference not found');
  assert.ok(supabaseIdx > -1, 'Supabase CDN reference not found');
  assert.ok(configIdx > -1, 'supabase-config.js reference not found');
  assert.ok(
    authIdx < supabaseIdx,
    'auth-entry-redirect.js must appear before Supabase CDN in document order'
  );
  assert.ok(
    supabaseIdx < configIdx,
    'Supabase CDN must appear before supabase-config.js in document order'
  );
});
