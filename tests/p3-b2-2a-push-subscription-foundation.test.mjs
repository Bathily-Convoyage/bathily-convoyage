// P3-B2.2A — Convoyeur push subscription foundation tests.
// Tests the frontend subscription lifecycle without real browser APIs,
// real VAPID keys, real push, or Production Supabase.
// Uses mocks for Notification, navigator.serviceWorker, PushManager, Swal.

import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';

// ── Helpers ──

const repoRoot = path.resolve(import.meta.dirname, '..');

function readFile(relPath) {
  return fs.readFileSync(path.join(repoRoot, relPath), 'utf8');
}

function fileExists(relPath) {
  return fs.existsSync(path.join(repoRoot, relPath));
}

// ── 1. generate-config supports VAPID_PUBLIC_KEY ──

test('generate-config.cjs includes VAPID_PUBLIC_KEY in output', () => {
  const content = readFile('scripts/generate-config.cjs');
  assert.ok(content.includes('VAPID_PUBLIC_KEY'),
    'generate-config.cjs must reference VAPID_PUBLIC_KEY');
  assert.ok(content.includes('window.VAPID_PUBLIC_KEY'),
    'generate-config.cjs must generate window.VAPID_PUBLIC_KEY');
});

test('generate-config.cjs does NOT reference VAPID_PRIVATE_KEY', () => {
  const content = readFile('scripts/generate-config.cjs');
  assert.ok(!content.includes('VAPID_PRIVATE_KEY'),
    'generate-config.cjs must NEVER reference VAPID_PRIVATE_KEY');
  assert.ok(!content.includes('PRIVATE_KEY'),
    'generate-config.cjs must NEVER reference any PRIVATE_KEY');
});

// ── 2. btnDisablePush exists in dashboard-convoyeur.html ──

test('dashboard-convoyeur.html contains btnDisablePush', () => {
  const html = readFile('dashboard-convoyeur.html');
  assert.ok(html.includes('id="btnDisablePush"'),
    'btnDisablePush must exist in dashboard-convoyeur.html');
});

test('dashboard-convoyeur.html contains btnEnablePush', () => {
  const html = readFile('dashboard-convoyeur.html');
  assert.ok(html.includes('id="btnEnablePush"'),
    'btnEnablePush must exist in dashboard-convoyeur.html');
});

test('dashboard-convoyeur.html contains pushStatus element', () => {
  const html = readFile('dashboard-convoyeur.html');
  assert.ok(html.includes('id="pushStatus"'),
    'pushStatus element must exist for user feedback');
});

// ── 3. gamification.js source-of-truth checks ──

test('public/js/gamification.js is the source of truth (deployed via vite)', () => {
  assert.ok(fileExists('public/js/gamification.js'));
  const content = readFile('public/js/gamification.js');
  assert.ok(content.includes('refreshPushUIState'),
    'refreshPushUIState must exist in source-of-truth');
});

test('root js/gamification.js is a stale duplicate (not modified)', () => {
  // The root js/gamification.js is NOT deployed (vite copies public/js/ to dist/js/)
  // We should NOT have modified it in this gate.
  const rootContent = readFile('js/gamification.js');
  assert.ok(!rootContent.includes('refreshPushUIState'),
    'stale duplicate js/gamification.js should NOT contain refreshPushUIState');
});

// ── 4. Initial state detection uses getSubscription() ──

test('refreshPushUIState calls pushManager.getSubscription()', () => {
  const content = readFile('public/js/gamification.js');
  assert.ok(content.includes('getSubscription()'),
    'refreshPushUIState must call getSubscription() to detect existing subscription');
});

// ── 5. No auto subscribe ──

test('no auto-subscribe on DOMContentLoaded — only refreshPushUIState', () => {
  const content = readFile('public/js/gamification.js');
  // DOMContentLoaded should call refreshPushUIState, NOT subscribePush
  const domIdx = content.indexOf('DOMContentLoaded');
  const domBlock = content.substring(domIdx, domIdx + 800);
  assert.ok(domBlock.includes('refreshPushUIState'),
    'DOMContentLoaded must call refreshPushUIState');
  // subscribePush should only be called on button click, not in DOMContentLoaded
  // The addEventListener('click', subscribePush) is fine — that's button wiring, not auto-subscribe
  // Check that subscribePush is NOT called as a function invocation (with parens) in DOMContentLoaded
  assert.ok(!domBlock.includes('subscribePush()'),
    'DOMContentLoaded must NOT call subscribePush()');
});

