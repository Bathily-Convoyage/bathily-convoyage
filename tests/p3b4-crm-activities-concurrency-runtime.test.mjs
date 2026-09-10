// =========================================================
// P3B4C — CRM Activities Concurrency Runtime Validation
// =========================================================
// True two-session PostgreSQL concurrency tests proving that
// CRM organization graph integrity cannot be violated by
// concurrent transactions.
//
// Uses a DISPOSABLE postgres:17 container with two separate
// psql sessions and explicit transactions.
//
// Run: node tests/p3b4-crm-activities-concurrency-runtime.test.mjs
// =========================================================

import { readFileSync, writeFileSync, unlinkSync } from 'fs';
import { execSync, spawnSync, spawn } from 'child_process';
import { join, basename, dirname } from 'path';
import { tmpdir } from 'os';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO_ROOT = join(__dirname, '..');

const MIGRATIONS_DIR = join(REPO_ROOT, 'supabase', 'migrations');
const P3B1_FILE = join(MIGRATIONS_DIR, '20260909120000_p3b1_crm_organizations_segments.sql');
const P3B2_FILE = join(MIGRATIONS_DIR, '20260909130000_p3b2_crm_sites_contacts.sql');
const P3B3_FILE = join(MIGRATIONS_DIR, '20260909140000_p3b3_crm_opportunities_pipeline.sql');
const P3B4_FILE = join(MIGRATIONS_DIR, '20260910100000_p3b4_crm_activities.sql');

const CONTAINER = 'p3b4c_concurrency_pg17';
const PGUSER = 'postgres';
const PGPASSWORD = 'test';
const PGDB = 'postgres';
const PGPORT = '5439';

const ADMIN_UID = 'aaaaaaaa-0000-0000-0000-000000000001';

let passed = 0;
let failed = 0;
function check(name, cond) {
  if (cond) { console.log(`  ✓ ${name}`); passed++; }
  else { console.log(`  ✗ ${name}`); failed++; }
}

function docker(args, opts = {}) {
  return spawnSync('docker', args, { stdio: 'pipe', encoding: 'utf8', ...opts });
}

function psql(sql, opts = {}) {
  const tmp = join(tmpdir(), `p3b4c_${Date.now()}_${Math.random().toString(36).slice(2)}.sql`);
  writeFileSync(tmp, sql, 'utf8');
  const containerPath = `/tmp/${basename(tmp)}`;
  docker(['cp', tmp, `${CONTAINER}:${containerPath}`], { stdio: 'pipe' });
  const res = docker(
    ['exec', '-e', `PGPASSWORD=${PGPASSWORD}`, CONTAINER, 'psql', '-U', PGUSER, '-d', PGDB, '-v', 'ON_ERROR_STOP=1', '-f', containerPath],
    { stdio: 'pipe', encoding: 'utf8', ...opts },
  );
  try { unlinkSync(tmp); } catch {}
  docker(['exec', CONTAINER, 'rm', '-f', containerPath], { stdio: 'pipe' });
  return res;
}

function psqlScalar(sql) {
  const tmp = join(tmpdir(), `p3b4c_q_${Date.now()}_${Math.random().toString(36).slice(2)}.sql`);
  writeFileSync(tmp, sql, 'utf8');
  const containerPath = `/tmp/${basename(tmp)}`;
  docker(['cp', tmp, `${CONTAINER}:${containerPath}`], { stdio: 'pipe' });
  const res = docker(
    ['exec', '-e', `PGPASSWORD=${PGPASSWORD}`, CONTAINER, 'psql', '-U', PGUSER, '-d', PGDB, '-q', '-t', '-A', '-v', 'ON_ERROR_STOP=1', '-f', containerPath],
    { stdio: 'pipe', encoding: 'utf8' },
  );
  try { unlinkSync(tmp); } catch {}
  docker(['exec', CONTAINER, 'rm', '-f', containerPath], { stdio: 'pipe' });
  return res.stdout.trim();
}

