// P3B3 — CRM Opportunities + Pipeline Events — Runtime Validation (Disposable PostgreSQL 17)
//
// Spins up a DISPOSABLE postgres:17 container, loads the minimal dependency
// baseline (auth.uid() stub + helpers + clients/user_roles/internal_operators),
// applies P3B1, P3B2, then P3B3 migrations in order, and runs runtime
// assertions covering:
//   - schema (tables, FKs, CHECKs, indexes)
//   - contact/org integrity (mismatch rejected)
//   - stage protection (direct UPDATE blocked, RPC allowed)
//   - transition map (allowed/invalid/no-op)
//   - pipeline events (creation event, exactly one per transition, immutability)
//   - RLS (admin/operator/client/anon)
//   - grants (events SELECT-only, no direct write)
//   - lost_reason handling
//
// AUTH_RLS_SIMULATION=YES — uses a session-GUC stub for auth.uid() because a
// plain PostgreSQL container has no Supabase GoTrue/JWT layer.
//
// The container is ALWAYS destroyed after tests (success or failure).

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { writeFileSync, unlinkSync, mkdtempSync, rmSync } from 'node:fs';
import { join, basename } from 'node:path';
import { tmpdir } from 'node:os';
import { readFileSync } from 'node:fs';

const CONTAINER = 'p3b3_runtime_pg17';
const PGUSER = 'postgres';
const PGDB = 'postgres';
const PGPASSWORD = 'p3b3test';
const PGPORT = '54178'; // avoid clashing with P3B2 test + local Supabase stack

