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
  '20260825072420_rpc_acl_hardening_p3_5.sql',
);

const sql = fs.readFileSync(migrationPath, 'utf8');
const normalized = sql.replace(/\s+/g, ' ').trim().toLowerCase();

const anonAuthenticatedService = [
  'public.external_convoyeurs_enabled()',
  'public.get_public_tracking(text)',
  'public.unsubscribe_newsletter_by_token(text)',
];

const authenticatedService = [
  'public.is_admin()',
  'public.is_internal_user()',
  'public.is_operator()',
  'public.admin_assign_mission(uuid, uuid)',
  'public.admin_toggle_ban(uuid, text, boolean)',
  'public.apply_parrainage_code(text)',
  'public.authorize_gps_session(uuid)',
  'public.create_mission_expense_draft(uuid, text, numeric, date, text)',
  'public.create_tracking_token(uuid)',
  'public.delete_mission_expense_draft(uuid)',
  'public.get_mission_contact(uuid)',
  'public.mark_mission_paid(uuid)',
  'public.record_gps_position(uuid, double precision, double precision, double precision, double precision)',
  'public.register_mission_expense_receipt(uuid, text, text, text)',
  'public.register_mission_incident_evidence(uuid, text, text, text)',
  'public.report_mission_incident(uuid, text, text, text, text, timestamptz, text)',
  'public.respond_mission_assignment(uuid, boolean)',
  'public.review_mission_expense(uuid, text, text)',
  'public.review_mission_incident(uuid, text, text)',
  'public.revoke_tracking_token(uuid)',
  'public.submit_mission_expense(uuid)',
  'public.transition_mission_status(uuid, text, text, jsonb)',
  'public.update_mission_expense_draft(uuid, text, numeric, date, text)',
  'public.update_mission_incident(uuid, text, text, text, text, text)',
  'public.validate_mission_edl(uuid, text, jsonb, uuid, text)',
];

const authenticatedOnly = [
  'public.admin_delete_user(uuid, text)',
  'public.like_reseau_post(uuid)',
];

const expectedRoles = new Map([
  ...anonAuthenticatedService.map((signature) => [signature, ['anon', 'authenticated', 'service_role']]),
  ...authenticatedService.map((signature) => [signature, ['authenticated', 'service_role']]),
  ...authenticatedOnly.map((signature) => [signature, ['authenticated']]),
]);

assert.equal(expectedRoles.size, 30, 'the allowlist must cover all 30 advisor-reported SECURITY DEFINER functions');
assert.match(normalized, /^begin;[\s\S]*commit;$/, 'migration must be transactional');

for (const [signature, roles] of expectedRoles) {
  const revoke = `revoke execute on function ${signature} from public, anon, authenticated, service_role;`;
  const grant = `grant execute on function ${signature} to ${roles.join(', ')};`;

  assert.ok(normalized.includes(revoke), `${signature} must first revoke every inherited/client role`);
  assert.ok(normalized.includes(grant), `${signature} must receive only its documented roles`);
  console.log(`ok - ${signature} -> ${roles.join(', ')}`);
}

const grantStatements = [...normalized.matchAll(/grant execute on function ([^;]+?) to ([^;]+);/g)];
assert.equal(grantStatements.length, expectedRoles.size, 'migration must not contain an undocumented function grant');
assert.ok(
  grantStatements.every((match) => !match[2].split(',').map((role) => role.trim()).includes('public')),
  'PUBLIC must never receive EXECUTE',
);

const anonGrants = grantStatements
  .filter((match) => match[2].split(',').map((role) => role.trim()).includes('anon'))
  .map((match) => match[1]);
assert.deepEqual(anonGrants, anonAuthenticatedService, 'only the three capability endpoints may remain anonymous');

assert.ok(
  normalized.includes("alter function public.apply_parrainage_code(text) set search_path to '';"),
  'apply_parrainage_code must use an empty search_path',
);
assert.ok(
  !normalized.includes('grant execute on function public.is_admin() to anon'),
  'is_admin must not be callable anonymously',
);
assert.ok(
  !normalized.includes('grant execute on function public.is_internal_user() to anon'),
  'is_internal_user must not be callable anonymously',
);

console.log(`\n${expectedRoles.size + 6}/${expectedRoles.size + 6} P3.5 RPC ACL checks passed`);
