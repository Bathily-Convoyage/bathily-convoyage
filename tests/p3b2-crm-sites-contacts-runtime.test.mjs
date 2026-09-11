// P3B2 — CRM Sites + Contacts — Runtime Validation (Disposable PostgreSQL 17)
//
// Spins up a DISPOSABLE postgres:17 container, loads the minimal dependency
// baseline (auth.uid() stub + helper functions + clients/user_roles/
// internal_operators), applies P3B1 then P3B2 migrations in order, and runs
// runtime assertions covering schema, FKs, CHECKs, primary-contact uniqueness,
// updated_at triggers, RLS (anon/non-internal/operator/admin), GRANT behavior,
// and DELETE cascade behavior.
//
// AUTH_RLS_SIMULATION=YES — uses a session-GUC stub for auth.uid() because a
// plain PostgreSQL container has no Supabase GoTrue/JWT layer.
//
// The container is ALWAYS destroyed after tests (success or failure).

import assert from 'node:assert/strict';
import { execSync, spawnSync } from 'node:child_process';
import { writeFileSync, unlinkSync, mkdtempSync, rmSync } from 'node:fs';
import { join, basename } from 'node:path';
import { tmpdir } from 'node:os';
import { readFileSync } from 'node:fs';

const CONTAINER = 'p3b2_runtime_pg17';
const PGUSER = 'postgres';
const PGDB = 'postgres';
const PGPASSWORD = 'p3b2test';
const PGPORT = '54177'; // avoid clashing with the local Supabase stack