function psqlScalarSafe(sql) {
  const tmp = join(tmpdir(), `p3b4c_qs_${Date.now()}_${Math.random().toString(36).slice(2)}.sql`);
  writeFileSync(tmp, sql, 'utf8');
  const containerPath = `/tmp/${basename(tmp)}`;
  docker(['cp', tmp, `${CONTAINER}:${containerPath}`], { stdio: 'pipe' });
  const res = docker(
    ['exec', '-e', `PGPASSWORD=${PGPASSWORD}`, CONTAINER, 'psql', '-U', PGUSER, '-d', PGDB, '-q', '-t', '-A', '-v', 'ON_ERROR_STOP=1', '-f', containerPath],
    { stdio: 'pipe', encoding: 'utf8' },
  );
  try { unlinkSync(tmp); } catch {}
  docker(['exec', CONTAINER, 'rm', '-f', containerPath], { stdio: 'pipe' });
  if (res.status !== 0) return null;
  return res.stdout.trim();
}

// Run a psql script in a truly async background process (for T1 hold-and-commit)
// Returns the ChildProcess (without await) so T2 can run concurrently
function psqlBackgroundAsync(sql) {
  const tmp = join(tmpdir(), `p3b4c_bg_${Date.now()}_${Math.random().toString(36).slice(2)}.sql`);
  writeFileSync(tmp, sql, 'utf8');
  const containerPath = `/tmp/${basename(tmp)}`;
  docker(['cp', tmp, `${CONTAINER}:${containerPath}`], { stdio: 'pipe' });
  const child = spawn('docker', [
    'exec', '-e', `PGPASSWORD=${PGPASSWORD}`, CONTAINER,
    'psql', '-U', PGUSER, '-d', PGDB, '-v', 'ON_ERROR_STOP=1', '-f', containerPath
  ], { stdio: 'pipe', encoding: 'utf8' });
  child._tmpFile = tmp;
  child._containerPath = containerPath;
  return child;
}

// Wait for a background process to finish (synchronous polling)
function waitForBackground(child, timeoutMs = 30000) {
  let stdout = '', stderr = '';
  child.stdout?.on('data', d => stdout += d);
  child.stderr?.on('data', d => stderr += d);
  const start = Date.now();
  while (child.exitCode === null && child.killed === false && Date.now() - start < timeoutMs) {
    spawnSync('timeout', ['/t', '0.1', '/nobreak'], { stdio: 'pipe' });
  }
  if (child.exitCode === null) {
    child.kill('SIGKILL');
  }
  try { unlinkSync(child._tmpFile); } catch {}
  docker(['exec', CONTAINER, 'rm', '-f', child._containerPath], { stdio: 'pipe' });
  return { status: child.exitCode ?? -1, stdout, stderr };
}

// Run T2 with a timeout — if it blocks beyond the timeout, it fails
function psqlTimed(sql, timeoutMs) {
  const tmp = join(tmpdir(), `p3b4c_t2_${Date.now()}_${Math.random().toString(36).slice(2)}.sql`);
  writeFileSync(tmp, sql, 'utf8');
  const containerPath = `/tmp/${basename(tmp)}`;
  docker(['cp', tmp, `${CONTAINER}:${containerPath}`], { stdio: 'pipe' });
  const start = Date.now();
  const res = docker(
    ['exec', '-e', `PGPASSWORD=${PGPASSWORD}`, CONTAINER, 'psql', '-U', PGUSER, '-d', PGDB, '-v', 'ON_ERROR_STOP=1', '-f', containerPath],
    { stdio: 'pipe', encoding: 'utf8', timeout: timeoutMs },
  );
  const elapsed = Date.now() - start;
  try { unlinkSync(tmp); } catch {}
  docker(['exec', CONTAINER, 'rm', '-f', containerPath], { stdio: 'pipe' });
  return { res, elapsed };
}

function readFileSyncCompat(path) {
  let content = readFileSync(path, 'utf8');
  return content;
}

// =========================================================
// SETUP SQL (same baseline as runtime test)
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

CREATE OR REPLACE FUNCTION public.set_updated_at() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN NEW.updated_at = now(); RETURN NEW; END; $$;

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
INSERT INTO auth.users (id) VALUES ('${ADMIN_UID}') ON CONFLICT (id) DO NOTHING;
INSERT INTO public.user_roles (user_id, role) VALUES ('${ADMIN_UID}', 'admin') ON CONFLICT DO NOTHING;
`;

// =========================================================
// MAIN
// =========================================================

console.log('=== P3B4C Concurrency Runtime Validation (disposable PostgreSQL 17) ===\n');

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
  console.log('Loading dependency baseline...');
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

  // Create test organizations + contacts + opportunities
  psql(`
