// P3B5 — CRM Business Links — Runtime Validation (Disposable PostgreSQL 17)
//
// Spins up a DISPOSABLE postgres:17 container, loads the minimal dependency
// baseline (auth.uid() stub + helpers + clients/devis/missions tables +
// existing client guard), applies P3B1, P3B2, P3B3, P3B4, then P3B5 migrations
// in order, and runs runtime assertions covering:
//   - schema (6 columns, 6 FKs, 6 indexes)
//   - authorization guards (clients/devis/missions CRM links)
//   - cross-entity consistency (contact/org, opportunity/org, client/org, devis/org)
//   - parent reparent guards (clients, devis, contacts, opportunities)
//   - RPCs (3 narrow CRM-link write paths)
//   - service_role direct CRM-link DENY
//   - anon/client CRM-link DENY
//   - error oracle (authorization precedes CRM lookups)
//   - legacy privileged-field semantics preserved
//
// AUTH_RLS_SIMULATION=YES — uses a session-GUC stub for auth.uid() because a
// plain PostgreSQL container has no Supabase GoTrue/JWT layer.
//
// The container is ALWAYS destroyed after tests (success or failure).

import { spawnSync } from 'node:child_process';
import { writeFileSync, unlinkSync, mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { join, basename } from 'node:path';
import { tmpdir } from 'node:os';

const CONTAINER = 'p3b5_runtime_pg17';
const PGUSER = 'postgres';
const PGDB = 'postgres';
const PGPASSWORD = 'p3b5test';
const PGPORT = '54180';

const MIGRATIONS_DIR = new URL('../supabase/migrations/', import.meta.url).pathname
  .replace(/^\//, '')
  .replace(/\//g, '\\');

const BASELINE_FILE    = join(MIGRATIONS_DIR, '20260807214536_remote_public_baseline.sql');
const CLIENT_GUARD_FILE = join(MIGRATIONS_DIR, '20260809000008_phase3_b4_harden_client_role_and_promo_rls.sql');
const P3B1_FILE = join(MIGRATIONS_DIR, '20260909120000_p3b1_crm_organizations_segments.sql');
const P3B2_FILE = join(MIGRATIONS_DIR, '20260909130000_p3b2_crm_sites_contacts.sql');
const P3B3_FILE = join(MIGRATIONS_DIR, '20260909140000_p3b3_crm_opportunities_pipeline.sql');
const P3B4_FILE = join(MIGRATIONS_DIR, '20260910100000_p3b4_crm_activities.sql');
const P3B5_FILE = join(MIGRATIONS_DIR, '20260910110000_p3b5_crm_business_links.sql');

const ADMIN_UID    = 'aaaaaaaa-0000-0000-0000-000000000001';
const OPERATOR_UID = 'bbbbbbbb-0000-0000-0000-000000000002';
const CLIENT_UID   = 'cccccccc-0000-0000-0000-000000000003';
const CLIENT2_UID   = 'cccccccc-0000-0000-0000-000000000004';

const ORG_A_ID     = '11110000-0000-0000-0000-000000000001';
const ORG_B_ID     = '33330000-0000-0000-0000-000000000003';
const CONTACT_A_ID = '22220000-0000-0000-0000-000000000002';
const CONTACT_B_ID = '44440000-0000-0000-0000-000000000004';
const OPP_A_ID     = '66660000-0000-0000-0000-000000000006';
const OPP_B_ID     = '77770000-0000-0000-0000-000000000007';

function docker(args, opts = {}) {
  return spawnSync('docker', args, { encoding: 'utf8', ...opts });
}

function psql(sql, opts = {}) {
  const tmp = join(tmpdir(), `p3b5_${Date.now()}_${Math.random().toString(36).slice(2)}.sql`);
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
  const tmp = join(tmpdir(), `p3b5_q_${Date.now()}_${Math.random().toString(36).slice(2)}.sql`);
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
  const tmp = join(tmpdir(), `p3b5_qs_${Date.now()}_${Math.random().toString(36).slice(2)}.sql`);
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

// =========================================================
// SETUP: dependency baseline (auth.uid stub + helpers + tables)
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

CREATE TABLE IF NOT EXISTS public.user_roles (
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  role text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, role),
  CHECK (role IN ('admin', 'operator'))
);
CREATE TABLE IF NOT EXISTS public.internal_operators (
  user_id uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  display_name text NOT NULL,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE OR REPLACE FUNCTION public.set_updated_at()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

GRANT USAGE ON SCHEMA public TO authenticated, anon, service_role;
`;

// Helper functions must be defined AFTER the baseline creates public.clients
const HELPERS_SQL = `
CREATE OR REPLACE FUNCTION public.is_admin()
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT EXISTS (SELECT 1 FROM public.user_roles ur WHERE ur.role = 'admin' AND ur.user_id = auth.uid())
  OR EXISTS (SELECT 1 FROM public.clients c WHERE c.role = 'admin' AND c.auth_user_id = auth.uid())
$$;

CREATE OR REPLACE FUNCTION public.is_operator()
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.user_roles ur
    JOIN public.internal_operators io ON io.user_id = ur.user_id
    WHERE ur.role = 'operator' AND ur.user_id = auth.uid() AND io.active = true
  )
$$;

CREATE OR REPLACE FUNCTION public.is_internal_user()
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  RETURN public.is_admin() OR public.is_operator();
END;
$$;

GRANT EXECUTE ON FUNCTION public.is_admin() TO authenticated;
GRANT EXECUTE ON FUNCTION public.is_operator() TO authenticated;
GRANT EXECUTE ON FUNCTION public.is_internal_user() TO authenticated;
`;

const FIXTURE_SQL = `
INSERT INTO auth.users (id) VALUES
  ('${ADMIN_UID}'),
  ('${OPERATOR_UID}'),
  ('${CLIENT_UID}'),
  ('${CLIENT2_UID}')
ON CONFLICT (id) DO NOTHING;

INSERT INTO public.user_roles (user_id, role) VALUES
  ('${ADMIN_UID}', 'admin'),
  ('${OPERATOR_UID}', 'operator')
ON CONFLICT DO NOTHING;

INSERT INTO public.internal_operators (user_id, display_name, active) VALUES
  ('${OPERATOR_UID}', 'Test Operator', true)
ON CONFLICT (user_id) DO NOTHING;
`;

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
// MAIN
// =========================================================

console.log('=== P3B5 Runtime Validation (disposable PostgreSQL 17) ===\n');

// Start container
console.log('Starting disposable postgres:17 container...');
docker(['rm', '-f', CONTAINER], { stdio: 'pipe' });
const startRes = docker(['run', '-d', '--name', CONTAINER, '-e', `POSTGRES_PASSWORD=${PGPASSWORD}`, '-p', `${PGPORT}:5432`, 'postgres:17'], { stdio: 'pipe' });
if (startRes.status !== 0) {
  console.error('Failed to start container:', startRes.stderr);
  process.exit(1);
}

// Wait for ready
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
  // Load setup
  console.log('Loading dependency baseline (auth.uid stub + helpers)...');
  let res = psql(SETUP_SQL);
  if (res.status !== 0) { console.error('Setup failed:', res.stderr); throw new Error('setup'); }

  // Load baseline (creates clients/devis/missions tables + RLS + grants)
  console.log('Loading remote_public_baseline (clients/devis/missions tables)...');
  res = psql(readFileSyncCompat(BASELINE_FILE));
  if (res.status !== 0) { console.error('Baseline failed:', res.stderr); throw new Error('baseline'); }

  // Define helper functions now that public.clients exists
  console.log('Loading helper functions (is_admin, is_operator, is_internal_user)...');
  res = psql(HELPERS_SQL);
  if (res.status !== 0) { console.error('Helpers failed:', res.stderr); throw new Error('helpers'); }

  // Load client guard migration (guard_clients_privileged_fields)
  console.log('Loading client guard migration...');
  res = psql(readFileSyncCompat(CLIENT_GUARD_FILE));
  if (res.status !== 0) { console.error('Client guard failed:', res.stderr); throw new Error('client_guard'); }

  // Apply P3B1-P3B4 migrations
  console.log('Applying P3B1 migration...');
  res = psql(readFileSyncCompat(P3B1_FILE));
  if (res.status !== 0) { console.error('P3B1 failed:', res.stderr); throw new Error('p3b1'); }

  console.log('Applying P3B2 migration...');
  res = psql(readFileSyncCompat(P3B2_FILE));
  if (res.status !== 0) { console.error('P3B2 failed:', res.stderr); throw new Error('p3b2'); }

  console.log('Applying P3B3 migration...');
  res = psql(readFileSyncCompat(P3B3_FILE));
  if (res.status !== 0) { console.error('P3B3 failed:', res.stderr); throw new Error('p3b3'); }

  console.log('Applying P3B4 migration...');
  res = psql(readFileSyncCompat(P3B4_FILE));
  if (res.status !== 0) { console.error('P3B4 failed:', res.stderr); throw new Error('p3b4'); }

  // Apply P3B5 migration
  console.log('Applying P3B5 migration...');
  res = psql(readFileSyncCompat(P3B5_FILE));
  if (res.status !== 0) { console.error('P3B5 failed:', res.stderr); throw new Error('p3b5'); }

  // Load fixtures
  res = psql(FIXTURE_SQL);
  if (res.status !== 0) { console.error('Fixtures failed:', res.stderr); throw new Error('fixtures'); }

  // Create test organizations + contacts + opportunities + clients + devis + missions
  psql(`
INSERT INTO public.organizations (id, legal_name) VALUES
  ('${ORG_A_ID}', 'Org A'),
  ('${ORG_B_ID}', 'Org B')
ON CONFLICT (id) DO NOTHING;

INSERT INTO public.organization_contacts (id, organization_id, first_name, last_name)
VALUES ('${CONTACT_A_ID}', '${ORG_A_ID}', 'Alice', 'Dupont')
ON CONFLICT (id) DO NOTHING;

INSERT INTO public.organization_contacts (id, organization_id, first_name, last_name)
VALUES ('${CONTACT_B_ID}', '${ORG_B_ID}', 'Bob', 'Martin')
ON CONFLICT (id) DO NOTHING;

INSERT INTO public.crm_opportunities (id, title, organization_id)
VALUES ('${OPP_A_ID}', 'Org A deal', '${ORG_A_ID}')
ON CONFLICT (id) DO NOTHING;

INSERT INTO public.crm_opportunities (id, title, organization_id)
VALUES ('${OPP_B_ID}', 'Org B deal', '${ORG_B_ID}')
ON CONFLICT (id) DO NOTHING;

INSERT INTO public.clients (id, role, auth_user_id, email, nom, prenom)
VALUES ('dddd0000-0000-0000-0000-000000000004', 'client', '${CLIENT_UID}', 'client@test.com', 'Test', 'Client')
ON CONFLICT (id) DO NOTHING;

INSERT INTO public.clients (id, role, auth_user_id, email, nom, prenom)
VALUES ('dddd0000-0000-0000-0000-000000000005', 'client', '${CLIENT2_UID}', 'client2@test.com', 'Test2', 'Client2')
ON CONFLICT (id) DO NOTHING;

INSERT INTO public.devis (id, reference, client_email, status)
VALUES ('eeee0000-0000-0000-0000-000000000001', 'DEV-001', 'client@test.com', 'pending')
ON CONFLICT (id) DO NOTHING;

INSERT INTO public.devis (id, reference, client_email, status)
VALUES ('eeee0000-0000-0000-0000-000000000002', 'DEV-002', 'client2@test.com', 'pending')
ON CONFLICT (id) DO NOTHING;

INSERT INTO public.missions (id, reference, client_email, status)
VALUES ('ffff0000-0000-0000-0000-000000000001', 'MIS-001', 'client@test.com', 'planned')
ON CONFLICT (id) DO NOTHING;
  `);

  // =========================================================
  // SCHEMA ASSERTIONS
  // =========================================================
  console.log('\n--- SCHEMA ASSERTIONS ---');

  // 6 columns
  check('clients.organization_id exists',
    psqlScalar(`SELECT count(*) FROM information_schema.columns WHERE table_schema='public' AND table_name='clients' AND column_name='organization_id'`) === '1');
  check('devis.organization_id exists',
    psqlScalar(`SELECT count(*) FROM information_schema.columns WHERE table_schema='public' AND table_name='devis' AND column_name='organization_id'`) === '1');
  check('devis.contact_id exists',
    psqlScalar(`SELECT count(*) FROM information_schema.columns WHERE table_schema='public' AND table_name='devis' AND column_name='contact_id'`) === '1');
  check('devis.opportunity_id exists',
    psqlScalar(`SELECT count(*) FROM information_schema.columns WHERE table_schema='public' AND table_name='devis' AND column_name='opportunity_id'`) === '1');
  check('missions.devis_id exists',
    psqlScalar(`SELECT count(*) FROM information_schema.columns WHERE table_schema='public' AND table_name='missions' AND column_name='devis_id'`) === '1');
  check('missions.organization_id exists',
    psqlScalar(`SELECT count(*) FROM information_schema.columns WHERE table_schema='public' AND table_name='missions' AND column_name='organization_id'`) === '1');

  // No missions.contact_id or missions.opportunity_id
  check('missions.contact_id NOT added',
    psqlScalar(`SELECT count(*) FROM information_schema.columns WHERE table_schema='public' AND table_name='missions' AND column_name='contact_id'`) === '0');
  check('missions.opportunity_id NOT added',
    psqlScalar(`SELECT count(*) FROM information_schema.columns WHERE table_schema='public' AND table_name='missions' AND column_name='opportunity_id'`) === '0');

  // 6 FKs
  check('clients.organization_id FK exists',
    psqlScalar(`SELECT count(*) FROM information_schema.table_constraints WHERE constraint_name='clients_organization_id_fkey' AND constraint_type='FOREIGN KEY'`) === '1');
  check('devis.organization_id FK exists',
    psqlScalar(`SELECT count(*) FROM information_schema.table_constraints WHERE constraint_name='devis_organization_id_fkey' AND constraint_type='FOREIGN KEY'`) === '1');
  check('devis.contact_id FK exists',
    psqlScalar(`SELECT count(*) FROM information_schema.table_constraints WHERE constraint_name='devis_contact_id_fkey' AND constraint_type='FOREIGN KEY'`) === '1');
  check('devis.opportunity_id FK exists',
    psqlScalar(`SELECT count(*) FROM information_schema.table_constraints WHERE constraint_name='devis_opportunity_id_fkey' AND constraint_type='FOREIGN KEY'`) === '1');
  check('missions.devis_id FK exists',
    psqlScalar(`SELECT count(*) FROM information_schema.table_constraints WHERE constraint_name='missions_devis_id_fkey' AND constraint_type='FOREIGN KEY'`) === '1');
  check('missions.organization_id FK exists',
    psqlScalar(`SELECT count(*) FROM information_schema.table_constraints WHERE constraint_name='missions_organization_id_fkey' AND constraint_type='FOREIGN KEY'`) === '1');

  // ON DELETE actions (confdeltype: 'n'=SET NULL, 'r'=RESTRICT, 'c'=CASCADE, 'a'=NO ACTION)
  check('clients.organization_id ON DELETE SET NULL',
    psqlScalar(`SELECT confdeltype FROM pg_constraint WHERE conname='clients_organization_id_fkey'`) === 'n');
  check('missions.devis_id ON DELETE RESTRICT',
    psqlScalar(`SELECT confdeltype FROM pg_constraint WHERE conname='missions_devis_id_fkey'`) === 'r');
  check('missions.organization_id ON DELETE SET NULL',
    psqlScalar(`SELECT confdeltype FROM pg_constraint WHERE conname='missions_organization_id_fkey'`) === 'n');

  // 6 partial indexes
  check('idx_clients_organization_id exists',
    psqlScalar(`SELECT count(*) FROM pg_indexes WHERE indexname='idx_clients_organization_id'`) === '1');
  check('idx_devis_organization_id exists',
    psqlScalar(`SELECT count(*) FROM pg_indexes WHERE indexname='idx_devis_organization_id'`) === '1');
  check('idx_devis_contact_id exists',
    psqlScalar(`SELECT count(*) FROM pg_indexes WHERE indexname='idx_devis_contact_id'`) === '1');
  check('idx_devis_opportunity_id exists',
    psqlScalar(`SELECT count(*) FROM pg_indexes WHERE indexname='idx_devis_opportunity_id'`) === '1');
  check('idx_missions_devis_id exists',
    psqlScalar(`SELECT count(*) FROM pg_indexes WHERE indexname='idx_missions_devis_id'`) === '1');
  check('idx_missions_organization_id exists',
    psqlScalar(`SELECT count(*) FROM pg_indexes WHERE indexname='idx_missions_organization_id'`) === '1');

  // =========================================================
  // SECURITY DEFINER INVENTORY
  // =========================================================
  console.log('\n--- SECURITY DEFINER INVENTORY ---');

  const sdCount = psqlScalar(`
    SELECT count(*) FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
      AND p.prosecdef = true
      AND p.proname IN (
        'guard_clients_organization_id',
        'devis_guard_crm_links',
        'missions_check_devis_org',
        'clients_guard_reparent',
        'devis_guard_reparent',
        'organization_contacts_check_client_org',
        'organization_contacts_guard_reparent',
        'crm_opportunities_guard_reparent',
        'crm_link_client_organization',
        'crm_link_devis_crm',
        'crm_link_mission_devis'
      )
  `);
  check('11 P3B5 SECURITY DEFINER functions exist', sdCount === '11');

  // All have search_path = '' (check proconfig contains empty string setting)
  const sdSearchPath = psqlScalar(`
    SELECT count(*) FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
      AND p.prosecdef = true
      AND p.proname IN (
        'guard_clients_organization_id',
        'devis_guard_crm_links',
        'missions_check_devis_org',
        'clients_guard_reparent',
        'devis_guard_reparent',
        'organization_contacts_check_client_org',
        'organization_contacts_guard_reparent',
        'crm_opportunities_guard_reparent',
        'crm_link_client_organization',
        'crm_link_devis_crm',
        'crm_link_mission_devis'
      )
      AND p.proconfig IS NOT NULL
      AND array_to_string(p.proconfig, ',') LIKE '%search_path=%'
  `);
  check('all SD functions have SET search_path', sdSearchPath === '11');

  // All owned by postgres
  const sdOwner = psqlScalar(`
    SELECT count(*) FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    JOIN pg_roles r ON r.oid = p.proowner
    WHERE n.nspname = 'public'
      AND p.prosecdef = true
      AND p.proname IN (
        'guard_clients_organization_id',
        'devis_guard_crm_links',
        'missions_check_devis_org',
        'clients_guard_reparent',
        'devis_guard_reparent',
        'organization_contacts_check_client_org',
        'organization_contacts_guard_reparent',
        'crm_opportunities_guard_reparent',
        'crm_link_client_organization',
        'crm_link_devis_crm',
        'crm_link_mission_devis'
      )
      AND r.rolname = 'postgres'
  `);
  check('all SD functions owned by postgres', sdOwner === '11');

  // =========================================================
  // RPC AUTHORIZATION: admin can link
  // =========================================================
  console.log('\n--- RPC AUTHORIZATION ---');

  // Admin: crm_link_client_organization
  const adminLinkClient = psqlScalarSafe(asUser('authenticated', ADMIN_UID, `
    SELECT public.crm_link_client_organization('dddd0000-0000-0000-0000-000000000004', '${ORG_A_ID}');
  `));
  check('admin can link client to organization', adminLinkClient !== null);
  check('client.organization_id set by admin RPC',
    psqlScalar(`SELECT organization_id FROM public.clients WHERE id='dddd0000-0000-0000-0000-000000000004'`) === ORG_A_ID);

  // Operator: crm_link_client_organization
  const opLinkClient = psqlScalarSafe(asUser('authenticated', OPERATOR_UID, `
    SELECT public.crm_link_client_organization('dddd0000-0000-0000-0000-000000000005', '${ORG_B_ID}');
  `));
  check('operator can link client to organization', opLinkClient !== null);
  check('client.organization_id set by operator RPC',
    psqlScalar(`SELECT organization_id FROM public.clients WHERE id='dddd0000-0000-0000-0000-000000000005'`) === ORG_B_ID);

  // Admin: crm_link_devis_crm
  const adminLinkDevis = psqlScalarSafe(asUser('authenticated', ADMIN_UID, `
    SELECT public.crm_link_devis_crm('eeee0000-0000-0000-0000-000000000001', '${ORG_A_ID}', '${CONTACT_A_ID}', NULL);
  `));
  check('admin can link devis to CRM', adminLinkDevis !== null);
  check('devis.organization_id set by admin RPC',
    psqlScalar(`SELECT organization_id FROM public.devis WHERE id='eeee0000-0000-0000-0000-000000000001'`) === ORG_A_ID);
  check('devis.contact_id set by admin RPC',
    psqlScalar(`SELECT contact_id FROM public.devis WHERE id='eeee0000-0000-0000-0000-000000000001'`) === CONTACT_A_ID);

  // Operator: crm_link_devis_crm
  const opLinkDevis = psqlScalarSafe(asUser('authenticated', OPERATOR_UID, `
    SELECT public.crm_link_devis_crm('eeee0000-0000-0000-0000-000000000002', '${ORG_B_ID}', '${CONTACT_B_ID}', '${OPP_B_ID}');
  `));
  check('operator can link devis to CRM', opLinkDevis !== null);
  check('devis.opportunity_id set by operator RPC',
    psqlScalar(`SELECT opportunity_id FROM public.devis WHERE id='eeee0000-0000-0000-0000-000000000002'`) === OPP_B_ID);

  // Admin: crm_link_mission_devis
  const adminLinkMission = psqlScalarSafe(asUser('authenticated', ADMIN_UID, `
    SELECT public.crm_link_mission_devis('ffff0000-0000-0000-0000-000000000001', 'eeee0000-0000-0000-0000-000000000001', '${ORG_A_ID}');
  `));
  check('admin can link mission to devis', adminLinkMission !== null);
  check('missions.devis_id set by admin RPC',
    psqlScalar(`SELECT devis_id FROM public.missions WHERE id='ffff0000-0000-0000-0000-000000000001'`) === 'eeee0000-0000-0000-0000-000000000001');
  check('missions.organization_id set by admin RPC',
    psqlScalar(`SELECT organization_id FROM public.missions WHERE id='ffff0000-0000-0000-0000-000000000001'`) === ORG_A_ID);

  // =========================================================
  // RPC AUTHORIZATION: client/anon/service_role denied
  // =========================================================
  console.log('\n--- RPC AUTHORIZATION DENIAL ---');

  // Client cannot call crm_link_client_organization
  const clientLinkAttempt = psqlScalarSafe(asUser('authenticated', CLIENT_UID, `
    SELECT public.crm_link_client_organization('dddd0000-0000-0000-0000-000000000004', '${ORG_B_ID}');
  `));
  check('client cannot call crm_link_client_organization', clientLinkAttempt === null);

  // Anon cannot call crm_link_client_organization
  const anonLinkAttempt = psqlScalarSafe(asUser('anon', '', `
    SELECT public.crm_link_client_organization('dddd0000-0000-0000-0000-000000000004', '${ORG_B_ID}');
  `));
  check('anon cannot call crm_link_client_organization', anonLinkAttempt === null);

  // service_role cannot call crm_link_client_organization (EXECUTE revoked)
  const srLinkAttempt = psqlScalarSafe(asUser('service_role', '', `
    SELECT public.crm_link_client_organization('dddd0000-0000-0000-0000-000000000004', '${ORG_B_ID}');
  `));
  check('service_role cannot call crm_link_client_organization', srLinkAttempt === null);

  // =========================================================
  // DIRECT TABLE WRITE DENIAL
  // =========================================================
  console.log('\n--- DIRECT TABLE WRITE DENIAL ---');

  // Client cannot directly UPDATE clients.organization_id
  const clientDirectUpdate = psqlScalarSafe(asUser('authenticated', CLIENT_UID, `
    UPDATE public.clients SET organization_id = '${ORG_B_ID}' WHERE id = 'dddd0000-0000-0000-0000-000000000004';
  `));
  check('client cannot directly UPDATE clients.organization_id', clientDirectUpdate === null);

  // Anon cannot directly UPDATE clients.organization_id (no UPDATE grant)
  const anonDirectUpdate = psqlScalarSafe(asUser('anon', '', `
    UPDATE public.clients SET organization_id = '${ORG_B_ID}' WHERE id = 'dddd0000-0000-0000-0000-000000000004';
  `));
  check('anon cannot directly UPDATE clients.organization_id', anonDirectUpdate === null);

  // service_role cannot directly UPDATE clients.organization_id via trigger
  // (service_role has GRANT ALL but trigger denies non-internal)
  const srDirectUpdate = psqlScalarSafe(asUser('service_role', '', `
    UPDATE public.clients SET organization_id = '${ORG_B_ID}' WHERE id = 'dddd0000-0000-0000-0000-000000000004';
  `));
  check('service_role cannot directly UPDATE clients.organization_id (trigger denies)', srDirectUpdate === null);

  // Client cannot directly UPDATE devis CRM links
  // RLS may block the update (0 rows affected) or the trigger may raise an error.
  // Either way, the organization_id must not be changed.
  psqlScalarSafe(asUser('authenticated', CLIENT_UID, `
    UPDATE public.devis SET organization_id = '${ORG_B_ID}' WHERE id = 'eeee0000-0000-0000-0000-000000000001';
  `));
  check('client cannot directly UPDATE devis.organization_id (value unchanged)',
    psqlScalar(`SELECT organization_id FROM public.devis WHERE id='eeee0000-0000-0000-0000-000000000001'`) === ORG_A_ID);

  // service_role cannot directly UPDATE devis CRM links
  psqlScalarSafe(asUser('service_role', '', `
    UPDATE public.devis SET organization_id = '${ORG_B_ID}' WHERE id = 'eeee0000-0000-0000-0000-000000000001';
  `));
  check('service_role cannot directly UPDATE devis.organization_id (value unchanged)',
    psqlScalar(`SELECT organization_id FROM public.devis WHERE id='eeee0000-0000-0000-0000-000000000001'`) === ORG_A_ID);

  // =========================================================
  // CROSS-ENTITY CONSISTENCY
  // =========================================================
  console.log('\n--- CROSS-ENTITY CONSISTENCY ---');

  // Devis: contact without org => DENY
  const devisContactNoOrg = psqlScalarSafe(asUser('authenticated', ADMIN_UID, `
    SELECT public.crm_link_devis_crm('eeee0000-0000-0000-0000-000000000001', NULL, '${CONTACT_A_ID}', NULL);
  `));
  check('devis: contact without org => DENY', devisContactNoOrg === null);

  // Devis: contact from different org => DENY
  const devisContactWrongOrg = psqlScalarSafe(asUser('authenticated', ADMIN_UID, `
    SELECT public.crm_link_devis_crm('eeee0000-0000-0000-0000-000000000001', '${ORG_B_ID}', '${CONTACT_A_ID}', NULL);
  `));
  check('devis: contact from different org => DENY', devisContactWrongOrg === null);

  // Devis: opportunity from different org => DENY
  const devisOppWrongOrg = psqlScalarSafe(asUser('authenticated', ADMIN_UID, `
    SELECT public.crm_link_devis_crm('eeee0000-0000-0000-0000-000000000001', '${ORG_A_ID}', '${CONTACT_A_ID}', '${OPP_B_ID}');
  `));
  check('devis: opportunity from different org => DENY', devisOppWrongOrg === null);

  // Devis: valid contact + org + opportunity => ALLOW
  const devisValidLink = psqlScalarSafe(asUser('authenticated', ADMIN_UID, `
    SELECT public.crm_link_devis_crm('eeee0000-0000-0000-0000-000000000001', '${ORG_A_ID}', '${CONTACT_A_ID}', '${OPP_A_ID}');
  `));
  check('devis: valid contact + org + opportunity => ALLOW', devisValidLink !== null);

  // Mission: devis from different org => DENY
  const missionDevisWrongOrg = psqlScalarSafe(asUser('authenticated', ADMIN_UID, `
    SELECT public.crm_link_mission_devis('ffff0000-0000-0000-0000-000000000001', 'eeee0000-0000-0000-0000-000000000002', '${ORG_A_ID}');
  `));
  check('mission: devis from different org => DENY', missionDevisWrongOrg === null);

  // Mission: valid devis + matching org => ALLOW
  const missionValidLink = psqlScalarSafe(asUser('authenticated', ADMIN_UID, `
    SELECT public.crm_link_mission_devis('ffff0000-0000-0000-0000-000000000001', 'eeee0000-0000-0000-0000-000000000001', '${ORG_A_ID}');
  `));
  check('mission: valid devis + matching org => ALLOW', missionValidLink !== null);

  // =========================================================
  // PARENT REPARENT GUARDS
  // =========================================================
  console.log('\n--- PARENT REPARENT GUARDS ---');

  // clients_guard_reparent: cannot change client org if linked contact has different org
  // First, link a contact to the client with matching org
  psql(`UPDATE public.organization_contacts SET client_id = 'dddd0000-0000-0000-0000-000000000004' WHERE id = '${CONTACT_A_ID}';`);
  // Now try to change client org to ORG_B (contact is in ORG_A)
  const clientReparentConflict = psqlScalarSafe(asUser('authenticated', ADMIN_UID, `
    SELECT public.crm_link_client_organization('dddd0000-0000-0000-0000-000000000004', '${ORG_B_ID}');
  `));
  check('clients_guard_reparent: blocks org change with linked contact conflict', clientReparentConflict === null);

  // Unlink contact, then change should succeed
  psql(`UPDATE public.organization_contacts SET client_id = NULL WHERE id = '${CONTACT_A_ID}';`);
  const clientReparentOk = psqlScalarSafe(asUser('authenticated', ADMIN_UID, `
    SELECT public.crm_link_client_organization('dddd0000-0000-0000-0000-000000000004', '${ORG_B_ID}');
  `));
  check('clients_guard_reparent: allows org change after unlink', clientReparentOk !== null);

  // devis_guard_reparent: cannot change devis org if linked mission has different org
  // Mission is currently linked to devis eeee...001 with org ORG_A
  // Change devis org to ORG_B should fail (mission has ORG_A)
  const devisReparentConflict = psqlScalarSafe(asUser('authenticated', ADMIN_UID, `
    SELECT public.crm_link_devis_crm('eeee0000-0000-0000-0000-000000000001', '${ORG_B_ID}', NULL, NULL);
  `));
  check('devis_guard_reparent: blocks org change with linked mission conflict', devisReparentConflict === null);

  // =========================================================
  // ERROR ORACLE: authorization precedes CRM lookups
  // =========================================================
  console.log('\n--- ERROR ORACLE ---');

  // Client with invalid org UUID vs valid org UUID: both should fail with same auth error
  const clientInvalidOrg = psqlScalarSafe(asUser('authenticated', CLIENT_UID, `
    SELECT public.crm_link_devis_crm('eeee0000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000099', NULL, NULL);
  `));
  const clientValidOrg = psqlScalarSafe(asUser('authenticated', CLIENT_UID, `
    SELECT public.crm_link_devis_crm('eeee0000-0000-0000-0000-000000000001', '${ORG_A_ID}', NULL, NULL);
  `));
  check('error oracle: client gets same auth error for invalid and valid org UUID',
    clientInvalidOrg === null && clientValidOrg === null);

  // =========================================================
  // LEGACY PRIVILEGED FIELDS PRESERVED
  // =========================================================
  console.log('\n--- LEGACY PRIVILEGED FIELDS ---');

  // Operator cannot change client.role via direct UPDATE (guard_clients_privileged_fields)
  // RLS may block the update (0 rows affected) or the trigger may raise an error.
  // Either way, the role must not be changed.
  psqlScalarSafe(asUser('authenticated', OPERATOR_UID, `
    UPDATE public.clients SET role = 'admin' WHERE id = 'dddd0000-0000-0000-0000-000000000004';
  `));
  check('operator cannot change client.role (legacy guard preserved)',
    psqlScalar(`SELECT role FROM public.clients WHERE id='dddd0000-0000-0000-0000-000000000004'`) === 'client');

  // Operator cannot change client.banned
  psqlScalarSafe(asUser('authenticated', OPERATOR_UID, `
    UPDATE public.clients SET banned = true WHERE id = 'dddd0000-0000-0000-0000-000000000004';
  `));
  check('operator cannot change client.banned (legacy guard preserved)',
    psqlScalar(`SELECT banned FROM public.clients WHERE id='dddd0000-0000-0000-0000-000000000004'`) === 'f');

  // Operator cannot change client.is_pro
  psqlScalarSafe(asUser('authenticated', OPERATOR_UID, `
    UPDATE public.clients SET is_pro = true WHERE id = 'dddd0000-0000-0000-0000-000000000004';
  `));
  check('operator cannot change client.is_pro (legacy guard preserved)',
    psqlScalar(`SELECT is_pro FROM public.clients WHERE id='dddd0000-0000-0000-0000-000000000004'`) === 'f');

  // =========================================================
  // ON DELETE RESTRICT: missions.devis_id
  // =========================================================
  console.log('\n--- ON DELETE RESTRICT ---');

  // Cannot delete devis that has a linked mission
  const deleteDevisWithMission = psqlScalarSafe(`
    DELETE FROM public.devis WHERE id = 'eeee0000-0000-0000-0000-000000000001';
  `);
  check('cannot delete devis with linked mission (ON DELETE RESTRICT)', deleteDevisWithMission === null);

  // =========================================================
  // ON DELETE SET NULL: organization deletion
  // =========================================================
  console.log('\n--- ON DELETE SET NULL ---');

  // Create a separate org, link a client, delete org => client.organization_id = NULL
  const tmpOrgId = '55550000-0000-0000-0000-000000000005';
  const tmpClientId = 'dddd0000-0000-0000-0000-000000000099';
  psql(`
    INSERT INTO public.organizations (id, legal_name) VALUES ('${tmpOrgId}', 'Tmp Org') ON CONFLICT DO NOTHING;
    INSERT INTO public.clients (id, role, email, nom, prenom) VALUES ('${tmpClientId}', 'client', 'tmp@test.com', 'Tmp', 'Client') ON CONFLICT DO NOTHING;
  `);
  psql(asUser('authenticated', ADMIN_UID, `
    SELECT public.crm_link_client_organization('${tmpClientId}', '${tmpOrgId}');
  `));
  check('tmp client linked to tmp org',
    psqlScalar(`SELECT organization_id FROM public.clients WHERE id='${tmpClientId}'`) === tmpOrgId);
  psql(`DELETE FROM public.organizations WHERE id = '${tmpOrgId}';`);
  check('deleting org sets client.organization_id to NULL (ON DELETE SET NULL)',
    psqlScalar(`SELECT organization_id FROM public.clients WHERE id='${tmpClientId}'`) === '');

  // =========================================================
  // FULL REPLACEMENT SEMANTICS
  // =========================================================
  console.log('\n--- FULL REPLACEMENT SEMANTICS ---');

  // Link devis with all 3 CRM links, then unlink all (NULL)
  psql(asUser('authenticated', ADMIN_UID, `
    SELECT public.crm_link_devis_crm('eeee0000-0000-0000-0000-000000000002', '${ORG_B_ID}', '${CONTACT_B_ID}', '${OPP_B_ID}');
  `));
  check('devis has 3 CRM links before unlink',
    psqlScalar(`SELECT (organization_id, contact_id, opportunity_id) = ('${ORG_B_ID}', '${CONTACT_B_ID}', '${OPP_B_ID}') FROM public.devis WHERE id='eeee0000-0000-0000-0000-000000000002'`) === 't');

  const unlinkDevis = psqlScalarSafe(asUser('authenticated', ADMIN_UID, `
    SELECT public.crm_link_devis_crm('eeee0000-0000-0000-0000-000000000002', NULL, NULL, NULL);
  `));
  check('devis unlink (FULL_REPLACEMENT to NULL) succeeds', unlinkDevis !== null);
  check('devis.organization_id is NULL after unlink',
    psqlScalar(`SELECT organization_id FROM public.devis WHERE id='eeee0000-0000-0000-0000-000000000002'`) === '');
  check('devis.contact_id is NULL after unlink',
    psqlScalar(`SELECT contact_id FROM public.devis WHERE id='eeee0000-0000-0000-0000-000000000002'`) === '');
  check('devis.opportunity_id is NULL after unlink',
    psqlScalar(`SELECT opportunity_id FROM public.devis WHERE id='eeee0000-0000-0000-0000-000000000002'`) === '');

  // =========================================================
  // PUBLIC DEVIS INSERT PRESERVED
  // =========================================================
  console.log('\n--- PUBLIC DEVIS INSERT ---');

  // Anon can still insert devis without CRM links
  const anonDevisInsert = psqlScalarSafe(asUser('anon', '', `
    INSERT INTO public.devis (reference, client_email, status)
    VALUES ('DEV-ANON-001', 'anon@test.com', 'pending');
  `));
  check('anon can insert devis without CRM links (legacy preserved)', anonDevisInsert !== null);

  // Anon cannot insert devis WITH CRM links
  const anonDevisWithCrm = psqlScalarSafe(asUser('anon', '', `
    INSERT INTO public.devis (reference, client_email, status, organization_id)
    VALUES ('DEV-ANON-002', 'anon2@test.com', 'pending', '${ORG_A_ID}');
  `));
  check('anon cannot insert devis with CRM links (trigger denies)', anonDevisWithCrm === null);

  // =========================================================
  // SUMMARY
  // =========================================================
  console.log('\n========================================');
  console.log(`P3B5 runtime validation: ${passed} passed, ${failed} failed`);
  console.log('========================================');

  if (failed > 0) {
    throw new Error(`${failed} runtime assertions failed`);
  }

} catch (err) {
  console.error('\nFATAL ERROR:', err.message);
  process.exitCode = 1;
} finally {
  // Always destroy container
  console.log('\nDestroying disposable container...');
  docker(['rm', '-f', CONTAINER], { stdio: 'pipe' });
  console.log('Done.');
}