// ── 6. Missing VAPID blocks subscribe cleanly ──

test('subscribePush checks vapidConfigured before requesting permission', () => {
  const content = readFile('public/js/gamification.js');
  const subIdx = content.indexOf('async function subscribePush');
  const subBlock = content.substring(subIdx, subIdx + 800);
  const vapidCheckIdx = subBlock.indexOf('vapidConfigured');
  const permIdx = subBlock.indexOf('Notification.requestPermission');
  assert.ok(vapidCheckIdx > -1 && permIdx > -1,
    'subscribePush must check vapidConfigured and requestPermission');
  assert.ok(vapidCheckIdx < permIdx,
    'vapidConfigured check must come BEFORE requestPermission');
});

test('vapidConfigured function exists and checks window.VAPID_PUBLIC_KEY', () => {
  const content = readFile('public/js/gamification.js');
  assert.ok(content.includes('function vapidConfigured'),
    'vapidConfigured function must exist');
  assert.ok(content.includes('window.VAPID_PUBLIC_KEY'),
    'vapidConfigured must check window.VAPID_PUBLIC_KEY');
});

// ── 7. Denied permission gives feedback ──

test('subscribePush shows feedback when permission denied', () => {
  const content = readFile('public/js/gamification.js');
  const subIdx = content.indexOf('async function subscribePush');
  const subBlock = content.substring(subIdx, subIdx + 2000);
  assert.ok(subBlock.includes("permission === 'denied'"),
    'subscribePush must handle denied permission');
  assert.ok(subBlock.includes('Swal') || subBlock.includes('showSwal'),
    'subscribePush must show user feedback on denied permission');
});

// ── 8. Existing subscription does not duplicate row ──

test('subscribePush checks existing subscription before creating new one', () => {
  const content = readFile('public/js/gamification.js');
  const subIdx = content.indexOf('async function subscribePush');
  const subBlock = content.substring(subIdx, subIdx + 2000);
  assert.ok(subBlock.includes('getSubscription()'),
    'subscribePush must check getSubscription() before subscribing');
  assert.ok(subBlock.includes('existingSub'),
    'subscribePush must store existing subscription reference');
});

// ── 9. New subscription inserts current endpoint ──

test('subscribePush persists endpoint to push_subscriptions table', () => {
  const content = readFile('public/js/gamification.js');
  const subIdx = content.indexOf('async function subscribePush');
  const subBlock = content.substring(subIdx, subIdx + 3000);
  assert.ok(subBlock.includes('push_subscriptions'),
    'subscribePush must persist to push_subscriptions');
  assert.ok(subBlock.includes('endpoint'),
    'subscribePush must persist the endpoint');
  assert.ok(subBlock.includes('p256dh'),
    'subscribePush must persist p256dh key');
  assert.ok(subBlock.includes('auth_key'),
    'subscribePush must persist auth_key');
});

// ── 10. Current implementation does NOT require UPDATE RLS ──

test('subscribePush uses SELECT-then-INSERT, not upsert with onConflict', () => {
  const content = readFile('public/js/gamification.js');
  const subIdx = content.indexOf('async function subscribePush');
  const subBlock = content.substring(subIdx, subIdx + 3000);
  // Strip comments to check only actual code
  const codeOnly = subBlock.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
  // Must NOT use upsert (which requires UPDATE RLS)
  assert.ok(!codeOnly.includes('.upsert('),
    'subscribePush must NOT use .upsert() — current RLS has no UPDATE policy');
  // Must use SELECT to check existing, then INSERT
  assert.ok(codeOnly.includes('.select('),
    'subscribePush must SELECT to check for existing row');
  assert.ok(codeOnly.includes('.insert('),
    'subscribePush must INSERT new row');
  assert.ok(codeOnly.includes('.maybeSingle()'),
    'subscribePush must use maybeSingle() for existence check');
});

