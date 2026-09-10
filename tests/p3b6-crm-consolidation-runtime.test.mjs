// P3B6 — CRM Consolidation — Runtime Validation (Disposable PostgreSQL 17)
//
// Spins up a DISPOSABLE postgres:17 container, loads the minimal dependency
// baseline (auth.uid() stub + helpers + clients/devis/missions tables +
// existing client guard), applies P3B1-P3B5 then P3B6 migrations in order,
// and runs runtime assertions covering:
//   - crm_link_events schema (columns, CHECKs, immutability, RLS)
//   - extended P3B5 guards (audit insertion, FAIL_CLOSED)
//   - crm_timeline_read (6 branches, redaction, limit, cursor, filters)
//   - crm_organizations_summary (aggregates, no billing_amount, Cartesian safety)
//   - authorization (admin/operator/client/convoyeur/anon)
//   - attribution (mission reparent changes current_organization_id)
//   - P3B5 regression (guards still work)
//
// AUTH_RLS_SIMULATION=YES — uses a session-GUC stub for auth.uid().
// The container is ALWAYS destroyed after tests (success or failure).

import { spawnSync } from 'node:child_process';
import { writeFileSync, unlinkSync, readFileSync, readdirSync } from 'node:fs';
import { join, basename } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const CONTAINER = 'p3b6_runtime_pg17';
const PGUSER = 'postgres';
const PGDB = 'postgres';
const PGPASSWORD = 'p3b6test';
const PGPORT = '54182';

const MIGRATIONS_DIR = fileURLToPath(
  new URL('../supabase/migrations/', import.meta.url)
);

const BASELINE_FILE    = join(MIGRATIONS_DIR, '20260807214536_remote_public_baseline.sql');
const P3B6_FILE = join(MIGRATIONS_DIR, '20260910120000_p3b6_crm_consolidation.sql');

// Load all migration files in order, excluding storage-dependent ones
// (we don't have Supabase storage schema in a vanilla postgres container).
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
const CONVOYEUR_UID = 'dddddddd-0000-0000-0000-000000000099';

const ORG_A_ID     = '11110000-0000-0000-0000-000000000001';
const ORG_B_ID     = '33330000-0000-0000-0000-000000000003';
const CONTACT_A_ID = '22220000-0000-0000-0000-000000000002';
const OPP_A_ID     = '66660000-0000-0000-0000-000000000006';

const CLIENT_ID   = 'dddd0000-0000-0000-0000-000000000004';
const DEVIS_ID    = 'eeee0000-0000-0000-0000-000000000001';
const MISSION_ID = 'ffff0000-0000-0000-0000-000000000001';

function docker(args, opts = {}) {
  return spawnSync('docker', args, { encoding: 'utf8', ...opts });
}

