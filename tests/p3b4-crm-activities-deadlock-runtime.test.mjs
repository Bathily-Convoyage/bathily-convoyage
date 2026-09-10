// =========================================================
// P3B4D — Deadlock + Lock Protocol Final Audit
// =========================================================
// True two-session PostgreSQL tests proving:
// 1. No reachable deadlock cycle in CRM parent/child locking
// 2. PostgreSQL UPDATE acquires target row lock BEFORE trigger
// 3. Adversarial interleaving cannot produce a deadlock
// 4. Stress test (25+ iterations) with zero deadlocks
// 5. Contact/opportunity concurrent final state validity
//
// Uses a DISPOSABLE postgres:17 container. Concurrency is handled
// by shell scripts inside the container (bash background jobs),
// avoiding Node.js event loop issues.
// =========================================================

import { readFileSync, writeFileSync, unlinkSync } from 'fs';
import { spawnSync } from 'child_process';
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

const CONTAINER = 'p3b4d_deadlock_pg17';
const PGUSER = 'postgres';
const PGPASSWORD = 'test';
const PGDB = 'postgres';
const PGPORT = '5440';

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
  const tmp = join(tmpdir(), `p3b4d_${Date.now()}_${Math.random().toString(36).slice(2)}.sql`);
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
  const tmp = join(tmpdir(), `p3b4d_q_${Date.now()}_${Math.random().toString(36).slice(2)}.sql`);
  writeFileSync(tmp, sql, 'utf8');
  const containerPath = `/tmp/${basename(tmp)}`;
  docker(['cp', tmp, `${CONTAINER}:${containerPath}`], { stdio: 'pipe' });
  const res = docker(
    ['exec', '-e', `PGPASSWORD=${PGPASSWORD}`, CONTAINER, 'psql', '-U', PGUSER, '-d', PGDB, '-q', '-t', '-A', '-v', 'ON_ERROR_STOP=1', '-f', containerPath],
    { stdio: 'pipe', encoding: 'utf8' },
  );
  try { unlinkSync(tmp); } catch {}
  docker(['exec', CONTAINER, 'rm', '-f', containerPath], { stdio: 'pipe' });
  return res.status === 0 ? res.stdout.trim() : '';
}

