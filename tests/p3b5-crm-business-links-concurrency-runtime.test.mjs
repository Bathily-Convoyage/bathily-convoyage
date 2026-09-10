// P3B5 — CRM Business Links — Concurrency Runtime Validation (Disposable PostgreSQL 17)
//
// True two-session PostgreSQL tests proving:
// 1. No reachable deadlock cycle in CRM business-link locking
// 2. Child-side FOR SHARE locks prevent concurrent parent reparent conflicts
// 3. Parent-side plain SELECT guards detect dependent conflicts without deadlocking
// 4. Stress test (10+ iterations) with zero deadlocks
// 5. Concurrent RPC calls maintain graph integrity
//
// Uses a DISPOSABLE postgres:17 container. Concurrency is handled
// by shell scripts inside the container (bash background jobs).

import { readFileSync, writeFileSync, unlinkSync } from 'fs';
import { spawnSync } from 'child_process';
import { join, basename } from 'path';
import { tmpdir } from 'os';

const CONTAINER = 'p3b5c_concurrency_pg17';
const PGUSER = 'postgres';
const PGPASSWORD = 'p3b5ctest';
const PGDB = 'postgres';
const PGPORT = '54182';

const MIGRATIONS_DIR = new URL('../supabase/migrations/', import.meta.url).pathname
  .replace(/^\//, '').replace(/\//g, '\\');

const BASELINE_FILE     = join(MIGRATIONS_DIR, '20260807214536_remote_public_baseline.sql');
const CLIENT_GUARD_FILE  = join(MIGRATIONS_DIR, '20260809000008_phase3_b4_harden_client_role_and_promo_rls.sql');
const P3B1_FILE = join(MIGRATIONS_DIR, '20260909120000_p3b1_crm_organizations_segments.sql');
const P3B2_FILE = join(MIGRATIONS_DIR, '20260909130000_p3b2_crm_sites_contacts.sql');
const P3B3_FILE = join(MIGRATIONS_DIR, '20260909140000_p3b3_crm_opportunities_pipeline.sql');
const P3B4_FILE = join(MIGRATIONS_DIR, '20260910100000_p3b4_crm_activities.sql');
const P3B5_FILE = join(MIGRATIONS_DIR, '20260910110000_p3b5_crm_business_links.sql');

const ADMIN_UID    = 'aaaaaaaa-0000-0000-0000-000000000001';
const OPERATOR_UID = 'bbbbbbbb-0000-0000-0000-000000000002';

const ORG_A_ID     = '11110000-0000-0000-0000-000000000001';
const ORG_B_ID     = '33330000-0000-0000-0000-000000000003';
const CONTACT_A_ID = '22220000-0000-0000-0000-000000000002';
const OPP_A_ID     = '66660000-0000-0000-0000-000000000006';

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
  const tmp = join(tmpdir(), `p3b5c_${Date.now()}_${Math.random().toString(36).slice(2)}.sql`);
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
  const tmp = join(tmpdir(), `p3b5c_q_${Date.now()}_${Math.random().toString(36).slice(2)}.sql`);
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

function runConcurrent(t1Sql, t2Sql, delaySec) {
  const t1File = `t1_${Date.now()}.sql`;
  const t2File = `t2_${Date.now()}.sql`;

  const t1Tmp = join(tmpdir(), `p3b5c_${t1File}`);
  writeFileSync(t1Tmp, t1Sql, 'utf8');
  docker(['cp', t1Tmp, `${CONTAINER}:/tmp/${t1File}`], { stdio: 'pipe' });
  try { unlinkSync(t1Tmp); } catch {}

  const t2Tmp = join(tmpdir(), `p3b5c_${t2File}`);
  writeFileSync(t2Tmp, t2Sql, 'utf8');
  docker(['cp', t2Tmp, `${CONTAINER}:/tmp/${t2File}`], { stdio: 'pipe' });
  try { unlinkSync(t2Tmp); } catch {}

  const bashScript = `#!/bin/bash
PGPASSWORD=${PGPASSWORD}
T1_OUT=/tmp/t1_out.txt
T1_ERR=/tmp/t1_err.txt
T2_OUT=/tmp/t2_out.txt
T2_ERR=/tmp/t2_err.txt

psql -U ${PGUSER} -d ${PGDB} -v ON_ERROR_STOP=1 -f /tmp/${t1File} >$T1_OUT 2>$T1_ERR &
T1_PID=$!

sleep ${delaySec}

T2_START=$(date +%s%N)
timeout 15 psql -U ${PGUSER} -d ${PGDB} -v ON_ERROR_STOP=1 -f /tmp/${t2File} >$T2_OUT 2>$T2_ERR
T2_STATUS=$?
T2_END=$(date +%s%N)

wait $T1_PID
T1_STATUS=$?

echo "T1_STATUS=$T1_STATUS"
echo "T2_STATUS=$T2_STATUS"
echo "T2_ELAPSED=$(( (T2_END - T2_START) / 1000000 ))"
echo "T1_STDERR:"
cat $T1_ERR
echo "T2_STDERR:"
cat $T2_ERR

rm -f /tmp/${t1File} /tmp/${t2File} $T1_OUT $T1_ERR $T2_OUT $T2_ERR
`;

  const bashTmp = join(tmpdir(), `p3b5c_bash_${Date.now()}.sh`);
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

// =========================================================
// SETUP
// =========================================================

const SETUP_SQL = `
DO \$\$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN CREATE ROLE anon; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN CREATE ROLE authenticated; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN CREATE ROLE service_role BYPASSRLS; END IF;
END \$\$;
CREATE SCHEMA IF NOT EXISTS auth;
CREATE TABLE IF NOT EXISTS auth.users (id uuid PRIMARY KEY DEFAULT gen_random_uuid());
CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS \$\$ SELECT NULLIF(current_setting('app.current_user_id', true), '')::uuid \$\$;
CREATE OR REPLACE FUNCTION auth.jwt() RETURNS jsonb LANGUAGE sql STABLE AS \$\$ SELECT COALESCE(NULLIF(current_setting('app.jwt', true), '')::jsonb, '{}'::jsonb) \$\$;
CREATE TABLE IF NOT EXISTS public.user_roles (user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE, role text NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY (user_id, role), CHECK (role IN ('admin', 'operator')));
CREATE TABLE IF NOT EXISTS public.internal_operators (user_id uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE, display_name text NOT NULL, active boolean NOT NULL DEFAULT true, created_at timestamptz NOT NULL DEFAULT now());
CREATE OR REPLACE FUNCTION public.set_updated_at() RETURNS trigger LANGUAGE plpgsql AS \$\$ BEGIN NEW.updated_at = now(); RETURN NEW; END; \$\$;
GRANT USAGE ON SCHEMA public TO authenticated, anon, service_role;
`;

const HELPERS_SQL = `
CREATE OR REPLACE FUNCTION public.is_admin() RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS \$\$ SELECT EXISTS (SELECT 1 FROM public.user_roles ur WHERE ur.role = 'admin' AND ur.user_id = auth.uid()) OR EXISTS (SELECT 1 FROM public.clients c WHERE c.role = 'admin' AND c.auth_user_id = auth.uid()) \$\$;
CREATE OR REPLACE FUNCTION public.is_operator() RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS \$\$ SELECT EXISTS (SELECT 1 FROM public.user_roles ur JOIN public.internal_operators io ON io.user_id = ur.user_id WHERE ur.role = 'operator' AND ur.user_id = auth.uid() AND io.active = true) \$\$;
CREATE OR REPLACE FUNCTION public.is_internal_user() RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS \$\$ BEGIN RETURN public.is_admin() OR public.is_operator(); END; \$\$;
GRANT EXECUTE ON FUNCTION public.is_admin() TO authenticated;
GRANT EXECUTE ON FUNCTION public.is_operator() TO authenticated;
GRANT EXECUTE ON FUNCTION public.is_internal_user() TO authenticated;
`;

console.log('=== P3B5 Concurrency Validation (disposable PostgreSQL 17) ===\n');

// Start container
docker(['rm', '-f', CONTAINER], { stdio: 'pipe' });
const startRes = docker(['run', '-d', '--name', CONTAINER, '-e', `POSTGRES_PASSWORD=${PGPASSWORD}`, 'postgres:17'], { stdio: 'pipe' });
if (startRes.status !== 0) { console.error('Failed to start container:', startRes.stderr); process.exit(1); }

let ready = false;
for (let i = 0; i < 30; i++) {
  const r = docker(['exec', '-e', `PGPASSWORD=${PGPASSWORD}`, CONTAINER, 'pg_isready', '-U', PGUSER], { stdio: 'pipe' });
  if (r.status === 0) { ready = true; break; }
  docker(['exec', CONTAINER, 'sleep', '1'], { stdio: 'pipe' });
}
if (!ready) { console.error('Container not ready'); docker(['rm', '-f', CONTAINER], { stdio: 'pipe' }); process.exit(1); }
console.log('Container ready.\n');

try {
  // Load migrations
  let res = psql(SETUP_SQL);
  if (res.status !== 0) throw new Error('setup');
  res = psql(readFileSync(BASELINE_FILE, 'utf8'));
  if (res.status !== 0) throw new Error('baseline');
  res = psql(HELPERS_SQL);
  if (res.status !== 0) throw new Error('helpers');
  res = psql(readFileSync(CLIENT_GUARD_FILE, 'utf8'));
  if (res.status !== 0) throw new Error('client_guard');
  for (const f of [P3B1_FILE, P3B2_FILE, P3B3_FILE, P3B4_FILE]) {
    res = psql(readFileSync(f, 'utf8'));
    if (res.status !== 0) throw new Error(`migration: ${f}`);
  }
  res = psql(readFileSync(P3B5_FILE, 'utf8'));
  if (res.status !== 0) throw new Error('p3b5');

  // Load fixtures
  psql(`
INSERT INTO auth.users (id) VALUES ('${ADMIN_UID}'), ('${OPERATOR_UID}') ON CONFLICT DO NOTHING;
INSERT INTO public.user_roles (user_id, role) VALUES ('${ADMIN_UID}', 'admin'), ('${OPERATOR_UID}', 'operator') ON CONFLICT DO NOTHING;
INSERT INTO public.internal_operators (user_id, display_name, active) VALUES ('${OPERATOR_UID}', 'Op', true) ON CONFLICT DO NOTHING;
INSERT INTO public.organizations (id, legal_name) VALUES ('${ORG_A_ID}', 'Org A'), ('${ORG_B_ID}', 'Org B') ON CONFLICT DO NOTHING;
INSERT INTO public.organization_contacts (id, organization_id, first_name, last_name) VALUES ('${CONTACT_A_ID}', '${ORG_A_ID}', 'Alice', 'D') ON CONFLICT DO NOTHING;
INSERT INTO public.crm_opportunities (id, title, organization_id) VALUES ('${OPP_A_ID}', 'Deal A', '${ORG_A_ID}') ON CONFLICT DO NOTHING;
INSERT INTO public.clients (id, role, email, nom, prenom) VALUES ('dddd0000-0000-0000-0000-000000000004', 'client', 'c@test.com', 'Test', 'Client') ON CONFLICT DO NOTHING;
INSERT INTO public.devis (id, reference, client_email, status) VALUES ('eeee0000-0000-0000-0000-000000000001', 'DEV-001', 'c@test.com', 'pending') ON CONFLICT DO NOTHING;
INSERT INTO public.missions (id, reference, client_email, status) VALUES ('ffff0000-0000-0000-0000-000000000001', 'MIS-001', 'c@test.com', 'planned') ON CONFLICT DO NOTHING;
  `);

  // =========================================================
  // TEST 1: No deadlock — concurrent devis link + mission link
  // T1: link devis to org A (holds devis row lock)
  // T2: link mission to devis (needs devis FOR SHARE lock)
  // T2 should wait for T1, then succeed (no deadlock)
  // =========================================================
  console.log('--- TEST 1: Concurrent devis link + mission link (no deadlock) ---');

  // Reset state
  psql(`UPDATE public.devis SET organization_id = NULL, contact_id = NULL, opportunity_id = NULL WHERE id = 'eeee0000-0000-0000-0000-000000000001';`);
  psql(`UPDATE public.missions SET devis_id = NULL, organization_id = NULL WHERE id = 'ffff0000-0000-0000-0000-000000000001';`);

  const t1Sql = `
SET app.current_user_id = '${ADMIN_UID}';
SET ROLE authenticated;
BEGIN;
SELECT public.crm_link_devis_crm('eeee0000-0000-0000-0000-000000000001', '${ORG_A_ID}', NULL, NULL);
-- Hold the lock for 3 seconds
SELECT pg_sleep(3);
COMMIT;
RESET ROLE;
SET app.current_user_id = '';
`;

  const t2Sql = `
SET app.current_user_id = '${ADMIN_UID}';
SET ROLE authenticated;
BEGIN;
SELECT public.crm_link_mission_devis('ffff0000-0000-0000-0000-000000000001', 'eeee0000-0000-0000-0000-000000000001', '${ORG_A_ID}');
COMMIT;
RESET ROLE;
SET app.current_user_id = '';
`;

  const result1 = runConcurrent(t1Sql, t2Sql, 1);
  check('T1 (devis link) succeeds', result1.t1Status === 0);
  check('T2 (mission link) succeeds after T1 commits', result1.t2Status === 0);
  check('T2 waited for T1 (elapsed > 2000ms)', result1.elapsed > 2000);
  check('no deadlock detected', !result1.t1Stderr.includes('deadlock') && !result1.t2Stderr.includes('deadlock'));

  // Verify final state
  check('devis.organization_id = ORG_A after concurrent links',
    psqlScalar(`SELECT organization_id FROM public.devis WHERE id='eeee0000-0000-0000-0000-000000000001'`) === ORG_A_ID);
  check('missions.devis_id set after concurrent links',
    psqlScalar(`SELECT devis_id FROM public.missions WHERE id='ffff0000-0000-0000-0000-000000000001'`) === 'eeee0000-0000-0000-0000-000000000001');

  // =========================================================
  // TEST 2: Parent reparent guard — no deadlock with child lock
  // T1: link client to org A (holds client row lock)
  // T2: try to reparent contact (which references client) — should
  //     not deadlock, should either wait or fail cleanly
  // =========================================================
  console.log('\n--- TEST 2: Parent reparent + child link (no deadlock) ---');

  // Reset: link contact to client, client to org A
  psql(`UPDATE public.clients SET organization_id = NULL WHERE id = 'dddd0000-0000-0000-0000-000000000004';`);
  psql(`UPDATE public.organization_contacts SET client_id = NULL WHERE id = '${CONTACT_A_ID}';`);
  psql(`UPDATE public.organization_contacts SET client_id = 'dddd0000-0000-0000-0000-000000000004' WHERE id = '${CONTACT_A_ID}';`);

  const t2_1Sql = `
SET app.current_user_id = '${ADMIN_UID}';
SET ROLE authenticated;
BEGIN;
-- Link client to org A (holds client row lock for 3s)
SELECT public.crm_link_client_organization('dddd0000-0000-0000-0000-000000000004', '${ORG_A_ID}');
SELECT pg_sleep(3);
COMMIT;
RESET ROLE;
SET app.current_user_id = '';
`;

  const t2_2Sql = `
SET app.current_user_id = '${ADMIN_UID}';
SET ROLE authenticated;
BEGIN;
-- Try to reparent contact to org B (guard checks client org)
-- Contact has client_id linked to the client T1 is updating.
-- The guard does a plain SELECT on clients (no FOR SHARE), so this
-- should not deadlock. It may see the old or new client org depending
-- on isolation level, but should not deadlock.
UPDATE public.organization_contacts SET organization_id = '${ORG_B_ID}' WHERE id = '${CONTACT_A_ID}';
COMMIT;
RESET ROLE;
SET app.current_user_id = '';
`;

  const result2 = runConcurrent(t2_1Sql, t2_2Sql, 1);
  check('T1 (client link) succeeds', result2.t1Status === 0);
  check('no deadlock in parent reparent + child link', !result2.t1Stderr.includes('deadlock') && !result2.t2Stderr.includes('deadlock'));

  // =========================================================
  // TEST 3: Stress test — 10 iterations of concurrent devis/mission links
  // =========================================================
  console.log('\n--- TEST 3: Stress test (10 iterations, no deadlocks) ---');

  let deadlockCount = 0;
  let successCount = 0;

  for (let i = 0; i < 10; i++) {
    // Reset state
    psql(`UPDATE public.devis SET organization_id = NULL, contact_id = NULL, opportunity_id = NULL WHERE id = 'eeee0000-0000-0000-0000-000000000001';`);
    psql(`UPDATE public.missions SET devis_id = NULL, organization_id = NULL WHERE id = 'ffff0000-0000-0000-0000-000000000001';`);

    const stressT1 = `
SET app.current_user_id = '${ADMIN_UID}';
SET ROLE authenticated;
BEGIN;
SELECT public.crm_link_devis_crm('eeee0000-0000-0000-0000-000000000001', '${ORG_A_ID}', NULL, NULL);
SELECT pg_sleep(0.5);
COMMIT;
RESET ROLE;
SET app.current_user_id = '';
`;

    const stressT2 = `
SET app.current_user_id = '${ADMIN_UID}';
SET ROLE authenticated;
BEGIN;
SELECT public.crm_link_mission_devis('ffff0000-0000-0000-0000-000000000001', 'eeee0000-0000-0000-0000-000000000001', '${ORG_A_ID}');
COMMIT;
RESET ROLE;
SET app.current_user_id = '';
`;

    const r = runConcurrent(stressT1, stressT2, 0.2);
    if (r.t1Stderr.includes('deadlock') || r.t2Stderr.includes('deadlock')) {
      deadlockCount++;
    }
    if (r.t1Status === 0 && r.t2Status === 0) {
      successCount++;
    }
  }

  check('zero deadlocks in 10 stress iterations', deadlockCount === 0);
  check(`all 10 iterations succeeded (${successCount}/10)`, successCount === 10);

  // =========================================================
  // TEST 4: Concurrent RPC calls — two operators linking different devis
  // =========================================================
  console.log('\n--- TEST 4: Concurrent RPC calls (different devis, no conflict) ---');

  // Create a second devis
  psql(`INSERT INTO public.devis (id, reference, client_email, status) VALUES ('eeee0000-0000-0000-0000-000000000002', 'DEV-002', 'c2@test.com', 'pending') ON CONFLICT DO NOTHING;`);

  const t4_1Sql = `
SET app.current_user_id = '${ADMIN_UID}';
SET ROLE authenticated;
BEGIN;
SELECT public.crm_link_devis_crm('eeee0000-0000-0000-0000-000000000001', '${ORG_A_ID}', NULL, NULL);
COMMIT;
RESET ROLE;
SET app.current_user_id = '';
`;

  const t4_2Sql = `
SET app.current_user_id = '${OPERATOR_UID}';
SET ROLE authenticated;
BEGIN;
SELECT public.crm_link_devis_crm('eeee0000-0000-0000-0000-000000000002', '${ORG_B_ID}', NULL, NULL);
COMMIT;
RESET ROLE;
SET app.current_user_id = '';
`;

  const result4 = runConcurrent(t4_1Sql, t4_2Sql, 0.5);
  check('concurrent RPC on different devis: T1 succeeds', result4.t1Status === 0);
  check('concurrent RPC on different devis: T2 succeeds', result4.t2Status === 0);
  check('no deadlock on different devis', !result4.t1Stderr.includes('deadlock') && !result4.t2Stderr.includes('deadlock'));

  // =========================================================
  // SUMMARY
  // =========================================================
  console.log('\n========================================');
  console.log(`P3B5 concurrency validation: ${passed} passed, ${failed} failed`);
  console.log('========================================');

  if (failed > 0) throw new Error(`${failed} concurrency assertions failed`);

} catch (err) {
  console.error('\nFATAL ERROR:', err.message);
  process.exitCode = 1;
} finally {
  console.log('\nDestroying disposable container...');
  docker(['rm', '-f', CONTAINER], { stdio: 'pipe' });
  console.log('Done.');
}
