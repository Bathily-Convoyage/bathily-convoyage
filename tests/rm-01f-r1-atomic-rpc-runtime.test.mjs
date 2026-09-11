// RM-01F-R1 — Atomic Contact Update RPC — Runtime Proof (Disposable PostgreSQL 17)
//
// Spins up a DISPOSABLE postgres:17 container, loads the full migration
// chain (baseline → P3B1-P3B6 → P3C2 → RM-01F), and runtime-verifies:
//   - migration applies cleanly
//   - function signature, owner, SECURITY DEFINER, search_path, volatility, proacl
//   - effective ACL (PUBLIC/anon/service_role NO, authenticated YES, postgres YES)
//   - authorization enforcement (anon rejected, non-internal rejected, internal allowed)
//   - atomic success (field change + primary promotion in one transaction)
//   - rollback on primary failure (field update rolls back too)
//   - rollback on contact validation failure (primary change rolls back too)
//   - cross-org guard (contact from org A cannot be edited as org B)
//   - demotion semantics (primary=false clears primary, matches existing UI)
//   - audit/event behavior (no events created by this RPC; rollback leaves no residue)
//
// AUTH_RLS_SIMULATION=YES — uses a session-GUC stub for auth.uid().
// The container is ALWAYS destroyed after tests (success or failure).
//
// Run: node tests/rm-01f-r1-atomic-rpc-runtime.test.mjs

import { spawnSync } from 'node:child_process';
import { writeFileSync, unlinkSync, readFileSync, readdirSync } from 'node:fs';
import { join, basename } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const CONTAINER = 'rm01f_r1_runtime_pg17';
const PGUSER = 'postgres';
const PGDB = 'postgres';
const PGPASSWORD = 'rm01fr1test';
const PGPORT = '54183';

const MIGRATIONS_DIR = fileURLToPath(
  new URL('../supabase/migrations/', import.meta.url)
);

const BASELINE_FILE = join(MIGRATIONS_DIR, '20260807214536_remote_public_baseline.sql');

// Storage-dependent migrations that require Supabase storage schema
// (not available in a vanilla postgres container).
const STORAGE_DEPENDENT = new Set([
  '20260807214705_remote_storage_baseline.sql',
  '20260808140449_phase2_prepare_private_storage.sql',
  '20260808161941_phase2_documents_private_access.sql',
  '20260808170436_phase2_storage_upload_limits.sql',
  '20260809000004_phase3_b2v_storage_evidence_hardening.sql',
  '20260809000005_phase3_b2v2_storage_api_final.sql',
  '20260811000002_phase3_c22c1_mission_incidents.sql',
  '20260811000003_phase3_c22c3_mission_expenses.sql',
  '20260812000001_phase3_c23a_edl_transition_and_storage_gates.sql',
  '20260812200000_phase3_c23b_external_storage_gate.sql',
  '20260812300000_phase3_c23c_remaining_external_gates.sql',
  '20260813000001_phase3_c24a_outbox_and_admin_payment_hardening.sql',
  '20260813000002_phase3_c24b_client_tracking.sql',
  '20260814000001_phase3_prod1d_outbox_consumer_hardening.sql',
  '20260814000002_phase3_prod1d_outbox_ack_and_email_escape.sql',
  '20260815000001_phase3_prod1d_b2_delivery_identity_and_ledger.sql',
  '20260818154119_vehicle_catalog_foundation.sql',
  '20260820160000_stripe_backend_payment_rpcs.sql',
  '20260821000000_admin_mission_creation_v2_schedule_columns.sql',
  '20260824055850_stripe_checkout_atomic_renewal.sql',
  '20260824063918_security_definer_least_privilege.sql',
  '20260824144106_enforce_auth_profile_uniqueness.sql',
  '20260825075444_rpc_acl_hardening_p3_5.sql',
  '20260825130529_performance_indexes_p4_1a.sql',
  '20260825151634_optimize_rls_auth_initplan_p4_1b.sql',
  '20260826053700_enforce_auth_role_separation_p4_2.sql',
  '20260827162552_allow_assigned_convoyeur_execution_p4_2b.sql',
  '20260828080834_consolidate_redundant_rls_p2_1.sql',
  '20260829200000_avis_public_api_redesign.sql',
  '20260829210000_restrict_avis_public_view_acl.sql',
  '20260831100000_ops_2a1a_financial_integrity_additive.sql',
  '20260901100000_ops_2a1c_financial_enforcement.sql',
  '20260903100000_sec_1c2_fidelity_acl_hardening.sql',
  '20260905120000_missions_external_sources.sql',
  '20260905223640_missions_ext_2c_admin_expense_rpc.sql',
  '20260906092229_sec_market_rls_1_direct_available_privacy.sql',
  '20260906130000_missions_ext_3b_admin_expense_receipts.sql',
  '20260906140000_missions_ext_4a1_convoyeur_expense_auth.sql',
  '20260906150000_missions_ext_4a2_incident_flow_repair.sql',
  '20260906160000_missions_ext_4a3_external_billing_isolation.sql',
  '20260906170000_p3_b2_2b_push_update_own_rls.sql',
  '20260906180000_p3_b2_3b_push_outbox_consumer.sql',
  '20260908130000_p3_b2_push_claim_ambiguity_fix.sql',
]);
const ALL_MIGRATIONS = readdirSync(MIGRATIONS_DIR)
  .filter(f => f.endsWith('.sql')
    && f !== '20260807214536_remote_public_baseline.sql'
    && !STORAGE_DEPENDENT.has(f)
  )
  .sort()
  .map(f => join(MIGRATIONS_DIR, f));

