// P3B4 — CRM Activities — Runtime Validation (Disposable PostgreSQL 17)
//
// Spins up a DISPOSABLE postgres:17 container, loads the minimal dependency
// baseline (auth.uid() stub + helpers + clients/user_roles/internal_operators),
// applies P3B1, P3B2, P3B3, then P3B4 migrations in order, and runs runtime
// assertions covering:
//   - schema (tables, FKs, CHECKs, indexes)
//   - cross-entity integrity (contact/org, opportunity/org)
//   - created_by server-derivation (non-forgeable)
//   - RLS (admin/operator/client/convoyeur/anon)
//   - grants (column-level INSERT/UPDATE, protected columns excluded)
//   - service_role privilege hardening
//   - delete policy (admin-only)
//   - updated_at trigger
//
// AUTH_RLS_SIMULATION=YES — uses a session-GUC stub for auth.uid() because a
// plain PostgreSQL container has no Supabase GoTrue/JWT layer.
//
// The container is ALWAYS destroyed after tests (success or failure).

import { spawnSync } from 'node:child_process';
import { writeFileSync, unlinkSync, mkdtempSync, rmSync } from 'node:fs';
import { join, basename } from 'node:path';
import { tmpdir } from 'node:os';

const CONTAINER = 'p3b4_runtime_pg17';
const PGUSER = 'postgres';
const PGDB = 'postgres';
const PGPASSWORD = 'p3b4test';
const PGPORT = '54179';