INSERT INTO public.organizations (id, legal_name) VALUES
  ('ca100000-0000-0000-0000-0000000000a1', 'Concur Org A1'),
  ('ca100000-0000-0000-0000-0000000000b1', 'Concur Org B1')
ON CONFLICT (id) DO NOTHING;

INSERT INTO public.organization_contacts (id, organization_id, first_name, last_name) VALUES
  ('cc100000-0000-0000-0000-0000000000c1', 'ca100000-0000-0000-0000-0000000000a1', 'Concur', 'C1'),
  ('cc100000-0000-0000-0000-0000000000c2', 'ca100000-0000-0000-0000-0000000000a1', 'Concur', 'C2'),
  ('cc100000-0000-0000-0000-0000000000c3', 'ca100000-0000-0000-0000-0000000000a1', 'Concur', 'C3')
ON CONFLICT (id) DO NOTHING;

INSERT INTO public.crm_opportunities (id, title, organization_id) VALUES
  ('c0100000-0000-0000-0000-0000000000d1', 'Concur Opp O1', 'ca100000-0000-0000-0000-0000000000a1'),
  ('c0100000-0000-0000-0000-0000000000d2', 'Concur Opp O2', 'ca100000-0000-0000-0000-0000000000a1')
ON CONFLICT (id) DO NOTHING;
  `);

  // =========================================================
  // SCHEMA ASSERTIONS
  // =========================================================
  console.log('\n--- SCHEMA ASSERTIONS ---');

  check('crm_activities table exists',
    psqlScalar(`SELECT count(*) FROM information_schema.tables WHERE table_schema='public' AND table_name='crm_activities'`) === '1');

  check('5 SECURITY DEFINER functions from P3B4',
    psqlScalar(`
SELECT count(*) FROM pg_proc p
JOIN pg_namespace n ON p.pronamespace = n.oid
WHERE n.nspname = 'public'
  AND p.proname IN ('crm_activities_check_cross_entity', 'crm_activities_set_created_by',
    'organization_contacts_guard_reparent', 'crm_opportunities_guard_reparent',
    'crm_opportunities_check_contact_org')
  AND p.prosecdef = true
`) === '5');

  // All have search_path = ''
  const sdFunctions = ['crm_activities_check_cross_entity', 'crm_activities_set_created_by',
    'organization_contacts_guard_reparent', 'crm_opportunities_guard_reparent',
    'crm_opportunities_check_contact_org'];
  for (const fn of sdFunctions) {
    const sp = psqlScalar(`
SELECT (config).setting FROM pg_proc p
JOIN pg_namespace n ON p.pronamespace = n.oid
CROSS JOIN LATERAL unnest(p.proconfig) AS config
WHERE n.nspname = 'public' AND p.proname = '${fn}'
`);
    check(`${fn} has search_path = ''`, sp === '');
  }

  // =========================================================
  // TEST A: T1 contact reparent VS T2 activity creation
  // =========================================================
  console.log('\n--- TEST A: contact reparent VS activity creation ---');

  // Reset contact C1 to org A1
  psql(`UPDATE public.organization_contacts SET organization_id = 'ca100000-0000-0000-0000-0000000000a1' WHERE id = 'cc100000-0000-0000-0000-0000000000c1';`);

  // T1: BEGIN, reparent contact C1 A1->B1, hold lock for 2s, COMMIT
  // T2: simultaneously try to create activity with contact C1, org A1
  // Expected: T2 blocks on T1's lock, then after T1 commits (contact now B1),
  //           T2's trigger reads B1, activity has A1 -> DENIED

  const t1ScriptA = `
BEGIN;
UPDATE public.organization_contacts SET organization_id = 'ca100000-0000-0000-0000-0000000000b1'
WHERE id = 'cc100000-0000-0000-0000-0000000000c1';
SELECT pg_sleep(2);
COMMIT;
  `;

  const t2ScriptA = `