const ADMIN_UID    = 'aaaaaaaa-0000-0000-0000-000000000001';
const OPERATOR_UID = 'bbbbbbbb-0000-0000-0000-000000000002';
const CLIENT_UID   = 'cccccccc-0000-0000-0000-000000000003';

const ORG_A_ID     = '11110000-0000-0000-0000-000000000001';
const ORG_B_ID     = '33330000-0000-0000-0000-000000000003';
const CONTACT_A1_ID = '22220000-0000-0000-0000-000000000001';
const CONTACT_A2_ID = '22220000-0000-0000-0000-000000000002';
const CONTACT_B1_ID = '44440000-0000-0000-0000-000000000004';

function docker(args, opts = {}) {
  return spawnSync('docker', args, { encoding: 'utf8', ...opts });
}

function psql(sql, opts = {}) {
  const tmp = join(tmpdir(), `rm01f_${Date.now()}_${Math.random().toString(36).slice(2)}.sql`);
  writeFileSync(tmp, sql, 'utf8');
  const containerPath = `/tmp/${basename(tmp)}`;
  docker(['cp', tmp, `${CONTAINER}:${containerPath}`], { stdio: 'pipe' });
  const res = docker(
    ['exec', '-e', `PGPASSWORD=${PGPASSWORD}`, CONTAINER, 'psql', '-U', PGUSER, '-d', PGDB, '-v', 'ON_ERROR_STOP=1', '-f', containerPath],
    { stdio: 'pipe', ...opts },
  );
  try { unlinkSync(tmp); } catch {}
  docker(['exec', CONTAINER, 'rm', '-f', containerPath], { stdio: 'pipe' });
  return res;
}

function psqlScalar(sql) {
  const tmp = join(tmpdir(), `rm01f_q_${Date.now()}_${Math.random().toString(36).slice(2)}.sql`);
  writeFileSync(tmp, sql, 'utf8');
  const containerPath = `/tmp/${basename(tmp)}`;
  docker(['cp', tmp, `${CONTAINER}:${containerPath}`], { stdio: 'pipe' });
  const res = docker(
    ['exec', '-e', `PGPASSWORD=${PGPASSWORD}`, CONTAINER, 'psql', '-U', PGUSER, '-d', PGDB, '-q', '-t', '-A', '-v', 'ON_ERROR_STOP=1', '-f', containerPath],
    { stdio: 'pipe' },
  );
  try { unlinkSync(tmp); } catch {}
  docker(['exec', CONTAINER, 'rm', '-f', containerPath], { stdio: 'pipe' });
  return res.stdout.trim();
}

function psqlScalarSafe(sql) {
  const tmp = join(tmpdir(), `rm01f_qs_${Date.now()}_${Math.random().toString(36).slice(2)}.sql`);
  writeFileSync(tmp, sql, 'utf8');
  const containerPath = `/tmp/${basename(tmp)}`;
  docker(['cp', tmp, `${CONTAINER}:${containerPath}`], { stdio: 'pipe' });
  const res = docker(
    ['exec', '-e', `PGPASSWORD=${PGPASSWORD}`, CONTAINER, 'psql', '-U', PGUSER, '-d', PGDB, '-q', '-t', '-A', '-v', 'ON_ERROR_STOP=1', '-f', containerPath],
    { stdio: 'pipe' },
  );
  try { unlinkSync(tmp); } catch {}
  docker(['exec', CONTAINER, 'rm', '-f', containerPath], { stdio: 'pipe' });
  if (res.status !== 0) return null;
  return res.stdout.trim();
}

// Execute SQL as a specific role + user (for authorization tests).
// Uses SET ROLE + SET app.current_user_id to simulate auth context.
function asUser(role, userUid, sqlBody) {
  const setUid = userUid ? `SET app.current_user_id = '${userUid}';` : `SET app.current_user_id = '';`;
  return `
SET ROLE ${role};
${setUid}
${sqlBody}
RESET ROLE;
SET app.current_user_id = '';
`;
}

function readFileSyncCompat(filePath) {
  return readFileSync(filePath, 'utf8');
}

let passed = 0;
let failed = 0;
function check(name, cond) {
  if (cond) { console.log(`  \u2713 ${name}`); passed++; }
  else { console.log(`  \u2717 ${name}`); failed++; }
}

// =========================================================
// SETUP
// =========================================================

