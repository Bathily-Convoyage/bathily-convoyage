import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const migrationUrl = new URL('../supabase/migrations/20260824055850_stripe_checkout_atomic_renewal.sql', import.meta.url);
const sql = await readFile(migrationUrl, 'utf8');

const checks = [
  ['defines the CAS RPC', /CREATE OR REPLACE FUNCTION public\.replace_stripe_checkout_session\s*\(/i],
  ['locks the mission row', /FROM public\.missions[\s\S]*FOR UPDATE;/i],
  ['uses null-safe expected-session comparison', /stripe_session_id IS DISTINCT FROM p_expected_session_id/i],
  ['is idempotent for the winning session', /stripe_session_id = p_new_session_id[\s\S]*RETURN 'already_linked'/i],
  ['updates only stripe_session_id', /UPDATE public\.missions\s+SET stripe_session_id = p_new_session_id/i],
  ['revokes PUBLIC execution', /REVOKE EXECUTE ON FUNCTION public\.replace_stripe_checkout_session\(uuid, text, text\) FROM PUBLIC;/i],
  ['revokes anon execution', /REVOKE EXECUTE ON FUNCTION public\.replace_stripe_checkout_session\(uuid, text, text\) FROM anon;/i],
  ['revokes authenticated execution', /REVOKE EXECUTE ON FUNCTION public\.replace_stripe_checkout_session\(uuid, text, text\) FROM authenticated;/i],
  ['grants only service_role execution', /GRANT EXECUTE ON FUNCTION public\.replace_stripe_checkout_session\(uuid, text, text\) TO service_role;/i],
];

for (const [name, pattern] of checks) {
  assert.match(sql, pattern, name);
  console.log(`  ✓ ${name}`);
}

assert.doesNotMatch(sql, /ALTER TABLE|ADD COLUMN|CREATE TABLE/i, 'migration must not change the table schema');
console.log('  ✓ no table or column change');
console.log(`\n${checks.length + 1} passed, 0 failed`);