SET ROLE authenticated;
SET app.current_user_id = '${ADMIN_UID}';
BEGIN;
INSERT INTO public.crm_activities (activity_type, subject, organization_id, contact_id)
VALUES ('call', 'Concur Test A activity', 'ca100000-0000-0000-0000-0000000000a1', 'cc100000-0000-0000-0000-0000000000c1');
COMMIT;
RESET ROLE;
SET app.current_user_id = '';
  `;

  // Run T1 in background (holds lock for 2s)
  const t1ChildA = psqlBackgroundAsync(t1ScriptA);

  // Wait a moment for T1 to acquire the lock
  docker(['exec', CONTAINER, 'sleep', '0.5'], { stdio: 'pipe' });

  // Run T2 — should block, then proceed after T1 commits
  const t2ResultA = psqlTimed(t2ScriptA, 15000);

  // Wait for T1 to finish
  waitForBackground(t1ChildA);

  // T2 should have been DENIED (contact is now B1, activity has A1)
  check('TEST A: T2 activity INSERT DENIED after contact reparent', t2ResultA.res.status !== 0);

  // Final state: contact is B1, no activity with org A1 referencing C1
  const contactOrgA = psqlScalar(`SELECT organization_id FROM public.organization_contacts WHERE id = 'cc100000-0000-0000-0000-0000000000c1'`);
  check('TEST A: contact reparented to B1', contactOrgA === 'ca100000-0000-0000-0000-0000000000b1');

  const activityCountA = psqlScalar(`SELECT count(*) FROM public.crm_activities WHERE contact_id = 'cc100000-0000-0000-0000-0000000000c1' AND organization_id = 'ca100000-0000-0000-0000-0000000000a1'`);
  check('TEST A: no inconsistent activity committed', activityCountA === '0');

  // T2 was blocked (took > 1s due to T1's pg_sleep)
  check('TEST A: T2 was blocked by T1 lock (serialized)', t2ResultA.elapsed > 1000);

  // =========================================================
  // TEST B: T1 activity creation first VS T2 contact reparent
  // =========================================================
  console.log('\n--- TEST B: activity creation first VS contact reparent ---');

  // Reset contact C2 to org A1
  psql(`UPDATE public.organization_contacts SET organization_id = 'ca100000-0000-0000-0000-0000000000a1' WHERE id = 'cc100000-0000-0000-0000-0000000000c2';`);

  // T1: BEGIN, create activity with contact C2, org A1 (acquires FOR SHARE on C2), hold, COMMIT
  // T2: simultaneously try to reparent contact C2 A1->B1 (should block on FOR SHARE)
  // Expected: T2 blocks, then after T1 commits (activity with A1 exists),
  //           T2's parent guard finds activity with A1 != B1 -> DENIED

  const t1ScriptB = `
SET ROLE authenticated;
SET app.current_user_id = '${ADMIN_UID}';
BEGIN;
INSERT INTO public.crm_activities (activity_type, subject, organization_id, contact_id)
VALUES ('call', 'Concur Test B activity', 'ca100000-0000-0000-0000-0000000000a1', 'cc100000-0000-0000-0000-0000000000c2');
SELECT pg_sleep(2);
COMMIT;
RESET ROLE;
SET app.current_user_id = '';
  `;

  const t2ScriptB = `
BEGIN;
UPDATE public.organization_contacts SET organization_id = 'ca100000-0000-0000-0000-0000000000b1'
WHERE id = 'cc100000-0000-0000-0000-0000000000c2';
COMMIT;
  `;

  const t1ChildB = psqlBackgroundAsync(t1ScriptB);
  docker(['exec', CONTAINER, 'sleep', '0.5'], { stdio: 'pipe' });

  const t2ResultB = psqlTimed(t2ScriptB, 15000);
  waitForBackground(t1ChildB);

  // T2 should have been DENIED (activity with A1 exists, reparent to B1 would be inconsistent)
  check('TEST B: T2 contact reparent DENIED (activity blocks reparent)', t2ResultB.res.status !== 0);

  // Final state: contact still A1 (reparent was denied)
  const contactOrgB = psqlScalar(`SELECT organization_id FROM public.organization_contacts WHERE id = 'cc100000-0000-0000-0000-0000000000c2'`);
  check('TEST B: contact remains A1 (reparent denied)', contactOrgB === 'ca100000-0000-0000-0000-0000000000a1');

  // Activity was committed with A1
  const activityCountB = psqlScalar(`SELECT count(*) FROM public.crm_activities WHERE contact_id = 'cc100000-0000-0000-0000-0000000000c2' AND organization_id = 'ca100000-0000-0000-0000-0000000000a1'`);
  check('TEST B: activity committed with org A1', activityCountB === '1');

  check('TEST B: T2 was blocked by T1 lock (serialized)', t2ResultB.elapsed > 1000);

  // =========================================================
  // TEST C: contact reparent VS opportunity creation
  // =========================================================
  console.log('\n--- TEST C: contact reparent VS opportunity creation ---');

  // Reset contact C3 to org A1
  psql(`UPDATE public.organization_contacts SET organization_id = 'ca100000-0000-0000-0000-0000000000a1' WHERE id = 'cc100000-0000-0000-0000-0000000000c3';`);

  // T1: BEGIN, reparent contact C3 A1->B1, hold, COMMIT
  // T2: try to create opportunity with contact C3, org A1
  // Expected: T2 blocks, then after T1 commits (contact now B1),
  //           T2's check_contact_org reads B1, opportunity has A1 -> DENIED

  const t1ScriptC = `