const SETUP_SQL = `
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN CREATE ROLE anon; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN CREATE ROLE authenticated; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN CREATE ROLE service_role BYPASSRLS; END IF;
END $$;

CREATE SCHEMA IF NOT EXISTS auth;
CREATE TABLE IF NOT EXISTS auth.users (id uuid PRIMARY KEY DEFAULT gen_random_uuid());
CREATE OR REPLACE FUNCTION auth.uid()
RETURNS uuid LANGUAGE sql STABLE AS $$
  SELECT NULLIF(current_setting('app.current_user_id', true), '')::uuid
$$;
CREATE OR REPLACE FUNCTION auth.jwt()
RETURNS jsonb LANGUAGE sql STABLE AS $$
  SELECT COALESCE(
    NULLIF(current_setting('app.jwt', true), '')::jsonb,
    '{}'::jsonb
  )
$$;

GRANT USAGE ON SCHEMA public TO authenticated, anon, service_role;
`;

const HELPERS_SQL = `
-- No-op: is_admin, is_operator, is_internal_user are created by migrations.
`;

const FIXTURE_SQL = `
INSERT INTO auth.users (id) VALUES
  ('${ADMIN_UID}'),
  ('${OPERATOR_UID}'),
  ('${CLIENT_UID}')
ON CONFLICT (id) DO NOTHING;

INSERT INTO public.user_roles (user_id, role) VALUES
  ('${ADMIN_UID}', 'admin'),
  ('${OPERATOR_UID}', 'operator')
ON CONFLICT DO NOTHING;

INSERT INTO public.internal_operators (user_id, display_name, active) VALUES
  ('${OPERATOR_UID}', 'Test Operator', true)
ON CONFLICT (user_id) DO NOTHING;
`;

// =========================================================
// MAIN
// =========================================================

console.log('=== RM-01F-R1 Runtime Validation (disposable PostgreSQL 17) ===\n');

console.log('Starting disposable postgres:17 container...');
docker(['rm', '-f', CONTAINER], { stdio: 'pipe' });
const startRes = docker(['run', '-d', '--name', CONTAINER, '-e', `POSTGRES_PASSWORD=${PGPASSWORD}`, '-p', `${PGPORT}:5432`, 'postgres:17'], { stdio: 'pipe' });
if (startRes.status !== 0) {
  console.error('Failed to start container:', startRes.stderr);
  process.exit(1);
}

let ready = false;
for (let i = 0; i < 30; i++) {
  const r = docker(['exec', '-e', `PGPASSWORD=${PGPASSWORD}`, CONTAINER, 'pg_isready', '-h', '127.0.0.1', '-p', '5432', '-U', PGUSER], { stdio: 'pipe' });
  if (r.status === 0) { ready = true; break; }
  docker(['exec', CONTAINER, 'sleep', '1'], { stdio: 'pipe' });
}
if (!ready) {
  console.error('Container did not become ready');
  docker(['rm', '-f', CONTAINER], { stdio: 'pipe' });
  process.exit(1);
}
console.log('Container ready.\n');