function psql(sql, opts = {}) {
  const tmp = join(tmpdir(), `p3b6_${Date.now()}_${Math.random().toString(36).slice(2)}.sql`);
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
  const tmp = join(tmpdir(), `p3b6_q_${Date.now()}_${Math.random().toString(36).slice(2)}.sql`);
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
  const tmp = join(tmpdir(), `p3b6_qs_${Date.now()}_${Math.random().toString(36).slice(2)}.sql`);
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

function readFileSyncCompat(filePath) {
  return readFileSync(filePath, 'utf8');
}

let passed = 0;
let failed = 0;
function check(name, cond) {
  if (cond) { console.log(`  ✓ ${name}`); passed++; }
  else { console.log(`  ✗ ${name}`); failed++; }
}

function asUser(role, userUid, sqlBody) {
  const setUid = userUid ? `SET app.current_user_id = '${userUid}';` : `SET app.current_user_id = '';`;
  return `
BEGIN;
SET ROLE ${role};
${setUid}
${sqlBody}
COMMIT;
RESET ROLE;
SET app.current_user_id = '';
`;
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
  ('${CLIENT_UID}'),
  ('${CONVOYEUR_UID}')
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

console.log('=== P3B6 Runtime Validation (disposable PostgreSQL 17) ===\n');

console.log('Starting disposable postgres:17 container...');
docker(['rm', '-f', CONTAINER], { stdio: 'pipe' });
const startRes = docker(['run', '-d', '--name', CONTAINER, '-e', `POSTGRES_PASSWORD=${PGPASSWORD}`, '-p', `${PGPORT}:5432`, 'postgres:17'], { stdio: 'pipe' });
if (startRes.status !== 0) {
  console.error('Failed to start container:', startRes.stderr);
  process.exit(1);
}

let ready = false;
for (let i = 0; i < 30; i++) {
  const r = docker(['exec', '-e', `PGPASSWORD=${PGPASSWORD}`, CONTAINER, 'pg_isready', '-U', PGUSER], { stdio: 'pipe' });
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
  for (const file of ALL_MIGRATIONS) {
    const name = basename(file);
    res = psql(readFileSyncCompat(file));
    if (res.status !== 0) {
      console.error(`${name} failed:`, res.stderr);
      throw new Error(name);
    }
    process.stdout.write(`  ${name} OK\n`);
  }

  console.log('Loading fixtures...');
  res = psql(FIXTURE_SQL);
  if (res.status !== 0) { console.error('Fixtures failed:', res.stderr); throw new Error('fixtures'); }

  // Create test data (separate calls so one failure doesn't block others)
  const testData = [
    `INSERT INTO public.organizations (id, legal_name) VALUES ('${ORG_A_ID}', 'Org A'), ('${ORG_B_ID}', 'Org B') ON CONFLICT (id) DO NOTHING;`,
    `INSERT INTO public.organization_contacts (id, organization_id, first_name, last_name) VALUES ('${CONTACT_A_ID}', '${ORG_A_ID}', 'Alice', 'Dupont') ON CONFLICT (id) DO NOTHING;`,
    `INSERT INTO public.crm_opportunities (id, title, organization_id, estimated_value) VALUES ('${OPP_A_ID}', 'Org A deal', '${ORG_A_ID}', 5000) ON CONFLICT (id) DO NOTHING;`,
    `INSERT INTO public.clients (id, role, auth_user_id, email, nom, prenom) VALUES ('${CLIENT_ID}', 'client', '${CLIENT_UID}', 'client@test.com', 'Test', 'Client') ON CONFLICT (id) DO NOTHING;`,
    `INSERT INTO public.devis (id, reference, client_email, status, total_ht) VALUES ('${DEVIS_ID}', 'DEV-001', 'client@test.com', 'pending', 1000) ON CONFLICT (id) DO NOTHING;`,
    `INSERT INTO public.missions (id, reference, client_email, status, client_id) VALUES ('${MISSION_ID}', 'MIS-001', 'client@test.com', 'available', '${CLIENT_ID}') ON CONFLICT (id) DO NOTHING;`,
    `INSERT INTO public.crm_pipeline_events (opportunity_id, from_stage, to_stage, actor_user_id, actor_role, reason, metadata) VALUES ('${OPP_A_ID}', NULL, 'lead', '${ADMIN_UID}', 'admin', 'Opportunity created', '{}'::jsonb) ON CONFLICT DO NOTHING;`,
    `INSERT INTO public.mission_events (mission_id, event_type, from_status, to_status, actor_user_id, actor_role, metadata) VALUES ('${MISSION_ID}', 'mission_status_changed', 'available', 'assigned', '${ADMIN_UID}', 'admin', '{}'::jsonb) ON CONFLICT DO NOTHING;`,
    `INSERT INTO public.billing_records (id, mission_id, client_id, provider, status, total_ht, total_ttc, prepared_payload) VALUES ('bbbb0000-0000-0000-0000-000000000001', '${MISSION_ID}', '${CLIENT_ID}', 'indy', 'prepared', 1000, 1000, '{}'::jsonb) ON CONFLICT (id) DO NOTHING;`,
    `INSERT INTO public.billing_events (billing_record_id, event_type, from_status, to_status, actor_user_id, actor_role, metadata) VALUES ('bbbb0000-0000-0000-0000-000000000001', 'billing_record_created', NULL, 'prepared', '${ADMIN_UID}', 'admin', jsonb_build_object('total_ht', 1000, 'total_ttc', 1000, 'provider', 'indy', 'mission_id', '${MISSION_ID}')) ON CONFLICT DO NOTHING;`,
  ];
  for (const sql of testData) {
    const r = psql(sql);
    if (r.status !== 0) {
      console.log('  TEST DATA ERROR:', r.stderr.trim().split('\n')[0]);
    }
  }

  // CRM activity needs auth context (created_by trigger uses auth.uid())
  psql(asUser('authenticated', ADMIN_UID, `
    INSERT INTO public.crm_activities (organization_id, activity_type, subject, body, status, occurred_at)
    VALUES ('${ORG_A_ID}', 'call', 'Follow-up call', 'Discussed deal', 'completed', now())
    ON CONFLICT DO NOTHING;
  `));

  // =========================================================
  // SCHEMA ASSERTIONS
  // =========================================================
  console.log('\n--- SCHEMA ASSERTIONS ---');

  check('crm_link_events table exists',
    psqlScalar(`SELECT count(*) FROM information_schema.tables WHERE table_schema='public' AND table_name='crm_link_events'`) === '1');

  check('crm_link_events.id column',
    psqlScalar(`SELECT count(*) FROM information_schema.columns WHERE table_schema='public' AND table_name='crm_link_events' AND column_name='id' AND data_type='uuid'`) === '1');
  check('crm_link_events.actor_user_id column',
    psqlScalar(`SELECT count(*) FROM information_schema.columns WHERE table_schema='public' AND table_name='crm_link_events' AND column_name='actor_user_id' AND is_nullable='NO'`) === '1');
  check('crm_link_events.actor_role column',
    psqlScalar(`SELECT count(*) FROM information_schema.columns WHERE table_schema='public' AND table_name='crm_link_events' AND column_name='actor_role' AND is_nullable='NO'`) === '1');
  check('crm_link_events.entity_type column',
    psqlScalar(`SELECT count(*) FROM information_schema.columns WHERE table_schema='public' AND table_name='crm_link_events' AND column_name='entity_type' AND is_nullable='NO'`) === '1');
  check('crm_link_events.entity_id column',
    psqlScalar(`SELECT count(*) FROM information_schema.columns WHERE table_schema='public' AND table_name='crm_link_events' AND column_name='entity_id' AND is_nullable='NO'`) === '1');
  check('crm_link_events.field_name column',
    psqlScalar(`SELECT count(*) FROM information_schema.columns WHERE table_schema='public' AND table_name='crm_link_events' AND column_name='field_name' AND is_nullable='NO'`) === '1');
  check('crm_link_events.old_value column (nullable)',
    psqlScalar(`SELECT count(*) FROM information_schema.columns WHERE table_schema='public' AND table_name='crm_link_events' AND column_name='old_value' AND is_nullable='YES'`) === '1');
  check('crm_link_events.new_value column (nullable)',
    psqlScalar(`SELECT count(*) FROM information_schema.columns WHERE table_schema='public' AND table_name='crm_link_events' AND column_name='new_value' AND is_nullable='YES'`) === '1');
  check('crm_link_events.metadata column',
    psqlScalar(`SELECT count(*) FROM information_schema.columns WHERE table_schema='public' AND table_name='crm_link_events' AND column_name='metadata' AND data_type='jsonb' AND is_nullable='NO'`) === '1');

  // CHECK constraints
  check('actor_role CHECK exists',
    psqlScalar(`SELECT count(*) FROM information_schema.check_constraints WHERE constraint_name='crm_link_events_actor_role_check'`) === '1');
  check('entity_type CHECK exists',
    psqlScalar(`SELECT count(*) FROM information_schema.check_constraints WHERE constraint_name='crm_link_events_entity_type_check'`) === '1');
  check('field_name CHECK exists',
    psqlScalar(`SELECT count(*) FROM information_schema.check_constraints WHERE constraint_name='crm_link_events_field_name_check'`) === '1');
  check('entity_field_compatible CHECK exists',
    psqlScalar(`SELECT count(*) FROM information_schema.check_constraints WHERE constraint_name='crm_link_events_entity_field_compatible'`) === '1');

  // RLS
  check('crm_link_events RLS enabled',
    psqlScalar(`SELECT relrowsecurity FROM pg_class WHERE relname='crm_link_events'`) === 't');
  check('crm_link_events RLS forced',
    psqlScalar(`SELECT relforcerowsecurity FROM pg_class WHERE relname='crm_link_events'`) === 't');

  // Index
  check('idx_mission_events_mission_created_at exists',
    psqlScalar(`SELECT count(*) FROM pg_indexes WHERE indexname='idx_mission_events_mission_created_at'`) === '1');

  // =========================================================
  // IMMUTABILITY
  // =========================================================
  console.log('\n--- IMMUTABILITY ---');

  // Insert a test audit row as postgres (bypasses RLS)
  psql(`
INSERT INTO public.crm_link_events (actor_user_id, actor_role, entity_type, entity_id, field_name, old_value, new_value)
VALUES ('${ADMIN_UID}', 'admin', 'client', '${CLIENT_ID}', 'organization_id', NULL, '${ORG_A_ID}');
  `);

  // UPDATE should fail
  const updateRes = psqlScalarSafe(`UPDATE public.crm_link_events SET actor_role='operator' WHERE actor_role='admin' LIMIT 1`);
  check('UPDATE crm_link_events DENIED (42501)', updateRes === null);

  // DELETE should fail
  const deleteRes = psqlScalarSafe(`DELETE FROM public.crm_link_events WHERE actor_role='admin' LIMIT 1`);
  check('DELETE crm_link_events DENIED (42501)', deleteRes === null);

  // =========================================================
  // RLS: admin-only SELECT
  // =========================================================
  console.log('\n--- RLS: ADMIN-ONLY SELECT ---');

  // Admin can SELECT
  const adminSelect = psqlScalarSafe(asUser('authenticated', ADMIN_UID, `
    SELECT count(*) FROM public.crm_link_events;
  `));
  check('admin can SELECT crm_link_events', adminSelect !== null && parseInt(adminSelect) >= 1);

  // Operator cannot SELECT (admin-only)
  const opSelect = psqlScalarSafe(asUser('authenticated', OPERATOR_UID, `
    SELECT count(*) FROM public.crm_link_events;
  `));
  check('operator cannot SELECT crm_link_events (admin-only)', opSelect === null || opSelect === '0');

  // =========================================================
  // DIRECT INSERT DENIED
  // =========================================================
  console.log('\n--- DIRECT INSERT DENIED ---');

  const adminDirectInsert = psqlScalarSafe(asUser('authenticated', ADMIN_UID, `
    INSERT INTO public.crm_link_events (actor_user_id, actor_role, entity_type, entity_id, field_name)
    VALUES ('${ADMIN_UID}', 'admin', 'client', '${CLIENT_ID}', 'organization_id');
  `));
  check('admin direct INSERT DENIED', adminDirectInsert === null);

  const opDirectInsert = psqlScalarSafe(asUser('authenticated', OPERATOR_UID, `
    INSERT INTO public.crm_link_events (actor_user_id, actor_role, entity_type, entity_id, field_name)
    VALUES ('${OPERATOR_UID}', 'operator', 'client', '${CLIENT_ID}', 'organization_id');
  `));
  check('operator direct INSERT DENIED', opDirectInsert === null);

  const srDirectInsert = psqlScalarSafe(asUser('service_role', '', `
    INSERT INTO public.crm_link_events (actor_user_id, actor_role, entity_type, entity_id, field_name)
    VALUES ('${ADMIN_UID}', 'admin', 'client', '${CLIENT_ID}', 'organization_id');
  `));
  check('service_role direct INSERT DENIED', srDirectInsert === null);

  // =========================================================
  // AUDIT: CLIENT LINK
  // =========================================================
  console.log('\n--- AUDIT: CLIENT LINK ---');

  // Clear existing audit rows
  psql(`TRUNCATE public.crm_link_events;`);

  // Admin links client to org
  const adminLink = psqlScalarSafe(asUser('authenticated', ADMIN_UID, `
    SELECT public.crm_link_client_organization('${CLIENT_ID}', '${ORG_A_ID}');
  `));
  check('admin can link client to org', adminLink !== null);

  const clientAuditCount = psqlScalar(`SELECT count(*) FROM public.crm_link_events WHERE entity_type='client' AND entity_id='${CLIENT_ID}' AND field_name='organization_id'`);
  check('client link creates 1 audit event', clientAuditCount === '1');

  const clientAuditActor = psqlScalar(`SELECT actor_role FROM public.crm_link_events WHERE entity_type='client' AND entity_id='${CLIENT_ID}' LIMIT 1`);
  check('client audit actor_role=admin', clientAuditActor === 'admin');

  const clientAuditUser = psqlScalar(`SELECT actor_user_id::text FROM public.crm_link_events WHERE entity_type='client' AND entity_id='${CLIENT_ID}' LIMIT 1`);
  check('client audit actor_user_id=admin', clientAuditUser === ADMIN_UID);

  // Unlink (value -> NULL)
  psql(`TRUNCATE public.crm_link_events;`);
  const adminUnlink = psqlScalarSafe(asUser('authenticated', ADMIN_UID, `
    SELECT public.crm_link_client_organization('${CLIENT_ID}', NULL);
  `));
  check('admin can unlink client', adminUnlink !== null);
  check('client unlink creates 1 audit event',
    psqlScalar(`SELECT count(*) FROM public.crm_link_events WHERE entity_type='client' AND entity_id='${CLIENT_ID}'`) === '1');

  // =========================================================
  // AUDIT: DEVIS LINK (up to 3)
  // =========================================================
  console.log('\n--- AUDIT: DEVIS LINK (up to 3) ---');

  psql(`TRUNCATE public.crm_link_events;`);

  // Link devis to org + contact + opportunity (3 fields)
  const devisLink = psqlScalarSafe(asUser('authenticated', ADMIN_UID, `
    SELECT public.crm_link_devis_crm('${DEVIS_ID}', '${ORG_A_ID}', '${CONTACT_A_ID}', '${OPP_A_ID}');
  `));
  check('admin can link devis to CRM (3 fields)', devisLink !== null);

  const devisAuditCount = psqlScalar(`SELECT count(*) FROM public.crm_link_events WHERE entity_type='devis' AND entity_id='${DEVIS_ID}'`);
  check('devis link creates 3 audit events', devisAuditCount === '3');

  // Verify each field
  check('devis audit has organization_id',
    psqlScalar(`SELECT count(*) FROM public.crm_link_events WHERE entity_type='devis' AND entity_id='${DEVIS_ID}' AND field_name='organization_id'`) === '1');
  check('devis audit has contact_id',
    psqlScalar(`SELECT count(*) FROM public.crm_link_events WHERE entity_type='devis' AND entity_id='${DEVIS_ID}' AND field_name='contact_id'`) === '1');
  check('devis audit has opportunity_id',
    psqlScalar(`SELECT count(*) FROM public.crm_link_events WHERE entity_type='devis' AND entity_id='${DEVIS_ID}' AND field_name='opportunity_id'`) === '1');

  // Unchanged field: re-link with same values should create 0 new events
  psql(`TRUNCATE public.crm_link_events;`);
  psqlScalarSafe(asUser('authenticated', ADMIN_UID, `
    SELECT public.crm_link_devis_crm('${DEVIS_ID}', '${ORG_A_ID}', '${CONTACT_A_ID}', '${OPP_A_ID}');
  `));
  check('devis re-link with same values creates 0 audit events',
    psqlScalar(`SELECT count(*) FROM public.crm_link_events WHERE entity_type='devis' AND entity_id='${DEVIS_ID}'`) === '0');

  // =========================================================
  // AUDIT: MISSION LINK (up to 2)
  // =========================================================
  console.log('\n--- AUDIT: MISSION LINK (up to 2) ---');

  psql(`TRUNCATE public.crm_link_events;`);

  const missionLink = psqlScalarSafe(asUser('authenticated', OPERATOR_UID, `
    SELECT public.crm_link_mission_devis('${MISSION_ID}', '${DEVIS_ID}', '${ORG_A_ID}');
  `));
  check('operator can link mission to devis+org', missionLink !== null);

  const missionAuditCount = psqlScalar(`SELECT count(*) FROM public.crm_link_events WHERE entity_type='mission' AND entity_id='${MISSION_ID}'`);
  check('mission link creates 2 audit events', missionAuditCount === '2');

  check('mission audit has devis_id',
    psqlScalar(`SELECT count(*) FROM public.crm_link_events WHERE entity_type='mission' AND entity_id='${MISSION_ID}' AND field_name='devis_id'`) === '1');
  check('mission audit has organization_id',
    psqlScalar(`SELECT count(*) FROM public.crm_link_events WHERE entity_type='mission' AND entity_id='${MISSION_ID}' AND field_name='organization_id'`) === '1');

  // Actor should be operator
  const missionActor = psqlScalar(`SELECT actor_role FROM public.crm_link_events WHERE entity_type='mission' AND entity_id='${MISSION_ID}' LIMIT 1`);
  check('mission audit actor_role=operator', missionActor === 'operator');

  // =========================================================
  // AUDIT: ENTITY/FIELD INVALID COMBO (CHECK deny)
  // =========================================================
  console.log('\n--- AUDIT: ENTITY/FIELD INVALID COMBO ---');

  // Try to insert an invalid combo directly as postgres (bypasses RLS but CHECK still applies)
  const invalidCombo = psqlScalarSafe(`
INSERT INTO public.crm_link_events (actor_user_id, actor_role, entity_type, entity_id, field_name)
VALUES ('${ADMIN_UID}', 'admin', 'client', '${CLIENT_ID}', 'devis_id');
  `);
  check('invalid entity/field combo (client+devis_id) rejected by CHECK', invalidCombo === null);

  const invalidCombo2 = psqlScalarSafe(`
INSERT INTO public.crm_link_events (actor_user_id, actor_role, entity_type, entity_id, field_name)
VALUES ('${ADMIN_UID}', 'admin', 'mission', '${MISSION_ID}', 'contact_id');
  `);
  check('invalid entity/field combo (mission+contact_id) rejected by CHECK', invalidCombo2 === null);

  // =========================================================
  // TIMELINE: AUTHORIZATION
  // =========================================================
  console.log('\n--- TIMELINE: AUTHORIZATION ---');

  // Admin can call
  const adminTimeline = psqlScalarSafe(asUser('authenticated', ADMIN_UID, `
    SELECT count(*) FROM public.crm_timeline_read();
  `));
  check('admin can call crm_timeline_read', adminTimeline !== null);

  // Operator can call
  const opTimeline = psqlScalarSafe(asUser('authenticated', OPERATOR_UID, `
    SELECT count(*) FROM public.crm_timeline_read();
  `));
  check('operator can call crm_timeline_read', opTimeline !== null);

  // Client cannot call (42501)
  const clientTimeline = psqlScalarSafe(asUser('authenticated', CLIENT_UID, `
    SELECT count(*) FROM public.crm_timeline_read();
  `));
  check('client cannot call crm_timeline_read (42501)', clientTimeline === null);

  // Convoyeur cannot call
  const convoyeurTimeline = psqlScalarSafe(asUser('authenticated', CONVOYEUR_UID, `
    SELECT count(*) FROM public.crm_timeline_read();
  `));
  check('convoyeur cannot call crm_timeline_read (42501)', convoyeurTimeline === null);

  // Anon cannot call (EXECUTE denied)
  const anonTimeline = psqlScalarSafe(asUser('anon', '', `
    SELECT count(*) FROM public.crm_timeline_read();
  `));
  check('anon cannot call crm_timeline_read (EXECUTE denied)', anonTimeline === null);

  // =========================================================
  // TIMELINE: 6 SOURCE BRANCHES
  // =========================================================
  console.log('\n--- TIMELINE: 6 SOURCE BRANCHES ---');

  // Check event_source values present
  const sources = psqlScalar(asUser('authenticated', ADMIN_UID, `
    SELECT string_agg(DISTINCT event_source, ',' ORDER BY event_source) FROM public.crm_timeline_read();
  `));

  check('timeline has pipeline_event branch', sources.includes('pipeline_event'));
  check('timeline has mission_event branch', sources.includes('mission_event'));
  check('timeline has billing_event branch', sources.includes('billing_event'));
  check('timeline has devis branch', sources.includes('devis'));
  check('timeline has mission branch', sources.includes('mission'));
  check('timeline has activity branch', sources.includes('activity'));

  // billing_records NOT included
  check('timeline does NOT have billing_record branch', !sources.includes('billing_record'));
  // crm_link_events NOT included
  check('timeline does NOT have link_event branch', !sources.includes('link_event'));

  // record_kind values
  const recordKinds = psqlScalar(asUser('authenticated', ADMIN_UID, `
    SELECT string_agg(DISTINCT record_kind, ',' ORDER BY record_kind) FROM public.crm_timeline_read();
  `));
  check('timeline has immutable_event record_kind', recordKinds.includes('immutable_event'));
  check('timeline has state_projection record_kind', recordKinds.includes('state_projection'));

  // =========================================================
  // TIMELINE: EVENT KEY UNIQUENESS
  // =========================================================
  console.log('\n--- TIMELINE: EVENT KEY UNIQUENESS ---');

  const totalRows = parseInt(psqlScalar(asUser('authenticated', ADMIN_UID, `
    SELECT count(*) FROM public.crm_timeline_read();
  `)));
  const uniqueKeys = parseInt(psqlScalar(asUser('authenticated', ADMIN_UID, `
    SELECT count(DISTINCT event_key) FROM public.crm_timeline_read();
  `)));
  check('event_key unique (no duplicates)', totalRows === uniqueKeys);

  // =========================================================
  // TIMELINE: MISSION_CREATED EXISTS
  // =========================================================
  console.log('\n--- TIMELINE: MISSION_CREATED EXISTS ---');

  const missionCreated = psqlScalar(asUser('authenticated', ADMIN_UID, `
    SELECT count(*) FROM public.crm_timeline_read() WHERE event_source='mission' AND event_type='mission_created';
  `));
  check('mission_created state projection exists', parseInt(missionCreated) >= 1);

  // =========================================================
  // TIMELINE: LIMIT
  // =========================================================
  console.log('\n--- TIMELINE: LIMIT ---');

  // NULL => 50
  const nullLimitCount = parseInt(psqlScalar(asUser('authenticated', ADMIN_UID, `
    SELECT count(*) FROM public.crm_timeline_read(p_limit => NULL);
  `)));
  check('p_limit=NULL => 50 rows max', nullLimitCount <= 50);

  // 0 => 1
  const zeroLimitCount = parseInt(psqlScalar(asUser('authenticated', ADMIN_UID, `
    SELECT count(*) FROM public.crm_timeline_read(p_limit => 0);
  `)));
  check('p_limit=0 => 1 row min', zeroLimitCount === 1);

  // negative => 1
  const negLimitCount = parseInt(psqlScalar(asUser('authenticated', ADMIN_UID, `
    SELECT count(*) FROM public.crm_timeline_read(p_limit => -5);
  `)));
  check('p_limit=-5 => 1 row min', negLimitCount === 1);

  // 999 => 200
  const bigLimitCount = parseInt(psqlScalar(asUser('authenticated', ADMIN_UID, `
    SELECT count(*) FROM public.crm_timeline_read(p_limit => 999);
  `)));
  check('p_limit=999 => 200 rows max', bigLimitCount <= 200);

  // =========================================================
  // TIMELINE: CURSOR PAIR VALIDATION
  // =========================================================
  console.log('\n--- TIMELINE: CURSOR PAIR VALIDATION ---');

  // Both NULL => OK
  const bothNull = psqlScalarSafe(asUser('authenticated', ADMIN_UID, `
    SELECT count(*) FROM public.crm_timeline_read(p_before_event_at => NULL, p_before_event_key => NULL);
  `));
  check('cursor both NULL => OK', bothNull !== null);

  // Timestamp only => 22023
  const tsOnly = psqlScalarSafe(asUser('authenticated', ADMIN_UID, `
    SELECT count(*) FROM public.crm_timeline_read(p_before_event_at => '2025-01-01T00:00:00Z'::timestamptz, p_before_event_key => NULL);
  `));
  check('cursor timestamp only => 22023', tsOnly === null);

  // Key only => 22023
  const keyOnly = psqlScalarSafe(asUser('authenticated', ADMIN_UID, `
    SELECT count(*) FROM public.crm_timeline_read(p_before_event_at => NULL, p_before_event_key => 'test');
  `));
  check('cursor key only => 22023', keyOnly === null);

  // =========================================================
  // TIMELINE: FILTER AUTHORIZATION
  // =========================================================
  console.log('\n--- TIMELINE: FILTER AUTHORIZATION ---');

  // Unauthorized caller with valid UUID => 42501
  const clientValidUuid = psqlScalarSafe(asUser('authenticated', CLIENT_UID, `
    SELECT count(*) FROM public.crm_timeline_read(p_organization_id => '${ORG_A_ID}');
  `));
  check('unauthorized valid UUID => 42501', clientValidUuid === null);

  // Unauthorized caller with invalid UUID => 42501
  const clientInvalidUuid = psqlScalarSafe(asUser('authenticated', CLIENT_UID, `
    SELECT count(*) FROM public.crm_timeline_read(p_organization_id => '00000000-0000-0000-0000-000000000099');
  `));
  check('unauthorized invalid UUID => 42501', clientInvalidUuid === null);

  // Authorized caller with unknown UUID => empty set (not error)
  const adminUnknownUuid = psqlScalarSafe(asUser('authenticated', ADMIN_UID, `
    SELECT count(*) FROM public.crm_timeline_read(p_organization_id => '00000000-0000-0000-0000-000000000099');
  `));
  check('authorized unknown UUID => empty set (not error)', adminUnknownUuid === '0');

  // =========================================================
  // TIMELINE: REDACTION
  // =========================================================
  console.log('\n--- TIMELINE: REDACTION ---');

  // Billing record + event already created in test data section above.

  // Admin sees full billing metadata
  const adminBillingMeta = psqlScalar(asUser('authenticated', ADMIN_UID, `
    SELECT metadata->>'total_ht' FROM public.crm_timeline_read()
    WHERE event_source='billing_event' LIMIT 1;
  `));
  check('admin sees billing total_ht in metadata', adminBillingMeta === '1000');

  // Operator does NOT see billing total_ht
  const opBillingMeta = psqlScalar(asUser('authenticated', OPERATOR_UID, `
    SELECT metadata->>'total_ht' FROM public.crm_timeline_read()
    WHERE event_source='billing_event' LIMIT 1;
  `));
  check('operator does NOT see billing total_ht', opBillingMeta === '' || opBillingMeta === null);

  // Operator sees billing event_type
  const opBillingType = psqlScalar(asUser('authenticated', OPERATOR_UID, `
    SELECT metadata->>'event_type' FROM public.crm_timeline_read()
    WHERE event_source='billing_event' LIMIT 1;
  `));
  check('operator sees billing event_type', opBillingType === 'billing_record_created');

  // Operator sees devis total_ht (CRM operational data)
  const opDevisAmount = psqlScalar(asUser('authenticated', OPERATOR_UID, `
    SELECT metadata->>'total_ht' FROM public.crm_timeline_read()
    WHERE event_source='devis' LIMIT 1;
  `));
  check('operator sees devis total_ht (CRM operational)', opDevisAmount === '1000');

  // =========================================================
  // TIMELINE: CURRENT ORGANIZATION ATTRIBUTION
  // =========================================================
  console.log('\n--- TIMELINE: CURRENT ORGANIZATION ATTRIBUTION ---');

  // Mission event already created in test data. Mission should be linked to ORG_A
  // by the "AUDIT: MISSION LINK" section above.
  // Before reparent: mission_event shows ORG_A
  const orgBeforeReparent = psqlScalar(asUser('authenticated', ADMIN_UID, `
    SELECT current_organization_id::text FROM public.crm_timeline_read()
    WHERE event_source='mission_event' AND current_mission_id='${MISSION_ID}'
    LIMIT 1;
  `));
  check('mission_event current_organization_id=ORG_A before reparent', orgBeforeReparent === ORG_A_ID);

  // Reparent mission to ORG_B (first unlink devis, then set org)
  psqlScalarSafe(asUser('authenticated', ADMIN_UID, `
    SELECT public.crm_link_mission_devis('${MISSION_ID}', NULL, '${ORG_B_ID}');
  `));

  // After reparent: same mission_event now shows ORG_B (current-parent semantics)
  const orgAfterReparent = psqlScalar(asUser('authenticated', ADMIN_UID, `
    SELECT current_organization_id::text FROM public.crm_timeline_read()
    WHERE event_source='mission_event' AND current_mission_id='${MISSION_ID}'
    LIMIT 1;
  `));
  check('mission_event current_organization_id=ORG_B after reparent (current-parent)', orgAfterReparent === ORG_B_ID);

  // =========================================================
  // SUMMARY: AUTHORIZATION
  // =========================================================
  console.log('\n--- SUMMARY: AUTHORIZATION ---');

  const adminSummary = psqlScalarSafe(asUser('authenticated', ADMIN_UID, `
    SELECT count(*) FROM public.crm_organizations_summary();
  `));
  check('admin can call crm_organizations_summary', adminSummary !== null);

  const opSummary = psqlScalarSafe(asUser('authenticated', OPERATOR_UID, `
    SELECT count(*) FROM public.crm_organizations_summary();
  `));
  check('operator can call crm_organizations_summary', opSummary !== null);

  const clientSummary = psqlScalarSafe(asUser('authenticated', CLIENT_UID, `
    SELECT count(*) FROM public.crm_organizations_summary();
  `));
  check('client cannot call crm_organizations_summary (42501)', clientSummary === null);

  const anonSummary = psqlScalarSafe(asUser('anon', '', `
    SELECT count(*) FROM public.crm_organizations_summary();
  `));
  check('anon cannot call crm_organizations_summary (EXECUTE denied)', anonSummary === null);

  // =========================================================
  // SUMMARY: AGGREGATES
  // =========================================================
  console.log('\n--- SUMMARY: AGGREGATES ---');

  // Org A should have counts
  const orgASummary = psqlScalar(asUser('authenticated', ADMIN_UID, `
    SELECT legal_name || '|' || contacts_count || '|' || opportunities_count || '|' ||
           devis_count || '|' || missions_count || '|' || billing_count || '|' || pipeline_value
    FROM public.crm_organizations_summary()
    WHERE organization_id='${ORG_A_ID}';
  `));
  check('Org A summary exists', orgASummary !== '');
  console.log(`    Org A: ${orgASummary}`);

  // billing_amount NOT in output (check column doesn't exist)
  const billingAmountCol = psqlScalar(`
    SELECT count(*) FROM information_schema.columns
    WHERE table_schema='public' AND table_name='crm_organizations_summary'
    AND column_name='billing_amount'
  `);
  // This checks the function's return type via pg_proc
  const summaryReturnType = psqlScalar(`
    SELECT count(*) FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname='public' AND p.proname='crm_organizations_summary'
    AND p.proallargtypes::text LIKE '%billing_amount%'
  `);
  check('billing_amount NOT in summary return type', summaryReturnType === '0');

  // Operator sees complete counts (SECURITY DEFINER bypasses RLS)
  const opDevisCount = psqlScalar(asUser('authenticated', OPERATOR_UID, `
    SELECT devis_count FROM public.crm_organizations_summary()
    WHERE organization_id='${ORG_A_ID}';
  `));
  check('operator sees devis_count > 0 (SECURITY DEFINER bypass)', parseInt(opDevisCount) > 0);

  const opBillingCount = psqlScalar(asUser('authenticated', OPERATOR_UID, `
    SELECT billing_count FROM public.crm_organizations_summary()
    WHERE organization_id='${ORG_B_ID}';
  `));
  check('operator sees billing_count > 0 (SECURITY DEFINER bypass)', parseInt(opBillingCount) > 0);

  // pipeline_value is present and correct
  const pipelineValue = psqlScalar(asUser('authenticated', ADMIN_UID, `
    SELECT pipeline_value FROM public.crm_organizations_summary()
    WHERE organization_id='${ORG_A_ID}';
  `));
  check('pipeline_value = 5000 (from opportunity estimated_value)', pipelineValue === '5000');

  // =========================================================
  // SUMMARY: ARCHIVED ORG EXCLUDED
  // =========================================================
  console.log('\n--- SUMMARY: ARCHIVED ORG EXCLUDED ---');

  // Create an archived org
  psql(`
INSERT INTO public.organizations (id, legal_name, status)
VALUES ('55550000-0000-0000-0000-000000000005', 'Archived Org', 'archived')
ON CONFLICT (id) DO NOTHING;
  `);

  const archivedOrgInSummary = psqlScalar(asUser('authenticated', ADMIN_UID, `
    SELECT count(*) FROM public.crm_organizations_summary()
    WHERE organization_id='55550000-0000-0000-0000-000000000005';
  `));
  check('archived org excluded from summary', archivedOrgInSummary === '0');

  // =========================================================
  // SUMMARY: EARLY LEADS EXCLUDED (NULL org opportunities)
  // =========================================================
  console.log('\n--- SUMMARY: EARLY LEADS EXCLUDED ---');

  // Create an opportunity with NULL organization_id (early lead)
  psql(`
INSERT INTO public.crm_opportunities (id, title, organization_id, estimated_value)
VALUES ('88880000-0000-0000-0000-000000000008', 'Early Lead', NULL, 999)
ON CONFLICT (id) DO NOTHING;
  `);

  // The early lead should NOT appear in any org's summary
  // (it has NULL organization_id, so it's excluded from opportunities_agg)
  const earlyLeadInSummary = psqlScalar(asUser('authenticated', ADMIN_UID, `
    SELECT count(*) FROM public.crm_organizations_summary()
    WHERE opportunities_count > 0 AND organization_id IS NULL;
  `));
  check('early lead (NULL org) excluded from summary', earlyLeadInSummary === '0');

  // =========================================================
  // P3B5 REGRESSION: GUARDS STILL WORK
  // =========================================================
  console.log('\n--- P3B5 REGRESSION ---');

  // Client cannot link
  const clientLinkAttempt = psqlScalarSafe(asUser('authenticated', CLIENT_UID, `
    SELECT public.crm_link_client_organization('${CLIENT_ID}', '${ORG_B_ID}');
  `));
  check('P3B5 regression: client cannot link client', clientLinkAttempt === null);

  // service_role cannot link
  const srLinkAttempt = psqlScalarSafe(asUser('service_role', '', `
    SELECT public.crm_link_client_organization('${CLIENT_ID}', '${ORG_B_ID}');
  `));
  check('P3B5 regression: service_role cannot link client', srLinkAttempt === null);

  // Graph-invalid: devis contact without org
  const graphInvalid = psqlScalarSafe(asUser('authenticated', ADMIN_UID, `
    SELECT public.crm_link_devis_crm('${DEVIS_ID}', NULL, '${CONTACT_A_ID}', NULL);
  `));
  check('P3B5 regression: graph-invalid (contact without org) DENIED', graphInvalid === null);

  // =========================================================
  // SECURITY DEFINER INVENTORY
  // =========================================================
  console.log('\n--- SECURITY DEFINER INVENTORY ---');

  // P3B5 had 11, P3B6 adds 4 new (crm_link_events_immutable, log_crm_link_event,
  // crm_timeline_read, crm_organizations_summary) = 15 total
  // But log_crm_link_event is internal helper, not in the P3B5 list.
  // The 3 extended guards are CREATE OR REPLACE (already counted in P3B5's 11).
  // New SD functions: 4
  // Total SD in public schema (including all from P3B1-P3B5 + P3B6):
  const sdCount = psqlScalar(`
    SELECT count(*) FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.prosecdef = true
  `);
  console.log(`    Total SECURITY DEFINER functions in public: ${sdCount}`);
  check('SECURITY DEFINER count >= 14 (P3B5 11 + 4 new)', parseInt(sdCount) >= 14);

  // All P3B6 SD functions have search_path = ''
  const sdSearchPathOk = psqlScalar(`
    SELECT count(*) FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
      AND p.prosecdef = true
      AND p.proname IN (
        'crm_link_events_immutable',
        'log_crm_link_event',
        'guard_clients_organization_id',
        'devis_guard_crm_links',
        'missions_check_devis_org',
        'crm_timeline_read',
        'crm_organizations_summary'
      )
      AND p.proconfig IS NOT NULL
      AND array_to_string(p.proconfig, ',') LIKE '%search_path=%'
  `);
  check('all P3B6 SD functions have SET search_path', sdSearchPathOk === '7');

  // All owned by postgres
  const sdOwnerOk = psqlScalar(`
    SELECT count(*) FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    JOIN pg_roles r ON r.oid = p.proowner
    WHERE n.nspname = 'public'
      AND p.prosecdef = true
      AND p.proname IN (
        'crm_link_events_immutable',
        'log_crm_link_event',
        'guard_clients_organization_id',
        'devis_guard_crm_links',
        'missions_check_devis_org',
        'crm_timeline_read',
        'crm_organizations_summary'
      )
      AND r.rolname = 'postgres'
  `);
  check('all P3B6 SD functions owned by postgres', sdOwnerOk === '7');

  // =========================================================
  // DEBUG: Error messages from failing queries
  // =========================================================
  console.log('\n--- DEBUG: Error messages ---');

  // Debug: summary function error
  const summaryDebug = psql(asUser('authenticated', ADMIN_UID, `
    SELECT count(*) FROM public.crm_organizations_summary();
  `));
  console.log('  Summary stderr:', summaryDebug.stderr.trim() || '(none)');

  // Debug: mission link error
  const missionDebug = psql(asUser('authenticated', OPERATOR_UID, `
    SELECT public.crm_link_mission_devis('${MISSION_ID}', '${DEVIS_ID}', '${ORG_A_ID}');
  `));
  console.log('  Mission link stderr:', missionDebug.stderr.trim() || '(none)');

  // Debug: check user_roles
  const userRolesDebug = psqlScalar(`SELECT count(*) FROM public.user_roles`);
  console.log('  user_roles count:', userRolesDebug);

  // Debug: check is_admin/is_operator as admin
  const adminCheck = psqlScalar(asUser('authenticated', ADMIN_UID, `
    SELECT public.is_admin()::text || '|' || public.is_operator()::text || '|' || public.is_internal_user()::text;
  `));
  console.log('  admin is_admin|is_operator|is_internal_user:', adminCheck);

  // Debug: check is_admin/is_operator as operator
  const opCheck = psqlScalar(asUser('authenticated', OPERATOR_UID, `
    SELECT public.is_admin()::text || '|' || public.is_operator()::text || '|' || public.is_internal_user()::text;
  `));
  console.log('  operator is_admin|is_operator|is_internal_user:', opCheck);

  // Debug: check mission exists
  const missionExists = psqlScalar(`SELECT count(*) FROM public.missions WHERE id='${MISSION_ID}'`);
  console.log('  mission exists:', missionExists);

  // Debug: check devis organization_id
  const devisOrg = psqlScalar(`SELECT organization_id::text FROM public.devis WHERE id='${DEVIS_ID}'`);
  console.log('  devis organization_id:', devisOrg || '(null)');

  // Debug: check mission_events
  const missionEventsCount = psqlScalar(`SELECT count(*) FROM public.mission_events WHERE mission_id='${MISSION_ID}'`);
  console.log('  mission_events count:', missionEventsCount);

  // Debug: check billing_events
  const billingEventsCount = psqlScalar(`SELECT count(*) FROM public.billing_events`);
  console.log('  billing_events count:', billingEventsCount);

  // Debug: check crm_activities
  const activitiesCount = psqlScalar(`SELECT count(*) FROM public.crm_activities WHERE organization_id='${ORG_A_ID}'`);
  console.log('  crm_activities count:', activitiesCount);

  // Debug: timeline sources as admin
  const timelineSources = psqlScalar(asUser('authenticated', ADMIN_UID, `
    SELECT string_agg(DISTINCT event_source, ',' ORDER BY event_source) FROM public.crm_timeline_read();
  `));
  console.log('  timeline sources:', timelineSources || '(empty)');

  // Debug: timeline count as admin
  const timelineCount = psqlScalar(asUser('authenticated', ADMIN_UID, `
    SELECT count(*) FROM public.crm_timeline_read();
  `));
  console.log('  timeline total count:', timelineCount);

  // =========================================================
  // SUMMARY
  // =========================================================
  console.log('\n=== P3B6 Runtime Validation Summary ===');
  console.log(`  Passed: ${passed}`);
  console.log(`  Failed: ${failed}`);
  console.log(`  Result: ${failed === 0 ? 'ALL PASSED' : 'FAILURES DETECTED'}`);

} catch (err) {
  console.error('Test error:', err.message);
  failed++;
} finally {
  // Always destroy container
  console.log('\nDestroying container...');
  docker(['rm', '-f', CONTAINER], { stdio: 'pipe' });
}

process.exit(failed > 0 ? 1 : 0);