const MIGRATIONS_DIR = new URL('../supabase/migrations/', import.meta.url).pathname
  .replace(/^\//, '')
  .replace(/\//g, '\\');

const P3B1_FILE = join(MIGRATIONS_DIR, '20260909120000_p3b1_crm_organizations_segments.sql');
const P3B2_FILE = join(MIGRATIONS_DIR, '20260909130000_p3b2_crm_sites_contacts.sql');
const P3B3_FILE = join(MIGRATIONS_DIR, '20260909140000_p3b3_crm_opportunities_pipeline.sql');
const P3B4_FILE = join(MIGRATIONS_DIR, '20260910100000_p3b4_crm_activities.sql');

const ADMIN_UID    = 'aaaaaaaa-0000-0000-0000-000000000001';
const OPERATOR_UID = 'bbbbbbbb-0000-0000-0000-000000000002';
const CLIENT_UID   = 'cccccccc-0000-0000-0000-000000000003';

function docker(args, opts = {}) {
  return spawnSync('docker', args, { encoding: 'utf8', ...opts });
}

function psql(sql, opts = {}) {
  const tmp = join(tmpdir(), `p3b4_${Date.now()}_${Math.random().toString(36).slice(2)}.sql`);
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
  const tmp = join(tmpdir(), `p3b4_q_${Date.now()}_${Math.random().toString(36).slice(2)}.sql`);
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
  const tmp = join(tmpdir(), `p3b4_qs_${Date.now()}_${Math.random().toString(36).slice(2)}.sql`);
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

CREATE TABLE IF NOT EXISTS public.clients (
  id uuid DEFAULT gen_random_uuid() NOT NULL PRIMARY KEY,
  role text DEFAULT 'client',
  auth_user_id uuid
);

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
GRANT USAGE ON SCHEMA public TO authenticated, anon, service_role;
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

INSERT INTO public.clients (id, role, auth_user_id) VALUES
  ('dddd0000-0000-0000-0000-000000000004', 'client', '${CLIENT_UID}')
ON CONFLICT (id) DO NOTHING;
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

console.log('=== P3B4 Runtime Validation (disposable PostgreSQL 17) ===\n');

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
  // Load setup
  console.log('Loading dependency baseline (auth.uid stub + helpers)...');
  let res = psql(SETUP_SQL);
  if (res.status !== 0) { console.error('Setup failed:', res.stderr); throw new Error('setup'); }

  // Apply migrations in order
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

  // Load fixtures
  res = psql(FIXTURE_SQL);
  if (res.status !== 0) { console.error('Fixtures failed:', res.stderr); throw new Error('fixtures'); }

  // Create test organizations + contacts + opportunities (as postgres for setup)
  psql(`
INSERT INTO public.organizations (id, legal_name) VALUES
  ('11110000-0000-0000-0000-000000000001', 'Org A'),
  ('33330000-0000-0000-0000-000000000003', 'Org B')
ON CONFLICT (id) DO NOTHING;

INSERT INTO public.organization_contacts (id, organization_id, first_name, last_name)
VALUES ('22220000-0000-0000-0000-000000000002', '11110000-0000-0000-0000-000000000001', 'Alice', 'Dupont')
ON CONFLICT (id) DO NOTHING;

INSERT INTO public.organization_contacts (id, organization_id, first_name, last_name)
VALUES ('44440000-0000-0000-0000-000000000004', '33330000-0000-0000-0000-000000000003', 'Bob', 'Martin')
ON CONFLICT (id) DO NOTHING;

INSERT INTO public.crm_opportunities (id, title, organization_id)
VALUES ('66660000-0000-0000-0000-000000000006', 'Org A deal', '11110000-0000-0000-0000-000000000001')
ON CONFLICT (id) DO NOTHING;

INSERT INTO public.crm_opportunities (id, title, organization_id)
VALUES ('77770000-0000-0000-0000-000000000007', 'Org B deal', '33330000-0000-0000-0000-000000000003')
ON CONFLICT (id) DO NOTHING;
  `);

  // =========================================================
  // SCHEMA ASSERTIONS
  // =========================================================
  console.log('\n--- SCHEMA ASSERTIONS ---');

  check('crm_activities table exists',
    psqlScalar(`SELECT count(*) FROM information_schema.tables WHERE table_schema='public' AND table_name='crm_activities'`) === '1');

  check('crm_activities.id is uuid',
    psqlScalar(`SELECT data_type FROM information_schema.columns WHERE table_schema='public' AND table_name='crm_activities' AND column_name='id'`) === 'uuid');

  check('RLS enabled on crm_activities',
    psqlScalar(`SELECT relrowsecurity FROM pg_class WHERE relname='crm_activities'`) === 't');

  check('index crm_activities_organization_id exists',
    psqlScalar(`SELECT count(*) FROM pg_indexes WHERE indexname='crm_activities_organization_id'`) === '1');
  check('index crm_activities_contact_id exists',
    psqlScalar(`SELECT count(*) FROM pg_indexes WHERE indexname='crm_activities_contact_id'`) === '1');
  check('index crm_activities_opportunity_id exists',
    psqlScalar(`SELECT count(*) FROM pg_indexes WHERE indexname='crm_activities_opportunity_id'`) === '1');
  check('index crm_activities_pending_due_at exists',
    psqlScalar(`SELECT count(*) FROM pg_indexes WHERE indexname='crm_activities_pending_due_at'`) === '1');

  // =========================================================
  // CREATE ACTIVITY — AUTHORIZATION
  // =========================================================
  console.log('\n--- CREATE ACTIVITY — AUTHORIZATION ---');

  // Admin create activity -> PASS
  {
    const r = psql(asUser('authenticated', ADMIN_UID, `
INSERT INTO public.crm_activities (activity_type, subject, body)
VALUES ('call', 'Admin call', 'Discussion with client');
    `));
    check('admin create activity PASS', r.status === 0);
  }

  // Operator create activity -> PASS
  {
    const r = psql(asUser('authenticated', OPERATOR_UID, `
INSERT INTO public.crm_activities (activity_type, subject, body)
VALUES ('email', 'Operator email', 'Follow-up email');
    `));
    check('operator create activity PASS', r.status === 0);
  }

  // Client create activity -> DENIED
  {
    const r = psql(asUser('authenticated', CLIENT_UID, `
INSERT INTO public.crm_activities (activity_type, subject)
VALUES ('note', 'Client attempt');
    `));
    check('client create activity DENIED', r.status !== 0);
  }

  // Anon create activity -> DENIED
  {
    const r = psql(asUser('anon', null, `
INSERT INTO public.crm_activities (activity_type, subject)
VALUES ('note', 'Anon attempt');
    `));
    check('anon create activity DENIED', r.status !== 0);
  }

  // =========================================================
  // CREATED_BY SERVER-DERIVED
  // =========================================================
  console.log('\n--- CREATED_BY SERVER-DERIVED ---');

  // created_by server-derived (admin)
  check('created_by server-derived (admin)',
    psqlScalar(`SELECT count(*) FROM public.crm_activities WHERE subject='Admin call' AND created_by='${ADMIN_UID}'`) === '1');

  // created_by server-derived (operator)
  check('created_by server-derived (operator)',
    psqlScalar(`SELECT count(*) FROM public.crm_activities WHERE subject='Operator email' AND created_by='${OPERATOR_UID}'`) === '1');

  // created_by forge attempt -> DENIED (column privilege)
  {
    const r = psql(asUser('authenticated', OPERATOR_UID, `
INSERT INTO public.crm_activities (activity_type, subject, created_by)
VALUES ('note', 'Forge attempt', 'ffffffff-0000-0000-0000-0000000000ff');
    `));
    check('created_by forge attempt DENIED', r.status !== 0);
  }

  // created_by direct UPDATE -> DENIED (column privilege)
  {
    const r = psql(asUser('authenticated', OPERATOR_UID, `
UPDATE public.crm_activities SET created_by='${OPERATOR_UID}' WHERE subject='Admin call';
    `));
    check('created_by direct UPDATE DENIED', r.status !== 0);
  }

  // =========================================================
  // CROSS-ENTITY INTEGRITY
  // =========================================================
  console.log('\n--- CROSS-ENTITY INTEGRITY ---');

  // Valid org/contact -> PASS
  {
    const r = psql(asUser('authenticated', ADMIN_UID, `
INSERT INTO public.crm_activities (activity_type, subject, organization_id, contact_id)
VALUES ('meeting', 'Meeting with Alice', '11110000-0000-0000-0000-000000000001', '22220000-0000-0000-0000-000000000002');
    `));
    check('valid org/contact PASS', r.status === 0);
  }

  // Cross-org contact -> DENIED
  {
    const r = psql(asUser('authenticated', ADMIN_UID, `
INSERT INTO public.crm_activities (activity_type, subject, organization_id, contact_id)
VALUES ('meeting', 'Bad contact', '11110000-0000-0000-0000-000000000001', '44440000-0000-0000-0000-000000000004');
    `));
    check('cross-org contact DENIED', r.status !== 0);
  }

  // Contact without org -> DENIED
  {
    const r = psql(asUser('authenticated', ADMIN_UID, `
INSERT INTO public.crm_activities (activity_type, subject, contact_id)
VALUES ('call', 'Contact no org', '22220000-0000-0000-0000-000000000002');
    `));
    check('contact without org DENIED', r.status !== 0);
  }

  // Valid opportunity/org -> PASS
  {
    const r = psql(asUser('authenticated', ADMIN_UID, `
INSERT INTO public.crm_activities (activity_type, subject, organization_id, opportunity_id)
VALUES ('note', 'Note on Org A deal', '11110000-0000-0000-0000-000000000001', '66660000-0000-0000-0000-000000000006');
    `));
    check('valid opportunity/org PASS', r.status === 0);
  }

  // Cross-org opportunity -> DENIED
  {
    const r = psql(asUser('authenticated', ADMIN_UID, `
INSERT INTO public.crm_activities (activity_type, subject, organization_id, opportunity_id)
VALUES ('note', 'Bad opp', '11110000-0000-0000-0000-000000000001', '77770000-0000-0000-0000-000000000007');
    `));
    check('cross-org opportunity DENIED', r.status !== 0);
  }

  // Opportunity with org but activity has no org -> DENIED
  {
    const r = psql(asUser('authenticated', ADMIN_UID, `
INSERT INTO public.crm_activities (activity_type, subject, opportunity_id)
VALUES ('note', 'Opp no org', '66660000-0000-0000-0000-000000000006');
    `));
    check('opportunity org without activity org DENIED', r.status !== 0);
  }

  // Note without org/contact/opportunity -> PASS
  {
    const r = psql(asUser('authenticated', ADMIN_UID, `
INSERT INTO public.crm_activities (activity_type, subject, body)
VALUES ('note', 'Standalone note', 'Just a note');
    `));
    check('note without org/contact/opportunity PASS', r.status === 0);
  }

  // =========================================================
  // TASK SEMANTICS
  // =========================================================
  console.log('\n--- TASK SEMANTICS ---');

  // Task pending + due_at -> PASS
  {
    const r = psql(asUser('authenticated', OPERATOR_UID, `
INSERT INTO public.crm_activities (activity_type, subject, status, due_at, assigned_to)
VALUES ('task', 'Follow up with Alice', 'pending', '2026-12-31T23:59:59Z', '${OPERATOR_UID}');
    `));
    check('task pending + due_at PASS', r.status === 0);
  }

  // =========================================================
  // FIELD UPDATE
  // =========================================================
  console.log('\n--- FIELD UPDATE ---');

  // Normal field update -> PASS
  {
    const r = psql(asUser('authenticated', OPERATOR_UID, `
UPDATE public.crm_activities SET status='completed', completed_at=now()
WHERE subject='Follow up with Alice';
    `));
    check('normal field update PASS', r.status === 0);
  }

  // updated_at changes automatically
  {
    const beforeUpdate = psqlScalar(`SELECT updated_at FROM public.crm_activities WHERE subject='Follow up with Alice'`);
    psql(asUser('authenticated', OPERATOR_UID, `
UPDATE public.crm_activities SET body='Updated body' WHERE subject='Follow up with Alice';
    `));
    const afterUpdate = psqlScalar(`SELECT updated_at FROM public.crm_activities WHERE subject='Follow up with Alice'`);
    check('updated_at advanced on update', beforeUpdate !== afterUpdate);
  }

  // =========================================================
  // DELETE POLICY
  // =========================================================
  console.log('\n--- DELETE POLICY ---');

  // Create a fresh row for the operator delete test (as admin).
  psql(asUser('authenticated', ADMIN_UID, `
INSERT INTO public.crm_activities (activity_type, subject, body)
VALUES ('note', 'Delete test row', 'For operator delete test');
  `));

  // Operator delete -> DENIED (RLS policy filters, row survives)
  {
    const r = psql(asUser('authenticated', OPERATOR_UID, `
DELETE FROM public.crm_activities WHERE subject='Delete test row';
    `));
    const stillExists = psqlScalar(`SELECT count(*) FROM public.crm_activities WHERE subject='Delete test row'`) === '1';
    check('operator delete DENIED (row survives)', r.status === 0 && stillExists);
  }

  // Admin delete -> PASS
  {
    const r = psql(asUser('authenticated', ADMIN_UID, `
DELETE FROM public.crm_activities WHERE subject='Delete test row';
    `));
    const gone = psqlScalar(`SELECT count(*) FROM public.crm_activities WHERE subject='Delete test row'`) === '0';
    check('admin delete PASS', r.status === 0 && gone);
  }

  // =========================================================
  // RLS: READ ACCESS
  // =========================================================
  console.log('\n--- RLS: READ ACCESS ---');

  // Operator can SELECT
  check('operator can SELECT crm_activities',
    psqlScalar(asUser('authenticated', OPERATOR_UID, `SELECT count(*) FROM public.crm_activities;`)) !== '');

  // Client cannot SELECT (RLS filters to 0 rows or errors)
  {
    const res = psql(asUser('authenticated', CLIENT_UID, `SELECT count(*) FROM public.crm_activities;`));
    const clientCount = psqlScalarSafe(asUser('authenticated', CLIENT_UID, `SELECT count(*) FROM public.crm_activities;`));
    check('client cannot SELECT crm_activities', res.status !== 0 || clientCount === '0');
  }

  // Anon cannot SELECT
  {
    const r = psql(asUser('anon', null, `SELECT count(*) FROM public.crm_activities;`));
    check('anon cannot SELECT crm_activities', r.status !== 0);
  }

  // =========================================================
  // CONSTRAINT VALIDATION
  // =========================================================
  console.log('\n--- CONSTRAINT VALIDATION ---');

  // Invalid activity_type -> DENIED
  {
    const r = psql(`
INSERT INTO public.crm_activities (activity_type, subject) VALUES ('invalid_type', 'Bad type');
    `);
    check('invalid activity_type DENIED', r.status !== 0);
  }

  // Invalid direction -> DENIED
  {
    const r = psql(`
INSERT INTO public.crm_activities (activity_type, subject, direction) VALUES ('call', 'Bad dir', 'invalid');
    `);
    check('invalid direction DENIED', r.status !== 0);
  }

  // Invalid status -> DENIED
  {
    const r = psql(`
INSERT INTO public.crm_activities (activity_type, subject, status) VALUES ('note', 'Bad status', 'invalid');
    `);
    check('invalid status DENIED', r.status !== 0);
  }

  // Empty subject -> DENIED
  {
    const r = psql(`
INSERT INTO public.crm_activities (activity_type, subject) VALUES ('note', '   ');
    `);
    check('empty subject DENIED', r.status !== 0);
  }

  // =========================================================
  // SERVICE_ROLE PRIVILEGE TESTS
  // =========================================================
  console.log('\n--- SERVICE_ROLE PRIVILEGE TESTS ---');

  // service_role SELECT -> PASS
  {
    const r = psql(asUser('service_role', null, `SELECT count(*) FROM public.crm_activities;`));
    check('service_role SELECT PASS', r.status === 0);
  }

  // service_role normal INSERT -> DENIED (P3B4A: INSERT grant removed entirely)
  {
    const r = psql(asUser('service_role', null, `
INSERT INTO public.crm_activities (activity_type, subject, body)
VALUES ('note', 'SR note', 'Service role created');
    `));
    check('service_role INSERT DENIED (no INSERT privilege)', r.status !== 0);
  }

  // service_role INSERT created_by -> DENIED
  {
    const r = psql(asUser('service_role', null, `
INSERT INTO public.crm_activities (activity_type, subject, created_by)
VALUES ('note', 'SR forge', 'ffffffff-0000-0000-0000-0000000000ff');
    `));
    check('service_role INSERT created_by DENIED', r.status !== 0);
  }

  // service_role UPDATE created_by -> DENIED
  {
    const r = psql(asUser('service_role', null, `
UPDATE public.crm_activities SET created_by='${ADMIN_UID}' WHERE subject='SR note';
    `));
    check('service_role UPDATE created_by DENIED', r.status !== 0);
  }

  // =========================================================
  // PRIVILEGE CATALOG CHECKS
  // =========================================================
  console.log('\n--- PRIVILEGE CATALOG CHECKS ---');

  // authenticated has no INSERT on created_by
  check('authenticated has NO INSERT on created_by (catalog)',
    psqlScalar(`SELECT count(*) FROM information_schema.column_privileges WHERE table_schema='public' AND table_name='crm_activities' AND column_name='created_by' AND grantee='authenticated' AND privilege_type='INSERT'`) === '0');

  // authenticated has no UPDATE on created_by
  check('authenticated has NO UPDATE on created_by (catalog)',
    psqlScalar(`SELECT count(*) FROM information_schema.column_privileges WHERE table_schema='public' AND table_name='crm_activities' AND column_name='created_by' AND grantee='authenticated' AND privilege_type='UPDATE'`) === '0');

  // service_role has no INSERT on created_by
  check('service_role has NO INSERT on created_by (catalog)',
    psqlScalar(`SELECT count(*) FROM information_schema.column_privileges WHERE table_schema='public' AND table_name='crm_activities' AND column_name='created_by' AND grantee='service_role' AND privilege_type='INSERT'`) === '0');

  // service_role has no UPDATE on created_by
  check('service_role has NO UPDATE on created_by (catalog)',
    psqlScalar(`SELECT count(*) FROM information_schema.column_privileges WHERE table_schema='public' AND table_name='crm_activities' AND column_name='created_by' AND grantee='service_role' AND privilege_type='UPDATE'`) === '0');

  // No table-wide INSERT for authenticated
  check('authenticated has NO table-wide INSERT (catalog)',
    psqlScalar(`SELECT count(*) FROM information_schema.table_privileges WHERE table_schema='public' AND table_name='crm_activities' AND grantee='authenticated' AND privilege_type='INSERT'`) === '0');

  // No table-wide UPDATE for authenticated
  check('authenticated has NO table-wide UPDATE (catalog)',
    psqlScalar(`SELECT count(*) FROM information_schema.table_privileges WHERE table_schema='public' AND table_name='crm_activities' AND grantee='authenticated' AND privilege_type='UPDATE'`) === '0');

  // No GRANT ALL to service_role
  check('service_role has NO table-wide INSERT (catalog)',
    psqlScalar(`SELECT count(*) FROM information_schema.table_privileges WHERE table_schema='public' AND table_name='crm_activities' AND grantee='service_role' AND privilege_type='INSERT'`) === '0');

  // =========================================================
  // SECURITY DEFINER AUDIT
  // =========================================================
  console.log('\n--- SECURITY DEFINER AUDIT ---');

  // P3B4B: 4 SECURITY DEFINER functions (2 original + 2 parent guards)
  const sdCount = psqlScalar(`
SELECT count(*) FROM pg_proc p
JOIN pg_namespace n ON p.pronamespace = n.oid
WHERE n.nspname = 'public'
  AND p.proname IN ('crm_activities_check_cross_entity', 'crm_activities_set_created_by', 'organization_contacts_guard_reparent', 'crm_opportunities_guard_reparent')
  AND p.prosecdef = true
`);
  check('exactly 4 SECURITY DEFINER functions from P3B4', sdCount === '4');

  // All have search_path = ''
  const sdFunctions = ['crm_activities_check_cross_entity', 'crm_activities_set_created_by', 'organization_contacts_guard_reparent', 'crm_opportunities_guard_reparent'];
  for (const fn of sdFunctions) {
    const sp = psqlScalar(`
SELECT (config).setting FROM pg_proc p
JOIN pg_namespace n ON p.pronamespace = n.oid
CROSS JOIN LATERAL unnest(p.proconfig) AS config
WHERE n.nspname = 'public' AND p.proname = '${fn}'
`);
    check(`${fn} has search_path = ''`, sp === '');
  }

  // Trigger function EXECUTE revoked from authenticated
  for (const fn of sdFunctions) {
    const execCount = psqlScalar(`
SELECT count(*) FROM information_schema.role_routine_grants
WHERE routine_schema = 'public' AND routine_name = '${fn}'
  AND grantee = 'authenticated' AND privilege_type = 'EXECUTE'
`);
    check(`${fn} EXECUTE revoked from authenticated`, execCount === '0');
  }

  // =========================================================
  // ASSIGNEE MATRIX (P3B4A)
  // =========================================================
  console.log('\n--- ASSIGNEE MATRIX (P3B4A) ---');

  // Create an inactive operator for testing
  psql(`
INSERT INTO auth.users (id) VALUES ('eeee0000-0000-0000-0000-000000000005')
ON CONFLICT (id) DO NOTHING;
INSERT INTO public.user_roles (user_id, role) VALUES ('eeee0000-0000-0000-0000-000000000005', 'operator')
ON CONFLICT DO NOTHING;
INSERT INTO public.internal_operators (user_id, display_name, active) VALUES ('eeee0000-0000-0000-0000-000000000005', 'Inactive Op', false)
ON CONFLICT (user_id) DO NOTHING;
  `);

  // P3B4B: Create a legacy admin (clients.role='admin', no user_roles entry)
  const LEGACY_ADMIN_UID = 'aaaa00ff-0000-0000-0000-0000000000ff';
  psql(`
INSERT INTO auth.users (id) VALUES ('${LEGACY_ADMIN_UID}')
ON CONFLICT (id) DO NOTHING;
INSERT INTO public.clients (id, role, auth_user_id) VALUES ('dddd00ff-0000-0000-0000-0000000000ff', 'admin', '${LEGACY_ADMIN_UID}')
ON CONFLICT (id) DO NOTHING;
  `);

  // assigned_to=NULL -> PASS
  {
    const r = psql(asUser('authenticated', ADMIN_UID, `
INSERT INTO public.crm_activities (activity_type, subject)
VALUES ('note', 'No assignee test');
    `));
    check('assigned_to=NULL PASS', r.status === 0);
  }

  // assigned_to=admin -> PASS
  {
    const r = psql(asUser('authenticated', ADMIN_UID, `
INSERT INTO public.crm_activities (activity_type, subject, assigned_to)
VALUES ('task', 'Admin assignee', '${ADMIN_UID}');
    `));
    check('assigned_to=admin PASS', r.status === 0);
  }

  // assigned_to=active operator -> PASS
  {
    const r = psql(asUser('authenticated', ADMIN_UID, `
INSERT INTO public.crm_activities (activity_type, subject, assigned_to)
VALUES ('task', 'Operator assignee', '${OPERATOR_UID}');
    `));
    check('assigned_to=active operator PASS', r.status === 0);
  }

  // assigned_to=client -> DENIED
  {
    const r = psql(asUser('authenticated', ADMIN_UID, `
INSERT INTO public.crm_activities (activity_type, subject, assigned_to)
VALUES ('task', 'Client assignee', '${CLIENT_UID}');
    `));
    check('assigned_to=client DENIED', r.status !== 0);
  }

  // assigned_to=inactive operator -> DENIED
  {
    const r = psql(asUser('authenticated', ADMIN_UID, `
INSERT INTO public.crm_activities (activity_type, subject, assigned_to)
VALUES ('task', 'Inactive op assignee', 'eeee0000-0000-0000-0000-000000000005');
    `));
    check('assigned_to=inactive operator DENIED', r.status !== 0);
  }

  // assigned_to=unknown UUID -> DENIED (FK violation)
  {
    const r = psql(asUser('authenticated', ADMIN_UID, `
INSERT INTO public.crm_activities (activity_type, subject, assigned_to)
VALUES ('task', 'Unknown assignee', 'ffff0000-0000-0000-0000-0000000000ff');
    `));
    check('assigned_to=unknown UUID DENIED (FK)', r.status !== 0);
  }

  // P3B4B: assigned_to=legacy admin (clients.role='admin') -> PASS
  {
    const r = psql(asUser('authenticated', ADMIN_UID, `
INSERT INTO public.crm_activities (activity_type, subject, assigned_to)
VALUES ('task', 'Legacy admin assignee', '${LEGACY_ADMIN_UID}');
    `));
    check('assigned_to=legacy admin PASS (clients.role=admin)', r.status === 0);
  }

  // =========================================================
  // NULL ORG OPPORTUNITY POLICY (P3B4A)
  // =========================================================
  console.log('\n--- NULL ORG OPPORTUNITY POLICY (P3B4A) ---');

  // Create an opportunity with NULL organization
  psql(`
INSERT INTO public.crm_opportunities (id, title)
VALUES ('88880000-0000-0000-0000-000000000008', 'No-org opportunity')
ON CONFLICT (id) DO NOTHING;
  `);

  // opp.org=NULL, activity.org=NULL -> ALLOW
  {
    const r = psql(asUser('authenticated', ADMIN_UID, `
INSERT INTO public.crm_activities (activity_type, subject, opportunity_id)
VALUES ('note', 'Null opp null org', '88880000-0000-0000-0000-000000000008');
    `));
    check('opp.org=NULL, activity.org=NULL ALLOW', r.status === 0);
  }

  // opp.org=NULL, activity.org=A -> ALLOW (opp doesn't constrain)
  {
    const r = psql(asUser('authenticated', ADMIN_UID, `
INSERT INTO public.crm_activities (activity_type, subject, organization_id, opportunity_id)
VALUES ('note', 'Null opp with org A', '11110000-0000-0000-0000-000000000001', '88880000-0000-0000-0000-000000000008');
    `));
    check('opp.org=NULL, activity.org=A ALLOW', r.status === 0);
  }

  // opp.org=NULL, activity.org=A, contact=contact(A) -> ALLOW
  {
    const r = psql(asUser('authenticated', ADMIN_UID, `
INSERT INTO public.crm_activities (activity_type, subject, organization_id, contact_id, opportunity_id)
VALUES ('meeting', 'Null opp with org A and contact', '11110000-0000-0000-0000-000000000001', '22220000-0000-0000-0000-000000000002', '88880000-0000-0000-0000-000000000008');
    `));
    check('opp.org=NULL, activity.org=A, contact(A) ALLOW', r.status === 0);
  }

  // =========================================================
  // CONTACT REPARENTING MATRIX (P3B4B)
  // =========================================================
  console.log('\n--- CONTACT REPARENTING MATRIX (P3B4B) ---');

  // Setup: dedicated contacts/orgs for reparent tests (avoid fixture collisions)
  psql(`
INSERT INTO public.organizations (id, legal_name) VALUES
  ('aaa10000-0000-0000-0000-0000000000a1', 'Reparent Org A1'),
  ('aaa10000-0000-0000-0000-0000000000a2', 'Reparent Org A2'),
  ('aaa10000-0000-0000-0000-0000000000b1', 'Reparent Org B1'),
  ('aaa10000-0000-0000-0000-0000000000b2', 'Reparent Org B2')
ON CONFLICT (id) DO NOTHING;

INSERT INTO public.organization_contacts (id, organization_id, first_name, last_name) VALUES
  ('ccc10000-0000-0000-0000-0000000000c1', 'aaa10000-0000-0000-0000-0000000000a1', 'Reparent', 'C1'),
  ('ccc10000-0000-0000-0000-0000000000c2', 'aaa10000-0000-0000-0000-0000000000a2', 'Reparent', 'C2'),
  ('ccc10000-0000-0000-0000-0000000000c3', 'aaa10000-0000-0000-0000-0000000000b1', 'Reparent', 'C3'),
  ('ccc10000-0000-0000-0000-0000000000c4', 'aaa10000-0000-0000-0000-0000000000b2', 'Reparent', 'C4')
ON CONFLICT (id) DO NOTHING;
  `);

  // Contact with no dependencies: A -> B ALLOW
  {
    const r = psqlScalarSafe(`
UPDATE public.organization_contacts SET organization_id = 'aaa10000-0000-0000-0000-0000000000b1'
WHERE id = 'ccc10000-0000-0000-0000-0000000000c1'
RETURNING organization_id;
`);
    check('contact no deps: A->B ALLOW', r !== null);
    // Revert for clean state
    psql(`UPDATE public.organization_contacts SET organization_id = 'aaa10000-0000-0000-0000-0000000000a1' WHERE id = 'ccc10000-0000-0000-0000-0000000000c1';`);
  }

  // Contact referenced by opportunity: A -> B DENY
  psql(`
INSERT INTO public.crm_opportunities (id, title, organization_id, contact_id)
VALUES ('0aa10000-0000-0000-0000-0000000000d2', 'Reparent opp C2', 'aaa10000-0000-0000-0000-0000000000a2', 'ccc10000-0000-0000-0000-0000000000c2')
ON CONFLICT (id) DO NOTHING;
  `);
  {
    const r = psqlScalarSafe(`
UPDATE public.organization_contacts SET organization_id = 'aaa10000-0000-0000-0000-0000000000b1'
WHERE id = 'ccc10000-0000-0000-0000-0000000000c2'
RETURNING organization_id;
`);
    check('contact referenced by opportunity: A->B DENY', r === null);
    // Verify original org preserved
    const orgAfter = psqlScalar(`SELECT organization_id FROM public.organization_contacts WHERE id = 'ccc10000-0000-0000-0000-0000000000c2';`);
    check('contact referenced by opportunity: original org preserved', orgAfter === 'aaa10000-0000-0000-0000-0000000000a2');
  }

  // Contact referenced by activity: A -> B DENY
  psql(asUser('authenticated', ADMIN_UID, `
INSERT INTO public.crm_activities (activity_type, subject, organization_id, contact_id)
VALUES ('call', 'Reparent activity C3', 'aaa10000-0000-0000-0000-0000000000b1', 'ccc10000-0000-0000-0000-0000000000c3');
  `));
  {
    const r = psqlScalarSafe(`
UPDATE public.organization_contacts SET organization_id = 'aaa10000-0000-0000-0000-0000000000a1'
WHERE id = 'ccc10000-0000-0000-0000-0000000000c3'
RETURNING organization_id;
`);
    check('contact referenced by activity: A->B DENY', r === null);
    const orgAfter = psqlScalar(`SELECT organization_id FROM public.organization_contacts WHERE id = 'ccc10000-0000-0000-0000-0000000000c3';`);
    check('contact referenced by activity: original org preserved', orgAfter === 'aaa10000-0000-0000-0000-0000000000b1');
  }

  // Contact referenced by both opportunity and activity: A -> B DENY
  psql(`
INSERT INTO public.crm_opportunities (id, title, organization_id, contact_id)
VALUES ('0aa10000-0000-0000-0000-0000000000d4', 'Reparent opp C4', 'aaa10000-0000-0000-0000-0000000000b2', 'ccc10000-0000-0000-0000-0000000000c4')
ON CONFLICT (id) DO NOTHING;
  `);
  psql(asUser('authenticated', ADMIN_UID, `
INSERT INTO public.crm_activities (activity_type, subject, organization_id, contact_id)
VALUES ('call', 'Reparent activity C4', 'aaa10000-0000-0000-0000-0000000000b2', 'ccc10000-0000-0000-0000-0000000000c4');
  `));
  {
    const r = psqlScalarSafe(`
UPDATE public.organization_contacts SET organization_id = 'aaa10000-0000-0000-0000-0000000000a1'
WHERE id = 'ccc10000-0000-0000-0000-0000000000c4'
RETURNING organization_id;
`);
    check('contact referenced by both: A->B DENY', r === null);
    const orgAfter = psqlScalar(`SELECT organization_id FROM public.organization_contacts WHERE id = 'ccc10000-0000-0000-0000-0000000000c4';`);
    check('contact referenced by both: original org preserved', orgAfter === 'aaa10000-0000-0000-0000-0000000000b2');
    // Verify no dependent row mutated
    const oppOrgAfter = psqlScalar(`SELECT organization_id FROM public.crm_opportunities WHERE id = '0aa10000-0000-0000-0000-0000000000d4';`);
    check('contact referenced by both: opportunity org not mutated', oppOrgAfter === 'aaa10000-0000-0000-0000-0000000000b2');
  }

  // Safe no-op update (same org) ALLOW
  {
    const r = psqlScalarSafe(`
UPDATE public.organization_contacts SET organization_id = 'aaa10000-0000-0000-0000-0000000000a1'
WHERE id = 'ccc10000-0000-0000-0000-0000000000c1'
RETURNING organization_id;
`);
    check('contact no-op update (same org) ALLOW', r !== null);
  }

  // =========================================================
  // OPPORTUNITY REPARENTING MATRIX (P3B4B)
  // =========================================================
  console.log('\n--- OPPORTUNITY REPARENTING MATRIX (P3B4B) ---');

  // Setup: dedicated opportunities for reparent tests
  const oppSetupRes = psql(`
INSERT INTO public.organizations (id, legal_name) VALUES
  ('0aa10000-0000-0000-0000-0000000000a1', 'Opp Reparent Org A1'),
  ('0aa10000-0000-0000-0000-0000000000b1', 'Opp Reparent Org B1')
ON CONFLICT (id) DO NOTHING;

INSERT INTO public.crm_opportunities (id, title, organization_id) VALUES
  ('0aa10000-0000-0000-0000-0000000000e1', 'Opp no deps', '0aa10000-0000-0000-0000-0000000000a1'),
  ('0aa10000-0000-0000-0000-0000000000e2', 'Opp with contact', '0aa10000-0000-0000-0000-0000000000a1'),
  ('0aa10000-0000-0000-0000-0000000000e3', 'Opp with activity', '0aa10000-0000-0000-0000-0000000000a1'),
  ('0aa10000-0000-0000-0000-0000000000e4', 'Opp NULL->A', NULL),
  ('0aa10000-0000-0000-0000-0000000000e5', 'Opp NULL->B', NULL)
ON CONFLICT (id) DO NOTHING;

INSERT INTO public.organization_contacts (id, organization_id, first_name, last_name)
VALUES ('0aa10000-0000-0000-0000-0000000000c2', '0aa10000-0000-0000-0000-0000000000a1', 'Opp', 'Contact')
ON CONFLICT (id) DO NOTHING;

UPDATE public.crm_opportunities SET contact_id = '0aa10000-0000-0000-0000-0000000000c2' WHERE id = '0aa10000-0000-0000-0000-0000000000e2';
  `);
  check('opportunity reparent setup succeeded', oppSetupRes.status === 0);
  if (oppSetupRes.status !== 0) {
    console.log('  SETUP ERROR:', oppSetupRes.stderr);
  }

  // Opp with no contact and no activities: A -> B ALLOW
  {
    const r = psqlScalarSafe(`
UPDATE public.crm_opportunities SET organization_id = '0aa10000-0000-0000-0000-0000000000b1'
WHERE id = '0aa10000-0000-0000-0000-0000000000e1'
RETURNING organization_id;
`);
    check('opportunity no deps: A->B ALLOW', r !== null);
    psql(`UPDATE public.crm_opportunities SET organization_id = '0aa10000-0000-0000-0000-0000000000a1' WHERE id = '0aa10000-0000-0000-0000-0000000000e1';`);
  }

  // Opp with contact(A): A -> B DENY (P3B3 contact/org integrity)
  {
    const r = psqlScalarSafe(`
UPDATE public.crm_opportunities SET organization_id = '0aa10000-0000-0000-0000-0000000000b1'
WHERE id = '0aa10000-0000-0000-0000-0000000000e2'
RETURNING organization_id;
`);
    check('opportunity with contact: A->B DENY', r === null);
    const orgAfter = psqlScalar(`SELECT organization_id FROM public.crm_opportunities WHERE id = '0aa10000-0000-0000-0000-0000000000e2';`);
    check('opportunity with contact: original org preserved', orgAfter === '0aa10000-0000-0000-0000-0000000000a1');
  }

  // Opp org A + activity org A: A -> B DENY
  psql(asUser('authenticated', ADMIN_UID, `
INSERT INTO public.crm_activities (activity_type, subject, organization_id, opportunity_id)
VALUES ('note', 'Reparent activity E3', '0aa10000-0000-0000-0000-0000000000a1', '0aa10000-0000-0000-0000-0000000000e3');
  `));
  {
    const r = psqlScalarSafe(`
UPDATE public.crm_opportunities SET organization_id = '0aa10000-0000-0000-0000-0000000000b1'
WHERE id = '0aa10000-0000-0000-0000-0000000000e3'
RETURNING organization_id;
`);
    check('opportunity with activity org A: A->B DENY', r === null);
    const orgAfter = psqlScalar(`SELECT organization_id FROM public.crm_opportunities WHERE id = '0aa10000-0000-0000-0000-0000000000e3';`);
    check('opportunity with activity: original org preserved', orgAfter === '0aa10000-0000-0000-0000-0000000000a1');
  }

  // Opp org NULL + activity org A: NULL -> A ALLOW
  psql(asUser('authenticated', ADMIN_UID, `
INSERT INTO public.crm_activities (activity_type, subject, organization_id, opportunity_id)
VALUES ('note', 'Reparent activity E4', '0aa10000-0000-0000-0000-0000000000a1', '0aa10000-0000-0000-0000-0000000000e4');
  `));
  {
    const r = psqlScalarSafe(`
UPDATE public.crm_opportunities SET organization_id = '0aa10000-0000-0000-0000-0000000000a1'
WHERE id = '0aa10000-0000-0000-0000-0000000000e4'
RETURNING organization_id;
`);
    check('opportunity NULL->A with activity org A: ALLOW', r !== null);
  }

  // Opp org NULL + activity org B: NULL -> A DENY
  psql(asUser('authenticated', ADMIN_UID, `
INSERT INTO public.crm_activities (activity_type, subject, organization_id, opportunity_id)
VALUES ('note', 'Reparent activity E5', '0aa10000-0000-0000-0000-0000000000b1', '0aa10000-0000-0000-0000-0000000000e5');
  `));
  {
    const r = psqlScalarSafe(`
UPDATE public.crm_opportunities SET organization_id = '0aa10000-0000-0000-0000-0000000000a1'
WHERE id = '0aa10000-0000-0000-0000-0000000000e5'
RETURNING organization_id;
`);
    check('opportunity NULL->A with activity org B: DENY', r === null);
    const orgAfter = psqlScalar(`SELECT organization_id FROM public.crm_opportunities WHERE id = '0aa10000-0000-0000-0000-0000000000e5';`);
    check('opportunity NULL->A denied: original NULL org preserved', orgAfter === '');
  }

  // =========================================================
  // TIMELINE READINESS
  // =========================================================
  console.log('\n--- TIMELINE READINESS ---');

  // created_at and occurred_at are queryable
  check('created_at column exists and is timestamptz',
    psqlScalar(`SELECT data_type FROM information_schema.columns WHERE table_schema='public' AND table_name='crm_activities' AND column_name='created_at'`) === 'timestamp with time zone');

  check('occurred_at column exists and is timestamptz',
    psqlScalar(`SELECT data_type FROM information_schema.columns WHERE table_schema='public' AND table_name='crm_activities' AND column_name='occurred_at'`) === 'timestamp with time zone');

  // Deterministic IDs (uuid)
  check('id is uuid (deterministic)',
    psqlScalar(`SELECT data_type FROM information_schema.columns WHERE table_schema='public' AND table_name='crm_activities' AND column_name='id'`) === 'uuid');

} catch (err) {
  console.error('Runtime test error:', err.message);
} finally {
  // Always destroy container
  console.log('\nDestroying disposable container...');
  docker(['rm', '-f', CONTAINER], { stdio: 'pipe' });
  console.log('Container destroyed.');
}

console.log(`\n=== RUNTIME RESULTS: ${passed} passed, ${failed} failed ===`);
console.log('AUTH_RLS_SIMULATION=YES');
if (failed === 0) {
  console.log('P3B4 runtime validation: ALL PASS');
} else {
  console.log('P3B4 runtime validation: FAILURES DETECTED');
  process.exit(1);
}

// Helper to read files compatibly (needed because import is at top)
import { readFileSync } from 'node:fs';
function readFileSyncCompat(p) {
  return readFileSync(p, 'utf8');
}