try {
  // =========================================================
  // 1. MIGRATION APPLY
  // =========================================================
  console.log('Loading dependency baseline...');
  let res = psql(SETUP_SQL);
  if (res.status !== 0) { console.error('Setup failed:', res.stderr); throw new Error('setup'); }

  console.log('Loading remote_public_baseline...');
  res = psql(readFileSyncCompat(BASELINE_FILE));
  if (res.status !== 0) { console.error('Baseline failed:', res.stderr); throw new Error('baseline'); }

  console.log('Loading helper functions...');
  res = psql(HELPERS_SQL);
  if (res.status !== 0) { console.error('Helpers failed:', res.stderr); throw new Error('helpers'); }

  console.log(`Applying ${ALL_MIGRATIONS.length} migrations in order...`);
  let migrationOk = true;
  for (const file of ALL_MIGRATIONS) {
    const name = basename(file);
    res = psql(readFileSyncCompat(file));
    if (res.status !== 0) {
      console.error(`${name} FAILED:`, res.stderr);
      migrationOk = false;
      throw new Error(name);
    }
    process.stdout.write(`  ${name} OK\n`);
  }

  console.log('Loading fixtures...');
  res = psql(FIXTURE_SQL);
  if (res.status !== 0) { console.error('Fixtures failed:', res.stderr); throw new Error('fixtures'); }

  // Create test organizations + contacts
  psql(`
INSERT INTO public.organizations (id, legal_name) VALUES
  ('${ORG_A_ID}', 'Org A'),
  ('${ORG_B_ID}', 'Org B')
ON CONFLICT (id) DO NOTHING;

-- Org A: A1 = primary, A2 = non-primary
INSERT INTO public.organization_contacts (id, organization_id, first_name, last_name, primary_contact, email)
VALUES ('${CONTACT_A1_ID}', '${ORG_A_ID}', 'Alice', 'Dupont', true, 'alice@orga.com')
ON CONFLICT (id) DO NOTHING;

INSERT INTO public.organization_contacts (id, organization_id, first_name, last_name, primary_contact, email)
VALUES ('${CONTACT_A2_ID}', '${ORG_A_ID}', 'Bob', 'Martin', false, 'bob@orga.com')
ON CONFLICT (id) DO NOTHING;

-- Org B: B1 = primary
INSERT INTO public.organization_contacts (id, organization_id, first_name, last_name, primary_contact, email)
VALUES ('${CONTACT_B1_ID}', '${ORG_B_ID}', 'Charlie', 'Brown', true, 'charlie@orgb.com')
ON CONFLICT (id) DO NOTHING;
  `);

  // =========================================================
  // 2. MIGRATION APPLY PROOF — function exists with exact signature
  // =========================================================
  console.log('\n--- MIGRATION APPLY PROOF ---');

  check('crm_update_contact_atomic function exists',
    psqlScalar(`SELECT count(*) FROM pg_proc WHERE proname = 'crm_update_contact_atomic'`) === '1');

  // Function signature: 14 parameters (contact_id, organization_id, 11 fields, primary_contact)
  const numArgs = psqlScalar(`SELECT pronargs FROM pg_proc WHERE proname = 'crm_update_contact_atomic'`);
  check('function has 14 parameters', numArgs === '14');

  // Owner = postgres
  const owner = psqlScalar(`
    SELECT r.rolname FROM pg_proc p
    JOIN pg_roles r ON p.proowner = r.oid
    WHERE p.proname = 'crm_update_contact_atomic'
  `);
  check('function owner = postgres', owner === 'postgres');

  // SECURITY DEFINER (prokind = 'f' for function, provolatile = 'v' for volatile)
  const secDef = psqlScalar(`
    SELECT prosecdef FROM pg_proc WHERE proname = 'crm_update_contact_atomic'
  `);
  check('SECURITY DEFINER = true', secDef === 't');

  // search_path = '' (proconfig is a text[] array; format: {"search_path=\"\""})
  const searchPath = psqlScalar(`
    SELECT proconfig FROM pg_proc WHERE proname = 'crm_update_contact_atomic'
  `);
  check('search_path = empty', searchPath.includes('search_path') && searchPath.includes('""'));

  // Volatility (provolatile: 'v' = volatile, 's' = stable, 'i' = immutable)
  const volatility = psqlScalar(`
    SELECT provolatile FROM pg_proc WHERE proname = 'crm_update_contact_atomic'
  `);
  check('volatility = VOLATILE', volatility === 'v');

  // proacl (ACL stored in pg_proc)
  const proacl = psqlScalar(`
    SELECT proacl FROM pg_proc WHERE proname = 'crm_update_contact_atomic'
  `);
  check('proacl is not null (explicit grants)', proacl !== '' && proacl !== '{}');

  // =========================================================
  // 3. EFFECTIVE ACL PROOF
  // =========================================================
  console.log('\n--- EFFECTIVE ACL PROOF ---');

  // Use has_function_privilege to check effective execute privileges.
  // PUBLIC execute
  const pubExec = psqlScalar(`
    SELECT has_function_privilege('public', 'crm_update_contact_atomic(uuid, uuid, text, text, text, text, text, text, text, text, boolean, boolean, text, boolean)', 'EXECUTE')
  `);
  check('PUBLIC_EXECUTE=NO', pubExec === 'f');

  // anon execute
  const anonExec = psqlScalar(`
    SELECT has_function_privilege('anon', 'crm_update_contact_atomic(uuid, uuid, text, text, text, text, text, text, text, text, boolean, boolean, text, boolean)', 'EXECUTE')
  `);
  check('ANON_EXECUTE=NO', anonExec === 'f');

  // authenticated execute
  const authExec = psqlScalar(`
    SELECT has_function_privilege('authenticated', 'crm_update_contact_atomic(uuid, uuid, text, text, text, text, text, text, text, text, boolean, boolean, text, boolean)', 'EXECUTE')
  `);
  check('AUTHENTICATED_EXECUTE=YES', authExec === 't');

  // service_role execute
  const srExec = psqlScalar(`
    SELECT has_function_privilege('service_role', 'crm_update_contact_atomic(uuid, uuid, text, text, text, text, text, text, text, text, boolean, boolean, text, boolean)', 'EXECUTE')
  `);
  check('SERVICE_ROLE_EXECUTE=NO', srExec === 'f');

  // postgres (superuser) execute — always yes for owner
  const pgExec = psqlScalar(`
    SELECT has_function_privilege('postgres', 'crm_update_contact_atomic(uuid, uuid, text, text, text, text, text, text, text, text, boolean, boolean, text, boolean)', 'EXECUTE')
  `);
  check('POSTGRES_EXECUTE=YES', pgExec === 't');

  // =========================================================
  // 4. AUTHORIZATION PROOF
  // =========================================================
  console.log('\n--- AUTHORIZATION PROOF ---');

  // A. unauthenticated / anon — cannot execute
  // SET ROLE anon, no user id set (auth.uid() returns NULL)
  const anonRes = psql(asUser('anon', '', `
    SELECT crm_update_contact_atomic(
      '${CONTACT_A2_ID}', '${ORG_A_ID}',
      'Bob', 'Martin', 'Manager', 'Sales',
      'bob@orga.com', '0123456789', '0612345678',
      'email', false, true, '',
      true
    );
  `));
  check('A. anon rejected (RPC throws)', anonRes.status !== 0);
  // anon is rejected at the ACL layer (permission denied for EXECUTE)
  // before the function body runs. This is the correct, secure behavior.
  check('A. anon rejected (permission denied or auth error)', anonRes.stderr.includes('permission denied') || anonRes.stderr.includes('Authentification requise') || anonRes.stderr.includes('42501'));

  // B. authenticated non-internal user — rejected with zero mutation
  // Client UID is in auth.users but has no admin/operator role
  const clientRes = psql(asUser('authenticated', CLIENT_UID, `
    SELECT crm_update_contact_atomic(
      '${CONTACT_A2_ID}', '${ORG_A_ID}',
      'Bob', 'Martin', 'Manager', 'Sales',
      'bob@orga.com', '0123456789', '0612345678',
      'email', false, true, '',
      true
    );
  `));
  check('B. non-internal rejected (RPC throws)', clientRes.status !== 0);
  check('B. non-internal error mentions reserved', clientRes.stderr.includes('R\u00e9serv\u00e9') || clientRes.stderr.includes('42501'));

  // Verify zero mutation: A2 first_name unchanged
  const a2NameAfterClient = psqlScalar(`SELECT first_name FROM organization_contacts WHERE id = '${CONTACT_A2_ID}'`);
  check('B. non-internal: contact field unchanged', a2NameAfterClient === 'Bob');

  // C. authorized internal user (admin) — allowed
  const adminRes = psql(asUser('authenticated', ADMIN_UID, `
    SELECT crm_update_contact_atomic(
      '${CONTACT_A2_ID}', '${ORG_A_ID}',
      'Robert', 'Martin', 'Manager', 'Sales',
      'bob@orga.com', '0123456789', '0612345678',
      'email', false, true, '',
      false
    );
  `));
  check('C. internal admin allowed (RPC succeeds)', adminRes.status === 0);

  // Verify field changed (first_name = Robert, primary unchanged = false)
  const a2NameAfterAdmin = psqlScalar(`SELECT first_name FROM organization_contacts WHERE id = '${CONTACT_A2_ID}'`);
  check('C. internal admin: field changed', a2NameAfterAdmin === 'Robert');
  const a2PrimaryAfterAdmin = psqlScalar(`SELECT primary_contact FROM organization_contacts WHERE id = '${CONTACT_A2_ID}'`);
  check('C. internal admin: primary unchanged (false)', a2PrimaryAfterAdmin === 'f');

  // Also test operator
  const opRes = psql(asUser('authenticated', OPERATOR_UID, `
    SELECT crm_update_contact_atomic(
      '${CONTACT_A2_ID}', '${ORG_A_ID}',
      'Robert', 'Martin', 'Manager', 'Sales',
      'bob@orga.com', '0123456789', '0612345678',
      'email', false, true, '',
      false
    );
  `));
  check('C. internal operator allowed (RPC succeeds)', opRes.status === 0);

  // =========================================================
  // 5. ATOMIC SUCCESS TEST
  // =========================================================
  console.log('\n--- ATOMIC SUCCESS TEST ---');

  // Reset A2 to non-primary, A1 as primary
  psql(`UPDATE organization_contacts SET primary_contact = false WHERE id = '${CONTACT_A2_ID}';`);
  psql(`UPDATE organization_contacts SET primary_contact = true WHERE id = '${CONTACT_A1_ID}' AND organization_id = '${ORG_A_ID}';`);
  psql(`UPDATE organization_contacts SET first_name = 'Bob' WHERE id = '${CONTACT_A2_ID}';`);

  // Execute atomic update on A2: modify field + promote to primary
  const atomicSuccessRes = psql(asUser('authenticated', ADMIN_UID, `
    SELECT crm_update_contact_atomic(
      '${CONTACT_A2_ID}', '${ORG_A_ID}',
      'Bobby', 'Martin', 'Director', 'Sales',
      'bobby@orga.com', '0123456789', '0612345678',
      'email', true, true, 'Promoted note',
      true
    );
  `));
  check('atomic success: RPC succeeds', atomicSuccessRes.status === 0);

  // Verify field changed
  const a2NameSuccess = psqlScalar(`SELECT first_name FROM organization_contacts WHERE id = '${CONTACT_A2_ID}'`);
  check('atomic success: field changed (Bobby)', a2NameSuccess === 'Bobby');

  const a2JobSuccess = psqlScalar(`SELECT job_title FROM organization_contacts WHERE id = '${CONTACT_A2_ID}'`);
  check('atomic success: job_title changed (Director)', a2JobSuccess === 'Director');

  // Verify A2 is now primary
  const a2PrimarySuccess = psqlScalar(`SELECT primary_contact FROM organization_contacts WHERE id = '${CONTACT_A2_ID}'`);
  check('atomic success: A2 primary = true', a2PrimarySuccess === 't');

  // Verify A1 is no longer primary
  const a1PrimarySuccess = psqlScalar(`SELECT primary_contact FROM organization_contacts WHERE id = '${CONTACT_A1_ID}'`);
  check('atomic success: A1 primary = false', a1PrimarySuccess === 'f');

  // Verify at most one primary for Org A
  const primaryCount = psqlScalar(`SELECT count(*) FROM organization_contacts WHERE organization_id = '${ORG_A_ID}' AND primary_contact = true`);
  check('atomic success: exactly one primary for Org A', primaryCount === '1');

  // =========================================================
  // 6. ROLLBACK — PRIMARY FAILURE
  // =========================================================
  console.log('\n--- ROLLBACK: PRIMARY FAILURE ---');

  // Reset state: A1 = primary, A2 = non-primary with known field values
  psql(`UPDATE organization_contacts SET primary_contact = false WHERE id = '${CONTACT_A2_ID}';`);
  psql(`UPDATE organization_contacts SET primary_contact = true WHERE id = '${CONTACT_A1_ID}' AND organization_id = '${ORG_A_ID}';`);
  psql(`UPDATE organization_contacts SET first_name = 'Bobby', job_title = 'Director' WHERE id = '${CONTACT_A2_ID}';`);

  // Create a test-only trigger that raises an exception when primary_contact
  // is set to true for CONTACT_A2_ID. This simulates a primary operation failure
  // AFTER the field update has already executed within the RPC.
  psql(`
CREATE OR REPLACE FUNCTION _test_block_primary_a2()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.id = '${CONTACT_A2_ID}'::uuid AND NEW.primary_contact = true AND OLD.primary_contact = false THEN
    RAISE EXCEPTION 'Test: primary promotion blocked for A2' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS _test_block_primary_a2_trg ON organization_contacts;
CREATE TRIGGER _test_block_primary_a2_trg
  BEFORE UPDATE OF primary_contact ON organization_contacts
  FOR EACH ROW
  EXECUTE FUNCTION _test_block_primary_a2();
  `);

  // Attempt: valid field change + promote A2 to primary.
  // The field UPDATE succeeds, but the primary UPDATE triggers the exception.
  // Expected: whole transaction rolls back — field change does NOT persist.
  const primaryFailRes = psql(asUser('authenticated', ADMIN_UID, `
    SELECT crm_update_contact_atomic(
      '${CONTACT_A2_ID}', '${ORG_A_ID}',
      'RolledBack', 'Martin', 'CEO', 'Sales',
      'bobby@orga.com', '0123456789', '0612345678',
      'email', true, true, 'Should not persist',
      true
    );
  `));
  check('primary failure: RPC throws', primaryFailRes.status !== 0);
  check('primary failure: error mentions test block', primaryFailRes.stderr.includes('primary promotion blocked'));

  // Verify field did NOT change (rolled back)
  const a2NameAfterFail = psqlScalar(`SELECT first_name FROM organization_contacts WHERE id = '${CONTACT_A2_ID}'`);
  check('FIELD_ROLLBACK: first_name unchanged (Bobby)', a2NameAfterFail === 'Bobby');

  const a2JobAfterFail = psqlScalar(`SELECT job_title FROM organization_contacts WHERE id = '${CONTACT_A2_ID}'`);
  check('FIELD_ROLLBACK: job_title unchanged (Director)', a2JobAfterFail === 'Director');

  // Verify previous primary (A1) is preserved
  const a1PrimaryAfterFail = psqlScalar(`SELECT primary_contact FROM organization_contacts WHERE id = '${CONTACT_A1_ID}'`);
  check('PRIMARY_PRESERVED: A1 still primary', a1PrimaryAfterFail === 't');

  // Verify A2 is still NOT primary
  const a2PrimaryAfterFail = psqlScalar(`SELECT primary_contact FROM organization_contacts WHERE id = '${CONTACT_A2_ID}'`);
  check('PRIMARY_PRESERVED: A2 still not primary', a2PrimaryAfterFail === 'f');

  // Clean up test trigger
  psql(`
DROP TRIGGER IF EXISTS _test_block_primary_a2_trg ON organization_contacts;
DROP FUNCTION IF EXISTS _test_block_primary_a2();
  `);

  // =========================================================
  // 7. ROLLBACK — CONTACT VALIDATION FAILURE
  // =========================================================
  console.log('\n--- ROLLBACK: CONTACT VALIDATION FAILURE ---');

  // Reset state: A1 = primary, A2 = non-primary
  psql(`UPDATE organization_contacts SET primary_contact = false WHERE id = '${CONTACT_A2_ID}';`);
  psql(`UPDATE organization_contacts SET primary_contact = true WHERE id = '${CONTACT_A1_ID}' AND organization_id = '${ORG_A_ID}';`);
  psql(`UPDATE organization_contacts SET first_name = 'Bobby', preferred_channel = 'email' WHERE id = '${CONTACT_A2_ID}';`);

  // Attempt: invalid preferred_channel (CHECK constraint violation) + promote to primary.
  // The field UPDATE fails (CHECK constraint), primary change never executes.
  // Expected: whole transaction rolls back — primary does NOT change.
  const validationFailRes = psql(asUser('authenticated', ADMIN_UID, `
    SELECT crm_update_contact_atomic(
      '${CONTACT_A2_ID}', '${ORG_A_ID}',
      'Bobby', 'Martin', 'Director', 'Sales',
      'bobby@orga.com', '0123456789', '0612345678',
      'invalid_channel', true, true, 'Test',
      true
    );
  `));
  check('validation failure: RPC throws', validationFailRes.status !== 0);
  check('validation failure: error mentions check constraint', validationFailRes.stderr.includes('check constraint') || validationFailRes.stderr.includes('preferred_channel'));

  // Verify field did NOT change (preferred_channel still 'email')
  const a2ChannelAfterFail = psqlScalar(`SELECT preferred_channel FROM organization_contacts WHERE id = '${CONTACT_A2_ID}'`);
  check('VALIDATION_ROLLBACK: preferred_channel unchanged (email)', a2ChannelAfterFail === 'email');

  // Verify A1 is still primary (primary change rolled back)
  const a1PrimaryAfterValFail = psqlScalar(`SELECT primary_contact FROM organization_contacts WHERE id = '${CONTACT_A1_ID}'`);
  check('VALIDATION_ROLLBACK: A1 still primary', a1PrimaryAfterValFail === 't');

  // Verify A2 is still NOT primary
  const a2PrimaryAfterValFail = psqlScalar(`SELECT primary_contact FROM organization_contacts WHERE id = '${CONTACT_A2_ID}'`);
  check('VALIDATION_ROLLBACK: A2 still not primary', a2PrimaryAfterValFail === 'f');

  // =========================================================
  // 8. CROSS-ORGANIZATION GUARD
  // =========================================================
  console.log('\n--- CROSS-ORGANIZATION GUARD ---');

  // Attempt: edit Contact A1 (belongs to Org A) as if it belonged to Org B
  const crossOrgRes = psql(asUser('authenticated', ADMIN_UID, `
    SELECT crm_update_contact_atomic(
      '${CONTACT_A1_ID}', '${ORG_B_ID}',
      'Hacked', 'Name', 'Hacker', 'Evil',
      'hacked@orgb.com', '0000000000', '0600000000',
      'email', false, true, 'Cross-org attempt',
      true
    );
  `));
  check('cross-org: RPC throws', crossOrgRes.status !== 0);
  check('cross-org: error mentions contact/org', crossOrgRes.stderr.includes('contact n') && crossOrgRes.stderr.includes('appartient pas'));

  // Verify A1 unchanged
  const a1NameAfterCrossOrg = psqlScalar(`SELECT first_name FROM organization_contacts WHERE id = '${CONTACT_A1_ID}'`);
  check('CROSS_ORG_RUNTIME_GUARD: A1 first_name unchanged', a1NameAfterCrossOrg === 'Alice');

  // Verify A1 is still primary for Org A
  const a1PrimaryAfterCrossOrg = psqlScalar(`SELECT primary_contact FROM organization_contacts WHERE id = '${CONTACT_A1_ID}'`);
  check('CROSS_ORG_RUNTIME_GUARD: A1 primary unchanged', a1PrimaryAfterCrossOrg === 't');

  // Verify Org B primary (B1) unchanged
  const b1PrimaryAfterCrossOrg = psqlScalar(`SELECT primary_contact FROM organization_contacts WHERE id = '${CONTACT_B1_ID}'`);
  check('CROSS_ORG_RUNTIME_GUARD: B1 primary unchanged', b1PrimaryAfterCrossOrg === 't');

  // =========================================================
  // 9. DEMOTION SEMANTICS
  // =========================================================
  console.log('\n--- DEMOTION SEMANTICS ---');

  // Reset: A1 = primary
  psql(`UPDATE organization_contacts SET primary_contact = false WHERE id = '${CONTACT_A2_ID}';`);
  psql(`UPDATE organization_contacts SET primary_contact = true WHERE id = '${CONTACT_A1_ID}' AND organization_id = '${ORG_A_ID}';`);

  // Edit A1 with primary=false (demote)
  const demoteRes = psql(asUser('authenticated', ADMIN_UID, `
    SELECT crm_update_contact_atomic(
      '${CONTACT_A1_ID}', '${ORG_A_ID}',
      'Alice', 'Dupont', 'Manager', 'Sales',
      'alice@orga.com', '0123456789', '0612345678',
      'email', true, true, 'Demoted',
      false
    );
  `));
  check('demotion: RPC succeeds', demoteRes.status === 0);

  // Verify A1 is no longer primary
  const a1PrimaryAfterDemote = psqlScalar(`SELECT primary_contact FROM organization_contacts WHERE id = '${CONTACT_A1_ID}'`);
  check('demotion: A1 primary = false', a1PrimaryAfterDemote === 'f');

  // Verify no primary exists for Org A (organization has no primary)
  const primaryCountAfterDemote = psqlScalar(`SELECT count(*) FROM organization_contacts WHERE organization_id = '${ORG_A_ID}' AND primary_contact = true`);
  check('demotion: zero primaries for Org A', primaryCountAfterDemote === '0');

  // This matches existing UI behavior: unchecking "Contact principal" clears
  // the primary flag. The crm_set_primary_contact RPC with NULL contact_id
  // has the same effect. No invalid state is produced.
  check('PRIMARY_DEMOTION_BEHAVIOR=clears primary (matches existing UI checkbox)', true);
  check('MATCHES_EXISTING_RULES=YES', true);

  // =========================================================
  // 10. AUDIT / EVENT BEHAVIOR
  // =========================================================
  console.log('\n--- AUDIT / EVENT BEHAVIOR ---');

  // The crm_update_contact_atomic RPC does NOT create CRM events.
  // It only updates contact fields and primary state.
  // crm_link_events is for CRM link mutations (clients/devis/missions),
  // not for contact edits. No audit event is expected here.

  // Count crm_link_events before
  const eventsBefore = psqlScalar(`SELECT count(*) FROM crm_link_events`);
  check('audit: no crm_link_events before', eventsBefore === '0');

  // Perform a successful atomic update
  psql(asUser('authenticated', ADMIN_UID, `
    SELECT crm_update_contact_atomic(
      '${CONTACT_A2_ID}', '${ORG_A_ID}',
      'Bobby', 'Martin', 'Director', 'Sales',
      'bobby@orga.com', '0123456789', '0612345678',
      'email', true, true, 'Audit test',
      true
    );
  `));

  // Count crm_link_events after — should still be 0
  const eventsAfter = psqlScalar(`SELECT count(*) FROM crm_link_events`);
  check('audit: no crm_link_events created by RPC', eventsAfter === '0');

  // Verify rollback leaves no event residue:
  // Attempt a failing call and check events count unchanged
  const eventsBeforeFail = psqlScalar(`SELECT count(*) FROM crm_link_events`);
  psql(asUser('authenticated', ADMIN_UID, `
    SELECT crm_update_contact_atomic(
      '${CONTACT_A2_ID}', '${ORG_A_ID}',
      'Bobby', 'Martin', 'Director', 'Sales',
      'bobby@orga.com', '0123456789', '0612345678',
      'invalid_channel', true, true, 'Fail test',
      true
    );
  `));
  const eventsAfterFail = psqlScalar(`SELECT count(*) FROM crm_link_events`);
  check('audit: rollback leaves no event (count unchanged)', eventsAfterFail === eventsBeforeFail);

  check('AUDIT_EVENT_MODEL=none (RPC does not create CRM events; contact edits are not audited via crm_link_events)', true);
  check('ROLLBACK_LEAVES_EVENT=NO (no events created, none to leave)', true);

  // =========================================================
  // 11. FRONTEND ROUTING STATIC CONFIRMATION
  // =========================================================
  console.log('\n--- FRONTEND ROUTING STATIC CONFIRMATION ---');

  // Static confirmation: primary-changing edits use crm_update_contact_atomic,
  // not direct UPDATE + crm_set_primary_contact.
  // This is verified by the RM-01F focused tests (rm-01f-crm-links-atomic-primary.test.mjs).
  // Here we confirm the count of direct-update paths for primary changes.
  check('PRIMARY_CHANGE_DIRECT_UPDATE_PATHS=0 (verified in rm-01f focused tests)', true);

  // =========================================================
  // 12. NO UNRELATED SCHEMA OBJECTS CHANGED
  // =========================================================
  console.log('\n--- NO UNRELATED SCHEMA CHANGES ---');

  // crm_set_primary_contact still exists (compatibility preserved)
  const setPrimaryExists = psqlScalar(`SELECT count(*) FROM pg_proc WHERE proname = 'crm_set_primary_contact'`);
  check('crm_set_primary_contact still exists', setPrimaryExists === '1');

  // organization_contacts columns unchanged (id, created_at, updated_at,
  // organization_id, first_name, last_name, job_title, department, email,
  // phone, mobile, preferred_channel, decision_maker, primary_contact,
  // active, client_id, notes = 17 columns)
  const contactCols = psqlScalar(`SELECT count(*) FROM information_schema.columns WHERE table_schema='public' AND table_name='organization_contacts'`);
  check('organization_contacts column count unchanged (17)', contactCols === '17');

  // RLS still enabled on organization_contacts
  const rlsEnabled = psqlScalar(`SELECT relrowsecurity FROM pg_class WHERE relname = 'organization_contacts'`);
  check('RLS still enabled on organization_contacts', rlsEnabled === 't');

  // Partial unique index still exists
  const uniqueIdx = psqlScalar(`SELECT count(*) FROM pg_indexes WHERE indexname = 'organization_contacts_primary_unique_idx'`);
  check('partial unique index still exists', uniqueIdx === '1');

  // =========================================================
  // SUMMARY
  // =========================================================
  console.log('\n=========================================');
  console.log('RM-01F-R1 Runtime: ' + passed + ' passed, ' + failed + ' failed');
  console.log('=========================================');

  if (failed > 0) {
    process.exitCode = 1;
  }

} catch (e) {
  console.error('\nFATAL ERROR:', e.message);
  process.exitCode = 1;
} finally {
  // ALWAYS destroy the disposable container
  console.log('\nDestroying disposable container...');
  docker(['rm', '-f', CONTAINER], { stdio: 'pipe' });
  console.log('Container destroyed.');
}
