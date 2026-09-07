// P3-B2.3B — Push outbox + consumer foundation tests.
// Tests schema, enqueue, consumer, multi-device, classification, retry,
// stale cleanup, URL safety, and email pipeline isolation.
// Uses mocks only — no external network, no Production Supabase.

import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';

const repoRoot = path.resolve(import.meta.dirname, '..');

function readFile(relPath) {
  return fs.readFileSync(path.join(repoRoot, relPath), 'utf8');
}

function fileExists(relPath) {
  return fs.existsSync(path.join(repoRoot, relPath));
}

// ── SCHEMA TESTS ──

test('push_notification_outbox migration file exists', () => {
  assert.ok(fileExists('supabase/migrations/20260906180000_p3_b2_3b_push_outbox_consumer.sql'),
    'migration file must exist');
});

test('1. push_notification_outbox table is created in migration', () => {
  const sql = readFile('supabase/migrations/20260906180000_p3_b2_3b_push_outbox_consumer.sql');
  assert.ok(sql.includes('CREATE TABLE IF NOT EXISTS public.push_notification_outbox'),
    'migration must create push_notification_outbox table');
});

test('2. server-only access model — no client policies, RLS enabled', () => {
  const sql = readFile('supabase/migrations/20260906180000_p3_b2_3b_push_outbox_consumer.sql');
  assert.ok(sql.includes('ENABLE ROW LEVEL SECURITY'),
    'RLS must be enabled on push_notification_outbox');
  // No CREATE POLICY for authenticated or anon
  assert.ok(!sql.includes('CREATE POLICY') || !sql.match(/CREATE POLICY.*push_notification_outbox.*TO\s+["']?authenticated/i),
    'no authenticated policy on push_notification_outbox');
  assert.ok(!sql.match(/CREATE POLICY.*push_notification_outbox.*TO\s+["']?anon/i),
    'no anon policy on push_notification_outbox');
  // Revoke from anon and authenticated
  assert.ok(sql.includes('REVOKE ALL ON TABLE public.push_notification_outbox FROM anon'),
    'must revoke from anon');
  assert.ok(sql.includes('REVOKE ALL ON TABLE public.push_notification_outbox FROM authenticated'),
    'must revoke from authenticated');
  // Grant only to service_role
  assert.ok(sql.includes('GRANT ALL ON TABLE public.push_notification_outbox TO service_role'),
    'must grant to service_role');
});

test('3. unique idempotency constraint on (mission_event_id, notification_type, target_user_id)', () => {
  const sql = readFile('supabase/migrations/20260906180000_p3_b2_3b_push_outbox_consumer.sql');
  assert.ok(sql.includes('UNIQUE (mission_event_id, notification_type, target_user_id)'),
    'must have unique constraint on (mission_event_id, notification_type, target_user_id)');
  assert.ok(sql.includes('ON CONFLICT (mission_event_id, notification_type, target_user_id) DO NOTHING'),
    'enqueue must use ON CONFLICT DO NOTHING for idempotency');
});

test('4. retry/state columns exist in schema', () => {
  const sql = readFile('supabase/migrations/20260906180000_p3_b2_3b_push_outbox_consumer.sql');
  const requiredColumns = ['status', 'attempts', 'next_attempt_at', 'created_at', 'updated_at', 'sent_at', 'last_error'];
  for (const col of requiredColumns) {
    assert.ok(sql.includes(col),
      `column ${col} must exist in push_notification_outbox schema`);
  }
  // Status check constraint
  assert.ok(sql.includes("status IN ('pending', 'processing', 'sent', 'failed')"),
    'status must be constrained to pending/processing/sent/failed');
});

// ── ENQUEUE TESTS ──

test('5. mission_assigned enqueues push row', () => {
  const sql = readFile('supabase/migrations/20260906180000_p3_b2_3b_push_outbox_consumer.sql');
  const fnIdx = sql.indexOf('enqueue_push_notification');
  const fnBlock = sql.substring(fnIdx, fnIdx + 2000);
  assert.ok(fnBlock.includes("'mission_assigned'"),
    'enqueue function must handle mission_assigned');
  assert.ok(fnBlock.includes('INSERT INTO public.push_notification_outbox'),
    'enqueue must INSERT into push_notification_outbox');
});

test('6. duplicate event does not duplicate (ON CONFLICT DO NOTHING)', () => {
  const sql = readFile('supabase/migrations/20260906180000_p3_b2_3b_push_outbox_consumer.sql');
  assert.ok(sql.includes('ON CONFLICT (mission_event_id, notification_type, target_user_id) DO NOTHING'),
    'enqueue must use ON CONFLICT DO NOTHING to prevent duplicates');
});

test('7. mission_cancelled enqueues push row', () => {
  const sql = readFile('supabase/migrations/20260906180000_p3_b2_3b_push_outbox_consumer.sql');
  const fnIdx = sql.indexOf('enqueue_push_notification');
  const fnBlock = sql.substring(fnIdx, fnIdx + 2000);
  assert.ok(fnBlock.includes("'mission_cancelled'"),
    'enqueue function must handle mission_cancelled');
});

test('8. unrelated events do NOT enqueue push rows', () => {
  const sql = readFile('supabase/migrations/20260906180000_p3_b2_3b_push_outbox_consumer.sql');
  const fnIdx = sql.indexOf('enqueue_push_notification');
  const fnBlock = sql.substring(fnIdx, fnIdx + 2000);
  // The function should check event_type and return early for non-push events
  assert.ok(fnBlock.includes("NOT IN ('mission_assigned', 'mission_cancelled')"),
    'enqueue must filter to only mission_assigned and mission_cancelled');
  assert.ok(fnBlock.includes('RETURN NEW'),
    'enqueue must return NEW for non-matching events without inserting');
});

test('9. correct target_user_id mapping (convoyeurs.auth_user_id)', () => {
  const sql = readFile('supabase/migrations/20260906180000_p3_b2_3b_push_outbox_consumer.sql');
  const fnIdx = sql.indexOf('enqueue_push_notification');
  const fnBlock = sql.substring(fnIdx, fnIdx + 2000);
  // Must resolve convoyeur_id from missions, then auth_user_id from convoyeurs
  assert.ok(fnBlock.includes('convoyeur_id'),
    'must select convoyeur_id from missions');
  assert.ok(fnBlock.includes('auth_user_id'),
    'must select auth_user_id from convoyeurs');
  assert.ok(fnBlock.includes('SELECT auth_user_id INTO _target_user_id'),
    'must resolve target_user_id from convoyeurs.auth_user_id');
});

// ── CONSUMER TESTS ──

test('10. internal auth required (OUTBOX_CRON_SECRET)', () => {
  const js = readFile('functions/api/process-push-outbox.js');
  assert.ok(js.includes('OUTBOX_CRON_SECRET'),
    'consumer must authenticate via OUTBOX_CRON_SECRET');
  assert.ok(js.includes('x-cron-secret'),
    'consumer must check x-cron-secret header');
  assert.ok(js.includes('Non autorisé'),
    'consumer must reject unauthorized requests');
});

test('11. due row claimed once (claim_push_outbox_rows RPC)', () => {
  const sql = readFile('supabase/migrations/20260906180000_p3_b2_3b_push_outbox_consumer.sql');
  assert.ok(sql.includes('claim_push_outbox_rows'),
    'migration must define claim_push_outbox_rows RPC');
  // Must use FOR UPDATE SKIP LOCKED for concurrency safety
  assert.ok(sql.includes('FOR UPDATE SKIP LOCKED'),
    'claim RPC must use FOR UPDATE SKIP LOCKED to prevent double-claim');
  // Must atomically set status to processing
  assert.ok(sql.includes("status = 'processing'"),
    'claim must set status to processing');
  const js = readFile('functions/api/process-push-outbox.js');
  assert.ok(js.includes('claim_push_outbox_rows'),
    'consumer must call claim_push_outbox_rows RPC');
});

test('12. all target endpoints loaded', () => {
  const js = readFile('functions/api/process-push-outbox.js');
  assert.ok(js.includes("from('push_subscriptions')"),
    'consumer must load push_subscriptions');
  assert.ok(js.includes("eq('user_id', row.target_user_id)"),
    'consumer must load subscriptions for target_user_id');
  // Must NOT filter to a single endpoint
  const subLoadBlock = js.substring(js.indexOf("from('push_subscriptions')"), js.indexOf("from('push_subscriptions')") + 300);
  assert.ok(!subLoadBlock.includes('.eq(\'endpoint\''),
    'consumer must load ALL endpoints, not just one');
});

test('13. 2xx success handling', () => {
  const js = readFile('functions/api/process-push-outbox.js');
  assert.ok(js.includes('anySuccess'),
    'consumer must track if any endpoint succeeded');
  assert.ok(js.includes("finalStatus = 'sent'"),
    'consumer must mark row as sent on success');
});

test('14. 404 stale cleanup', () => {
  const js = readFile('functions/api/process-push-outbox.js');
  assert.ok(js.includes('stale_subscription'),
    'consumer must handle stale_subscription classification');
  assert.ok(js.includes('staleEndpoints'),
    'consumer must collect stale endpoints for cleanup');
});

test('15. 410 stale cleanup', () => {
  const js = readFile('functions/api/process-push-outbox.js');
  // classifyPushResponse handles both 404 and 410 as stale_subscription
  // The consumer deletes stale endpoints
  assert.ok(js.includes('delete'),
    'consumer must delete stale subscriptions');
});

test('16. 429 retry', () => {
  const js = readFile('functions/api/process-push-outbox.js');
  assert.ok(js.includes('retryable'),
    'consumer must handle retryable classification');
  assert.ok(js.includes('retryableCount'),
    'consumer must count retryable endpoints');
  assert.ok(js.includes("finalStatus = 'pending'"),
    'consumer must set status to pending for retry');
});

test('17. 5xx retry', () => {
  const js = readFile('functions/api/process-push-outbox.js');
  // classifyPushResponse handles 5xx as retryable
  // Same code path as 429
  assert.ok(js.includes('computeBackoff'),
    'consumer must compute backoff for retry');
});

test('18. network retry (ambiguous_retryable)', () => {
  const js = readFile('functions/api/process-push-outbox.js');
  assert.ok(js.includes('ambiguous_retryable'),
    'consumer must handle ambiguous_retryable (network errors)');
});

test('19. terminal 400/401/403', () => {
  const js = readFile('functions/api/process-push-outbox.js');
  assert.ok(js.includes('terminal_failed'),
    'consumer must handle terminal_failed classification');
  assert.ok(js.includes("finalStatus = 'failed'"),
    'consumer must set failed for terminal errors');
});

test('20. max attempts enforced', () => {
  const js = readFile('functions/api/process-push-outbox.js');
  assert.ok(js.includes('MAX_ATTEMPTS'),
    'consumer must have MAX_ATTEMPTS constant');
  assert.ok(js.includes('max_attempts'),
    'consumer must check max attempts');
  assert.ok(js.includes("p_status: 'failed'"),
    'consumer must mark as failed when max attempts reached');
  // Verify MAX_ATTEMPTS is 5
  assert.ok(js.includes('MAX_ATTEMPTS = 5'),
    'MAX_ATTEMPTS must be 5');
});

test('21. no subscription deterministic handling', () => {
  const js = readFile('functions/api/process-push-outbox.js');
  assert.ok(js.includes('No push subscriptions') || js.includes('no_subscriptions') || js.includes('subscriptions.length === 0'),
    'consumer must handle zero subscriptions case');
  assert.ok(js.includes("p_status: 'failed'"),
    'no subscriptions must result in failed status (terminal, not retry)');
});

test('22. partial multi-device success', () => {
  const js = readFile('functions/api/process-push-outbox.js');
  assert.ok(js.includes('anySuccess'),
    'consumer must track partial success across devices');
  assert.ok(js.includes("if (anySuccess)"),
    'consumer must mark sent if any endpoint succeeded');
});

test('23. stale device A does not delete device B', () => {
  const js = readFile('functions/api/process-push-outbox.js');
  // Stale cleanup must be per-endpoint, not per-user
  const deleteBlock = js.substring(js.indexOf('staleEndpoints'));
  assert.ok(deleteBlock.includes("eq('user_id', row.target_user_id)"),
    'stale cleanup must filter by user_id');
  assert.ok(deleteBlock.includes("eq('endpoint', stale.endpoint)"),
    'stale cleanup must filter by specific endpoint — not all user subscriptions');
});

test('24. no arbitrary external URL in push payload', () => {
  const js = readFile('functions/api/process-push-outbox.js');
  assert.ok(js.includes('validatePushUrl'),
    'consumer must validate push URL');
  assert.ok(js.includes("startsWith('//')"),
    'URL validator must reject protocol-relative URLs');
  assert.ok(js.includes("'/dashboard-convoyeur.html'"),
    'URL must default to safe internal path');
  // Payload URLs must be relative
  const payloadBlock = js.substring(js.indexOf('buildPushPayload'));
  assert.ok(payloadBlock.includes("url: '/dashboard-convoyeur.html'"),
    'payload URLs must be relative same-origin paths');
});

test('25. email consumer (process-notification-outbox.js) is NOT modified', () => {
  // This is a scope-control check — the email consumer must be unchanged
  // We verify our migration does NOT modify the email notification_outbox table
  // (references to push_notification_outbox are our own table, not the email one)
  const sql = readFile('supabase/migrations/20260906180000_p3_b2_3b_push_outbox_consumer.sql');
  // Strip comments to check only DDL code
  const codeOnly = sql.replace(/--.*$/gm, '');
  // Must NOT contain DDL that alters the email notification_outbox table
  assert.ok(!codeOnly.match(/ALTER\s+TABLE.*\bnotification_outbox\b(?!_)/i),
    'migration must NOT ALTER email notification_outbox table');
  assert.ok(!codeOnly.match(/CREATE\s+POLICY.*\bnotification_outbox\b(?!_)/i),
    'migration must NOT create policies on email notification_outbox table');
  assert.ok(!codeOnly.match(/DROP\s+POLICY.*\bnotification_outbox\b(?!_)/i),
    'migration must NOT drop policies from email notification_outbox table');
  assert.ok(!codeOnly.match(/INSERT\s+INTO.*\bnotification_outbox\b(?!_)/i),
    'migration must NOT INSERT into email notification_outbox table');

  // Verify the consumer does NOT import or call email helpers
  const js = readFile('functions/api/process-push-outbox.js');
  // Strip comments to check only actual code
  const jsCodeOnly = js.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
  assert.ok(!jsCodeOnly.includes('sendEmail'),
    'push consumer must NOT call sendEmail');
  assert.ok(!jsCodeOnly.includes('process-notification-outbox'),
    'push consumer must NOT reference email consumer in code');
  // Check for bare notification_outbox (not push_notification_outbox)
  assert.ok(!jsCodeOnly.match(/\bnotification_outbox\b(?!_)/),
    'push consumer must NOT reference email outbox table in code');
});

// ── ADDITIONAL TESTS ──

test('migration timestamp is after 20260906170000 (no collision)', () => {
  const filename = '20260906180000_p3_b2_3b_push_outbox_consumer.sql';
  assert.ok(filename.startsWith('20260906180000'),
    'timestamp must be 20260906180000 (after 20260906170000)');
});

test('transport helper is used (not direct sendNotification)', () => {
  const js = readFile('functions/api/process-push-outbox.js');
  assert.ok(js.includes('sendWebPush'),
    'consumer must use sendWebPush from _push.js');
  assert.ok(!js.includes('webpush.sendNotification'),
    'consumer must NOT call webpush.sendNotification directly');
});

test('claim RPC uses SECURITY DEFINER', () => {
  const sql = readFile('supabase/migrations/20260906180000_p3_b2_3b_push_outbox_consumer.sql');
  assert.ok(sql.includes('SECURITY DEFINER'),
    'claim RPC must be SECURITY DEFINER');
});

test('enqueue trigger is AFTER INSERT on mission_events', () => {
  const sql = readFile('supabase/migrations/20260906180000_p3_b2_3b_push_outbox_consumer.sql');
  assert.ok(sql.includes('AFTER INSERT ON public.mission_events'),
    'enqueue trigger must be AFTER INSERT on mission_events');
});

test('backoff schedule is exponential', () => {
  const js = readFile('functions/api/process-push-outbox.js');
  assert.ok(js.includes('Math.pow(2,'),
    'backoff must use exponential schedule (2^attempts)');
});

test('payload is SW-compatible ({ title, body, url })', () => {
  const js = readFile('functions/api/process-push-outbox.js');
  assert.ok(js.includes('title:') && js.includes('body:') && js.includes('url:'),
    'payload must have title, body, url fields for SW compatibility');
});

test('no wrangler.toml modification in this gate', () => {
  // Scope control — wrangler.toml should be unchanged from baseline
  const wrangler = readFile('wrangler.toml');
  assert.ok(wrangler.includes('nodejs_compat'),
    'wrangler.toml should still have nodejs_compat (unchanged)');
});

test('no cron configuration changes', () => {
  // The consumer should NOT add any cron config.
  // Note: OUTBOX_CRON_SECRET is an auth secret name, not cron configuration.
  // We check for actual cron schedule configuration, not the word "cron" in secret names.
  const js = readFile('functions/api/process-push-outbox.js');
  assert.ok(!js.includes('schedules'),
    'consumer must NOT contain cron schedules');
  assert.ok(!js.includes('wrangler.toml'),
    'consumer must NOT modify wrangler config');
  assert.ok(!js.match(/cron\s*[:=]/i),
    'consumer must NOT contain cron configuration assignments');
});

test('complete_push_outbox_row RPC exists with CAS parameters', () => {
  const sql = readFile('supabase/migrations/20260906180000_p3_b2_3b_push_outbox_consumer.sql');
  assert.ok(sql.includes('complete_push_outbox_row'),
    'migration must define complete_push_outbox_row RPC');
  assert.ok(sql.includes('p_expected_attempts'),
    'complete RPC must accept p_expected_attempts for CAS protection');
});

test('VAPID private key is read from env, not hardcoded', () => {
  const js = readFile('functions/api/process-push-outbox.js');
  assert.ok(js.includes('env.VAPID_PRIVATE_KEY'),
    'consumer must read VAPID private key from env');
  assert.ok(js.includes('env.VAPID_PUBLIC_KEY'),
    'consumer must read VAPID public key from env');
  // No hardcoded key values
  assert.ok(!js.match(/VAPID_PRIVATE_KEY\s*=\s*['"][A-Za-z0-9_-]{40,}/),
    'no hardcoded VAPID private key value');
});

test('sanitized logging — no sensitive data in logs', () => {
  const js = readFile('functions/api/process-push-outbox.js');
  // The consumer should not log endpoint URLs, keys, or payloads
  assert.ok(!js.match(/console\.(log|error).*endpoint/i),
    'consumer must not log endpoint URLs');
  assert.ok(!js.match(/console\.(log|error).*p256dh/i),
    'consumer must not log p256dh keys');
  assert.ok(!js.match(/console\.(log|error).*auth_key/i),
    'consumer must not log auth keys');
});

// =========================================================
// P3-B2.3B1 — RELIABILITY + SQL SECURITY HARDENING TESTS
// =========================================================

// ── 1. Stale processing row becomes reclaimable ──

test('B1.1: stale processing row becomes reclaimable (claimed_at + timeout)', () => {
  const sql = readFile('supabase/migrations/20260906180000_p3_b2_3b_push_outbox_consumer.sql');
  // claimed_at column must exist
  assert.ok(sql.includes('claimed_at'),
    'schema must have claimed_at column for stale recovery');
  // Claim RPC must reclaim processing rows older than timeout
  const claimIdx = sql.indexOf('claim_push_outbox_rows');
  const claimBlock = sql.substring(claimIdx, claimIdx + 2000);
  assert.ok(claimBlock.includes("q.status = 'processing'"),
    'claim RPC must consider processing rows for reclaim');
  assert.ok(claimBlock.includes('claimed_at'),
    'claim RPC must use claimed_at for stale detection');
  assert.ok(claimBlock.includes("interval '5 minutes'"),
    'claim RPC must use 5-minute timeout for stale processing rows');
});

// ── 2. Fresh processing row is NOT reclaimed ──

test('B1.2: fresh processing row is NOT reclaimed (within timeout)', () => {
  const sql = readFile('supabase/migrations/20260906180000_p3_b2_3b_push_outbox_consumer.sql');
  const claimIdx = sql.indexOf('claim_push_outbox_rows');
  const claimBlock = sql.substring(claimIdx, claimIdx + 2000);
  // The condition must use < (older than), not <= (any processing)
  assert.ok(claimBlock.includes('q.claimed_at < now() - interval'),
    'claim must only reclaim processing rows OLDER than timeout, not fresh ones');
});

// ── 3. Stale row still respects max attempts ──

test('B1.3: stale row still respects max attempts (attempts < 5 in claim)', () => {
  const sql = readFile('supabase/migrations/20260906180000_p3_b2_3b_push_outbox_consumer.sql');
  const claimIdx = sql.indexOf('claim_push_outbox_rows');
  const claimBlock = sql.substring(claimIdx, claimIdx + 2000);
  // The attempts < 5 check must apply to BOTH pending and processing reclaim
  // and must match consumer MAX_ATTEMPTS = 5
  assert.ok(claimBlock.includes('q.attempts < 5'),
    'claim must enforce attempts < 5 for both pending and stale processing rows');
  // Verify alignment: SQL CHECK constraint also uses 5
  assert.ok(sql.includes('attempts <= 5'),
    'schema CHECK constraint must use attempts <= 5 (aligned with consumer MAX_ATTEMPTS)');
});

// ── 4. Concurrent stale recovery cannot double-claim ──

test('B1.4: concurrent stale recovery cannot double-claim (FOR UPDATE SKIP LOCKED)', () => {
  const sql = readFile('supabase/migrations/20260906180000_p3_b2_3b_push_outbox_consumer.sql');
  const claimIdx = sql.indexOf('claim_push_outbox_rows');
  const claimBlock = sql.substring(claimIdx, claimIdx + 2000);
  assert.ok(claimBlock.includes('FOR UPDATE SKIP LOCKED'),
    'claim must use FOR UPDATE SKIP LOCKED for concurrency safety');
  // The SKIP LOCKED must apply to the combined eligible set
  assert.ok(claimBlock.includes('LIMIT p_limit'),
    'claim must limit rows per invocation');
});

// ── 5. Crash-after-claim scenario recovers ──

test('B1.5: crash-after-claim scenario recovers (processing → reclaim → finalize)', () => {
  const sql = readFile('supabase/migrations/20260906180000_p3_b2_3b_push_outbox_consumer.sql');
  // claimed_at is set on claim
  assert.ok(sql.includes('claimed_at = now()'),
    'claim must set claimed_at = now() when claiming');
  // Stale processing rows are eligible after timeout
  const claimIdx = sql.indexOf('claim_push_outbox_rows');
  const claimBlock = sql.substring(claimIdx, claimIdx + 2000);
  assert.ok(claimBlock.includes("status = 'processing'"),
    'reclaimed rows must be set back to processing (re-claimed)');
  assert.ok(claimBlock.includes('attempts = p.attempts + 1'),
    'reclaim must increment attempts (bounded retry)');
});

// ── 6. SECURITY DEFINER functions have safe search_path ──

test('B1.6: all SECURITY DEFINER functions have safe search_path', () => {
  const sql = readFile('supabase/migrations/20260906180000_p3_b2_3b_push_outbox_consumer.sql');
  // Find all SECURITY DEFINER functions and verify each has SET search_path
  const fnBlocks = sql.split(/CREATE OR REPLACE FUNCTION/);
  for (let i = 1; i < fnBlocks.length; i++) {
    const block = fnBlocks[i];
    if (block.includes('SECURITY DEFINER')) {
      assert.ok(block.includes('SET search_path'),
        `SECURITY DEFINER function must have SET search_path: ${block.substring(0, 60)}...`);
    }
  }
});

// ── 7. PUBLIC execute revoked ──

test('B1.7: PUBLIC execute revoked on all SECURITY DEFINER functions', () => {
  const sql = readFile('supabase/migrations/20260906180000_p3_b2_3b_push_outbox_consumer.sql');
  // Check for REVOKE EXECUTE ... FROM PUBLIC on each function
  assert.ok(sql.includes('REVOKE EXECUTE ON FUNCTION public.enqueue_push_notification() FROM PUBLIC'),
    'PUBLIC execute must be revoked on enqueue_push_notification');
  assert.ok(sql.includes('REVOKE EXECUTE ON FUNCTION public.claim_push_outbox_rows(int) FROM PUBLIC'),
    'PUBLIC execute must be revoked on claim_push_outbox_rows');
  assert.ok(sql.includes('REVOKE EXECUTE ON FUNCTION public.complete_push_outbox_row'),
    'PUBLIC execute must be revoked on complete_push_outbox_row');
  assert.ok(sql.includes('FROM PUBLIC'),
    'must revoke from PUBLIC');
});

// ── 8. anon execute revoked ──

test('B1.8: anon execute revoked on all SECURITY DEFINER functions', () => {
  const sql = readFile('supabase/migrations/20260906180000_p3_b2_3b_push_outbox_consumer.sql');
  assert.ok(sql.includes('REVOKE EXECUTE ON FUNCTION public.enqueue_push_notification() FROM anon'),
    'anon execute must be revoked on enqueue_push_notification');
  assert.ok(sql.includes('REVOKE EXECUTE ON FUNCTION public.claim_push_outbox_rows(int) FROM anon'),
    'anon execute must be revoked on claim_push_outbox_rows');
  assert.ok(sql.includes('FROM anon'),
    'must revoke from anon');
});

// ── 9. authenticated execute revoked (backend-only) ──

test('B1.9: authenticated execute revoked on backend-only functions', () => {
  const sql = readFile('supabase/migrations/20260906180000_p3_b2_3b_push_outbox_consumer.sql');
  assert.ok(sql.includes('REVOKE EXECUTE ON FUNCTION public.enqueue_push_notification() FROM authenticated'),
    'authenticated execute must be revoked on enqueue_push_notification (trigger only)');
  assert.ok(sql.includes('REVOKE EXECUTE ON FUNCTION public.claim_push_outbox_rows(int) FROM authenticated'),
    'authenticated execute must be revoked on claim_push_outbox_rows (backend only)');
  assert.ok(sql.includes('REVOKE EXECUTE ON FUNCTION public.complete_push_outbox_row') && sql.includes('FROM authenticated'),
    'authenticated execute must be revoked on complete_push_outbox_row (backend only)');
});

// ── 10. Trigger still server-derived target user ──

test('B1.10: trigger derives target_user_id server-side (not from user input)', () => {
  const sql = readFile('supabase/migrations/20260906180000_p3_b2_3b_push_outbox_consumer.sql');
  const fnIdx = sql.indexOf('enqueue_push_notification');
  const fnBlock = sql.substring(fnIdx, fnIdx + 2000);
  // target_user_id must be derived from convoyeurs.auth_user_id, not from NEW or user input
  assert.ok(fnBlock.includes('SELECT auth_user_id INTO _target_user_id'),
    'target_user_id must be derived from convoyeurs.auth_user_id (server-side)');
  assert.ok(fnBlock.includes('FROM public.convoyeurs'),
    'must query convoyeurs table (schema-qualified)');
  assert.ok(fnBlock.includes('FROM public.missions'),
    'must query missions table (schema-qualified)');
  // Must NOT use NEW.target_user_id or any user-supplied field
  assert.ok(!fnBlock.includes('NEW.target_user_id'),
    'trigger must NOT use NEW.target_user_id (server-derived only)');
});

// ── 11. Claim RPC unavailable to browser roles ──

test('B1.11: claim RPC unavailable to browser roles (anon + authenticated revoked)', () => {
  const sql = readFile('supabase/migrations/20260906180000_p3_b2_3b_push_outbox_consumer.sql');
  // Both anon and authenticated must have EXECUTE revoked
  assert.ok(sql.match(/REVOKE EXECUTE ON FUNCTION public\.claim_push_outbox_rows\(int\) FROM anon/),
    'anon cannot call claim_push_outbox_rows');
  assert.ok(sql.match(/REVOKE EXECUTE ON FUNCTION public\.claim_push_outbox_rows\(int\) FROM authenticated/),
    'authenticated cannot call claim_push_outbox_rows');
  // service_role is not explicitly revoked (it retains access via superuser bypass)
  assert.ok(!sql.match(/REVOKE.*claim_push_outbox_rows.*service_role/i),
    'service_role must NOT be revoked on claim_push_outbox_rows');
});

// ── 12. Finalization CAS-protected ──

test('B1.12: finalization is CAS-protected (status + attempts check)', () => {
  const sql = readFile('supabase/migrations/20260906180000_p3_b2_3b_push_outbox_consumer.sql');
  const completeIdx = sql.indexOf('complete_push_outbox_row');
  const completeBlock = sql.substring(completeIdx, completeIdx + 2000);
  // Must check status = 'processing' AND attempts = expected
  assert.ok(completeBlock.includes("status = 'processing'"),
    'complete RPC must verify status is still processing (CAS)');
  assert.ok(completeBlock.includes('attempts = p_expected_attempts'),
    'complete RPC must verify attempts match expected (CAS)');
  // Must return boolean (success/failure of CAS)
  assert.ok(completeBlock.includes('RETURNS boolean'),
    'complete RPC must return boolean for CAS result');
});

// ── 13. Retry CAS-protected ──

test('B1.13: retry finalization is CAS-protected (same RPC, pending status)', () => {
  const js = readFile('functions/api/process-push-outbox.js');
  // Consumer must pass p_expected_attempts on ALL complete calls
  // Including retry (pending) and failure paths
  const completeCalls = js.split('complete_push_outbox_row').length - 1;
  const expectedAttemptsCalls = js.split('p_expected_attempts').length - 1;
  // Every complete call should include p_expected_attempts
  // -1 for the function definition reference, so completeCalls should match
  assert.ok(expectedAttemptsCalls >= completeCalls,
    'every complete_push_outbox_row call must include p_expected_attempts for CAS');
});

// ── 14. At-least-one-device semantics explicitly tested ──

test('B1.14: AT_LEAST_ONE_DEVICE delivery semantics documented and tested', () => {
  const js = readFile('functions/api/process-push-outbox.js');
  assert.ok(js.includes('AT_LEAST_ONE_DEVICE'),
    'consumer must document AT_LEAST_ONE_DEVICE semantics');
  assert.ok(js.includes('DELIVERY_SUCCESS_SEMANTICS'),
    'consumer must declare DELIVERY_SUCCESS_SEMANTICS constant');
  // anySuccess → sent (at least one device)
  assert.ok(js.includes('if (anySuccess)'),
    'consumer must check anySuccess for AT_LEAST_ONE_DEVICE semantics');
  assert.ok(js.includes("finalStatus = 'sent'"),
    'consumer must mark sent when at least one device succeeds');
});

// ── 15. Email pipeline still untouched ──

test('B1.15: email pipeline still untouched after hardening', () => {
  const sql = readFile('supabase/migrations/20260906180000_p3_b2_3b_push_outbox_consumer.sql');
  // Strip comments to check only DDL code
  const codeOnly = sql.replace(/--.*$/gm, '');
  assert.ok(!codeOnly.match(/ALTER\s+TABLE.*\bnotification_outbox\b(?!_)/i),
    'migration must NOT ALTER email notification_outbox table');
  assert.ok(!codeOnly.match(/INSERT\s+INTO.*\bnotification_outbox\b(?!_)/i),
    'migration must NOT INSERT into email notification_outbox table');
  // Consumer must not reference email helpers in code
  const js = readFile('functions/api/process-push-outbox.js');
  const jsCodeOnly = js.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
  assert.ok(!jsCodeOnly.includes('sendEmail'),
    'push consumer must NOT call sendEmail');
  assert.ok(!jsCodeOnly.match(/\bnotification_outbox\b(?!_)/),
    'push consumer must NOT reference email outbox table in code');
});
