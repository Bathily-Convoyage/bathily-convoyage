import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const migrationPath = path.join(
  here,
  '..',
  'supabase',
  'migrations',
  '20260824063918_security_definer_least_privilege.sql',
);
const sql = fs.readFileSync(migrationPath, 'utf8');
const dashboard = fs.readFileSync(path.join(here, '..', 'dashboard-convoyeur.html'), 'utf8');

const checks = [
  ['transaction wrapper', /^BEGIN;[\s\S]*COMMIT;\s*$/i],
  ['future functions private by default', /ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public[\s\S]*REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC, anon, authenticated, service_role;/i],
  ['notification trigger is not client-callable', /REVOKE EXECUTE ON FUNCTION public\.enqueue_mission_notification\(\) FROM PUBLIC, anon, authenticated, service_role;/i],
  ['client guard trigger is not client-callable', /REVOKE EXECUTE ON FUNCTION public\.guard_clients_privileged_fields\(\) FROM PUBLIC, anon, authenticated, service_role;/i],
  ['role sync trigger is not client-callable', /REVOKE EXECUTE ON FUNCTION public\.sync_user_roles_on_client_role\(\) FROM PUBLIC, anon, authenticated, service_role;/i],
  ['admin assignment rejects anon at ACL', /REVOKE EXECUTE ON FUNCTION public\.admin_assign_mission\(uuid, uuid\) FROM PUBLIC, anon;/i],
  ['GPS write rejects anon at ACL', /REVOKE EXECUTE ON FUNCTION public\.record_gps_position\([^)]+\) FROM PUBLIC, anon;/i],
  ['workflow transition rejects anon at ACL', /REVOKE EXECUTE ON FUNCTION public\.transition_mission_status\(uuid, text, text, jsonb\) FROM PUBLIC, anon;/i],
  ['admin email helper is backend-only', /REVOKE EXECUTE ON FUNCTION public\.is_admin_by_email\(text\) FROM PUBLIC, anon, authenticated;[\s\S]*GRANT EXECUTE ON FUNCTION public\.is_admin_by_email\(text\) TO service_role;/i],
  ['admin email helper has locked search path', /CREATE OR REPLACE FUNCTION public\.is_admin_by_email[\s\S]*SET search_path TO ''/i],
  ['likes ledger has one row per user and post', /PRIMARY KEY \(post_id, user_id\)/i],
  ['likes ledger uses RLS', /ALTER TABLE public\.reseau_post_likes ENABLE ROW LEVEL SECURITY;/i],
  ['likes RPC requires a signed-in user', /v_user_id uuid := auth\.uid\(\);[\s\S]*IF v_user_id IS NULL/i],
  ['likes RPC is idempotent', /ON CONFLICT \(post_id, user_id\) DO NOTHING;/i],
  ['counter changes only for a new ledger row', /GET DIAGNOSTICS v_inserted = ROW_COUNT;[\s\S]*IF v_inserted = 1 THEN[\s\S]*UPDATE public\.reseau_posts/i],
  ['likes RPC remains authenticated-only', /REVOKE EXECUTE ON FUNCTION public\.like_reseau_post\(uuid\) FROM PUBLIC, anon, service_role;[\s\S]*GRANT EXECUTE ON FUNCTION public\.like_reseau_post\(uuid\) TO authenticated;/i],
];

for (const [name, pattern] of checks) {
  assert.match(sql, pattern, name);
  console.log(`ok - ${name}`);
}

assert.doesNotMatch(sql, /GRANT EXECUTE[^;]+TO anon/i, 'migration must not add anonymous RPC access');
assert.match(
  dashboard,
  /await client\.rpc\('like_reseau_post'[\s\S]*select\('likes_count'\)[\s\S]*span\.textContent = data\.likes_count/,
  'dashboard must render the authoritative counter returned by the database read',
);
assert.doesNotMatch(
  dashboard,
  /span\.textContent = current \+ 1;[\s\S]*like_reseau_post/,
  'dashboard must not optimistically inflate the counter before the RPC succeeds',
);
console.log('ok - dashboard renders the authoritative likes counter');

console.log(`\n${checks.length + 3}/${checks.length + 3} security hardening checks passed`);