const MIGRATIONS_DIR = new URL('../supabase/migrations/', import.meta.url).pathname
  .replace(/^\//, '')
  .replace(/\//g, '\\');

const P3B1_FILE = join(MIGRATIONS_DIR, '20260909120000_p3b1_crm_organizations_segments.sql');
const P3B2_FILE = join(MIGRATIONS_DIR, '20260909130000_p3b2_crm_sites_contacts.sql');
const P3B3_FILE = join(MIGRATIONS_DIR, '20260909140000_p3b3_crm_opportunities_pipeline.sql');

// Fixed UUIDs for test identities (deterministic).
const ADMIN_UID    = 'aaaaaaaa-0000-0000-0000-000000000001';
const OPERATOR_UID = 'bbbbbbbb-0000-0000-0000-000000000002';
const CLIENT_UID   = 'cccccccc-0000-0000-0000-000000000003'; // non-internal client user

function docker(args, opts = {}) {
  return spawnSync('docker', args, { encoding: 'utf8', ...opts });
}

function psql(sql, opts = {}) {
  const tmp = join(tmpdir(), `p3b3_${Date.now()}_${Math.random().toString(36).slice(2)}.sql`);
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
  const tmp = join(tmpdir(), `p3b3_q_${Date.now()}_${Math.random().toString(36).slice(2)}.sql`);
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
  const tmp = join(tmpdir(), `p3b3_qs_${Date.now()}_${Math.random().toString(36).slice(2)}.sql`);
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

console.log('=== P3B3 Runtime Validation (disposable PostgreSQL 17) ===\n');

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
  const probe = docker(['exec', '-e', `PGPASSWORD=${PGPASSWORD}`, CONTAINER, 'pg_isready', '-U', PGUSER], { stdio: 'pipe' });
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

  // 4. Apply P3B3 migration.
  console.log('Applying P3B3 migration...');
  r = psql(readFileSync(P3B3_FILE, 'utf8'));
  if (r.status !== 0) { console.error('P3B3 failed:\n', r.stderr); throw new Error('p3b3'); }

  // 5. Load fixtures.
  r = psql(FIXTURE_SQL);
  if (r.status !== 0) { console.error('FIXTURE failed:\n', r.stderr); throw new Error('fixture'); }

  // =========================================================
  // SCHEMA ASSERTIONS
  // =========================================================
  console.log('\n--- SCHEMA ASSERTIONS ---');

  check('crm_opportunities table exists',
    psqlScalar(`SELECT to_regclass('public.crm_opportunities')`) === 'crm_opportunities');
  check('crm_pipeline_events table exists',
    psqlScalar(`SELECT to_regclass('public.crm_pipeline_events')`) === 'crm_pipeline_events');

  check('crm_opportunities.id is uuid',
    psqlScalar(`SELECT format_type(atttypid, atttypmod) FROM pg_attribute WHERE attrelid='public.crm_opportunities'::regclass AND attname='id'`) === 'uuid');
  check('crm_pipeline_events.id is uuid',
    psqlScalar(`SELECT format_type(atttypid, atttypmod) FROM pg_attribute WHERE attrelid='public.crm_pipeline_events'::regclass AND attname='id'`) === 'uuid');

  check('RLS enabled on crm_opportunities',
    psqlScalar(`SELECT relrowsecurity FROM pg_class WHERE relname='crm_opportunities'`) === 't');
  check('RLS enabled on crm_pipeline_events',
    psqlScalar(`SELECT relrowsecurity FROM pg_class WHERE relname='crm_pipeline_events'`) === 't');

  // Indexes
  check('index crm_opportunities_organization_id exists',
    psqlScalar(`SELECT count(*) FROM pg_indexes WHERE indexname='crm_opportunities_organization_id_idx'`) === '1');
  check('index crm_opportunities_contact_id exists',
    psqlScalar(`SELECT count(*) FROM pg_indexes WHERE indexname='crm_opportunities_contact_id_idx'`) === '1');
  check('index crm_opportunities_stage exists',
    psqlScalar(`SELECT count(*) FROM pg_indexes WHERE indexname='crm_opportunities_stage_idx'`) === '1');
  check('index crm_pipeline_events_opportunity_created exists',
    psqlScalar(`SELECT count(*) FROM pg_indexes WHERE indexname='crm_pipeline_events_opportunity_created_idx'`) === '1');

  // =========================================================
  // DATA + FK + CHECK ASSERTIONS (as admin)
  // =========================================================
  console.log('\n--- DATA + FK + CHECK ASSERTIONS (as admin) ---');

  // Create an organization + contact as admin (for FK targets).
  psql(asUser('authenticated', ADMIN_UID, `
INSERT INTO public.organizations (id, legal_name) VALUES ('11110000-0000-0000-0000-000000000001', 'Test Concession')
ON CONFLICT (id) DO NOTHING;
INSERT INTO public.organization_contacts (id, organization_id, first_name, last_name, email, primary_contact)
VALUES ('22220000-0000-0000-0000-000000000002', '11110000-0000-0000-0000-000000000001', 'Alice', 'Dupont', 'alice@test.com', true)
ON CONFLICT (id) DO NOTHING;
`));

  // Create a second org + contact (for mismatch test).
  psql(asUser('authenticated', ADMIN_UID, `
INSERT INTO public.organizations (id, legal_name) VALUES ('33330000-0000-0000-0000-000000000003', 'Other Org')
ON CONFLICT (id) DO NOTHING;
INSERT INTO public.organization_contacts (id, organization_id, first_name, last_name)
VALUES ('44440000-0000-0000-0000-000000000004', '33330000-0000-0000-0000-000000000003', 'Bob', 'Martin')
ON CONFLICT (id) DO NOTHING;
`));

  // Create early lead without organization (valid).
  psql(asUser('authenticated', ADMIN_UID, `
INSERT INTO public.crm_opportunities (id, title, lead_first_name, lead_email)
VALUES ('55550000-0000-0000-0000-000000000005', 'Early lead', 'Jean', 'jean@test.com');
`));
  check('early lead without organization inserted',
    psqlScalar(`SELECT count(*) FROM public.crm_opportunities WHERE id='55550000-0000-0000-0000-000000000005'`) === '1');

  // Initial creation event created (from_stage=NULL, to_stage='lead').
  check('initial creation event created (from_stage=NULL, to_stage=lead)',
    psqlScalar(`SELECT count(*) FROM public.crm_pipeline_events WHERE opportunity_id='55550000-0000-0000-0000-000000000005' AND from_stage IS NULL AND to_stage='lead'`) === '1');

  // Create opportunity linked to organization.
  psql(asUser('authenticated', ADMIN_UID, `
INSERT INTO public.crm_opportunities (id, title, organization_id)
VALUES ('66660000-0000-0000-0000-000000000006', 'Org deal', '11110000-0000-0000-0000-000000000001');
`));
  check('opportunity linked to organization inserted',
    psqlScalar(`SELECT count(*) FROM public.crm_opportunities WHERE id='66660000-0000-0000-0000-000000000006' AND organization_id='11110000-0000-0000-0000-000000000001'`) === '1');

  // Create opportunity linked to valid contact (matching org).
  psql(asUser('authenticated', ADMIN_UID, `
INSERT INTO public.crm_opportunities (id, title, organization_id, contact_id)
VALUES ('77770000-0000-0000-0000-000000000007', 'Contact deal', '11110000-0000-0000-0000-000000000001', '22220000-0000-0000-0000-000000000002');
`));
  check('opportunity with valid contact+org inserted',
    psqlScalar(`SELECT count(*) FROM public.crm_opportunities WHERE id='77770000-0000-0000-0000-000000000007'`) === '1');

  // Reject contact/org mismatch (contact belongs to different org).
  {
    const res = psql(asUser('authenticated', ADMIN_UID, `
INSERT INTO public.crm_opportunities (id, title, organization_id, contact_id)
VALUES ('88880000-0000-0000-0000-000000000008', 'Mismatch', '11110000-0000-0000-0000-000000000001', '44440000-0000-0000-0000-000000000004');
`));
    check('contact/org mismatch rejected', res.status !== 0 && /n'appartient pas/i.test(res.stderr));
  }

  // =========================================================
  // CONTACT/ORG 5-STATE MATRIX
  // =========================================================
  console.log('\n--- CONTACT/ORG 5-STATE MATRIX ---');

  // State 1: org=A, contact=contact(A) -> ALLOW (already tested above as 7777).
  check('state1: org=A + contact(A) ALLOW',
    psqlScalar(`SELECT count(*) FROM public.crm_opportunities WHERE id='77770000-0000-0000-0000-000000000007'`) === '1');

  // State 2: org=A, contact=contact(B) -> DENY (already tested above as 8888).
  check('state2: org=A + contact(B) DENY',
    psqlScalar(`SELECT count(*) FROM public.crm_opportunities WHERE id='88880000-0000-0000-0000-000000000008'`) === '0');

  // State 3: org=NULL, contact=NULL -> ALLOW (already tested as early lead 5555).
  check('state3: org=NULL + contact=NULL ALLOW',
    psqlScalar(`SELECT count(*) FROM public.crm_opportunities WHERE id='55550000-0000-0000-0000-000000000005'`) === '1');

  // State 4: org=A, contact=NULL -> ALLOW (already tested as org deal 6666).
  check('state4: org=A + contact=NULL ALLOW',
    psqlScalar(`SELECT count(*) FROM public.crm_opportunities WHERE id='66660000-0000-0000-0000-000000000006'`) === '1');

  // State 5: org=NULL, contact=contact(A) -> DENY (contact without org).
  {
    const res = psql(asUser('authenticated', ADMIN_UID, `
INSERT INTO public.crm_opportunities (id, title, contact_id)
VALUES ('eeee0000-0000-0000-0000-00000000000e', 'Contact no org', '22220000-0000-0000-0000-000000000002');
`));
    check('state5: org=NULL + contact(A) DENY', res.status !== 0 && /organisation/i.test(res.stderr));
  }

  // Reject empty title.
  {
    const res = psql(asUser('authenticated', ADMIN_UID, `
INSERT INTO public.crm_opportunities (id, title) VALUES ('99990000-0000-0000-0000-000000000009', '   ');
`));
    check('empty title rejected', res.status !== 0);
  }

  // Reject invalid stage.
  {
    const res = psql(asUser('authenticated', ADMIN_UID, `
INSERT INTO public.crm_opportunities (id, title, stage) VALUES ('aaaa0000-0000-0000-0000-00000000000a', 'Bad stage', 'invalid_stage');
`));
    check('invalid stage rejected', res.status !== 0 && /check constraint/i.test(res.stderr));
  }

  // Reject probability > 100.
  {
    const res = psql(asUser('authenticated', ADMIN_UID, `
INSERT INTO public.crm_opportunities (id, title, probability) VALUES ('bbbb0000-0000-0000-0000-00000000000b', 'Bad prob', 150);
`));
    check('probability > 100 rejected', res.status !== 0 && /check constraint/i.test(res.stderr));
  }

  // Reject negative estimated_value.
  {
    const res = psql(asUser('authenticated', ADMIN_UID, `
INSERT INTO public.crm_opportunities (id, title, estimated_value) VALUES ('cccc0000-0000-0000-0000-00000000000c', 'Neg value', -100);
`));
    check('negative estimated_value rejected', res.status !== 0 && /check constraint/i.test(res.stderr));
  }

  // Reject lost_reason when stage != lost.
  {
    const res = psql(asUser('authenticated', ADMIN_UID, `
INSERT INTO public.crm_opportunities (id, title, stage, lost_reason) VALUES ('dddd0000-0000-0000-0000-00000000000d', 'Bad reason', 'lead', 'Too expensive');
`));
    check('lost_reason when stage!=lost rejected', res.status !== 0 && /check constraint/i.test(res.stderr));
  }

  // =========================================================
  // RLS: READ ACCESS
  // =========================================================
  console.log('\n--- RLS: READ ACCESS ---');

  // Operator can SELECT opportunities.
  check('operator can SELECT crm_opportunities',
    psqlScalarSafe(asUser('authenticated', OPERATOR_UID, `SELECT count(*) FROM public.crm_opportunities;`)) !== null);

  // Non-internal (client) cannot SELECT.
  {
    const res = psql(asUser('authenticated', CLIENT_UID, `SELECT count(*) FROM public.crm_opportunities;`));
    check('non-internal cannot SELECT crm_opportunities', res.status !== 0 || (psqlScalarSafe(asUser('authenticated', CLIENT_UID, `SELECT count(*) FROM public.crm_opportunities;`)) === '0'));
  }

  // Operator can SELECT pipeline events.
  check('operator can SELECT crm_pipeline_events',
    psqlScalarSafe(asUser('authenticated', OPERATOR_UID, `SELECT count(*) FROM public.crm_pipeline_events;`)) !== null);

  // Non-internal cannot SELECT pipeline events.
  check('non-internal cannot SELECT crm_pipeline_events',
    psqlScalarSafe(asUser('authenticated', CLIENT_UID, `SELECT count(*) FROM public.crm_pipeline_events;`)) === '0' || psql(asUser('authenticated', CLIENT_UID, `SELECT count(*) FROM public.crm_pipeline_events;`)).status !== 0);

  // =========================================================
  // TRANSITION RPC
  // =========================================================
  console.log('\n--- TRANSITION RPC ---');

  // Allowed transition: lead -> qualified.
  {
    const res = psql(asUser('authenticated', OPERATOR_UID, `
SELECT public.crm_transition_opportunity('55550000-0000-0000-0000-000000000005', 'qualified');
`));
    check('allowed transition lead->qualified succeeds', res.status === 0);
    check('stage is now qualified',
      psqlScalar(`SELECT stage FROM public.crm_opportunities WHERE id='55550000-0000-0000-0000-000000000005'`) === 'qualified');
  }

  // Exactly one pipeline event created for this transition.
  check('exactly one event for lead->qualified transition',
    psqlScalar(`SELECT count(*) FROM public.crm_pipeline_events WHERE opportunity_id='55550000-0000-0000-0000-000000000005' AND from_stage='lead' AND to_stage='qualified'`) === '1');

  // Event actor captured.
  check('event actor_user_id captured',
    psqlScalar(`SELECT actor_user_id FROM public.crm_pipeline_events WHERE opportunity_id='55550000-0000-0000-0000-000000000005' AND to_stage='qualified'`) === OPERATOR_UID);
  check('event actor_role captured (operator)',
    psqlScalar(`SELECT actor_role FROM public.crm_pipeline_events WHERE opportunity_id='55550000-0000-0000-0000-000000000005' AND to_stage='qualified'`) === 'operator');

  // Invalid transition: qualified -> won (not allowed).
  {
    const res = psql(asUser('authenticated', OPERATOR_UID, `
SELECT public.crm_transition_opportunity('55550000-0000-0000-0000-000000000005', 'won');
`));
    check('invalid transition qualified->won fails', res.status !== 0 && /non autoris/i.test(res.stderr));
  }

  // No-op transition: qualified -> qualified.
  {
    const res = psql(asUser('authenticated', OPERATOR_UID, `
SELECT public.crm_transition_opportunity('55550000-0000-0000-0000-000000000005', 'qualified');
`));
    check('no-op transition fails', res.status !== 0 && /no-op/i.test(res.stderr));
  }

  // Transition to lost sets lost_reason.
  {
    const res = psql(asUser('authenticated', OPERATOR_UID, `
SELECT public.crm_transition_opportunity('55550000-0000-0000-0000-000000000005', 'lost', 'Too expensive');
`));
    check('transition to lost succeeds', res.status === 0);
    check('lost_reason set on lost transition',
      psqlScalar(`SELECT lost_reason FROM public.crm_opportunities WHERE id='55550000-0000-0000-0000-000000000005'`) === 'Too expensive');
  }

  // Lost is terminal — no further transitions.
  {
    const res = psql(asUser('authenticated', OPERATOR_UID, `
SELECT public.crm_transition_opportunity('55550000-0000-0000-0000-000000000005', 'lead');
`));
    check('lost is terminal (no transition out)', res.status !== 0 && /non autoris/i.test(res.stderr));
  }

  // Transition out of non-lost state keeps lost_reason NULL.
  // Use the org deal (6666...) which is still at 'lead'.
  {
    const res = psql(asUser('authenticated', ADMIN_UID, `
SELECT public.crm_transition_opportunity('66660000-0000-0000-0000-000000000006', 'contacted');
`));
    check('transition lead->contacted (admin) succeeds', res.status === 0);
    check('lost_reason is NULL after non-lost transition',
      psqlScalar(`SELECT lost_reason FROM public.crm_opportunities WHERE id='66660000-0000-0000-0000-000000000006'`) === '');
  }

  // Admin transition allowed.
  {
    const res = psql(asUser('authenticated', ADMIN_UID, `
SELECT public.crm_transition_opportunity('66660000-0000-0000-0000-000000000006', 'meeting');
`));
    check('admin transition contacted->meeting succeeds', res.status === 0);
  }

  // =========================================================
  // DIRECT STAGE UPDATE BLOCKED (column-level privilege)
  // =========================================================
  console.log('\n--- DIRECT STAGE UPDATE BLOCKED (column privilege) ---');

  // Operator direct UPDATE stage = DENIED (column privilege).
  {
    const res = psql(asUser('authenticated', OPERATOR_UID, `
UPDATE public.crm_opportunities SET stage='won' WHERE id='66660000-0000-0000-0000-000000000006';
`));
    check('operator direct UPDATE stage DENIED', res.status !== 0);
  }

  // Operator direct UPDATE lost_reason = DENIED (column privilege).
  {
    const res = psql(asUser('authenticated', OPERATOR_UID, `
UPDATE public.crm_opportunities SET lost_reason='hacked' WHERE id='66660000-0000-0000-0000-000000000006';
`));
    check('operator direct UPDATE lost_reason DENIED', res.status !== 0);
  }

  // Admin direct UPDATE stage = DENIED (column privilege applies to all authenticated).
  {
    const res = psql(asUser('authenticated', ADMIN_UID, `
UPDATE public.crm_opportunities SET stage='won' WHERE id='66660000-0000-0000-0000-000000000006';
`));
    check('admin direct UPDATE stage DENIED', res.status !== 0);
  }

  // Admin direct UPDATE lost_reason = DENIED.
  {
    const res = psql(asUser('authenticated', ADMIN_UID, `
UPDATE public.crm_opportunities SET lost_reason='hacked' WHERE id='66660000-0000-0000-0000-000000000006';
`));
    check('admin direct UPDATE lost_reason DENIED', res.status !== 0);
  }

  // Non-stage field UPDATE allowed.
  {
    const res = psql(asUser('authenticated', OPERATOR_UID, `
UPDATE public.crm_opportunities SET estimated_value=5000 WHERE id='66660000-0000-0000-0000-000000000006';
`));
    check('non-stage field UPDATE allowed', res.status === 0);
    check('estimated_value updated',
      psqlScalar(`SELECT estimated_value FROM public.crm_opportunities WHERE id='66660000-0000-0000-0000-000000000006'`) === '5000');
  }

  // updated_at trigger advanced.
  {
    const before = psqlScalar(`SELECT updated_at FROM public.crm_opportunities WHERE id='66660000-0000-0000-0000-000000000006'`);
    psql(asUser('authenticated', OPERATOR_UID, `
UPDATE public.crm_opportunities SET next_action='Call back' WHERE id='66660000-0000-0000-0000-000000000006';
`));
    const after = psqlScalar(`SELECT updated_at FROM public.crm_opportunities WHERE id='66660000-0000-0000-0000-000000000006'`);
    check('updated_at advanced on update', before !== '' && after !== '' && before !== after);
  }

  // =========================================================
  // PIPELINE EVENT IMMUTABILITY
  // =========================================================
  console.log('\n--- PIPELINE EVENT IMMUTABILITY ---');

  // Direct INSERT blocked (no INSERT grant for authenticated).
  {
    const res = psql(asUser('authenticated', OPERATOR_UID, `
INSERT INTO public.crm_pipeline_events (opportunity_id, to_stage) VALUES ('66660000-0000-0000-0000-000000000006', 'won');
`));
    check('direct pipeline-event INSERT blocked', res.status !== 0);
  }

  // Direct UPDATE blocked (immutability trigger OR RLS permission denial).
  {
    const res = psql(asUser('authenticated', OPERATOR_UID, `
UPDATE public.crm_pipeline_events SET reason='hacked' WHERE opportunity_id='66660000-0000-0000-0000-000000000006';
`));
    check('direct pipeline-event UPDATE blocked', res.status !== 0);
  }

  // Direct DELETE blocked (immutability trigger OR RLS permission denial).
  {
    const res = psql(asUser('authenticated', OPERATOR_UID, `
DELETE FROM public.crm_pipeline_events WHERE opportunity_id='66660000-0000-0000-0000-000000000006';
`));
    check('direct pipeline-event DELETE blocked', res.status !== 0);
  }

  // Immutability trigger fires even when RLS is bypassed (as postgres).
  {
    const res = psql(`
SET ROLE postgres;
UPDATE public.crm_pipeline_events SET reason='hacked' WHERE opportunity_id='66660000-0000-0000-0000-000000000006';
RESET ROLE;
`);
    check('immutability trigger fires (UPDATE as postgres)', res.status !== 0 && /immutable/i.test(res.stderr));
  }
  {
    const res = psql(`
SET ROLE postgres;
DELETE FROM public.crm_pipeline_events WHERE opportunity_id='66660000-0000-0000-0000-000000000006';
RESET ROLE;
`);
    check('immutability trigger fires (DELETE as postgres)', res.status !== 0 && /immutable/i.test(res.stderr));
  }

  // =========================================================
  // TRANSITION AUTHORIZATION
  // =========================================================
  console.log('\n--- TRANSITION AUTHORIZATION ---');

  // Client (non-internal) cannot call transition RPC.
  {
    const res = psql(asUser('authenticated', CLIENT_UID, `
SELECT public.crm_transition_opportunity('77770000-0000-0000-0000-000000000007', 'qualified');
`));
    check('client transition denied', res.status !== 0 && /internes/i.test(res.stderr));
  }

  // Anon cannot call transition RPC.
  {
    const res = psql(asUser('anon', null, `
SELECT public.crm_transition_opportunity('77770000-0000-0000-0000-000000000007', 'qualified');
`));
    check('anon transition denied', res.status !== 0);
  }

  // =========================================================
  // DELETE: ADMIN-ONLY
  // =========================================================
  console.log('\n--- DELETE: ADMIN-ONLY ---');

  // Operator cannot delete opportunity (admin-only).
  {
    const res = psql(asUser('authenticated', OPERATOR_UID, `
DELETE FROM public.crm_opportunities WHERE id='77770000-0000-0000-0000-000000000007';
`));
    check('operator cannot delete opportunity', res.status !== 0 || psqlScalar(`SELECT count(*) FROM public.crm_opportunities WHERE id='77770000-0000-0000-0000-000000000007'`) === '1');
  }

  // =========================================================
  // FK ON DELETE RESTRICT (pipeline_events)
  // =========================================================
  console.log('\n--- FK ON DELETE RESTRICT ---');

  // Attempt to delete an opportunity that has pipeline events should be
  // blocked by ON DELETE RESTRICT on crm_pipeline_events.opportunity_id.
  {
    const res = psql(asUser('authenticated', ADMIN_UID, `
DELETE FROM public.crm_opportunities WHERE id='66660000-0000-0000-0000-000000000006';
`));
    check('delete opportunity with events blocked (RESTRICT)', res.status !== 0 && /foreign key/i.test(res.stderr));
  }

  // =========================================================
  // NO SECURITY DEFINER LEAKAGE
  // =========================================================
  console.log('\n--- NO SECURITY DEFINER LEAKAGE ---');

  // Verify exactly 3 SECURITY DEFINER functions from P3B3.
  const sdCount = psqlScalar(`
SELECT count(*) FROM pg_proc p
JOIN pg_namespace n ON p.pronamespace = n.oid
WHERE n.nspname = 'public'
  AND p.proname IN ('crm_transition_opportunity', 'crm_opportunities_create_event', 'crm_opportunities_check_contact_org')
  AND p.prosecdef = true
`);
  check('exactly 3 SECURITY DEFINER functions from P3B3', sdCount === '3');

  // Transition RPC has search_path = ''.
  const spResult = psqlScalar(`
SELECT (config).setting FROM pg_proc p
JOIN pg_namespace n ON p.pronamespace = n.oid
CROSS JOIN LATERAL unnest(p.proconfig) AS config
WHERE n.nspname = 'public' AND p.proname = 'crm_transition_opportunity'
`);
  check('transition RPC has search_path = \'\'', spResult === '');

  // =========================================================
  // ATOMIC BEHAVIOR (structural)
  // =========================================================
  console.log('\n--- ATOMIC BEHAVIOR ---');

  // After a failed transition, no partial event should exist.
  // The invalid transition above (qualified->won on 5555) should NOT
  // have created an event.
  check('failed transition creates no event',
    psqlScalar(`SELECT count(*) FROM public.crm_pipeline_events WHERE opportunity_id='55550000-0000-0000-0000-000000000005' AND to_stage='won'`) === '0');

  // Total events for 5555: creation (lead) + qualified + lost = 3.
  check('correct total events for opportunity 5555',
    psqlScalar(`SELECT count(*) FROM public.crm_pipeline_events WHERE opportunity_id='55550000-0000-0000-0000-000000000005'`) === '3');

} finally {
  // Always destroy the container.
  console.log('\nDestroying disposable container...');
  docker(['rm', '-f', CONTAINER], { stdio: 'pipe' });
  console.log('Container destroyed.');
}

console.log(`\n=== RUNTIME RESULTS: ${passed} passed, ${failed} failed ===`);
console.log('AUTH_RLS_SIMULATION=YES');
if (failed > 0) {
  console.log('P3B3 runtime validation: FAIL');
  process.exit(1);
}
console.log('P3B3 runtime validation: ALL PASS');