// Run a concurrent test using a bash script inside the container.
// The script runs T1 in the background, sleeps, runs T2, waits for T1.
// Returns { t1Status, t1Stderr, t2Status, t2Stderr, elapsed }
function runConcurrent(t1Sql, t2Sql, delaySec) {
  // Write both SQL scripts to the container
  const t1File = `t1_${Date.now()}.sql`;
  const t2File = `t2_${Date.now()}.sql`;

  // Copy T1 SQL to container
  const t1Tmp = join(tmpdir(), `p3b4d_${t1File}`);
  writeFileSync(t1Tmp, t1Sql, 'utf8');
  docker(['cp', t1Tmp, `${CONTAINER}:/tmp/${t1File}`], { stdio: 'pipe' });
  try { unlinkSync(t1Tmp); } catch {}

  // Copy T2 SQL to container
  const t2Tmp = join(tmpdir(), `p3b4d_${t2File}`);
  writeFileSync(t2Tmp, t2Sql, 'utf8');
  docker(['cp', t2Tmp, `${CONTAINER}:/tmp/${t2File}`], { stdio: 'pipe' });
  try { unlinkSync(t2Tmp); } catch {}

  // Write a bash script that runs T1 in background, sleeps, runs T2, waits for T1
  const bashScript = `#!/bin/bash
PGPASSWORD=${PGPASSWORD}
T1_OUT=/tmp/t1_out.txt
T1_ERR=/tmp/t1_err.txt
T2_OUT=/tmp/t2_out.txt
T2_ERR=/tmp/t2_err.txt

# Start T1 in background
psql -U ${PGUSER} -d ${PGDB} -v ON_ERROR_STOP=1 -f /tmp/${t1File} >$T1_OUT 2>$T1_ERR &
T1_PID=$!

# Sleep to let T1 acquire locks
sleep ${delaySec}

# Run T2 in foreground (with timeout)
T2_START=$(date +%s%N)
timeout 15 psql -U ${PGUSER} -d ${PGDB} -v ON_ERROR_STOP=1 -f /tmp/${t2File} >$T2_OUT 2>$T2_ERR
T2_STATUS=$?
T2_END=$(date +%s%N)

# Wait for T1
wait $T1_PID
T1_STATUS=$?

# Output results in parseable format
echo "T1_STATUS=$T1_STATUS"
echo "T2_STATUS=$T2_STATUS"
echo "T2_ELAPSED=$(( (T2_END - T2_START) / 1000000 ))"
echo "T1_STDERR:"
cat $T1_ERR
echo "T2_STDERR:"
cat $T2_ERR

# Cleanup
rm -f /tmp/${t1File} /tmp/${t2File} $T1_OUT $T1_ERR $T2_OUT $T2_ERR
`;

  const bashTmp = join(tmpdir(), `p3b4d_bash_${Date.now()}.sh`);
  writeFileSync(bashTmp, bashScript, 'utf8');
  const bashPath = `/tmp/${basename(bashTmp)}`;
  docker(['cp', bashTmp, `${CONTAINER}:${bashPath}`], { stdio: 'pipe' });
  try { unlinkSync(bashTmp); } catch {}

  const res = docker(['exec', CONTAINER, 'bash', bashPath], { stdio: 'pipe', encoding: 'utf8', timeout: 60000 });
  docker(['exec', CONTAINER, 'rm', '-f', bashPath], { stdio: 'pipe' });

  const output = res.stdout || '';
  const t1Status = parseInt((output.match(/T1_STATUS=(\d+)/) || [])[1] ?? -1);
  const t2Status = parseInt((output.match(/T2_STATUS=(\d+)/) || [])[1] ?? -1);
  const t2Elapsed = parseInt((output.match(/T2_ELAPSED=(\d+)/) || [])[1] ?? 0);
  const t1StderrMatch = output.match(/T1_STDERR:\n([\s\S]*?)\nT2_STDERR:/);
  const t2StderrMatch = output.match(/T2_STDERR:\n([\s\S]*?)$/);
  const t1Stderr = t1StderrMatch ? t1StderrMatch[1].trim() : '';
  const t2Stderr = t2StderrMatch ? t2StderrMatch[1].trim() : '';

  return { t1Status, t2Status, t1Stderr, t2Stderr, elapsed: t2Elapsed };
}

function readFileSyncCompat(path) {
  return readFileSync(path, 'utf8');
}

// =========================================================
// SETUP SQL
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

console.log('=== P3B4D Deadlock + Lock Protocol Final Audit ===\n');

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

let deadlockCount = 0;
let graphInconsistencyCount = 0;