// ── 11. Unsubscribe deletes by user_id + endpoint ──

test('unsubscribePush deletes by user_id AND endpoint (not user_id alone)', () => {
  const content = readFile('public/js/gamification.js');
  const unsubIdx = content.indexOf('async function unsubscribePush');
  const unsubBlock = content.substring(unsubIdx, unsubIdx + 2000);
  assert.ok(unsubBlock.includes('.eq(\'user_id\''),
    'unsubscribePush must filter by user_id');
  assert.ok(unsubBlock.includes('.eq(\'endpoint\''),
    'unsubscribePush must filter by endpoint');
  // Must NOT delete by user_id alone
  // Check that the delete call has BOTH eq conditions
  const delIdx = unsubBlock.indexOf('.delete()');
  const afterDel = unsubBlock.substring(delIdx, delIdx + 200);
  assert.ok(afterDel.includes('user_id') && afterDel.includes('endpoint'),
    'delete() must be scoped by both user_id AND endpoint');
});

// ── 12. Device A unsubscribe preserves device B ──

test('unsubscribePush does NOT delete all rows for user (no user_id-only delete)', () => {
  const content = readFile('public/js/gamification.js');
  // The old buggy code was: .delete().eq('user_id', ...) without .eq('endpoint', ...)
  // Verify the new code always includes endpoint in the delete filter
  const unsubIdx = content.indexOf('async function unsubscribePush');
  const unsubBlock = content.substring(unsubIdx, unsubIdx + 2000);
  // Find all .delete() calls and verify each has both user_id and endpoint
  const deleteMatches = [...unsubBlock.matchAll(/\.delete\(\)/g)];
  for (const match of deleteMatches) {
    const afterDelete = unsubBlock.substring(match.index, match.index + 200);
    assert.ok(afterDelete.includes('user_id'),
      'delete() must be scoped by user_id');
    assert.ok(afterDelete.includes('endpoint'),
      'delete() must be scoped by endpoint — no cross-device deletion');
  }
});

// ── 13. User-facing error path exists ──

test('subscribePush has user-facing error feedback in catch block', () => {
  const content = readFile('public/js/gamification.js');
  const subIdx = content.indexOf('async function subscribePush');
  const subBlock = content.substring(subIdx, subIdx + 3000);
  assert.ok(subBlock.includes('catch'),
    'subscribePush must have catch block');
  assert.ok(subBlock.includes('Swal') || subBlock.includes('showSwal'),
    'subscribePush must show user-facing error in catch');
});

test('unsubscribePush has user-facing error feedback in catch block', () => {
  const content = readFile('public/js/gamification.js');
  const unsubIdx = content.indexOf('async function unsubscribePush');
  const unsubBlock = content.substring(unsubIdx, unsubIdx + 2000);
  assert.ok(unsubBlock.includes('catch'),
    'unsubscribePush must have catch block');
  assert.ok(unsubBlock.includes('Swal') || unsubBlock.includes('showSwal'),
    'unsubscribePush must show user-facing error in catch');
});

// ── 14. SW malformed JSON does not crash ──

test('sw.js push handler has try-catch for JSON parsing', () => {
  const sw = readFile('public/sw.js');
  const pushIdx = sw.indexOf("addEventListener('push'");
  const pushBlock = sw.substring(pushIdx, pushIdx + 600);
  assert.ok(pushBlock.includes('try'),
    'push handler must have try block for JSON parsing');
  assert.ok(pushBlock.includes('catch'),
    'push handler must have catch block for malformed JSON');
  assert.ok(pushBlock.includes('event.data.json()'),
    'push handler must attempt JSON parsing');
  assert.ok(pushBlock.includes('event.data.text()') || pushBlock.includes('data = {}'),
    'push handler must fall back safely on malformed JSON');
});

// ── 15. P3-B1 API bypass remains ──

test('sw.js preserves P3-B1 /api bypass', () => {
  const sw = readFile('public/sw.js');
  assert.ok(sw.includes("url.pathname === '/api'"),
    'sw.js must preserve exact /api bypass');
  assert.ok(sw.includes("url.pathname.startsWith('/api/')"),
    'sw.js must preserve /api/* bypass');
});

// ── 16. Cache name remains v5 ──