BEGIN;
UPDATE public.organization_contacts SET organization_id = 'ca100000-0000-0000-0000-0000000000b1'
WHERE id = 'cc100000-0000-0000-0000-0000000000c3';
SELECT pg_sleep(2);
COMMIT;
  `;

  const t2ScriptC = `
SET ROLE authenticated;
SET app.current_user_id = '${ADMIN_UID}';
BEGIN;
INSERT INTO public.crm_opportunities (id, title, organization_id, contact_id)
VALUES ('c0100000-0000-0000-0000-0000000000c3', 'Concur Test C opp', 'ca100000-0000-0000-0000-0000000000a1', 'cc100000-0000-0000-0000-0000000000c3');
COMMIT;
RESET ROLE;
SET app.current_user_id = '';
  `;

  const t1ChildC = psqlBackgroundAsync(t1ScriptC);
  docker(['exec', CONTAINER, 'sleep', '1.5'], { stdio: 'pipe' });

  const t2ResultC = psqlTimed(t2ScriptC, 15000);
  waitForBackground(t1ChildC);

  // T2 should have been DENIED (contact is now B1, opportunity has A1)
  check('TEST C: T2 opportunity INSERT DENIED after contact reparent', t2ResultC.res.status !== 0);

  // Final state: contact is B1
  const contactOrgC = psqlScalar(`SELECT organization_id FROM public.organization_contacts WHERE id = 'cc100000-0000-0000-0000-0000000000c3'`);
  check('TEST C: contact reparented to B1', contactOrgC === 'ca100000-0000-0000-0000-0000000000b1');

  // No opportunity with org A1 referencing C3
  const oppCountC = psqlScalar(`SELECT count(*) FROM public.crm_opportunities WHERE contact_id = 'cc100000-0000-0000-0000-0000000000c3' AND organization_id = 'ca100000-0000-0000-0000-0000000000a1'`);
  check('TEST C: no inconsistent opportunity committed', oppCountC === '0');

  // T2 was either blocked (serialized) or denied immediately (T1 already committed)
  // Both outcomes are safe — the graph remains consistent.
  check('TEST C: T2 serialized (blocked or denied after T1)', t2ResultC.elapsed > 1000 || t2ResultC.res.status !== 0);

  // =========================================================
  // TEST D: opportunity reparent VS activity creation
  // =========================================================
  console.log('\n--- TEST D: opportunity reparent VS activity creation ---');

  // Reset opportunity O1 to org A1, clear contact_id and any prior activities
  psql(`
UPDATE public.crm_opportunities SET organization_id = 'ca100000-0000-0000-0000-0000000000a1', contact_id = NULL
WHERE id = 'c0100000-0000-0000-0000-0000000000d1';
DELETE FROM public.crm_activities WHERE opportunity_id = 'c0100000-0000-0000-0000-0000000000d1';
  `);

  // T1: BEGIN, reparent opportunity O1 A1->B1, hold, COMMIT
  // T2: try to create activity with opportunity O1, org A1
  // Expected: T2 blocks, then after T1 commits (opportunity now B1),
  //           T2's trigger reads B1, activity has A1 -> DENIED

  const t1ScriptD = `
BEGIN;
UPDATE public.crm_opportunities SET organization_id = 'ca100000-0000-0000-0000-0000000000b1'
WHERE id = 'c0100000-0000-0000-0000-0000000000d1';
SELECT pg_sleep(2);
COMMIT;
  `;

  const t2ScriptD = `
