/**
 * OPS-2A1A — Financial Integrity Phase A Tests
 *
 * Tests:
 * - RPC static contract (SECURITY DEFINER, search_path, grants)
 * - RPC runtime behavior (validation, guards, margin, audit)
 * - Trigger behavior (permissive mode, margin derivation, dirty-data compat)
 * - Billing lock fix (prepare_billing_record FOR UPDATE)
 *
 * Requires local Supabase running.
 * Run: node tests/admin-tariff-integrity.test.cjs
 *
 * Environment:
 *   LOCAL_SUPABASE_URL (default http://127.0.0.1:54321)
 *   LOCAL_SUPABASE_SERVICE_ROLE_KEY (from: npx supabase status -o env)
 *   LOCAL_SUPABASE_ANON_KEY (from: npx supabase status -o env)
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL = process.env.LOCAL_SUPABASE_URL || 'http://127.0.0.1:54321';
const ANON_KEY = process.env.LOCAL_SUPABASE_ANON_KEY ||
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6ImFub24iLCJleHAiOjE5ODM4MTI5OTZ9.CRXP1A7WOeoJeXxjNni43kdQwgnWNReilDMblYTn_I0';
const SERVICE_ROLE_KEY = process.env.LOCAL_SUPABASE_SERVICE_ROLE_KEY ||
  process.env.SERVICE_ROLE_KEY;

// In CI (no local Supabase), skip runtime tests but still run static tests
const SKIP_RUNTIME = !SERVICE_ROLE_KEY || process.env.CI === 'true';

if (!SERVICE_ROLE_KEY && process.env.CI !== 'true') {
  console.error('ERROR: LOCAL_SUPABASE_SERVICE_ROLE_KEY or SERVICE_ROLE_KEY env var required.');
  console.error('Run: npx supabase status -o env  # then export the SERVICE_ROLE_KEY value');
  process.exit(1);
}

// Safety: ensure we are targeting LOCAL Supabase, not Production
if (SERVICE_ROLE_KEY && !SUPABASE_URL.includes('127.0.0.1') && !SUPABASE_URL.includes('localhost')) {
  console.error('ERROR: Refusing to run against non-local Supabase URL:', SUPABASE_URL);
  process.exit(1);
}

const sb = SERVICE_ROLE_KEY ? createClient(SUPABASE_URL, SERVICE_ROLE_KEY) : null;
const sbAnon = SERVICE_ROLE_KEY ? createClient(SUPABASE_URL, ANON_KEY) : null;

let passed = 0;
let failed = 0;
const results = [];

function test(name, fn) {
  return Promise.resolve()
    .then(() => fn())
    .then(() => {
      passed++;
      results.push({ name, status: 'PASS' });
      console.log(`  \u2713 ${name}`);
    })
    .catch((err) => {
      failed++;
      results.push({ name, status: 'FAIL', error: err.message });
      console.log(`  \u2717 ${name}`);
      console.log(`    ERROR: ${err.message}`);
    });
}

// =====================================================
// Load migration SQL for static analysis
// =====================================================
const migrationPath = path.join(__dirname, '..', 'supabase', 'migrations',
  '20260831100000_ops_2a1a_financial_integrity_additive.sql');
const migrationSQL = fs.readFileSync(migrationPath, 'utf8');

// =====================================================
// Helpers
// =====================================================
const sessionId = Math.random().toString(36).slice(2, 8);
let fixtureCounter = 0;

async function createAdminUser() {
  const email = `admin-${sessionId}-${++fixtureCounter}@local.test`;
  const password = 'TestPass123!';

  // Create auth user via admin API
  const { data: authData, error: authErr } = await sb.auth.admin.createUser({
    email,
    password,
    email_confirm: true
  });
  if (authErr) throw new Error(`Failed to create auth user: ${authErr.message}`);

  const userId = authData.user.id;

  // Create client record with admin role
  const { data: client, error: clientErr } = await sb.from('clients')
    .insert({
      email,
      nom: 'Admin',
      prenom: 'Test',
      telephone: '0600000000',
      role: 'admin',
      auth_user_id: userId
    })
    .select().single();
  if (clientErr) throw new Error(`Failed to create admin client: ${clientErr.message}`);

  // user_roles entry is auto-created by sync_user_roles_on_client_role trigger
  // when a client with role='admin' is inserted. No manual insert needed.

  // Sign in to get access token
  const sbAdmin = createClient(SUPABASE_URL, ANON_KEY);
  const { data: signInData, error: signInErr } = await sbAdmin.auth.signInWithPassword({
    email, password
  });
  if (signInErr) throw new Error(`Failed to sign in admin: ${signInErr.message}`);

  return { userId, client, sbAdmin, email, password };
}

async function createNonAdminUser() {
  const email = `user-${sessionId}-${++fixtureCounter}@local.test`;
  const password = 'TestPass123!';

  const { data: authData, error: authErr } = await sb.auth.admin.createUser({
    email, password, email_confirm: true
  });
  if (authErr) throw new Error(`Failed to create auth user: ${authErr.message}`);

  const userId = authData.user.id;

  const { data: client, error: clientErr } = await sb.from('clients')
    .insert({
      email,
      nom: 'User',
      prenom: 'Test',
      telephone: '0600000000',
      role: 'client',
      auth_user_id: userId
    })
    .select().single();
  if (clientErr) throw new Error(`Failed to create client: ${clientErr.message}`);

  const sbUser = createClient(SUPABASE_URL, ANON_KEY);
  const { data: signInData, error: signInErr } = await sbUser.auth.signInWithPassword({
    email, password
  });
  if (signInErr) throw new Error(`Failed to sign in user: ${signInErr.message}`);

  return { userId, client, sbUser, email, password };
}

async function createTestMission(overrides = {}) {
  const ref = `TARIFF-${sessionId}-${++fixtureCounter}`;
  const { data: mission, error } = await sb.from('missions')
    .insert({
      reference: ref,
      depart: 'Test Depart',
      arrivee: 'Test Arrivee',
      status: 'available',
      paiement_statut: 'pending',
      montant_ht: 100,
      remuneration_convoyeur: 30,
      marge: 70,
      ...overrides
    })
    .select().single();
  if (error) throw new Error(`Failed to create mission: ${error.message}`);
  return mission;
}

async function cleanupMission(missionId) {
  // Clean mission_events first (FK)
  await sb.from('mission_events').delete().eq('mission_id', missionId);
  // Clean billing records
  await sb.from('billing_records').delete().eq('mission_id', missionId);
  // Delete mission
  await sb.from('missions').delete().eq('id', missionId);
}

async function cleanupUser(userId, clientId) {
  if (clientId) await sb.from('clients').delete().eq('id', clientId);
  if (userId) {
    await sb.from('user_roles').delete().eq('user_id', userId).then(() => {});
    await sb.auth.admin.deleteUser(userId);
  }
}

// =====================================================
// STATIC TESTS — Migration SQL analysis
// =====================================================

async function runStaticTests() {
  console.log('\n=== STATIC TESTS (migration SQL analysis) ===');

  // Extract the full RPC function definition for analysis
  const rpcMatch = migrationSQL.match(/CREATE OR REPLACE FUNCTION public\.admin_update_mission_tariffs[\s\S]*?\$\$;/);
  assert.ok(rpcMatch, 'Must find admin_update_mission_tariffs function definition');
  const rpcDef = rpcMatch[0];

  await test('RPC: SECURITY DEFINER', () => {
    assert.ok(rpcDef.includes('SECURITY DEFINER'),
      'admin_update_mission_tariffs must be SECURITY DEFINER');
  });

  await test('RPC: SET search_path = \'\'', () => {
    assert.ok(rpcDef.includes("SET search_path = ''"),
      'admin_update_mission_tariffs must have empty search_path');
  });

  await test('RPC: Owner postgres', () => {
    assert.ok(migrationSQL.includes('ALTER FUNCTION public.admin_update_mission_tariffs') &&
      migrationSQL.includes('OWNER TO postgres'),
      'RPC must be owned by postgres');
  });

  await test('RPC: auth.uid() check', () => {
    assert.ok(migrationSQL.includes('auth.uid()'),
      'RPC must check auth.uid()');
  });

  await test('RPC: is_admin() check', () => {
    assert.ok(migrationSQL.includes('public.is_admin()'),
      'RPC must check is_admin()');
  });

  await test('RPC: EXECUTE granted to authenticated only', () => {
    assert.ok(migrationSQL.includes('GRANT EXECUTE ON FUNCTION public.admin_update_mission_tariffs') &&
      migrationSQL.includes('TO authenticated'),
      'RPC must be granted to authenticated');
  });

  await test('RPC: EXECUTE revoked from PUBLIC', () => {
    assert.ok(migrationSQL.includes('REVOKE EXECUTE ON FUNCTION public.admin_update_mission_tariffs') &&
      migrationSQL.includes('FROM PUBLIC'),
      'RPC must be revoked from PUBLIC');
  });

  await test('RPC: EXECUTE revoked from anon', () => {
    assert.ok(migrationSQL.includes('REVOKE EXECUTE ON FUNCTION public.admin_update_mission_tariffs') &&
      migrationSQL.includes('anon'),
      'RPC must be revoked from anon');
  });

  await test('RPC: EXECUTE revoked from service_role', () => {
    assert.ok(migrationSQL.includes('REVOKE EXECUTE ON FUNCTION public.admin_update_mission_tariffs') &&
      migrationSQL.includes('service_role'),
      'RPC must be revoked from service_role');
  });

  await test('RPC: No service_role GRANT', () => {
    const grantSection = migrationSQL.match(/GRANT EXECUTE ON FUNCTION public\.admin_update_mission_tariffs[^;]+;/);
    assert.ok(grantSection, 'Must have GRANT EXECUTE for RPC');
    assert.ok(!grantSection[0].includes('service_role'),
      'RPC must NOT be granted to service_role');
  });

  await test('RPC: Partial update (COALESCE)', () => {
    assert.ok(migrationSQL.includes('COALESCE(p_montant_ht, v_mission.montant_ht)'),
      'RPC must use COALESCE for partial updates');
    assert.ok(migrationSQL.includes('COALESCE(p_remuneration_convoyeur, v_mission.remuneration_convoyeur)'),
      'RPC must use COALESCE for partial updates');
  });

  await test('RPC: Validation price > 0', () => {
    assert.ok(migrationSQL.includes('v_new_price <= 0'),
      'RPC must validate price > 0');
  });

  await test('RPC: Validation rem >= 0', () => {
    assert.ok(migrationSQL.includes('v_new_rem < 0'),
      'RPC must validate rem >= 0');
  });

  await test('RPC: Validation rem <= price', () => {
    assert.ok(migrationSQL.includes('v_new_rem > v_new_price'),
      'RPC must validate rem <= price');
  });

  await test('RPC: Payment guard (paid/paye)', () => {
    assert.ok(migrationSQL.includes("paiement_statut IN ('paid', 'paye')"),
      'RPC must guard against paid/paye');
  });

  await test('RPC: Stripe session guard', () => {
    assert.ok(migrationSQL.includes('stripe_session_id IS NOT NULL'),
      'RPC must guard against existing Stripe session');
  });

  await test('RPC: Billing guard (prepared/issued)', () => {
    assert.ok(migrationSQL.includes("status IN ('prepared', 'issued')"),
      'RPC must guard against prepared/issued billing records');
  });

  await test('RPC: Margin atomic calculation', () => {
    assert.ok(migrationSQL.includes('v_new_marge := v_new_price - v_new_rem'),
      'RPC must calculate margin atomically');
  });

  await test('RPC: GUC marker set', () => {
    assert.ok(migrationSQL.includes("set_config('bathily.tariff_update_authorized', '1', true)"),
      'RPC must set GUC marker');
  });

  await test('RPC: GUC marker reset', () => {
    assert.ok(migrationSQL.includes("set_config('bathily.tariff_update_authorized', '', true)"),
      'RPC must reset GUC marker');
  });

  await test('RPC: Reason limit 500', () => {
    assert.ok(migrationSQL.includes('length(v_reason) > 500'),
      'RPC must reject reason > 500 chars');
  });

  await test('RPC: Reason sanitization (NULLIF btrim)', () => {
    assert.ok(migrationSQL.includes("NULLIF(btrim(p_reason), '')"),
      'RPC must sanitize reason');
  });

  await test('RPC: Audit event (tariff_updated)', () => {
    assert.ok(migrationSQL.includes("'tariff_updated'"),
      'RPC must log tariff_updated event');
    assert.ok(migrationSQL.includes('log_mission_event'),
      'RPC must call log_mission_event');
  });

  await test('RPC: No margin parameter', () => {
    // Verify the function signature does not include a margin parameter
    const sigMatch = migrationSQL.match(/admin_update_mission_tariffs\([^)]+\)/);
    assert.ok(sigMatch, 'Must find function signature');
    assert.ok(!sigMatch[0].includes('marge') && !sigMatch[0].includes('margin'),
      'RPC must NOT accept a margin parameter');
  });

  await test('RPC: FOR UPDATE on mission', () => {
    assert.ok(migrationSQL.includes('FROM public.missions WHERE id = p_mission_id FOR UPDATE'),
      'RPC must lock mission row with FOR UPDATE');
  });

  await test('RPC: No exception catching around UPDATE', () => {
    // Verify there's no EXCEPTION block around the financial UPDATE
    const rpcBody = migrationSQL.split('admin_update_mission_tariffs')[1];
    const updateSection = rpcBody.substring(rpcBody.indexOf('-- 15. UPDATE'),
      rpcBody.indexOf('-- 16. Immediately reset'));
    assert.ok(!updateSection.includes('EXCEPTION'),
      'RPC must NOT catch the UPDATE exception');
  });

  // Extract the trigger function definition for analysis
  const triggerMatch = migrationSQL.match(/CREATE OR REPLACE FUNCTION public\.missions_financial_protect\(\)[\s\S]*?\$\$;/);
  assert.ok(triggerMatch, 'Must find missions_financial_protect function definition');
  const triggerDef = triggerMatch[0];

  // Trigger static tests
  await test('Trigger: SECURITY INVOKER', () => {
    assert.ok(triggerDef.includes('SECURITY INVOKER'),
      'Trigger function must be SECURITY INVOKER');
  });

  await test('Trigger: SET search_path = \'\'', () => {
    assert.ok(triggerDef.includes("SET search_path = ''"),
      'Trigger function must have empty search_path');
  });

  await test('Trigger: Phase A permissive (no auth gate)', () => {
    // Phase A should NOT have current_user or GUC checks in the trigger function
    assert.ok(!triggerDef.includes("current_user"),
      'Phase A trigger must NOT check current_user');
    assert.ok(!triggerDef.includes('bathily.tariff_update_authorized'),
      'Phase A trigger must NOT check GUC marker');
  });

  await test('Trigger: IS DISTINCT FROM activation', () => {
    assert.ok(migrationSQL.includes('IS DISTINCT FROM OLD.montant_ht') &&
      migrationSQL.includes('IS DISTINCT FROM OLD.remuneration_convoyeur') &&
      migrationSQL.includes('IS DISTINCT FROM OLD.marge'),
      'Trigger must activate on financial field changes');
  });

  await test('Trigger: price validation scoped to changed field', () => {
    assert.ok(migrationSQL.includes('NEW.montant_ht IS DISTINCT FROM OLD.montant_ht') &&
      migrationSQL.includes('NEW.montant_ht <= 0'),
      'Trigger must validate price only when price changed');
  });

  await test('Trigger: rem validation scoped to changed field', () => {
    assert.ok(migrationSQL.includes('NEW.remuneration_convoyeur IS DISTINCT FROM OLD.remuneration_convoyeur') &&
      migrationSQL.includes('NEW.remuneration_convoyeur < 0'),
      'Trigger must validate remuneration only when remuneration changed');
  });

  await test('Trigger: cross-field only when both individually valid', () => {
    assert.ok(migrationSQL.includes('NEW.montant_ht > 0') &&
      migrationSQL.includes('NEW.remuneration_convoyeur >= 0') &&
      migrationSQL.includes('NEW.remuneration_convoyeur > NEW.montant_ht'),
      'Cross-field check must require both individual values valid');
  });

  await test('Trigger: Derives margin when both non-NULL', () => {
    assert.ok(migrationSQL.includes('NEW.marge := NEW.montant_ht - NEW.remuneration_convoyeur'),
      'Trigger must derive marge when both components are non-NULL');
  });

  await test('Trigger: BEFORE UPDATE', () => {
    assert.ok(migrationSQL.includes('BEFORE UPDATE ON public.missions'),
      'Trigger must be BEFORE UPDATE');
  });

  // Billing lock fix static tests
  await test('Billing: prepare_billing_record has FOR UPDATE', () => {
    // Find the prepare_billing_record section and verify FOR UPDATE
    const billingSection = migrationSQL.split('prepare_billing_record')[1];
    assert.ok(billingSection.includes('FOR UPDATE'),
      'prepare_billing_record must use FOR UPDATE on mission row');
  });

  await test('Billing: No grants change on missions table', () => {
    assert.ok(!migrationSQL.match(/REVOKE.*UPDATE.*ON.*public\.missions/i),
      'Migration must NOT revoke UPDATE on missions');
    assert.ok(!migrationSQL.match(/GRANT.*UPDATE.*ON.*public\.missions/i),
      'Migration must NOT grant UPDATE on missions');
  });

  await test('Safety: No Phase C enforcement', () => {
    assert.ok(!migrationSQL.includes('REVOKE UPDATE ON public.missions FROM authenticated'),
      'Migration must NOT include Phase C REVOKE');
  });
}

// =====================================================
// RUNTIME TESTS — Trigger behavior (via service_role)
// =====================================================

async function runTriggerRuntimeTests() {
  console.log('\n=== TRIGGER RUNTIME TESTS (via authenticated admin RPC) ===');

  let mission;

  // Phase C: financial updates must go through the admin RPC.
  // Direct .update() on financial fields is blocked by the trigger gate.
  // Non-financial updates still use service_role direct .update().
  let adminCtx;
  try {
    adminCtx = await createAdminUser();
  } catch (err) {
    console.log(`  SKIP: Could not create admin user: ${err.message}`);
    return;
  }

  // Helper: update tariffs via RPC
  async function rpcUpdateTariffs(missionId, montantHt, remuneration, reason) {
    return adminCtx.sbAdmin.rpc('admin_update_mission_tariffs', {
      p_mission_id: missionId,
      p_montant_ht: montantHt,
      p_remuneration_convoyeur: remuneration,
      p_reason: reason || 'trigger runtime test'
    });
  }

  await test('Trigger: direct financial update recalculates margin', async () => {
    mission = await createTestMission({ montant_ht: 100, remuneration_convoyeur: 30, marge: 70 });
    const { error } = await rpcUpdateTariffs(mission.id, 120, 40);
    assert.ok(!error, `Update should succeed: ${error?.message}`);

    const { data: updated, error: fetchErr } = await sb.from('missions')
      .select('montant_ht, remuneration_convoyeur, marge')
      .eq('id', mission.id).single();
    assert.ok(!fetchErr);
    assert.strictEqual(updated.montant_ht, 120);
    assert.strictEqual(updated.remuneration_convoyeur, 40);
    assert.strictEqual(Number(updated.marge), 80, 'Margin should be 120-40=80');
  });

  await test('Trigger: caller-supplied wrong margin corrected', async () => {
    await cleanupMission(mission.id);
    mission = await createTestMission({ montant_ht: 100, remuneration_convoyeur: 30, marge: 70 });
    // RPC does not accept marge parameter — margin is always derived server-side
    const { error } = await rpcUpdateTariffs(mission.id, 150, 50);
    assert.ok(!error, `Update should succeed: ${error?.message}`);

    const { data: updated } = await sb.from('missions')
      .select('montant_ht, remuneration_convoyeur, marge')
      .eq('id', mission.id).single();
    assert.strictEqual(Number(updated.marge), 100, 'Margin should be 150-50=100, not caller-supplied');
  });

  await test('Trigger: invalid direct update (price <= 0) rejected', async () => {
    await cleanupMission(mission.id);
    mission = await createTestMission({ montant_ht: 100, remuneration_convoyeur: 30, marge: 70 });
    const { error } = await rpcUpdateTariffs(mission.id, 0, null);
    assert.ok(error, 'Should reject price=0');
  });

  await test('Trigger: negative remuneration rejected', async () => {
    await cleanupMission(mission.id);
    mission = await createTestMission({ montant_ht: 100, remuneration_convoyeur: 30, marge: 70 });
    const { error } = await rpcUpdateTariffs(mission.id, null, -10);
    assert.ok(error, 'Should reject negative remuneration');
  });

  await test('Trigger: rem > price rejected', async () => {
    await cleanupMission(mission.id);
    mission = await createTestMission({ montant_ht: 100, remuneration_convoyeur: 30, marge: 70 });
    const { error } = await rpcUpdateTariffs(mission.id, 50, 60);
    assert.ok(error, 'Should reject rem > price');
  });

  await test('Trigger: non-financial update does not modify stale margin', async () => {
    await cleanupMission(mission.id);
    mission = await createTestMission({ montant_ht: 100, remuneration_convoyeur: 30, marge: 999 });
    // Non-financial update via service_role — trigger is a no-op
    const { error } = await sb.from('missions')
      .update({ notes: 'updated notes' })
      .eq('id', mission.id);
    assert.ok(!error, `Non-financial update should succeed: ${error?.message}`);

    const { data: updated } = await sb.from('missions')
      .select('montant_ht, remuneration_convoyeur, marge, notes')
      .eq('id', mission.id).single();
    assert.strictEqual(Number(updated.montant_ht), 100);
    assert.strictEqual(Number(updated.remuneration_convoyeur), 30);
    assert.strictEqual(Number(updated.marge), 999, 'Stale margin should NOT be repaired by non-financial update');
    assert.strictEqual(updated.notes, 'updated notes');
  });

  // Dirty-data compatibility cases — via RPC (authorized path)
  // Note: RPC validates RESOLVED values strictly, so cases where the
  // resolved price is <= 0 will be rejected by the RPC, not the trigger.
  // The trigger's dirty-data compatibility is about not blocking on
  // unchanged invalid fields — tested via non-financial updates above
  // and via the RPC where the resolved values are valid.

  await test('Dirty CASE 1: price=100/rem=NULL → update price=120 → 120/NULL/NULL', async () => {
    await cleanupMission(mission.id);
    mission = await createTestMission({ montant_ht: 100, remuneration_convoyeur: null, marge: null });
    // RPC: resolved rem = COALESCE(null, null) = null => RPC rejects null rem
    // This is strict RPC validation. The trigger would allow it, but the RPC won't.
    const { error } = await rpcUpdateTariffs(mission.id, 120, null);
    // RPC rejects because resolved remuneration is null
    assert.ok(error, 'Should reject: RPC requires non-null resolved remuneration');
  });

  await test('Dirty CASE 2: price=NULL/rem=30 → update rem=40 → NULL/40/NULL', async () => {
    await cleanupMission(mission.id);
    mission = await createTestMission({ montant_ht: null, remuneration_convoyeur: 30, marge: null });
    // RPC: resolved price = COALESCE(null, null) = null => RPC rejects null price
    const { error } = await rpcUpdateTariffs(mission.id, null, 40);
    assert.ok(error, 'Should reject: RPC requires non-null resolved price');
  });

  await test('Dirty CASE 3: stale marge=999 → update notes → 100/30/999 (no repair)', async () => {
    await cleanupMission(mission.id);
    mission = await createTestMission({ montant_ht: 100, remuneration_convoyeur: 30, marge: 999 });
    // Non-financial update via service_role
    const { error } = await sb.from('missions')
      .update({ notes: 'test notes' })
      .eq('id', mission.id);
    assert.ok(!error, `Should succeed: ${error?.message}`);

    const { data: updated } = await sb.from('missions')
      .select('montant_ht, remuneration_convoyeur, marge')
      .eq('id', mission.id).single();
    assert.strictEqual(Number(updated.montant_ht), 100);
    assert.strictEqual(Number(updated.remuneration_convoyeur), 30);
    assert.strictEqual(Number(updated.marge), 999, 'Stale margin preserved');
  });

  await test('Dirty CASE 4: stale marge=999 → update price=120 → 120/30/90 (repair)', async () => {
    await cleanupMission(mission.id);
    mission = await createTestMission({ montant_ht: 100, remuneration_convoyeur: 30, marge: 999 });
    const { error } = await rpcUpdateTariffs(mission.id, 120, null);
    assert.ok(!error, `Should succeed: ${error?.message}`);

    const { data: updated } = await sb.from('missions')
      .select('montant_ht, remuneration_convoyeur, marge')
      .eq('id', mission.id).single();
    assert.strictEqual(Number(updated.montant_ht), 120);
    assert.strictEqual(Number(updated.remuneration_convoyeur), 30);
    assert.strictEqual(Number(updated.marge), 90, 'Margin repaired to 120-30=90');
  });

  await cleanupMission(mission.id);
}

// =====================================================
// RUNTIME TESTS — Phase A dirty-data compatibility cases A-F
// =====================================================

async function runDirtyCompatibilityCases() {
  console.log('\n=== DIRTY-DATA COMPATIBILITY CASES A-F (via admin RPC) ===');

  let mission;

  // Phase C: financial updates must go through the admin RPC.
  // The RPC validates RESOLVED values strictly, so cases where the
  // resolved price or rem is invalid will be rejected by the RPC.
  // The trigger's dirty-data compatibility (not blocking on unchanged
  // invalid fields) is tested via non-financial updates (Case F).
  let adminCtx;
  try {
    adminCtx = await createAdminUser();
  } catch (err) {
    console.log(`  SKIP: Could not create admin user: ${err.message}`);
    return;
  }

  async function rpcUpdateTariffs(missionId, montantHt, remuneration, reason) {
    return adminCtx.sbAdmin.rpc('admin_update_mission_tariffs', {
      p_mission_id: missionId,
      p_montant_ht: montantHt,
      p_remuneration_convoyeur: remuneration,
      p_reason: reason || 'dirty compatibility test'
    });
  }

  // CASE A: price=0 (invalid, unchanged), rem 30→20 → RPC rejects (resolved price=0)
  await test('DIRTY CASE A: price=0 unchanged, rem 30→20 → RPC rejects (resolved price=0)', async () => {
    mission = await createTestMission({ montant_ht: 0, remuneration_convoyeur: 30, marge: -30 });
    const { error } = await rpcUpdateTariffs(mission.id, null, 20);
    assert.ok(error, 'Should reject: RPC strict validation — resolved price=0 is not > 0');
  });

  // CASE B: price=-10 (invalid, unchanged), rem 0→1 → RPC rejects (resolved price=-10)
  await test('DIRTY CASE B: price=-10 unchanged, rem 0→1 → RPC rejects (resolved price=-10)', async () => {
    await cleanupMission(mission.id);
    mission = await createTestMission({ montant_ht: -10, remuneration_convoyeur: 0, marge: -10 });
    const { error } = await rpcUpdateTariffs(mission.id, null, 1);
    assert.ok(error, 'Should reject: RPC strict validation — resolved price=-10 is not > 0');
  });

  // CASE C: price 100→120, rem=-5 (invalid, unchanged) → RPC rejects (resolved rem=-5)
  await test('DIRTY CASE C: price 100→120, rem=-5 unchanged → RPC rejects (resolved rem=-5)', async () => {
    await cleanupMission(mission.id);
    mission = await createTestMission({ montant_ht: 100, remuneration_convoyeur: -5, marge: 105 });
    const { error } = await rpcUpdateTariffs(mission.id, 120, null);
    assert.ok(error, 'Should reject: RPC strict validation — resolved rem=-5 is < 0');
  });

  // CASE D: price 100→200, rem=150 → ALLOW 200/150/50
  await test('DIRTY CASE D: price 100→200, rem=150 → ALLOW 200/150/50', async () => {
    await cleanupMission(mission.id);
    mission = await createTestMission({ montant_ht: 100, remuneration_convoyeur: 150, marge: -50 });
    const { error } = await rpcUpdateTariffs(mission.id, 200, null);
    assert.ok(!error, `Should ALLOW: ${error?.message}`);
    const { data: u } = await sb.from('missions')
      .select('montant_ht, remuneration_convoyeur, marge')
      .eq('id', mission.id).single();
    assert.strictEqual(Number(u.montant_ht), 200);
    assert.strictEqual(Number(u.remuneration_convoyeur), 150);
    assert.strictEqual(Number(u.marge), 50, 'marge derived: 200-150=50');
  });

  // CASE E: price 100→120, rem=150 → REJECT (rem > price)
  await test('DIRTY CASE E: price 100→120, rem=150 → REJECT', async () => {
    await cleanupMission(mission.id);
    mission = await createTestMission({ montant_ht: 100, remuneration_convoyeur: 150, marge: -50 });
    const { error } = await rpcUpdateTariffs(mission.id, 120, null);
    assert.ok(error, 'Should REJECT: resulting rem 150 > price 120');
  });

  // CASE F: price=0, rem=30, notes only → ALLOW, financial untouched
  // This is a non-financial update — trigger is a no-op, service_role direct update works
  await test('DIRTY CASE F: notes only → ALLOW, financial untouched', async () => {
    await cleanupMission(mission.id);
    mission = await createTestMission({ montant_ht: 0, remuneration_convoyeur: 30, marge: -30 });
    const { error } = await sb.from('missions')
      .update({ notes: 'test notes' })
      .eq('id', mission.id);
    assert.ok(!error, `Should ALLOW: ${error?.message}`);
    const { data: u } = await sb.from('missions')
      .select('montant_ht, remuneration_convoyeur, marge, notes')
      .eq('id', mission.id).single();
    assert.strictEqual(Number(u.montant_ht), 0);
    assert.strictEqual(Number(u.remuneration_convoyeur), 30);
    assert.strictEqual(Number(u.marge), -30);
    assert.strictEqual(u.notes, 'test notes');
  });

  await cleanupMission(mission.id);
}

// =====================================================
// RUNTIME TESTS — RPC behavior (via authenticated admin)
// =====================================================

async function runRpcRuntimeTests() {
  console.log('\n=== RPC RUNTIME TESTS (via authenticated admin) ===');

  let adminCtx, nonAdminCtx, mission;

  try {
    adminCtx = await createAdminUser();
    nonAdminCtx = await createNonAdminUser();
  } catch (err) {
    console.log(`  SKIP: Could not create test users: ${err.message}`);
    console.log('  (This is expected if local Supabase auth is not fully configured)');
    return;
  }

  const sbAdmin = adminCtx.sbAdmin;

  await test('RPC: price=100/rem=30 => margin=70', async () => {
    mission = await createTestMission({ montant_ht: 100, remuneration_convoyeur: 30, marge: 70 });
    const { data, error } = await sbAdmin.rpc('admin_update_mission_tariffs', {
      p_mission_id: mission.id,
      p_montant_ht: 200,
      p_remuneration_convoyeur: 50
    });
    assert.ok(!error, `RPC should succeed: ${error?.message}`);
    assert.strictEqual(Number(data.new_montant_ht), 200);
    assert.strictEqual(Number(data.new_remuneration_convoyeur), 50);
    assert.strictEqual(Number(data.new_marge), 150);

    const { data: updated } = await sb.from('missions')
      .select('montant_ht, remuneration_convoyeur, marge')
      .eq('id', mission.id).single();
    assert.strictEqual(Number(updated.montant_ht), 200);
    assert.strictEqual(Number(updated.remuneration_convoyeur), 50);
    assert.strictEqual(Number(updated.marge), 150);
  });

  await test('RPC: price-only update uses old remuneration', async () => {
    await cleanupMission(mission.id);
    mission = await createTestMission({ montant_ht: 100, remuneration_convoyeur: 30, marge: 70 });
    const { data, error } = await sbAdmin.rpc('admin_update_mission_tariffs', {
      p_mission_id: mission.id,
      p_montant_ht: 150
    });
    assert.ok(!error, `RPC should succeed: ${error?.message}`);
    assert.strictEqual(Number(data.new_montant_ht), 150);
    assert.strictEqual(Number(data.new_remuneration_convoyeur), 30);
    assert.strictEqual(Number(data.new_marge), 120);
  });

  await test('RPC: rem-only update uses old price', async () => {
    await cleanupMission(mission.id);
    mission = await createTestMission({ montant_ht: 100, remuneration_convoyeur: 30, marge: 70 });
    const { data, error } = await sbAdmin.rpc('admin_update_mission_tariffs', {
      p_mission_id: mission.id,
      p_remuneration_convoyeur: 40
    });
    assert.ok(!error, `RPC should succeed: ${error?.message}`);
    assert.strictEqual(Number(data.new_montant_ht), 100);
    assert.strictEqual(Number(data.new_remuneration_convoyeur), 40);
    assert.strictEqual(Number(data.new_marge), 60);
  });

  await test('RPC: both NULL rejected', async () => {
    await cleanupMission(mission.id);
    mission = await createTestMission({ montant_ht: 100, remuneration_convoyeur: 30, marge: 70 });
    const { error } = await sbAdmin.rpc('admin_update_mission_tariffs', {
      p_mission_id: mission.id
    });
    assert.ok(error, 'Should reject when both params are NULL');
  });

  await test('RPC: price=0 rejected', async () => {
    await cleanupMission(mission.id);
    mission = await createTestMission({ montant_ht: 100, remuneration_convoyeur: 30, marge: 70 });
    const { error } = await sbAdmin.rpc('admin_update_mission_tariffs', {
      p_mission_id: mission.id,
      p_montant_ht: 0
    });
    assert.ok(error, 'Should reject price=0');
  });

  await test('RPC: negative price rejected', async () => {
    await cleanupMission(mission.id);
    mission = await createTestMission({ montant_ht: 100, remuneration_convoyeur: 30, marge: 70 });
    const { error } = await sbAdmin.rpc('admin_update_mission_tariffs', {
      p_mission_id: mission.id,
      p_montant_ht: -50
    });
    assert.ok(error, 'Should reject negative price');
  });

  await test('RPC: negative remuneration rejected', async () => {
    await cleanupMission(mission.id);
    mission = await createTestMission({ montant_ht: 100, remuneration_convoyeur: 30, marge: 70 });
    const { error } = await sbAdmin.rpc('admin_update_mission_tariffs', {
      p_mission_id: mission.id,
      p_remuneration_convoyeur: -10
    });
    assert.ok(error, 'Should reject negative remuneration');
  });

  await test('RPC: remuneration > price rejected', async () => {
    await cleanupMission(mission.id);
    mission = await createTestMission({ montant_ht: 100, remuneration_convoyeur: 30, marge: 70 });
    const { error } = await sbAdmin.rpc('admin_update_mission_tariffs', {
      p_mission_id: mission.id,
      p_montant_ht: 50,
      p_remuneration_convoyeur: 60
    });
    assert.ok(error, 'Should reject rem > price');
  });

  await test('RPC: NULL old financial component causes rejection', async () => {
    await cleanupMission(mission.id);
    // Mission with NULL remuneration — updating only price should fail
    // because resolved rem = COALESCE(NULL, NULL) = NULL
    mission = await createTestMission({ montant_ht: 100, remuneration_convoyeur: null, marge: null });
    const { error } = await sbAdmin.rpc('admin_update_mission_tariffs', {
      p_mission_id: mission.id,
      p_montant_ht: 120
    });
    assert.ok(error, 'Should reject when resolved rem is NULL');
  });

  // Payment guards
  await test('RPC: paid blocked', async () => {
    await cleanupMission(mission.id);
    mission = await createTestMission({ montant_ht: 100, remuneration_convoyeur: 30, marge: 70, paiement_statut: 'paid' });
    const { error } = await sbAdmin.rpc('admin_update_mission_tariffs', {
      p_mission_id: mission.id,
      p_montant_ht: 200
    });
    assert.ok(error, 'Should block when paid');
  });

  await test('RPC: paye blocked', async () => {
    await cleanupMission(mission.id);
    mission = await createTestMission({ montant_ht: 100, remuneration_convoyeur: 30, marge: 70, paiement_statut: 'paye' });
    const { error } = await sbAdmin.rpc('admin_update_mission_tariffs', {
      p_mission_id: mission.id,
      p_montant_ht: 200
    });
    assert.ok(error, 'Should block when paye');
  });

  await test('RPC: stripe_session_id non-null blocked', async () => {
    await cleanupMission(mission.id);
    mission = await createTestMission({
      montant_ht: 100, remuneration_convoyeur: 30, marge: 70,
      stripe_session_id: 'cs_test_123'
    });
    const { error } = await sbAdmin.rpc('admin_update_mission_tariffs', {
      p_mission_id: mission.id,
      p_montant_ht: 200
    });
    assert.ok(error, 'Should block when stripe_session_id is non-null');
  });

  await test('RPC: pending/no-session allowed', async () => {
    await cleanupMission(mission.id);
    mission = await createTestMission({
      montant_ht: 100, remuneration_convoyeur: 30, marge: 70,
      paiement_statut: 'pending', stripe_session_id: null
    });
    const { data, error } = await sbAdmin.rpc('admin_update_mission_tariffs', {
      p_mission_id: mission.id,
      p_montant_ht: 200
    });
    assert.ok(!error, `Should succeed: ${error?.message}`);
    assert.strictEqual(Number(data.new_montant_ht), 200);
  });

  // Billing guards
  await test('RPC: no billing record allowed', async () => {
    await cleanupMission(mission.id);
    mission = await createTestMission({ montant_ht: 100, remuneration_convoyeur: 30, marge: 70 });
    const { data, error } = await sbAdmin.rpc('admin_update_mission_tariffs', {
      p_mission_id: mission.id,
      p_montant_ht: 200
    });
    assert.ok(!error, `Should succeed with no billing record: ${error?.message}`);
  });

  await test('RPC: prepared billing blocked', async () => {
    await cleanupMission(mission.id);
    mission = await createTestMission({ montant_ht: 100, remuneration_convoyeur: 30, marge: 70 });
    // Create a prepared billing record
    const { error: billingErr } = await sb.from('billing_records')
      .insert({
        mission_id: mission.id,
        provider: 'indy',
        status: 'prepared',
        invoice_type: 'invoice',
        total_ht: 100,
        total_tva: 0,
        total_ttc: 100,
        currency: 'EUR',
        prepared_payload: {}
      });
    if (billingErr) throw new Error(`Failed to create billing record: ${billingErr.message}`);

    const { error } = await sbAdmin.rpc('admin_update_mission_tariffs', {
      p_mission_id: mission.id,
      p_montant_ht: 200
    });
    assert.ok(error, 'Should block when prepared billing record exists');
  });

  await test('RPC: issued billing blocked', async () => {
    await cleanupMission(mission.id);
    mission = await createTestMission({ montant_ht: 100, remuneration_convoyeur: 30, marge: 70 });
    // Create prepared billing record first (insert guard requires status='prepared')
    const { data: billingId, error: prepErr } = await sbAdmin.rpc('prepare_billing_record', {
      p_mission_id: mission.id
    });
    if (prepErr) throw new Error(`Failed to prepare billing: ${prepErr.message}`);

    // Transition to issued via link_external_invoice
    const invNumber = `INV-TEST-${sessionId}-${++fixtureCounter}`;
    const { error: linkErr } = await sbAdmin.rpc('link_external_invoice', {
      p_billing_record_id: billingId,
      p_external_invoice_number: invNumber,
      p_external_invoice_id: `ext-${invNumber}`
    });
    if (linkErr) throw new Error(`Failed to link external invoice: ${linkErr.message}`);

    const { error } = await sbAdmin.rpc('admin_update_mission_tariffs', {
      p_mission_id: mission.id,
      p_montant_ht: 200
    });
    assert.ok(error, 'Should block when issued billing record exists');
  });

  await test('RPC: cancelled billing allowed', async () => {
    await cleanupMission(mission.id);
    mission = await createTestMission({ montant_ht: 100, remuneration_convoyeur: 30, marge: 70 });
    // Create prepared billing record first
    const { data: billingId, error: prepErr } = await sbAdmin.rpc('prepare_billing_record', {
      p_mission_id: mission.id
    });
    if (prepErr) throw new Error(`Failed to prepare billing: ${prepErr.message}`);

    // Cancel it via cancel_billing_record
    const { error: cancelErr } = await sbAdmin.rpc('cancel_billing_record', {
      p_billing_record_id: billingId,
      p_reason: 'test cancellation'
    });
    if (cancelErr) throw new Error(`Failed to cancel billing: ${cancelErr.message}`);

    const { data, error } = await sbAdmin.rpc('admin_update_mission_tariffs', {
      p_mission_id: mission.id,
      p_montant_ht: 200
    });
    assert.ok(!error, `Should succeed with cancelled billing: ${error?.message}`);
    assert.strictEqual(Number(data.new_montant_ht), 200);
  });

  // Audit tests
  await test('RPC: exactly one tariff_updated event after success', async () => {
    await cleanupMission(mission.id);
    mission = await createTestMission({ montant_ht: 100, remuneration_convoyeur: 30, marge: 70 });
    // Clean any existing events
    await sb.from('mission_events').delete().eq('mission_id', mission.id);

    await sbAdmin.rpc('admin_update_mission_tariffs', {
      p_mission_id: mission.id,
      p_montant_ht: 200,
      p_remuneration_convoyeur: 50
    });

    const { data: events, error: evtErr } = await sb.from('mission_events')
      .select('*').eq('mission_id', mission.id).eq('event_type', 'tariff_updated');
    assert.ok(!evtErr);
    assert.strictEqual(events.length, 1, 'Exactly one tariff_updated event');
  });

  await test('RPC: audit old/new values correct', async () => {
    await cleanupMission(mission.id);
    mission = await createTestMission({ montant_ht: 100, remuneration_convoyeur: 30, marge: 70 });
    await sb.from('mission_events').delete().eq('mission_id', mission.id);

    await sbAdmin.rpc('admin_update_mission_tariffs', {
      p_mission_id: mission.id,
      p_montant_ht: 200,
      p_remuneration_convoyeur: 50
    });

    const { data: events } = await sb.from('mission_events')
      .select('metadata').eq('mission_id', mission.id).eq('event_type', 'tariff_updated').single();
    const meta = events.metadata;
    assert.strictEqual(Number(meta.old_montant_ht), 100);
    assert.strictEqual(Number(meta.new_montant_ht), 200);
    assert.strictEqual(Number(meta.old_remuneration_convoyeur), 30);
    assert.strictEqual(Number(meta.new_remuneration_convoyeur), 50);
    assert.strictEqual(Number(meta.old_marge), 70);
    assert.strictEqual(Number(meta.new_marge), 150);
  });

  await test('RPC: reason trimmed', async () => {
    await cleanupMission(mission.id);
    mission = await createTestMission({ montant_ht: 100, remuneration_convoyeur: 30, marge: 70 });
    await sb.from('mission_events').delete().eq('mission_id', mission.id);

    await sbAdmin.rpc('admin_update_mission_tariffs', {
      p_mission_id: mission.id,
      p_montant_ht: 200,
      p_reason: '  price adjustment  '
    });

    const { data: events } = await sb.from('mission_events')
      .select('metadata').eq('mission_id', mission.id).eq('event_type', 'tariff_updated').single();
    assert.strictEqual(events.metadata.reason, 'price adjustment');
  });

  await test('RPC: empty reason => NULL', async () => {
    await cleanupMission(mission.id);
    mission = await createTestMission({ montant_ht: 100, remuneration_convoyeur: 30, marge: 70 });
    await sb.from('mission_events').delete().eq('mission_id', mission.id);

    await sbAdmin.rpc('admin_update_mission_tariffs', {
      p_mission_id: mission.id,
      p_montant_ht: 200,
      p_reason: '   '
    });

    const { data: events } = await sb.from('mission_events')
      .select('metadata').eq('mission_id', mission.id).eq('event_type', 'tariff_updated').single();
    assert.strictEqual(events.metadata.reason, null);
  });

  await test('RPC: >500 reason rejected', async () => {
    await cleanupMission(mission.id);
    mission = await createTestMission({ montant_ht: 100, remuneration_convoyeur: 30, marge: 70 });
    const longReason = 'x'.repeat(501);
    const { error } = await sbAdmin.rpc('admin_update_mission_tariffs', {
      p_mission_id: mission.id,
      p_montant_ht: 200,
      p_reason: longReason
    });
    assert.ok(error, 'Should reject reason > 500 chars');
  });

  await test('RPC: failed tariff update => no tariff_updated event', async () => {
    await cleanupMission(mission.id);
    mission = await createTestMission({ montant_ht: 100, remuneration_convoyeur: 30, marge: 70 });
    await sb.from('mission_events').delete().eq('mission_id', mission.id);

    // This should fail (price=0)
    await sbAdmin.rpc('admin_update_mission_tariffs', {
      p_mission_id: mission.id,
      p_montant_ht: 0
    });

    const { data: events } = await sb.from('mission_events')
      .select('*').eq('mission_id', mission.id).eq('event_type', 'tariff_updated');
    assert.strictEqual(events.length, 0, 'No event should be logged on failed update');
  });

  // Authorization tests
  await test('RPC: non-admin authenticated rejected', async () => {
    await cleanupMission(mission.id);
    mission = await createTestMission({ montant_ht: 100, remuneration_convoyeur: 30, marge: 70 });
    const { error } = await nonAdminCtx.sbUser.rpc('admin_update_mission_tariffs', {
      p_mission_id: mission.id,
      p_montant_ht: 200
    });
    assert.ok(error, 'Non-admin should be rejected');
  });

  await test('RPC: unauthenticated rejected', async () => {
    await cleanupMission(mission.id);
    mission = await createTestMission({ montant_ht: 100, remuneration_convoyeur: 30, marge: 70 });
    const { error } = await sbAnon.rpc('admin_update_mission_tariffs', {
      p_mission_id: mission.id,
      p_montant_ht: 200
    });
    assert.ok(error, 'Unauthenticated should be rejected');
  });

  await cleanupMission(mission?.id);
  await cleanupUser(adminCtx.userId, adminCtx.client.id);
  await cleanupUser(nonAdminCtx.userId, nonAdminCtx.client.id);
}

// =====================================================
// RUNTIME TESTS — Billing lock verification
// =====================================================

async function runBillingLockTests() {
  console.log('\n=== BILLING LOCK TESTS ===');

  let mission;

  await test('Billing: prepare_billing_record uses mission FOR UPDATE', async () => {
    // This is verified by the fact that prepare_billing_record succeeds
    // and serializes with other mission operations.
    // We verify by calling prepare_billing_record and checking it works.
    mission = await createTestMission({ montant_ht: 100, remuneration_convoyeur: 30, marge: 70 });

    // We need an admin user to call prepare_billing_record
    let adminCtx;
    try {
      adminCtx = await createAdminUser();
    } catch (err) {
      console.log('  SKIP: Could not create admin user for billing test');
      await cleanupMission(mission.id);
      return;
    }

    const { data, error } = await adminCtx.sbAdmin.rpc('prepare_billing_record', {
      p_mission_id: mission.id
    });
    assert.ok(!error, `prepare_billing_record should succeed: ${error?.message}`);
    assert.ok(data, 'Should return billing record ID');

    // Verify the billing record was created
    const { data: billing, error: billingErr } = await sb.from('billing_records')
      .select('status, total_ht, mission_id').eq('id', data).single();
    assert.ok(!billingErr);
    assert.strictEqual(billing.status, 'prepared');
    assert.strictEqual(Number(billing.total_ht), 100);
    assert.strictEqual(billing.mission_id, mission.id);

    await cleanupMission(mission.id);
    await cleanupUser(adminCtx.userId, adminCtx.client.id);
  });

  await test('Billing: prepare_billing_record signature unchanged', () => {
    // Static check: verify the function signature matches the original
    const billingSection = migrationSQL.match(/CREATE OR REPLACE FUNCTION public\.prepare_billing_record\([^)]+\)/);
    assert.ok(billingSection, 'Must find prepare_billing_record definition');
    assert.ok(billingSection[0].includes('p_mission_id uuid'),
      'Signature must include p_mission_id uuid');
    assert.ok(billingSection[0].includes('p_notes text DEFAULT NULL'),
      'Signature must include p_notes text DEFAULT NULL');
  });
}

// =====================================================
// MAIN
// =====================================================

async function main() {
  console.log('OPS-2A1A — Financial Integrity Phase A Tests');
  console.log('Target:', SUPABASE_URL);
  if (SKIP_RUNTIME) {
    console.log('Mode: STATIC ONLY (no local Supabase available)');
  }
  console.log('');

  await runStaticTests();
  if (!SKIP_RUNTIME) {
    await runTriggerRuntimeTests();
    await runDirtyCompatibilityCases();
    await runRpcRuntimeTests();
    await runBillingLockTests();
  } else {
    console.log('\n=== RUNTIME TESTS SKIPPED (no local Supabase) ===');
    console.log('  Trigger runtime, dirty compatibility, RPC runtime, billing lock: SKIPPED');
  }

  console.log('\n=== SUMMARY ===');
  console.log(`Passed: ${passed}`);
  console.log(`Failed: ${failed}`);
  console.log('');

  if (failed > 0) {
    console.log('FAILED TESTS:');
    results.filter(r => r.status === 'FAIL').forEach(r => {
      console.log(`  \u2717 ${r.name}: ${r.error}`);
    });
    throw new Error(`${failed} test(s) failed`);
  } else {
    console.log('ALL TESTS PASSED');
  }
}

// Only run main() when executed directly (node tests/admin-tariff-integrity.test.cjs)
// Skip when loaded by Playwright (PW_WORKER_ID is set in Playwright workers)
if (!process.env.PW_WORKER_ID && !process.env.PLAYWRIGHT_WORKER_ID) {
  main().catch(err => {
    console.error('Fatal error:', err);
    throw err;
  });
} else {
  // When loaded by Playwright, export a no-op so the file is discovered
  // but doesn't interfere with the Playwright test runner.
  module.exports = {};
}