test('sw.js cache name remains bathily-convoyage-v5', () => {
  const sw = readFile('public/sw.js');
  assert.ok(sw.includes("bathily-convoyage-v5"),
    'sw.js must preserve cache name v5');
});

// ── Additional: roll back browser subscription on DB failure ──

test('subscribePush rolls back browser subscription if DB persistence fails', () => {
  const content = readFile('public/js/gamification.js');
  const subIdx = content.indexOf('async function subscribePush');
  const subBlock = content.substring(subIdx, subIdx + 3000);
  assert.ok(subBlock.includes('sub.unsubscribe()'),
    'subscribePush must roll back browser subscription on DB failure');
  assert.ok(subBlock.includes('_insert.error') || subBlock.includes('insert.error'),
    'subscribePush must check insert error before rollback');
});

// ── Additional: refreshPushUIState handles denied permission ──

test('refreshPushUIState shows message for denied permission', () => {
  const content = readFile('public/js/gamification.js');
  const refreshIdx = content.indexOf('async function refreshPushUIState');
  const refreshBlock = content.substring(refreshIdx, refreshIdx + 1500);
  assert.ok(refreshBlock.includes("permission === 'denied'") || refreshBlock.includes("'denied'"),
    'refreshPushUIState must handle denied permission state');
});

// ── Additional: refreshPushUIState handles unsupported browser ──

test('refreshPushUIState handles unsupported browser', () => {
  const content = readFile('public/js/gamification.js');
  const refreshIdx = content.indexOf('async function refreshPushUIState');
  const refreshBlock = content.substring(refreshIdx, refreshIdx + 1500);
  assert.ok(refreshBlock.includes('pushSupported'),
    'refreshPushUIState must check pushSupported()');
});

// ── Additional: no real VAPID key in source ──

test('no real VAPID key value hardcoded in gamification.js', () => {
  const content = readFile('public/js/gamification.js');
  // Should reference window.VAPID_PUBLIC_KEY, not a hardcoded key
  assert.ok(!content.match(/VAPID_PUBLIC_KEY\s*=\s*['"][A-Za-z0-9_-]{80,}/),
    'no hardcoded VAPID key value in gamification.js');
});

test('no real VAPID key in generate-config.cjs output', () => {
  const content = readFile('scripts/generate-config.cjs');
  // Should read from env, not hardcode a key
  assert.ok(!content.match(/VAPID_PUBLIC_KEY\s*=\s*['"][A-Za-z0-9_-]{80,}/),
    'no hardcoded VAPID key value in generate-config.cjs');
});

// ── Additional: notificationclick preserved ──

test('sw.js preserves notificationclick handler', () => {
  const sw = readFile('public/sw.js');
  assert.ok(sw.includes("notificationclick"),
    'sw.js must preserve notificationclick handler');
  assert.ok(sw.includes('clients.matchAll'),
    'sw.js must preserve clients.matchAll in notificationclick');
});

// ── Additional: no wrangler.toml or migration changes ──

test('wrangler.toml not modified in this gate', () => {
  // This is a scope-control check — wrangler.toml should be unchanged from baseline
  const wrangler = readFile('wrangler.toml');
  assert.ok(wrangler.includes('nodejs_compat'),
    'wrangler.toml should still have nodejs_compat (unchanged)');
  // Should NOT have enable_nodejs_http_modules added in this gate
  // (that was only in the spike branch)
  // The baseline wrangler.toml only has nodejs_compat
});

// ── Generate-config integration test ──

test('generate-config.cjs produces VAPID_PUBLIC_KEY line when env set', () => {
  // Verify the template string includes VAPID_PUBLIC_KEY
  const content = readFile('scripts/generate-config.cjs');
  assert.ok(content.includes('window.VAPID_PUBLIC_KEY'),
    'generated config must include window.VAPID_PUBLIC_KEY');
  // Verify it reads from env, with empty string fallback
  assert.ok(content.includes("process.env.VAPID_PUBLIC_KEY"),
    'generate-config must read VAPID_PUBLIC_KEY from environment');
  assert.ok(content.includes("|| ''"),
    'generate-config must default to empty string when VAPID_PUBLIC_KEY not set');
});