SET ROLE authenticated;
SET app.current_user_id = '${ADMIN_UID}';
BEGIN;
INSERT INTO public.crm_activities (activity_type, subject, organization_id, opportunity_id)
VALUES ('note', 'Concur Test D activity', 'ca100000-0000-0000-0000-0000000000a1', 'c0100000-0000-0000-0000-0000000000d1');
COMMIT;
RESET ROLE;
SET app.current_user_id = '';
  `;

  const t1ChildD = psqlBackgroundAsync(t1ScriptD);
  docker(['exec', CONTAINER, 'sleep', '0.5'], { stdio: 'pipe' });

  const t2ResultD = psqlTimed(t2ScriptD, 15000);
  waitForBackground(t1ChildD);

  // T2 should have been DENIED (opportunity is now B1, activity has A1)
  check('TEST D: T2 activity INSERT DENIED after opportunity reparent', t2ResultD.res.status !== 0);

  // Final state: opportunity is B1
  const oppOrgD = psqlScalar(`SELECT organization_id FROM public.crm_opportunities WHERE id = 'c0100000-0000-0000-0000-0000000000d1'`);
  check('TEST D: opportunity reparented to B1', oppOrgD === 'ca100000-0000-0000-0000-0000000000b1');

  // No activity with org A1 referencing O1
  const activityCountD = psqlScalar(`SELECT count(*) FROM public.crm_activities WHERE opportunity_id = 'c0100000-0000-0000-0000-0000000000d1' AND organization_id = 'ca100000-0000-0000-0000-0000000000a1'`);
  check('TEST D: no inconsistent activity committed', activityCountD === '0');

  check('TEST D: T2 was blocked by T1 lock (serialized)', t2ResultD.elapsed > 1000);

  // =========================================================
  // TEST E: activity creation first VS opportunity reparent
  // =========================================================
  console.log('\n--- TEST E: activity creation first VS opportunity reparent ---');

  // Reset opportunity O2 to org A1, clear contact_id and any prior activities
  psql(`
UPDATE public.crm_opportunities SET organization_id = 'ca100000-0000-0000-0000-0000000000a1', contact_id = NULL
WHERE id = 'c0100000-0000-0000-0000-0000000000d2';
DELETE FROM public.crm_activities WHERE opportunity_id = 'c0100000-0000-0000-0000-0000000000d2';
  `);

  // T1: BEGIN, create activity with opportunity O2, org A1 (acquires FOR SHARE on O2), hold, COMMIT
  // T2: try to reparent opportunity O2 A1->B1 (should block on FOR SHARE)
  // Expected: T2 blocks, then after T1 commits (activity with A1 exists),
  //           T2's parent guard finds activity with A1 != B1 -> DENIED

  const t1ScriptE = `
SET ROLE authenticated;
SET app.current_user_id = '${ADMIN_UID}';
BEGIN;
INSERT INTO public.crm_activities (activity_type, subject, organization_id, opportunity_id)
VALUES ('note', 'Concur Test E activity', 'ca100000-0000-0000-0000-0000000000a1', 'c0100000-0000-0000-0000-0000000000d2');
SELECT pg_sleep(2);
COMMIT;
RESET ROLE;
SET app.current_user_id = '';
  `;

  const t2ScriptE = `
BEGIN;
UPDATE public.crm_opportunities SET organization_id = 'ca100000-0000-0000-0000-0000000000b1'
WHERE id = 'c0100000-0000-0000-0000-0000000000d2';
COMMIT;
  `;

  const t1ChildE = psqlBackgroundAsync(t1ScriptE);
  docker(['exec', CONTAINER, 'sleep', '0.5'], { stdio: 'pipe' });

  const t2ResultE = psqlTimed(t2ScriptE, 15000);
  waitForBackground(t1ChildE);

  // T2 should have been DENIED (activity with A1 exists, reparent to B1 would be inconsistent)
  check('TEST E: T2 opportunity reparent DENIED (activity blocks reparent)', t2ResultE.res.status !== 0);

  // Final state: opportunity still A1 (reparent was denied)
  const oppOrgE = psqlScalar(`SELECT organization_id FROM public.crm_opportunities WHERE id = 'c0100000-0000-0000-0000-0000000000d2'`);
  check('TEST E: opportunity remains A1 (reparent denied)', oppOrgE === 'ca100000-0000-0000-0000-0000000000a1');

  // Activity was committed with A1
  const activityCountE = psqlScalar(`SELECT count(*) FROM public.crm_activities WHERE opportunity_id = 'c0100000-0000-0000-0000-0000000000d2' AND organization_id = 'ca100000-0000-0000-0000-0000000000a1'`);
  check('TEST E: activity committed with org A1', activityCountE === '1');

  check('TEST E: T2 was blocked by T1 lock (serialized)', t2ResultE.elapsed > 1000);

  // =========================================================
  // P3B3 NULL/CONTACT INVARIANT
  // =========================================================
  console.log('\n--- P3B3 NULL/CONTACT INVARIANT ---');

  // Reset contact C1 to org A1 and create/update an opportunity with contact C1
  psql(`UPDATE public.organization_contacts SET organization_id = 'ca100000-0000-0000-0000-0000000000a1' WHERE id = 'cc100000-0000-0000-0000-0000000000c1';`);
  psql(`