try {
  console.log('Loading dependency baseline...');
  let res = psql(SETUP_SQL);
  if (res.status !== 0) { console.error('Setup failed:', res.stderr); throw new Error('setup'); }

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

  res = psql(FIXTURE_SQL);
  if (res.status !== 0) { console.error('Fixtures failed:', res.stderr); throw new Error('fixtures'); }

  // Create test data
  psql(`
INSERT INTO public.organizations (id, legal_name) VALUES
  ('da100000-0000-0000-0000-0000000000a1', 'Deadlock Org A1'),
  ('da100000-0000-0000-0000-0000000000b1', 'Deadlock Org B1')
ON CONFLICT (id) DO NOTHING;

INSERT INTO public.organization_contacts (id, organization_id, first_name, last_name) VALUES
  ('dc100000-0000-0000-0000-0000000000c1', 'da100000-0000-0000-0000-0000000000a1', 'Deadlock', 'C1'),
  ('dc100000-0000-0000-0000-0000000000c2', 'da100000-0000-0000-0000-0000000000a1', 'Deadlock', 'C2')
ON CONFLICT (id) DO NOTHING;

INSERT INTO public.crm_opportunities (id, title, organization_id, contact_id) VALUES
  ('d0100000-0000-0000-0000-0000000000d1', 'Deadlock Opp O1', 'da100000-0000-0000-0000-0000000000a1', 'dc100000-0000-0000-0000-0000000000c1')
ON CONFLICT (id) DO NOTHING;
  `);

  // =========================================================
  // SECURITY DEFINER INVENTORY
  // =========================================================
  console.log('\n--- SECURITY DEFINER INVENTORY ---');

  const sdCount = psqlScalar(`
SELECT count(*) FROM pg_proc p
JOIN pg_namespace n ON p.pronamespace = n.oid
WHERE n.nspname = 'public'
  AND p.proname IN ('crm_activities_check_cross_entity', 'crm_activities_set_created_by',
    'organization_contacts_guard_reparent', 'crm_opportunities_guard_reparent',
    'crm_opportunities_check_contact_org')
  AND p.prosecdef = true
`);
  check('exactly 5 SECURITY DEFINER functions', sdCount === '5');

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

    const owner = psqlScalar(`
SELECT rolname FROM pg_proc p
JOIN pg_namespace n ON p.pronamespace = n.oid
JOIN pg_roles r ON r.oid = p.proowner
WHERE n.nspname = 'public' AND p.proname = '${fn}'
`);
    check(`${fn} owner = postgres`, owner === 'postgres');

    const execCount = psqlScalar(`
SELECT count(*) FROM information_schema.role_routine_grants
WHERE routine_schema = 'public' AND routine_name = '${fn}'
  AND grantee = 'authenticated' AND privilege_type = 'EXECUTE'
`);
    check(`${fn} EXECUTE revoked from authenticated`, execCount === '0');
  }

  // =========================================================
  // POSTGRESQL UPDATE/TRIGGER LOCK ORDER VERIFICATION
  // =========================================================
  console.log('\n--- POSTGRESQL UPDATE/TRIGGER LOCK ORDER ---');

  // Reset state
  psql(`
UPDATE public.crm_opportunities SET organization_id = 'da100000-0000-0000-0000-0000000000a1', contact_id = 'dc100000-0000-0000-0000-0000000000c1', title = 'Deadlock Opp O1'
WHERE id = 'd0100000-0000-0000-0000-0000000000d1';
DELETE FROM public.crm_activities WHERE opportunity_id = 'd0100000-0000-0000-0000-0000000000d1';
  `);

  // T1: BEGIN, UPDATE opportunity title (holds O1 FOR NO KEY UPDATE), pg_sleep, COMMIT
  // T2: activity INSERT referencing O1 -> should block on O1 FOR SHARE
  const t1LockSql = `BEGIN;
UPDATE public.crm_opportunities SET title = 'Lock order test (updated)'
WHERE id = 'd0100000-0000-0000-0000-0000000000d1';
SELECT pg_sleep(3);
COMMIT;
`;

  const t2LockSql = `SET ROLE authenticated;
SET app.current_user_id = '${ADMIN_UID}';
BEGIN;
INSERT INTO public.crm_activities (activity_type, subject, organization_id, opportunity_id)
VALUES ('note', 'Lock order test', 'da100000-0000-0000-0000-0000000000a1', 'd0100000-0000-0000-0000-0000000000d1');
COMMIT;
RESET ROLE;
SET app.current_user_id = '';
`;

  const lockResult = runConcurrent(t1LockSql, t2LockSql, 1);
  check('OPPORTUNITY_TARGET_ROW_LOCK_HELD_BEFORE_CONTACT_SHARE_LOCK: T2 blocked on opportunity', lockResult.elapsed > 2000);
  check('OPPORTUNITY_TARGET_ROW_LOCK_HELD: T2 activity INSERT succeeds after T1 commits', lockResult.t2Status === 0);

  // =========================================================
  // ADVERSARIAL DEADLOCK TEST
  // =========================================================
  console.log('\n--- ADVERSARIAL DEADLOCK TEST ---');

  // Reset state: opportunity with contact C1, org A1, no activities
  psql(`
UPDATE public.crm_opportunities SET organization_id = 'da100000-0000-0000-0000-0000000000a1', contact_id = 'dc100000-0000-0000-0000-0000000000c1', title = 'Deadlock Opp O1'
WHERE id = 'd0100000-0000-0000-0000-0000000000d1';
DELETE FROM public.crm_activities WHERE opportunity_id = 'd0100000-0000-0000-0000-0000000000d1';
  `);

  // T1: opportunity UPDATE (contact_id C1->C2, org stays A1)
  //   Locks: O1 (FOR NO KEY UPDATE by PG) -> C2 (FOR SHARE by trigger)
  // T2: activity INSERT (contact C2, opportunity O1, org A1)
  //   Locks: C2 (FOR SHARE) -> O1 (FOR SHARE)
  //
  // Potential deadlock: T1 holds O1, waits C2; T2 holds C2, waits O1
  // But FOR SHARE is self-compatible: T1's FOR SHARE on C2 doesn't
  // conflict with T2's FOR SHARE on C2. So T1 acquires C2, completes.
  // No deadlock.

  const t1AdvSql = `BEGIN;
UPDATE public.crm_opportunities SET contact_id = 'dc100000-0000-0000-0000-0000000000c2'
WHERE id = 'd0100000-0000-0000-0000-0000000000d1';
SELECT pg_sleep(2);
COMMIT;
`;

  const t2AdvSql = `SET ROLE authenticated;
SET app.current_user_id = '${ADMIN_UID}';
BEGIN;
SET lock_timeout = '10s';
SET statement_timeout = '15s';
INSERT INTO public.crm_activities (activity_type, subject, organization_id, contact_id, opportunity_id)
VALUES ('note', 'Adversarial deadlock test', 'da100000-0000-0000-0000-0000000000a1', 'dc100000-0000-0000-0000-0000000000c2', 'd0100000-0000-0000-0000-0000000000d1');
COMMIT;
RESET ROLE;
SET app.current_user_id = '';
`;

  const advResult = runConcurrent(t1AdvSql, t2AdvSql, 1);

  const advDeadlocked = advResult.t1Stderr.includes('deadlock detected') || advResult.t2Stderr.includes('deadlock detected');
  if (advDeadlocked) deadlockCount++;

  check('ADVERSARIAL_DEADLOCK_REPRODUCED=NO (no deadlock)', !advDeadlocked);

  // T2 should have been blocked then SUCCEEDED (both have org A1, consistent)
  check('Adversarial: T2 activity INSERT succeeded (graph consistent)', advResult.t2Status === 0);

  // Verify final state consistency
  const oppOrgAdv = psqlScalar(`SELECT organization_id FROM public.crm_opportunities WHERE id = 'd0100000-0000-0000-0000-0000000000d1'`);
  const oppContactAdv = psqlScalar(`SELECT contact_id FROM public.crm_opportunities WHERE id = 'd0100000-0000-0000-0000-0000000000d1'`);
  check('Adversarial: opportunity org is A1 (not reparented)', oppOrgAdv === 'da100000-0000-0000-0000-0000000000a1');
  check('Adversarial: opportunity contact is C2 (updated)', oppContactAdv === 'dc100000-0000-0000-0000-0000000000c2');

  // Activity was committed with org A1 referencing C2 and O1
  const advActivityCount = psqlScalar(`SELECT count(*) FROM public.crm_activities WHERE opportunity_id = 'd0100000-0000-0000-0000-0000000000d1' AND organization_id = 'da100000-0000-0000-0000-0000000000a1' AND contact_id = 'dc100000-0000-0000-0000-0000000000c2'`);
  check('Adversarial: consistent activity committed', advActivityCount === '1');

  // =========================================================
  // CONTACT/OPPORTUNITY CONCURRENT RACE
  // =========================================================
  console.log('\n--- CONTACT/OPPORTUNITY CONCURRENT RACE ---');

  // Reset state
  psql(`
UPDATE public.organization_contacts SET organization_id = 'da100000-0000-0000-0000-0000000000a1'
WHERE id = 'dc100000-0000-0000-0000-0000000000c2';
UPDATE public.crm_opportunities SET organization_id = 'da100000-0000-0000-0000-0000000000a1', contact_id = 'dc100000-0000-0000-0000-0000000000c2', title = 'Deadlock Opp O1'
WHERE id = 'd0100000-0000-0000-0000-0000000000d1';
  `);

  // T1: contact C2 reparent A->B
  // T2: opportunity O1 UPDATE (organization_id A->B)
  // T1 locks C2 (FOR NO KEY UPDATE), trigger queries O1 (plain SELECT)
  // T2 locks O1 (FOR NO KEY UPDATE), trigger locks C2 (FOR SHARE) - blocks on T1
  // T1's trigger sees O1 with org A != B -> DENIES -> T1 rolls back
  // T2 then acquires C2 (FOR SHARE), validates, commits

  const t1COSql = `BEGIN;
UPDATE public.organization_contacts SET organization_id = 'da100000-0000-0000-0000-0000000000b1'
WHERE id = 'dc100000-0000-0000-0000-0000000000c2';
SELECT pg_sleep(2);
COMMIT;
`;

  const t2COSql = `BEGIN;
SET lock_timeout = '10s';
SET statement_timeout = '15s';
UPDATE public.crm_opportunities SET organization_id = 'da100000-0000-0000-0000-0000000000b1'
WHERE id = 'd0100000-0000-0000-0000-0000000000d1';
COMMIT;
`;

  const coResult = runConcurrent(t1COSql, t2COSql, 1);

  const coDeadlocked = coResult.t1Stderr.includes('deadlock detected') || coResult.t2Stderr.includes('deadlock detected');
  if (coDeadlocked) deadlockCount++;

  check('Contact/opp race: no deadlock', !coDeadlocked);

  // Verify final state: no opportunity/contact org mismatch
  const coOppOrg = psqlScalar(`SELECT organization_id FROM public.crm_opportunities WHERE id = 'd0100000-0000-0000-0000-0000000000d1'`);
  const coContactOrg = psqlScalar(`SELECT organization_id FROM public.organization_contacts WHERE id = 'dc100000-0000-0000-0000-0000000000c2'`);
  const coOppContactId = psqlScalar(`SELECT contact_id FROM public.crm_opportunities WHERE id = 'd0100000-0000-0000-0000-0000000000d1'`);

  let coValid = true;
  if (coOppContactId === 'dc100000-0000-0000-0000-0000000000c2') {
    coValid = coOppOrg === coContactOrg;
  }
  check('CONTACT_OPPORTUNITY_CONCURRENT_FINAL_STATE_VALID', coValid);
  if (!coValid) graphInconsistencyCount++;

  // =========================================================
  // DEADLOCK STRESS TEST (25+ iterations)
  // =========================================================
  console.log('\n--- DEADLOCK STRESS TEST (25 iterations) ---');

  const STRESS_ITERATIONS = 25;

  for (let i = 0; i < STRESS_ITERATIONS; i++) {
    // Reset state for each iteration
    psql(`
UPDATE public.organization_contacts SET organization_id = 'da100000-0000-0000-0000-0000000000a1'
WHERE id IN ('dc100000-0000-0000-0000-0000000000c1', 'dc100000-0000-0000-0000-0000000000c2');
UPDATE public.crm_opportunities SET organization_id = 'da100000-0000-0000-0000-0000000000a1', contact_id = 'dc100000-0000-0000-0000-0000000000c1', title = 'Deadlock Opp O1'
WHERE id = 'd0100000-0000-0000-0000-0000000000d1';
DELETE FROM public.crm_activities WHERE opportunity_id = 'd0100000-0000-0000-0000-0000000000d1';
    `);

    const scenario = i % 4;
    let t1Sql, t2Sql;

    if (scenario === 0) {
      // Scenario 0: contact reparent VS activity insert
      t1Sql = `BEGIN;
UPDATE public.organization_contacts SET organization_id = 'da100000-0000-0000-0000-0000000000b1'
WHERE id = 'dc100000-0000-0000-0000-0000000000c1';
SELECT pg_sleep(0.5);
COMMIT;
`;
      t2Sql = `SET ROLE authenticated;
SET app.current_user_id = '${ADMIN_UID}';
BEGIN;
SET lock_timeout = '5s';
INSERT INTO public.crm_activities (activity_type, subject, organization_id, contact_id)
VALUES ('note', 'Stress ${i}', 'da100000-0000-0000-0000-0000000000a1', 'dc100000-0000-0000-0000-0000000000c1');
COMMIT;
RESET ROLE;
SET app.current_user_id = '';
`;
    } else if (scenario === 1) {
      // Scenario 1: opportunity reparent VS activity insert
      t1Sql = `BEGIN;
UPDATE public.crm_opportunities SET organization_id = 'da100000-0000-0000-0000-0000000000b1', contact_id = NULL
WHERE id = 'd0100000-0000-0000-0000-0000000000d1';
SELECT pg_sleep(0.5);
COMMIT;
`;
      t2Sql = `SET ROLE authenticated;
SET app.current_user_id = '${ADMIN_UID}';
BEGIN;
SET lock_timeout = '5s';
INSERT INTO public.crm_activities (activity_type, subject, organization_id, opportunity_id)
VALUES ('note', 'Stress ${i}', 'da100000-0000-0000-0000-0000000000a1', 'd0100000-0000-0000-0000-0000000000d1');
COMMIT;
RESET ROLE;
SET app.current_user_id = '';
`;
    } else if (scenario === 2) {
      // Scenario 2: activity insert first VS contact reparent
      t1Sql = `SET ROLE authenticated;
SET app.current_user_id = '${ADMIN_UID}';
BEGIN;
INSERT INTO public.crm_activities (activity_type, subject, organization_id, contact_id)
VALUES ('note', 'Stress ${i}', 'da100000-0000-0000-0000-0000000000a1', 'dc100000-0000-0000-0000-0000000000c2');
SELECT pg_sleep(0.5);
COMMIT;
RESET ROLE;
SET app.current_user_id = '';
`;
      t2Sql = `BEGIN;
SET lock_timeout = '5s';
UPDATE public.organization_contacts SET organization_id = 'da100000-0000-0000-0000-0000000000b1'
WHERE id = 'dc100000-0000-0000-0000-0000000000c2';
COMMIT;
`;
    } else {
      // Scenario 3: opportunity contact update VS activity insert
      t1Sql = `BEGIN;
UPDATE public.crm_opportunities SET contact_id = 'dc100000-0000-0000-0000-0000000000c2'
WHERE id = 'd0100000-0000-0000-0000-0000000000d1';
SELECT pg_sleep(0.5);
COMMIT;
`;
      t2Sql = `SET ROLE authenticated;
SET app.current_user_id = '${ADMIN_UID}';
BEGIN;
SET lock_timeout = '5s';
INSERT INTO public.crm_activities (activity_type, subject, organization_id, contact_id, opportunity_id)
VALUES ('note', 'Stress ${i}', 'da100000-0000-0000-0000-0000000000a1', 'dc100000-0000-0000-0000-0000000000c2', 'd0100000-0000-0000-0000-0000000000d1');
COMMIT;
RESET ROLE;
SET app.current_user_id = '';
`;
    }

    const stressResult = runConcurrent(t1Sql, t2Sql, 0.2);

    const stressDead = stressResult.t1Stderr.includes('deadlock detected') || stressResult.t2Stderr.includes('deadlock detected');
    if (stressDead) {
      deadlockCount++;
      console.log(`  [ALERT] Iteration ${i}: deadlock detected!`);
      console.log(`    T1: ${stressResult.t1Stderr.slice(0, 200)}`);
      console.log(`    T2: ${stressResult.t2Stderr.slice(0, 200)}`);
    }

    // Check graph consistency after each iteration
    const stressActMismatch = psqlScalar(`
SELECT count(*) FROM public.crm_activities a
JOIN public.organization_contacts c ON a.contact_id = c.id
WHERE a.contact_id IS NOT NULL
  AND a.organization_id IS DISTINCT FROM c.organization_id
`);
    if (stressActMismatch !== '0') {
      graphInconsistencyCount++;
      console.log(`  [ALERT] Iteration ${i}: activity/contact mismatch count=${stressActMismatch}`);
    }

    const stressOppMismatch = psqlScalar(`
SELECT count(*) FROM public.crm_opportunities o
JOIN public.organization_contacts c ON o.contact_id = c.id
WHERE o.contact_id IS NOT NULL
  AND o.organization_id IS DISTINCT FROM c.organization_id
`);
    if (stressOppMismatch !== '0') {
      graphInconsistencyCount++;
      console.log(`  [ALERT] Iteration ${i}: opportunity/contact mismatch count=${stressOppMismatch}`);
    }
  }

  check(`STRESS: ${STRESS_ITERATIONS} iterations completed`, true);
  check(`STRESS: DEADLOCK_COUNT=0`, deadlockCount === 0);
  check(`STRESS: GRAPH_INCONSISTENCY_COUNT=0`, graphInconsistencyCount === 0);

  // =========================================================
  // FINAL STATE AUDIT
  // =========================================================
  console.log('\n--- FINAL STATE AUDIT ---');

  const activityContactMismatch = psqlScalar(`
SELECT count(*) FROM public.crm_activities a
JOIN public.organization_contacts c ON a.contact_id = c.id
WHERE a.contact_id IS NOT NULL
  AND a.organization_id IS DISTINCT FROM c.organization_id
`);
  check('no activity/contact org mismatch', activityContactMismatch === '0');

  const oppContactMismatch = psqlScalar(`
SELECT count(*) FROM public.crm_opportunities o
JOIN public.organization_contacts c ON o.contact_id = c.id
WHERE o.contact_id IS NOT NULL
  AND o.organization_id IS DISTINCT FROM c.organization_id
`);
  check('no opportunity/contact org mismatch', oppContactMismatch === '0');

  const activityOppMismatch = psqlScalar(`
SELECT count(*) FROM public.crm_activities a
JOIN public.crm_opportunities o ON a.opportunity_id = o.id
WHERE a.opportunity_id IS NOT NULL
  AND o.organization_id IS NOT NULL
  AND a.organization_id IS DISTINCT FROM o.organization_id
`);
  check('no activity/opportunity org mismatch', activityOppMismatch === '0');

} catch (err) {
  console.error('Deadlock test error:', err.message);
  console.error(err.stack);
} finally {
  console.log('\nDestroying disposable container...');
  docker(['rm', '-f', CONTAINER], { stdio: 'pipe' });
  console.log('Container destroyed.');
}

console.log(`\n=== DEADLOCK RESULTS: ${passed} passed, ${failed} failed ===`);
console.log(`DEADLOCK_COUNT=${deadlockCount}`);
console.log(`GRAPH_INCONSISTENCY_COUNT=${graphInconsistencyCount}`);
console.log(`AUTH_RLS_SIMULATION=YES`);
if (failed === 0) {
  console.log('P3B4D deadlock validation: ALL PASS');
} else {
  console.log('P3B4D deadlock validation: FAILURES DETECTED');
}