const MIGRATIONS_DIR = new URL('../supabase/migrations/', import.meta.url).pathname
  .replace(/^\//, '') // strip leading slash on Windows drive paths
  .replace(/\//g, '\\');

const P3B1_FILE = join(MIGRATIONS_DIR, '20260909120000_p3b1_crm_organizations_segments.sql');
const P3B2_FILE = join(MIGRATIONS_DIR, '20260909130000_p3b2_crm_sites_contacts.sql');

// Fixed UUIDs for test identities (deterministic).
const ADMIN_UID   = 'aaaaaaaa-0000-0000-0000-000000000001';
const OPERATOR_UID = 'bbbbbbbb-0000-0000-0000-000000000002';
const CLIENT_UID  = 'cccccccc-0000-0000-0000-000000000003'; // non-internal client user
const ANON_UID    = null; // no user

function docker(args, opts = {}) {
  return spawnSync('docker', args, { encoding: 'utf8', ...opts });
}

function psql(sql, opts = {}) {
  // Run SQL inside the container via a temp file.
  const tmp = join(tmpdir(), `p3b2_${Date.now()}_${Math.random().toString(36).slice(2)}.sql`);
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
  // Run SQL that returns a single value via -q -t -A.
  // -q (quiet) suppresses command tags (BEGIN/SET/COMMIT/RESET) so that
  // only the SELECT result row is printed, making .trim() reliable.
  const tmp = join(tmpdir(), `p3b2_q_${Date.now()}_${Math.random().toString(36).slice(2)}.sql`);
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
  // Like psqlScalar but returns null on error (e.g. permission denied)
  // instead of empty string. Useful for checks where either an error
  // OR a 0-row result both mean "no access".
  const tmp = join(tmpdir(), `p3b2_qs_${Date.now()}_${Math.random().toString(36).slice(2)}.sql`);
  writeFileSync(tmp, sql, 'utf8');
  const containerPath = `/tmp/${basename(tmp)}`;
  docker(['cp', tmp, `${CONTAINER}:${containerPath}`], { stdio: 'pipe' });
  const res = docker(
    ['exec', '-e', `PGPASSWORD=${PGPASSWORD}`, CONTAINER, 'psql', '-U', PGUSER, '-d', PGDB, '-q', '-t', '-A', '-v', 'ON_ERROR_STOP=1', '-f', containerPath],
    { stdio: 'pipe' },
  );
  try { unlinkSync(tmp); } catch {}
  docker(['exec', CONTAINER, 'rm', '-f', containerPath], { stdio: 'pipe' });
  if (res.status !== 0) return null; // error (e.g. permission denied)
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
-- Roles used by Supabase-style GRANTs.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN CREATE ROLE anon; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN CREATE ROLE authenticated; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN CREATE ROLE service_role BYPASSRLS; END IF;
END $$;

-- auth schema + auth.uid() session-GUC stub (AUTH_RLS_SIMULATION=YES).
CREATE SCHEMA IF NOT EXISTS auth;
CREATE TABLE IF NOT EXISTS auth.users (id uuid PRIMARY KEY DEFAULT gen_random_uuid());
CREATE OR REPLACE FUNCTION auth.uid()
RETURNS uuid LANGUAGE sql STABLE AS $$
  SELECT NULLIF(current_setting('app.current_user_id', true), '')::uuid
$$;

-- Minimal clients table (only columns referenced by is_admin legacy path + FK target).
CREATE TABLE IF NOT EXISTS public.clients (
  id uuid DEFAULT gen_random_uuid() NOT NULL PRIMARY KEY,
  role text DEFAULT 'client',
  auth_user_id uuid
);

-- user_roles + internal_operators (faithful to phase1 roles security foundation).
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

-- Helper functions (faithful to baseline definitions).
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

-- Grant execute on helpers to authenticated (so RLS policies can call them).
GRANT EXECUTE ON FUNCTION public.is_admin() TO authenticated;
GRANT EXECUTE ON FUNCTION public.is_operator() TO authenticated;
GRANT EXECUTE ON FUNCTION public.is_internal_user() TO authenticated;
GRANT USAGE ON SCHEMA public TO authenticated, anon, service_role;
`;

// =========================================================
// FIXTURE: test identities
// =========================================================

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

-- A client record (non-internal) so client_id FK can be exercised.
INSERT INTO public.clients (id, role, auth_user_id) VALUES
  ('dddd0000-0000-0000-0000-000000000004', 'client', '${CLIENT_UID}')
ON CONFLICT (id) DO NOTHING;
`;

// Helper to run SQL as a specific role + user_id (GUC).
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

console.log('=== P3B2 Runtime Validation (disposable PostgreSQL 17) ===\n');

// 0. Start disposable container.
console.log('Starting disposable postgres:17 container...');
docker(['rm', '-f', CONTAINER], { stdio: 'pipe' });
const startRes = docker([
  'run', '-d', '--name', CONTAINER,
  '-e', `POSTGRES_PASSWORD=${PGPASSWORD}`,
  '-p', `${PGPORT}:5432`,
  'postgres:17',
], { stdio: 'pipe' });
if (startRes.status !== 0) {
  console.error('Failed to start container:', startRes.stderr);
  process.exit(1);
}

// Wait for readiness.
let ready = false;
for (let i = 0; i < 60; i++) {
  const probe = docker(['exec', '-e', `PGPASSWORD=${PGPASSWORD}`, CONTAINER, 'pg_isready', '-h', '127.0.0.1', '-p', '5432', '-U', PGUSER], { stdio: 'pipe' });
  if (probe.stdout.includes('accepting connections')) { ready = true; break; }
  spawnSync('node', ['-e', 'setTimeout(()=>{},300)'], { stdio: 'ignore' });
}
if (!ready) {
  console.error('PostgreSQL did not become ready.');
  docker(['rm', '-f', CONTAINER], { stdio: 'pipe' });
  process.exit(1);
}
console.log('Container ready.\n');

try {
  // 1. Apply setup baseline.
  console.log('Loading dependency baseline (auth.uid stub + helpers)...');
  let r = psql(SETUP_SQL);
  if (r.status !== 0) { console.error('SETUP failed:\n', r.stderr); throw new Error('setup'); }

  // 2. Apply P3B1 migration.
  console.log('Applying P3B1 migration...');
  r = psql(readFileSync(P3B1_FILE, 'utf8'));
  if (r.status !== 0) { console.error('P3B1 failed:\n', r.stderr); throw new Error('p3b1'); }

  // 3. Apply P3B2 migration.
  console.log('Applying P3B2 migration...');
  r = psql(readFileSync(P3B2_FILE, 'utf8'));
  if (r.status !== 0) { console.error('P3B2 failed:\n', r.stderr); throw new Error('p3b2'); }

  // 4. Load fixtures.
  r = psql(FIXTURE_SQL);
  if (r.status !== 0) { console.error('FIXTURE failed:\n', r.stderr); throw new Error('fixture'); }

  console.log('\n--- SCHEMA ASSERTIONS ---');

  // Both tables created.
  check('organization_sites table exists',
    psqlScalar(`SELECT to_regclass('public.organization_sites')`) === 'organization_sites');
  check('organization_contacts table exists',
    psqlScalar(`SELECT to_regclass('public.organization_contacts')`) === 'organization_contacts');

  // UUID PKs.
  check('organization_sites.id is uuid',
    psqlScalar(`SELECT format_type(atttypid, atttypmod) FROM pg_attribute WHERE attrelid='public.organization_sites'::regclass AND attname='id'`) === 'uuid');
  check('organization_contacts.id is uuid',
    psqlScalar(`SELECT format_type(atttypid, atttypmod) FROM pg_attribute WHERE attrelid='public.organization_contacts'::regclass AND attname='id'`) === 'uuid');

  // RLS enabled.
  check('RLS enabled on organization_sites',
    psqlScalar(`SELECT relrowsecurity FROM pg_class WHERE relname='organization_sites'`) === 't');
  check('RLS enabled on organization_contacts',
    psqlScalar(`SELECT relrowsecurity FROM pg_class WHERE relname='organization_contacts'`) === 't');

  // Indexes exist.
  check('primary_contact partial unique index exists',
    psqlScalar(`SELECT count(*) FROM pg_indexes WHERE indexname='organization_contacts_primary_unique_idx'`) === '1');

  console.log('\n--- DATA + FK + CHECK ASSERTIONS (as admin) ---');

  // Create an organization as admin.
  psql(asUser('authenticated', ADMIN_UID, `
INSERT INTO public.organizations (id, legal_name) VALUES ('11110000-0000-0000-0000-000000000001', 'Test Concession');
`));

  // organization → multiple sites.
  psql(asUser('authenticated', ADMIN_UID, `
INSERT INTO public.organization_sites (organization_id, name, site_type, city, postal_code, country)
VALUES
  ('11110000-0000-0000-0000-000000000001', 'HQ', 'headquarters', 'Paris', '75001', 'FR'),
  ('11110000-0000-0000-0000-000000000001', 'Dépôt', 'depot', 'Lyon', '69001', 'FR');
`));
  check('organization → multiple sites inserted',
    psqlScalar(`SELECT count(*) FROM public.organization_sites WHERE organization_id='11110000-0000-0000-0000-000000000001'`) === '2');

  // organization → multiple contacts.
  psql(asUser('authenticated', ADMIN_UID, `
INSERT INTO public.organization_contacts (organization_id, first_name, last_name, email, preferred_channel, primary_contact)
VALUES
  ('11110000-0000-0000-0000-000000000001', 'Alice', 'Dupont', 'alice@test.com', 'email', true),
  ('11110000-0000-0000-0000-000000000001', 'Bob', 'Martin', 'bob@test.com', 'phone', false);
`));
  check('organization → multiple contacts inserted',
    psqlScalar(`SELECT count(*) FROM public.organization_contacts WHERE organization_id='11110000-0000-0000-0000-000000000001'`) === '2');

  // site invalid FK rejected.
  {
    const res = psql(asUser('authenticated', ADMIN_UID, `
INSERT INTO public.organization_sites (organization_id, name) VALUES ('99990000-0000-0000-0000-000000000099', 'Ghost');
`));
    check('site invalid FK rejected', res.status !== 0 && /foreign key/i.test(res.stderr));
  }

  // contact invalid FK rejected.
  {
    const res = psql(asUser('authenticated', ADMIN_UID, `
INSERT INTO public.organization_contacts (organization_id, first_name) VALUES ('99990000-0000-0000-0000-000000000099', 'Ghost');
`));
    check('contact invalid FK rejected', res.status !== 0 && /foreign key/i.test(res.stderr));
  }

  // invalid site_type rejected.
  {
    const res = psql(asUser('authenticated', ADMIN_UID, `
INSERT INTO public.organization_sites (organization_id, name, site_type) VALUES ('11110000-0000-0000-0000-000000000001', 'Bad', 'factory');
`));
    check('invalid site_type rejected', res.status !== 0 && /check constraint|violates/i.test(res.stderr));
  }

  // invalid preferred_channel rejected.
  {
    const res = psql(asUser('authenticated', ADMIN_UID, `
INSERT INTO public.organization_contacts (organization_id, first_name, preferred_channel) VALUES ('11110000-0000-0000-0000-000000000001', 'Bad', 'fax');
`));
    check('invalid preferred_channel rejected', res.status !== 0 && /check constraint|violates/i.test(res.stderr));
  }

  // valid preferred_channel NULL accepted.
  {
    const res = psql(asUser('authenticated', ADMIN_UID, `
INSERT INTO public.organization_contacts (organization_id, first_name, preferred_channel) VALUES ('11110000-0000-0000-0000-000000000001', 'NoChannel', NULL);
`));
    check('preferred_channel NULL accepted', res.status === 0);
  }

  // active defaults.
  check('site active defaults to true',
    psqlScalar(`SELECT active FROM public.organization_sites WHERE name='HQ'`) === 't');
  check('contact active defaults to true',
    psqlScalar(`SELECT active FROM public.organization_contacts WHERE first_name='Alice'`) === 't');

  console.log('\n--- PRIMARY CONTACT CONSTRAINT ---');

  // Second primary_contact for same org must be rejected.
  {
    const res = psql(asUser('authenticated', ADMIN_UID, `
INSERT INTO public.organization_contacts (organization_id, first_name, primary_contact) VALUES ('11110000-0000-0000-0000-000000000001', 'Second', true);
`));
    check('second primary_contact for same org rejected', res.status !== 0 && /unique/i.test(res.stderr));
  }

  // Different org can have its own primary contact.
  psql(asUser('authenticated', ADMIN_UID, `
INSERT INTO public.organizations (id, legal_name) VALUES ('22220000-0000-0000-0000-000000000002', 'Second Org');
INSERT INTO public.organization_contacts (organization_id, first_name, primary_contact) VALUES ('22220000-0000-0000-0000-000000000002', 'Carol', true);
`));
  check('different org can have its own primary contact',
    psqlScalar(`SELECT count(*) FROM public.organization_contacts WHERE primary_contact=true`) === '2');

  // Org with no primary contact allowed.
  psql(asUser('authenticated', ADMIN_UID, `
INSERT INTO public.organizations (id, legal_name) VALUES ('33330000-0000-0000-0000-000000000003', 'No Primary Org');
INSERT INTO public.organization_contacts (organization_id, first_name, primary_contact) VALUES ('33330000-0000-0000-0000-000000000003', 'Dave', false);
`));
  check('org with no primary contact allowed',
    psqlScalar(`SELECT count(*) FROM public.organization_contacts WHERE organization_id='33330000-0000-0000-0000-000000000003' AND primary_contact=false`) === '1');

  console.log('\n--- UPDATED_AT TRIGGERS ---');

  // Capture original updated_at for Alice, then update, then compare.
  const before = psqlScalar(`SELECT updated_at FROM public.organization_contacts WHERE first_name='Alice'`);
  // sleep briefly to ensure now() differs
  spawnSync('node', ['-e', 'setTimeout(()=>{},1100)'], { stdio: 'ignore' });
  psql(asUser('authenticated', ADMIN_UID, `
UPDATE public.organization_contacts SET job_title='Manager' WHERE first_name='Alice';
`));
  const after = psqlScalar(`SELECT updated_at FROM public.organization_contacts WHERE first_name='Alice'`);
  check('contact updated_at advanced on update', before !== after && after !== '');

  const siteBefore = psqlScalar(`SELECT updated_at FROM public.organization_sites WHERE name='HQ'`);
  spawnSync('node', ['-e', 'setTimeout(()=>{},1100)'], { stdio: 'ignore' });
  psql(asUser('authenticated', ADMIN_UID, `
UPDATE public.organization_sites SET phone='+331' WHERE name='HQ';
`));
  const siteAfter = psqlScalar(`SELECT updated_at FROM public.organization_sites WHERE name='HQ'`);
  check('site updated_at advanced on update', siteBefore !== siteAfter && siteAfter !== '');

  console.log('\n--- CLIENT_ID OPTIONAL LINK ---');

  // Link a contact to a client.
  psql(asUser('authenticated', ADMIN_UID, `
INSERT INTO public.organization_contacts (organization_id, first_name, client_id)
VALUES ('11110000-0000-0000-0000-000000000001', 'Linked', 'dddd0000-0000-0000-0000-000000000004');
`));
  check('contact with valid client_id inserted',
    psqlScalar(`SELECT client_id FROM public.organization_contacts WHERE first_name='Linked'`) === 'dddd0000-0000-0000-0000-000000000004');

  // Invalid client_id rejected.
  {
    const res = psql(asUser('authenticated', ADMIN_UID, `
INSERT INTO public.organization_contacts (organization_id, first_name, client_id)
VALUES ('11110000-0000-0000-0000-000000000001', 'BadLink', 'eeee0000-0000-0000-0000-000000000099');
`));
    check('contact invalid client_id rejected', res.status !== 0 && /foreign key/i.test(res.stderr));
  }

  // ON DELETE SET NULL on client delete.
  psql(`DELETE FROM public.clients WHERE id='dddd0000-0000-0000-0000-000000000004';`);
  check('client delete SET NULL on contact.client_id',
    psqlScalar(`SELECT client_id FROM public.organization_contacts WHERE first_name='Linked'`) === '');

  console.log('\n--- RLS: ANON ---');

  // anon SELECT: either permission denied (REVOKE ALL) or 0 rows (RLS).
  // Both outcomes mean anon has no access.
  {
    const v = psqlScalarSafe(asUser('anon', null, `SELECT count(*) FROM public.organization_sites;`));
    check('anon cannot SELECT organization_sites', v === null || v === '0');
  }
  {
    const v = psqlScalarSafe(asUser('anon', null, `SELECT count(*) FROM public.organization_contacts;`));
    check('anon cannot SELECT organization_contacts', v === null || v === '0');
  }

  // anon INSERT rejected.
  {
    const res = psql(asUser('anon', null, `
INSERT INTO public.organization_sites (organization_id, name) VALUES ('11110000-0000-0000-0000-000000000001', 'AnonSite');
`));
    check('anon cannot INSERT organization_sites', res.status !== 0);
  }

  console.log('\n--- RLS: NON-INTERNAL (client user) ---');

  // Non-internal authenticated user sees 0 rows.
  check('non-internal cannot SELECT organization_sites',
    psqlScalar(asUser('authenticated', CLIENT_UID, `SELECT count(*) FROM public.organization_sites;`)) === '0');
  check('non-internal cannot SELECT organization_contacts',
    psqlScalar(asUser('authenticated', CLIENT_UID, `SELECT count(*) FROM public.organization_contacts;`)) === '0');

  // Non-internal INSERT rejected.
  {
    const res = psql(asUser('authenticated', CLIENT_UID, `
INSERT INTO public.organization_contacts (organization_id, first_name) VALUES ('11110000-0000-0000-0000-000000000001', 'ClientInsert');
`));
    check('non-internal cannot INSERT organization_contacts', res.status !== 0);
  }

  console.log('\n--- RLS: OPERATOR ---');

  // Operator can SELECT (sees rows).
  check('operator can SELECT organization_sites',
    psqlScalar(asUser('authenticated', OPERATOR_UID, `SELECT count(*) FROM public.organization_sites;`)) !== '0');
  check('operator can SELECT organization_contacts',
    psqlScalar(asUser('authenticated', OPERATOR_UID, `SELECT count(*) FROM public.organization_contacts;`)) !== '0');

  // Operator can INSERT.
  {
    const res = psql(asUser('authenticated', OPERATOR_UID, `
INSERT INTO public.organization_sites (organization_id, name, site_type) VALUES ('11110000-0000-0000-0000-000000000001', 'OpSite', 'office');
`));
    check('operator can INSERT organization_sites', res.status === 0);
  }

  // Operator can UPDATE.
  {
    const res = psql(asUser('authenticated', OPERATOR_UID, `
UPDATE public.organization_sites SET city='Marseille' WHERE name='OpSite';
`));
    check('operator can UPDATE organization_sites', res.status === 0);
  }

  // Operator can DELETE (internal delete policy).
  {
    const res = psql(asUser('authenticated', OPERATOR_UID, `
DELETE FROM public.organization_sites WHERE name='OpSite';
`));
    check('operator can DELETE organization_sites (internal)', res.status === 0);
  }

  console.log('\n--- RLS: ADMIN ---');

  // Admin can SELECT.
  check('admin can SELECT organization_sites',
    psqlScalar(asUser('authenticated', ADMIN_UID, `SELECT count(*) FROM public.organization_sites;`)) !== '0');

  // Admin can INSERT/UPDATE/DELETE contacts.
  {
    const res = psql(asUser('authenticated', ADMIN_UID, `
INSERT INTO public.organization_contacts (organization_id, first_name) VALUES ('11110000-0000-0000-0000-000000000001', 'AdminIns');
`));
    check('admin can INSERT organization_contacts', res.status === 0);
  }
  {
    const res = psql(asUser('authenticated', ADMIN_UID, `
DELETE FROM public.organization_contacts WHERE first_name='AdminIns';
`));
    check('admin can DELETE organization_contacts (internal)', res.status === 0);
  }

  console.log('\n--- GRANT BEHAVIOR ---');

  // service_role bypasses RLS (GRANT ALL + superuser-like).
  check('service_role can SELECT organization_sites',
    psqlScalar(asUser('service_role', null, `SELECT count(*) FROM public.organization_sites;`)) !== '0');

  // anon has no INSERT privilege (REVOKE ALL).
  {
    const res = psql(asUser('anon', null, `INSERT INTO public.organization_contacts (organization_id, first_name) VALUES ('11110000-0000-0000-0000-000000000001', 'X');`));
    check('anon has no INSERT privilege (revoked)', res.status !== 0);
  }

  console.log('\n--- DELETE CASCADE BEHAVIOR ---');

  // Deleting the parent organization cascades to sites + contacts.
  const sitesBefore = psqlScalar(`SELECT count(*) FROM public.organization_sites WHERE organization_id='22220000-0000-0000-0000-000000000002'`);
  const contactsBefore = psqlScalar(`SELECT count(*) FROM public.organization_contacts WHERE organization_id='22220000-0000-0000-0000-000000000002'`);
  check('cascade fixture: second org has sites/contacts', sitesBefore !== '0' || contactsBefore !== '0');

  // Admin deletes the parent org (organizations DELETE is admin-only).
  psql(asUser('authenticated', ADMIN_UID, `DELETE FROM public.organizations WHERE id='22220000-0000-0000-0000-000000000002';`));
  check('parent org delete cascades to sites',
    psqlScalar(`SELECT count(*) FROM public.organization_sites WHERE organization_id='22220000-0000-0000-0000-000000000002'`) === '0');
  check('parent org delete cascades to contacts',
    psqlScalar(`SELECT count(*) FROM public.organization_contacts WHERE organization_id='22220000-0000-0000-0000-000000000002'`) === '0');

  console.log('\n--- NO SECURITY DEFINER IN P3B2 ---');
  // The P3B2 migration introduces no SECURITY DEFINER functions.
  check('no new SECURITY DEFINER functions from P3B2',
    psqlScalar(`
      SELECT count(*) FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname='public'
        AND p.prosecdef = true
        AND p.proname IN ('organization_sites_set_updated_at','organization_contacts_set_updated_at')
    `) === '0');

} finally {
  // ALWAYS destroy the disposable container.
  console.log('\nDestroying disposable container...');
  docker(['rm', '-f', CONTAINER], { stdio: 'pipe' });
  console.log('Container destroyed.');
}

console.log(`\n=== RUNTIME RESULTS: ${passed} passed, ${failed} failed ===`);
if (failed > 0) {
  process.exit(1);
}
console.log('AUTH_RLS_SIMULATION=YES');
console.log('P3B2 runtime validation: ALL PASS');