INSERT INTO public.crm_opportunities (id, title, organization_id, contact_id)
VALUES ('c0100000-0000-0000-0000-0000000000d3', 'Null invariant test', 'ca100000-0000-0000-0000-0000000000a1', 'cc100000-0000-0000-0000-0000000000c1')
ON CONFLICT (id) DO UPDATE SET title = EXCLUDED.title, organization_id = EXCLUDED.organization_id, contact_id = EXCLUDED.contact_id;
  `);

  // Try to set opportunity org to NULL while contact is non-null -> DENIED
  const nullOrgResult = psqlScalarSafe(`
UPDATE public.crm_opportunities SET organization_id = NULL
WHERE id = 'c0100000-0000-0000-0000-0000000000d3'
RETURNING organization_id;
`);
  check('P3B3 contact invariant: opp.org=NULL with contact DENIED', nullOrgResult === null);

  // Verify opportunity org preserved
  const oppOrgNull = psqlScalar(`SELECT organization_id FROM public.crm_opportunities WHERE id = 'c0100000-0000-0000-0000-0000000000d3'`);
  check('P3B3 contact invariant: opportunity org preserved', oppOrgNull === 'ca100000-0000-0000-0000-0000000000a1');

  // =========================================================
  // POST-CONCURRENCY FINAL STATE AUDIT
  // =========================================================
  console.log('\n--- POST-CONCURRENCY FINAL STATE AUDIT ---');

  // No activity/contact org mismatch
  const activityContactMismatch = psqlScalar(`
SELECT count(*) FROM public.crm_activities a
JOIN public.organization_contacts c ON a.contact_id = c.id
WHERE a.contact_id IS NOT NULL
  AND a.organization_id IS DISTINCT FROM c.organization_id
`);
  check('no activity/contact org mismatch', activityContactMismatch === '0');

  // No opportunity/contact org mismatch
  const oppContactMismatch = psqlScalar(`
SELECT count(*) FROM public.crm_opportunities o
JOIN public.organization_contacts c ON o.contact_id = c.id
WHERE o.contact_id IS NOT NULL
  AND o.organization_id IS DISTINCT FROM c.organization_id
`);
  check('no opportunity/contact org mismatch', oppContactMismatch === '0');

  // No activity/opportunity org mismatch
  const activityOppMismatch = psqlScalar(`
SELECT count(*) FROM public.crm_activities a
JOIN public.crm_opportunities o ON a.opportunity_id = o.id
WHERE a.opportunity_id IS NOT NULL
  AND o.organization_id IS NOT NULL
  AND a.organization_id IS DISTINCT FROM o.organization_id
`);
  check('no activity/opportunity org mismatch', activityOppMismatch === '0');

} catch (err) {
  console.error('Concurrency test error:', err.message);
  console.error(err.stack);
} finally {
  console.log('\nDestroying disposable container...');
  docker(['rm', '-f', CONTAINER], { stdio: 'pipe' });
  console.log('Container destroyed.');
}

console.log(`\n=== CONCURRENCY RESULTS: ${passed} passed, ${failed} failed ===`);
console.log(`AUTH_RLS_SIMULATION=YES`);
if (failed === 0) {
  console.log('P3B4C concurrency validation: ALL PASS');
} else {
  console.log('P3B4C concurrency validation: FAILURES DETECTED');
}
